# Booking chain activity that Postgres lacks

Attested-gap admission ([fleet-resume.md](fleet-resume.md), step 5) reads the
chain for each live tenant before it registers a new book. It refuses a tenant
when the account sent an operation, or moved USDG, that Postgres has no row
for:

```
[alert] 0x…: resume approval REFUSED — the chain holds operations or USDG
transfers for the account that Postgres lacks: operation 0x… in tx 0x… at
block N; USDG in 4.965021 in tx 0x… log 11 at block N. …
```

The tenant stays held until those rows exist. This page covers booking them
with `worker/src/chain-gap-booking-cli.ts`, one tenant at a time. Every step
is preview first, and nothing is written until the owner of the books has
reviewed the exact rows and a backup exists.

The order is: **preview → the owner reviews → backup → apply → preview the
tenant again → approve → rollout.**

**The tool books only a tenant that refusal holds.** It checks this in
Postgres, not on trust (see [Which tenants it books](#which-tenants-it-books)).
A tenant still running on its own book is refused. Booking it would race its
mirror for the same operation, and the mirror skips any trade whose hash is
already in Postgres.

## What it books, and what it refuses

The tool runs admission's own chain check, from the same block admission
starts at, against one read of Postgres. Then it reads each named
transaction's receipt and block, and classifies every fact. For each token a
trade moved, it also reads the book's balance at a pinned block (see below).

**Where both read from.** Admission's window starts at the oldest financial
cursor of the last mirror, at least 26 hours back, and that 26-hour bound
moves later as time passes. For a tenant held on a chain refusal, the
window also never starts later than where the refused read began. Each
chain refusal records that point (`ledger_resume_approvals.chain_read_from_sec`,
the chain time of the first block it read). So whatever a refusal named is
still in the window however long the booking takes, and the tool and
admission read the same window. A refusal recorded by an earlier build has
no such value. Its start is derived from its own row: the approval's time
less 26 hours, or a cursor stamp its evidence recorded if that is earlier.
That is never later than where its read was asked to start. If its evidence
cannot show that (it does not parse, or a financial cursor in it has no
stamp), the window starts at the first block of all. Without this, a
deposit older than every recent cursor fell out of the window a day after
the refusal: the tool said `NOTHING-MISSING`, and an approval was admitted
with the deposit unbooked.

The classes:

| Class | What it is | What it writes |
|---|---|---|
| `session-trade` | The session key's swap: USDG one way, one token the other, read across the account and its custody vault | A `trades` row, as the in-flight reconciler writes a landed operation the book lost: `kind 'swap'`, `status 'landed'`, `basis_source 'receipt'`, the two legs, the fill (side, quantity and cash from the Transfer logs), gas from the EntryPoint's own event (sponsored or owner-paid), `created_at` at the block time. **Only when the cost-basis snapshot already holds what the chain does in that token** (see below) |
| `session-no-movement` | A session-key operation that moved nothing across the book's edge (an approval, a key install, a probe) | The reconciler's notional-0 row, so the operation is counted |
| `session-reverted` | A session-key operation that the EntryPoint recorded as failed | A resolved revert's row: `status 'reverted'`, its gas, notional 0 |
| `operation-leg` | A USDG transfer inside one of those operations | Nothing extra: the operation's row carries its transaction hash, which answers it |
| `deposit` | USDG in from outside the system, with no operation of the account and nothing paired | A `flows` row, as the chain-capital reconstruction writes one: `source 'chain-log'`, its `tx#log`, the block time |
| `owner-operation` | An operation signed by the owner's own key (the root validator) | **Nothing. It blocks.** The agent's book has no writer for an owner's operation, and booking it as the agent's trade would misattribute it |
| `unresolved` | Anything else, with the reason in words | **Nothing. It blocks.** |

The `unresolved` class covers these cases:

- A session key moved USDG with nothing coming back. A transfer home or an
  energy purchase books a flow beside its row, and that is two writers' work.
- The operation moved several tokens.
- USDG left the account in a transaction with no operation of the account.
- USDG arrived from another hosted account or from the account's own vault.
- A USDG transfer of the account sits outside its operation's execution.
- The fact is not yet 64 blocks deep, or it landed before the current
  accounting epoch opened. The current epoch has no trade, flow or equity
  row yet, so its opening cannot be dated.
- The fact landed after admission's chain refusal of the tenant, or within a
  minute before it. Admission never found it missing from the book a worker
  would run on. Let admission refuse the tenant again, then preview again.
- A trade whose token the cost-basis snapshot does not hold as the chain does
  (next section). A basis left over a token nobody holds is passed over only
  where it provably cannot reach the new book
  ([A basis left over a token nobody holds](#a-basis-left-over-a-token-nobody-holds)).
- A receipt or a balance could not be read.

**One unresolved fact blocks the whole tenant.** Escalate it to Milla and
Codex with the preview file.

### A trade books only if the cost-basis snapshot holds what the chain does

When a tenant is admitted, the new book takes its cost basis from Postgres's
`cost_basis` table, for each symbol that Postgres's `positions` table shows
held. Both tables are the lost book's last mirrored snapshot. The in-flight
reconciler books the basis beside every row it writes. This tool writes
neither table, so a booked trade that the snapshot leaves out would cause one
of two faults:

- **After a buy:** the new book holds the token with no basis, or with a
  basis for less than it holds, and the stop-loss and take-profit measure
  from the wrong cost.
- **After a sell:** the new book restores a basis for more than it holds.

**When the rows were written is never enough.** A missed buy followed by an
ordinary buy rewrites both rows after the missed one, and the basis can still
leave the missed buy out. So the tool compares what the rows **contain** with
the chain.

It reads the token's balance with `balanceOf` for each address of the book
(the account and its custody vaults, as the fill was read) at a **pinned
block**: admission's chain head less 64. Every booked fact is at least 64
blocks deep under that head, so the balance includes all of them and is as
final as they are. A balance read at `latest` could include later activity,
so the transport refuses one.

`positions` and `cost_basis` cover the account and its Trencher vault (the
worker adds the vault's balance to the position). A Pons class vault's
holding belongs to the class book, `class_positions`, which is seeded
separately. So **a tenant with a class vault cannot book a trade in a token
that the class vault holds**: the trade is refused as `class-vault-held`.

A `session-trade` is booked only if one of these holds, judged over every
booked trade in that token together:

- **The snapshot holds none of it.** The book holds none at the pinned
  block, no live `cost_basis` row under any name the token has gone by
  still covers a quantity, and the fill walk (below) does not go below
  zero. Nothing is seeded for the token, so what it cost cannot reach the
  new book. A `cost_basis` row that does still cover a quantity here is
  passed over only when it provably cannot reach the new book either. It is
  then named in the plan, and never booked or changed (see
  [A basis left over a token nobody holds](#a-basis-left-over-a-token-nobody-holds)).
- **The snapshot holds the token.** All of the following are true:
  - its `positions` row's raw balance **and** its live `cost_basis` row's
    quantity each equal the book's balance at the pinned block;
  - both rows were written at or after the last booked trade in the token.
    That check is necessary but never enough alone;
  - the fill walk reproduces the balance;
  - the basis's cost is what those fills give (the cost replay, below). If
    the replay cannot be done, the trade is refused, whichever way the
    booked trades go.

### The fill walk

The tool walks the token's fills back from the balance: every fill Postgres
records in the token, and every trade the plan books, newest first. Before
each fill the book held what it holds after, less what was bought or plus
what was sold. The walk ends when it has passed every booked trade and
stands at zero. That is where the basis last opened, and the fills since
then reproduce the chain's quantity exactly (`reproduced`).

**`reproduced` proves the quantity, not that the basis includes the fills.**
A buy and a sell of the same amount add nothing to the total. So a basis
that left both out holds the chain's quantity too, at the wrong cost. Only
one of the two need be a trade the plan books: the other can be a fill that
Postgres records and the basis never had. The cost replay is what tells
them apart.

- If the walk goes **below zero**, the fills are more than the chain holds.
  Something moved the token that neither Postgres nor the plan records, and
  the trade is refused (`fills-exceed-chain`).
- If the records **do not allow** the walk (`unproven`), a held token is
  refused (`fills-unproven`). This happens when a row in the token is still
  `submitted`, carries no fill, or has a fill from a quote rather than its
  receipt, or when the records run out with the book still holding some.
  The in-flight reconciler writes its rows without a fill, so a held token
  whose history includes one that has not been repaired is refused (see
  [When each fill happened](#when-each-fill-happened) for a repaired one).
  For a token nobody holds, the plan says why in a `note:` and in
  `evidence.holding.fills`, and the trade books.

### The cost replay

From where the walk stopped, the tool replays the walked fills forward,
oldest first, with the worker's own weighted-average arithmetic
(`basis.ts` `applyFill`). It uses each recorded row's `fill_qty_raw` and
`fill_cash_usdg`, and each booked trade's quantity and exact cash from its
receipt. The result, in `evidence.holding.cost`, is what a basis built from
exactly those fills holds.

- If the replay can be done and the basis's cost differs, the trade is
  refused (`basis-cost-differs`), whichever way the trades go.
- The replay cannot be done when a walked buy has no `fill_cash_usdg`, or
  one that does not read back as an exact amount of at most 6 decimals. A
  sell's cash is its proceeds, which never reach the basis, so a sell needs
  none. Then the trade is refused (`cost-unproven`), whichever way the
  booked trades go.

**The quantity checks are never proof of the cost alone,** even when every
booked trade goes the same way. A booked buy can be offset by a recorded
sell that the basis never had, or a booked sell by such a buy: the total
nets to nothing, so the position, the basis quantity, the row times and the
fill walk all agree, while the cost is wrong. A basis can lack a recorded
fill in at least two ways:

- the in-flight reconciler writes a row and skips the basis when it does not
  watch the token, and the history repair later fills in that row's fill
  (`history-fill-repair.ts`);
- the mirrored `cost_basis` can be stale, left by a delete the mirror
  skipped (`basis-seed.ts`).

Nothing in the tool can prove that the basis is exactly the worker's
arithmetic over every recorded fill since it opened, so the cost must be
replayed and equal. `fill_cash_usdg` was added on 2026-08-26, so a buy
written before then has no cash unless the history repair filled it in.
A token whose basis opened before then is likely to refuse here.

### When each fill happened

Booked trades are dated by their block. Recorded rows are dated by
`created_at`, which is when the row was first written, not when its
operation landed:

- An executor writes its row as `submitted` when it sends the operation, a
  few seconds before the block, and settles that row in place.
- The in-flight reconciler writes its row when an arm finds the operation,
  which can be many hours after the block. It writes the row without a
  fill, and the walk stops at such a row as `unproven`. But the history
  repair (`history-fill-repair.ts`, when the orchestrator starts) later fills
  in that row's side, quantity and cash from the receipt and keeps
  `basis_source` `receipt`. The walk then reads the repaired row at the
  arm's time, perhaps hours after its block: out of order.

A row read out of order, or a missed fill that landed in the seconds between
a recorded row's submission and its block, can make the walk refuse
wrongly, or miss an excess it would otherwise find. It can also make the
replayed cost differ from the basis, which refuses. For example, a repaired
reconciler buy of 100 whose row was written hours after its block, and a
missed sell of 100 between the two, is a flat round trip. The walk dates the
buy after the sell, so it goes below zero and refuses the sell
(`fills-exceed-chain`). The quantity checks do not depend on the order, and
a held token books only when the replayed cost equals the basis's.

### A basis left over a token nobody holds

Shogun's TSLA preview of 2026-10-07 is the case this covers:

- Postgres records a buy with no fill (trade #94285, side and quantity null).
- The chain holds a buy Postgres never recorded (the operation this tool
  books).
- Postgres records one sell of both lots together (trade #101069,
  46757368332762768 base units, which is the two buys exactly).
- The live `cost_basis` row still covers the other buy's lot,
  23370235163310797 at 8.332500 USDG. It was written after that sell, yet
  the sell is not in it. [The cost replay](#the-cost-replay) lists ways a
  basis can lack a recorded fill.
- The chain holds none of TSLA at any address of the book, and `positions`
  holds none.

The row's cost cannot be replayed, because the recorded buy (#94285)
carries no fill. The tool cannot say what the row should be, and it does not
change it.

The trade is booked past such a row only when the row **provably cannot
reach the attested book**. Every one of the following must hold
(`staleBasisVerdict`):

1. **The chain holds none.** Every address of the book was read at the
   pinned block (the account, the Trencher vault and, when the grant names
   one, the class vault), and each read 0.
2. **The seed cannot carry it.** Admission seeds the new book's basis only
   for a symbol that `positions` shows held: `raw_balance <> '0'`, in
   `planAttestedSeed` and in the ordinary seed, `seedBasisForChild`. So no
   `positions` row may be held for the token, or under any name the token has
   gone by. That includes another token under the same symbol, because the
   seed would hand it this cost. In addition, the tool calls admission's own
   `planAttestedSeed` on the snapshot's read, and that seed must carry none of
   those names.
3. **It does not outlive admission.** The first mirror pass after the new
   book's worker arms deletes the account's `cost_basis` in any letter-case
   (see below). Every stale row must also be spelled exactly as the grant
   spells the account. An older mirror, from before the delete took any
   letter-case, matched the worker's spelling exactly, and this way it
   deletes the row too.
4. **The fill walk does not go below zero** (`fills-exceed-chain`).

If any of these fails, the trade is refused as `basis-without-position`, and
the sentence says which one failed. A `positions` row that holds `0` under
the name is not held, as the seed reads it. It does not refuse, but the note
says the dashboard shows the cost beside it (below).

When the trade books, the plan says so. `evidence.holding.staleBasis` holds:

- the rows, each with its own spelling of the account;
- the names checked;
- what the seed carries under them (nothing);
- every `positions` row under them;
- the account as the grant spells it, which every row matches;
- a note, also printed at the console, saying the rows are not booked or
  changed, and why they cannot reach the new book.

All of it is in the `previewDigest`. The apply compares the holdings again
inside its transaction: every basis row with its spelling, quantity, cost
and time, every position, and the seed's answer. A row that changed,
re-spelled or went away refuses the apply (`cas`, `(holdings)` or
`(spellings)`), and so does a new position under the name. Through the CLI,
the recomputed preview's digest is no longer the confirmed one, so the apply
refuses earlier (`confirm-mismatch`).

**What happens to the row after admission.** The tool never writes
`cost_basis`, so the row stays exactly as it is until the following steps
change it:

1. **Approval and registration.** Admission's evidence digests every
   `cost_basis` row of the account, so the approval binds the row as it is.
   Registration (`registerAttestedGapSource`) copies it to
   `ledger_snapshot_archive` and leaves it in place. It also archives and
   **deletes the tenant's `mirror_state` cursors**.
2. **The first spawn.** Both seeds read it (`seedBasisForChild`, and
   `completeAttestedSeed` from `planAttestedSeed`). Both skip it, because no
   `positions` row under its symbol is held (condition 2). The new book holds
   no basis for the token.
3. **The first mirror pass after the new book's worker arms.** The worker
   writes its `agents` row under `grant.smartAccount`, as the grant spells it
   when the worker spawns (`store.ts ensureAgent`). The mirror's snapshot
   step then runs `DELETE FROM cost_basis WHERE lower(agent_id) =
   lower(<that spelling>)` and inserts only the book's own rows
   (`ledger-mirror.ts`). `positions`, `position_floors` and
   `class_positions` are replaced the same way.
   - The delete takes the account in any letter-case. So if the owner
     re-signs the grant under another letter-case of the account between
     the apply and the first spawn, the worker registers under the new
     spelling and the row is still deleted. An older mirror matched the
     worker's spelling exactly, and a row under the old spelling survived
     it, still read as the account's by both seeds (they take any
     letter-case). Condition 3 still asks for the grant's spelling at the
     preview and the apply, so the verdict also holds under that older
     mirror, as long as nobody re-signs in between.
   - The delete is skipped only when the pass reads the child as rebuilt. That
     happens only when a `mirror_state` cursor no longer matches the book
     (its row is gone, or another row is there), and registration removed
     every cursor. So this pass is not a rebuilt one, and the row is
     deleted.
   - A pass that runs before the worker has written its `agents` row deletes
     nothing; it only upserts the new book's own seeded rows, so the stale
     row is untouched.
   - The delete is an equality on the lowered account, never a pattern, so
     no other account's rows are touched, whatever it shares with this one.
   - `ledger-mirror.test.ts` holds each of these cases, and
     `chain-gap-booking.postgres.test.ts` runs the re-signed case on
     Postgres.

Until that pass, and indefinitely if the tenant is never run, the row is
read exactly as it is today:

- **Seeds.** Filtered by held symbols, so it is not seeded (above).
- **Dashboard, public agent and token pages, portfolio** (`desk-positions.ts`,
  `read-agent.ts`, `read-token.ts`, `portfolio.ts`). Each joins basis to a
  `positions` row with the same agent and symbol. So the cost shows only
  beside a `positions` row under its name that holds `0`, and the note names
  any such row.
- **The owner's report export** (`reports.ts portfolioTable`). For the book
  the agent is not running (its newest equity mark is of the other mode), the
  export lists that book's `cost_basis` rows with no position, as "not
  valued". So a live stale row appears there only while the newest equity
  mark is paper.
- **Realised and unrealised P&L, hold time.** Realised P&L comes from
  `trades.realized_pnl_usdg`. Unrealised P&L comes from the positions joins
  above. Hold time (`hold-time.ts`) reads `trades`. None of them reads this
  row on its own. `basis-usdg.ts` only converts units.
- **The automatic paper lane.** It counts a live basis with a quantity as an
  open live row, and holds such a tenant for an operator (`openRows`). That
  makes the lane more cautious, not less.
- **The class P&L repair.** Its delete of a stale shared basis
  (`MERRYMEN_REPAIR_CLASS_PNL`, `orchestrator.ts`) covers class positions
  only, so it does not apply here.

### What a refusal says

In any other case the trade and its USDG leg are `unresolved`, and so is the
tenant. A balance that cannot be read proves nothing, so it also leaves the
trade `unresolved`. Each trade's `evidence.holding` shows the position, the
basis, the balances read, the fill walk, the cost replay, and `refusal`,
which names the check that refused:

| `refusal` | What it found |
|---|---|
| `balance-unread` | The book's balance at the pinned block could not be read for every address |
| `class-vault-held` | A Pons class vault holds the token, and positions and cost basis do not cover it |
| `position-differs` | The position's raw balance is not the chain's |
| `basis-missing` | A held position has no live cost basis |
| `basis-differs` | The basis quantity is not the chain's: for example, a fill the lost book never booked to it |
| `position-stale`, `basis-stale` | A row was written before the last booked trade in the token |
| `held-unrecorded` | The chain holds the token and the snapshot holds none |
| `basis-without-position` | The chain and the positions hold none, but a basis still covers a quantity, and it cannot be shown that the basis will not reach the new book. One of these failed: every book address read 0; no `positions` row held (`raw_balance <> '0'`) for the token or under any name it has gone by, another token's included; `planAttestedSeed` carries none of those names; the rows spelled as the grant spells the account. Where all of them hold, the trade books and the basis is named instead ([A basis left over a token nobody holds](#a-basis-left-over-a-token-nobody-holds)) |
| `fills-exceed-chain` | The fill walk went below zero |
| `fills-unproven` | The token is held, and its fills could not be walked back to where its basis opened |
| `basis-cost-differs` | The basis's cost is not what the walked fills give: for example, a buy and a sell the lost book never booked to it |
| `cost-unproven` | The token is held, and the cost could not be replayed: a walked buy has no exact `fill_cash_usdg` |
| `positions-ambiguous`, `position-unreadable`, `basis-unreadable` | The snapshot cannot be read as one answer |

Resolving any of these needs a reviewed basis decision.

### What it never does

The tool never does any of the following:

- invent a figure it cannot prove: realised P&L stays `NULL`, and gas is not
  priced in USDG;
- move `agents.hwm_usdg`, `hwm_withdrawn_usdg` or a risk period;
- touch `cost_basis`, `positions`, `position_floors` or decisions.

A fill's price is the ratio of the two amounts the logs moved, scaled by the
token's `decimals()`. If `decimals()` cannot be read, the price stays `NULL`
and the rest of the row is still booked.

Two consequences need a reviewer's eye:

- **A deposit after the last equity mark** shows as drift at the worker's
  first look. The worker marks contributions unknown and suppresses the fee
  rather than guess. This is existing fail-closed behaviour.
- **A booked trade does not move the cost basis.** It is booked only when
  the snapshot's position and basis already hold what the chain does, as
  described above. For a held token, that includes the basis's cost, which
  must equal what the replayed fills give: a cost that cannot be replayed
  refuses. Still check the positions, basis and floors on the dashboard at
  `exits-only`, before `trade`.
- **A basis left over a token nobody holds stays in Postgres** until the
  first mirror pass after the new book's worker arms deletes it (see
  [A basis left over a token nobody holds](#a-basis-left-over-a-token-nobody-holds)).
  Its note in the preview says why it cannot reach the new book.

## The three tenants held on 2026-10-06

| Tenant | Line | Shape | Expected |
|---|---|---|---|
| `0x8e93bad5a60a266b4283855ceffa0979720aed72` (Shogun, account `0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487`) | 1 op + 1 USDG transfer | A Trencher buy of TSLA whose row is missing (op `0x73578ec3…` in tx `0xdb99af5b…`, block 63838886), and its USDG leg out of the account (log 13). Postgres records the other TSLA buy with no fill (#94285) and one sell of both lots (#101069). A live TSLA basis still covers the other lot, and nothing holds TSLA on chain or in `positions` | The 2026-10-07 preview, run by a build without the stale-basis check: `BLOCKED` on `basis-without-position` (its fill walk `unproven`, not `exceeds`). Expected with this build: `session-trade` + `operation-leg` → one `trades` row, with the TSLA basis named in `evidence.holding.staleBasis` and its note, neither booked nor changed. This holds if the basis row is spelled exactly as the grant spells the account and no `positions` row under TSLA is held. Otherwise `basis-without-position` names which check failed: escalate for a basis decision |
| `0x4b6dcd559c82ea897c34dacfb785fb0c8f85d4c5` | 1 op, 0 transfers | An operation with no USDG leg | `session-no-movement` books the reconciler's row. A root-key `owner-operation` blocks: escalate |
| `0x0e1ca00202df6e686ac2317e10ed8ee8ae5e320d` | 0 ops, 1 transfer | A lone USDG transfer | `deposit` → one `flows` row. Outbound, or from a hosted account or vault, blocks |

The preview settles which shape each tenant is in. These are expectations, not
results.

## Which tenants it books

Postgres does not record which tenants a deploy's `MERRYMEN_FLEET_ROLLOUT`
runs. So the tool proves from Postgres that the tenant is held, and refuses
the preview (`refused:`, exit code `2`) unless all of the following are true:

- **Admission's newest decision for the tenant is a chain refusal.** This is
  its newest `ledger_resume_approvals` row that was not revoked, in state
  `refused`, with a reason starting "the chain holds operations or USDG
  transfers for the account that Postgres lacks". A revoked approval is
  skipped because it decided nothing. Admission drains the old book's tail
  into Postgres before reading the chain, so this refusal shows that the old
  book lacked those facts too.
- **Nothing has written for the tenant since that refusal.** Its heartbeat
  (`agents.beat_at`) and its newest mirror cursor (`mirror_state.updated_at`)
  are no later than the refusal. All three times come from the orchestrator's
  clock.
- **Its book has been quiet for 10 minutes**, by the same two timestamps.

On top of that, only facts that landed at least a minute before the refusal
are booked. A later fact is `unresolved`, which covers a worker running under
a stuck mirror. The apply checks the heartbeat, the mirror cursor, the mode,
the approvals, the attestations and the snapshot again, inside its
transaction. If any of them moved since the preview, it refuses.

If the tenant has no chain refusal, the preview says so. Run admission for it
as [fleet-resume.md](fleet-resume.md) describes, so that admission refuses it
and names what is missing. Then preview here again.

**If a later refusal superseded the chain refusal**, the tool still refuses.
Its anchor is only ever the newest decision: that one row is what proves the
tenant held, and the heartbeat, mirror and fact times above are measured
against it. The preview says `… refused for another reason) is not a chain
refusal …` and, when an earlier chain refusal is still unanswered, it also
says how to get past it. A tenant with a chain refusal no admission has
answered reads `chain:"required"` in admission's preview, with
`chainHeld: true`, even if it now reads as paper (for example, its owner
turned live trading off). So:

1. Preview the tenant in admission's preview.
2. Approve the digest that preview prints once, with the tenant in the
   rollout at `exits-only`. This does not make it trade. Admission reads the
   chain from where the refused read began, and while Postgres still lacks
   what the chain showed it refuses the tenant again, recording a fresh chain
   refusal that names it.
3. Take the tenant out of the rollout and preview here again. The fresh
   refusal is the newest decision now.

Every decision of a held tenant changes its digest: its evidence binds its
newest decision (`checks.chainHeldSince`), so a preview after a refusal never
prints the refused digest again. An approval of a digest already decided,
from an older line or a variable left set, records nothing and raises
`[alert] resume approval: 0x… is held on a chain refusal no admission has
answered, and an approval of this exact evidence refused (…)`. Preview again
and approve the digest that preview prints.

## Before you start

- **Keep the tenant held.** Take it out of `MERRYMEN_FLEET_ROLLOUT` before
  you book, and leave it out until step 7. The tool also refuses a tenant
  that has run since its refusal (above). With
  `MERRYMEN_RESUME_AUTO_PAPER=1`, the orchestrator's automatic lane does not
  approve a tenant that has a chain refusal no admission has answered, even
  when its owner re-signs and it reads as paper again. Its preview is
  recorded and left to you, so the refusal stays its newest decision
  ([fleet-resume.md](fleet-resume.md#the-safe-case-all-of-it)). The lane's
  line tells you to take it out of the rollout and book it first. It never
  offers the approval of its digest as a way to trade: an approval of such a
  tenant reads the chain again, from where the refused read began, and
  admission refuses it again while Postgres lacks what the chain showed.
- **No approval may be open.** If one is, the preview refuses and prints the
  exact `MERRYMEN_RESUME_REVOKE=0x<tenant>:<digest>` to set. Set it, deploy,
  and start again. A booking changes the evidence that approval was given on.
  The revoked approval is passed over, so the chain refusal before it still
  holds the tenant.
- **Where to run it.** Use a shell that can reach the shared Postgres. A
  container in this project can, and the hosted image already installs the
  `pg` driver and `tsx`. `DATABASE_URL` comes from the existing private
  credential mechanism. Never paste it, or the RPC URL, into a command, a PR,
  a report or a chat. The tool prints neither. A driver or network error is
  printed as a fixed code.
- **The RPC.** The default is the public Robinhood Chain mainnet RPC.
  `MERRYMEN_CHAIN_GAP_RPC` selects another. The transport admits only
  `eth_chainId`, `eth_blockNumber`, `eth_getLogs`, `eth_getTransactionReceipt`,
  `eth_getBlockByNumber`, and `eth_call` for exactly two view calls:
  `decimals()` at `latest`, and `balanceOf` of one address at a block number
  (never a tag). The node must still serve state 64 blocks back. The public
  RPC does. If a node cannot, the balance reads as unread and the trade is
  `unresolved`.

## 1. Preview

```sh
node --import tsx worker/src/chain-gap-booking-cli.ts \
  --tenant 0x<tenant> --output /absolute/private-dir/<tenant>-preview.json
```

`--dry-run` is the default and may be given explicitly. The preview does the
following:

1. It reads Postgres in one `REPEATABLE READ READ ONLY` snapshot on a
   connection that the server holds read-only. Every statement must be a
   `SELECT`, and the snapshot is rolled back.
2. It closes that connection and reads the chain.
3. It writes the plan to `--output`. The file is created once, with mode
   `0600`, and is never written over an existing file or through a link.

The console prints one line per fact with its class, then the reason for
anything not booked, any notes, and:

```
chain-gap booking READY — tenant 0x…, account 0x…, epoch 2: 2 fact(s) on chain that Postgres lacks, 1 row(s) proposed
  operation-leg: USDG in 4.965021 in tx 0x… log 11 at block 79494846 → covered by op:0x…
  session-trade: operation 0x… in tx 0x… at block 79494846 → trades row
  note: a trade is booked without touching cost_basis, positions or position_floors, because the snapshot … already holds what the chain does in its token at block …
previewDigest 3f…
PREVIEW ONLY — 0 database writes. The plan is in /…/preview.json.
```

The verdict is one of:

- `READY`: every fact is classified and proposed. Exit code `0`.
- `NOTHING-MISSING`: admission's check is already clean for this tenant.
  Exit code `0`.
- `BLOCKED`: see `refused:` and `why:`. Exit code `2`. Nothing can be applied.

## 2. The owner of the books reviews it

Send the preview file to Milla. For each item, check:

- the transaction on the explorer, as printed;
- the class and its `why`;
- the proposed row, column by column;
- the `evidence`: block hash, validator, payer, the book's net movement and
  the fill amounts, and for a trade its `holding`: the position and basis
  rows and their times, the balances read at the pinned block
  (`capture.balanceBlock`), the fill walk, the cost replay, and the
  `refusal`, if any;
- the `remaining` list, which must be empty;
- the `warnings`.

The `previewDigest` is what the review approves. It covers:

- the code that produced the preview, by file digest;
- the database, by host, port and name;
- every Postgres fact the plan depends on, including the tenant's approvals,
  heartbeat, mirror cursor, positions and cost basis, and its recorded fills
  (by digest);
- the balances read;
- every proposed row.

It does not cover the time of the preview, the chain head or the pinned
block.

## 3. Backup

Take a backup immediately before applying:

- a manual backup of the Postgres service, or
- a noted PITR restore point (UTC), per [backups.md](backups.md).

Write down its name, for example `railway-backup-2026-10-06T09:00Z` or
`pitr-2026-10-06T09:00:00Z`. That name is `--backup-ref`. It must be a name
(letters, digits, `.`, `_`, `:`, `-`), not a URL. It is recorded with every
row the apply writes.

## 4. Apply

```sh
node --import tsx worker/src/chain-gap-booking-cli.ts \
  --tenant 0x<tenant> --apply --confirm <previewDigest> --backup-ref <backup name> \
  --output /absolute/private-dir/<tenant>-apply.json
```

The first line it prints is the booking id and where its report goes:
`booking <id>: its apply report is written to … before the COMMIT is sent`.
Note the id. `--output` is created at that moment (once, mode `0600`).

Apply then recomputes the whole preview. It refuses, writing nothing, unless
the new preview is `READY` with exactly the confirmed digest. If the books,
the chain or the code moved since the review, preview again and review that
one.

Then, in **one transaction** at `SERIALIZABLE` (the tool asks the server and
refuses to run at any other level), the apply:

1. locks the agent row;
2. compares every Postgres fact again (compare-and-set), refusing if any
   changed. This includes the tenant's heartbeat, mirror cursor, mode,
   approvals, attestations, positions, cost basis and recorded fills, so a
   tenant that woke up after the preview is refused;
3. inserts exactly the proposed rows and reads each one back;
4. proves the flows are still distinct and that admission's chain-fact rule
   is now answered for every fact;
5. records one receipt per row in `chain_gap_bookings`. Each receipt also
   records the tenant's admission state at that moment (`admission_json`):
   its approvals, attestations, heartbeat and mirror cursor. The revert is
   decided against this;
6. asks the server which transaction this is: its id
   (`pg_current_xact_id()`, or `txid_current()` before PostgreSQL 13) and
   the server's system identifier (`pg_control_system()`). Both go in the
   report as `xact`;
7. writes the **apply report** to `--output` and fsyncs it, with
   `"commitOutcome": "unknown"`. Only then is the `COMMIT` sent.

Receipts are unique per (account, epoch, `op:<userOpHash>` or
`log:<tx>#<log>`) while applied. Any failure before the `COMMIT` rolls the
whole transaction back, and the report file is removed.

`SERIALIZABLE` makes every compare-and-set read one snapshot, taken before
the agent row is locked. If another transaction writes that row after the
snapshot, the lock fails with `40001` and nothing is written. A conflict
with another `SERIALIZABLE` transaction fails the same way, at a statement
or at the `COMMIT`. The orchestrator's transactions are a plain `BEGIN`, so
they run at Postgres's default `READ COMMITTED`, which its serializable
checks do not track. A write the orchestrator commits between the snapshot
and the `COMMIT` (a few milliseconds) is therefore still not seen, for
example a new agent registration. A lock on `agents` would close that gap,
but every worker's heartbeat would queue behind it, so the tool does not
take one. Step 5 (admission's preview) reads the books again in any case.

On success the console prints
`APPLIED booking <id> — N row(s) for tenant 0x… under backup <name>`. The
report in `--output` has then been replaced, whole, by the same report with
`"commitOutcome": "committed"`. It holds the booking id and every row as
written. Keep it with the runbook evidence, because it is what `--revert`
takes. The receipts table holds the same rows, but `--revert` reads them
only to check the report.

If the report cannot be marked `committed` (the tool writes
`<output>.committed.tmp` and renames it over the report), the tool still
prints `APPLIED`, then exits with `applied-report-not-marked-committed`. The
booking committed. The report still says `unknown` and is still what
`--revert` takes.

The first apply creates `chain_gap_bookings`. This is additive DDL, like the
resume tables.

Applying again finds nothing missing and writes nothing
(`refused (nothing-missing)`).

### If Postgres rolls the apply back for a conflict

```
refused (conflict): Postgres rolled the apply back for a conflict with another transaction (SQLSTATE 40001, a serialization failure): nothing was written — run the same command again, with a new --output; …
```

Nothing was written, and no report is left. Run the same apply again with a
new `--output`. If the books moved in the meantime, it refuses with
`confirm-mismatch`. In that case, preview again.

### If the apply's outcome is unknown

The `COMMIT` can take effect on the server and its answer can still be lost
on the way back. Only these answers prove that it rolled back:

- an error with a SQLSTATE in class `40` (a serialization failure or a
  deadlock), except `40003` ("statement completion unknown");
- an error in class `23` (a deferred constraint, checked at the commit);
- the `COMMIT` answered with `ROLLBACK`'s tag (`commit-answered-rollback`).

With those, nothing was written and no report is left. Anything else is an
unknown outcome, because it can arrive after the commit was made durable.
That includes a dropped or reset connection (`EPIPE`, `ECONNRESET`, no code),
a terminated backend or a server shutting down or starting (`57P01`,
`57P02`, `57P03`), a connection exception (class `08`), and a cancelled or
timed-out statement (`57014`). The tool then keeps the report, which still
says `"commitOutcome": "unknown"`, and prints:

```
OUTCOME UNKNOWN for booking <id>: the COMMIT was sent and no answer proved it rolled back, so it may have committed. … Its transaction is <xid>.
  1. Did it commit? Read only: node --import tsx worker/src/chain-gap-booking-cli.ts --revert <output> --dry-run --output /absolute/new-receipts-report.json
     COMMITTED (receipts 'applied', every row as booked): its rows stand; go on to step 5 of docs/chain-gap-booking.md, or take it back with 2.
     NOT COMMITTED (no receipt, and the server says its transaction ended without committing): nothing was written; preview the tenant again.
     STILL UNKNOWN (no receipt yet, and no such word from the server): keep the report and run 1 again; it settles once the server ends that transaction.
  2. Take it back: node --import tsx worker/src/chain-gap-booking-cli.ts --revert <output> --output /absolute/new-revert-report.json
```

It exits with `apply-outcome-unknown`. Run command 1 first. It opens a
read-only connection and, in one read-only snapshot, reads the booking's
receipts and asks the server what became of the apply's transaction
(`pg_xact_status` on the report's `xact` id). It checks the receipts against
the report as a revert would, and writes its answer to its own `--output`.
It changes nothing in the database. The report names the database it was
applied to (`target`: host, port and name, as the preview digest binds
them). If `DATABASE_URL` names another database, the check and the revert
refuse with `target` before they connect.

**No receipt is not proof that the apply never committed.** The connection
can fail while the `COMMIT` is on its way, and the server may still be
committing, or the apply's session may still be open, when the check takes
its snapshot. The receipts appear moments later. So the check says
`NOT COMMITTED` only when the server says the apply's transaction ended
without committing (`aborted`), on the server whose system identifier the
report holds. Anything else with no receipt is `STILL UNKNOWN`. The check
prints one of:

- `COMMITTED booking <id> …`: every receipt says `applied`, and each booked
  row is still exactly as the report wrote it. The rows stand. Carry on from
  step 5, or take the booking back with command 2.
- `COMMITTED, BUT ITS ROWS DIVERGED booking <id> …`: every receipt says
  `applied`, but a booked row has changed or is gone (`rows[].now` in its
  report says which: `changed` or `gone`). The rows do not stand as booked,
  and a `--revert` refuses (`cas`). Escalate. It exits 2.
- `NOT COMMITTED booking <id> …`: no receipt, and the server says the
  transaction ended without committing. Nothing was written. Preview the
  tenant again. A `--revert` of this report is refused with `not-committed`.
- `STILL UNKNOWN booking <id> …`: no receipt is visible, and the server has
  not said the transaction aborted. **Keep the report**: if the booking
  committed, it is the only thing `--revert` takes. It exits 2.
  `transaction.status` in its report says what the server said, and `why`
  explains it:
  - `in-progress`: the transaction is still open, or had not ended when the
    check began. The apply may still be running or its `COMMIT` still
    going through, or the server has not yet noticed that the apply's
    session is gone. Run the check again in a minute. If it stays
    `in-progress`, look in `pg_stat_activity` for an
    `application_name` of `merrymen-chain-gap-apply`. The server ends that
    session when its connection is found dead. Ending it yourself
    (`pg_terminate_backend`) rolls the transaction back if it has not
    committed, and the check then says `NOT COMMITTED`.
  - `committed-after-snapshot`: it committed after the check took its
    snapshot. Run the check again: it says `COMMITTED`.
  - `committed`: it committed before the snapshot, yet this database holds
    no receipt of it. `DATABASE_URL` names another database on that server,
    or the receipts were removed. Escalate.
  - `forgotten`: the transaction is too old for the server to remember.
  - `other-server`: this server's system identifier is not the report's,
    or one of them could not be read. The id means nothing here.
  - `unrecorded`: the report names no transaction (an earlier build).
- `COMMITTED, THEN REVERTED booking <id> …`: it committed and has since been
  reverted.

Receipts that match the report while the server says the transaction
aborted, or is still open, contradict each other. The check refuses
(`receipts`): escalate.

What binds the check to the right server is the report's `target` (host,
port and database name) and the server's system identifier. A physical
copy of the server (a promoted replica, a restored volume snapshot) keeps
the identifier. On a copy taken before the apply committed, the booking is
not in that copy, and its `NOT COMMITTED` is true of the copy only. Run the
check against the server the apply ran on.

If the process died during the apply, the same check applies to its
`--output`. An empty or cut-short report means the apply never sent its
`COMMIT`, because the report is written in full and fsynced first. The check
says so (`refused (report-unfinished)`). Then nothing was written. If you
want to look without the tool, use the booking id from the first line and
the `xact` id from the report, in a read-only transaction:

```sql
BEGIN READ ONLY;
SELECT evidence_key, table_name, row_id, state, applied_at_ms, reverted_at_ms
  FROM chain_gap_bookings WHERE booking_id = '<id>' ORDER BY evidence_key;
SELECT pg_xact_status('<xact.id>'::xid8),
       (SELECT system_identifier::text FROM pg_control_system());
ROLLBACK;
```

No rows alone does not mean it never committed. Only `aborted`, with the
report's `xact.system` as the system identifier, means that. A
`pg_xact_status` error saying the id is "in the future" means this server
has not reached that id: it is not the server the apply ran on, or it is a
copy of it from before.

## 5. Preview the tenant again (admission's preview)

Set `MERRYMEN_RESUME_PREVIEW=0x<tenant>` and deploy, as in fleet-resume.md
step 2. The tenant's `[resume-preview]` line should show:

- `pass: true`;
- a **new** `digest`, because the booked rows are now in the evidence;
- `chain: "required"` and `chainHeld: true`. Admission reads the chain for
  this tenant until an admission answers the refusal, from the same second
  the tool read from, so what you booked is in that read. That is the check
  step 7 watches for;
- `lastRefusal`, still the old chain refusal. This is information only, and
  it stays until a newer approval supersedes it.

## 6. Approve

Set `MERRYMEN_RESUME_APPROVE=0x<tenant>:<the new digest>` and deploy.
Approve per tenant, never with a `run:` that was taken before the booking.

## 7. Rollout

Add `0x<tenant>:exits-only` to `MERRYMEN_FLEET_ROLLOUT` and deploy, as in
fleet-resume.md step 5. Watch for this line:
`resume chain check clean — … all in Postgres`.

If the chain check refuses again, the new refusal names what is still
missing. That is something that landed after the booking: start again at
step 1.

At `exits-only`, check the positions, cost basis and floors on the dashboard
before moving the tenant to `trade` (step 7 of fleet-resume.md).

## Rollback

Before the tenant is admitted on the rows, run:

```sh
node --import tsx worker/src/chain-gap-booking-cli.ts \
  --revert /absolute/private-dir/<tenant>-apply.json --output /absolute/private-dir/<tenant>-revert.json
```

It takes the apply report, whether it says `"commitOutcome": "committed"` or
`"unknown"` (or nothing, from a build before that field). In one transaction
at `SERIALIZABLE`, the revert:

- verifies the report against its own digest and against the receipts. The
  report's apply time and admission state must be the ones the receipts
  hold. If no receipt of the booking is visible, it changes nothing and
  refuses. It says `not-committed` only when the server says the apply's
  transaction ended without committing, so there is nothing to revert.
  Otherwise it says `no-receipt`: the apply may still be open or
  committing. Keep the report and run the check in
  [If the apply's outcome is unknown](#if-the-applys-outcome-is-unknown);
- refuses if any row is no longer exactly as written;
- refuses if anything has relied on the rows since the apply. It compares
  what the database records now with the receipts' `admission_json`, and
  never compares one machine's clock with another's. It refuses for any of
  the following:
  - an attested book is in use for the tenant;
  - an attestation was recorded after the apply;
  - an approval created after the apply is still `approved`. Revoke it first;
  - an approval created after the apply reached `archiving`, `archived`,
    `registered` or `applied`, or minted a generation or archived a home on
    its way to `refused` or `revoked`;
  - an approval that existed at the apply has changed;
  - the tenant's heartbeat or mirror cursor moved, which means a worker
    wrote its book;
- removes the rows and marks each receipt `reverted`, keeping the row in full.

An approval created after the apply that was refused or revoked before it
minted anything did not rely on the rows, so it does not block a revert.

Running it a second time prints `ALREADY REVERTED` and changes nothing.

A revert that Postgres rolls back for a conflict says `refused (conflict)`
and changed nothing: run it again. If its `COMMIT` is sent and no answer
proves a rollback (the same rule as the apply's), it prints
`OUTCOME UNKNOWN for the revert of booking <id>`, leaves no revert report and
exits with `revert-outcome-unknown`. Run the same `--revert` again with a new
`--output`. If the first one committed, the second prints `ALREADY REVERTED`
and changes nothing. Otherwise it reverts. To only look, run
`--revert <apply report> --dry-run` as in
[If the apply's outcome is unknown](#if-the-applys-outcome-is-unknown). It
prints `COMMITTED, THEN REVERTED` once the revert has committed.

After admission, there is no revert. Narrow `MERRYMEN_FLEET_ROLLOUT` and
escalate. The last resort is the backup named in the receipts.

## Restore drills

Booked rows carry their block time, not the apply time. A restore drill whose
restore point falls before the apply will report `trades` or `flows`
`missing-in-fork` for them. `chain_gap_bookings` names each one, with the time
it was applied.

## Verification

```sh
node --import tsx --test worker/src/chain-gap-booking.test.ts worker/src/chain-gap-booking-cli.test.ts \
  worker/src/ledger-resume.test.ts worker/src/orchestrator-ledger-resume.integration.test.ts \
  worker/src/ledger-mirror.test.ts
```

These tests are in the ordinary `npm test` glob. The fixtures are Shogun's
own public receipts (the Trencher sell and the enable-mode buy of
2026-10-04, and a root-key operation of 2026-10-03), plus synthetic
operations and deposits. Shogun's TSLA shape from the 2026-10-07 preview is
a fixture too. Its amounts, trade ids, block and times are the preview's
own, and the parts of each hash the preview did not print are synthetic.
`ledger-mirror.test.ts` holds what the first mirror pass after an attested
registration does to a basis the new book never had.

`chain-gap-booking-cli.test.ts` holds each answer a `COMMIT` can get. A
lost answer after the commit took effect (`EPIPE`, `ECONNRESET`, `57P01`,
`57P02`, `57P03`, `08006`, `08007`, `57014`, `40003`, no code) keeps the
report, and the receipts settle it. A proven rollback (`40001`, `40P01`,
`40002`, `23505`, `23514`, `ROLLBACK`'s tag) leaves no report and writes
nothing. Its stand-in server hands out transaction ids and answers
`pg_xact_status`, so the check is shown saying `STILL UNKNOWN`, never
`NOT COMMITTED`, for a transaction in progress, forgotten, committed with
no receipt, on another server or an unreadable one, an id the server has
not reached, and a report with no id. It also shows `DIVERGED` for a
booked row changed or gone, and refuses receipts that the server
contradicts.

The opt-in real-Postgres tests also cover the stale-basis case. There,
admission's own seed runs inside the read-only snapshot, and the apply
compares the named basis again. They also run the write transaction against
the server. They check that it is `SERIALIZABLE` as the server reports it,
and that it gets a real `40001` when the agent row moves after its snapshot.
They fail the `COMMIT` with a deferred constraint (`23514`) and with
serializable write skew (`40001`), and answer it with `ROLLBACK`'s tag. They
terminate the backend as the `COMMIT` is sent (`NOT COMMITTED` on the
server's word that it aborted), and lose the answer after a real commit.
They pause the apply just before its `COMMIT` and run the check and a
revert: `STILL UNKNOWN` and `no-receipt`. They let the `COMMIT` through
between the check's snapshot and its question to the server
(`committed-after-snapshot`). They also change and delete a booked row
(`DIVERGED`). They need two things: a disposable **loopback**
server in `MERRYMEN_TEST_PG_URL`, and the `pg` driver resolvable. `NODE_PATH`
works, because the tests load the driver with `require`. Each test creates
its own database and drops it, and never reads `DATABASE_URL`:

```sh
MERRYMEN_TEST_PG_URL=postgres://postgres@127.0.0.1:<port>/postgres \
  node --import tsx --test worker/src/chain-gap-booking.postgres.test.ts
```
