/**
 * HOW MANY PHANTOM CONTRIBUTIONS ARE IN THE SHARED LEDGER, AND WHAT THE TOTALS
 * SHOULD BE. READ ONLY — this script writes nothing.
 *
 * Run it from inside the Railway network (the Postgres host is internal-only):
 *
 *   railway run --service orchestrator -- node spikes/accounting-repair/diagnose.mjs
 *
 * WHAT IT IS COUNTING. Two mechanisms put contributions into `flows` that never
 * happened, and they compound:
 *
 *   1. THE WORKER. A hosted child's SQLite lives in an ephemeral container
 *      directory, so a redeploy handed it an empty database, and the old
 *      accounting read that emptiness as "this money just arrived" and booked
 *      the whole balance as an opening contribution. Fixed in bootstrap-state.ts.
 *
 *   2. THE MIRROR. When the child ledger is rebuilt, the mirror finds its
 *      watermark row gone, rewinds the cursor to zero (the orchestrator logs
 *      CURSOR REWOUND) and re-copies rows 1..N from the reborn child. The INSERT
 *      has no ON CONFLICT and `flows` has no unique key, so the shared table
 *      accumulates the OLD rows plus whatever the new incarnation wrote. NOT
 *      fixed by that change — it is a data problem, which is what this is for.
 *
 * THE ROWS ARE DISTINGUISHABLE, which is the whole reason a repair is possible.
 * `source` is 'chain-log' when a flow was read off a USDG Transfer log and
 * 'inferred' when it was deduced from a balance change (index.ts:963), and only
 * the former carries a transaction hash. A chain-log row is a receipt anyone can
 * refetch. An inferred row is an opinion, and it is the opinion both mechanisms
 * manufacture.
 */
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("no DATABASE_URL — run this through `railway run --service orchestrator`");
  process.exit(1);
}
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const q = async (sql, params = []) => (await c.query(sql, params)).rows;

console.log("=== per-agent flow composition ===\n");
const rows = await q(`
  SELECT
    f.agent_id,
    COUNT(*)                                                             AS rows_total,
    COUNT(*) FILTER (WHERE f.tx_hash IS NOT NULL AND f.tx_hash <> '')     AS rows_anchored,
    COUNT(*) FILTER (WHERE f.tx_hash IS NULL OR f.tx_hash = '')           AS rows_inferred,
    COUNT(DISTINCT f.tx_hash) FILTER (WHERE f.tx_hash IS NOT NULL)        AS distinct_txs,
    SUM(CASE WHEN f.direction = 'in' THEN f.amount_usdg ELSE -f.amount_usdg END) AS net_all,
    SUM(CASE WHEN f.tx_hash IS NOT NULL AND f.tx_hash <> ''
             THEN (CASE WHEN f.direction = 'in' THEN f.amount_usdg ELSE -f.amount_usdg END)
             ELSE 0 END)                                                  AS net_anchored,
    a.hwm_usdg,
    a.epoch
  FROM flows f
  LEFT JOIN agents a ON LOWER(a.smart_account) = LOWER(f.agent_id)
  GROUP BY f.agent_id, a.hwm_usdg, a.epoch
  ORDER BY (SUM(CASE WHEN f.direction = 'in' THEN f.amount_usdg ELSE -f.amount_usdg END)
          - SUM(CASE WHEN f.tx_hash IS NOT NULL AND f.tx_hash <> ''
                     THEN (CASE WHEN f.direction = 'in' THEN f.amount_usdg ELSE -f.amount_usdg END)
                     ELSE 0 END)) DESC
`);

let overstatement = 0;
let contaminated = 0;
for (const r of rows) {
  const gap = Number(r.net_all) - Number(r.net_anchored);
  if (Number(r.rows_inferred) > 0) contaminated++;
  overstatement += gap;
  console.log(
    `${r.agent_id}\n` +
      `   rows ${r.rows_total} (anchored ${r.rows_anchored}, inferred ${r.rows_inferred})  ` +
      `epoch ${r.epoch ?? "?"}  hwm ${Number(r.hwm_usdg ?? 0).toFixed(6)}\n` +
      `   net all rows ${Number(r.net_all).toFixed(6)}   net receipts-only ${Number(r.net_anchored).toFixed(6)}   ` +
      `UNSUPPORTED ${gap.toFixed(6)} USDG`,
  );
}
console.log(
  `\n${rows.length} agent(s) with flows; ${contaminated} carry inferred rows; ` +
    `${overstatement.toFixed(6)} USDG of contributions rest on inference fleet-wide.`,
);

console.log("\n=== exact duplicates (same agent, direction, amount, tx) ===");
console.log("A tx-hashed flow copied more than once is the mirror rewind, not a second deposit.\n");
for (const d of await q(`
  SELECT agent_id, direction, amount_usdg, tx_hash, COUNT(*) AS copies
  FROM flows WHERE tx_hash IS NOT NULL AND tx_hash <> ''
  GROUP BY agent_id, direction, amount_usdg, tx_hash HAVING COUNT(*) > 1
  ORDER BY COUNT(*) DESC LIMIT 50
`)) {
  console.log(`  ${d.agent_id} ${d.direction} ${Number(d.amount_usdg).toFixed(6)} ${d.tx_hash} x${d.copies}`);
}

console.log("\n=== repeated inferred amounts (the phantom opening-balance signature) ===");
console.log("The same amount booked as an inferred inbound flow N times is one deploy per N.\n");
for (const d of await q(`
  SELECT agent_id, amount_usdg, COUNT(*) AS times, MIN(at) AS first_at, MAX(at) AS last_at
  FROM flows WHERE (tx_hash IS NULL OR tx_hash = '') AND direction = 'in'
  GROUP BY agent_id, amount_usdg HAVING COUNT(*) > 1
  ORDER BY COUNT(*) DESC LIMIT 50
`)) {
  console.log(
    `  ${d.agent_id} ${Number(d.amount_usdg).toFixed(6)} USDG booked ${d.times}x ` +
      `(${new Date(Number(d.first_at) * 1000).toISOString()} .. ${new Date(Number(d.last_at) * 1000).toISOString()})`,
  );
}

console.log("\n=== fee exposure ===");
console.log("Whether any performance fee was actually charged while contributions were wrong.\n");
for (const f of await q(`
  SELECT agent_id, COUNT(*) AS accruals, SUM(fee_usdg) AS fees, SUM(profit_usdg) AS profit
  FROM fee_accruals GROUP BY agent_id HAVING SUM(fee_usdg) > 0 ORDER BY SUM(fee_usdg) DESC
`)) {
  console.log(
    `  ${f.agent_id}  ${f.accruals} accrual(s)  fees ${Number(f.fees).toFixed(6)} USDG ` +
      `on ${Number(f.profit).toFixed(6)} claimed profit`,
  );
}

console.log("\n=== REPAIR PREVIEW — every row a quarantine would touch, and what it does to the book ===");
console.log("Nothing below is written. This is what `repair.mjs --commit` would move, row by row.\n");
{
  const candidates = await q(`
    SELECT f.id, f.agent_id, f.epoch, f.direction, f.amount_usdg, f.tx_hash, f.source, f.at,
           CASE
             WHEN f.tx_hash IS NOT NULL AND f.tx_hash <> '' THEN 'duplicate of a tx-hashed flow (mirror cursor rewind)'
             WHEN f.source = 'epoch-carry' THEN 'epoch bridge — NOT quarantined, it is evidence'
             ELSE 'inferred from a balance change, not read from a Transfer log'
           END AS reason
    FROM flows f
    WHERE (f.tx_hash IS NULL OR f.tx_hash = '')
       OR f.id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (
             PARTITION BY LOWER(agent_id), direction, amount_usdg, LOWER(tx_hash), COALESCE(log_index, -1)
             ORDER BY at ASC, id ASC) AS rn
           FROM flows WHERE tx_hash IS NOT NULL AND tx_hash <> ''
         ) t WHERE rn > 1)
    ORDER BY f.agent_id, f.epoch, f.at, f.id
  `);
  if (candidates.length === 0) console.log("  (nothing to quarantine)");
  let tenant = null;
  for (const r of candidates) {
    if (r.agent_id !== tenant) {
      tenant = r.agent_id;
      console.log(`\n  ${tenant}`);
    }
    console.log(
      `    id ${String(r.id).padStart(6)}  epoch ${r.epoch ?? "?"}  ${r.direction} ` +
        `${Number(r.amount_usdg).toFixed(6)} USDG  source ${String(r.source).padEnd(15)} ` +
        `tx ${r.tx_hash ? String(r.tx_hash).slice(0, 12) + "…" : "NONE"}\n` +
        `              why: ${r.reason}`,
    );
  }

  console.log("\n  ── contribution totals, and the quality that results ──");
  for (const r of await q(`
    SELECT f.agent_id, f.epoch,
      SUM(CASE WHEN f.direction = 'in' THEN f.amount_usdg ELSE -f.amount_usdg END) AS before_net,
      SUM(CASE WHEN (f.tx_hash IS NOT NULL AND f.tx_hash <> '') OR f.source = 'epoch-carry'
               THEN (CASE WHEN f.direction = 'in' THEN f.amount_usdg ELSE -f.amount_usdg END)
               ELSE 0 END) AS after_net,
      COUNT(*) FILTER (WHERE (f.tx_hash IS NULL OR f.tx_hash = '') AND f.source <> 'epoch-carry') AS unevidenced,
      (SELECT e.equity_usdg FROM equity e
        WHERE LOWER(e.agent_id) = LOWER(f.agent_id) AND e.epoch = f.epoch
        ORDER BY e.at DESC, e.id DESC LIMIT 1) AS nav
    FROM flows f GROUP BY f.agent_id, f.epoch ORDER BY f.agent_id, f.epoch
  `)) {
    const before = Number(r.before_net);
    const after = Number(r.after_net);
    const nav = r.nav === null || r.nav === undefined ? null : Number(r.nav);
    // The resulting quality, by the same rule the worker applies.
    const known = Number(r.unevidenced) === 0;
    const pnl = nav === null || !known ? null : nav - after;
    console.log(
      `    ${r.agent_id} epoch ${r.epoch}\n` +
        `      contributions ${before.toFixed(6)} -> ${after.toFixed(6)} USDG` +
        `   (${Number(r.unevidenced)} unevidenced row(s) removed)\n` +
        `      NAV ${nav === null ? "unknown" : nav.toFixed(6)}   ` +
        `contributionsKnown ${known}   ` +
        `P&L ${pnl === null ? "UNKNOWN — and it must render as unknown, never as 0" : pnl.toFixed(6) + " USDG (gross of gas)"}`,
    );
  }
}

console.log("\n=== is the journal in the shared database at all? ===");
try {
  const [j] = await q("SELECT COUNT(*) AS n FROM journal");
  console.log(`  journal rows in Postgres: ${j.n}`);
  console.log(
    j.n === "0" || Number(j.n) === 0
      ? "  EMPTY — the journal is not mirrored (it is absent from LOG_TABLES by design),\n" +
          "  so every hosted tenant's hash chain died with its container. Continuity for anything\n" +
          "  before the current child is UNRECOVERABLE. It cannot be reconstructed; do not pretend."
      : "  non-empty — investigate, because nothing in ledger-mirror.ts writes this table.",
  );
} catch (e) {
  console.log(`  could not read: ${e.message}`);
}

await c.end();
