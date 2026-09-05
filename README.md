# Stablecoin arbitrage scanner

Finds where unbalanced stablecoin pools are mispriced enough to trade. Read-only
for now — it tells you *where the trades are*. No wallet, no keys, no execution.
Automation comes later.

## The idea

House rules: every trade starts and ends in **USDC on Base**. So an opportunity
is a full round trip:

```
USDC @ Base  ->  <stable> @ <chain>  ->  USDC @ Base
```

Both legs are priced with **real executable quotes from LI.FI** (the engine
behind [Jumper](https://jumper.exchange)). That means the numbers already
include DEX fees, bridge fees and slippage for the size you're quoting. We then
subtract gas. If you'd end with more USDC than you started, the pool is
mispriced enough to trade *after all costs* — not just in theory.

This is the honest part: a 0.3% peg deviation is not 0.3% profit. Size,
slippage, bridge fees and gas eat most small deviations. The scanner shows the
net number, so most of the time the answer is "nothing clears costs right now",
which is correct.

## What counts as "legit"

A `(chain, stablecoin)` pair is only scanned if **DefiLlama** vouches for it: it
must appear in a pool from a reputable AMM (Curve, Uniswap, Aerodrome, Balancer,
Velodrome, Fluid, Sushi, Pancake) with TVL above a floor (default $1M). The
trusted projects, stables, chains and thresholds all live in `src/config.ts` and
nothing outside that list is ever touched.

Stablecoins considered: USDC, USDT, DAI, USDS, crvUSD, GHO, USDe, FRAX, LUSD.
Yield-bearing wrappers (sUSDe, sDAI, ...) are excluded — they don't peg to $1.

Chains scanned: Base (home), Ethereum, Arbitrum, Optimism, Polygon.

## Run it

```bash
npm install
npm run scan            # default size: 10,000 USDC
npm run scan 50000      # quote a 50k round trip
NOTIONAL=2000 npm run scan
npm test                # offline math self-test
```

Output is a ranked table: net USD, net %, gas, the bridge/DEX used on each leg,
and the DefiLlama pool that vouches for the stable. Rows that clear costs are
flagged. Quotes go stale in seconds — re-run before acting on anything.

## Network requirement

The scanner calls two hosts:

- `yields.llama.fi` (DefiLlama pools)
- `li.quest` (LI.FI / Jumper quotes and token lists)

**Both must be reachable.** In a restricted/managed environment these may be
blocked by egress policy (you'll see `403 CONNECT tunnel failed`). If so, run the
scanner from a machine with open outbound HTTPS, or have those two hosts
allow-listed. The code itself is unaffected — `npm test` runs fully offline.

## What this is not (yet)

- It does **not** execute trades. No private key is read anywhere.
- It does **not** account for MEV, mempool competition, or the fact that a
  visible arb is often gone by the time you'd land the tx.
- Quotes are indicative. Real fills can differ.

## Where automation would plug in

`src/scan.ts` already produces structured `Opportunity` objects. Execution would
be a separate module that: takes a positive-net opportunity, re-quotes it fresh,
fetches the transaction data from LI.FI's `/quote` (same call, minus the
read-only stance), signs with a funded wallet on Base, and monitors the round
trip back to USDC. That's deliberately not built here — it needs keys, risk
limits, and your explicit go-ahead.

## Layout

```
src/config.ts     trusted chains, stables, projects, thresholds, trade size
src/defillama.ts  pulls pools, builds the verified (chain, stable) whitelist
src/lifi.ts       token addresses + executable round-trip quotes
src/scan.ts       the round-trip loop and net-PnL math
src/index.ts      CLI entry + ranked table
src/selftest.ts   offline arithmetic checks
```
