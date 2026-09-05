/**
 * READ-ONLY. Per-deployment history of the orchestrator's fleet census line.
 * Reads the per-deployment log captures written by sweep-fleet.sh.
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

const prefix = process.argv[2] ?? "fleet";
let total = 0;
for (const d of deps) {
  const f = path.join(SC, "sb", `${prefix}-${d.id}.json`);
  if (!fs.existsSync(f)) {
    console.log(`${d.at}  ${d.commit}  ${d.id.slice(0, 8)}  (not fetched)`);
    continue;
  }
  const s = fs.readFileSync(f, "utf8");
  const vals = {};
  let firstTs = null;
  let lastTs = null;
  for (const line of s.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = /fleet: (\d+) agent\(s\) — ([^"]*)$/.exec(o.message ?? "");
    if (!m) continue;
    total++;
    const k = `${m[1]}|${m[2].trim()}`;
    vals[k] = (vals[k] || 0) + 1;
    if (!firstTs) firstTs = o.timestamp;
    lastTs = o.timestamp;
  }
  const summary = Object.entries(vals)
    .map(([k, n]) => `${k} x${n}`)
    .join("  ||  ");
  console.log(
    `${d.at}  ${d.commit}  ${d.id.slice(0, 8)}  ${summary || "(no fleet line)"}  ${firstTs ? `[${firstTs.slice(5, 19)} → ${lastTs.slice(5, 19)}]` : ""}`,
  );
}
console.log(`\ntotal fleet lines seen: ${total}`);
