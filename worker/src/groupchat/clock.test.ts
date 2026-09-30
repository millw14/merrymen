/**
 * Owner-local time is the whole reason an agent goes quiet at night instead of
 * at 23:00 UTC. These pin the three ways that silently goes wrong: a DST
 * transition read with a hand-computed offset, a half-hour zone rounded to the
 * hour, and a fleet whose sleep windows collapse onto one minute.
 *
 * Every instant is built with Date.UTC and every expectation is local wall
 * time, so the tests mean the same thing on a laptop in any zone and on hosted
 * (which runs in UTC).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalTz, fmtHm, isAsleep, localDay, localMinutes, phaseOf, sleepWindow } from "./clock";

const MIN = 60_000;
const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const hm = (h: number, m: number) => h * 60 + m;

// FROZEN WINDOWS. A change to the derivation silently moves every agent's
// quiet hours; if that is intended, update these on purpose.
const PINNED_ONE = { startMin: hm(22, 41), endMin: hm(6, 40) };
const PINNED_TENANT = { startMin: hm(23, 53), endMin: hm(5, 49) };

/** Deterministic tenant-shaped keys: what the conductor actually passes (lowercased 0x wallets). */
function tenants(n: number): string[] {
  let s = 0x2545f491;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let hex = "";
    while (hex.length < 40) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      hex += (s >>> 0).toString(16).padStart(8, "0");
    }
    out.push(`0x${hex.slice(0, 40)}`);
  }
  return out;
}

/** Circular distance between two local minutes. */
const circ = (a: number, b: number) => {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
};

/**
 * One instant per local minute of a DST-free day in `tz`, found by asking the
 * code under test rather than by adding an offset by hand.
 */
function instantsByLocalMinute(tz: string, fromMs: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let t = fromMs; out.size < 1440 && t < fromMs + 2 * 1440 * MIN; t += MIN) {
    const m = localMinutes(tz, t);
    if (m !== null && !out.has(m)) out.set(m, t);
  }
  assert.equal(out.size, 1440, `every local minute of ${tz} is reachable`);
  return out;
}

describe("canonicalTz", () => {
  it("accepts IANA zones, trims, and folds case", () => {
    assert.equal(canonicalTz("America/New_York"), "America/New_York");
    assert.equal(canonicalTz("  Europe/London\n"), "Europe/London");
    assert.equal(canonicalTz("america/new_york"), "America/New_York");
    assert.equal(canonicalTz("Etc/GMT+5"), "Etc/GMT+5");
    assert.equal(canonicalTz("America/Port-au-Prince"), "America/Port-au-Prince");
    assert.ok(canonicalTz("UTC"));
  });

  it("accepts aliases — Asia/Calcutta is still a real place", () => {
    const calcutta = canonicalTz("Asia/Calcutta");
    const kolkata = canonicalTz("Asia/Kolkata");
    assert.ok(calcutta, "the old name resolves");
    assert.ok(kolkata, "the new name resolves");
    // The spelling ICU returns differs by runtime; the wall clock does not.
    const t = utc(2026, 1, 1);
    assert.equal(localMinutes(calcutta, t), hm(5, 30));
    assert.equal(localMinutes(kolkata, t), hm(5, 30));
    assert.ok(canonicalTz("US/Eastern"));
  });

  it("is idempotent, so a stored zone survives a second pass through the gate", () => {
    for (const z of ["Asia/Calcutta", "asia/kolkata", "US/Eastern", "Europe/London", "Asia/Kathmandu", "utc", "Etc/UTC"]) {
      const once = canonicalTz(z);
      assert.ok(once, z);
      assert.equal(canonicalTz(once), once, z);
    }
  });

  it("rejects junk, injection and non-strings", () => {
    const junk: unknown[] = [
      "",
      "   ",
      "Mars/Olympus_Mons",
      "America/New York",
      "America/New_York; DROP TABLE groupchat_members;--",
      "'; DROP TABLE x; --",
      "<script>alert(1)</script>",
      "../../etc/passwd",
      "America\\New_York",
      "America/New_York\u0000",
      "‮America/New_York",
      "Аmerica/New_York", // Cyrillic А
      "${process.env.GROQ_API_KEY}",
      "{{7*7}}",
      "America%2FNew_York",
      "Etc/Unknown",
      "Z",
      "0",
      "A".repeat(65),
      `America/${"x".repeat(60)}`,
      null,
      undefined,
      42,
      true,
      {},
      ["UTC"],
      { toString: () => "UTC" },
    ];
    for (const j of junk) assert.equal(canonicalTz(j), null, JSON.stringify(String(j)));
  });

  it("refuses bare UTC offsets even though ICU resolves them", () => {
    // "+0530" → "+05:30" in V8: a fixed offset with no DST is not an IANA zone.
    for (const o of ["+05:30", "+0530", "+05", "-00", "-0800"]) {
      assert.equal(canonicalTz(o), null, o);
      assert.equal(localMinutes(o, utc(2026, 1, 1)), null, `${o} cannot drive a clock either`);
    }
  });

  it("stays correct past the formatter cache cap", () => {
    // 700 distinct case variants of one zone overflow the 512-entry cache.
    const base = "america/new_york";
    const letters = [...base].flatMap((c, i) => (/[a-z]/.test(c) ? [i] : []));
    const seen = new Set<string>();
    for (let i = 0; i < 700; i++) {
      const chars = [...base];
      letters.forEach((pos, b) => {
        if ((i >> b) & 1) chars[pos] = chars[pos]!.toUpperCase();
      });
      const v = chars.join("");
      seen.add(v);
      assert.equal(canonicalTz(v), "America/New_York", v);
    }
    assert.equal(seen.size, 700);
    assert.equal(localMinutes("America/New_York", utc(2026, 1, 1, 12)), hm(7, 0));
  });
});

describe("localMinutes", () => {
  it("New York spring-forward: 01:59 EST is followed by 03:00 EDT", () => {
    const tz = "America/New_York";
    // 2026-03-08 02:00 local (07:00Z) jumps to 03:00.
    assert.equal(localMinutes(tz, utc(2026, 3, 8, 6, 59)), hm(1, 59));
    assert.equal(localMinutes(tz, utc(2026, 3, 8, 7, 0)), hm(3, 0));
    for (let t = utc(2026, 3, 8, 5); t < utc(2026, 3, 8, 9); t += MIN) {
      const m = localMinutes(tz, t)!;
      assert.ok(m < hm(2, 0) || m >= hm(3, 0), "02:xx does not exist that night");
    }
  });

  it("New York fall-back: 01:30 happens twice, an hour apart", () => {
    const tz = "America/New_York";
    // 2026-11-01 02:00 EDT (06:00Z) falls back to 01:00 EST.
    assert.equal(localMinutes(tz, utc(2026, 11, 1, 5, 59)), hm(1, 59));
    assert.equal(localMinutes(tz, utc(2026, 11, 1, 6, 0)), hm(1, 0));
    assert.equal(localMinutes(tz, utc(2026, 11, 1, 5, 30)), hm(1, 30));
    assert.equal(localMinutes(tz, utc(2026, 11, 1, 6, 30)), hm(1, 30));
  });

  it("London spring-forward and fall-back", () => {
    const tz = "Europe/London";
    // 2026-03-29 01:00 GMT (01:00Z) jumps to 02:00 BST.
    assert.equal(localMinutes(tz, utc(2026, 3, 29, 0, 59)), hm(0, 59));
    assert.equal(localMinutes(tz, utc(2026, 3, 29, 1, 0)), hm(2, 0));
    // 2026-10-25 02:00 BST (01:00Z) falls back to 01:00 GMT.
    assert.equal(localMinutes(tz, utc(2026, 10, 25, 0, 59)), hm(1, 59));
    assert.equal(localMinutes(tz, utc(2026, 10, 25, 1, 0)), hm(1, 0));
    // Summer and winter noon UTC read an hour apart.
    assert.equal(localMinutes(tz, utc(2026, 7, 1, 12)), hm(13, 0));
    assert.equal(localMinutes(tz, utc(2026, 1, 15, 12)), hm(12, 0));
  });

  it("half- and three-quarter-hour zones keep their minutes", () => {
    const t = utc(2026, 1, 1);
    assert.equal(localMinutes("Asia/Kolkata", t), hm(5, 30));
    assert.equal(localMinutes("Asia/Kathmandu", t), hm(5, 45));
    assert.equal(localMinutes("Asia/Kolkata", utc(2025, 12, 31, 18, 29)), hm(23, 59));
    assert.equal(localMinutes("Asia/Kolkata", utc(2025, 12, 31, 18, 30)), 0, "midnight is 0, never 1440");
  });

  it("midnight reads as 0 in every zone, never 24:00", () => {
    assert.equal(localMinutes("UTC", utc(2026, 5, 5)), 0);
    assert.equal(localMinutes("America/New_York", utc(2026, 1, 1, 5)), 0);
  });

  it("an unusable zone or instant is null, never a guess", () => {
    assert.equal(localMinutes("Mars/Base", utc(2026, 1, 1)), null);
    assert.equal(localMinutes("", utc(2026, 1, 1)), null);
    assert.equal(localMinutes("UTC", Number.NaN), null);
    assert.equal(localMinutes("UTC", Number.POSITIVE_INFINITY), null);
    assert.equal(localMinutes("UTC", 1e20), null, "finite but past Date's range");
  });
});

describe("sleepWindow", () => {
  const keys = tenants(2000);

  it("both ends stay within ±75 minutes of 23:00 and 07:00", () => {
    for (const k of keys) {
      const w = sleepWindow(k);
      assert.ok(Number.isInteger(w.startMin) && w.startMin >= 0 && w.startMin < 1440, k);
      assert.ok(Number.isInteger(w.endMin) && w.endMin >= 0 && w.endMin < 1440, k);
      assert.ok(circ(w.startMin, hm(23, 0)) <= 75, `${k} start ${w.startMin}`);
      assert.ok(Math.abs(w.endMin - hm(7, 0)) <= 75, `${k} end ${w.endMin}`);
    }
  });

  it("is deterministic and case-blind in the tenant", () => {
    const k = keys[7]!;
    const w = sleepWindow(k);
    for (let i = 0; i < 5; i++) assert.deepEqual(sleepWindow(k), w);
    assert.deepEqual(sleepWindow(k.toUpperCase().replace("0X", "0x")), w, "a checksummed wallet is the same tenant");
    assert.deepEqual(sleepWindow(` ${k} `), w);
  });

  it("is pinned: changing the derivation moves every agent's quiet hours", () => {
    assert.deepEqual(sleepWindow("0x0000000000000000000000000000000000000001"), PINNED_ONE);
    assert.deepEqual(sleepWindow("tenant"), PINNED_TENANT);
  });

  it("spreads the fleet: many distinct windows, both extremes reached", () => {
    const starts = new Set<number>();
    const ends = new Set<number>();
    let pastMidnight = 0;
    let before2200 = 0;
    let wakeBefore6 = 0;
    let wakeAfter8 = 0;
    for (const k of keys) {
      const w = sleepWindow(k);
      starts.add(w.startMin);
      ends.add(w.endMin);
      if (w.startMin < 12 * 60) pastMidnight++;
      if (w.startMin >= 12 * 60 && w.startMin < hm(22, 0)) before2200++;
      if (w.endMin < hm(6, 0)) wakeBefore6++;
      if (w.endMin >= hm(8, 0)) wakeAfter8++;
    }
    assert.ok(starts.size >= 140, `distinct starts ${starts.size}/151`);
    assert.ok(ends.size >= 140, `distinct ends ${ends.size}/151`);
    for (const [name, n] of Object.entries({ pastMidnight, before2200, wakeBefore6, wakeAfter8 })) {
      assert.ok(n > 50, `${name}: ${n}`);
    }
  });

  it("spreads even sequential and vanity-shaped keys, not just random wallets", () => {
    for (const gen of [(i: number) => `tenant-${i}`, (i: number) => `0x${i.toString(16).padStart(40, "0")}`]) {
      const starts = new Set<number>();
      const ends = new Set<number>();
      for (let i = 0; i < 500; i++) {
        const w = sleepWindow(gen(i));
        starts.add(w.startMin);
        ends.add(w.endMin);
      }
      assert.ok(starts.size >= 120 && ends.size >= 120, `${gen(1)}: ${starts.size} starts, ${ends.size} ends of 151`);
    }
  });

  it("jitters the two ends independently", () => {
    const js: number[] = [];
    const je: number[] = [];
    let same = 0;
    for (const k of keys) {
      const w = sleepWindow(k);
      const s = ((w.startMin - hm(23, 0) + 720 + 1440) % 1440) - 720;
      const e = w.endMin - hm(7, 0);
      js.push(s);
      je.push(e);
      if (s === e) same++;
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const ms = mean(js);
    const me = mean(je);
    let cov = 0;
    let vs = 0;
    let ve = 0;
    for (let i = 0; i < js.length; i++) {
      cov += (js[i]! - ms) * (je[i]! - me);
      vs += (js[i]! - ms) ** 2;
      ve += (je[i]! - me) ** 2;
    }
    const r = cov / Math.sqrt(vs * ve);
    assert.ok(Math.abs(r) < 0.1, `correlation ${r.toFixed(3)}`);
    assert.ok(same < keys.length * 0.03, `identical jitter on ${same} keys`);
    assert.ok(Math.abs(ms) < 8 && Math.abs(me) < 8, `means ${ms.toFixed(1)} / ${me.toFixed(1)} stay centred`);
  });

  it("always leaves a sleep of 5.5 to 10.5 hours", () => {
    for (const k of keys) {
      const w = sleepWindow(k);
      const len = (w.endMin - w.startMin + 1440) % 1440;
      assert.ok(len >= 330 && len <= 630, `${k}: ${len}`);
    }
  });
});

describe("isAsleep", () => {
  const keys = tenants(60);

  it("an unknown zone never sleeps", () => {
    for (let m = 0; m < 1440; m += 7) {
      assert.equal(isAsleep(null, keys[0]!, utc(2026, 1, 1) + m * MIN), false);
      assert.equal(isAsleep("Not/AZone", keys[0]!, utc(2026, 1, 1) + m * MIN), false);
      assert.equal(isAsleep("+05:30", keys[0]!, utc(2026, 1, 1) + m * MIN), false);
    }
    assert.equal(isAsleep("UTC", keys[0]!, Number.NaN), false);
  });

  for (const tz of ["UTC", "Asia/Kolkata", "Asia/Kathmandu", "America/New_York"]) {
    it(`flips exactly at each key's own edges in ${tz}`, () => {
      const at = instantsByLocalMinute(tz, utc(2026, 1, 10));
      const w = (m: number) => at.get((m + 1440) % 1440)!;
      for (const k of keys) {
        const { startMin: s, endMin: e } = sleepWindow(k);
        assert.equal(isAsleep(tz, k, w(s - 1)), false, `${k} awake just before start`);
        assert.equal(isAsleep(tz, k, w(s)), true, `${k} asleep at start`);
        assert.equal(isAsleep(tz, k, w(s + 1)), true, `${k} asleep just after start`);
        assert.equal(isAsleep(tz, k, w(e - 1)), true, `${k} asleep just before end`);
        assert.equal(isAsleep(tz, k, w(e)), false, `${k} awake at end`);
        assert.equal(isAsleep(tz, k, w(e + 1)), false, `${k} awake just after end`);
      }
    });
  }

  it("matches the window minute-for-minute across a whole day, wrap included", () => {
    const day = utc(2026, 1, 10);
    for (const k of keys.slice(0, 20)) {
      const { startMin: s, endMin: e } = sleepWindow(k);
      const len = (e - s + 1440) % 1440;
      for (let m = 0; m < 1440; m++) {
        assert.equal(isAsleep("UTC", k, day + m * MIN), (m - s + 1440) % 1440 < len, `${k} @ ${fmtHm(m)}`);
      }
    }
  });

  it("handles a start pushed past midnight and one before it", () => {
    const all = tenants(2000);
    const late = all.find((k) => sleepWindow(k).startMin <= 15 && sleepWindow(k).startMin > 0);
    const early = all.find((k) => sleepWindow(k).startMin >= hm(22, 0) && sleepWindow(k).startMin < hm(23, 0));
    assert.ok(late && early, "the fleet has both kinds");
    const day = utc(2026, 1, 10);
    const at = (h: number, m: number) => day + hm(h, m) * MIN;
    const lateStart = sleepWindow(late).startMin;
    assert.equal(isAsleep("UTC", late, at(23, 59)), false, "a late sleeper is still up at 23:59");
    assert.equal(isAsleep("UTC", late, at(0, 0)), false, "and at midnight");
    assert.equal(isAsleep("UTC", late, day + lateStart * MIN), true);
    assert.equal(isAsleep("UTC", late, at(4, 0)), true);
    assert.equal(isAsleep("UTC", early, at(23, 59)), true);
    assert.equal(isAsleep("UTC", early, at(0, 0)), true, "the wrap past midnight holds");
    assert.equal(isAsleep("UTC", early, at(4, 0)), true);
    assert.equal(isAsleep("UTC", early, at(12, 0)), false);
  });

  it("the fleet winds down and wakes gradually, never all at once", () => {
    const all = tenants(500);
    const day = utc(2026, 1, 10);
    const asleepAt = (h: number, m: number) => all.filter((k) => isAsleep("UTC", k, day + hm(h, m) * MIN)).length;
    assert.equal(asleepAt(21, 44), 0, "nobody before 21:45");
    const at2300 = asleepAt(23, 0);
    assert.ok(at2300 > 100 && at2300 < 400, `about half asleep at 23:00 (${at2300})`);
    assert.equal(asleepAt(0, 16), all.length, "everyone by 00:16");
    assert.equal(asleepAt(5, 44), all.length, "everyone still at 05:44");
    const at0700 = asleepAt(7, 0);
    assert.ok(at0700 > 100 && at0700 < 400, `about half still asleep at 07:00 (${at0700})`);
    assert.equal(asleepAt(8, 15), 0, "nobody after 08:15");
  });

  it("sleeps straight through both DST transitions in New York", () => {
    const tz = "America/New_York";
    for (const k of keys) {
      // Spring: 01:59 EST then 03:00 EDT.
      assert.equal(isAsleep(tz, k, utc(2026, 3, 8, 6, 59)), true, k);
      assert.equal(isAsleep(tz, k, utc(2026, 3, 8, 7, 0)), true, k);
      // Autumn: 01:30 EDT and, an hour later, 01:30 EST.
      assert.equal(isAsleep(tz, k, utc(2026, 11, 1, 5, 30)), true, k);
      assert.equal(isAsleep(tz, k, utc(2026, 11, 1, 6, 30)), true, k);
      // Noon either side of each transition is awake.
      assert.equal(isAsleep(tz, k, utc(2026, 3, 8, 16)), false, k);
      assert.equal(isAsleep(tz, k, utc(2026, 11, 1, 17)), false, k);
    }
  });

  it("follows the owner's zone, not UTC", () => {
    const k = keys[3]!;
    const { startMin } = sleepWindow(k);
    const tokyo = instantsByLocalMinute("Asia/Tokyo", utc(2026, 1, 10));
    const t = tokyo.get((startMin + 30) % 1440)!;
    assert.equal(isAsleep("Asia/Tokyo", k, t), true);
    assert.equal(isAsleep("UTC", k, t), false, "the same instant is mid-afternoon in UTC");
  });
});

describe("localDay", () => {
  it("flips at local midnight, not UTC midnight", () => {
    const ny = "America/New_York";
    assert.equal(localDay(ny, utc(2026, 1, 2, 0, 0)), "2026-01-01", "UTC midnight is 19:00 the day before");
    assert.equal(localDay(ny, utc(2026, 1, 2, 4, 59)), "2026-01-01");
    assert.equal(localDay(ny, utc(2026, 1, 2, 5, 0)), "2026-01-02");
    // In summer the flip moves an hour earlier, with the offset.
    assert.equal(localDay(ny, utc(2026, 7, 2, 3, 59)), "2026-07-01");
    assert.equal(localDay(ny, utc(2026, 7, 2, 4, 0)), "2026-07-02");
    assert.equal(localDay("Asia/Tokyo", utc(2026, 1, 1, 14, 59)), "2026-01-01");
    assert.equal(localDay("Asia/Tokyo", utc(2026, 1, 1, 15, 0)), "2026-01-02");
    assert.equal(localDay("Asia/Kolkata", utc(2026, 1, 1, 18, 29)), "2026-01-01");
    assert.equal(localDay("Asia/Kolkata", utc(2026, 1, 1, 18, 30)), "2026-01-02");
    assert.equal(localDay("Europe/London", utc(2026, 7, 1, 22, 59)), "2026-07-01");
    assert.equal(localDay("Europe/London", utc(2026, 7, 1, 23, 0)), "2026-07-02", "BST midnight is 23:00Z");
  });

  it("does not flip across a DST transition", () => {
    assert.equal(localDay("America/New_York", utc(2026, 11, 1, 5, 30)), "2026-11-01");
    assert.equal(localDay("America/New_York", utc(2026, 11, 1, 6, 30)), "2026-11-01");
    assert.equal(localDay("America/New_York", utc(2026, 3, 8, 7, 0)), "2026-03-08");
  });

  it("is UTC when the zone is unknown or unusable", () => {
    assert.equal(localDay(null, utc(2026, 1, 1, 23, 59)), "2026-01-01");
    assert.equal(localDay(null, utc(2026, 1, 2, 0, 0)), "2026-01-02");
    assert.equal(localDay("Not/AZone", utc(2026, 1, 2, 0, 0)), "2026-01-02");
    assert.equal(localDay("+05:30", utc(2026, 1, 1, 20, 0)), "2026-01-01");
  });

  it("zero-pads and never throws on a bad instant", () => {
    assert.equal(localDay("UTC", utc(2026, 3, 5, 12)), "2026-03-05");
    assert.equal(localDay("UTC", Number.NaN), "0000-00-00");
  });
});

describe("phaseOf", () => {
  it("buckets local time at the documented edges", () => {
    const day = utc(2026, 1, 10);
    const cases: [number, number, string][] = [
      [0, 0, "night"],
      [4, 59, "night"],
      [5, 0, "morning"],
      [11, 59, "morning"],
      [12, 0, "day"],
      [16, 59, "day"],
      [17, 0, "evening"],
      [21, 59, "evening"],
      [22, 0, "night"],
      [23, 59, "night"],
    ];
    for (const [h, m, want] of cases) assert.equal(phaseOf("UTC", day + hm(h, m) * MIN), want, `${h}:${m}`);
  });

  it("reads the owner's zone", () => {
    const t = utc(2026, 1, 1, 0, 0);
    assert.equal(phaseOf("UTC", t), "night");
    assert.equal(phaseOf("Asia/Kolkata", t), "morning", "05:30 in Kolkata");
    assert.equal(phaseOf("America/Los_Angeles", t), "day", "16:00 the day before");
  });

  it("is null when the zone is unknown", () => {
    assert.equal(phaseOf(null, utc(2026, 1, 1)), null);
    assert.equal(phaseOf("Not/AZone", utc(2026, 1, 1)), null);
    assert.equal(phaseOf("UTC", Number.NaN), null);
  });
});

describe("fmtHm", () => {
  it("formats local minutes as HH:MM", () => {
    assert.equal(fmtHm(425), "07:05");
    assert.equal(fmtHm(0), "00:00");
    assert.equal(fmtHm(60), "01:00");
    assert.equal(fmtHm(1380), "23:00");
    assert.equal(fmtHm(1439), "23:59");
  });

  it("wraps into one day and never prints a fake time", () => {
    assert.equal(fmtHm(1440), "00:00");
    assert.equal(fmtHm(1455), "00:15");
    assert.equal(fmtHm(-1), "23:59");
    assert.equal(fmtHm(7.9), "00:07");
    assert.equal(fmtHm(Number.NaN), "--:--");
  });

  it("renders every window the screen will show", () => {
    for (const k of tenants(200)) {
      const w = sleepWindow(k);
      assert.match(fmtHm(w.startMin), /^(2[1-3]|00):[0-5]\d$/);
      assert.match(fmtHm(w.endMin), /^0[5-8]:[0-5]\d$/);
    }
  });
});
