import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const D = (xs) => `n=${xs.length} min ${Math.min(...xs)} · med ${pct(xs, 50)} · p90 ${pct(xs, 90)} · max ${Math.max(...xs)}`;

const main = d.runs.filter((r) => r.tag === "main");
console.log("=== PHASE 1: full mode, per pair x size ===");
const bykey = new Map();
for (const r of main) {
  const k = `${r.pair} ${r.sizeLabel}`;
  if (!bykey.has(k)) bykey.set(k, []);
  bykey.get(k).push(r);
}
for (const [k, rs] of bykey) {
  const b = rs[0].buckets;
  console.log(
    `${k.padEnd(22)} meterCalls ${D(rs.map((r) => r.meterCalls))} | wire ${D(rs.map((r) => r.wirePosts))} | ms ${D(rs.map((r) => r.ms))} | quoted=${rs.filter((r) => r.quoted).length}/${rs.length} ${rs[0].quoteKind} | buckets ${JSON.stringify(b)}`,
  );
}
console.log("\n=== PHASE 1 aggregate ===");
console.log("meterCalls per bestRoute:", D(main.map((r) => r.meterCalls)));
console.log("wire POSTs per bestRoute:", D(main.map((r) => r.wirePosts)));
console.log("latency per bestRoute ms:", D(main.map((r) => r.ms)));
console.log("peak in-flight, 1 bestRoute:", D(main.map((r) => r.meterPeak)));
const allCall = main.flatMap((r) => r.callMs);
console.log("latency per CALL ms:", D(allCall), " mean", (allCall.reduce((a, b) => a + b, 0) / allCall.length).toFixed(0));
const sumB = {};
for (const r of main) for (const [k, v] of Object.entries(r.buckets)) sumB[k] = (sumB[k] ?? 0) + v;
console.log("bucket totals:", JSON.stringify(sumB));
const v3 = (sumB["v3-direct"] ?? 0) + (sumB["v3-hop"] ?? 0);
const v4 = (sumB["v4-slot0"] ?? 0) + (sumB["v4-liquidity"] ?? 0) + (sumB["v4-quote"] ?? 0);
console.log(`v3 total ${v3} (${((100 * v3) / (v3 + v4)).toFixed(1)}%) vs v4 total ${v4} (${((100 * v4) / (v3 + v4)).toFixed(1)}%)`);
const amp = main.reduce((a, r) => a + r.wirePosts, 0) / main.reduce((a, r) => a + r.meterCalls, 0);
console.log(`wire/meter amplification on the real endpoint: ${amp.toFixed(4)}x`);
console.log("runs where wire > meter (real retries):", main.filter((r) => r.wirePosts > r.meterCalls).map((r) => `${r.pair} ${r.sizeLabel} +${r.wirePosts - r.meterCalls}`).join(", ") || "none");

console.log("\n=== PHASE 2: shapes ===");
for (const mode of ["direct-only", "hop-no-v4", "v4-only"]) {
  const rs = d.runs.filter((r) => r.tag === "shape" && r.mode === mode);
  const byp = new Map();
  for (const r of rs) { if (!byp.has(r.pair)) byp.set(r.pair, []); byp.get(r.pair).push(r); }
  for (const [p, g] of byp) console.log(`${mode.padEnd(12)} ${p.padEnd(12)} calls ${D(g.map((r) => r.meterCalls))} ms ${D(g.map((r) => r.ms))} quoted ${g.filter((r) => r.quoted).length}/${g.length} peak ${g[0].meterPeak}`);
}

console.log("\n=== PHASE 3: v4Keys marginal ===");
for (const mode of ["keys:0", "keys:1-hookless", "keys:2-hookless", "keys:1-hooked"]) {
  const rs = d.runs.filter((r) => r.tag === "v4keys" && r.mode === mode);
  console.log(`${mode.padEnd(16)} calls ${D(rs.map((r) => r.meterCalls))} v4quote ${rs.map((r) => r.buckets["v4-quote"] ?? 0).join(",")} ms ${D(rs.map((r) => r.ms))}`);
}

console.log("\n=== PHASE 4: concurrency ===");
const byn = new Map();
for (const c of d.conc) { if (!byn.has(c.n)) byn.set(c.n, []); byn.get(c.n).push(c); }
for (const [n, g] of byn) console.log(`n=${String(n).padStart(2)} peak ${D(g.map((x) => x.peak))} calls ${D(g.map((x) => x.calls))} wall ${D(g.map((x) => x.wallMs))} ms  -> peak/n = ${g[0].peak / n}`);

console.log("\n=== PHASE 5: 429 ===");
const byf = new Map();
for (const r of d.rl) { if (!byf.has(r.frac)) byf.set(r.frac, []); byf.get(r.frac).push(r); }
for (const [f, g] of byf) {
  const wire = g.map((x) => x.wire), inj = g.map((x) => x.injected);
  console.log(
    `frac ${f}: meterCalls ${D(g.map((x) => x.meterCalls))} · meterErr ${D(g.map((x) => x.meterErr))} · meterRateLimited ${D(g.map((x) => x.meterRl))} · wire ${D(wire)} · injected ${D(inj)} · quoted ${g.filter((x) => x.quoted).length}/${g.length} · ms ${D(g.map((x) => x.ms))} · amp ${(g.reduce((a, x) => a + x.wire, 0) / g.reduce((a, x) => a + x.meterCalls, 0)).toFixed(2)}x`,
  );
}

console.log("\n=== PHASE 6: dedup ===");
console.log(JSON.stringify(d.dedup, null, 2).slice(0, 2000));

console.log("\n=== TOTAL WIRE ===");
console.log("serial runs:", d.runs.length, "wire:", d.runs.reduce((a, r) => a + r.wirePosts, 0));
console.log("concurrency phase wire:", d.conc.reduce((a, c) => a + c.wire, 0));
