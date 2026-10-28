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
  0. The same skip hid an owner's withdrawal that a bundler put in one
  transaction with a genuine agent trade (see
  [The deposit scanner and a shared bundle](#the-deposit-scanner-and-a-shared-bundle)).

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

The record is one `INSERT … ON CONFLICT (chain_id, LOWER(agent_id),
user_op_hash) DO NOTHING`. It returns `'inserted'`, then `'present'`, or
`'failed'`, and never falls back to a trades row. A crash on either side
replays nothing: the record moves no money, and a second insert changes
nothing. `listOpHashes` includes recorded owner
operations, so a later arm does not find them again.

The owner gets one event per arm. It says only what the book does:

- "recorded N operation(s) your own key signed … not agent trades: they count
  toward no trading limit".
- For USDG in or out of the account: it is capital, not performance, and is
  **left to the deposit scanner** to book as a deposit or withdrawal. The
  notice does not say it is booked: the scanner books only a leg it reads (see
  [Behaviour to sign off](#behaviour-to-sign-off)).
- For a token that left: "a withdrawal in kind, not a trade". No flow records
  a withdrawal in kind, so the book sees its value leave with no withdrawal
  beside it, and the operation is kept for review. The notice no longer says
  "not a loss".
- For a token that arrived: its cost **can** be recovered from the receipt on
  a later tick if USDG was paid for it in that transaction. A token that
  arrived with no USDG paid has no cost on record, so stop-loss and
  take-profit cannot act on it. (The live tick's `recoverReceiptBasis` replays
  a token's Transfer history without asking who signed;
  `receipt-basis-recovery.test.ts` pins that.)

## The record

`owner_operations` is in `store.ts SQLITE_SCHEMA`. It reaches Postgres through
`translateSchema`. It is append-only, and its identity, `(chain_id,
LOWER(agent_id), user_op_hash)`, is unique in both databases
(`owner_operations_account_identity`).

**The identity is per account.** Postgres holds every tenant's records in one
table. The first cut keyed them on `(chain_id, user_op_hash)` alone, so another
tenant's child could record this tenant's operation hash under its own account
first. Its mirror would copy that row (it is that tenant's own account), and
this tenant's genuine record would then never land: first row wins. With the
account in the key, the two rows are different records, and neither answers
the other's admission. Every schema run drops the first cut's index
(`DROP INDEX IF EXISTS owner_operations_identity`, in `SQLITE_ALTERS`). That
is safe on a populated table: the per-account index is strictly weaker, so it
builds over any rows the old one admitted, and no row moves.

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

1. Every USDG leg of the account is one of:
   - capital-in or capital-out by the scanner's own classifier and inputs
     (`deposit-log.ts scannerClassifyContext`), left for the scanner's flow;
   - internal by the custody-transfer rule, which the record answers and lists
     in `covers`;
   - a leg that moves nothing (a self-transfer, or an amount of zero), kind
     `no-movement`, which the record also answers and lists in `covers`. No
     flow writer books such a log, and admission reads every USDG log of the
     account. Left out of `covers`, an `acknowledged` operation whose only
     movement is a self-transfer would hold its tenant for good.
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

**An amount that cannot be read is not zero.** A Transfer in the receipt
whose data is not one quantity (`0x` and 1 to 64 hex digits: no data, `0x`,
or more than a word) leaves the whole receipt unread, and the reading is null.
That is the rule admission reads every amount by (`ledger-resume.ts
hexQuantity`), so both sides fail closed the same way: the reconciler records
nothing and finds the operation again at the next arm, and admission answers
nothing, so the operation stays missing. The deposit scanner refuses such a
receipt by the same rule (`transferAmountsReadable`) wherever it would book
an owner's leg from a trade's transaction (below). (The first cut read such a
log as an amount of zero, a leg that moves nothing, which admission then
refused to take as covered. With no data at all, the first cut threw
instead.)

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

## The deposit scanner and a shared bundle

A record leaves an owner's capital leg (`answeredBy: "flow"`) to the deposit
scanner. That scanner skips every USDG log in a transaction the ledger holds as
a trade. A bundler can put the owner's root-key withdrawal and the agent's own
swap in one `handleOps` transaction, the shape `asset-movements.test.ts` reads
op by op. That transaction is a trade's, so the skip hid the owner's
withdrawal for good, and contributions and the peak stayed wrong.

So `deposit-log.ts findTransferFlows` now lets one kind of log in a trade's
transaction through to the receipt classifier. The log must be a USDG log
that the receipt places inside the execution of a successful **root**
operation of this account (`owner-operations.ts rootExecutionLogs`, the same
segment the record reads). That operation must also be one no trade row of the
transaction is (`store.ts tradeOpsInTx`). Everything else in the transaction
stays skipped, exactly as before:

- the trade's own execution, so a trade's USDG legs are never classified at
  all and never booked as capital;
- validation-phase logs, such as a paymaster's charge;
- another account's operations, and a reverted operation's;
- a root operation that the ledger holds as a trade row (a misbooked `'swap'`
  from before owner records): booking its leg moves a peak, which is an
  `hwm-repair` decision;
- every log of a transaction that has a trade row naming no operation, since
  that row could be the root operation's;
- a receipt whose logs carry no positions.

What is let through is classified like any other leg, on the whole receipt's
legs. That is the classifier and the inputs the record judged it by, so the
scanner books exactly the legs the record leaves to it. One consequence: beside
an agent **buy**, the token the trade brought in pairs with the owner's USDG
across the bundle. The classifier then reads a trade, not capital. The record
reads it the same way (`usdg-not-capital`, and `usdg-outside-segment` because
the trade's USDG sits outside the owner's execution), so it is `review` and
leaves nothing to a flow that is never booked.

The trade-row lookup is asked only for such a leg. To find one, the scanner now
reads the receipt of each trade's transaction in its window that moved USDG of
the account; before, it read none of them. It only places their logs, and
decodes their amounts only for a leg it lets through, so a malformed Transfer
elsewhere in the bundle stops nothing. An unreadable one refuses the scan
pass, as an unreadable receipt always did for any other transaction: the
cursor stays, and the window is read again.

**A receipt with an amount that cannot be read refuses that transaction
alone.** Before it decodes a let-through leg's receipt, the scanner checks
every Transfer in it, whoever's operation it sits in, by the rule the record
refuses a receipt by (`owner-operations.ts transferAmountsReadable`: one
quantity, 1 to 64 hex digits). If any fails, the leg is not booked, the
scanner logs one `not booked:` line for it, and the rest of the window is
booked as usual. The record refuses the same receipt, so the reconciler
records nothing for the operation and admission names it missing. (The first
cut decoded the whole receipt instead. A Transfer with `0x` data anywhere in
it threw, which refused every pass for that tenant, so no later deposit or
withdrawal was booked. Empty data, or more than a word, was read as an amount,
and the leg was booked from a receipt the record refused.)

## How it reaches Postgres

Children have no `DATABASE_URL`, so the mirror carries the record up
(`ledger-mirror.ts mirrorOwnerOperations`). It is **not** a log table:

- A child ledger written before the table would fail a log-table read. Any
  failed table withholds an anchor, a drain, a retirement and the fleet
  checkpoint. Here such a ledger is zero rows: no failure and no cursor.
- A log table's cursor is in the continuity proof and the handover's final
  cursor, which the persistent-home import cannot satisfy. This cursor is in
  neither, because rewinding it can neither duplicate nor lose a record: every
  insert is `ON CONFLICT (chain_id, LOWER(agent_id), user_op_hash) DO
  NOTHING`.

**The cursor is the child's own `id`, with a witness, and no clock in it.**
`mirror_state.last_id` is the child id of the last row a pass settled, and
`last_stamp` is that row's `created_at` (the log tables' convention). A
child's `AUTOINCREMENT` id only grows within one ledger, whatever its clock
does. So a record written after the child's clock stepped back is still after
the cursor. (The first cut kept a `created_at` watermark opened 300 seconds
behind itself. A clock that stepped back by more than that skipped every
record in between, for good.)

A rebuilt or imported child is told apart by the witness. When the row at
`last_id` is gone, or carries another `created_at`, the pass reads from id 0
again, and the inserts absorb what Postgres already has. That re-read is not
reported as `restarted`, and it holds no drain, anchor or checkpoint. A cursor
with no witness (an earlier build's watermark) is not trusted either: the pass
reads from id 0.

**The bound.** A rebuilt child that already holds a row at exactly `last_id`,
created in exactly the witnessed second, is taken for the old ledger, and its
rows at lower ids are not re-read. For that, a new ledger has to record as
many owner operations as the old one before the mirror's first pass over it
(the orchestrator mirrors every 15 seconds, and an imported book starts with
none), the last in the same second. A record missed that way is absent from Postgres, so
admission names its operation and holds the tenant. That fails closed, and
nothing is booked from it.

The rows and the cursor commit in one transaction. The cursor's `updated_at`
says when the tenant's book was last written (`lastMirrorPassAt`). It never
moves on a pass that read nothing. On a trusted cursor it moves whenever a
pass settles rows, since those are rows no pass had passed. After a rewind it
moves only when the pass inserts a record. The re-read cannot tell which of a
rebuilt ledger's rows an earlier pass passed, so a re-read that copies nothing
new (rows already there, foreign or invalid) leaves it as it was. A tenant
that has records gains an `owner_operations` row in
`mirror_state`. That is expected: admission's evidence binds every cursor row,
so the tenant's digest changes once, when its first record arrives. The
continuity proof and the handover format (`ledger-import.ts` SPECS) are
unchanged. Postgres keeps what a rebuilt or imported child has lost.

**The tenant is the mirror's.** Each row is stamped with the pass's tenant.
The account is the one the tenant's own grant names
(`ledger-mirror.ts tenantGrantAccount`: the shared `grants` table, exactly one
row, a full address). A caller that names an account (the fleet checkpoint,
its roster's) must agree with the grant wherever there is one. Each row read is
then exactly one of:

| row | what happens | counted as |
|---|---|---|
| a full root record under the tenant's account | copied, stamped with the tenant, or already there | `owner_operations`, `owner_operations_already_mirrored` |
| a full root record under **another** account | never copied under this tenant. The cursor passes it and it is counted on that pass: once, unless a rewind re-reads the ledger from id 0 and counts it again. Foreign is decided against the grant's account alone, which no child writes, and a tenant keeps its account across a grant replacement, so no later pass would copy it | `owner_operations_foreign` |
| not a full lowercase hash pair, or not root | never copied by any account. The cursor passes it and it is counted like a foreign row | `owner_operations_invalid` |

With no account to check against (no grant, or the caller's account and the
grant's disagree), nothing is copied. A row with nothing left to copy is
settled as above: a record Postgres already holds under this tenant (an earlier
pass with an account placed it; a rebuilt child's re-read finds these), or an
invalid one. Any other row is not, and then:

- the cursor does not move;
- each such row is counted on every such pass (`owner_operations_unattributed`);
- the pass reports `owner_operations` as **failed**.

The first pass that can name the account copies it. So a stale account can
never turn a genuine record foreign, and no row is skipped silently. The
counts line prints all three apart from the rows that arrived.

**Why failed, not idle.** A removed tenant's last copy runs after its grant
row is gone (`orchestrator.ts` removed-agent cleanup, `finalMirrorBeforeAnchor`).
Its home may hold the only copy of a record the regular 15-second pass had not
yet carried up, and a redeploy can take that home. The first cut reported such
a pass as complete (`hasMore: false`), so the cleanup released the lease
without keeping the tenant in `removedLedgerPending`. Reported failed, it is
not a finished copy to any caller. The cleanup keeps the tenant pending under
its lease and retries each pass, and a drain, a retirement and the fleet
checkpoint refuse in the same way. A re-grant that names the account lets the
next pass copy the record and finish.

## How admission uses it

`ledger-resume.ts knownChainFacts` loads only the acknowledged root records the
mirror stamped for this tenant, account and chain. It asks the catalogue first
(`to_regclass`), so a missing table means no answers, never an aborted
statement. A `review` record is never loaded.

**Only for the tenant's own account.** The records are loaded only when the
tenant's own grant row, read the way the mirror reads it
(`tenantGrantAccount`), names exactly the account admission asked about. No
grant, two grant rows, or a grant naming another account loads none, and every
root operation stays missing (fail closed).

`chainGapCheck` then re-derives each candidate (`ownerAnswersFor`). It reads
from the chain, never the row, and a record answers the operation only when all
of these hold:

1. The record names this operation in the same transaction.
2. The operation's own log says root, success and this account
   (`isRootSuccessOf`). A session key's operation is never answered; its
   receipt is not even read.
3. Its receipt, read now and re-derived over the grant's custody and chain,
   comes out `acknowledged`.
4. Every leg the re-derived reading covers is a USDG log the check read. By
   that log's own topics and data, either its counterparty is a custody
   address, or it moves nothing (from the account to itself, or an amount of
   zero).

If a receipt cannot be read, the check is `unavailable` and it retries. An
owner-answered operation does **not** answer the other USDG legs of its
transaction. A capital leg still needs its flow, and only the re-derived
covers are held by the record.

**What this changes in admission, and why it is chain-proved.** Admission now
answers two things it did not before, and nothing else:

- a root operation with no trade row, when its acknowledged record is the
  tenant's own and its receipt re-derives `acknowledged` today (steps 1 to 3);
- the USDG logs of the account that such a record covers: custody-internal
  legs, and legs that move nothing (step 4).

Each is proved from public chain data at admission time: the EntryPoint's own
event for who signed it and whether it succeeded, and the receipt and the logs
admission itself read for what it moved. The row only says which operation to
look at. A capital leg is still answered only by its flow, so a deposit or
withdrawal under the owner's key still holds the tenant until the scanner books
it (except in a transaction that also holds a trade row: limit (e)). A token
that arrived or left keeps the record at `review`, which answers nothing.

Elsewhere admission is stricter, not looser. `resumePreconditions` counts owner
records as live operations, so the tenant is read on chain. It also includes
the table in the one-spelling check. The evidence binds a tenant's records
where there are any. Every other tenant's digest is byte for byte what it was.

The chain-gap booking tool reads the records exactly as admission does. It
binds them into its digest and compare-and-set, and shows the record and the
re-derived reading beside an `owner-operation` fact as evidence. It still never
books an owner operation. A USDG leg of an operation that an owner record
answers, with no flow, is `unresolved` with the reason in full: the record
answers the operation only, it leaves the capital leg to the deposit scanner's
flow, and the scanner never booked it (one that landed outside every window a
running worker scanned, during downtime for one, is never seen). Booking that
flow moves the account's capital and its peaks: a reviewed `hwm-repair`
decision, not this tool's.

## Behaviour to sign off

1. **The deposit scanner now books an owner withdrawal's USDG leg.** With no
   trades row, it no longer skips the transaction. A withdrawal inside the scan
   window is booked as a chain-log `out` flow and lowers the peak with it. That
   is correct accounting, and it is already what happens to an owner operation
   that lands while a worker runs (the reconciler only ever saw ops from before
   an arm). The same holds for an owner withdrawal bundled in one transaction
   with a genuine agent trade: only the owner's own execution is let past the
   trade skip ([The deposit scanner and a shared bundle](#the-deposit-scanner-and-a-shared-bundle)).
2. **A root-key purchase no longer gets an automatic basis at arm.** The
   reconciler's `bookFill` is gone for root ops. The live tick's receipt
   recovery still books one where USDG was paid in the same receipt.
3. **Rows booked before this change keep counting.** A misbooked `'swap'` row
   already in Postgres stays in the shared budget seed for up to 24 hours after
   it was settled, and on every tape. That over-counts, which is the safe
   direction. The audit below finds them.

**Check before deploying: a peak `MERRYMEN_REPAIR_HWM=apply` already
lowered.** The repair derives a peak from every capital leg on chain, trades'
transactions included, and lowers it by raising `hwm_withdrawn_usdg`. It
writes no flow. So an owner withdrawal in a trade's transaction that an apply
already compensated has no flow row, and nothing dedupes the two. On its first
boot this code catches the scanner up from its last recorded `chain-log`
flow, up to 200,000 blocks back. It books that leg as a flow and lowers the
peak a second time. Before deploying, check each tenant an apply touched for
such a withdrawal inside that window. If there is one, decide before the
deploy how its peak is kept from moving twice.

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
- **(e) Admission holds every USDG log of a trade's transaction by its trade
  row** (`chainFactsPostgresLacks`), as it always has. An owner's capital leg
  in such a transaction goes unheld only when its record is `acknowledged`,
  and `acknowledged` means nothing else in the transaction moved USDG of the
  account (rule 3). Beside an agent trade that moved the account's USDG the
  record is `review` and answers nothing, so the operation itself holds the
  tenant. With no record at all (an operation no arm read, or a receipt with
  an amount that cannot be read) it holds the tenant too. In the
  `acknowledged` case nothing holds the tenant for that leg, even when no
  flow books it. The live scanner books it now (above). One that landed while no worker scanned
  is booked by nothing, and admission does not name it. (A root operation
  already held as a misbooked `'swap'` row left its leg unheld the same way
  before this change; the audit below finds those.) Tightening that is a
  change to admission for every trade, left to a reviewed decision.
- Owner records are not in the persistent-home handover. Postgres keeps the
  mirrored copy, and admission fails closed if one is lost.
- Every outstanding chain-gap booking preview recomputes to a new digest. Its
  fingerprint (`chain-gap-booking-cli.ts sourceFingerprint`) now covers, beside
  `ledger-resume.ts` and `inflight-reconcile.ts`:
  - `owner-operations.ts`, the owner reading;
  - `deposit-log.ts`, whose `scannerClassifyContext` that reading classifies
    with;
  - `ledger-mirror.ts` and `db.ts`, for `tenantGrantAccount` and
    `tablePresent`, which decide whether admission loads owner records at all.

  `known.ownerOps` and `ownerRecords` are in its compare-and-set. Preview again
  after this deploys. `store.ts` is still not in the fingerprint: the record's
  identity there decides what the mirror can write, not what a preview reads.

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
- **A reviewed path for an owner's capital leg the scanner never saw** (a
  deposit or withdrawal under the owner's key that landed while no worker
  ran). Admission holds such a tenant on the leg, and the booking tool names
  it, but booking its flow moves the peaks, so it is an `hwm-repair`
  decision.
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

- `owner-operations.test.ts`: the real receipts above, the synthetic shapes,
  unreadable amounts, and which logs a root operation executed.
- `deposit-log.test.ts`: the shared bundle. The owner's withdrawal beside an
  agent sell is booked, and the trade's own USDG and validation's never are.
  The scanner books exactly the legs the record leaves to it, beside a sell
  and beside a buy. A misbooked root `'swap'` row, a row naming no operation,
  a revert, another account's operation and a receipt with no positions all
  stay skipped.
- `inflight-reconcile.test.ts`: root orphans get readings and no fill; the
  session op is unchanged.
- `owner-operations.integration.test.ts`: a real ledger. Recorded once; counted
  by no limit; the withdrawal's leg is booked by the scanner, alone and beside
  a trade row in the same transaction (`tradeOpsInTx`).
- `mirror-owner-operations.test.ts`, `ledger-safeguard.test.ts`,
  `anchor-final-mirror.test.ts` and `ledger-import.test.ts`: the mirror (the id
  cursor and its witness, a clock that stepped back, foreign, invalid and
  unattributed rows, a rewind's recount, another tenant's child unable to
  pre-empt a record), the fleet checkpoint and a removed tenant's final copy
  refusing on an unattributed record, the handover.
- `owner-operations-admission.test.ts` and
  `orchestrator-ledger-resume.integration.test.ts`: admission, end to end.
- `chain-gap-booking.test.ts`: the booking tool.
- `owner-op-audit.test.ts` and `owner-op-audit.postgres.test.ts`: the audit,
  and Postgres 17 (the per-account expression index, the migration off the
  first cut's index on a populated table, the pre-emption, and the grant
  gate on JSONB).
- `energy-buy-wiring.test.ts`: source pins on the root branch.
