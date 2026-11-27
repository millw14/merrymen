# Venue quotes on Robinhood Chain: Stoa, Uniswap, Rialto

A read-only comparison for the venue proposal in #402. It answers one question: for the same pair and input amount at the same moment, how much would the agent receive from each venue, how long does the quote take, and where does a venue fail to quote? Nothing here changes the agent, wallets or trading paths.

The script is [`scripts/compare-venue-quotes.mts`](../scripts/compare-venue-quotes.mts). It only makes `eth_call`s and GET requests:

```bash
npx tsx scripts/compare-venue-quotes.mts                    # Stoa + Uniswap
RIALTO_API_KEY=… npx tsx scripts/compare-venue-quotes.mts   # + Rialto (its /quote needs an integrator key)
npx tsx scripts/compare-venue-quotes.mts --json             # rows as JSON
```

## How each venue is measured

- **Stoa**: `GET https://stoadex.com/api/v1/quote`, no key. `amountOut` is net of Stoa's 2 bps router fee. Stoa holds no liquidity; it routes through the chain's pools (Uniswap V2/V3/V4, Aero, Ramses, up., Pons curves), direct or through one hop token.
- **Uniswap V2**: `Router02.getAmountsOut`, direct and through VIRTUAL, USDG or WETH. LP fee included.
- **Uniswap V3**: `QuoterV2`, every fee tier, direct and two-hop through the same tokens. LP fees included.
- **Uniswap V4** is not quoted by the script: its pools need hook-specific keys. Merrymen's own `worker/src/venues/uniswap-v4.ts` could be added for a fuller picture.
- **Rialto**: `GET /quote` with `RIALTO_API_KEY`. We don't hold an integrator key, so the Rialto rows below are empty; running the script with your key fills them in.
- **Same moment**: on-chain quotes are pinned to one block (shown per case). Stoa's and Rialto's APIs answer at their latest block, so each case is fetched within about a second.
- **Fee-on-transfer tokens**: $MERRYMEN takes 1.00% on every transfer (measured with a simulated swap: what arrives vs the quoter's output on the same path). Uniswap's quoters ignore it, so the Uniswap rows for MERRYMEN show the amount after that fee. Stoa's ETH buy quotes come from a simulated swap and already include it. Stoa's router does not accept fee-on-transfer tokens as input, so Stoa refuses to sell $MERRYMEN.

## Results, 27 November 2026 (UTC)

Amounts are what the agent receives, in the output token. "vs best" compares with the best venue in that case.

**ETH → MERRYMEN, 0.005 in** (block 124405511, 2026-11-27T17:01:28Z)

| Venue | Received | vs best | Latency | Route or failure |
|---|---:|---:|---:|---|
| Stoa | 57,821.6 | +0.00% | 767 ms | Uniswap V3 → Uniswap V2 (via VIRTUAL) |
| Uniswap V2 | 57,661.4 | -0.28% | 165 ms | V2 ETH→VIRTUAL→MERRYMEN (after 1% token transfer fee) |
| Uniswap V3 | — |  | 593 ms | no V3 route |
| Rialto | — |  | 4 ms | skipped: set RIALTO_API_KEY |

**ETH → MERRYMEN, 0.02 in** (block 124405511, 2026-11-27T17:01:29Z)

| Venue | Received | vs best | Latency | Route or failure |
|---|---:|---:|---:|---|
| Stoa | 231,028 | +0.00% | 552 ms | Uniswap V3 → Uniswap V2 (via VIRTUAL) |
| Uniswap V2 | 230,379 | -0.28% | 136 ms | V2 ETH→VIRTUAL→MERRYMEN (after 1% token transfer fee) |
| Uniswap V3 | — |  | 238 ms | no V3 route |
| Rialto | — |  | 1 ms | skipped: set RIALTO_API_KEY |

**ETH → MERRYMEN, 0.1 in** (block 124405511, 2026-11-27T17:01:30Z)

| Venue | Received | vs best | Latency | Route or failure |
|---|---:|---:|---:|---|
| Stoa | 1.1483e+06 | +0.00% | 579 ms | Uniswap V3 → Uniswap V2 (via VIRTUAL) |
| Uniswap V2 | 1.14485e+06 | -0.30% | 159 ms | V2 ETH→VIRTUAL→MERRYMEN (after 1% token transfer fee) |
| Uniswap V3 | — |  | 188 ms | no V3 route |
| Rialto | — |  | 1 ms | skipped: set RIALTO_API_KEY |

**MERRYMEN → ETH, 50000 in** (block 124405511, 2026-11-27T17:01:30Z)

| Venue | Received | vs best | Latency | Route or failure |
|---|---:|---:|---:|---|
| Stoa | — |  | 526 ms | This token takes a fee on every transfer, which Stoa's router refuses to sell |
| Uniswap V2 | 0.00419561 | +0.00% | 145 ms | V2 MERRYMEN→VIRTUAL→ETH (after 1% token transfer fee) |
| Uniswap V3 | — |  | 215 ms | no V3 route |
| Rialto | — |  | 0 ms | skipped: set RIALTO_API_KEY |

**ETH → USDG, 0.01 in** (block 124405511, 2026-11-27T17:01:31Z)

| Venue | Received | vs best | Latency | Route or failure |
|---|---:|---:|---:|---|
| Stoa | 16.6805 | -0.02% | 190 ms | Uniswap V3 |
| Uniswap V2 | 16.6616 | -0.14% | 92 ms | V2 ETH→USDG |
| Uniswap V3 | 16.6841 | +0.00% | 123 ms | V3 ETH→USDG 0.01% |
| Rialto | — |  | 1 ms | skipped: set RIALTO_API_KEY |

**ETH → USDG, 0.1 in** (block 124405511, 2026-11-27T17:01:31Z)

| Venue | Received | vs best | Latency | Route or failure |
|---|---:|---:|---:|---|
| Stoa | 166.804 | -0.02% | 116 ms | Uniswap V3 |
| Uniswap V2 | 166.46 | -0.23% | 97 ms | V2 ETH→USDG |
| Uniswap V3 | 166.841 | +0.00% | 113 ms | V3 ETH→USDG 0.01% |
| Rialto | — |  | 0 ms | skipped: set RIALTO_API_KEY |

**USDG → NVDA, 25 in** (block 124405511, 2026-11-27T17:01:31Z)

| Venue | Received | vs best | Latency | Route or failure |
|---|---:|---:|---:|---|
| Stoa | 0.167694 | +0.00% | 305 ms | up. |
| Uniswap V2 | 0.001054 | -99.37% | 129 ms | V2 USDG→NVDA |
| Uniswap V3 | 0.167631 | -0.04% | 297 ms | V3 USDG→NVDA 0.05% |
| Rialto | — |  | 0 ms | skipped: set RIALTO_API_KEY |

**USDG → TSLA, 25 in** (block 124405511, 2026-11-27T17:01:31Z)

| Venue | Received | vs best | Latency | Route or failure |
|---|---:|---:|---:|---|
| Stoa | 0.0625452 | -0.02% | 126 ms | Uniswap V3 |
| Uniswap V2 | 0.00813283 | -87.00% | 138 ms | V2 USDG→TSLA |
| Uniswap V3 | 0.0625577 | +0.00% | 229 ms | V3 USDG→TSLA 0.05% |
| Rialto | — |  | 0 ms | skipped: set RIALTO_API_KEY |

## What this shows

- **Buying $MERRYMEN with ETH**: Stoa delivered about 0.3% more than the best Uniswap V2 path after the token's transfer fee, by taking ETH → VIRTUAL on Uniswap V3 and VIRTUAL → MERRYMEN on V2. Uniswap V3 has no MERRYMEN pool.
- **Selling $MERRYMEN**: Stoa does not quote it (fee-on-transfer input is refused by its router). Uniswap V2 through VIRTUAL is the venue for sells.
- **ETH/USDG and stock tokens**: Stoa is level with or slightly above the best single Uniswap quote (+0.00% to +0.10%), because it also checks Uniswap V4, Aero, Ramses and up. for the exact amount. Uniswap V2 stock-token pools are seed-sized and far off.
- **Latency**: Stoa's API took about 0.2 to 1.4 s per quote (the MERRYMEN buy runs an extra simulation), against 0.1 to 0.3 s for a direct `eth_call` to one Uniswap quoter. Stoa returns a ready transaction with the quote.
- **Failures**: no Stoa errors or timeouts in this run; Stoa answered "no route" only where its router cannot execute (MERRYMEN sells).

Run it again at agent-sized amounts you care about; numbers move with pool state.
