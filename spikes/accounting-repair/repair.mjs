/**
 * QUARANTINE THE CONTRIBUTIONS THAT ARE NOT RECEIPTS. Nothing is deleted.
 *
 *   railway run --service orchestrator -- node spikes/accounting-repair/repair.mjs           # dry run
 *   railway run --service orchestrator -- node spikes/accounting-repair/repair.mjs --commit  # writes
 *
 * READ diagnose.mjs FIRST. This script acts on what that one measures, and
 * running it without having looked at the numbers is how a repair becomes a
 * second incident.
 *
 * WHY QUARANTINE AND NOT DELETE. A wrong row is evidence of a bug and the only
 * remaining record of what the fleet believed while the bug was live. Deleting
 * it destroys the ability to explain a number an owner may already have seen,
 * and there is no procedure that walks a DELETE back. Moving the rows to
 * `flows_quarantine` makes the live total correct while keeping every row
 * reachable, and it is reversible with an INSERT ... SELECT.
 *
 * WHAT IT TOUCHES, and nothing else:
 *
 *   1. EXACT DUPLICATES of a tx-hashed flow. The same transaction cannot have
 *      deposited twice; a second copy is the mirror's cursor rewind re-reading a
 *      rebuilt child ledger into a table with no unique key. The oldest row of
 *      each group stays, the copies are quarantined. This is unambiguous.
 *
 *   2. INFERRED flows — `tx_hash IS NULL`, written when a balance change was
 *      deduced rather than read (index.ts:963). Every phantom opening balance is
 *      one of these. So, unavoidably, is every LEGITIMATE deposit made while the
 *      deposit scan was off, and this script cannot tell them apart, because
 *      nothing in the row can. That is why the choice is quarantine: the true
 *      figure comes back from the chain, not from guessing which opinions to keep.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH:
 *
 *   THE HIGH-WATER MARK. It was inflated in lockstep with the phantom
 *   contributions (record() calls adjustAgentHwm), so it is now too HIGH — which
 *   suppresses performance fees rather than charging them. That is the safe
 *   direction, and `setAgentHwm` is MAX() precisely so nothing lowers a peak
 *   silently. Correcting it charges an owner money and is a decision, not a
 *   repair. The numbers are reported; the write is not made.
 *
 * AFTER THIS RUNS the contribution total is receipts-only and therefore
 * UNDERSTATED for any agent that was genuinely funded while the deposit scan was
 * off. That is the honest state, and the worker now reports it as such:
 * `contributionsKnown` is false and P&L reads unavailable rather than wrong. The
 * way back to a complete figure is to enable the deposit scan so every flow is
 * read off a USDG Transfer log and carries a hash — not to re-infer.
 */
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
/**
 * INFERRED FLOWS ARE NOT QUARANTINED BY DEFAULT, and the reason is a hazard this
 * script had in its first version.
 *
 * `openNextEpoch` carries capital across an accounting-epoch boundary by writing
 * an OPENING BALANCE — necessarily inferred, because it is a bookkeeping entry
 * rather than a transfer anyone can point at. For an agent that has crossed a
 * boundary, that row IS its contribution total. Quarantining it drops
 * contributions to zero, and `pnlUsdg(equity, 0, gas)` is the whole bankroll
 * published as profit: the exact bug the epoch mechanism was built to prevent,
 * reintroduced by the cleanup.
 *
 * So the destructive half is opt-in, it refuses any agent it would leave with a
 * contribution total of zero against positive equity, and the default pass takes
 * only the unambiguous duplicates.
 */
const INCLUDE_INFERRED = process.argv.includes("--include-inferred");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("no DATABASE_URL — run this through `railway run --service orchestrator`");
  process.exit(1);
}
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (sql, params = []) => (await c.query(sql, params)).rows;

console.log(COMMIT ? "MODE: COMMIT — this will write.\n" : "MODE: DRY RUN — nothing is written. Pass --commit to apply.\n");

await q(`
  CREATE TABLE IF NOT EXISTS flows_quarantine (
    id            BIGINT,
    agent_id      TEXT,
    direction     TEXT,
    amount_usdg   DOUBLE PRECISION,
    tx_hash       TEXT,
    block_number  BIGINT,
    log_index     BIGINT,
    source        TEXT,
    epoch         INTEGER,
    at            BIGINT,
    reason        TEXT,
    quarantined_at BIGINT
  )
`);

/** The copies of a tx-hashed flow, keeping the oldest row of each group. */
const DUPES = `
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY LOWER(agent_id), direction, amount_usdg, LOWER(tx_hash), COALESCE(log_index, -1)
      ORDER BY at ASC, id ASC
    ) AS rn
    FROM flows WHERE tx_hash IS NOT NULL AND tx_hash <> ''
  ) t WHERE rn > 1
`;
// EPOCH BRIDGES ARE NOT QUARANTINED. 'epoch-carry' has no transaction and never
// can — it is the closing equity of the epoch just closed — but it is checkable
// against that epoch's own final mark, which is a different and sufficient kind
// of evidence. Sweeping it up with real inference is what would have zeroed the
// contributions of every agent that had crossed a boundary.
const INFERRED = `SELECT id, agent_id FROM flows WHERE (tx_hash IS NULL OR tx_hash = '') AND source <> 'epoch-carry'`;

const dupes = await q(DUPES);
const inferredAll = await q(INFERRED);

// AGENTS THIS WOULD LEAVE CLAIMING NOTHING WAS EVER CONTRIBUTED, while holding
// money. Every one is refused: an epoch-boundary opening balance is inferred by
// construction and is the whole contribution total for an agent that has crossed
// one, so removing it turns the owner's principal into published profit.
const wouldZero = new Set(
  (
    await q(`
    SELECT f.agent_id
    FROM flows f
    LEFT JOIN (SELECT agent_id, equity_usdg FROM equity) e ON LOWER(e.agent_id) = LOWER(f.agent_id)
    GROUP BY f.agent_id
    HAVING SUM(CASE WHEN f.tx_hash IS NOT NULL AND f.tx_hash <> ''
                    THEN (CASE WHEN f.direction = 'in' THEN f.amount_usdg ELSE -f.amount_usdg END)
                    ELSE 0 END) <= 0
       AND SUM(CASE WHEN f.direction = 'in' THEN f.amount_usdg ELSE -f.amount_usdg END) > 0
  `)
  ).map((r) => String(r.agent_id).toLowerCase()),
);

const inferred = INCLUDE_INFERRED
  ? inferredAll.filter((r) => !wouldZero.has(String(r.agent_id ?? "").toLowerCase()))
  : [];
const [{ n: before }] = await q("SELECT COUNT(*) AS n FROM flows");
console.log(`flows rows now:              ${before}`);
console.log(`duplicate tx-hashed copies:  ${dupes.length}   (the mirror rewind — always taken)`);
console.log(
  `inferred (no transaction):   ${inferredAll.length}   ` +
    (INCLUDE_INFERRED
      ? `(taking ${inferred.length}; ${inferredAll.length - inferred.length} REFUSED to protect an agent ` +
        `whose only contribution record is inferred)`
      : `(NOT taken — pass --include-inferred, and read this file's header first)`),
);
if (wouldZero.size) {
  console.log(
    `\n!! ${wouldZero.size} agent(s) hold money but have NO receipt-backed contribution at all.\n` +
      `   Quarantining their inferred flows would leave contributions at zero, and pnlUsdg(equity, 0, gas)\n` +
      `   publishes the owner's principal as profit. They are excluded even under --include-inferred:`,
  );
  for (const a of wouldZero) console.log(`     ${a}`);
}

console.log("\n=== contribution totals, before and after ===");
for (const r of await q(`
  SELECT agent_id,
    SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END) AS net_all,
    SUM(CASE WHEN tx_hash IS NOT NULL AND tx_hash <> ''
             THEN (CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END) ELSE 0 END) AS net_kept
  FROM flows GROUP BY agent_id ORDER BY agent_id
`)) {
  const all = Number(r.net_all);
  const kept = Number(r.net_kept);
  console.log(`  ${r.agent_id}  ${all.toFixed(6)} -> ${kept.toFixed(6)}  (removing ${(all - kept).toFixed(6)} unsupported)`);
}

console.log("\n=== high-water marks, REPORTED not changed ===");
for (const r of await q(`
  SELECT a.smart_account, a.hwm_usdg,
    COALESCE((SELECT SUM(CASE WHEN f.direction = 'in' THEN f.amount_usdg ELSE -f.amount_usdg END)
              FROM flows f WHERE LOWER(f.agent_id) = LOWER(a.smart_account)
                AND f.tx_hash IS NOT NULL AND f.tx_hash <> ''), 0) AS net_kept
  FROM agents a WHERE a.hwm_usdg > 0 ORDER BY a.hwm_usdg DESC
`)) {
  console.log(
    `  ${r.smart_account}  hwm ${Number(r.hwm_usdg).toFixed(6)}  receipts-only contributions ${Number(r.net_kept).toFixed(6)}` +
      (Number(r.hwm_usdg) > Number(r.net_kept) ? "   [peak sits above contributions — fees suppressed, the safe direction]" : ""),
  );
}

if (!COMMIT) {
  console.log("\nDry run complete. Nothing was written.");
  await c.end();
  process.exit(0);
}

// ONE TRANSACTION. A partial repair is worse than none: the totals would be
// correct for the rows that moved and wrong for the rows that did not, with
// nothing on the record saying which pass they belong to.
const now = Math.floor(Date.now() / 1000);
await q("BEGIN");
try {
  for (const [ids, reason] of [
    [dupes.map((r) => r.id), "duplicate of a tx-hashed flow — mirror cursor rewind re-copied a rebuilt child ledger"],
    [inferred.map((r) => r.id), "inferred from a balance change, not read from a Transfer log — not a receipt"],
  ]) {
    if (!ids.length) continue;
    await c.query(
      `INSERT INTO flows_quarantine
         (id, agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, at, reason, quarantined_at)
       SELECT id, agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, at, $2, $3
       FROM flows WHERE id = ANY($1::bigint[])`,
      [ids, reason, now],
    );
    await c.query("DELETE FROM flows WHERE id = ANY($1::bigint[])", [ids]);
    console.log(`quarantined ${ids.length} row(s): ${reason}`);
  }
  await q("COMMIT");
} catch (e) {
  await q("ROLLBACK");
  console.error(`ROLLED BACK — ${e.message}`);
  process.exit(1);
}

const [{ n: after }] = await q("SELECT COUNT(*) AS n FROM flows");
console.log(`\nflows rows: ${before} -> ${after}. Quarantined rows are in flows_quarantine and can be restored.`);
console.log("The high-water marks were NOT changed. Enable the deposit scan to rebuild a complete figure.");
await c.end();
