// The core loop. For every trusted (chain, stable), simulate the full round
// trip that respects the house rules:
//
//     USDC on Base  ->  <stable> on <chain>  ->  USDC on Base
//
// Both legs are real LI.FI quotes, so the final USDC already accounts for DEX
// fees, bridge fees and slippage. We then subtract gas to get true net PnL.
// If final USDC > starting USDC, the pool is mispriced enough to trade.
//
// Targets come from two sources:
//   - DefiLlama-verified stables (legit + sizeable + pooled on a good venue), or
//   - manually approved stables (you vouched for them and pinned the address).

import { CHAINS, HOME } from "./config.js";
import { loadApprovedStables } from "./approved.js";
import { fetchVerifiedStables, isVerified, type VerifiedPool } from "./defillama.js";
import { fetchTokens, getQuote, type Token } from "./lifi.js";

export type Opportunity = {
  chain: string;
  stable: string;
  address: string;
  source: "defillama" | "manual";
  notionalUsdc: number;
  finalUsdc: number;
  grossUsd: number;
  gasUsd: number;
  netUsd: number;
  netPct: number;
  outboundTool: string;
  inboundTool: string;
  /** Present for DefiLlama-sourced targets. */
  verified?: VerifiedPool;
  /** Present for manually approved targets. */
  note?: string;
};

type Target = {
  chainId: number;
  chainName: string;
  symbol: string;
  address: string;
  source: "defillama" | "manual";
  verified?: VerifiedPool;
  note?: string;
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

async function buildTargets(): Promise<{ targets: Target[]; homeUsdc: Token }> {
  console.error("Fetching DefiLlama verified stable pools...");
  const verified = await fetchVerifiedStables();
  console.error(`  ${verified.size} trusted (chain, stable) pairs.`);

  console.error("Fetching LI.FI token lists...");
  const tokensByChain = new Map<number, Map<string, Token>>();
  for (const c of CHAINS) {
    tokensByChain.set(c.id, await fetchTokens(c.id));
  }

  const homeTokens = tokensByChain.get(HOME.chainId)!;
  const homeUsdc = homeTokens.get(HOME.symbol);
  if (!homeUsdc) throw new Error("Could not resolve USDC on Base from LI.FI.");

  const targets: Target[] = [];
  const seen = new Set<string>(); // `${chainId}:${addressLower}`

  // DefiLlama-verified targets (need LI.FI to resolve the canonical address).
  for (const c of CHAINS) {
    const chainTokens = tokensByChain.get(c.id)!;
    for (const [symbol, token] of chainTokens) {
      if (c.id === HOME.chainId && symbol === HOME.symbol) continue; // skip home asset
      const v = isVerified(verified, c.id, symbol);
      if (!v) continue;
      const key = `${c.id}:${token.address.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ chainId: c.id, chainName: c.name, symbol, address: token.address, source: "defillama", verified: v });
    }
  }

  // Manually approved targets (address pinned by the user; gates bypassed).
  const approved = loadApprovedStables();
  if (approved.length > 0) console.error(`Loaded ${approved.length} manually approved stable(s).`);
  for (const a of approved) {
    const chain = CHAINS.find((c) => c.id === a.chainId)!;
    if (a.chainId === HOME.chainId && a.address.toLowerCase() === homeUsdc.address.toLowerCase()) continue;
    const key = `${a.chainId}:${a.address.toLowerCase()}`;
    if (seen.has(key)) continue; // already covered by DefiLlama
    seen.add(key);
    targets.push({ chainId: a.chainId, chainName: chain.name, symbol: a.symbol, address: a.address, source: "manual", note: a.note });
  }

  return { targets, homeUsdc };
}

export async function scan(notionalUsdc: number): Promise<Opportunity[]> {
  const { targets, homeUsdc } = await buildTargets();
  const fromAmount = toRaw(notionalUsdc, homeUsdc.decimals);
  console.error(`\nScanning ${targets.length} targets at ${notionalUsdc.toLocaleString()} USDC...\n`);

  const results: Opportunity[] = [];

  for (const t of targets) {
    const tag = t.source === "manual" ? " [manual]" : "";
    process.stderr.write(`Quoting ${HOME.symbol}@Base -> ${t.symbol}@${t.chainName}${tag} -> ${HOME.symbol}@Base ... `);

    // Leg 1: USDC(Base) -> stable(chain)
    const out = await getQuote({
      fromChain: HOME.chainId,
      toChain: t.chainId,
      fromToken: homeUsdc.address,
      toToken: t.address,
      fromAmount,
    });
    if (!out || out.toAmount === "0") {
      console.error("no outbound route");
      continue;
    }

    // Leg 2: stable(chain) -> USDC(Base), feeding leg 1's output back in.
    const back = await getQuote({
      fromChain: t.chainId,
      toChain: HOME.chainId,
      fromToken: t.address,
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
      chain: t.chainName,
      stable: t.symbol,
      address: t.address,
      source: t.source,
      notionalUsdc,
      finalUsdc,
      grossUsd,
      gasUsd,
      netUsd,
      netPct,
      outboundTool: out.tool,
      inboundTool: back.tool,
      verified: t.verified,
      note: t.note,
    });
  }

  results.sort((a, b) => b.netUsd - a.netUsd);
  return results;
}
