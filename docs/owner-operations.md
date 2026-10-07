# Owner operations are not agent trades

An operation the owner's own key signed is not something the agent did. That
covers a `recoverFunds` withdrawal (from the web recovery panel, the CLI or the
mobile app), a Kernel `invalidateNonce` revocation, and a custody vault's
`sweep`. This page covers four things:

- how the worker tells such an operation apart and records it;
- how the record reaches Postgres;
- how admission may accept it;
- the read-only audit of rows booked before this change.

Nothing on this page rewrites history.

## What was wrong

The in-flight reconciler runs at arm (`index.ts reconcileInFlightAtArm`). It
wrote every successful operation the ledger lacked as a landed `'swap'`, whoever
signed it. So an owner's operation found inside its lookback became an agent
trade:

- It counted toward the ops and spend caps and the shared trailing-day budget
  seed (`budget-seed.ts`).
- It was shown on the scoreboard, the profile and feed tapes and chat-trades,
  and journaled as a fill.
- The deposit scanner skips any USDG log in a transaction the ledger holds as a
  trade (`deposit-log.ts`, `tradeTxHashes`). So an owner's withdrawal recorded
  this way was never booked as the capital-out flow it is, and the peak never
  came down with it. That is very likely why 0x0e1c's `hwm_withdrawn_usdg` is
  0.

## Who signed it

Kernel v3 packs the validator into the nonce, and the EntryPoint's own
`UserOperationEvent` carries the nonce. A contract cannot forge a log at the
EntryPoint's address. `asset-movements.ts validatorOfNonce` reads it:

| nonce top bytes | validator | what it is |
|---|---|---|
| mode `0x00`, vType `0x00` | `root` | the owner's sudo key |
| mode `0x00`/`0x01`, vType `0x02` | `permission` | the agent's session key (`0x01` is its first, enable-mode op) |
| vType `0x01` | `secondary` | neither; kept on the old path |
| anything else, root in enable mode | none | not vouched for; kept on the old path |

**Only a proved root leaves the trades path.** A session key, a secondary
validator or an unreadable nonce is still booked as today's conservative
`'swap'`, which over-counts the caps.

## What the reconciler does now

`findOrphanOps` reads each orphan's nonce and block. A root op never gets a fill
(`acquired` is null). Given the grant's custody contracts and chain, it also
carries an **owner reading** (`owner-operations.ts ownerOperationOf`).

For a root op, `reconcileInFlightAtArm` records the reading in
`owner_operations` and writes nothing else for it: no trades row, fill, basis,
flow or peak. It records the op only when:

- its receipt was read;
- it is 64 blocks deep;
- its block time was read.

If any of these is missing, it leaves the op for the next arm. Either way the
op is never booked as the agent's.

The record is one `INSERT … ON CONFLICT (chain_id, user_op_hash) DO NOTHING`. It
returns `'inserted'`, then `'present'`, or `'failed'`, and never falls back to a
trades row. A crash on either side replays nothing: the record moves no money,
and a second insert changes nothing. `listOpHashes` includes recorded owner
operations, so a later arm does not find them again.

The owner gets one event per arm:

- "recorded N operation(s) your own key signed … not agent trades: they count
  toward no trading limit".
- For a token that left: "a withdrawal in kind, not a loss".
- For a token that arrived: its cost is recovered from the receipt if USDG was
  paid for it in that transaction. A token that arrived with no USDG paid has
  no cost on record, so stop-loss and take-profit cannot act on it. (The live
  tick's `recoverReceiptBasis` replays a token's Transfer history without
  asking who signed; `receipt-basis-recovery.test.ts` pins that.)

## The record

`owner_operations` is in `store.ts SQLITE_SCHEMA`. It reaches Postgres through
`translateSchema`. It is append-only, and its identity, `(chain_id,
user_op_hash)`, is unique in both databases.

| column | meaning |
|---|---|
| `tenant` | NULL in a child. Stamped by the mirror from its own grant, never from the child |
| `agent_id` | the worker's account, spelled as its trades rows spell it |
| `user_op_hash`, `tx_hash`, `block_number`, `log_index` | the operation, as the chain recorded it |
| `block_time` | the block's time, from the chain |
| `nonce` | the 256-bit nonce in hex: the root proof, re-checkable by anyone |
| `validator` | always `root` (a CHECK) |
| `disposition` | `acknowledged` or `review` (a CHECK); `review_reason` is set exactly when it is `review` |
| `usdg_legs_json`, `covers_logs_json`, `token_moves_json` | evidence for people and the audit. Admission recomputes them |
| `recorded_epoch` | the epoch when it was **recorded**, not when it landed (`block_time` says that) |

**Disposition.** A record is `acknowledged` only when nothing is left to decide:

1. Every USDG leg of the account is either:
   - capital-in or capital-out by the scanner's own classifier and inputs
     (`deposit-log.ts scannerClassifyContext`), left for the scanner's flow;
     or
   - internal by the custody-transfer rule, which the record answers and lists
     in `covers`.
2. No USDG moves between a custody contract and the outside.
3. No USDG log of the account sits outside the operation's execution.
4. No other token moves at any book address.
5. The execution was read.

Anything else is `review`, with one or more of these reasons:

- `token-arrived`
- `token-departed`
- `usdg-not-capital`
- `usdg-through-custody`
- `usdg-outside-segment`
- `segment-unread`

ETH is fuel and is ignored.

These are the real shapes, read from the public chain
(`worker/src/testdata/owner-operations-receipts.json`):

| operation | disposition |
|---|---|
| 0x4b6dcd `invalidateNonce` (root seq 0) | acknowledged; moved nothing |
| 0x4b6dcd vault `sweep(USDG)`, with the vault as custody | acknowledged; covers log 13 (vault → account) |
| 0x4b6dcd `recoverFunds` | review (`token-departed`: NVDA dust); log 8, 348.368488 USDG out, is a capital-out for the scanner's flow |
| 0x9eaa728e pure USDG root withdrawal | acknowledged; log 18 is a capital-out for the scanner's flow |
| 0x0e1c multi-token sweep | review (`token-departed`: MU, USAR, steakUSDG) |
| 0x4b6dcd session key's enable-mode sell | not an owner operation |

## How it reaches Postgres

Children have no `DATABASE_URL`, so the mirror carries the record up
(`ledger-mirror.ts mirrorOwnerOperations`). It is **not** a log table:

- A child ledger written before the table would fail a log-table read. Any
  failed table withholds an anchor, a drain, a retirement and the fleet
  checkpoint.
- An id cursor would have to join the continuity proof, which the
  persistent-home import cannot satisfy.

So it copies by identity. It keeps a `created_at` watermark opened 300 seconds
behind itself, inserts with `ON CONFLICT DO NOTHING`, and commits the rows and
the watermark in one transaction. A child without the table is zero rows: no
failure and no cursor. A tenant that has records gains an `owner_operations`
row in `mirror_state`. That is expected: admission's evidence binds every
cursor row, so the tenant's digest changes once, when its first record
arrives. The continuity proof and the handover format
(`ledger-import.ts` SPECS) are unchanged. Postgres keeps what a rebuilt or
imported child has lost.

**The tenant is the mirror's.** Each row is stamped with the pass's tenant. It
is copied only when all of these hold:

- its `agent_id` is the account the orchestrator knows for that tenant (the
  caller's argument; the fleet checkpoint passes its roster's; otherwise the
  shared `grants` row);
- its hashes are full lowercase hashes;
- its validator is root.

Anything else is skipped and counted (`owner_operations_foreign`). With no
account to check against, nothing is copied or advanced
(`owner_operations_unattributed`). The counts line prints both apart from the
rows that arrived.

## How admission uses it

`ledger-resume.ts knownChainFacts` loads only the acknowledged root records the
mirror stamped for this tenant, account and chain. It asks the catalogue first
(`to_regclass`), so a missing table means no answers, never an aborted
statement. A `review` record is never loaded.

`chainGapCheck` then re-derives each candidate (`ownerAnswersFor`). It reads
from the chain, never the row, and a record answers the operation only when all
of these hold:

1. The record names this operation in the same transaction.
2. The operation's own log says root, success and this account
   (`isRootSuccessOf`). A session key's operation is never answered; its
   receipt is not even read.
3. Its receipt, read now and re-derived over the grant's custody and chain,
   comes out `acknowledged`.
4. Every leg the re-derived reading covers is a USDG log the check read, and
   its counterparty, by the log's own topics, is a custody address.

If a receipt cannot be read, the check is `unavailable` and it retries. An
owner-answered operation does **not** answer the other USDG legs of its
transaction. A capital leg still needs its flow, and only the re-derived
custody-internal covers are held by the record.

Admission is never loosened by this. `resumePreconditions` counts owner records
as live operations, so the tenant is read on chain. It also includes the table
in the one-spelling check. The evidence binds a tenant's records where there
are any. Every other tenant's digest is byte for byte what it was.

The chain-gap booking tool reads the records exactly as admission does. It
binds them into its digest and compare-and-set, and shows the record and the
re-derived reading beside an `owner-operation` fact as evidence. It still never
books an owner operation.

## Behaviour to sign off

1. **The deposit scanner now books an owner withdrawal's USDG leg.** With no
   trades row, it no longer skips the transaction. A withdrawal inside the scan
   window is booked as a chain-log `out` flow and lowers the peak with it. That
   is correct accounting, and it is already what happens to an owner operation
   that lands while a worker runs (the reconciler only ever saw ops from before
   an arm).
2. **A root-key purchase no longer gets an automatic basis at arm.** The
   reconciler's `bookFill` is gone for root ops. The live tick's receipt
   recovery still books one where USDG was paid in the same receipt.
3. **Rows booked before this change keep counting.** A misbooked `'swap'` row
   already in Postgres stays in the shared budget seed for up to 24 hours after
   it was settled, and on every tape. That over-counts, which is the safe
   direction. The audit below finds them.

## Limits

- **(a) Any token departure is `review`.** Almost every recovery sweep carries
  dust: NVDA on 0x4b6dcd; MU, USAR and steakUSDG on 0x0e1c. steakUSDG is vault
  equity, so an in-kind sweep of it can be a material withdrawal. Such a sweep
  holds the tenant at any future attested admission, and no tool clears that
  hold today. This change unblocks owner revocations, custody sweeps and
  pure-USDG withdrawals. It does not unblock owner operations in general.
- **(b) Only a live arm records owner operations.** The lookback is clamped to
  200,000 blocks, about 5.5 hours. Operations that land during long sessions,
  while a tenant is held, or on the paper rail (`reconcileInFlightAtArm` runs
  only with an executor) are not recorded. They keep failing closed at
  admission.
- **(c)** A USDG-paired root-key buy can still get a receipt basis on a later
  tick (above).
- **(d)** This change does **not** guard 0x0e1c's stale live basis. Its sweep
  is already answered by an existing trades row, and owner records never touch
  positions or cost_basis. That guard belongs to the closed-epoch filing work.
- Secondary-validator (vType `0x01`) operations keep the `'swap'` booking.
- Owner records are not in the persistent-home handover. Postgres keeps the
  mirrored copy, and admission fails closed if one is lost.
- Every outstanding chain-gap booking preview recomputes to a new digest:
  `ledger-resume.ts`, `inflight-reconcile.ts` and the new
  `owner-operations.ts` are in its fingerprint, and `known.ownerOps` is in its
  compare-and-set. Preview again after this deploys.

## The audit: which trades rows are an owner's own operation

`worker/src/owner-op-audit-cli.ts` is read only. It writes nothing but its own
report and rewrites nothing. The owner runs it. Claude never does.

**It needs an image built from this code**, so it runs after review, merge and
deploy. Check first:

```sh
railway ssh --service <orchestrator service>
cd /app && ls worker/src/owner-op-audit-cli.ts
```

Then, in the same shell inside the orchestrator container:

```sh
cd /app
OUT=/tmp/owner-op-audit-$(date -u +%Y%m%dT%H%M%SZ).json
node --import tsx worker/src/owner-op-audit-cli.ts --output "$OUT"; echo "exit $?"
cat "$OUT"
```

- `DATABASE_URL` is already in the container's environment. Never paste it.
  `MERRYMEN_CHAIN_GAP_RPC` optionally selects the RPC; the default is the
  public one.
- `--tenant 0x…` audits one tenant.
- `--max-receipts N` bounds the receipts read (default 5000). Past it the run
  is incomplete and says by how much.

**What it reads.**

- Postgres, in one `REPEATABLE READ READ ONLY` snapshot, always rolled back, on
  a connection the server holds read only (`application_name`
  `merrymen-owner-op-audit-readonly`).
- From grants, the account, chain and custody fields only. Never the whole
  `grant_json`, and never `sealed_session_key`.
- Then one receipt and block per transaction, over an RPC that admits
  `eth_chainId`, `eth_blockNumber`, `eth_getTransactionReceipt` and
  `eth_getBlockByNumber` only.

The report is created once, with mode `0600`, before anything is read, and
removed if the run fails. Neither URL is printed or saved.

**Exit codes.**

| code | meaning |
|---|---|
| `0` | nothing found |
| `2` | root-key rows found |
| `3` | coverage incomplete: an unread receipt, the bound reached, a settled row with no tx hash, or a grant on another chain |
| `1` | the run failed (a fixed code is printed) |

**What it reports.** For every trades row whose operation the root validator
signed:

- tenant, account, trade id, tx, block, block time and whether the block is
  canonical;
- kind, status, amount, epoch and the account's current epoch and mode;
- `created_at` and `budget_settled_at`;
- the nonce;
- the owner reading of its receipt, with each USDG leg and whether a flow holds
  it;
- `counted`, each flag naming the shared-ledger reader it mirrors:
  - the trailing-day budget seed (ops, spend, gross);
  - the scoreboard (landed, volume);
  - the profile and feed tape;
  - chat-trades;
  - the restart-copy shape;
  - a booked fill;
  - any owner record beside it.

It also gives:

- totals by validator;
- the root rows' count, tenants and amounts;
- capital legs that no flow holds;
- every owner record (both dispositions, and any on another chain or without a
  tenant);
- anomalies, such as a hash not in its own receipt;
- an `auditDigest` over the code, the target, the snapshot and the chain
  evidence.

**What it cannot see.** A running child seeds its live ops and spend caps from
its own SQLite copy. The audit cannot see that copy, and a Postgres edit never
changes it.

**Send back** to Milla:

- the console output;
- the exit code;
- the report file (`cat "$OUT"`).

It holds public chain data, tenant and account addresses and amounts. It holds
no URL, key or setting.

## What a later reviewed reclassification would need

None of this is in this change.

- Bind to an `auditDigest` and a fresh preview of the same rows.
- Hold the tenant (no running worker), or prove each row is outside every budget
  window. The child's own trades copy is untouched by any Postgres edit.
- In one transaction:
  - compare-and-set each trades row exactly as read;
  - **move** it to a `trades_quarantine` table shaped like `flows_quarantine`
    (`store.ts`);
  - insert its `owner_operations` row.

  Never delete. Keep receipts and an exact revert.
- Give the mirror a skip for trades whose hash an owner record holds.
  Otherwise a persistent child's rewind re-mirrors the quarantined row (the
  mirror's dedupe looks only in `trades`).
- Correct the journal with a new entry, never an edit. `addTrade` journaled the
  row as a fill.
- Make a reviewed basis decision for rows with fills.
- Treat booking each suppressed capital leg as a peak decision for
  `hwm-repair`, in the epoch the evidence names: the record's `block_time`,
  never its `recorded_epoch`. 0x0e1c's sweep is in a closed epoch, which is the
  closed-epoch filing work.
- Preview admission again afterwards.
- Get Milla's review.

## Follow-ups for Milla to decide

- **A priced-dust acknowledgment for departures.** It would require each
  departed token to be flat at every book address at a block at or after the
  operation, and Postgres positions and live basis not to hold it.
- **A reviewed booking-tool class that writes an `owner_operations` row**, for
  operations no arm recorded.
- **A bounded per-tick EntryPoint sweep** over the deposit-scan window, so owner
  operations in long sessions are recorded.
- **Recording on the paper rail at arm.** It is read-only on chain and moves no
  money.
- **Making `recoverReceiptBasis` refuse root-key receipts.**
- **Deciding secondary-validator operations.**

## The tenants held on 2026-10-06

- **0x4b6dcd** (account 0xa96bf429…): the owner decided **leave held**. Its
  held fact is the `recoverFunds` operation. Re-derived, that is `review`
  (NVDA dust left), so even with a record it stays held. That is consistent
  with the decision. Its revocations and vault sweep, had an arm recorded them,
  would be acknowledged.
- **0x0e1c** (account 0x88e47214…): out of scope here (limit (d)). Its capital
  pair belongs to the closed-epoch filing.

## Tests

The tests are under `worker/src/`.

- `owner-operations.test.ts`: the real receipts above, and the synthetic shapes.
- `inflight-reconcile.test.ts`: root orphans get readings and no fill; the
  session op is unchanged.
- `owner-operations.integration.test.ts`: a real ledger. Recorded once; counted
  by no limit; the withdrawal's leg is booked by the scanner.
- `mirror-owner-operations.test.ts`, `ledger-safeguard.test.ts` and
  `ledger-import.test.ts`: the mirror, the fleet checkpoint, the handover.
- `owner-operations-admission.test.ts` and
  `orchestrator-ledger-resume.integration.test.ts`: admission, end to end.
- `chain-gap-booking.test.ts`: the booking tool.
- `owner-op-audit.test.ts` and `owner-op-audit.postgres.test.ts`: the audit,
  and Postgres 17.
- `energy-buy-wiring.test.ts`: source pins on the root branch.
