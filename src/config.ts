// Central config for the scanner. Everything the agent treats as "trusted"
// is declared here explicitly. Nothing is discovered blindly.

export type Chain = {
  /** EVM chain id, used by LI.FI. */
  id: number;
  /** Human name. */
  name: string;
  /** DefiLlama's `chain` field spelling, used to match pools. */
  llama: string;
  /**
   * Extra spellings DefiLlama might use for the same chain. Any match counts.
   * Used for newer chains where the exact `chain` label is uncertain.
   */
  llamaAliases?: string[];
};

export type Currency = "USD" | "EUR";

export type QuoteBase = {
  /** Chain the round trip starts and ends on (Base). */
  chainId: number;
  /** Base asset symbol used to enter and exit. */
  symbol: string;
  currency: Currency;
};

// Two separate homes, one per currency. USD stables round-trip against USDC on
// Base; EUR stables round-trip against EURC on Base. Keeping them separate means
// a EUR opportunity never crosses EUR/USD — it's a pure EUR-peg imbalance.
export const BASES: Record<Currency, QuoteBase> = {
  USD: { chainId: 8453, symbol: "USDC", currency: "USD" },
  EUR: { chainId: 8453, symbol: "EURC", currency: "EUR" },
};

/** DefiLlama pegType -> our currency bucket. */
export function pegTypeToCurrency(pegType: string): Currency | undefined {
  if (pegType === "peggedUSD") return "USD";
  if (pegType === "peggedEUR") return "EUR";
  return undefined;
}

// Chains we scan. Base is home; the rest are reachable via Jumper/LI.FI.
export const CHAINS: Chain[] = [
  { id: 8453, name: "Base", llama: "Base" },
  { id: 1, name: "Ethereum", llama: "Ethereum" },
  { id: 42161, name: "Arbitrum", llama: "Arbitrum" },
  { id: 10, name: "Optimism", llama: "Optimism" },
  { id: 137, name: "Polygon", llama: "Polygon" },
  { id: 100, name: "Gnosis", llama: "Gnosis", llamaAliases: ["xDai"] },
  // HyperEVM (Hyperliquid's EVM), native gas HYPE. DefiLlama label unconfirmed
  // from here — match the likely spellings.
  { id: 999, name: "HyperEVM", llama: "Hyperliquid", llamaAliases: ["HyperEVM", "Hyperliquid L1"] },
  // Robinhood Chain, Arbitrum Orbit L2, gas in ETH, mainnet live 2026-07-01.
  { id: 4663, name: "Robinhood", llama: "Robinhood", llamaAliases: ["Robinhood Chain"] },
];

// Candidate stablecoins by name. This is the name allowlist; each one still has
// to pass a live legitimacy gate (see MIN_STABLE_MCAP_USD) before it's scanned.
// $1- and €1-pegged assets. Yield-bearing wrappers (sUSDe, sDAI, etc.) are
// deliberately excluded — they do not hold a fixed peg.
export const STABLE_SYMBOLS = [
  // USD
  "USDC",
  "USDT",
  "DAI",
  "USDS",
  "crvUSD",
  "GHO",
  "USDe",
  "FRAX",
  "LUSD",
  "USDG", // Global Dollar (Paxos) — primary stable on Robinhood Chain
  "USDT0", // canonical bridged USDT on HyperEVM
  // EUR — settled back to USDC; the EUR/USD leg cancels across the round trip.
  "EURC", // Circle
  "EURe", // Monerium
  "EURS", // Stasis
  "EURA", // Angle (formerly agEUR)
  "agEUR", // legacy symbol still used by some pools
  "EURt", // Tether EUR
];

// Which DefiLlama peg types we accept. USD and EUR only.
export const ALLOWED_PEG_TYPES = new Set<string>(["peggedUSD", "peggedEUR"]);

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

// Trade size to quote, in the book's base units (USDC or EURC). Real
// profitability is size-dependent, so this matters. Override with the first CLI
// arg or NOTIONAL env var — but never above MAX_NOTIONAL.
export const DEFAULT_NOTIONAL_USDC = 500;

// Hard cap on trade size: 500 USDC / 500 EURC. Larger sizes are clamped down.
export const MAX_NOTIONAL = 500;

// Placeholder address used only for quoting (no signing, no execution).
// LI.FI requires a fromAddress even for quotes.
export const QUOTE_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// Politeness delay between LI.FI calls (ms) to stay under free-tier limits.
export const RATE_LIMIT_MS = 300;
