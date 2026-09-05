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
import { RateLimitedError, fetchTokens, getQuote, type Token } from "./lifi.js";

/** Net result at one trade size. null net/netPct means no route at that size. */
export type StepResult = {
  size: number;
  net: number | null; // base currency units
  netPct: number | null;
  gasUsd: number | null;
};

export type Opportunity = {
  chain: string;
  stable: string;
  address: string;
  source: "defillama" | "manual";
  currency: Currency;
  /** One entry per configured trade size, amounts in base units (USDC/EURC). */
  steps: StepResult[];
  /** Best (max) net across sizes, for ranking. */
  bestNet: number;
  via: string;
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

/**
 * Price one target at one size. Returns null only when a leg genuinely has no
 * route. A rate limit throws RateLimitedError so it can never be misread as
 * "no route" — that distinction is the difference between a real finding and a
 * false one.
 */
async function quoteRoundTrip(
  base: (typeof BASES)[Currency],
  baseToken: Token,
  currency: Currency,
  target: Target,
  size: number,
): Promise<{ net: number; netPct: number; gasUsd: number; via: string } | null> {
  const fromAmount = toRaw(size, baseToken.decimals);

  // Leg 1: base(Base) -> stable(chain)
  const out = await getQuote({
    fromChain: base.chainId,
    toChain: target.chainId,
    fromToken: baseToken.address,
    toToken: target.address,
    fromAmount,
  });
  if (out.status === "rate-limited") throw new RateLimitedError(out.detail);
  if (out.status !== "ok") return null;

  // Leg 2: stable(chain) -> base(Base), feeding leg 1's output back in.
  const back = await getQuote({
    fromChain: target.chainId,
    toChain: base.chainId,
    fromToken: target.address,
    toToken: baseToken.address,
    fromAmount: out.estimate.toAmount,
  });
  if (back.status === "rate-limited") throw new RateLimitedError(back.detail);
  if (back.status !== "ok") return null;

  const finalBase = fromRaw(back.estimate.toAmount, baseToken.decimals);
  const gross = finalBase - size;
  const gasUsd = out.estimate.gasCostsUSD + back.estimate.gasCostsUSD;
  const gasBase = gasUsd / basePriceUsd(baseToken, currency);
  const net = gross - gasBase;
  return { net, netPct: (net / size) * 100, gasUsd, via: `${out.estimate.tool}/${back.estimate.tool}` };
}

export type ScanOutcome = {
  results: Opportunity[];
  /** Set when the scan stopped before covering every target. */
  stoppedEarly?: string;
  scanned: number;
  total: number;
};

export async function scan(sizes: number[]): Promise<ScanOutcome> {
  const { targets, baseTokens } = await buildTargets();
  console.error(`\nScanning ${targets.length} targets at sizes ${sizes.join(", ")} (each base's units)...\n`);

  const results: Opportunity[] = [];
  let scanned = 0;

  for (const t of targets) {
    const base = BASES[t.currency];
    const baseToken = baseTokens[t.currency];
    if (!baseToken) continue; // base unresolved, already warned

    // Skip the base asset itself (its own trivial round trip).
    if (t.chainId === base.chainId && t.address.toLowerCase() === baseToken.address.toLowerCase()) continue;

    const tag = t.source === "manual" ? " [manual]" : "";
    process.stderr.write(`Quoting ${base.symbol}@Base -> ${t.symbol}@${t.chainName}${tag} ... `);

    const steps: StepResult[] = [];
    let via = "";
    let anyRoute = false;

    try {
      for (const size of sizes) {
        const r = await quoteRoundTrip(base, baseToken, t.currency, t, size);
        if (!r) {
          steps.push({ size, net: null, netPct: null, gasUsd: null });
          continue;
        }
        anyRoute = true;
        via = r.via;
        steps.push({ size, net: r.net, netPct: r.netPct, gasUsd: r.gasUsd });
      }
    } catch (e) {
      if (e instanceof RateLimitedError) {
        console.error("RATE LIMITED");
        return {
          results,
          scanned,
          total: targets.length,
          stoppedEarly:
            `LI.FI rate limit hit after ${scanned}/${targets.length} targets: ${e.message}. ` +
            `Remaining targets were NOT scanned (this is not "no route"). Set LIFI_API_KEY for a higher limit, or use fewer sizes.`,
        };
      }
      throw e;
    }

    if (!anyRoute) {
      scanned++;
      console.error("no route");
      continue;
    }

    scanned++;
    const nets = steps.map((s) => s.net).filter((n): n is number => n !== null);
    const bestNet = Math.max(...nets);
    console.error(steps.map((s) => `${s.size}:${s.net === null ? "-" : (s.net >= 0 ? "+" : "") + s.net.toFixed(2)}`).join(" "));

    results.push({
      chain: t.chainName,
      stable: t.symbol,
      address: t.address,
      source: t.source,
      currency: t.currency,
      steps,
      bestNet,
      via,
      verified: t.verified,
      note: t.note,
    });
  }

  results.sort((a, b) => b.bestNet - a.bestNet);
  return { results, scanned, total: targets.length };
}
