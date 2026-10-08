import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  budgetConfigFor,
  DEFAULT_GROUP_HOURLY_CREDITS,
  DEFAULT_PRIORITY_SHARES,
  DEFAULT_TENANT_DAILY_CREDITS,
  DEFAULT_TENANT_HOURLY_CREDITS,
  describeBudget,
  fomoBudgetFrom,
  fomoPlanFrom,
  FREE_PLAN_CREDITS_PER_MONTH,
  refusalResetAt,
  utcClockText,
  FomoBudget,
  MemoryAllowance,
  ModelBudget,
  ROUTE_COST,
  UsageMeter,
  deriveDailyCredits,
  estimateCredits,
  utcDay,
  type AllowancePort,
  type ChargeRequest,
  type FomoBudgetConfig,
} from "./budget";
import { admitTgLine } from "../telegram/tg-groups/gate";
import { FOMO_GROUP_OFF, groupRefusalLine } from "./render";
import type { RetrievalPriority } from "./types";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BIG = 1_000_000_000;

function make(over: Partial<FomoBudgetConfig> = {}, port = new MemoryAllowance()) {
  const budget = new FomoBudget({
    port,
    config: { sharedDailyCredits: 10_000, tenantHourlyCredits: BIG, tenantDailyCredits: BIG, groupHourlyCredits: BIG, ...over },
    now: () => NOW,
  });
  return { port, budget };
}

const req = (priority: RetrievalPriority, over: Partial<ChargeRequest> = {}): ChargeRequest => ({
  priority,
  tenant: "t1",
  surface: "background",
  credits: 250,
  now: NOW,
  ...over,
});

/** Charge until refused; how many succeeded and why it stopped. */
async function drain(b: FomoBudget, priority: RetrievalPriority, over: Partial<ChargeRequest> = {}) {
  for (let n = 0; n < 10_000; n++) {
    const r = await b.tryCharge(req(priority, over));
    if (!r.ok) return { n, reason: r.reason };
  }
  throw new Error("never refused");
}

const poolKey = (part: string, day = utcDay(NOW)) => `fomo:credits:pool:${part}:d:${day}`;

describe("ROUTE_COST and estimateCredits", () => {
  it("matches the provider's published credit costs", () => {
    assert.deepEqual({ ...ROUTE_COST }, {
      leaderboard: 250,
      "normal-read": 250,
      "alerts-page": 125,
      "thesis-page": 1_250,
      "following-page": 250,
      "wallet-resolution": 2_500,
      "unresolved-handle-miss": 250,
      me: 0,
      health: 0,
    });
  });

  it("multiplies by pages, rounding pages up to at least one", () => {
    assert.equal(estimateCredits("thesis-page", 4), 5_000);
    assert.equal(estimateCredits("normal-read", 12), 3_000, "/trades?deep=1 is twelve upstream calls");
    assert.equal(estimateCredits("alerts-page", 3), 375);
    assert.equal(estimateCredits("leaderboard"), 250);
    assert.equal(estimateCredits("wallet-resolution"), 2_500);
    assert.equal(estimateCredits("me", 5), 0);
    assert.equal(estimateCredits("normal-read", 0), 250);
    assert.equal(estimateCredits("normal-read", 2.2), 750);
    assert.equal(estimateCredits("normal-read", Number.NaN), 250);
    assert.throws(() => estimateCredits("pay-create" as never), RangeError);
  });

  it("accepts a route's own cost spec, billing a flat route once", () => {
    assert.equal(estimateCredits({ credits: 1_250, perPage: true }, 3), 3_750);
    assert.equal(estimateCredits({ credits: 250, perPage: false }, 6), 250);
    assert.equal(estimateCredits({ credits: 250 }, 2), 500);
    assert.throws(() => estimateCredits({ credits: Number.NaN }), RangeError);
    assert.throws(() => estimateCredits({ credits: -1 }), RangeError);
  });
});

describe("deriveDailyCredits", () => {
  it("spreads the plan, less the safety fraction, over the month", () => {
    assert.equal(deriveDailyCredits(250_000, 31, 0), 8_064);
    assert.equal(deriveDailyCredits(2_500_000, 30, 0.1), 75_000);
    assert.equal(deriveDailyCredits(0, 31, 0), 0);
  });

  it("is null, not zero, for unusable inputs", () => {
    assert.equal(deriveDailyCredits(Number.NaN, 31, 0), null);
    assert.equal(deriveDailyCredits(-1, 31, 0), null);
    assert.equal(deriveDailyCredits(250_000, 32, 0), null);
    assert.equal(deriveDailyCredits(250_000, 30.5, 0), null);
    assert.equal(deriveDailyCredits(250_000, 31, 1), null);
    assert.equal(deriveDailyCredits(250_000, 31, -0.1), null);
  });
});

describe("FomoBudget: priority reservations on the shared pool", () => {
  it("defaults to 25 / 45 / 30", () => {
    assert.deepEqual({ ...DEFAULT_PRIORITY_SHARES }, { "position-protection": 0.25, interactive: 0.45, discovery: 0.3 });
    const { budget } = make();
    assert.deepEqual(budget.limitsFor("discovery"), {
      poolAll: 9_000, poolNonProtection: 7_500, poolDiscovery: 3_000, tenantHourly: 750_000_000, tenantDaily: 750_000_000, groupHourly: BIG,
    });
    assert.equal(budget.limitsFor("interactive").poolDiscovery, null);
    assert.equal(budget.limitsFor("position-protection").poolNonProtection, null);
    assert.equal(budget.limitsFor("position-protection").tenantDaily, BIG);
  });

  it("the protection reserve survives a discovery flood (and an interactive one)", async () => {
    const { budget } = make();
    const disc = await drain(budget, "discovery");
    assert.deepEqual(disc, { n: 12, reason: "class-reserve" }, "discovery stops at its 30% share");
    const inter = await drain(budget, "interactive");
    assert.deepEqual(inter, { n: 18, reason: "class-reserve" }, "interactive gets its 45%, not protection's");
    const prot = await drain(budget, "position-protection");
    assert.deepEqual(prot, { n: 10, reason: "shared-daily" }, "the 25% protection reserve is intact");
  });

  it("after a discovery flood alone, protection may borrow everything left", async () => {
    const { budget } = make();
    await drain(budget, "discovery");
    assert.deepEqual(await drain(budget, "position-protection"), { n: 28, reason: "shared-daily" });
  });

  it("interactive still works when discovery is exhausted", async () => {
    const { budget } = make();
    await drain(budget, "discovery");
    assert.equal((await budget.tryCharge(req("discovery"))).ok, false);
    const r = await budget.tryCharge(req("interactive"));
    assert.equal(r.ok, true);
  });

  it("interactive may borrow discovery's unused share, never protection's", async () => {
    const { budget } = make();
    assert.deepEqual(await drain(budget, "interactive"), { n: 30, reason: "class-reserve" });
    assert.deepEqual(await drain(budget, "discovery"), { n: 0, reason: "class-reserve" }, "borrowed share is gone for discovery");
    assert.deepEqual(await drain(budget, "position-protection"), { n: 10, reason: "shared-daily" });
  });

  it("protection may use the whole pool", async () => {
    const { budget } = make();
    assert.deepEqual(await drain(budget, "position-protection"), { n: 40, reason: "shared-daily" });
    assert.deepEqual(await drain(budget, "interactive"), { n: 0, reason: "shared-daily" });
  });

  it("discovery is shed first as the pool runs low, even inside its own share", async () => {
    const { budget } = make();
    for (let i = 0; i < 26; i++) assert.equal((await budget.tryCharge(req("position-protection"))).ok, true);
    // 6,500 used. Discovery's share has 3,000 free, but it stops at 90% of the pool.
    assert.deepEqual(await drain(budget, "discovery"), { n: 10, reason: "shared-daily" });
    assert.deepEqual(await drain(budget, "interactive"), { n: 4, reason: "shared-daily" }, "interactive keeps the last 10%");
  });

  it("an unrecognised priority is treated as discovery, never promoted", async () => {
    const { budget } = make({ sharedDailyCredits: 1_000 });
    assert.deepEqual(await drain(budget, "vip" as RetrievalPriority), { n: 1, reason: "class-reserve" });
  });

  it("a new UTC day is a new pool", async () => {
    const { budget } = make({ sharedDailyCredits: 1_000 });
    await drain(budget, "position-protection");
    assert.equal((await budget.tryCharge(req("position-protection", { now: NOW + DAY }))).ok, true);
  });
});

describe("FomoBudget: tenant and group caps", () => {
  it("caps a tenant per hour, keeping a protection reserve inside the tenant's own limit", async () => {
    const { budget } = make({ sharedDailyCredits: BIG, tenantHourlyCredits: 1_000 });
    assert.deepEqual(await drain(budget, "interactive"), { n: 3, reason: "tenant-hourly" });
    assert.deepEqual(await drain(budget, "position-protection"), { n: 1, reason: "tenant-hourly" }, "the tenant's chat cannot spend its protection");
    assert.equal((await budget.tryCharge(req("interactive", { tenant: "t2" }))).ok, true, "another tenant is unaffected");
    assert.equal((await budget.tryCharge(req("interactive", { now: NOW + HOUR }))).ok, true, "a new hour is a new allowance");
  });

  it("caps a tenant per day across hours", async () => {
    const { budget } = make({ sharedDailyCredits: BIG, tenantDailyCredits: 1_000 });
    assert.deepEqual(await drain(budget, "interactive"), { n: 3, reason: "tenant-daily" });
    assert.deepEqual(await drain(budget, "interactive", { now: NOW + HOUR }), { n: 0, reason: "tenant-daily" });
    assert.equal((await budget.tryCharge(req("interactive", { now: NOW + DAY }))).ok, true);
  });

  it("caps a group per hour across tenants, and refuses a group request without a group", async () => {
    const { budget } = make({ sharedDailyCredits: BIG, groupHourlyCredits: 500 });
    const g = { surface: "telegram-group" as const, groupId: "g1" };
    assert.deepEqual(await drain(budget, "interactive", g), { n: 2, reason: "group-hourly" });
    assert.deepEqual(await drain(budget, "interactive", { ...g, tenant: "t2" }), { n: 0, reason: "group-hourly" });
    assert.equal((await budget.tryCharge(req("interactive", { ...g, groupId: "g2" }))).ok, true);
    // Fail-closed, and never a clock time: a group it cannot name is no group hour to wait for.
    assert.deepEqual(await budget.tryCharge(req("interactive", { surface: "telegram-group", groupId: null })), { ok: false, reason: "no-group" });
    assert.deepEqual(await budget.tryCharge(req("interactive", { surface: "telegram-group", groupId: "  " })), { ok: false, reason: "no-group" });
    assert.equal(refusalResetAt("no-group", NOW), null);
  });

  it("a single charge larger than a limit is refused without touching the counter", async () => {
    const { budget, port } = make({ tenantHourlyCredits: 1_000 });
    const r = await budget.tryCharge(req("position-protection", { credits: 1_250 }));
    // It can never fit, in any hour: no reset time is promised (refusalResetAt is null).
    assert.deepEqual(r, { ok: false, reason: "below-one-read" });
    assert.equal(refusalResetAt(r.ok ? null : r.reason, NOW), null);
    assert.ok(port.keys().every((k) => port.used(k) === 0));
  });

  it("a refusal late in the sequence gives back every counter taken before it", async () => {
    const { budget, port } = make({ sharedDailyCredits: 1_000, groupHourlyCredits: BIG });
    const g = { surface: "telegram-group" as const, groupId: "g1" };
    assert.equal((await budget.tryCharge(req("discovery", g))).ok, true);
    assert.deepEqual(await budget.tryCharge(req("discovery", g)), { ok: false, reason: "class-reserve" });
    const used = port.keys().map((k) => port.used(k));
    assert.ok(used.length >= 6);
    assert.ok(used.every((n) => n === 250), `every counter holds only the first charge: ${used.join(",")}`);
  });

  it("percent-encodes tenant and group ids so one cannot forge another's key", async () => {
    const { budget, port } = make();
    await budget.tryCharge(req("interactive", { tenant: "a:all:h", surface: "telegram-group", groupId: "x:y" }));
    const keys = port.keys();
    assert.ok(keys.includes(`fomo:credits:tenant:a%3Aall%3Ah:all:h:${Math.floor(NOW / HOUR)}`), keys.join("\n"));
    assert.ok(keys.includes(`fomo:credits:group:x%3Ay:h:${Math.floor(NOW / HOUR)}`));
  });
});

describe("FomoBudget: the reason reported is the one with the latest reset (review 2026-10-08)", () => {
  const free = budgetConfigFor(FREE_PLAN_CREDITS_PER_MONTH);
  const at = Date.UTC(2026, 9, 7, 14, 20, 0);
  const room = (credits: number, over: Partial<ChargeRequest> = {}) => req("interactive", { surface: "telegram-group", groupId: "g1", credits, now: at, ...over });

  it("the room's hourly cap and the shared pool both spent: the pool's reason, so the room hears 00:00, not the next hour", async () => {
    const budget = new FomoBudget({ port: new MemoryAllowance(), config: free, now: () => at });
    // Another owner spends most of the interactive pool in the morning.
    for (let i = 0; i < 11; i++) assert.equal((await budget.tryCharge(req("interactive", { tenant: "t9", surface: "telegram-dm", credits: 250, now: at }))).ok, true);
    // The room reads one coin (a search and a thesis page), then a second coin's search.
    for (const c of [250, 1_250, 250]) assert.equal((await budget.tryCharge(room(c))).ok, true, String(c));
    const r = await budget.tryCharge(room(1_250));
    assert.deepEqual(r, { ok: false, reason: "class-reserve" });
    const reason = r.ok ? null : `budget-${r.reason}`;
    assert.equal(new Date(refusalResetAt(reason, at)!).toISOString(), "2026-10-08T00:00:00.000Z");
    assert.equal(groupRefusalLine(reason, at), "fomo lookups for this room are used up for now, try again after 00:00 UTC.");
  });

  it("only the room's hourly cap spent: the next hour, as before", async () => {
    const budget = new FomoBudget({ port: new MemoryAllowance(), config: free, now: () => at });
    for (const c of [250, 1_250, 250]) assert.equal((await budget.tryCharge(room(c))).ok, true, String(c));
    const r = await budget.tryCharge(room(1_250));
    assert.deepEqual(r, { ok: false, reason: "group-hourly" });
    assert.equal(groupRefusalLine("budget-group-hourly", at), "fomo lookups for this room are used up for now, try again after 15:00 UTC.");
  });

  it("a group cap of 0, or below one read: the room hears research is not on here, never a time, hour after hour", async () => {
    for (const groupHourlyCredits of [0, 1_000]) {
      const budget = new FomoBudget({ port: new MemoryAllowance(), config: { ...free, groupHourlyCredits }, now: () => at });
      for (const now of [at, at + HOUR]) {
        const r = await budget.tryCharge(room(1_250, { now }));
        assert.deepEqual(r, { ok: false, reason: "below-one-read" }, String(groupHourlyCredits));
        const line = groupRefusalLine(r.ok ? null : `budget-${r.reason}`, now);
        assert.equal(line, FOMO_GROUP_OFF);
        assert.doesNotMatch(line, /try again/);
      }
    }
    assert.ok(admitTgLine(FOMO_GROUP_OFF, { agentName: "Shogun", kind: "research", recentOwn: [] }).ok);
  });
});

describe("FomoBudget: the hourly counters first; the reason read without taking anything (review r2)", () => {
  const free = budgetConfigFor(FREE_PLAN_CREDITS_PER_MONTH);
  const at = Date.UTC(2026, 9, 7, 14, 20, 0);
  const room = (credits: number, over: Partial<ChargeRequest> = {}) => req("interactive", { surface: "telegram-group", groupId: "g1", credits, now: at, ...over });
  /** A MemoryAllowance that records every take, and may run something when one key is taken. */
  const spy = (mem = new MemoryAllowance(), during?: (key: string) => Promise<void>, withPeek = true) => {
    const takes: string[] = [];
    const port: AllowancePort = {
      take: async (k, a, l, n) => {
        takes.push(k);
        if (during) await during(k);
        return mem.take(k, a, l, n);
      },
      give: (k, a) => mem.give(k, a),
      ...(withPeek ? { peek: (k: string) => mem.peek(k) } : {}),
    };
    return { port, takes, mem };
  };

  it("a room past its hour is refused at its own counter, never touching the fleet's daily pools", async () => {
    const { port, takes } = spy();
    const budget = new FomoBudget({ port, config: free, now: () => at });
    for (const c of [250, 1_250, 250]) assert.equal((await budget.tryCharge(room(c))).ok, true, String(c));
    takes.length = 0;
    for (let i = 0; i < 6; i++) assert.deepEqual(await budget.tryCharge(room(1_250)), { ok: false, reason: "group-hourly" });
    assert.ok(takes.length > 0 && takes.every((k) => k.startsWith("fomo:credits:group:g1:h:")), takes.join("\n"));
  });

  it("another owner's read while a spent room is refused is granted with the pool one read from full", async () => {
    const mem = new MemoryAllowance();
    let other: Promise<unknown> | null = null;
    let armed = false;
    let budget!: FomoBudget;
    const { port } = spy(mem, async (k) => {
      // The room's refused charge is under way: another owner asks for the last read the pool holds.
      if (armed && k.startsWith("fomo:credits:group:g1:h:") && other === null) other = budget.tryCharge(req("interactive", { tenant: "t9", surface: "telegram-dm", credits: 250, now: at }));
    });
    const pool = 2_000;
    budget = new FomoBudget({ port, config: { ...free, sharedDailyCredits: pool, groupHourlyCredits: 1_250, tenantHourlyCredits: pool, tenantDailyCredits: pool }, now: () => at });
    assert.equal((await budget.tryCharge(room(1_250))).ok, true);
    // Fill the interactive pool to one read from its limit.
    const np = budget.limitsFor("interactive").poolNonProtection!;
    for (let used = 1_250; used + 250 <= np - 250; used += 250) assert.equal((await budget.tryCharge(req("interactive", { tenant: "t8", surface: "telegram-dm", credits: 250, now: at }))).ok, true);
    armed = true;
    const refused = await budget.tryCharge(room(250));
    assert.equal(refused.ok, false);
    assert.ok(other !== null, "the other owner's read ran inside the room's refused charge");
    assert.equal(((await other) as { ok: boolean }).ok, true, "granted: the room's refusal never held the pool");
  });

  it("without a way to read the counters (no peek), a refusal keeps the hourly reason it met", async () => {
    const { port } = spy(new MemoryAllowance(), undefined, false);
    const budget = new FomoBudget({ port, config: free, now: () => at });
    for (let i = 0; i < 11; i++) assert.equal((await budget.tryCharge(req("interactive", { tenant: "t9", surface: "telegram-dm", credits: 250, now: at }))).ok, true);
    for (const c of [250, 1_250, 250]) assert.equal((await budget.tryCharge(room(c))).ok, true, String(c));
    assert.deepEqual(await budget.tryCharge(room(1_250)), { ok: false, reason: "group-hourly" });
    assert.equal(await budget.wouldRefuse(room(1_250)), null, "nothing it cannot read is said");
  });

  it("wouldRefuse: the reason tryCharge would report, taking nothing; null when the whole cost fits", async () => {
    const mem = new MemoryAllowance();
    const budget = new FomoBudget({ port: mem, config: { ...free, groupHourlyCredits: 1_600, tenantDailyCredits: 3_000 }, now: () => at });
    assert.equal(await budget.wouldRefuse(room(1_500)), null);
    assert.ok(mem.keys().every((k) => mem.used(k) === 0), "nothing taken");
    for (const c of [250, 1_250]) assert.equal((await budget.tryCharge(room(c))).ok, true);
    const before = mem.keys().map((k) => [k, mem.used(k)]);
    // The group hour (1,500 of 1,600) and the owner's daily share (1,500 of 2,250) both refuse 1,500 more: midnight.
    assert.equal(await budget.wouldRefuse(room(1_500)), "tenant-daily");
    // 250 alone is refused only by the hour: the next hour, and it fits then.
    assert.equal(await budget.wouldRefuse(room(250)), "group-hourly");
    assert.equal(await budget.wouldRefuse(room(100)), null);
    assert.deepEqual(mem.keys().map((k) => [k, mem.used(k)]), before, "still nothing taken");
    assert.equal(await budget.wouldRefuse(room(1_500)), (await budget.tryCharge(room(1_500)).then((r) => (r.ok ? null : r.reason))));
    assert.equal(await budget.wouldRefuse(room(250, { groupId: null })), "no-group");
    const off = new FomoBudget({ port: new MemoryAllowance(), config: { ...free, groupHourlyCredits: 0 }, now: () => at });
    assert.equal(await off.wouldRefuse(room(250)), "below-one-read");
  });
});

describe("FomoBudget: settle and refund", () => {
  it("refund restores the allowance, once", async () => {
    const { budget, port } = make({ sharedDailyCredits: 1_000 });
    const grants = [];
    for (let i = 0; i < 4; i++) {
      const g = await budget.tryCharge(req("position-protection"));
      assert.equal(g.ok, true);
      grants.push(g);
    }
    assert.equal((await budget.tryCharge(req("position-protection"))).ok, false);
    const first = grants[0];
    assert.ok(first && first.ok);
    await first.refund();
    await first.refund();
    assert.equal(port.used(poolKey("all")), 750, "a second refund gives nothing back");
    assert.equal((await budget.tryCharge(req("position-protection"))).ok, true);
    assert.equal((await budget.tryCharge(req("position-protection"))).ok, false);
  });

  it("settle gives back the difference when the provider billed less (a handle miss)", async () => {
    const { budget, port } = make();
    const g = await budget.tryCharge(req("interactive", { credits: estimateCredits("wallet-resolution") }));
    assert.ok(g.ok);
    assert.equal(g.charged, 2_500);
    await g.settle(ROUTE_COST["unresolved-handle-miss"]);
    assert.equal(port.used(poolKey("all")), 250);
    assert.equal(port.used(poolKey("np")), 250);
    await g.refund();
    assert.equal(port.used(poolKey("all")), 250, "refund after settle does nothing");
  });

  it("settle(0) on a refunded 'resolving' response gives everything back", async () => {
    const { budget, port } = make();
    const g = await budget.tryCharge(req("interactive", { credits: 2_500 }));
    assert.ok(g.ok);
    await g.settle(0);
    assert.equal(port.used(poolKey("all")), 0);
  });

  it("settle(null) keeps the estimate: credits we may have been billed for stay counted", async () => {
    const { budget, port } = make();
    const g = await budget.tryCharge(req("interactive", { credits: 1_250 }));
    assert.ok(g.ok);
    await g.settle(null);
    await g.settle(0);
    assert.equal(port.used(poolKey("all")), 1_250, "only the first settle counts");
  });

  it("settle records an overrun even past the limit, because it was spent", async () => {
    const { budget, port } = make({ sharedDailyCredits: 3_000 });
    const g = await budget.tryCharge(req("position-protection", { credits: 1_250 }));
    assert.ok(g.ok);
    await g.settle(5_000);
    assert.equal(port.used(poolKey("all")), 5_000);
    assert.deepEqual(await budget.tryCharge(req("position-protection")), { ok: false, reason: "shared-daily" });
  });

  it("ignores a nonsense actual and keeps the estimate", async () => {
    const { budget, port } = make();
    const g = await budget.tryCharge(req("interactive", { credits: 250 }));
    assert.ok(g.ok);
    await g.settle(Number.NaN);
    assert.equal(port.used(poolKey("all")), 250);
  });

  it("a zero-credit route (me, health) is granted without touching any counter", async () => {
    const { budget, port } = make({ sharedDailyCredits: 0 });
    const g = await budget.tryCharge(req("discovery", { credits: estimateCredits("health") }));
    assert.ok(g.ok);
    await g.settle(0);
    assert.deepEqual(port.keys(), []);
  });

  it("a zero pool refuses every paid call", async () => {
    const { budget } = make({ sharedDailyCredits: 0 });
    assert.deepEqual(await budget.tryCharge(req("position-protection")), { ok: false, reason: "shared-daily" });
  });
});

describe("FomoBudget: failure handling and validation", () => {
  it("a port failure rejects and gives back what was already taken", async () => {
    const mem = new MemoryAllowance();
    let calls = 0;
    const flaky: AllowancePort = {
      take: async (k, a, l, n) => {
        if (++calls === 3) throw new Error("db down");
        return mem.take(k, a, l, n);
      },
      give: (k, a) => mem.give(k, a),
    };
    const errors: string[] = [];
    const budget = new FomoBudget({
      port: flaky,
      config: { sharedDailyCredits: 10_000, tenantHourlyCredits: BIG, tenantDailyCredits: BIG, groupHourlyCredits: BIG },
      onError: (op) => errors.push(op),
    });
    await assert.rejects(budget.tryCharge(req("interactive")), /db down/);
    assert.ok(mem.keys().length >= 2);
    assert.ok(mem.keys().every((k) => mem.used(k) === 0));
    assert.deepEqual(errors, []);
  });

  it("rejects an invalid configuration and invalid requests loudly", async () => {
    const base = { sharedDailyCredits: 1, tenantHourlyCredits: 1, tenantDailyCredits: 1, groupHourlyCredits: 1 };
    const port = new MemoryAllowance();
    assert.throws(() => new FomoBudget({ port, config: { ...base, shares: { "position-protection": 0.5, interactive: 0.5, discovery: 0.2 } } }), RangeError);
    assert.throws(() => new FomoBudget({ port, config: { ...base, sharedDailyCredits: Number.NaN } }), RangeError);
    assert.throws(() => new FomoBudget({ port, config: { ...base, discoveryShedAt: 2 } }), RangeError);
    const { budget } = make();
    await assert.rejects(budget.tryCharge(req("interactive", { tenant: " " })), TypeError);
    await assert.rejects(budget.tryCharge(req("interactive", { credits: -1 })), RangeError);
    await assert.rejects(budget.tryCharge(req("interactive", { credits: Number.POSITIVE_INFINITY })), RangeError);
    await assert.rejects(budget.tryCharge(req("interactive", { now: Number.NaN })), RangeError);
  });
});

describe("ModelBudget", () => {
  const mk = (callsPerDay: number, tokensPerDay: number) => {
    const port = new MemoryAllowance();
    return { port, mb: new ModelBudget({ port, config: { callsPerDay, tokensPerDay }, now: () => NOW }) };
  };
  const start = (mb: ModelBudget, estimatedTokens: number, over: { tenant?: string; now?: number } = {}) =>
    mb.tryStart({ tenant: "t1", estimatedTokens, now: NOW, ...over });

  it("caps calls per tenant per day", async () => {
    const { mb } = mk(2, BIG);
    assert.equal((await start(mb, 100)).ok, true);
    assert.equal((await start(mb, 100)).ok, true);
    assert.deepEqual(await start(mb, 100), { ok: false, reason: "model-calls-daily" });
    assert.equal((await start(mb, 100, { tenant: "t2" })).ok, true);
    assert.equal((await start(mb, 100, { now: NOW + DAY })).ok, true);
  });

  it("caps tokens, rolls back the call on a token refusal, and reconciles actual tokens", async () => {
    const { mb, port } = mk(10, 5_000);
    const a = await start(mb, 4_000);
    assert.ok(a.ok);
    assert.deepEqual(await start(mb, 2_000), { ok: false, reason: "model-tokens-daily" });
    const callsKey = `fomo:model:t1:${utcDay(NOW)}:calls`;
    const tokensKey = `fomo:model:t1:${utcDay(NOW)}:tokens`;
    assert.equal(port.used(callsKey), 1, "the refused call was given back");
    await a.settle(1_000);
    assert.equal(port.used(tokensKey), 1_000);
    const b = await start(mb, 2_000);
    assert.ok(b.ok);
    await b.refund();
    assert.equal(port.used(callsKey), 1, "a refunded call never ran");
    assert.equal(port.used(tokensKey), 1_000);
    await b.settle(9_999);
    assert.equal(port.used(tokensKey), 1_000, "settle after refund does nothing");
  });

  it("rejects nonsense estimates", async () => {
    const { mb } = mk(1, 1);
    await assert.rejects(start(mb, 0), RangeError);
    await assert.rejects(start(mb, Number.NaN), RangeError);
  });
});

describe("UsageMeter", () => {
  it("aggregates calls, known and unknown credits, cache hits and refusals per day and bucket", () => {
    const m = new UsageMeter();
    m.recordCall({ now: NOW, bucket: "thesis-page", credits: 1_250 });
    m.recordCall({ now: NOW, bucket: "thesis-page", credits: null });
    m.recordCall({ now: NOW, bucket: "normal-read", credits: 250 });
    m.recordCacheHit({ now: NOW, bucket: "thesis-page" });
    m.recordCacheHit({ now: NOW, bucket: "thesis-page" });
    m.recordRefusal({ now: NOW, bucket: "normal-read" });
    m.recordCall({ now: NOW + DAY, bucket: "leaderboard", credits: 250 });
    const s = m.snapshot();
    assert.equal(s.days.length, 2);
    const [d1, d2] = s.days;
    assert.ok(d1 && d2);
    assert.equal(d1.day, "2026-10-04");
    assert.deepEqual(d1.buckets["thesis-page"], { calls: 2, creditsKnown: 1_250, callsCreditsUnknown: 1, cacheHits: 2, refusals: 0 });
    assert.deepEqual(d1.totals, { calls: 3, creditsKnown: 1_500, callsCreditsUnknown: 1, cacheHits: 2, refusals: 1 });
    assert.equal(d2.day, "2026-10-05");
    assert.equal(d2.totals.creditsKnown, 250);
    assert.equal(s.lastCreditsRemaining, null);
  });

  it("is bounded in days and buckets", () => {
    const m = new UsageMeter({ retainDays: 2, maxBucketsPerDay: 2 });
    for (let i = 0; i < 4; i++) m.recordCall({ now: NOW + i * DAY, bucket: "a", credits: 1 });
    assert.deepEqual(m.snapshot().days.map((d) => d.day), ["2026-10-06", "2026-10-07"]);
    m.recordCall({ now: NOW, bucket: "late", credits: 1 });
    assert.equal(m.snapshot().days.length, 2, "a record older than every retained day is dropped");
    for (const b of ["a", "b", "c", "d"]) m.recordCall({ now: NOW + 3 * DAY, bucket: b, credits: 1 });
    const last = m.snapshot().days.at(-1);
    assert.ok(last);
    assert.deepEqual(Object.keys(last.buckets), ["_other", "a", "b"]);
    assert.equal(last.buckets._other?.calls, 2);
  });

  it("keeps the newest credits-remaining reading and ignores nonsense", () => {
    const m = new UsageMeter();
    m.recordRemaining({ now: NOW, remaining: 1_000 });
    m.recordRemaining({ now: NOW - 1, remaining: 9_999 });
    m.recordRemaining({ now: NOW + 1, remaining: null });
    m.recordCall({ now: Number.NaN, bucket: "x", credits: 1 });
    const s = m.snapshot();
    assert.deepEqual(s.lastCreditsRemaining, { value: 1_000, at: NOW });
    assert.equal(s.days.length, 0);
  });

  it("snapshots are copies", () => {
    const m = new UsageMeter();
    m.recordCall({ now: NOW, bucket: "a", credits: 1 });
    const s = m.snapshot();
    const b = s.days[0]?.buckets.a;
    assert.ok(b);
    b.calls = 99;
    assert.equal(m.snapshot().days[0]?.buckets.a?.calls, 1);
  });
});

describe("refusalResetAt and the configured caps", () => {
  it("an hourly cap resets at the next clock hour, a daily one at 00:00 UTC, a job's allowance never on a clock", () => {
    const at = (iso: string) => Date.parse(iso);
    const t = (r: string, iso: string) => {
      const ms = refusalResetAt(r, at(iso));
      return ms === null ? null : new Date(ms).toISOString();
    };
    assert.equal(t("budget-group-hourly", "2026-10-07T23:05:00Z"), "2026-10-08T00:00:00.000Z");
    assert.equal(t("group-hourly", "2026-10-07T14:59:59Z"), "2026-10-07T15:00:00.000Z");
    assert.equal(t("budget-tenant-hourly", "2026-10-07T15:00:00Z"), "2026-10-07T16:00:00.000Z");
    assert.equal(t("budget-tenant-daily", "2026-10-07T00:00:00Z"), "2026-10-08T00:00:00.000Z");
    assert.equal(t("budget-shared-daily", "2026-10-07T23:59:59Z"), "2026-10-08T00:00:00.000Z");
    assert.equal(t("budget-class-reserve", "2026-10-07T08:00:00Z"), "2026-10-08T00:00:00.000Z");
    assert.equal(t("job-allowance", "2026-10-07T08:00:00Z"), null);
    assert.equal(t("budget-error", "2026-10-07T08:00:00Z"), null);
    assert.equal(refusalResetAt(null, 0), null);
    assert.equal(refusalResetAt("budget-group-hourly", Number.NaN), null);
    assert.equal(utcClockText(at("2026-10-08T00:00:00Z")), "00:00");
  });

  it("reads the three cap overrides as whole numbers only, one problem line per bad value, never echoing it", () => {
    assert.deepEqual(fomoBudgetFrom({}), { budget: {}, problems: [] });
    assert.deepEqual(fomoBudgetFrom({ MERRYMEN_FOMO_GROUP_HOURLY_CREDITS: " 6500 ", MERRYMEN_FOMO_TENANT_HOURLY_CREDITS: "13000", MERRYMEN_FOMO_TENANT_DAILY_CREDITS: "26000" }), {
      budget: { groupHourlyCredits: 6_500, tenantHourlyCredits: 13_000, tenantDailyCredits: 26_000 },
      problems: [],
    });
    assert.deepEqual(fomoBudgetFrom({ MERRYMEN_FOMO_GROUP_HOURLY_CREDITS: "0" }).budget, { groupHourlyCredits: 0 }, "0 is a cap: no group research");
    for (const bad of ["6,500", "6500.5", "-1", "1e4", "lots", "0x10", "sk_live_pasted_key_123"]) {
      const r = fomoBudgetFrom({ MERRYMEN_FOMO_GROUP_HOURLY_CREDITS: bad });
      assert.deepEqual(r.budget, {}, bad);
      assert.deepEqual(r.problems, ["fomo: MERRYMEN_FOMO_GROUP_HOURLY_CREDITS is not a whole number of credits; its default applies"], bad);
    }
    assert.equal(fomoBudgetFrom({ MERRYMEN_FOMO_TENANT_HOURLY_CREDITS: "x", MERRYMEN_FOMO_TENANT_DAILY_CREDITS: "y" }).problems.length, 2);
    assert.equal(fomoBudgetFrom({ MERRYMEN_FOMO_GROUP_HOURLY_CREDITS: "  " }).problems.length, 0, "blank is unset");
    // A nonzero group cap below a room's dearest read (a coin's thesis page, 1,250; a room never reads
    // the 2,500-credit profile route) can never answer it: said at boot (review r2).
    assert.deepEqual(fomoBudgetFrom({ MERRYMEN_FOMO_GROUP_HOURLY_CREDITS: "1000" }).problems, ["fomo: MERRYMEN_FOMO_GROUP_HOURLY_CREDITS is below what one coin's thesis page costs (1250 credits), so a room can never hear a coin's theses"]);
    assert.deepEqual(fomoBudgetFrom({ MERRYMEN_FOMO_GROUP_HOURLY_CREDITS: "2000" }).problems, [], "2,000 fits a page, and every trader read");
    assert.deepEqual(fomoBudgetFrom({ MERRYMEN_FOMO_GROUP_HOURLY_CREDITS: "1250" }).problems, [], "exactly one page");
    assert.equal(fomoBudgetFrom({ MERRYMEN_FOMO_TENANT_HOURLY_CREDITS: "1500" }).problems.length, 1, "1500 leaves an owner 1125 an hour");
    assert.equal(fomoBudgetFrom({ MERRYMEN_FOMO_GROUP_HOURLY_CREDITS: "0" }).problems.length, 0, "0 is the documented off");
    assert.equal(fomoBudgetFrom({ MERRYMEN_FOMO_GROUP_HOURLY_CREDITS: "2500" }).problems.length, 0, "the default fits one");
  });

  it("the defaults are unchanged, and an override is still held under the shared pool", () => {
    const free = budgetConfigFor(FREE_PLAN_CREDITS_PER_MONTH);
    const growth = budgetConfigFor(37_500_000);
    assert.deepEqual([growth.tenantHourlyCredits, growth.tenantDailyCredits, growth.groupHourlyCredits], [DEFAULT_TENANT_HOURLY_CREDITS, DEFAULT_TENANT_DAILY_CREDITS, DEFAULT_GROUP_HOURLY_CREDITS]);
    assert.deepEqual(budgetConfigFor(37_500_000, fomoBudgetFrom({}).budget), growth, "no variable set: exactly the defaults");
    assert.deepEqual([DEFAULT_TENANT_HOURLY_CREDITS, DEFAULT_TENANT_DAILY_CREDITS, DEFAULT_GROUP_HOURLY_CREDITS], [6_000, 20_000, 2_500]);
    const big = budgetConfigFor(FREE_PLAN_CREDITS_PER_MONTH, fomoBudgetFrom({ MERRYMEN_FOMO_TENANT_DAILY_CREDITS: "99999999" }).budget);
    assert.equal(big.tenantDailyCredits, big.sharedDailyCredits);
    assert.equal(fomoPlanFrom({ MERRYMEN_FOMO_PLAN_CREDITS: "1000000" }), 1_000_000);
    assert.equal(fomoPlanFrom({ MERRYMEN_FOMO_PLAN_CREDITS: "lots" }), undefined);
    assert.equal(describeBudget(growth), `fomo: research budget ${growth.sharedDailyCredits} credits/day shared; per owner 6000/h and 20000/day; per group 2500/h`);
  });
});

describe("budget.ts boundary", () => {
  it("reads no environment, calls no network and has no way to buy credits", () => {
    const src = readFileSync(new URL("./budget.ts", import.meta.url), "utf8");
    assert.ok(!/process\.env/.test(src));
    assert.ok(!/\bfetch\s*\(/.test(src));
    assert.ok(!/fomoapi\.io/.test(src));
    assert.ok(!/\/pay\//.test(src));
  });
});
