// Central config for the scanner. Everything the agent treats as "trusted"
// is declared here explicitly. Nothing is discovered blindly.

export type Chain = {
  /** EVM chain id, used by LI.FI. */
  id: number;
  /** Human name. */
  name: string;
  /** DefiLlama's `chain` field spelling, used to match pools. */
  llama: string;
};

// Home base. Every opportunity must start and end here.
// USDC on Base.
export const HOME = {
  chainId: 8453,
  symbol: "USDC",
} as const;

// Chains we scan. Base is home; the rest are reachable via Jumper/LI.FI.
export const CHAINS: Chain[] = [
  { id: 8453, name: "Base", llama: "Base" },
  { id: 1, name: "Ethereum", llama: "Ethereum" },
  { id: 42161, name: "Arbitrum", llama: "Arbitrum" },
  { id: 10, name: "Optimism", llama: "Optimism" },
  { id: 137, name: "Polygon", llama: "Polygon" },
];

// Candidate stablecoins by name. This is the name allowlist; each one still has
// to pass a live legitimacy gate (see MIN_STABLE_MCAP_USD) before it's scanned.
// Only $1-pegged assets. Yield-bearing wrappers (sUSDe, sDAI, etc.) are
// deliberately excluded — they do not peg to $1.
export const STABLE_SYMBOLS = [
  "USDC",
  "USDT",
  "DAI",
  "USDS",
  "crvUSD",
  "GHO",
  "USDe",
  "FRAX",
  "LUSD",
];

// DefiLlama project slugs we consider reputable AMMs for stable pools.
// A stable is only scanned on a chain if it appears in one of these projects
// with enough TVL. This is the "legit pool" gate.
export const ALLOWED_PROJECTS = new Set<string>([
  "curve-dex",
  "uniswap-v3",
  "uniswap-v2",
  "aerodrome-v1",
  "aerodrome-slipstream",
  "velodrome-v2",
  "balancer-v2",
  "balancer-v3",
  "fluid-dex",
  "sushiswap",
  "pancakeswap-amm-v3",
]);

// Legitimacy of the STABLE itself: its total circulating supply / market cap
// (from DefiLlama's stablecoins dataset) must clear this floor. This is the
// "is this a real, sizeable stablecoin" gate. Small pools are fine; small
// stablecoins are not.
export const MIN_STABLE_MCAP_USD = 50_000_000;

// A stable must sit in at least one allowed pool with at least this much TVL
// (USD) on a chain before we scan it there. Kept low on purpose: small,
// unbalanced pools are where the arbitrage lives. This only proves the stable
// is actually pooled on a reputable venue on that chain — not that the pool is
// deep.
export const MIN_POOL_TVL_USD = 1_000;

// Trade size to quote, in USDC. Real profitability is size-dependent, so this
// matters. Override with the first CLI arg or NOTIONAL env var.
export const DEFAULT_NOTIONAL_USDC = 10_000;

// Placeholder address used only for quoting (no signing, no execution).
// LI.FI requires a fromAddress even for quotes.
export const QUOTE_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// Politeness delay between LI.FI calls (ms) to stay under free-tier limits.
export const RATE_LIMIT_MS = 300;
