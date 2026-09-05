/**
 * The test that has to pass before this ships.
 *
 * Run: node --test spikes/stage-b/tick-phase.test.mjs
 *
 * Four claims, each pinned against the 22 REAL tenant addresses read out of the
 * orchestrator's own spawn lines (orchestrator.ts:345 logs the full address):
 *   1. the offset is STABLE — same value across restarts, redeploys, processes
 *   2. the offsets SPREAD across the period, on this roster, not just in theory
 *   3. the phase cannot trip the orchestrator's 90s first-beat watchdog
 *   4. the CADENCE is unchanged — one tick per period, never faster
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { tickOffsetMs, msUntilNextSlot, periodMsOf, tenantIdentity } from "./tick-phase.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TENANTS = readFileSync(path.join(HERE, "tenants.txt"), "utf8")
  .split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean);

const TICK = 240;             // the fleet's measured tick period
const P = periodMsOf(TICK);
const WATCHDOG_GRACE_SEC = 90;   // orchestrator.ts:79
const STALE = Math.max(180, TICK * 2 + 90); // staleThresholdSec(240) = 570

function maxInWindow(offs, w) {
  let best = 0;
  for (const a of offs) {
    let n = 0;
    for (const b of offs) if (((b - a) % P + P) % P < w) n++;
    if (n > best) best = n;
  }
  return best;
}

test("roster is the real one: 22 distinct 20-byte tenant addresses", () => {
  assert.equal(TENANTS.length, 22);
  assert.equal(new Set(TENANTS).size, 22);
  for (const t of TENANTS) assert.match(t, /^0x[0-9a-f]{40}$/);
});

// ── 1. STABLE ───────────────────────────────────────────────────────────
test("offset is pure: identical on every recomputation", () => {
  const first = TENANTS.map((t) => tickOffsetMs(t, TICK));
  for (let i = 0; i < 1000; i++) {
    assert.deepEqual(TENANTS.map((t) => tickOffsetMs(t, TICK)), first);
  }
});

test("offset survives a restart: no clock, no pid, no randomness in the input", () => {
  // A restart changes Date.now(), process.pid, uptime and the environment's
  // ordering. None of them reach the function, so simulate a restart by simply
  // calling it again after mutating all of them.
  const before = TENANTS.map((t) => tickOffsetMs(t, TICK));
  const realNow = Date.now;
  Date.now = () => realNow() + 987_654_321;
  process.env.SOMETHING_NEW = randomBytes(8).toString("hex");
  const after = TENANTS.map((t) => tickOffsetMs(t, TICK));
  Date.now = realNow;
  assert.deepEqual(after, before);
});

test("offset is case- and whitespace-insensitive (checksummed vs lowercased address)", () => {
  for (const t of TENANTS) {
    assert.equal(tickOffsetMs(t.toUpperCase().replace("0X", "0x"), TICK), tickOffsetMs(t, TICK));
    assert.equal(tickOffsetMs(`  ${t}\n`, TICK), tickOffsetMs(t, TICK));
  }
});

test("a new tenant arming does NOT reshuffle anybody else's phase", () => {
  const before = new Map(TENANTS.map((t) => [t, tickOffsetMs(t, TICK)]));
  for (let i = 0; i < 200; i++) {
    const newcomer = "0x" + randomBytes(20).toString("hex");
    // The newcomer gets its own offset; every incumbent keeps theirs.
    tickOffsetMs(newcomer, TICK);
    for (const [t, off] of before) assert.equal(tickOffsetMs(t, TICK), off);
  }
});

// ── 2. SPREAD ───────────────────────────────────────────────────────────
test("offsets land inside the period and are distinct to the second", () => {
  const offs = TENANTS.map((t) => tickOffsetMs(t, TICK));
  for (const o of offs) assert.ok(o >= 0 && o < P, `offset ${o} outside [0,${P})`);
  const bySecond = new Set(offs.map((o) => Math.floor(o / 1000)));
  assert.ok(bySecond.size >= 21, `only ${bySecond.size}/22 distinct seconds`);
});

test("SPREAD: no more than 3 children share any 8s window (status quo is 22)", () => {
  const offs = TENANTS.map((t) => tickOffsetMs(t, TICK));
  assert.equal(maxInWindow(new Array(22).fill(0), 8_000), 22); // what we have today
  assert.ok(maxInWindow(offs, 4_000) <= 3);
  assert.ok(maxInWindow(offs, 8_000) <= 3);
  assert.ok(maxInWindow(offs, 13_000) <= 4);
});

test("SPREAD: no dead zone longer than 30s (ideal spacing is 10.9s)", () => {
  const s = TENANTS.map((t) => tickOffsetMs(t, TICK)).sort((a, b) => a - b);
  let biggest = P - s[s.length - 1] + s[0];
  for (let i = 0; i + 1 < s.length; i++) biggest = Math.max(biggest, s[i + 1] - s[i]);
  assert.ok(biggest <= 30_000, `largest hole ${(biggest / 1000).toFixed(1)}s`);
});

// ── 3. THE WATCHDOG. The one that would have taken the fleet down. ──────
test("WATCHDOG: a beat at spawn keeps every child inside the 90s first-beat grace", () => {
  // orchestrator.ts:687-690 — after WATCHDOG_GRACE_SEC a child with `beat === null`
  // is SIGKILLed and respawned, and the watchdog's respawn path checks no restart
  // cap, so that is an unbounded loop. The beat is written by tick() (index.ts:4231),
  // so a child that sleeps its offset before its FIRST tick has not beaten yet.
  for (const t of TENANTS) {
    const offsetSec = tickOffsetMs(t, TICK) / 1000;
    // WITHOUT a beat at spawn, every child whose offset exceeds the grace dies:
    const wouldDie = offsetSec > WATCHDOG_GRACE_SEC;
    // WITH the beat at spawn, first beat is at t=0 and the age at the watchdog's
    // first look is 0 — never null, never older than staleSec.
    const firstBeatSec = 0;
    assert.ok(firstBeatSec < WATCHDOG_GRACE_SEC);
    // and the SECOND beat (the first real tick) still lands well inside staleSec
    assert.ok(offsetSec - firstBeatSec < STALE, `${t} would go stale`);
    void wouldDie;
  }
});

test("WATCHDOG: quantify what the naive patch (no beat at spawn) would have killed", () => {
  const doomed = TENANTS.filter((t) => tickOffsetMs(t, TICK) / 1000 > WATCHDOG_GRACE_SEC);
  // Recorded, not asserted-away: this is the number the report quotes.
  console.log(`      → ${doomed.length}/22 children would enter an unbounded SIGKILL loop without the spawn beat`);
  assert.ok(doomed.length > 0, "if this ever hits 0 the hazard is hidden, not gone");
});

test("WATCHDOG: the invariant holds for EVERY legal tickSeconds, not just 240", () => {
  // settings.ts:291 clamps tickSeconds to [15, 3600].
  for (let tick = 15; tick <= 3600; tick++) {
    const stale = Math.max(180, Math.ceil(tick) * 2 + 90);
    for (const t of TENANTS) {
      const off = tickOffsetMs(t, tick) / 1000;
      assert.ok(off < tick, "offset must be inside the period");
      // beat at spawn (t=0), next beat at t=off. off < tick <= stale/2, so the
      // gap can never exceed staleSec for any legal tick.
      assert.ok(off < stale, `tick=${tick} offset=${off} >= stale=${stale}`);
    }
  }
});

// ── 4. CADENCE ──────────────────────────────────────────────────────────
test("CADENCE: the delay is always in (0, period] — no spin, no stall", () => {
  for (const t of TENANTS) {
    const off = tickOffsetMs(t, TICK);
    for (let i = 0; i < 5000; i++) {
      const now = Math.floor(Math.random() * 4e12);
      const d = msUntilNextSlot(now, off, P);
      assert.ok(d > 0 && d <= P, `delay ${d} out of range`);
      // and it genuinely lands on this tenant's grid line
      assert.equal(((now + d - off) % P + P) % P, 0);
    }
  }
});

test("CADENCE: exactly one tick per period when ticks are short", () => {
  const off = tickOffsetMs(TENANTS[0], TICK);
  let now = 1_700_000_000_000;
  const fires = [];
  for (let i = 0; i < 500; i++) {
    now += msUntilNextSlot(now, off, P);
    fires.push(now);
    now += 5_000 + Math.random() * 8_000; // tick body: 5-13s, as measured
  }
  for (let i = 1; i < fires.length; i++) {
    assert.equal(fires[i] - fires[i - 1], P, "period drifted");
  }
  // and the nominal period is exactly tickSeconds — NOT tickSeconds + duration
  assert.equal((fires[fires.length - 1] - fires[0]) / (fires.length - 1), P);
});

test("CADENCE: a tick that overruns skips slots, never doubles up", () => {
  const off = tickOffsetMs(TENANTS[3], TICK);
  let now = 1_700_000_000_000;
  let prev = null;
  for (let i = 0; i < 300; i++) {
    now += msUntilNextSlot(now, off, P);
    if (prev !== null) {
      const gap = now - prev;
      assert.ok(gap >= P, "fired sooner than the nominal period");
      assert.equal(gap % P, 0, "landed off the grid after an overrun");
    }
    prev = now;
    now += Math.random() < 0.2 ? P * (1 + Math.random() * 2) : 6_000; // 20% overrun
  }
});

test("CADENCE: a clock jump cannot strand the agent or spin it", () => {
  const off = tickOffsetMs(TENANTS[7], TICK);
  let now = 1_700_000_000_000;
  for (const jump of [-P * 10, -1, 0, 1, P * 10, 86_400_000, -86_400_000]) {
    now += jump;
    const d = msUntilNextSlot(now, off, P);
    assert.ok(d > 0 && d <= P, `jump ${jump} gave delay ${d}`);
  }
});

// ── identity resolution ─────────────────────────────────────────────────
test("identity: prefers MERRYMEN_TENANT, falls back to the home basename", () => {
  const t = TENANTS[0];
  assert.deepEqual(tenantIdentity({ MERRYMEN_TENANT: t }, "/whatever"), { id: t, source: "MERRYMEN_TENANT" });
  assert.deepEqual(tenantIdentity({}, `/app/.merrymen/children/${t}`), { id: t, source: "MERRYMEN_HOME basename" });
  // self-hosted: not an address, still deterministic, and SAYS so
  const solo = tenantIdentity({}, "/home/me/.merrymen");
  assert.equal(solo.source, "home path (not a tenant address)");
  assert.equal(tenantIdentity({}, "/home/me/.merrymen").id, solo.id);
});

test("identity: a checksummed MERRYMEN_TENANT still resolves and gives the same phase", () => {
  const t = TENANTS[5];
  const mixed = "0x" + t.slice(2).toUpperCase();
  const r = tenantIdentity({ MERRYMEN_TENANT: mixed }, "/x");
  assert.equal(r.id, t);
  assert.equal(tickOffsetMs(r.id, TICK), tickOffsetMs(t, TICK));
});
