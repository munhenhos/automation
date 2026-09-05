// LI.FI is the engine behind Jumper. We use it for two things:
//   1. Canonical token addresses per chain (so we never hardcode a wrong one).
//   2. Executable quotes — real amounts out after DEX fees, bridge fees,
//      slippage and gas. This is what makes an "imbalance" into a real trade.
//
// Set LIFI_API_KEY to raise the rate limit. The anonymous tier is small: a full
// ladder scan can exhaust it, and LI.FI then blocks for hours.

import { QUOTE_ADDRESS, RATE_LIMIT_MS } from "./config.js";

const BASE = "https://li.quest/v1";
const API_KEY = process.env.LIFI_API_KEY;

function headers(): Record<string, string> {
  return API_KEY ? { "x-lifi-api-key": API_KEY } : {};
}

export type Token = {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
  priceUSD?: string;
};

export type QuoteEstimate = {
  toAmount: string; // raw units of toToken
  toAmountUSD?: string;
  fromAmountUSD?: string;
  gasCostsUSD: number;
  feeCostsUSD: number;
  tool: string; // bridge/dex used
};

/**
 * A quote attempt. "no-route" genuinely means LI.FI found no path; it is never
 * used for a transport failure, so a rate limit can't masquerade as one.
 */
export type QuoteResult =
  | { status: "ok"; estimate: QuoteEstimate }
  | { status: "no-route" }
  | { status: "rate-limited"; detail: string }
  | { status: "error"; detail: string };

/** Thrown to abort a scan when the API key/tier is exhausted. */
export class RateLimitedError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch the token list for a chain and index it by uppercased symbol.
 * If multiple tokens share a symbol, we keep the first (LI.FI lists the
 * canonical one first).
 */
export async function fetchTokens(chainId: number): Promise<Map<string, Token>> {
  const res = await fetch(`${BASE}/tokens?chains=${chainId}`, { headers: headers() });
  if (res.status === 429) throw new RateLimitedError(`rate limited fetching tokens for chain ${chainId}`);
  if (!res.ok) throw new Error(`LI.FI tokens request failed (${chainId}): ${res.status}`);
  const body = (await res.json()) as { tokens: Record<string, Token[]> };
  const list = body.tokens[String(chainId)] ?? [];
  const map = new Map<string, Token>();
  for (const t of list) {
    const key = t.symbol.toUpperCase();
    if (!map.has(key)) map.set(key, { ...t, chainId });
  }
  return map;
}

/** Get one executable quote. `fromAmount` is in raw units of fromToken. */
export async function getQuote(params: {
  fromChain: number;
  toChain: number;
  fromToken: string;
  toToken: string;
  fromAmount: string;
}): Promise<QuoteResult> {
  const q = new URLSearchParams({
    fromChain: String(params.fromChain),
    toChain: String(params.toChain),
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: params.fromAmount,
    fromAddress: QUOTE_ADDRESS,
    // Modest slippage; a realistic taker setting.
    slippage: "0.005",
  });

  await sleep(RATE_LIMIT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}/quote?${q.toString()}`, { headers: headers() });
  } catch (e) {
    return { status: "error", detail: e instanceof Error ? e.message : String(e) };
  }

  if (res.status === 404) return { status: "no-route" };
  if (res.status === 429) {
    const txt = await res.text().catch(() => "");
    return { status: "rate-limited", detail: txt.slice(0, 160) };
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { status: "error", detail: `HTTP ${res.status} ${txt.slice(0, 120)}` };
  }

  const body = (await res.json()) as any;
  const est = body.estimate ?? {};
  if (!est.toAmount || est.toAmount === "0") return { status: "no-route" };

  return {
    status: "ok",
    estimate: {
      toAmount: est.toAmount,
      toAmountUSD: est.toAmountUSD,
      fromAmountUSD: est.fromAmountUSD,
      gasCostsUSD: sumUSD(est.gasCosts),
      feeCostsUSD: sumUSD(est.feeCosts),
      tool: body.tool ?? est.tool ?? "?",
    },
  };
}

function sumUSD(items: any[] | undefined): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((acc, it) => acc + (parseFloat(it?.amountUSD ?? "0") || 0), 0);
}
