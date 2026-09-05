/**
 * READ-ONLY. Per deployment: which tenants the SPAWN LOOP spawned (= rows in the
 * `grants` table, the thing the census does NOT read), and which of them ever
 * printed an `executor live — smart account …` line.
 *
 * A tenant that is spawned but never arms is the dangerous case: it has a grant,
 * the operator's census counts it, and it is not trading.
 */
import fs from "node:fs";
import path from "node:path";

const SC = "C:/Users/1/AppData/Local/Temp/claude/C--Users-1-Documents-milla-projects/6042837b-fc09-4d49-881b-472d0a87cf43/scratchpad";
const deps = fs
  .readFileSync(path.join(SC, "sb-deps.tsv"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const [id, at, status, commit] = l.split("\t");
    return { id, at, status, commit };
  });

const SPAWN = /^\[orchestrator\] (0x[0-9a-fA-F]{40}) spawned \(pid/;
const ACCT = /\[(0x[0-9a-fA-F]{6})\] \[worker\] executor (?:live|paper|idle)[^\n]*?smart account ((?:0x[0-9a-fA-F]{40})|(?:rh:[A-Za-z0-9]+))/;

function jsonl(f) {
  if (!fs.existsSync(f)) return null;
  const out = [];
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* truncated */
    }
  }
  return out;
}

const everSpawned = new Map(); // tenant(full) -> {first,last,deploys:Set}
for (const d of deps) {
  const sp = jsonl(path.join(SC, "sb", `spawn-${d.id}.json`));
  const ac = jsonl(path.join(SC, "sb", `acct-${d.id}.json`));
  const spawned = new Set();
  for (const o of sp ?? []) {
    const m = SPAWN.exec(o.message ?? "");
    if (!m) continue;
    const t = m[1].toLowerCase();
    spawned.add(t);
    const e = everSpawned.get(t) ?? { first: o.timestamp, last: o.timestamp, deploys: new Set() };
    if (o.timestamp && o.timestamp < e.first) e.first = o.timestamp;
    if (o.timestamp && o.timestamp > e.last) e.last = o.timestamp;
    e.deploys.add(d.id.slice(0, 8));
    everSpawned.set(t, e);
  }
  const armed = new Set();
  for (const o of ac ?? []) {
    const m = ACCT.exec(o.message ?? "");
    if (m) armed.add(m[1].toLowerCase());
  }
  const spawnedNotArmed = [...spawned].filter((t) => !armed.has(t.slice(0, 8)));
  console.log(
    `${d.at.slice(0, 19)}  ${d.id.slice(0, 8)}  ${d.commit}  spawned=${sp ? String(spawned.size).padStart(2) : "--"}  armed=${ac ? String(armed.size).padStart(2) : "--"}${spawnedNotArmed.length ? `  SPAWNED-BUT-NEVER-ARMED: ${spawnedNotArmed.map((t) => t.slice(0, 8)).join(",")}` : ""}`,
  );
}

console.log(`\ndistinct tenants ever spawned: ${everSpawned.size}`);
for (const [t, e] of [...everSpawned].sort((a, b) => (a[1].last < b[1].last ? -1 : 1))) {
  console.log(`  ${t.slice(0, 10)}…  first ${e.first?.slice(0, 19)}  last ${e.last?.slice(0, 19)}  in ${e.deploys.size} deploy(s)`);
}
