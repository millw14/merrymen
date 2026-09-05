/**
 * What the phase actually buys, derived from the measured cold start rather
 * than from a model.
 *
 * MEASURED (2026-09-03T02:34Z deploy, 22 first-tick [rpc:read] summaries):
 *   1,495 calls in 13.12s  = 114 calls/s fleet-wide
 *   617 arm + 878 first tick; 108 rate-limited (107 on eth_call, 1 on eth_blockNumber)
 *   sustained fleet rate over the same deployment: 8.08 calls/s
 *
 * THE ONE ASSUMPTION, stated: a child's cold start occupies a window of W
 * seconds, and the fleet's instantaneous call rate is the sum of the rates of
 * the children whose windows overlap. Then the peak fleet rate is
 * (children overlapping) x (one child's rate), and "children overlapping" is
 * exactly maxInWindow(offsets, W) — which is measured on the real offsets, not
 * assumed. Today every offset is 0, so all 22 overlap.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tickOffsetMs } from "./tick-phase.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TENANTS = readFileSync(path.join(HERE, "tenants.txt"), "utf8")
  .split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean);

const TICK = 240;
const P = TICK * 1000;
const MEASURED_PEAK = 114.0;   // calls/s, whole fleet, cold start
const SUSTAINED = 8.08;        // calls/s, whole fleet, steady state
const N = TENANTS.length;

const offs = TENANTS.map((t) => tickOffsetMs(t, TICK));

function maxInWindow(o, w) {
  let best = 0;
  for (const a of o) {
    let n = 0;
    for (const b of o) if (((b - a) % P + P) % P < w) n++;
    if (n > best) best = n;
  }
  return best;
}

console.log(`Cold-start burst, measured today vs derived under the phase\n`);
console.log(`  measured fleet peak        ${MEASURED_PEAK.toFixed(1)} calls/s  (${(MEASURED_PEAK / SUSTAINED).toFixed(1)}x sustained)`);
console.log(`  one child's share          ${(MEASURED_PEAK / N).toFixed(2)} calls/s\n`);

const rows = [];
for (const Wsec of [4, 6, 8, 10, 13, 20, 30]) {
  const overlap = maxInWindow(offs, Wsec * 1000);
  const peak = (MEASURED_PEAK / N) * overlap;
  rows.push({
    "child cold-start window": `${Wsec}s`,
    "children overlapping (today)": N,
    "children overlapping (phased)": overlap,
    "fleet peak calls/s": +peak.toFixed(1),
    "x sustained": +(peak / SUSTAINED).toFixed(2),
    reduction: `${(N / overlap).toFixed(1)}x`,
  });
}
console.table(rows);

console.log(
  `\nThe 13.12s figure is the whole fleet's burst, so a single child's own cold\n` +
    `start is shorter than that; 6-10s is the defensible range and every row in it\n` +
    `lands the deploy peak between ${((MEASURED_PEAK / N) * maxInWindow(offs, 6000)).toFixed(0)} and ` +
    `${((MEASURED_PEAK / N) * maxInWindow(offs, 10000)).toFixed(0)} calls/s — i.e. between ` +
    `${(((MEASURED_PEAK / N) * maxInWindow(offs, 6000)) / SUSTAINED).toFixed(1)}x and ` +
    `${(((MEASURED_PEAK / N) * maxInWindow(offs, 10000)) / SUSTAINED).toFixed(1)}x sustained,\n` +
    `against 14.1x today. The deploy stops being the fleet's worst RPC moment.`,
);

// ── the cost side, stated with the same rigour ─────────────────────────
console.log(`\nWhat it costs: delay to first arm/first trade after a deploy.`);
console.log(
  `  The wait is msUntilNextSlot(), which is uniform in (0, ${TICK}s] because a deploy\n` +
    `  lands at an arbitrary point on the grid. So per deploy, per tenant:\n` +
    `    worst case  ${TICK}s   (one full period, for any tenant, not just the last)\n` +
    `    mean        ${TICK / 2}s\n` +
    `  Today every child arms at t≈0. Under the phase they arm spread across one\n` +
    `  period — first at ~0s, last at ≤${TICK}s. Nothing is delayed twice: the offset is\n` +
    `  a phase, not a per-tick penalty.`,
);

// steady state: is the tick burst spread too, not just the deploy?
console.log(`\nSteady state (every tick, not just the deploy):`);
console.log(
  `  today   phases are whatever drift left them — measured 6.1s of spread after a\n` +
    `          deploy, ~57s after nine hours, and a deploy resets it to 3ms.\n` +
    `  phased  permanently spread across all ${TICK}s: max ${maxInWindow(offs, 8000)} children in any 8s window,\n` +
    `          largest hole ${(() => { const s=[...offs].sort((a,b)=>a-b); let g=P-s[s.length-1]+s[0]; for(let i=0;i+1<s.length;i++) g=Math.max(g,s[i+1]-s[i]); return (g/1000).toFixed(1); })()}s, and it does not decay because the grid is absolute.`,
);
