// DefiLlama is the trust anchor. We use its yields/pools dataset to decide
// which (chain, stablecoin) combinations are backed by a real, reputable,
// liquid pool. Nothing is scanned that DefiLlama can't vouch for.

import {
  ALLOWED_PROJECTS,
  CHAINS,
  MIN_POOL_TVL_USD,
  MIN_STABLE_MCAP_USD,
  STABLE_SYMBOLS,
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
};

const llamaByChainId = new Map(CHAINS.map((c) => [c.id, c.llama]));

type PeggedAsset = {
  symbol: string;
  pegType: string; // "peggedUSD", "peggedEUR", ...
  circulating: { peggedUSD?: number } | null;
  price?: number | null;
};

/**
 * Pull DefiLlama's stablecoins dataset and return uppercased symbol ->
 * circulating market cap (USD), for USD-pegged assets only. This is the source
 * of truth for "is this stablecoin legit and sizeable".
 */
export async function fetchStableMarketCaps(): Promise<Map<string, number>> {
  const res = await fetch(STABLECOINS_URL);
  if (!res.ok) throw new Error(`DefiLlama stablecoins request failed: ${res.status}`);
  const body = (await res.json()) as { peggedAssets: PeggedAsset[] };

  const caps = new Map<string, number>();
  for (const a of body.peggedAssets) {
    if (a.pegType !== "peggedUSD") continue; // USD-pegged only
    const mcap = a.circulating?.peggedUSD ?? 0;
    if (mcap <= 0) continue;
    const key = a.symbol.toUpperCase();
    // Keep the largest if a symbol appears twice.
    caps.set(key, Math.max(caps.get(key) ?? 0, mcap));
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

  const wantChains = new Set(CHAINS.map((c) => c.llama));
  const wantStables = new Set(STABLE_SYMBOLS.map((s) => s.toLowerCase()));

  const verified = new Map<string, VerifiedPool>();
  const rejectedForMcap = new Set<string>();

  for (const p of body.data) {
    if (!p.stablecoin) continue;
    if (!wantChains.has(p.chain)) continue;
    if (!ALLOWED_PROJECTS.has(p.project)) continue;
    if (p.tvlUsd < MIN_POOL_TVL_USD) continue;

    // A pool symbol like "USDC-USDT" verifies each stable leg it contains.
    const legs = p.symbol.split(/[-/]/).map((s) => s.trim());
    for (const leg of legs) {
      if (!wantStables.has(leg.toLowerCase())) continue;
      const upper = leg.toUpperCase();

      // Gate 1: the stable itself must be legit and sizeable.
      const mcap = marketCaps.get(upper) ?? 0;
      if (mcap < MIN_STABLE_MCAP_USD) {
        rejectedForMcap.add(upper);
        continue;
      }

      const key = `${p.chain}:${upper}`;
      const existing = verified.get(key);
      if (!existing || p.tvlUsd > existing.tvlUsd) {
        verified.set(key, {
          chain: p.chain,
          symbol: upper,
          project: p.project,
          poolSymbol: p.symbol,
          tvlUsd: p.tvlUsd,
          stableMcapUsd: mcap,
        });
      }
    }
  }

  if (rejectedForMcap.size > 0) {
    console.error(
      `  skipped (below $${(MIN_STABLE_MCAP_USD / 1e6).toFixed(0)}M mcap or not USD-pegged in DefiLlama): ${[...rejectedForMcap].join(", ")}`,
    );
  }

  return verified;
}

export function isVerified(
  verified: Map<string, VerifiedPool>,
  chainId: number,
  symbol: string,
): VerifiedPool | undefined {
  const llama = llamaByChainId.get(chainId);
  if (!llama) return undefined;
  return verified.get(`${llama}:${symbol.toUpperCase()}`);
}
