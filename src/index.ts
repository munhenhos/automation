// CLI entry. Runs the scan and prints ranked tables of where the trades are —
// one per currency (USD settles in USDC, EUR settles in EURC). Each target is
// priced at several sizes so you can see where it turns profitable.
// Read-only: no keys, no signing, no execution. Automation comes later.

import { BASES, MAX_NOTIONAL, NOTIONAL_STEPS, type Currency } from "./config.js";
import { scan, type Opportunity } from "./scan.js";

function stepsFromArgs(): number[] {
  const arg = process.argv[2] ?? process.env.NOTIONAL;
  if (!arg) return NOTIONAL_STEPS;
  const parsed = arg
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.min(n, MAX_NOTIONAL));
  if (parsed.length === 0) {
    console.error(`Invalid size(s) "${arg}", using ${NOTIONAL_STEPS.join(", ")}.`);
    return NOTIONAL_STEPS;
  }
  return [...new Set(parsed)].sort((a, b) => a - b);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function netCell(net: number | null): string {
  if (net === null) return "-";
  return `${net >= 0 ? "+" : ""}${net.toFixed(2)}`;
}

function printTable(currency: Currency, rows: Opportunity[], sizes: number[]) {
  const base = BASES[currency].symbol;
  console.log(`\n=== ${currency} — round trip: ${base}@Base -> stable@chain -> ${base}@Base ===`);

  if (rows.length === 0) {
    console.log(`No routable ${currency} pairs.`);
    return;
  }
  console.log(`Net per size, in ${base} (final minus start minus gas). Fees & slippage already in the quotes.\n`);

  const sizeCols = sizes.map((s) => pad(`NET@${s}`, 11));
  const header = [pad("STABLE", 8), pad("CHAIN", 10), ...sizeCols, pad("GAS USD", 9), pad("VIA (out/in)", 22), "STABLE + POOL (DefiLlama)"].join(" ");
  console.log(header);
  console.log("-".repeat(header.length + 20));

  for (const r of rows) {
    const flag = r.bestNet > 0 ? "  <-- profitable" : "";
    let pool: string;
    if (r.source === "manual") {
      pool = `MANUAL (you approved) ${r.address}${r.note ? ` — ${r.note}` : ""}`;
    } else if (r.verified) {
      const mcapM = (r.verified.stableMcapUsd / 1e6).toFixed(0);
      pool = `mcap $${mcapM}M | ${r.verified.project} ${r.verified.poolSymbol} pool $${Math.round(r.verified.tvlUsd).toLocaleString()}`;
    } else {
      pool = "";
    }
    // Gas is ~size-independent; show the first available step's gas.
    const gas = r.steps.find((s) => s.gasUsd !== null)?.gasUsd ?? null;
    const cells = r.steps.map((s) => pad(netCell(s.net), 11));
    console.log(
      [pad(r.stable, 8), pad(r.chain, 10), ...cells, pad(gas === null ? "-" : gas.toFixed(2), 9), pad(r.via, 22), pool + flag].join(" "),
    );
  }

  const profitable = rows.filter((r) => r.bestNet > 0);
  console.log(`\n${profitable.length} of ${rows.length} ${currency} pairs net positive at some size.`);
}

async function main() {
  const sizes = stepsFromArgs();
  const rows = await scan(sizes);
  if (rows.length === 0) {
    console.log("\nNo routable stable pairs found. Check network / LI.FI availability.");
    return;
  }

  for (const currency of Object.keys(BASES) as Currency[]) {
    printTable(currency, rows.filter((r) => r.currency === currency), sizes);
  }

  const anyProfit = rows.some((r) => r.bestNet > 0);
  console.log(
    anyProfit
      ? "\nProfitable rows are executable today, but quotes go stale in seconds. Re-run before acting."
      : "\nNothing clears fees + gas at any size right now. That's the normal state — pegs are tight.",
  );
}

main().catch((err) => {
  console.error("\nScan failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
