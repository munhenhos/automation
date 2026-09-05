// CLI entry. Runs the scan and prints a ranked table of where the trades are.
// Read-only: no keys, no signing, no execution. Automation comes later.

import { DEFAULT_NOTIONAL_USDC } from "./config.js";
import { scan, type Opportunity } from "./scan.js";

function notionalFromArgs(): number {
  const arg = process.argv[2] ?? process.env.NOTIONAL;
  const n = arg ? Number(arg) : DEFAULT_NOTIONAL_USDC;
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Invalid notional "${arg}", using ${DEFAULT_NOTIONAL_USDC}.`);
    return DEFAULT_NOTIONAL_USDC;
  }
  return n;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printTable(rows: Opportunity[], notional: number) {
  console.log(`\nRound trip: USDC@Base -> stable@chain -> USDC@Base, size ${notional.toLocaleString()} USDC`);
  console.log("Net = final USDC minus starting USDC minus gas. Fees & slippage already in the quotes.\n");

  const header = [
    pad("STABLE", 8),
    pad("CHAIN", 10),
    pad("NET USD", 12),
    pad("NET %", 9),
    pad("GAS USD", 9),
    pad("VIA (out/in)", 22),
    "STABLE + POOL (DefiLlama)",
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length + 20));

  for (const r of rows) {
    const flag = r.netUsd > 0 ? "  <-- profitable" : "";
    const mcapM = (r.verified.stableMcapUsd / 1e6).toFixed(0);
    const pool = `mcap $${mcapM}M | ${r.verified.project} ${r.verified.poolSymbol} pool $${Math.round(r.verified.tvlUsd).toLocaleString()}`;
    console.log(
      [
        pad(r.stable, 8),
        pad(r.chain, 10),
        pad(`${r.netUsd >= 0 ? "+" : ""}${r.netUsd.toFixed(2)}`, 12),
        pad(`${r.netPct.toFixed(3)}%`, 9),
        pad(r.gasUsd.toFixed(2), 9),
        pad(`${r.outboundTool}/${r.inboundTool}`, 22),
        pool + flag,
      ].join(" "),
    );
  }

  const profitable = rows.filter((r) => r.netUsd > 0);
  console.log(`\n${profitable.length} of ${rows.length} round trips net positive at this size.`);
  if (profitable.length === 0) {
    console.log("Nothing clears fees + gas right now. That's the normal state — pegs are tight.");
  } else {
    console.log("Profitable rows are executable today, but quotes go stale in seconds. Re-run before acting.");
  }
}

async function main() {
  const notional = notionalFromArgs();
  const rows = await scan(notional);
  if (rows.length === 0) {
    console.log("\nNo routable stable pairs found. Check network / LI.FI availability.");
    return;
  }
  printTable(rows, notional);
}

main().catch((err) => {
  console.error("\nScan failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
