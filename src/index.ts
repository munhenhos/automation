// CLI entry. Runs the scan and prints ranked tables of where the trades are —
// one per currency (USD settles in USDC, EUR settles in EURC).
// Read-only: no keys, no signing, no execution. Automation comes later.

import { BASES, DEFAULT_NOTIONAL_USDC, MAX_NOTIONAL, type Currency } from "./config.js";
import { scan, type Opportunity } from "./scan.js";

function notionalFromArgs(): number {
  const arg = process.argv[2] ?? process.env.NOTIONAL;
  let n = arg ? Number(arg) : DEFAULT_NOTIONAL_USDC;
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Invalid notional "${arg}", using ${DEFAULT_NOTIONAL_USDC}.`);
    return DEFAULT_NOTIONAL_USDC;
  }
  if (n > MAX_NOTIONAL) {
    console.error(`Notional ${n} exceeds the ${MAX_NOTIONAL} cap; clamping to ${MAX_NOTIONAL}.`);
    n = MAX_NOTIONAL;
  }
  return n;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printTable(currency: Currency, rows: Opportunity[], notional: number) {
  const base = BASES[currency].symbol;
  console.log(`\n=== ${currency} — round trip: ${base}@Base -> stable@chain -> ${base}@Base, size ${notional.toLocaleString()} ${base} ===`);

  if (rows.length === 0) {
    console.log(`No routable ${currency} pairs.`);
    return;
  }
  console.log(`Net = final ${base} minus starting ${base} minus gas (gas converted to ${base}). Fees & slippage already in the quotes.\n`);

  const header = [
    pad("STABLE", 8),
    pad("CHAIN", 10),
    pad(`NET ${base}`, 13),
    pad("NET %", 9),
    pad("GAS USD", 9),
    pad("VIA (out/in)", 22),
    "STABLE + POOL (DefiLlama)",
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length + 20));

  for (const r of rows) {
    const flag = r.net > 0 ? "  <-- profitable" : "";
    let pool: string;
    if (r.source === "manual") {
      pool = `MANUAL (you approved) ${r.address}${r.note ? ` — ${r.note}` : ""}`;
    } else if (r.verified) {
      const mcapM = (r.verified.stableMcapUsd / 1e6).toFixed(0);
      pool = `mcap $${mcapM}M | ${r.verified.project} ${r.verified.poolSymbol} pool $${Math.round(r.verified.tvlUsd).toLocaleString()}`;
    } else {
      pool = "";
    }
    console.log(
      [
        pad(r.stable, 8),
        pad(r.chain, 10),
        pad(`${r.net >= 0 ? "+" : ""}${r.net.toFixed(2)}`, 13),
        pad(`${r.netPct.toFixed(3)}%`, 9),
        pad(r.gasUsd.toFixed(2), 9),
        pad(`${r.outboundTool}/${r.inboundTool}`, 22),
        pool + flag,
      ].join(" "),
    );
  }

  const profitable = rows.filter((r) => r.net > 0);
  console.log(`\n${profitable.length} of ${rows.length} ${currency} round trips net positive at this size.`);
}

async function main() {
  const notional = notionalFromArgs();
  const rows = await scan(notional);
  if (rows.length === 0) {
    console.log("\nNo routable stable pairs found. Check network / LI.FI availability.");
    return;
  }

  for (const currency of Object.keys(BASES) as Currency[]) {
    printTable(currency, rows.filter((r) => r.currency === currency), notional);
  }

  const anyProfit = rows.some((r) => r.net > 0);
  console.log(
    anyProfit
      ? "\nProfitable rows are executable today, but quotes go stale in seconds. Re-run before acting."
      : "\nNothing clears fees + gas right now. That's the normal state — pegs are tight.",
  );
}

main().catch((err) => {
  console.error("\nScan failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
