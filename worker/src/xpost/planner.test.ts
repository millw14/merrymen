/**
 * The cadence under a held clock: the intro first and alone, buys only fresh
 * and after consent, one per coin in three days, two a day, three posts a day,
 * three hours apart, a casual post at the account's own afternoon slot most
 * days, nothing while the owner sleeps — and the owner's local day, not the
 * server's, deciding what "a day" is.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUY_STALE_MS,
  CASUAL_MAX_PUSH_MS,
  GAP_MS,
  INTRO_DELAY_MS,
  MIN_LEAD_MS,
  buyKey,
  casualKey,
  coinOf,
  hash32,
  introKey,
  planPosts,
  sendDecision,
  type IntroRow,
  type PlanCall,
  type PlanClock,
  type PlanInput,
  type PlanIntent,
} from "./planner";
import type { XPost } from "./store";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 2026-09-28 00:00 UTC. */
const DAY0 = Date.UTC(2026, 8, 28);
const TENANT = `0x${"ab".repeat(20)}`;

/**
 * A HELD CLOCK: fixed-offset test zones and a plain 23:00–07:00 night, so
 * every boundary below is arithmetic. The production clock is the room's
 * (owner-local, DST-aware, per-agent night); the planner only asks it
 * questions.
 */
const OFFSETS: Record<string, number> = { "Test/Minus5": -5 * 60, "Test/Plus2": 2 * 60, UTC: 0 };
function localMs(tz: string | null, ms: number): number {
  return ms + (OFFSETS[tz ?? "UTC"] ?? 0) * MIN;
}
const clock: PlanClock = {
  localDay: (tz, ms) => new Date(localMs(tz, ms)).toISOString().slice(0, 10),
  localMinutes: (tz, ms) => {
    if (tz !== null && !(tz in OFFSETS)) return null;
    const d = new Date(localMs(tz, ms));
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  },
  isAsleep: (tz, _key, ms) => {
    if (tz === null) return false;
    const m = clock.localMinutes(tz, ms)!;
    return m >= 23 * 60 || m < 7 * 60;
  },
};

let nextId = 1;
function post(over: Partial<XPost>): XPost {
  return {
    id: nextId++,
    tenant: TENANT,
    xUserId: "111",
    kind: "buy",
    dedupeKey: `k${nextId}`,
    body: "a post",
    coin: null,
    decisionId: null,
    status: "posted",
    reason: null,
    createdAtMs: DAY0,
    dueAtMs: DAY0,
    sentAtMs: null,
    tweetId: null,
    updatedAtMs: DAY0,
    ...over,
  };
}

/** One intro row for this account's first hello (or the n-th redraft's key). */
function intro(status: XPost["status"], over: Partial<IntroRow> & { attempt?: number } = {}): IntroRow {
  const { attempt = 0, ...rest } = over;
  return { dedupeKey: introKey(TENANT, "111", attempt), status, reason: null, createdAtMs: DAY0, updatedAtMs: DAY0, ...rest };
}

function call(over: Partial<PlanCall>): PlanCall {
  return { decisionId: `d-${nextId++}`, side: "buy", symbol: "PEPE", name: "Pepe", paper: true, atSec: 0, ...over };
}

function input(over: Partial<PlanInput> = {}): PlanInput {
  const tenant = over.tenant ?? TENANT;
  return {
    tenant,
    account: { xUserId: "111", consentAtMs: DAY0 },
    tz: null,
    nowMs: DAY0 + 10 * HOUR,
    clock,
    // The hello went out long ago, for whichever owner this is.
    intros: [{ ...intro("posted"), dedupeKey: introKey(tenant, "111") }],
    posts: [],
    calls: [],
    perDay: 3,
    model: true,
    ...over,
  };
}

const kinds = (plan: PlanIntent[]) => plan.map((p) => p.kind);
const buys = (plan: PlanIntent[]) => plan.filter((p): p is Extract<PlanIntent, { kind: "buy" }> => p.kind === "buy");

// ── the intro ───────────────────────────────────────────────────────────────

describe("the intro comes first, and alone", () => {
  it("is planned once consent exists, ten minutes after it, and never sooner than ten minutes from now", () => {
    const now = DAY0 + 10 * HOUR;
    const fresh = planPosts(input({ intros: [], nowMs: now, account: { xUserId: "111", consentAtMs: now }, calls: [call({ atSec: (now - MIN) / 1000 })] }));
    assert.deepEqual(fresh, [{ kind: "intro", dedupeKey: `intro:${TENANT}:111`, attempt: 0, dueAtMs: now + INTRO_DELAY_MS }]);
    assert.equal(INTRO_DELAY_MS, 10 * MIN);
    const next = planPosts(input({ intros: [], nowMs: now, account: { xUserId: "111", consentAtMs: now - 2 * MIN } }));
    assert.equal(next[0]?.dueAtMs, now + MIN_LEAD_MS, "the next pass after consent still leaves the whole review window");
    const late = planPosts(input({ intros: [], nowMs: now, account: { xUserId: "111", consentAtMs: now - HOUR } }));
    assert.equal(late[0]?.dueAtMs, now + 10 * MIN, "a late pass (the owner consented at night) still shows it ten minutes before it goes");
    assert.equal(introKey(TENANT.toUpperCase(), "111"), `intro:${TENANT}:111`, "keyed by the lowercased owner");
  });

  it("holds everything else while it is scheduled or sending", () => {
    const now = DAY0 + 15 * HOUR;
    for (const status of ["scheduled", "sending"] as const) {
      assert.deepEqual(planPosts(input({ intros: [intro(status)], nowMs: now, calls: [call({ atSec: (now - MIN) / 1000 })] })), [], status);
    }
  });

  it("once it went out, the owner skipped it, or it may have gone out, the rest may follow", () => {
    const now = DAY0 + 10 * HOUR;
    const dealt: [XPost["status"], string | null][] = [
      ["posted", null],
      ["cancelled", "owner"],
      ["failed", "uncertain"],
      ["failed", "interrupted"],
      ["failed", "duplicate"],
      ["failed", "fault"],
    ];
    for (const [status, reason] of dealt) {
      assert.deepEqual(kinds(planPosts(input({ intros: [intro(status, { reason })], nowMs: now, calls: [call({ atSec: (now - MIN) / 1000 })] }))), ["buy"], `${status}/${reason}`);
    }
  });

  it("a hello that did not go out for a reason the owner did not choose is drafted again, never a coin post first", () => {
    const consent = DAY0 + 9 * HOUR;
    const now = DAY0 + 10 * HOUR;
    const account = { xUserId: "111", consentAtMs: consent };
    const fresh = [call({ atSec: (now - MIN) / 1000 })];
    const notOut: [XPost["status"], string | null][] = [
      ["cancelled", "turned-off"],
      ["cancelled", "disconnected"],
      ["cancelled", "revoked"],
      ["cancelled", "account-off"],
      ["skipped", "template:echo"],
      ["failed", "forbidden"],
      ["failed", "revoked"],
      ["failed", "gone"],
      ["failed", "invalid"],
    ];
    for (const [status, reason] of notOut) {
      // It ended before the owner consented again (switched off and on): drafted again at once, under a new key.
      const before = [intro(status, { reason, createdAtMs: consent - 20 * MIN, updatedAtMs: consent - 5 * MIN })];
      assert.deepEqual(planPosts(input({ account, intros: before, nowMs: now, calls: fresh })), [
        { kind: "intro", dedupeKey: `intro:${TENANT}:111:1`, attempt: 1, dueAtMs: now + MIN_LEAD_MS },
      ], `${status}/${reason}`);
      // It ended after this consent: nothing at all that day, the intro included…
      const after = [intro(status, { reason, createdAtMs: consent + MIN, updatedAtMs: consent + 11 * MIN })];
      assert.deepEqual(planPosts(input({ account, intros: after, nowMs: now, calls: fresh })), [], `${status}/${reason}: held today`);
      // …and the owner's next local day, a fresh hello first.
      const tomorrow = DAY0 + 24 * HOUR + 9 * HOUR;
      assert.deepEqual(kinds(planPosts(input({ account, intros: after, nowMs: tomorrow, calls: [call({ atSec: (tomorrow - MIN) / 1000 })] }))), ["intro"], `${status}/${reason}: tomorrow`);
    }
  });

  it("a reconnect counts as the owner acting again, like a new consent", () => {
    const consent = DAY0 + 9 * HOUR;
    const now = DAY0 + 10 * HOUR;
    const revoked = [intro("cancelled", { reason: "revoked", createdAtMs: consent + MIN, updatedAtMs: consent + 5 * MIN })];
    assert.deepEqual(planPosts(input({ account: { xUserId: "111", consentAtMs: consent }, intros: revoked, nowMs: now })), [], "same day, no new connection");
    const plan = planPosts(input({ account: { xUserId: "111", consentAtMs: consent, connectedAtMs: consent + 30 * MIN }, intros: revoked, nowMs: now }));
    assert.deepEqual(plan.map((p) => p.dedupeKey), [`intro:${TENANT}:111:1`]);
  });

  it("at most three hellos per consent; then nothing, until the owner acts again", () => {
    const consent = DAY0 + 9 * HOUR;
    const account = { xUserId: "111", consentAtMs: consent };
    const refused = [0, 1, 2].map((n) => intro("failed", { reason: "forbidden", attempt: n, createdAtMs: consent + n * 24 * HOUR + MIN, updatedAtMs: consent + n * 24 * HOUR + 11 * MIN }));
    const day4 = DAY0 + 3 * 24 * HOUR + 10 * HOUR;
    assert.deepEqual(planPosts(input({ account, intros: refused.slice(0, 2), nowMs: day4 })).map((p) => p.dedupeKey), [`intro:${TENANT}:111:2`], "the third try");
    assert.deepEqual(planPosts(input({ account, intros: refused, nowMs: day4, calls: [call({ atSec: (day4 - MIN) / 1000 })] })), [], "no fourth, and no coin post instead");
    const again = planPosts(input({ account: { xUserId: "111", consentAtMs: day4 - HOUR }, intros: refused, nowMs: day4 }));
    assert.deepEqual(again.map((p) => p.dedupeKey), [`intro:${TENANT}:111:3`], "a new consent is a new plan");
  });

  it("the historic key and every redraft's are one hello: another X account's intros are not this one's", () => {
    const now = DAY0 + 10 * HOUR;
    const redraftOut = [intro("cancelled", { reason: "turned-off" }), intro("posted", { attempt: 1 })];
    assert.deepEqual(kinds(planPosts(input({ intros: redraftOut, nowMs: now, calls: [call({ atSec: (now - MIN) / 1000 })] }))), ["buy"]);
    const other = [{ ...intro("posted"), dedupeKey: introKey(TENANT, "999") }];
    assert.deepEqual(kinds(planPosts(input({ intros: other, nowMs: now }))), ["intro"]);
  });

  it("nothing without consent, and nothing while the owner sleeps — the intro included", () => {
    assert.deepEqual(planPosts(input({ intros: [], account: { xUserId: "111", consentAtMs: null } })), []);
    const night = Date.UTC(2026, 8, 28, 5); // 00:00 in Test/Minus5
    assert.deepEqual(planPosts(input({ intros: [], tz: "Test/Minus5", nowMs: night })), []);
    assert.equal(planPosts(input({ intros: [], tz: "Test/Minus5", nowMs: night + 8 * HOUR })).length, 1, "morning");
    assert.equal(planPosts(input({ intros: [], tz: null, nowMs: night })).length, 1, "an unknown zone never sleeps");
  });

  it("without a model, only the intro", () => {
    const now = DAY0 + 16 * HOUR;
    assert.equal(planPosts(input({ intros: [], model: false })).length, 1);
    assert.deepEqual(planPosts(input({ model: false, nowMs: now, calls: [call({ atSec: (now - MIN) / 1000 })] })), []);
  });

  it("uses no clock of its own", () => {
    const real = Date.now;
    Date.now = () => {
      throw new Error("the planner read the process clock");
    };
    try {
      planPosts(input({ intros: [] }));
      planPosts(input({ nowMs: DAY0 + 16 * HOUR, calls: [call({ atSec: (DAY0 + 16 * HOUR - MIN) / 1000 })] }));
    } finally {
      Date.now = real;
    }
  });
});

// ── buys ────────────────────────────────────────────────────────────────────

describe("a buy post is about a fresh buy after consent, once", () => {
  const now = DAY0 + 10 * HOUR;
  const at = (msAgo: number) => (now - msAgo) / 1000;

  it("only a buy, made after consent, at most two hours ago", () => {
    const plan = planPosts(
      input({
        nowMs: now,
        account: { xUserId: "111", consentAtMs: now - 3 * HOUR },
        calls: [
          call({ decisionId: "sell", side: "sell", atSec: at(MIN), name: "Sold Coin" }),
          call({ decisionId: "before-consent", atSec: at(4 * HOUR), name: "Early Coin" }),
          call({ decisionId: "stale", atSec: at(2 * HOUR + MIN), name: "Stale Coin" }),
          call({ decisionId: "future", atSec: (now + MIN) / 1000, name: "Future Coin" }),
          call({ decisionId: "fresh", atSec: at(30 * MIN), name: "Fresh Coin" }),
        ],
      }),
    );
    assert.deepEqual(buys(plan).map((b) => b.dedupeKey), [buyKey("fresh")]);
    assert.equal(buys(plan)[0]?.coin, "Fresh Coin");
    assert.equal(buys(plan)[0]?.coinKey, "fresh coin");
  });

  it("goes out ten to forty minutes after the fill, by the decision's own hash, and never before ten minutes from now", () => {
    const fill = now;
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      const [b] = buys(planPosts(input({ nowMs: now, calls: [call({ decisionId: id, atSec: fill / 1000 })] })));
      const jitter = 10 + (hash32(`buy|${id}`) % 31);
      assert.equal(b?.dueAtMs, fill + jitter * MIN, id);
      assert.ok(b!.dueAtMs >= fill + 10 * MIN && b!.dueAtMs <= fill + 40 * MIN);
    }
    const [old] = buys(planPosts(input({ nowMs: now, calls: [call({ decisionId: "old", atSec: at(100 * MIN) })] })));
    assert.equal(old?.dueAtMs, now + 10 * MIN, "a fill found late still waits the whole review window");
    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const [b] = buys(planPosts(input({ nowMs: now, calls: [call({ decisionId: id, atSec: at(5 * MIN) })] })));
      assert.ok(b!.dueAtMs >= now + MIN_LEAD_MS, `${id}: a fill five minutes old is still due ten minutes after it is drafted`);
    }
  });

  it("never twice for one decision", () => {
    const c = call({ decisionId: "once", atSec: at(MIN) });
    const plan = planPosts(input({ nowMs: now, calls: [c], posts: [post({ dedupeKey: buyKey("once"), status: "skipped", kind: "buy" })] }));
    assert.deepEqual(plan, [], "a skipped key is spent too");
  });

  it("never names a coin by an address-derived id", () => {
    assert.equal(coinOf({ name: null, symbol: "T7631DACC21B" }), null);
    assert.equal(coinOf({ name: "Pepe 2", symbol: "T7631DACC21B" }), null);
    assert.equal(coinOf({ name: "pump.fun cat", symbol: null }), null);
    assert.deepEqual(coinOf({ name: "Pepe 2", symbol: "PEPE" }), { label: "PEPE", key: "pepe 2" });
    assert.deepEqual(coinOf({ name: "Moo Deng", symbol: "T7631DACC21B" }), { label: "Moo Deng", key: "moo deng" });
    assert.deepEqual(coinOf({ name: null, symbol: "TSLA" }), { label: "TSLA", key: "tsla" });
    assert.deepEqual(buys(planPosts(input({ nowMs: now, calls: [call({ name: null, symbol: "T7631DACC21B", atSec: at(MIN) })] }))), []);
  });

  it("one buy post per coin in three days", () => {
    const c = call({ decisionId: "again", name: "Pepe", atSec: at(MIN) });
    const recent = post({ kind: "buy", coin: "pepe", createdAtMs: now - 71 * HOUR, sentAtMs: now - 71 * HOUR });
    assert.deepEqual(planPosts(input({ nowMs: now, calls: [c], posts: [recent] })), []);
    const older = post({ kind: "buy", coin: "pepe", createdAtMs: now - 73 * HOUR, sentAtMs: now - 73 * HOUR });
    assert.equal(buys(planPosts(input({ nowMs: now, calls: [c], posts: [older] }))).length, 1);
    const refused = post({ kind: "buy", coin: "pepe", createdAtMs: now - HOUR, status: "skipped" });
    assert.equal(buys(planPosts(input({ nowMs: now, calls: [c], posts: [refused] }))).length, 1, "a draft that never went out does not fold the coin");
  });

  it("two buy posts a day at most, counting the ones planned in the same pass", () => {
    const plan = planPosts(
      input({
        nowMs: now,
        perDay: 10,
        calls: [call({ name: "Alpha", atSec: at(3 * MIN) }), call({ name: "Beta", atSec: at(2 * MIN) }), call({ name: "Gamma", atSec: at(MIN) })],
      }),
    );
    assert.deepEqual(buys(plan).map((b) => b.coin), ["Alpha", "Beta"]);
    const two = [post({ kind: "buy", coin: "x", sentAtMs: now - 5 * HOUR }), post({ kind: "buy", coin: "y", sentAtMs: now - 9 * HOUR })];
    assert.deepEqual(planPosts(input({ nowMs: now, perDay: 10, posts: two, calls: [call({ name: "Delta", atSec: at(MIN) })] })), []);
  });

  it("three hours apart, by pushing later — and a buy that cannot go within eight hours of its fill is not planned", () => {
    const fill = now - MIN;
    const c = call({ decisionId: "gap", atSec: fill / 1000 });
    const jitter = 10 + (hash32("buy|gap") % 31);
    const casual = post({ kind: "casual", status: "scheduled", dueAtMs: fill + jitter * MIN + HOUR });
    const [b] = buys(planPosts(input({ nowMs: now, calls: [c], posts: [casual] })));
    assert.equal(b?.dueAtMs, casual.dueAtMs + GAP_MS);
    const chain = [0, 1, 2].map((i) => post({ kind: "casual", status: "posted", sentAtMs: fill + i * GAP_MS + HOUR }));
    assert.deepEqual(buys(planPosts(input({ nowMs: now, perDay: 10, calls: [c], posts: chain }))), [], "pushed past fill + eight hours");
    assert.ok(fill + 2 * GAP_MS + HOUR + GAP_MS > fill + BUY_STALE_MS);
  });

  it("the intro is exempt from the gap", () => {
    const fill = now;
    const intro = post({ kind: "intro", status: "posted", sentAtMs: now - 5 * MIN });
    const [b] = buys(planPosts(input({ nowMs: now, calls: [call({ decisionId: "after-intro", atSec: fill / 1000 })], posts: [intro] })));
    assert.equal(b?.dueAtMs, fill + (10 + (hash32("buy|after-intro") % 31)) * MIN);
  });
});

// ── the day's cap, in the owner's day ───────────────────────────────────────

describe("the daily cap is the owner's local day", () => {
  it("counts scheduled, sending and posted — not skipped, cancelled or failed", () => {
    const now = DAY0 + 10 * HOUR;
    const c = [call({ name: "Pepe", atSec: (now - MIN) / 1000 })];
    const out = ["skipped", "cancelled", "failed"].map((status) => post({ kind: "casual", status: status as XPost["status"], dueAtMs: now - 6 * HOUR }));
    assert.equal(buys(planPosts(input({ nowMs: now, perDay: 1, calls: c, posts: out }))).length, 1);
    const live = [post({ kind: "intro", status: "posted", sentAtMs: now - 6 * HOUR })];
    assert.deepEqual(planPosts(input({ nowMs: now, perDay: 1, calls: c, posts: live })), [], "the intro counts toward the day");
  });

  it("a post late last night, owner-local, is yesterday — even when it is today in UTC", () => {
    const now = Date.UTC(2026, 8, 28, 16); // 11:00 in Test/Minus5
    const lastNight = post({ kind: "casual", status: "posted", sentAtMs: Date.UTC(2026, 8, 28, 3) }); // 22:00 the 27th, Test/Minus5
    const c = [call({ name: "Pepe", atSec: (now - MIN) / 1000 })];
    assert.equal(buys(planPosts(input({ nowMs: now, tz: "Test/Minus5", perDay: 1, calls: c, posts: [lastNight] }))).length, 1);
    assert.deepEqual(buys(planPosts(input({ nowMs: now, tz: null, perDay: 1, calls: c, posts: [lastNight] }))), [], "with no zone, a UTC day");
  });

  it("at midnight the count starts again", () => {
    const tz = "Test/Plus2";
    const before = Date.UTC(2026, 8, 28, 21, 50); // 23:50 local — asleep, so nothing is planned at all
    assert.deepEqual(planPosts(input({ tz, nowMs: before, perDay: 1, calls: [call({ atSec: (before - MIN) / 1000 })] })), []);
    const morning = Date.UTC(2026, 8, 29, 6); // 08:00 local on the 29th
    const yesterday = post({ kind: "casual", status: "posted", sentAtMs: Date.UTC(2026, 8, 28, 21) }); // 23:00 local on the 28th
    const plan = planPosts(input({ tz, nowMs: morning, perDay: 1, calls: [call({ atSec: (morning - MIN) / 1000 })], posts: [yesterday] }));
    assert.equal(buys(plan).length, 1);
  });
});

// ── casual ──────────────────────────────────────────────────────────────────

describe("one casual post at the account's own afternoon slot, most days", () => {
  /** The first minute of the day's window at which the slot has come, found by asking the planner. */
  function firstPlanned(tenant: string, tz: string | null, day: number): number | null {
    for (let m = 0; m < 24 * 60; m += 1) {
      const nowMs = day + m * MIN - (tz ? (OFFSETS[tz] ?? 0) * MIN : 0);
      const plan = planPosts(input({ tenant, tz, nowMs }));
      if (plan.some((p) => p.kind === "casual")) return m;
    }
    return null;
  }

  it("inside the owner's afternoon with a zone, the UTC afternoon without one; keyed by the local day", () => {
    let planned = 0;
    for (let i = 0; i < 40; i++) {
      const tenant = `0x${i.toString(16).padStart(40, "0")}`;
      const local = firstPlanned(tenant, "Test/Plus2", DAY0);
      const utc = firstPlanned(tenant, null, DAY0);
      if (local !== null) {
        assert.ok(local >= 12 * 60 && local < 20 * 60 - 30, `${tenant} local slot ${local}`);
        planned++;
      }
      if (utc !== null) assert.ok(utc >= 14 * 60 && utc < 22 * 60 - 30, `${tenant} utc slot ${utc}`);
    }
    // About three days in ten are quiet, deterministically.
    assert.ok(planned >= 20 && planned <= 36, `${planned} of forty accounts post a casual line today`);
  });

  it("due a few minutes from now, once per local day, and never after the window", () => {
    const tenant = `0x${"0".repeat(39)}1`;
    let day = DAY0;
    let slot = firstPlanned(tenant, null, day);
    while (slot === null) {
      day += 24 * HOUR;
      slot = firstPlanned(tenant, null, day);
    }
    const now = day + slot * MIN;
    const [c] = planPosts(input({ tenant, nowMs: now }));
    assert.equal(c?.kind, "casual");
    assert.equal(c?.dedupeKey, casualKey(tenant, new Date(day).toISOString().slice(0, 10)));
    assert.ok(c!.dueAtMs >= now + 20 * MIN && c!.dueAtMs <= now + 45 * MIN, "twenty to forty-five minutes under Coming up");
    assert.deepEqual(planPosts(input({ tenant, nowMs: now + HOUR, posts: [post({ kind: "casual", dedupeKey: c!.dedupeKey, status: "skipped" })] })), [], "the key is spent");
    assert.deepEqual(planPosts(input({ tenant, nowMs: day + 22 * HOUR })), [], "the window has closed");
  });

  it("the gap pushes it, and a push past six hours waits for another day", () => {
    const tenant = `0x${"0".repeat(39)}1`;
    let day = DAY0;
    let slot = firstPlanned(tenant, null, day);
    while (slot === null) {
      day += 24 * HOUR;
      slot = firstPlanned(tenant, null, day);
    }
    const now = day + slot * MIN;
    const soon = post({ kind: "buy", status: "scheduled", dueAtMs: now + HOUR, coin: "x" });
    const [c] = planPosts(input({ tenant, nowMs: now, posts: [soon] }));
    assert.equal(c?.dueAtMs, soon.dueAtMs + GAP_MS);
    const far = [0, 1].map((i) => post({ kind: "buy", status: "scheduled", dueAtMs: now + HOUR + i * GAP_MS, coin: `c${i}` }));
    assert.deepEqual(planPosts(input({ tenant, nowMs: now, perDay: 10, posts: far })), []);
  });

  it("one casual post per owner-local day under the zone known now, whatever day its key was written under", () => {
    const tenant = `0x${"0".repeat(39)}1`;
    const tz = "Test/Plus2";
    let day = DAY0;
    let slot = firstPlanned(tenant, tz, day);
    while (slot === null) {
      day += 24 * HOUR;
      slot = firstPlanned(tenant, tz, day);
    }
    const now = day + slot * MIN - 2 * HOUR; // the slot, local
    assert.equal(kinds(planPosts(input({ tenant, tz, nowMs: now }))).includes("casual"), true);
    // Posted this morning (local) while the zone was unknown: its key is
    // yesterday's UTC day, so the key alone would allow a second one today.
    const utcKeyed = post({ kind: "casual", status: "posted", dedupeKey: casualKey(tenant, "2000-01-01"), sentAtMs: day - 2 * HOUR + 30 * MIN });
    assert.equal(clock.localDay(tz, utcKeyed.sentAtMs!), clock.localDay(tz, now), "the same local day");
    assert.deepEqual(planPosts(input({ tenant, tz, nowMs: now, posts: [utcKeyed] })), []);
  });

  it("a zone the clock cannot read gets no casual post rather than a guessed afternoon", () => {
    for (let m = 0; m < 24 * 60; m += 15) {
      assert.deepEqual(planPosts(input({ tz: "Not/AZone", nowMs: DAY0 + m * MIN })), []);
    }
  });
});

// ── sending ─────────────────────────────────────────────────────────────────

describe("sendDecision", () => {
  const now = DAY0 + 12 * HOUR;
  const p = { kind: "buy" as const, xUserId: "111", createdAtMs: now - HOUR, dueAtMs: now - MIN };
  const on = { xUserId: "111", posting: true };

  it("cancels a post whose account is gone, changed or off", () => {
    assert.deepEqual(sendDecision(p, null, now, false), { action: "cancel", reason: "account-gone" });
    assert.deepEqual(sendDecision(p, { xUserId: "222", posting: true }, now, false), { action: "cancel", reason: "account-changed" });
    assert.deepEqual(sendDecision(p, { xUserId: "111", posting: false }, now, false), { action: "cancel", reason: "account-off" });
  });

  it("skips a buy post still waiting eight hours after it was drafted — only a buy post", () => {
    assert.deepEqual(sendDecision({ ...p, createdAtMs: now - BUY_STALE_MS - 1 }, on, now, false), { action: "skip", reason: "stale" });
    assert.deepEqual(sendDecision({ ...p, createdAtMs: now - BUY_STALE_MS }, on, now, false), { action: "send" });
    assert.deepEqual(sendDecision({ ...p, kind: "casual", createdAtMs: now - 20 * HOUR }, on, now, false), { action: "send" });
  });

  it("skips a casual post held past its owner-local day, or six hours past due; never the intro", () => {
    const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const casual = { ...p, kind: "casual" as const, createdAtMs: now - 2 * HOUR, dueAtMs: now - HOUR };
    assert.deepEqual(sendDecision(casual, on, now, false, utcDay), { action: "send" });
    assert.deepEqual(sendDecision({ ...casual, dueAtMs: now - CASUAL_MAX_PUSH_MS }, on, now, false, utcDay), { action: "send" });
    assert.deepEqual(sendDecision({ ...casual, dueAtMs: now - CASUAL_MAX_PUSH_MS - 1 }, on, now, false), { action: "skip", reason: "stale" }, "held six hours, even with no day to read");
    // Due 23:30 on the 28th, held (a pause, the ceiling, the owner's night) to 00:05 on the 29th.
    const late = Date.UTC(2026, 8, 28, 23, 30);
    const past = Date.UTC(2026, 8, 29, 0, 5);
    assert.deepEqual(sendDecision({ ...casual, dueAtMs: late }, on, past, false, utcDay), { action: "skip", reason: "stale" }, "yesterday's thought");
    assert.deepEqual(sendDecision({ ...casual, dueAtMs: late }, on, past, true, utcDay), { action: "skip", reason: "stale" }, "retired while the owner sleeps, before it blocks anything");
    assert.deepEqual(sendDecision({ ...casual, dueAtMs: now + HOUR }, on, now, false, utcDay), { action: "wait" }, "not due is not stale");
    const hello = { ...p, kind: "intro" as const, createdAtMs: now - 3 * 24 * HOUR, dueAtMs: now - 3 * 24 * HOUR };
    assert.deepEqual(sendDecision(hello, on, now, false, utcDay), { action: "send" }, "a late hello is still the right first post");
  });

  it("waits while the owner sleeps, or until it is due; otherwise sends", () => {
    assert.deepEqual(sendDecision(p, on, now, true), { action: "wait" });
    assert.deepEqual(sendDecision({ ...p, dueAtMs: now + 1 }, on, now, false), { action: "wait" });
    assert.deepEqual(sendDecision(p, on, now, false), { action: "send" });
  });
});
