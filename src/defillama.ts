// DefiLlama is the trust anchor. We use its yields/pools dataset to decide
// which (chain, stablecoin) combinations are backed by a real, reputable,
// liquid pool. Nothing is scanned that DefiLlama can't vouch for.

import {
  ALLOWED_PEG_TYPES,
  ALLOWED_PROJECTS,
  CHAINS,
  MIN_POOL_TVL_USD,
  MIN_STABLE_MCAP_USD,
  STABLE_SYMBOLS,
  pegTypeToCurrency,
  type Currency,
} from "./config.js";

const POOLS_URL = "https://yields.llama.fi/pools";
const STABLECOINS_URL = "https://stablecoins.llama.fi/stablecoins?includePrices=true";

type LlamaPool = {
  chain: string;
  project: string;
  symbol: string; // e.g. "USDC-USDT"
  tvlUsd: number;
  stablecoin: boolean;
  pool: string;
};

// Key = `${llamaChain}:${stableSymbol}`. Value = the best pool that verifies it.
export type VerifiedPool = {
  chain: string;
  symbol: string;
  project: string;
  poolSymbol: string;
  tvlUsd: number;
  /** Global circulating supply / market cap of the stable (USD). */
  stableMcapUsd: number;
  /** USD or EUR — decides which base the round trip uses. */
  currency: Currency;
};

export type StableInfo = { mcapUsd: number; currency: Currency };

// Map every DefiLlama chain spelling we accept (canonical + aliases, lowercased)
// back to our EVM chain id. Verified pairs are then keyed by chain id, so an
// alias can never mismatch the lookup.
const chainIdByLlamaName = new Map<string, number>();
for (const c of CHAINS) {
  for (const name of [c.llama, ...(c.llamaAliases ?? [])]) {
    chainIdByLlamaName.set(name.toLowerCase(), c.id);
  }
}

type PeggedAsset = {
  symbol: string;
  pegType: string; // "peggedUSD", "peggedEUR", ...
  circulating: Record<string, number> | null; // keyed by pegType, in peg units
  price?: number | null; // USD per token (with includePrices=true)
};

/**
 * Circulating supply converted to USD. For a USD peg the supply is already in
 * USD; for a EUR peg we multiply the EUR supply by the token's USD price so the
 * mcap floor is a like-for-like USD comparison. Returns 0 when it can't be
 * computed (missing price on a non-USD peg), which safely fails the gate.
 */
export function mcapUsd(pegType: string, circulating: Record<string, number> | null, price?: number | null): number {
  const amount = circulating?.[pegType] ?? 0;
  if (amount <= 0) return 0;
  if (pegType === "peggedUSD") return amount * (typeof price === "number" && price > 0 ? price : 1);
  if (typeof price === "number" && price > 0) return amount * price; // e.g. EUR supply * EUR/USD
  return 0;
}

/**
 * Pull DefiLlama's stablecoins dataset and return uppercased symbol -> its USD
 * market cap and currency bucket, for the allowed peg types (USD, EUR). This is
 * the source of truth for "is this stablecoin legit and sizeable".
 */
export async function fetchStableMarketCaps(): Promise<Map<string, StableInfo>> {
  const res = await fetch(STABLECOINS_URL);
  if (!res.ok) throw new Error(`DefiLlama stablecoins request failed: ${res.status}`);
  const body = (await res.json()) as { peggedAssets: PeggedAsset[] };

  const caps = new Map<string, StableInfo>();
  for (const a of body.peggedAssets) {
    if (!ALLOWED_PEG_TYPES.has(a.pegType)) continue;
    const currency = pegTypeToCurrency(a.pegType);
    if (!currency) continue;
    const cap = mcapUsd(a.pegType, a.circulating, a.price);
    if (cap <= 0) continue;
    const key = a.symbol.toUpperCase();
    // Keep the largest if a symbol appears twice.
    const existing = caps.get(key);
    if (!existing || cap > existing.mcapUsd) caps.set(key, { mcapUsd: cap, currency });
  }
  return caps;
}

/**
 * Build the set of (chain, stable) pairs worth scanning. Two independent gates:
 *   1. The stable is legit and sizeable  -> circulating mcap >= MIN_STABLE_MCAP_USD.
 *   2. The stable is actually pooled here -> appears in an allowed project's pool
 *      with TVL >= MIN_POOL_TVL_USD (kept low; small pools are welcome).
 * Returns the best pool per pair so we can show the user why it's trusted.
 */
export async function fetchVerifiedStables(): Promise<Map<string, VerifiedPool>> {
  const [poolsRes, marketCaps] = await Promise.all([
    fetch(POOLS_URL),
    fetchStableMarketCaps(),
  ]);
  if (!poolsRes.ok) throw new Error(`DefiLlama pools request failed: ${poolsRes.status}`);
  const body = (await poolsRes.json()) as { data: LlamaPool[] };

  const wantStables = new Set(STABLE_SYMBOLS.map((s) => s.toLowerCase()));

  const verified = new Map<string, VerifiedPool>();
  const rejectedForMcap = new Set<string>();

  for (const p of body.data) {
    if (!p.stablecoin) continue;
    const chainId = chainIdByLlamaName.get(p.chain.toLowerCase());
    if (chainId === undefined) continue; // chain not in scope
    if (!ALLOWED_PROJECTS.has(p.project)) continue;
    if (p.tvlUsd < MIN_POOL_TVL_USD) continue;

    // A pool symbol like "USDC-USDT" verifies each stable leg it contains.
    const legs = p.symbol.split(/[-/]/).map((s) => s.trim());
    for (const leg of legs) {
      if (!wantStables.has(leg.toLowerCase())) continue;
      const upper = leg.toUpperCase();

      // Gate 1: the stable itself must be legit and sizeable.
      const info = marketCaps.get(upper);
      if (!info || info.mcapUsd < MIN_STABLE_MCAP_USD) {
        rejectedForMcap.add(upper);
        continue;
      }

      const key = `${chainId}:${upper}`;
      const existing = verified.get(key);
      if (!existing || p.tvlUsd > existing.tvlUsd) {
        verified.set(key, {
          chain: p.chain,
          symbol: upper,
          project: p.project,
          poolSymbol: p.symbol,
          tvlUsd: p.tvlUsd,
          stableMcapUsd: info.mcapUsd,
          currency: info.currency,
        });
      }
    }
  }

  if (rejectedForMcap.size > 0) {
    console.error(
      `  skipped (below $${(MIN_STABLE_MCAP_USD / 1e6).toFixed(0)}M mcap or not a USD/EUR peg in DefiLlama): ${[...rejectedForMcap].join(", ")}`,
    );
  }

  return verified;
}

export function isVerified(
  verified: Map<string, VerifiedPool>,
  chainId: number,
  symbol: string,
): VerifiedPool | undefined {
  return verified.get(`${chainId}:${symbol.toUpperCase()}`);
}
