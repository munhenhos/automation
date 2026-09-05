// LI.FI is the engine behind Jumper. We use it for two things:
//   1. Canonical token addresses per chain (so we never hardcode a wrong one).
//   2. Executable quotes — real amounts out after DEX fees, bridge fees,
//      slippage and gas. This is what makes an "imbalance" into a real trade.

import { QUOTE_ADDRESS, RATE_LIMIT_MS } from "./config.js";

const BASE = "https://li.quest/v1";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch the token list for a chain and index it by uppercased symbol.
 * If multiple tokens share a symbol, we keep the first (LI.FI lists the
 * canonical one first).
 */
export async function fetchTokens(chainId: number): Promise<Map<string, Token>> {
  const res = await fetch(`${BASE}/tokens?chains=${chainId}`);
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

/**
 * Get one executable quote. Returns null if LI.FI can't route it.
 * `fromAmount` is in raw units of fromToken.
 */
export async function getQuote(params: {
  fromChain: number;
  toChain: number;
  fromToken: string;
  toToken: string;
  fromAmount: string;
}): Promise<QuoteEstimate | null> {
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
  const res = await fetch(`${BASE}/quote?${q.toString()}`);
  if (res.status === 404) return null; // no route
  if (!res.ok) {
    // 429 or transient; caller decides. Surface as null but log.
    if (res.status !== 429) {
      const txt = await res.text().catch(() => "");
      console.error(`  quote ${res.status}: ${txt.slice(0, 120)}`);
    }
    return null;
  }

  const body = (await res.json()) as any;
  const est = body.estimate ?? {};
  const gasCostsUSD = sumUSD(est.gasCosts);
  const feeCostsUSD = sumUSD(est.feeCosts);

  return {
    toAmount: est.toAmount ?? "0",
    toAmountUSD: est.toAmountUSD,
    fromAmountUSD: est.fromAmountUSD,
    gasCostsUSD,
    feeCostsUSD,
    tool: body.tool ?? est.tool ?? "?",
  };
}

function sumUSD(items: any[] | undefined): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((acc, it) => acc + (parseFloat(it?.amountUSD ?? "0") || 0), 0);
}
