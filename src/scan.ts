// The core loop. Each stable round-trips against the base of its own currency:
//
//     USD stables:  USDC on Base  ->  <stable> on <chain>  ->  USDC on Base
//     EUR stables:  EURC on Base  ->  <stable> on <chain>  ->  EURC on Base
//
// Keeping EUR on its own EURC base means a EUR opportunity never crosses
// EUR/USD — it's a pure EUR-peg imbalance. Both legs are real LI.FI quotes, so
// the amount back already accounts for DEX fees, bridge fees and slippage. Gas
// (reported by LI.FI in USD) is converted into the base currency and subtracted,
// so net PnL is expressed in that base's own units.
//
// Targets come from two sources:
//   - DefiLlama-verified stables (legit + sizeable + pooled on a good venue), or
//   - manually approved stables (you vouched for them and pinned the address).

import { BASES, CHAINS, type Currency } from "./config.js";
import { loadApprovedStables } from "./approved.js";
import { fetchVerifiedStables, isVerified, type VerifiedPool } from "./defillama.js";
import { fetchTokens, getQuote, type Token } from "./lifi.js";

export type Opportunity = {
  chain: string;
  stable: string;
  address: string;
  source: "defillama" | "manual";
  currency: Currency;
  /** All amounts below are in the base currency's units (USDC or EURC). */
  notional: number;
  finalBase: number;
  gross: number;
  gasUsd: number;
  net: number;
  netPct: number;
  outboundTool: string;
  inboundTool: string;
  verified?: VerifiedPool;
  note?: string;
};

type Target = {
  chainId: number;
  chainName: string;
  symbol: string;
  address: string;
  currency: Currency;
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

function basePriceUsd(token: Token, currency: Currency): number {
  const p = token.priceUSD ? parseFloat(token.priceUSD) : NaN;
  if (Number.isFinite(p) && p > 0) return p;
  return currency === "USD" ? 1 : 1.08; // fallback if LI.FI omits the price
}

async function buildTargets(): Promise<{ targets: Target[]; baseTokens: Record<Currency, Token | undefined> }> {
  console.error("Fetching DefiLlama verified stable pools...");
  const verified = await fetchVerifiedStables();
  console.error(`  ${verified.size} trusted (chain, stable) pairs.`);

  console.error("Fetching LI.FI token lists...");
  const tokensByChain = new Map<number, Map<string, Token>>();
  for (const c of CHAINS) {
    tokensByChain.set(c.id, await fetchTokens(c.id));
  }

  // Resolve both base tokens (USDC and EURC on Base).
  const baseTokens = {} as Record<Currency, Token | undefined>;
  for (const cur of Object.keys(BASES) as Currency[]) {
    const base = BASES[cur];
    const t = tokensByChain.get(base.chainId)?.get(base.symbol);
    baseTokens[cur] = t;
    if (!t) console.error(`  WARNING: could not resolve ${base.symbol} on chain ${base.chainId}; ${cur} scan will be skipped.`);
  }

  const targets: Target[] = [];
  const seen = new Set<string>(); // `${chainId}:${addressLower}`

  // DefiLlama-verified targets (need LI.FI to resolve the canonical address).
  for (const c of CHAINS) {
    const chainTokens = tokensByChain.get(c.id)!;
    for (const [symbol, token] of chainTokens) {
      const v = isVerified(verified, c.id, symbol);
      if (!v) continue;
      const key = `${c.id}:${token.address.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ chainId: c.id, chainName: c.name, symbol, address: token.address, currency: v.currency, source: "defillama", verified: v });
    }
  }

  // Manually approved targets (address pinned by the user; gates bypassed).
  const approved = loadApprovedStables();
  if (approved.length > 0) console.error(`Loaded ${approved.length} manually approved stable(s).`);
  for (const a of approved) {
    const chain = CHAINS.find((c) => c.id === a.chainId)!;
    const key = `${a.chainId}:${a.address.toLowerCase()}`;
    if (seen.has(key)) continue; // already covered by DefiLlama
    seen.add(key);
    targets.push({ chainId: a.chainId, chainName: chain.name, symbol: a.symbol, address: a.address, currency: a.currency, source: "manual", note: a.note });
  }

  return { targets, baseTokens };
}

export async function scan(notional: number): Promise<Opportunity[]> {
  const { targets, baseTokens } = await buildTargets();
  console.error(`\nScanning ${targets.length} targets at ${notional.toLocaleString()} in each base's units...\n`);

  const results: Opportunity[] = [];

  for (const t of targets) {
    const base = BASES[t.currency];
    const baseToken = baseTokens[t.currency];
    if (!baseToken) continue; // base unresolved, already warned

    // Skip the base asset itself (its own trivial round trip).
    if (t.chainId === base.chainId && t.address.toLowerCase() === baseToken.address.toLowerCase()) continue;

    const tag = t.source === "manual" ? " [manual]" : "";
    process.stderr.write(`Quoting ${base.symbol}@Base -> ${t.symbol}@${t.chainName}${tag} -> ${base.symbol}@Base ... `);

    const fromAmount = toRaw(notional, baseToken.decimals);

    // Leg 1: base(Base) -> stable(chain)
    const out = await getQuote({
      fromChain: base.chainId,
      toChain: t.chainId,
      fromToken: baseToken.address,
      toToken: t.address,
      fromAmount,
    });
    if (!out || out.toAmount === "0") {
      console.error("no outbound route");
      continue;
    }

    // Leg 2: stable(chain) -> base(Base), feeding leg 1's output back in.
    const back = await getQuote({
      fromChain: t.chainId,
      toChain: base.chainId,
      fromToken: t.address,
      toToken: baseToken.address,
      fromAmount: out.toAmount,
    });
    if (!back || back.toAmount === "0") {
      console.error("no inbound route");
      continue;
    }

    const finalBase = fromRaw(back.toAmount, baseToken.decimals);
    const gross = finalBase - notional;
    const gasUsd = out.gasCostsUSD + back.gasCostsUSD;
    const gasBase = gasUsd / basePriceUsd(baseToken, t.currency);
    const net = gross - gasBase;
    const netPct = (net / notional) * 100;

    console.error(`net ${net >= 0 ? "+" : ""}${net.toFixed(2)} ${base.symbol} (${netPct.toFixed(3)}%)`);

    results.push({
      chain: t.chainName,
      stable: t.symbol,
      address: t.address,
      source: t.source,
      currency: t.currency,
      notional,
      finalBase,
      gross,
      gasUsd,
      net,
      netPct,
      outboundTool: out.tool,
      inboundTool: back.tool,
      verified: t.verified,
      note: t.note,
    });
  }

  results.sort((a, b) => b.netPct - a.netPct);
  return results;
}
