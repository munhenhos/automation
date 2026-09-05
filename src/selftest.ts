// Offline sanity checks for the arithmetic, since live APIs may be blocked by
// network policy. Run: npx tsx src/selftest.ts
import { toRaw, fromRaw } from "./scan.js";
import { mcapUsd } from "./defillama.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}  got=${got} want=${want}`);
}

// USDC has 6 decimals.
check("toRaw 10000 USDC", toRaw(10000, 6), "10000000000");
check("toRaw 5000.5 USDC", toRaw(5000.5, 6), "5000500000");
check("fromRaw back to 10000", fromRaw("10000000000", 6), 10000);

// DAI has 18 decimals.
check("toRaw 1 DAI", toRaw(1, 18), "1000000000000000000");
check("fromRaw 1 DAI", fromRaw("1000000000000000000", 18), 1);

// Net PnL math, mirroring scan.ts, with a synthetic +0.4% gross, $6 gas.
const notional = 10000;
const finalUsdc = fromRaw("10040000000", 6); // 10040 USDC out
const grossUsd = finalUsdc - notional;       // +40
const gasUsd = 6;
const netUsd = grossUsd - gasUsd;            // +34
const netPct = (netUsd / notional) * 100;    // 0.34%
check("gross +40", grossUsd, 40);
check("net +34", netUsd, 34);
check("netPct 0.34", Number(netPct.toFixed(2)), 0.34);

// Market-cap-in-USD conversion across peg types.
check("USD mcap = supply", mcapUsd("peggedUSD", { peggedUSD: 1_000_000 }, 1), 1_000_000);
check("USD mcap defaults price to 1", mcapUsd("peggedUSD", { peggedUSD: 500 }, null), 500);
check("EUR mcap = supply * price", mcapUsd("peggedEUR", { peggedEUR: 1_000_000 }, 1.08), 1_080_000);
check("EUR mcap 0 without price", mcapUsd("peggedEUR", { peggedEUR: 1_000_000 }, null), 0);
check("empty circulating -> 0", mcapUsd("peggedUSD", null, 1), 0);

console.log(failures === 0 ? "\nAll self-tests passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
