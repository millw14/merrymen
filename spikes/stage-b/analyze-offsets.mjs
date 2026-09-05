/**
 * Does the offset function actually spread THIS fleet?
 *
 * Inputs are the 22 REAL tenant addresses, pulled read-only from
 *   railway logs --service orchestrator --lines 5000 --filter "spawned"
 * (orchestrator.ts:345 logs the FULL tenant address on every spawn).
 * They are the exact strings the child would hash in production, so the
 * offsets printed here are the production offsets, not a proxy.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HASHES, offsetMsFor } from "./offset.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tenants = readFileSync(path.join(HERE, "tenants.txt"), "utf8")
  .split(/\r?\n/)
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const PERIOD_SEC = Number(process.argv[2] ?? 240);
const P = PERIOD_SEC * 1000;

/** Max points inside any circular window of W ms. Windows anchored at points. */
function maxInWindow(offs, W) {
  let best = 0;
  for (const a of offs) {
    let n = 0;
    for (const b of offs) if (((b - a) % P + P) % P < W) n++;
    if (n > best) best = n;
  }
  return best;
}

function gaps(offs) {
  const s = [...offs].sort((x, y) => x - y);
  const g = [];
  for (let i = 0; i < s.length; i++) g.push(((s[(i + 1) % s.length] - s[i]) % P + P) % P);
  // the wrap gap for a single sorted pass
  if (s.length > 1) g[g.length - 1] = P - s[s.length - 1] + s[0];
  return g;
}

const WINDOWS = [4, 8, 13, 30].map((s) => s * 1000);
const N = tenants.length;
const IDEAL_GAP = P / N;

console.log(`fleet ${N} tenants · period ${PERIOD_SEC}s · ideal spacing ${(IDEAL_GAP / 1000).toFixed(3)}s\n`);

const rows = [];
for (const [name, h] of Object.entries(HASHES)) {
  const offs = tenants.map((t) => offsetMsFor(h, t, P));
  const uniqSec = new Set(offs.map((o) => Math.floor(o / 1000))).size;
  const g = gaps(offs);
  const row = {
    hash: name,
    minGap_s: +(Math.min(...g) / 1000).toFixed(2),
    maxGap_s: +(Math.max(...g) / 1000).toFixed(2),
    uniq_s: uniqSec,
  };
  for (const W of WINDOWS) row[`max_in_${W / 1000}s`] = maxInWindow(offs, W);
  rows.push(row);
}
// baselines
{
  const now = tenants.map(() => 0);
  const r = { hash: "STATUS QUO (all 0)", minGap_s: 0, maxGap_s: +(P / 1000).toFixed(2), uniq_s: 1 };
  for (const W of WINDOWS) r[`max_in_${W / 1000}s`] = maxInWindow(now, W);
  rows.push(r);
  const ideal = tenants.map((_, i) => Math.round(i * IDEAL_GAP));
  const r2 = { hash: "IDEAL (evenly spaced)", minGap_s: +(IDEAL_GAP / 1000).toFixed(2), maxGap_s: +(IDEAL_GAP / 1000).toFixed(2), uniq_s: N };
  for (const W of WINDOWS) r2[`max_in_${W / 1000}s`] = maxInWindow(ideal, W);
  rows.push(r2);
}
console.table(rows);

// ── the chosen hash, in full ────────────────────────────────────────────
const CHOSEN = "djb2";
const chosen = tenants
  .map((t) => ({ tenant: t, off_s: +(offsetMsFor(HASHES[CHOSEN], t, P) / 1000).toFixed(3) }))
  .sort((a, b) => a.off_s - b.off_s);
console.log(`\n${CHOSEN} — every tenant's permanent tick phase (seconds into the ${PERIOD_SEC}s grid):`);
console.table(chosen.map((r, i, arr) => ({
  tag: r.tenant.slice(0, 8),
  offset_s: r.off_s,
  gap_to_next_s: +(((i + 1 < arr.length ? arr[i + 1].off_s : arr[0].off_s + PERIOD_SEC) - r.off_s)).toFixed(3),
})));

// histogram, 20s buckets
const BUCKET = 20;
const nb = Math.ceil(PERIOD_SEC / BUCKET);
const hist = new Array(nb).fill(0);
for (const r of chosen) hist[Math.min(nb - 1, Math.floor(r.off_s / BUCKET))]++;
console.log(`\n${CHOSEN} histogram, ${BUCKET}s buckets (expected ${(N / nb).toFixed(2)}/bucket):`);
for (let i = 0; i < nb; i++) {
  console.log(
    `  [${String(i * BUCKET).padStart(3)}–${String((i + 1) * BUCKET).padStart(3)}) ${String(hist[i]).padStart(2)} ${"#".repeat(hist[i])}`,
  );
}
// chi-square goodness of fit vs uniform over the buckets
const exp = N / nb;
const chi2 = hist.reduce((a, o) => a + (o - exp) ** 2 / exp, 0);
console.log(`  chi-square = ${chi2.toFixed(2)} on ${nb - 1} df (uniform would average ${nb - 1})`);
