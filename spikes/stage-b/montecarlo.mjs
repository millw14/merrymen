/**
 * Is the clustering a HASH defect, or just what 22 uniform points on a circle
 * look like?
 *
 * If every candidate hash lands inside the distribution of "22 points drawn
 * uniformly at random", then choosing between them on the strength of today's
 * 22 tenants is choosing a lottery ticket that has already been drawn — it
 * says nothing about the 23rd tenant.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { HASHES, offsetMsFor } from "./offset.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tenants = readFileSync(path.join(HERE, "tenants.txt"), "utf8")
  .split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean);

const P = 240_000;
const W = 8_000;
const N = tenants.length;
const TRIALS = 200_000;

function maxInWindow(offs, w) {
  let best = 0;
  for (const a of offs) {
    let n = 0;
    for (const b of offs) if (((b - a) % P + P) % P < w) n++;
    if (n > best) best = n;
  }
  return best;
}
function maxGap(offs) {
  const s = [...offs].sort((x, y) => x - y);
  let g = P - s[s.length - 1] + s[0];
  for (let i = 0; i + 1 < s.length; i++) g = Math.max(g, s[i + 1] - s[i]);
  return g;
}

// ── the null distribution: N points uniform on [0,P) ────────────────────
const dist = new Map();
const gapSamples = [];
for (let t = 0; t < TRIALS; t++) {
  const offs = new Array(N);
  for (let i = 0; i < N; i++) offs[i] = Math.random() * P;
  const m = maxInWindow(offs, W);
  dist.set(m, (dist.get(m) ?? 0) + 1);
  if (t < 20_000) gapSamples.push(maxGap(offs));
}
const keys = [...dist.keys()].sort((a, b) => a - b);
console.log(`Null model: ${N} uniform points on a ${P / 1000}s circle, ${TRIALS.toLocaleString()} trials`);
console.log(`max children inside any ${W / 1000}s window:`);
let cum = 0;
for (const k of keys) {
  cum += dist.get(k);
  console.log(
    `  ${k}: ${((dist.get(k) / TRIALS) * 100).toFixed(2).padStart(6)}%   (cumulative ${((cum / TRIALS) * 100).toFixed(2).padStart(6)}%)`,
  );
}
gapSamples.sort((a, b) => a - b);
const q = (p) => (gapSamples[Math.floor(p * gapSamples.length)] / 1000).toFixed(1);
console.log(`largest empty gap: median ${q(0.5)}s · p90 ${q(0.9)}s · p99 ${q(0.99)}s (ideal would be ${(P / N / 1000).toFixed(1)}s)`);

// ── where each hash's REAL draw lands in that distribution ──────────────
console.log(`\nThe real fleet's draw, per hash:`);
const out = [];
for (const [name, h] of Object.entries(HASHES)) {
  const offs = tenants.map((t) => offsetMsFor(h, t, P));
  const m = maxInWindow(offs, W);
  let pct = 0;
  for (const k of keys) if (k <= m) pct += dist.get(k);
  out.push({
    hash: name,
    [`max_in_${W / 1000}s`]: m,
    percentile: `${((pct / TRIALS) * 100).toFixed(1)}%`,
    maxGap_s: +(maxGap(offs) / 1000).toFixed(1),
  });
}
console.table(out);

// ── does today's winner keep winning as the fleet grows? ────────────────
// Add k synthetic tenants (real-shaped random 20-byte addresses) and re-rank.
console.log(`\nDoes the hash that wins at n=22 keep winning as tenants arm?`);
const RUNS = 2000;
const wins = {};
for (const name of Object.keys(HASHES)) wins[name] = 0;
for (let r = 0; r < RUNS; r++) {
  const set = [...tenants, ...Array.from({ length: 6 }, () => "0x" + randomBytes(20).toString("hex"))];
  let best = Infinity;
  let bestName = null;
  for (const [name, h] of Object.entries(HASHES)) {
    if (name === "bytesum") continue;
    const m = maxInWindow(set.map((t) => offsetMsFor(h, t, P)), W);
    if (m < best) { best = m; bestName = name; }
  }
  wins[bestName]++;
}
console.log(`  with 6 more tenants armed, ${RUNS} random rosters — times each hash gave the best spread:`);
for (const [k, v] of Object.entries(wins)) if (v) console.log(`    ${k.padEnd(12)} ${((v / RUNS) * 100).toFixed(1)}%`);
