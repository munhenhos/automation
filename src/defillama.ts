// DefiLlama is the trust anchor. We use its yields/pools dataset to decide
// which (chain, stablecoin) combinations are backed by a real, reputable,
// liquid pool. Nothing is scanned that DefiLlama can't vouch for.

import { ALLOWED_PROJECTS, CHAINS, MIN_POOL_TVL_USD, STABLE_SYMBOLS } from "./config.js";

const POOLS_URL = "https://yields.llama.fi/pools";

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
};

const llamaByChainId = new Map(CHAINS.map((c) => [c.id, c.llama]));

/**
 * Pull DefiLlama pools once and build the set of (chain, stable) pairs that are
 * backed by an allowed project with enough TVL. Also returns the single best
 * pool per pair so we can show the user why it's trusted.
 */
export async function fetchVerifiedStables(): Promise<Map<string, VerifiedPool>> {
  const res = await fetch(POOLS_URL);
  if (!res.ok) throw new Error(`DefiLlama pools request failed: ${res.status}`);
  const body = (await res.json()) as { data: LlamaPool[] };

  const wantChains = new Set(CHAINS.map((c) => c.llama));
  const wantStables = new Set(STABLE_SYMBOLS.map((s) => s.toLowerCase()));

  const verified = new Map<string, VerifiedPool>();

  for (const p of body.data) {
    if (!p.stablecoin) continue;
    if (!wantChains.has(p.chain)) continue;
    if (!ALLOWED_PROJECTS.has(p.project)) continue;
    if (p.tvlUsd < MIN_POOL_TVL_USD) continue;

    // A pool symbol like "USDC-USDT" verifies each stable leg it contains.
    const legs = p.symbol.split(/[-/]/).map((s) => s.trim());
    for (const leg of legs) {
      if (!wantStables.has(leg.toLowerCase())) continue;
      const key = `${p.chain}:${leg.toUpperCase()}`;
      const existing = verified.get(key);
      if (!existing || p.tvlUsd > existing.tvlUsd) {
        verified.set(key, {
          chain: p.chain,
          symbol: leg.toUpperCase(),
          project: p.project,
          poolSymbol: p.symbol,
          tvlUsd: p.tvlUsd,
        });
      }
    }
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
