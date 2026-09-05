# Stablecoin arbitrage scanner

Finds where unbalanced stablecoin pools are mispriced enough to trade. Read-only
for now — it tells you *where the trades are*. No wallet, no keys, no execution.
Automation comes later.

## The idea

USD and EUR are scanned as two separate books, each with its own home base:

```
USD stables:  USDC @ Base  ->  <stable> @ <chain>  ->  USDC @ Base
EUR stables:  EURC @ Base  ->  <stable> @ <chain>  ->  EURC @ Base
```

Each round trip starts and ends on Base, in that book's base asset. Keeping EUR
on EURC means a EUR trade never crosses EUR/USD — it's a pure EUR-peg imbalance,
no FX exposure. Results print as two tables, USD then EUR.

Both legs are priced with **real executable quotes from LI.FI** (the engine
behind [Jumper](https://jumper.exchange)). The numbers already include DEX fees,
bridge fees and slippage for the size you're quoting. Gas (which LI.FI reports in
USD) is converted into the book's base currency and subtracted, so net PnL is in
that base's units. If you'd end with more of the base than you started, the pool
is mispriced enough to trade *after all costs* — not just in theory.

This is the honest part: a 0.3% peg deviation is not 0.3% profit. Size,
slippage, bridge fees and gas eat most small deviations. The scanner shows the
net number, so most of the time the answer is "nothing clears costs right now",
which is correct.

## What counts as "legit"

Two independent gates, both from **DefiLlama**:

1. **The stablecoin is legit and sizeable.** Its circulating supply / market cap
   (DefiLlama stablecoins dataset, USD- or EUR-pegged) must clear a floor —
   default **$50M**. This is what stops a scam or dead token sneaking in.
2. **It's actually pooled here.** It must appear in a pool from a reputable AMM
   (Curve, Uniswap, Aerodrome, Balancer, Velodrome, Fluid, Sushi, Pancake) on
   that chain. The pool TVL floor is deliberately **low ($1k)** — small,
   unbalanced pools are where the arbitrage lives, so we don't exclude them.

So: big trusted stables, small pools welcome. The trusted projects, candidate
stables, chains and both thresholds all live in `src/config.ts`.

Candidate stablecoins:
- USD: USDC, USDT, DAI, USDS, crvUSD, GHO, USDe, FRAX, LUSD, USDG, USDT0
- EUR: EURC, EURe, EURS, EURA/agEUR, EURt

Each still has to pass the market-cap gate at runtime (for EUR stables the supply
is converted to USD via price, so the floor is like-for-like). Yield-bearing
wrappers (sUSDe, sDAI, ...) are excluded; they don't hold a fixed peg.

**EUR is its own book.** EUR stables round-trip against EURC on Base, not USDC,
so no EUR/USD crossing enters the trade — the number is a clean EUR-peg
imbalance. The market-cap floor is still applied in USD (EUR supply × price) so
"decent size" means the same thing across both books. Caveat: EUR stables are
thinner, so expect more noise on the EUR table. Trust net-after-gas, not gross.

Chains scanned: Base (home), Ethereum, Arbitrum, Optimism, Polygon, Gnosis,
HyperEVM (Hyperliquid), Robinhood Chain. All are bridgeable via Jumper/LI.FI.

Note on the two newest chains: I couldn't confirm from this environment the exact
string DefiLlama uses in its pool `chain` field for HyperEVM and Robinhood, so
`src/config.ts` matches several likely spellings (`llamaAliases`). If a live run
shows zero pairs for one of them, check the `chain` value in
`https://yields.llama.fi/pools` and add the exact spelling to that chain's
`llamaAliases`. Wrong spelling = silently skipped, never a crash.

## Including a lower-TVL stable you trust

The market-cap gate ($50M) keeps junk out, but it also blocks small, legit
stables you might specifically want to watch. To include one, approve it by hand
— you provide the exact contract address, and that entry bypasses both the
market-cap and pool gates. Pinning the address is the safety: it quotes *that*
token, not whatever shares the symbol on that chain.

```bash
cp approved-stables.example.json approved-stables.json
# edit it:
```

```json
[
  { "chainId": 8453, "symbol": "SOMEUSD", "address": "0xTheExactTokenContract", "currency": "USD", "note": "why you trust it" }
]
```

- `chainId` must be a chain the scanner already covers (see the list above).
- `address` must be the real 0x token contract on that chain — malformed or
  wrong-chain entries are skipped with a warning, never trusted silently.
- `currency` is `"USD"` or `"EUR"` (defaults to `USD`) — it decides which base
  the stable round-trips against (USDC or EURC on Base).
- Manual entries show as `MANUAL (you approved)` in the output.
- The file is git-ignored so your picks stay local. Override the path with
  `APPROVED_STABLES=/path/to/file`. Commit it deliberately if you want it shared.

## Run it

```bash
npm install
npm run scan            # default size: 10,000 (USDC for USD book, EURC for EUR book)
npm run scan 50000      # quote a 50k round trip
NOTIONAL=2000 npm run scan
npm test                # offline math self-test
```

Output is two ranked tables (USD then EUR): net in the base asset, net %, gas,
the bridge/DEX used on each leg, and the DefiLlama pool that vouches for the
stable. Rows that clear costs are flagged. Quotes go stale in seconds — re-run
before acting on anything.

## Network requirement

The scanner calls two hosts:

- `yields.llama.fi` (DefiLlama pools)
- `stablecoins.llama.fi` (DefiLlama stablecoin market caps)
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
- **Small pools cut both ways.** A tiny pool is easy to unbalance, but you can
  only trade it up to its depth — a large order moves the price and eats its own
  edge. The LI.FI quotes reflect the best *aggregated* route at the size you ask
  for, so if you want to target a specific small pool, quote a size at or below
  that pool's TVL. Big size on a small pool is a mirage.

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
src/defillama.ts  stablecoin market caps + pools -> verified (chain, stable) set
src/lifi.ts       token addresses + executable round-trip quotes
src/scan.ts       the round-trip loop and net-PnL math
src/index.ts      CLI entry + ranked table
src/selftest.ts   offline arithmetic checks
```
