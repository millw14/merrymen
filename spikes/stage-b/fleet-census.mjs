/**
 * READ-ONLY. Reconcile the orchestrator's "fleet: N agent(s)" census against the
 * spawn loop's tenant count, using log captures already on disk.
 *
 * No network, no database, no writes.
 */
import fs from "node:fs";
import path from "node:path";

const DIR = process.argv[2];
const files = fs.readdirSync(DIR).filter((f) => /\.(json|log|txt|out|ndjson)$/.test(f));

// ── 1. every distinct "fleet:" census value ever captured ────────────────────
const census = {};
for (const f of files) {
  let s;
  try {
    s = fs.readFileSync(path.join(DIR, f), "utf8");
  } catch {
    continue;
  }
  if (!s.includes("fleet: ")) continue;
  const c = {};
  for (const m of s.matchAll(/fleet: (\d+) agent\(s\) [^\\"\n]*/g)) {
    const k = m[0].replace(/\s+$/, "");
    c[k] = (c[k] || 0) + 1;
  }
  census[f] = c;
}
console.log("=== fleet census values, by capture file ===");
for (const [f, c] of Object.entries(census)) console.log(" ", f, JSON.stringify(c));

// ── 2. every "smart account 0x…" ever seen, with which tenant said it and when ─
const EXTRA = [
  "0x5a67a2832b6c7598d9fb13990c8d3b5bfeb3e08b",
  "0x6ea1a0e1934e57d23ba9c8cc9d15b246224ce565",
  "0x10442368ea28a2f29608c9cddf8a048c05315742",
  "0xb06ccd65f3a0818ca15322ddec221c9802bcfbe8",
];
const hits = {};
for (const f of files) {
  let s;
  try {
    s = fs.readFileSync(path.join(DIR, f), "utf8");
  } catch {
    continue;
  }
  for (const a of EXTRA) {
    const re = new RegExp(a.slice(2), "gi");
    let n = 0;
    let ctx = null;
    for (const m of s.matchAll(re)) {
      n++;
      if (!ctx) ctx = s.slice(Math.max(0, m.index - 260), m.index + 60).replace(/\\n/g, "\n").split("\n").slice(-3).join(" | ");
    }
    if (n) (hits[a] ??= []).push({ file: f, n, ctx });
  }
}
console.log("\n=== the four historical smart accounts, wherever they appear ===");
for (const a of EXTRA) {
  console.log("\n", a);
  for (const h of hits[a] ?? []) console.log("   ", h.file, "x" + h.n, "\n      ", (h.ctx || "").slice(0, 400));
  if (!hits[a]) console.log("    (absent from every local capture)");
}
