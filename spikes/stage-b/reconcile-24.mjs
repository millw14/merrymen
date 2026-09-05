/**
 * READ-ONLY. Reconcile the orchestrator's `fleet: N agent(s)` census against the
 * set of smart accounts that have ever armed.
 *
 * WHY THIS WORKS WITHOUT A DATABASE READ.
 *   fleetHealth() counts ROWS in the shared `agents` table, unfiltered:
 *     SELECT status, COUNT(*) FROM agents GROUP BY status     (orchestrator.ts:560)
 *   The only writer of that table is the ledger mirror, which upserts one row per
 *   smart_account it finds in a child's own ledger (ledger-mirror.ts:481), and
 *   NOTHING anywhere deletes from it. So the census is exactly
 *     |{ smart accounts that have ever armed under a mirroring orchestrator }|
 *   and every arm prints `[worker] executor <mode> — smart account 0x…`.
 *
 * Reads only the per-deployment log captures under <scratchpad>/sb/.
 */
import fs from "node:fs";
import path from "node:path";

const SC = "C:/Users/1/AppData/Local/Temp/claude/C--Users-1-Documents-milla-projects/6042837b-fc09-4d49-881b-472d0a87cf43/scratchpad";
const deps = fs
  .readFileSync(path.join(SC, "sb-deps.tsv"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const [id, at, status, commit, msg] = l.split("\t");
    return { id, at, status, commit, msg };
  });

const ACCT = /\[(0x[0-9a-fA-F]{6})\] \[worker\] executor (live|paper|idle)[^\n]*?smart account ((?:0x[0-9a-fA-F]{40})|(?:rh:[A-Za-z0-9]+))/;
const FLEET = /fleet: (\d+) agent\(s\) — ([^"]*)$/;

function readJsonl(f) {
  if (!fs.existsSync(f)) return null;
  const out = [];
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a truncated tail line */
    }
  }
  return out;
}

const seenAccounts = new Map(); // account -> {first, last, tenants:Set, deploys:Set}
const rows = [];
let missing = 0;

for (const d of deps) {
  const acct = readJsonl(path.join(SC, "sb", `acct-${d.id}.json`));
  const fleet = readJsonl(path.join(SC, "sb", `fleet-${d.id}.json`));
  if (!acct || !fleet) missing++;

  const here = new Map(); // account -> tenant prefix, this deployment
  for (const o of acct ?? []) {
    const m = ACCT.exec(o.message ?? "");
    if (!m) continue;
    const a = m[3].toLowerCase();
    here.set(a, m[1].toLowerCase());
    const e = seenAccounts.get(a) ?? { first: o.timestamp, last: o.timestamp, tenants: new Set(), deploys: new Set() };
    if (o.timestamp && (!e.first || o.timestamp < e.first)) e.first = o.timestamp;
    if (o.timestamp && (!e.last || o.timestamp > e.last)) e.last = o.timestamp;
    e.tenants.add(m[1].toLowerCase());
    e.deploys.add(d.id.slice(0, 8));
    seenAccounts.set(a, e);
  }

  const vals = new Map();
  for (const o of fleet ?? []) {
    const m = FLEET.exec(o.message ?? "");
    if (!m) continue;
    const n = Number(m[1]);
    if (!vals.has(n)) vals.set(n, { n: 0, first: o.timestamp, last: o.timestamp, parts: m[2].trim() });
    const v = vals.get(n);
    v.n++;
    v.last = o.timestamp;
  }

  rows.push({
    ...d,
    have: !!acct,
    childrenHere: new Set([...here.values()]).size,
    acctsHere: here.size,
    acctLines: (acct ?? []).length,
    fleetVals: [...vals.entries()].sort((a, b) => a[0] - b[0]),
    cumulative: seenAccounts.size,
  });
}

console.log("deployment                         commit   children accts  cumulative  census");
for (const r of rows) {
  const census = r.fleetVals.map(([n, v]) => `${n}x${v.n}`).join(",") || "-";
  console.log(
    `${r.at.slice(0, 19)}  ${r.id.slice(0, 8)}  ${r.commit}  ${r.have ? String(r.childrenHere).padStart(3) : " NO"}  ${r.have ? String(r.acctsHere).padStart(3) : "CAP"}  ${String(r.cumulative).padStart(4)}       ${census}${r.acctLines >= 4990 ? "   (acct capture at cap!)" : ""}`,
  );
}

// ── the running set: the 22 accounts of the LIVE deployment (be09d72) ────────
// accts.txt was harvested from the running deployment's own `executor live` lines.
const running = new Set(
  fs
    .readFileSync(path.join(SC, "accts.txt"), "utf8")
    .split("\n")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

console.log(`\nCUMULATIVE distinct smart accounts ever armed: ${seenAccounts.size}`);
console.log(`RUNNING under the live deployment be09d72: ${running.size}`);
console.log(`\n=== every account ever armed that is NOT running now ===`);
for (const [a, e] of [...seenAccounts].sort((x, y) => (x[1].first < y[1].first ? -1 : 1))) {
  if (running.has(a)) continue;
  console.log(
    `  ${a}\n     owner-prefix ${[...e.tenants].join(",")}  first ${e.first?.slice(0, 19)}  last ${e.last?.slice(0, 19)}  in ${e.deploys.size} deploy(s)`,
  );
}
// THE CUTOFF. The mirror's `agents` copy shipped in 79fb898 (deployed 08-30T14:00Z),
// but the orchestrator did not apply the ledger schema to the SHARED database until
// a8926f0, first deployed as 1621ed2 at 2026-08-31T03:47:58Z — before that the
// INSERT hit a table the shared database did not have, and mirrorTenant's per-table
// catch swallowed it. So an account whose LAST arm predates that deployment never
// had a row written for it, and (nothing deletes rows) never will.
const MIRROR_LIVE = "2026-08-31T03:47:58";
const preMirror = [...seenAccounts].filter(([, e]) => (e.last ?? "") < MIRROR_LIVE);
console.log(`\naccounts whose LAST arm predates the agents-mirror going live (${MIRROR_LIVE}Z): ${preMirror.length}`);
for (const [a, e] of preMirror) console.log(`  ${a}  last ${e.last?.slice(0, 19)}  owner-prefix ${[...e.tenants].join(",")}`);
console.log(`\npredicted rows in shared agents = ever-armed ${seenAccounts.size} − pre-schema ${preMirror.length} = ${seenAccounts.size - preMirror.length}`);
console.log("\n=== all accounts ever armed, oldest last-arm first ===");
for (const [a, e] of [...seenAccounts].sort((x, y) => ((x[1].last ?? "") < (y[1].last ?? "") ? -1 : 1))) {
  const row = (e.last ?? "") >= MIRROR_LIVE;
  console.log(
    `  ${a}  owner ${[...e.tenants].join(",")}  last ${e.last?.slice(0, 19)}  row=${row ? "YES" : "no "}  running=${running.has(a) ? "YES" : "no "}`,
  );
}
for (const [a, e] of seenAccounts) {
  if (!running.has(a) && (e.last ?? "") >= MIRROR_LIVE) {
    console.log(`  => EXTRA ROW CANDIDATE ${a}  owner-prefix ${[...e.tenants].join(",")}  last arm ${e.last?.slice(0, 19)}`);
  }
}
console.log(`\n(deployments with a missing capture: ${missing})`);
