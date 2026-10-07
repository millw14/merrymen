# Filing a closed epoch's capital from the chain

Admission ([fleet-resume.md](fleet-resume.md), step 5) holds a tenant while
the chain shows an operation or a USDG transfer that Postgres has no row for.
The booking tool ([chain-gap-booking.md](chain-gap-booking.md)) books such a
fact into the tenant's **current** accounting epoch, and refuses one that
landed before that epoch opened:

```
not booked: it landed before accounting epoch 2 opened (…), so which epoch it belongs to is not this tool's to say
```

That refusal is right. But a tenant whose owner deposited, traded and
withdrew everything inside an epoch that has since been closed then stays
held for good. `worker/src/closed-epoch-capital-cli.ts` is the reviewed path
for that case, for one tenant at a time. It files the closed epoch's capital
movements the chain shows, in and out, into that epoch, and nothing else.

**This release files only into epoch 1.** Epoch 1's lower boundary is the
account's first block on chain, which the tool reads in full. A later epoch's
lower boundary cannot be proved from rows: a bump may write none. `--epoch 2`
or above refuses with `epoch-unsupported`.

The order is: **preview → the owner reviews → backup → apply → preview the
tenant in admission → approve → rollout.** If anything landed after the epoch
closed, book it with [chain-gap-booking.md](chain-gap-booking.md) **after**
this repair.

## The case it was built for: 0x0e1ca0…

Tenant `0x0e1ca00202df6e686ac2317e10ed8ee8ae5e320d`, account
`0x88e47214b5a0ca488cdabb4c9c28c3b71441ba78`. Read from the public chain
from block 0 (2026-10-07):

| When (UTC) | What | Tx#log |
|---|---|---|
| 2026-09-15 23:32:18 | USDG **in** 145.499004 from `0x472e130c…` (an EOA, not a hosted account). The account's first activity ever | `0xc8ab6c45…e6c5#0`, block 64045884 |
| 2026-09-16 10:54–20:31 | 17 session-key trades: 13 USDG out (100.000000), 4 in (99.319526). Each is answered by its trades row | |
| 2026-09-16 21:09:23 | The owner's **root-key** sweep: USDG **out** 144.818530 to `0x472e130c…`, plus the MU, USAR and steakUSDG left over | `0xffd1143e…dfb1#7`, block 64819173 |
| 2026-09-16 21:21:51 | Epoch 2's first row (the paper opening) | |

The USDG logs net to 0, which is the account's balance. The class vault
`0xc730…` has no code and no USDG movement.

Postgres, as the booking tool's preview read it on 2026-10-07: agents epoch 2,
mode `paper`, `hwm_usdg` 145.579752, `hwm_withdrawn_usdg` 0; **no flows rows at
all**; all 18 operations answered by trades rows; live MU and USAR cost basis,
and positions rows that still show both held.

What this tool should propose for it:

- **File two `chain-log` rows into epoch 1**, at block time: in 145.499004
  (`c8ab…#0`) and out 144.818530 (`ffd1…#7`). Epoch 1's net contributions
  become 0.680474, which is the trading loss.
- **Quarantine** any unevidenced epoch-1 stand-in. The 2026-10-07 read found no
  flows, so none is expected.
- **Delete the live MU and USAR basis and their floors.** Admission would seed
  them today (positions show both held), and the chain shows neither held.
  This happens only if admission's evidence for the tenant's chain refusal
  shows that the next admission cannot drain an old book back over the clear
  ([below](#a-clear-only-where-admissions-drain-cannot-undo-it)). If that
  evidence found the old book in the home, the preview is `BLOCKED` with
  `home-book-present`.
- Admission's chain check is then clean: the deposit is answered by its flows
  row (admission's flows identity reads every epoch), and the sweep's USDG leg
  was already answered by the trades row in its transaction.

These are expectations. The preview says what is true.

## What it files, and what it refuses

The tool reads Postgres in one read-only snapshot, closes the connection, and
then reads the chain. It reads every balance it needs first, at a block 64
deep (the public node keeps little history). It then reads the account's
whole USDG and operation history from block 0 to that block, in spans the
public node accepts (at most 10,000,000 blocks; it halves on a "narrow the
block range" refusal). It also reads the same history for each custody vault
in the grant. Every USDG movement is classified by the shared classifier
(`capital-classify.ts` `classifyUsdgMovement`), over its whole receipt, with
every hosted account and the grant's custody addresses.

It then proposes:

| Proposal | When | Row |
|---|---|---|
| file a flow | a `capital-in` or `capital-out` movement before epoch 1 closed, that the owner made ([below](#who-moved-it)), with no row for its `tx#log` in any epoch and no applied receipt | `flows`: `source 'chain-log'`, the stored `agent_id` spelling, `epoch 1`, `chain_id`, `tx_hash`, `block_number`, `log_index`, `at` = block time |
| quarantine a flow | an epoch-1 row that is not a receipt: one with no transaction (`inferred`, a legacy row), or one with a transaction and no log index that twins a movement being filed (a `transfer-intent`) | moved to `flows_quarantine` with `run_id` = the repair id and `replaced_by` = the filed `tx#log` list |
| clear a live basis and floor | a symbol admission would seed a live basis for (`planAttestedSeed`), whose token the chain shows the book does not hold at all | the `cost_basis` and `position_floors` rows deleted by exact primary key and exact contents |

An energy purchase (`reserve-out`) already filed as the worker's
`energy-buy` row counts as present. Any other is refused.

### Who moved it

The classifier reads a USDG movement with nothing paired in its transaction
as capital, whoever caused it. Filed into a closed epoch, it becomes the
owner's capital for good. So the tool files a movement only where its own
receipt shows the owner made it (`capitalProvenance`). The preview lists the
account's operations in each movement's transaction (`signers`): who signed
each, whether it succeeded, and whether the movement's log ran inside it.

- **Out** is filed only from inside the execution of a successful operation
  of the account signed by the owner's root key. USDG that left with no
  operation of the account in the transaction was an allowance someone
  spent. `chain-gap-booking` refuses that too: nobody can be said to have
  chosen it. USDG that left outside the root-key operation's execution, or
  inside one that failed, is not the owner's either. Both are refused with
  `out-not-owner`.
- **In or out** is never filed from a transaction where the agent acted.
  That means an operation of the account that the root key did not sign (a
  session key's, another validator's, or one whose validator is not read,
  such as one at another entry point). It also means a trades row that
  names the transaction and answers no root-key operation in it. Such a
  movement is a leg of the agent's own trade or transfer, even when its
  pair is missing from the receipt. This includes a session key's transfer
  home: the chain does not show that the owner chose it. Refused with
  `capital-in-session-op`.
- **In** needs no operation. An owner's deposit is a plain transfer in
  (`0xc8ab6c45…#0` carries none).

A `reserve-out` is not asked: this tool never files one, and only keeps
the worker's own `energy-buy` row. 0x0e1ca0's pair passes: the deposit
carries no operation, and the sweep's USDG log `#7` runs inside the root-key
operation `0x0a223e56…`. That operation is answered by the reconciler's
`swap` row.

### Refusals

One refusal blocks the whole tenant. Each is named:

| Code | What it found |
|---|---|
| `epoch-unsupported` | `--epoch` is not 1 |
| `epoch-not-closed` | the account is still in that epoch |
| `epoch-rows-ahead` | rows are filed under an epoch past the registration's |
| `next-epoch-empty` | no later epoch has a row to date the close by |
| `epochs-overlap` | an epoch-1 valuation is dated after a later epoch's first row |
| `boundary-contradicted` | an event that closes epoch 1 is dated before epoch 1's own last valuation |
| `boundary-upper` | a capital movement landed within 60 seconds of epoch 1's close |
| `boundary-undated` | nothing written while epoch 1 was open dates it after its last capital movement (see below) |
| `after-refusal` | a capital movement landed within a minute of admission's refusal, or after it |
| `coverage-incomplete`, `custody-unread`, `log-unreadable`, `movement-unread` | a log, receipt or block could not be read whole |
| `coverage-mismatch`, `custody-coverage`, `balance-unread` | the logs since block 0 do not net to the balance at the pinned block, or the balance could not be read (a node with no state at that block says so) |
| `custody-capital` | a custody vault moved USDG with an address outside the book |
| `ambiguous-movement` | the classifier cannot say what a movement before the close was |
| `fact-in-wrong-epoch`, `twin-in-other-epoch` | the movement is already filed in another epoch, by its `tx#log` or by its transaction and direction. Nothing is ever moved between epochs |
| `identity-conflict` | an epoch-1 row has the movement's `tx#log` and differs from the chain, or has no chain, or there are two |
| `receipt-without-row` | an applied receipt names the movement and no row does |
| `identity-quarantined-before` | an earlier repair quarantined that `tx#log` |
| `out-of-scope-reserve` | an energy purchase with no `energy-buy` row |
| `unexplained-receipt` | an epoch-1 `chain-log` or `energy-buy` row the chain's capital set for the epoch does not hold |
| `carry-in-epoch-1` | an `epoch-carry` row in epoch 1 |
| `unexplained-row` | an epoch-1 row with a transaction that answers no capital movement |
| `outbound-only` | after the repair, epoch 1 would hold a withdrawal and no capital in |
| `out-not-owner` | a `capital-out` movement did not run inside a successful operation that the owner's root key signed: no operation of the account in its transaction (an allowance spent), or USDG out outside that operation's execution or inside a failed one ([above](#who-moved-it)) |
| `capital-in-session-op` | a `capital-in` or `capital-out` movement is in a transaction where the agent acted: an operation of the account that the root key did not sign, or a trades row that names the transaction and answers no root-key operation in it. It is a trade's or a transfer's leg, never filed as capital ([above](#who-moved-it)) |
| `operation-unanswered`, `transfer-unanswered`, `fact-undated`, `admission-unread` | admission would still find something from before epoch 1 closed. An owner's root-key operation is named `owner-operation`: **this tool books no operation** |
| `positions-ambiguous`, `class-vault-held`, `live-position-disagrees` | the stale-basis check cannot decide (below) |
| `home-book-present`, `home-unproved` | a basis or floor would be cleared, and admission's drain of the tenant's home could put it back, or nothing proves it could not ([below](#a-clear-only-where-admissions-drain-cannot-undo-it)) |
| `flows-duplicate` | admission's duplicate check (`distinct-flows.ts`) would find a copy or a conflict: in epoch 1 as the repair would leave it, or in the current run, which the repair never writes. The apply would refuse on the same check after its writes; the preview says so first |
| `not-held`, `open-approval`, `admitted`, `no-grant`, `no-registration`, `registrations`, `spellings`, `chain`, `rpc-chain`, `identity-index`, `chain-unavailable` | the tenant is not one this tool may repair now, or the database or RPC is not the one it should be |

Escalate any refusal to Milla and Codex with the preview file.

## How it proves the epoch

**The close.** Epoch 1 closed no later than the earliest stamp of any row
filed under a later epoch (`trades.created_at`, `flows.at`, `equity.at`,
`fee_accruals.at`, `paper_checkpoints.updated_at`, each read as seconds
whether it was written in seconds or milliseconds), and no later than any
event that closes it. Every capital movement filed must be at least 60
seconds before that.

**Open after the last movement.** A later row only bounds the close from
above. The bump that closed the epoch may have written no row at all
(`resetBlockedPaperBookIn`), and an identical paper-opening row can be
written with no bump (`getPaperBook`). So the tool also requires one of these,
written while epoch 1 was still open and at least 60 seconds after its last
capital movement:

- **W1:** an epoch-1 valuation (`equity.at` is stamped when the row is
  written) between the last movement and the close;
- **W2:** the held reset's own event, which `held-reset.ts` inserts inside the
  reset's transaction;
- **W3:** epoch 2's first row is `resetPaperLedger`'s paper opening (mode
  `paper`, no ETH, vault or positions, cash equal to equity), and
  `runPaperReset`'s line ("paper book restarted — cash back to …, closed into
  epoch 1") follows it within 60 seconds. A paper-opening row alone is never
  enough.

The preview names the witness and its margin. Otherwise it refuses with
`boundary-undated`.

For 0x0e1ca0, the sweep is at 21:09:23 and epoch 2's first row at 21:21:51.
W1 holds if epoch 1 has a valuation between 21:10:23 and 21:21:51. W3 holds
if the 21:21:51 row is the paper opening and the practice-reset line follows
it.

## The stale live basis

When a tenant is admitted, the new book is seeded with a live cost basis for
each symbol that Postgres's `positions` shows held (`planAttestedSeed`), and
the floors beside them. On the paper rail, `positions` is the paper book's
cache, and `resetPaperLedger` deletes only the paper basis. So a paper tenant
can hold a live basis that admission would seed for a token the account no
longer holds.

The tool looks only at what admission would seed. For each seeded symbol, it
takes the token from that symbol's `positions` row and reads the book's
balance at the pinned block, at the account and every custody vault:

- **The book holds none:** the live basis row and its live floor are deleted,
  by exact primary key and exact contents. This is the worker's own rule (a
  symbol no longer held has no basis), proved from the chain.
- **The book holds some:** the basis is kept, as admission keeps it today. If
  the quantity differs, the preview says so.
- **A balance cannot be read**, **the class vault holds the token**, or **the
  agent last reported the live rail and its positions say held** where the
  chain says flat: refused.

A live basis outside what admission would seed is inert, named in the
preview and left alone: admission never seeds it, and the first mirror pass
after admission replaces Postgres's copy. `positions` is never touched.

### A clear only where admission's drain cannot undo it

The clear is in Postgres. Before admission reads anything for an approved
tenant, it drains the old book in the tenant's home into Postgres
(`orchestrator.ts` `drainContinuousBook`, the first step of Phase A). The
mirror then replaces the account's `cost_basis` and `position_floors` with
that book's own. An old book that is still continuous holds the live basis
this repair would clear, so the drain puts it back. The approval is then
refused for changed evidence, the tenant's newest decision is no longer a
chain refusal (so this tool no longer runs for it), and a later approval
seeds the stale basis anyway.

The drain skips a home with no `merrymen.db`, and a home behind a source
barrier (`ledger-source-blocked.json`). A home admission archived no longer
holds its book: the archive does not carry `merrymen.db` back. This tool
cannot read the volume, so it proves which case applies from what admission
recorded about the anchor (the tenant's newest decision, its chain refusal):

| What admission recorded | The clear | Why |
|---|---|---|
| The anchor reached `archived` (`archive_path` set) | holds | Admission archived the home before refusing in Phase B, and nothing has run for the tenant since (the hold proves that) |
| The anchor's evidence binds a home with no book | holds | A Phase A chain refusal is recorded only after its drain, and only when the evidence recomputed there matched the approved digest. So this is the home the drain met |
| The anchor's evidence binds a book behind a source barrier | holds | The drain never copies from it |
| The anchor's evidence binds a book, unblocked | **refused** `home-book-present` | The next admission drains it back |
| The evidence does not hash to its digest, binds no home, names another tenant, or there is no anchor | **refused** `home-unproved` | Nothing proves the clear would hold |

The evidence is trusted only when the sha256 of its stored text equals the
digest on its row, because that is how `recordApproval` writes them. Only
the home's class is kept (absent, blocked or present), never an inode, size
or path. The class goes into the compare-and-set: an evidence rewritten
between the preview and the apply refuses the apply.

When the refusal applies, the whole repair refuses, not just the clear.
Filing the flows without the clear would let admission pass its chain check
and seed the stale basis. The tenant stays held. That is a reviewed basis
decision: escalate to Milla with the preview file. When nothing needs
clearing (every seeded token is still held), the home does not matter: the
drain copies back what the books already hold.

Someone who restores a book into the tenant's home after the anchor (a
manual restore or a handover), or who clears its source barrier, undoes
this proof, and Postgres cannot show it. Do neither for a tenant being
repaired until it is admitted.

Why not change `planAttestedSeed` instead: `positions` has no mode column, a
paper tenant can still hold real tokens with a real basis, and skipping the
seed lets the first mirror pass delete the only copy. A seed gated on the
chain would add RPC reads to every admission and could drop a real basis on a
wrong zero. That is a separate, fleet-wide decision.

## What the preview reports

Everything a reviewer would otherwise check by hand:

- the tenant's registration, mode, epoch, `hwm_usdg`, `hwm_withdrawn_usdg`,
  contributions flags, and the hold (the chain refusal, heartbeat, mirror);
- every flows row in every epoch, with each epoch's in, out, net and
  evidenced/unevidenced counts, any `epoch-carry` checked against epoch 1's
  last valuation, and the quarantine history;
- the epoch bounds per table, the boundary events by class (never their
  text), the practice-reset commands, the first later valuation and its
  shape, the witness and its margin;
- every USDG movement since block 0: tx, log, block, time, direction, amount,
  counterparty, the classifier's kind, rule and reason, whether the
  counterparty is a hosted account or the owner, which epoch its time places
  it in, and what already answers it;
- the coverage proof (logs net to the balance) and each custody vault's;
- every operation: hash, time, validator, paymaster, the trades rows that
  answer it (kind, amount, epoch, when written). An owner's root-key operation
  answered by a `'swap'` row is flagged: an owner operation recorded as an
  agent trade by the in-flight reconciler. **It is left in place**; a later
  audit that removes it re-holds the tenant;
- what a root-key operation moved in kind (review only: never a flow);
- fee accruals and risk periods (untouched);
- positions, live and paper basis, live floors, class positions, what
  admission would seed before and after, and each seeded token's balances;
- what admission recorded of the tenant's home at its chain refusal (archived,
  or its book absent, blocked or present), and whether a clear would hold
  (`holdings.home`);
- admission's duplicate check over epoch 1 as the repair would leave it, and
  over the current run (`duplicates`);
- what admission's own chain check finds now, and what it would still find
  after the repair;
- the proposals, the predicted epoch-1 net, and warnings, including: no peak
  moves (run `hwm-repair` before any live re-arm), web reports that sum flows
  by time will show the pair, the child's journal is not written, and a fresh
  approval is needed.

The `previewDigest` covers the code (by file digest), the database (host, port
and name), every Postgres fact relied on, every chain fact read (movements
with block hashes and times, classifications, operations, the coverage proof,
balances) and every proposal. It does not cover the time, the head or the
pinned block.

## Before you start

- **The tenant is held** on admission's chain refusal, out of
  `MERRYMEN_FLEET_ROLLOUT`, with no approval open, exactly as for the booking
  tool ([chain-gap-booking.md](chain-gap-booking.md#which-tenants-it-books)).
  The same proof (`holdOf`) is applied here.
- **Where to run it:** a shell that can reach the shared Postgres, such as
  `/app` in the orchestrator container. `DATABASE_URL` comes from the existing
  private mechanism; the tool never prints it or the RPC URL.
- **The RPC:** the public Robinhood Chain RPC by default;
  `MERRYMEN_CHAIN_GAP_RPC` selects another. The transport admits only
  `eth_chainId`, `eth_blockNumber`, `eth_getLogs`, `eth_getTransactionReceipt`,
  `eth_getBlockByNumber` and `eth_call` for `balanceOf` of one address at a
  block number. The full read is about fifty log calls plus one receipt per
  transaction, a few minutes on the public node. A `log query timed out`
  leaves the read incomplete: preview again.

## 1. Preview

```sh
node --import tsx worker/src/closed-epoch-capital-cli.ts \
  --tenant 0x<tenant> --epoch 1 --output /absolute/private-dir/<tenant>-epoch1-preview.json
```

`--dry-run` is the default. The plan file is created once with mode `0600`.
The console prints the verdict, each refusal, the boundary and its witness,
the coverage, each proposal, the predicted net, and `previewDigest …`.

- `READY`: exit code `0`.
- `NOTHING-TO-DO`: nothing to file, quarantine or clear. Exit code `0`.
- `BLOCKED`: exit code `2`. Nothing can be applied.

## 2. The owner of the books reviews it

Send the preview file to Milla. Check each proposed row against the explorer,
the boundary and its witness, the coverage, each operation's validator and
answering rows, the stale-basis verdicts and balances, `admission.remaining`
(nothing before the boundary), and the warnings.

## 3. Backup

As for the booking tool: a manual Postgres backup or a noted PITR restore
point, per [backups.md](backups.md). Its name is `--backup-ref`.

## 4. Apply

```sh
node --import tsx worker/src/closed-epoch-capital-cli.ts \
  --tenant 0x<tenant> --epoch 1 --apply --confirm <previewDigest> --backup-ref <backup name> \
  --output /absolute/private-dir/<tenant>-epoch1-apply.json
```

It prints the repair id first:
`repair <id> — if this process dies, see what was applied with --revert-repair <id> --dry-run`.

It then recomputes the preview and refuses unless it is `READY` with exactly
the confirmed digest. Then, in **one `SERIALIZABLE` transaction**:

1. It locks the agent row (the lock `bookCapitalFlow`, `openNextEpoch` and
   `resetPaperLedger` take), and checks the flows identity index again.
2. It compares every Postgres fact the preview relied on. Anything that moved
   refuses, and nothing is written. That includes every hosted account (by
   digest): the full chain read takes minutes, and an account registered
   during it can turn a transfer the preview read as an owner's deposit into
   an internal one. It also includes the home class from the anchor's
   evidence.
3. It checks each movement's identity once more across every epoch.
4. It inserts the `chain-log` rows and reads each back.
5. It **verifies** that epoch 1's receipts are exactly the chain's capital
   set, before anything is taken away.
6. It quarantines the stand-ins (`accounting-repair.ts`'s own statements).
7. It deletes the stale basis and floor rows by exact contents.
8. It proves the postconditions: no unevidenced row left in epoch 1, the
   predicted net, every other epoch's rows unchanged, the peaks, fee accruals
   and risk periods unchanged, the flows distinct, admission's chain rule
   answered before the boundary, nothing seeded for a flat token, one spelling.
9. It records one receipt per action in `closed_epoch_repairs`, with the
   tenant's admission state and the before/after fingerprints.
10. It writes the apply report to `--output` and fsyncs it, **before** the
    commit.

The first apply creates `closed_epoch_repairs` (additive DDL). Receipts are
unique per (account, evidence key) while applied, across every epoch.

Applying again finds nothing to do (`refused (nothing-to-do)`).

### If the apply's outcome is unknown

If the commit was sent and no answer proved it rolled back, the tool says
`outcome unknown: …` and keeps the report file. Two answers prove a
rollback, as in the booking tool. One is an error answering `COMMIT` with a
SQLSTATE in class 40 other than `40003` (a serialization failure or a
deadlock), or in class 23 (a deferred constraint). That error is rethrown.
The other is a `COMMIT` the server answered with the `ROLLBACK` tag, because
the transaction had already failed. That one is
`commit-answered-rollback`. Either way, no report file is left. Any other
error is an unknown outcome, because each can arrive after the commit was
made durable. That includes a dropped or reset connection (`EPIPE`,
`ECONNRESET`, no code), a terminated backend or a server shutting down or
starting (`57P01`, `57P02`, `57P03`), and a connection exception (class 08).
It also includes a cancelled or timed-out statement (`57014`), `40003`
(statement completion unknown, which a pooler can send), and an answer
tagged neither `COMMIT` nor `ROLLBACK`. Run:

```sh
node --import tsx worker/src/closed-epoch-capital-cli.ts \
  --revert-repair <repair id> --output /absolute/private-dir/<tenant>-receipts.json --dry-run
```

It reads the receipts (read only) and says whether the repair committed.

If the apply committed but its report could not be closed, the tool fails
with `applied-but-report-not-closed`. If the report was written but the
`APPLIED` line could not be printed, it fails with `applied-but-not-printed`.
Either way the apply stands, and the report file is kept. The receipts
command above shows it.

## 5. Preview the tenant in admission, approve, roll out

As in [chain-gap-booking.md](chain-gap-booking.md) steps 5 to 7. The tenant's
evidence digest changes (its flows changed), so approve the new digest. The
tenant stays on its rail; for 0x0e1ca0, paper.

If admission still refuses on a fact from after epoch 1 closed, book it with
the booking tool now.

## Rollback

Before the tenant is admitted on the rows:

```sh
node --import tsx worker/src/closed-epoch-capital-cli.ts \
  --revert /absolute/private-dir/<tenant>-epoch1-apply.json --output /absolute/private-dir/<tenant>-revert.json
```

or, without the report (the receipts hold everything):

```sh
node --import tsx worker/src/closed-epoch-capital-cli.ts \
  --revert-repair <repair id> --output /absolute/private-dir/<tenant>-revert.json
```

In one transaction, the revert:

- verifies the receipts against their own digests, and the report against the
  receipts;
- refuses if anything stood on the rows since (the same rules as the booking
  tool: an attested book, a new attestation or approval, a heartbeat or a
  mirrored row);
- refuses, **before writing**, if the account's flows, quarantine history,
  live basis or floors are not exactly as the apply left them;
- puts the basis and floors back from their pre-images, puts each quarantined
  flow back **under its original id**, every column including `chain_id`,
  and deletes the filed rows if still exactly as written;
- **keeps the `flows_quarantine` rows** as history (that table is
  append-only);
- proves the flows, basis and floors are byte for byte as before the apply,
  and marks the receipts `reverted`.

A second revert says `ALREADY REVERTED`.

Once the revert has committed, nothing that fails afterwards turns it into
a failure that reads as "nothing happened", and the revert report is never
removed:

- `reverted-but-report-not-written`: the revert committed, but its report
  could not be written and synced to `--output`. What is there may be
  partial.
- `reverted-but-not-printed`: the revert committed and its report was
  written, but the `REVERTED` line could not be printed.

Either way the receipts read `reverted`. Check them with
`--revert-repair <repair id> --dry-run`, or run the revert again with a new
`--output`, which says `ALREADY REVERTED`. A revert whose `COMMIT` answer
proved nothing fails with `revert-outcome-unknown`, and the same check says
whether it took.

After admission, there is no revert:
narrow the rollout and escalate. The last resort is the backup named in the
receipts.

## Restore drills

Filed rows carry their block time, not the apply time, so a drill whose
restore point is before the apply reports them `missing-in-fork` in `flows`.
Quarantined rows leave `flows` and appear in `flows_quarantine` with the
repair's `quarantined_at`. A revert re-inserts a flow under its old id and
`at`, and re-inserts `cost_basis` and `position_floors` rows with their old
stamps. `closed_epoch_repairs` names every action with its time.

The drill reads `closed_epoch_repairs` itself (`scripts/pg-backup/verify-restore.mjs`,
beside `chain_gap_bookings`) by `applied_at_ms`, as presence-only: a revert
marks each receipt `reverted` in place without moving that stamp. Each
receipt is stamped with its apply's own time, so it is compared like any
other row. The table is created by the first apply, so a drill whose restore
point is before that reads it `missing-in-fork`, as for `flows_quarantine`.

## What it never does

- write `trades`, `agents` (beyond the no-op row lock), `positions`,
  `paper_book`, `journal`, `events`, `fee_accruals` or `risk_periods`;
- write a row in an epoch other than 1, or move a row between epochs;
- book an operation, an owner's root-key operation above all;
- book an in-kind movement;
- move `hwm_usdg`, `hwm_withdrawn_usdg`, `contributions_known` or a risk period.
  `contributions_known` and `quality_at` describe the current epoch, which
  the mirror carries;
- run for a tenant that is not held;
- print or save `DATABASE_URL`, the RPC URL, the grant's serialized
  permission or the sealed key.

## Not decided here

These need their own reviewed decisions:

- The in-flight reconciler books any operation it finds with no row as an
  agent `'swap'`, whatever its validator (`index.ts`
  `reconcileInFlightAtArm`). An owner's sweep found after an arm becomes a
  fake agent trade counted toward the day's caps. 0x0e1ca0's sweep is very
  likely one; 0x4b6dcd's root-key operations may be. Fix it, and audit the
  existing rows.
- A seed that is chain-gated and mode-aware (`planAttestedSeed`,
  `seedBasisForChild`) for the fleet.
- `hwm-repair` before any live re-arm: for 0x0e1ca0 the effective peak is
  145.579752 against 0 on chain.
- The value an owner sweeps in kind (0x0e1ca0's steakUSDG, MU and USAR dust)
  is not a flow, so epoch 1's P&L reads it as a loss.
- Whether `0x9eaa728e…`'s own book records the 145.499004 that left it for
  `0x472e130c…` on 2026-09-15.

## Verification

```sh
node --import tsx --test worker/src/closed-epoch-capital.test.ts worker/src/closed-epoch-capital-cli.test.ts
```

These are in the ordinary `npm test` glob. The fixtures are public receipts:
every transaction that moved 0x0e1ca0's USDG or carried one of its
operations, from block 0 (`worker/src/testdata/closed-epoch-0e1ca0.json`),
and three of 0x4b6dcd's root-key operations
(`worker/src/testdata/closed-epoch-4b6dcd.json`).

The opt-in real-Postgres test needs a disposable **loopback** server in
`MERRYMEN_TEST_PG_URL` and the `pg` driver resolvable (`NODE_PATH` works). It
creates its own database and drops it, and never reads `DATABASE_URL`:

```sh
MERRYMEN_TEST_PG_URL=postgres://postgres@127.0.0.1:<port>/postgres \
  node --import tsx --test worker/src/closed-epoch-capital.postgres.test.ts
```
