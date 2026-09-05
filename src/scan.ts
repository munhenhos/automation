// The core loop. For every trusted (chain, stable), simulate the full round
// trip that respects the house rules:
//
//     USDC on Base  ->  <stable> on <chain>  ->  USDC on Base
//
// Both legs are real LI.FI quotes, so the final USDC already accounts for DEX
// fees, bridge fees and slippage. We then subtract gas to get true net PnL.
// If final USDC > starting USDC, the pool is mispriced enough to trade.

import { CHAINS, HOME } from "./config.js";
import { fetchVerifiedStables, isVerified, type VerifiedPool } from "./defillama.js";
import { fetchTokens, getQuote, type Token } from "./lifi.js";

export type Opportunity = {
  chain: string;
  stable: string;
  notionalUsdc: number;
  finalUsdc: number;
  grossUsd: number;
  gasUsd: number;
  netUsd: number;
  netPct: number;
  outboundTool: string;
  inboundTool: string;
  verified: VerifiedPool;
};

export function toRaw(human: number, decimals: number): string {
  // Avoid float dust: work in integer string.
  const [int = "0", frac = ""] = human.toString().split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(int) * 10n ** BigInt(decimals) + BigInt(fracPadded || "0")).toString();
}

export function fromRaw(raw: string, decimals: number): number {
  return Number(BigInt(raw)) / 10 ** decimals;
}

export async function scan(notionalUsdc: number): Promise<Opportunity[]> {
  console.error("Fetching DefiLlama verified stable pools...");
  const verified = await fetchVerifiedStables();
  console.error(`  ${verified.size} trusted (chain, stable) pairs.\n`);

  console.error("Fetching LI.FI token lists...");
  const tokensByChain = new Map<number, Map<string, Token>>();
  for (const c of CHAINS) {
    tokensByChain.set(c.id, await fetchTokens(c.id));
  }

  const homeTokens = tokensByChain.get(HOME.chainId)!;
  const homeUsdc = homeTokens.get(HOME.symbol);
  if (!homeUsdc) throw new Error("Could not resolve USDC on Base from LI.FI.");
  const fromAmount = toRaw(notionalUsdc, homeUsdc.decimals);

  const results: Opportunity[] = [];

  for (const c of CHAINS) {
    const chainTokens = tokensByChain.get(c.id)!;
    for (const [symbol, token] of chainTokens) {
      // Skip the home asset itself.
      if (c.id === HOME.chainId && symbol === HOME.symbol) continue;

      const v = isVerified(verified, c.id, symbol);
      if (!v) continue; // not vouched for by DefiLlama -> skip

      process.stderr.write(`Quoting ${HOME.symbol}@Base -> ${symbol}@${c.name} -> ${HOME.symbol}@Base ... `);

      // Leg 1: USDC(Base) -> stable(chain)
      const out = await getQuote({
        fromChain: HOME.chainId,
        toChain: c.id,
        fromToken: homeUsdc.address,
        toToken: token.address,
        fromAmount,
      });
      if (!out || out.toAmount === "0") {
        console.error("no outbound route");
        continue;
      }

      // Leg 2: stable(chain) -> USDC(Base), feeding leg 1's output back in.
      const back = await getQuote({
        fromChain: c.id,
        toChain: HOME.chainId,
        fromToken: token.address,
        toToken: homeUsdc.address,
        fromAmount: out.toAmount,
      });
      if (!back || back.toAmount === "0") {
        console.error("no inbound route");
        continue;
      }

      const finalUsdc = fromRaw(back.toAmount, homeUsdc.decimals);
      const grossUsd = finalUsdc - notionalUsdc;
      const gasUsd = out.gasCostsUSD + back.gasCostsUSD;
      const netUsd = grossUsd - gasUsd;
      const netPct = (netUsd / notionalUsdc) * 100;

      console.error(`net ${netUsd >= 0 ? "+" : ""}${netUsd.toFixed(2)} USD (${netPct.toFixed(3)}%)`);

      results.push({
        chain: c.name,
        stable: symbol,
        notionalUsdc,
        finalUsdc,
        grossUsd,
        gasUsd,
        netUsd,
        netPct,
        outboundTool: out.tool,
        inboundTool: back.tool,
        verified: v,
      });
    }
  }

  results.sort((a, b) => b.netUsd - a.netUsd);
  return results;
}
