/**
 * THE OWNER'S NOTICE, READ FROM THE REAL TABLE BY THE DESK'S OWN RULE — and the
 * idle channel keeping a tripped breaker on it, through the real store.
 *
 * The desk (web api/feed/route.ts) reads an agent's newest 40 events newest
 * first, and the notice (terminal/live.ts mineOf, android Core.kt) is the first
 * warn or err among them. store.ownerNotice asks the child's own table that
 * question; IdleChannel uses the answer to say a standing breaker again when
 * something has covered it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import type { Why } from "./strategies/reasons";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-owner-notice-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));
const { breakerResetLine, idleChannelOnStore, RESTATE_AFTER_MS, withEarlier } = await import("./idle-notice");
const { drawdownOf } = await import("./strategies/types");
const { renderWhy } = await import("./strategies/reasons");

after(() => {
  raw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

let n = 0;
const agent = () => `0x${(++n).toString(16).padStart(40, "0")}`;

describe("store.ownerNotice is the desk's notice", () => {
  it("NOTHING WRITTEN, NOTHING SHOWN", async () => {
    assert.equal(await store.ownerNotice(agent()), null);
  });

  it("the newest warn or err — the running commentary is not a notice", async () => {
    const a = agent();
    await store.addEvent(a, "warn", "first warning");
    for (let i = 0; i < 5; i++) await store.addEvent(a, "ok", `note ${i}`);
    assert.equal((await store.ownerNotice(a))?.message, "first warning");
    await store.addEvent(a, "err", "an error");
    assert.equal((await store.ownerNotice(a))?.message, "an error");
    await store.addEvent(a, "warn", "a newer warning");
    await store.addEvent(a, "ok", "note");
    assert.equal((await store.ownerNotice(a))?.message, "a newer warning", "ties in one second go to the later row, as the desk orders them");
  });

  it("ONLY THE NEWEST 40 — the desk's own LIMIT: a warn older than that is off the desk", async () => {
    const a = agent();
    await store.addEvent(a, "warn", "buried");
    for (let i = 0; i < 39; i++) await store.addEvent(a, "ok", `note ${i}`);
    assert.equal((await store.ownerNotice(a))?.message, "buried", "the 40th newest still shows");
    await store.addEvent(a, "ok", "one more");
    assert.equal(await store.ownerNotice(a), null);
  });

  it("NEWEST BY WHEN IT WAS WRITTEN, then by row — not by insertion alone", async () => {
    const a = agent();
    await store.addEvent(a, "warn", "written later, stamped earlier");
    await store.addEvent(a, "warn", "stamped latest");
    raw.prepare("UPDATE events SET created_at = created_at - 100 WHERE agent_id = ? AND message = ?").run(a, "written later, stamped earlier");
    raw.prepare("UPDATE events SET created_at = created_at - 200 WHERE agent_id = ? AND message = ?").run(a, "stamped latest");
    assert.equal((await store.ownerNotice(a))?.message, "written later, stamped earlier");
  });

  it("another agent's warnings are not this owner's notice, and the time is when it was written", async () => {
    const a = agent();
    const b = agent();
    await store.addEvent(b, "warn", "not yours");
    assert.equal(await store.ownerNotice(a), null);
    const shown = await store.ownerNotice(b);
    assert.ok(shown && Math.abs(shown.atMs - Date.now()) < 5_000, `atMs ${shown?.atMs}`);
  });
});

describe("the idle channel on the real store", () => {
  const breaker: Why = { code: "breaker-tripped", limitBps: 1_000 };
  const underOne: Why = { code: "under-one-buy", cashRaw: 1_000_000n, needRaw: 5_000_000n, vaultRaw: 0n };
  // The factory the tick calls, so its binding to the store is run here.
  const channel = () => idleChannelOnStore();
  const decisions = (a: string) =>
    raw.prepare("SELECT source, action, symbol, size_usdg, reason FROM decisions WHERE agent_id = ?").all(a) as Record<string, unknown>[];

  it("A TRIPPED BREAKER COVERED BY THE COMMENTARY IS SAID AGAIN, and the desk shows it — no post either time", async () => {
    const a = agent();
    const ch = channel();
    await ch.tell({ agentId: a, strategyName: "steady-basket", idle: breaker, modeEmptied: null });
    assert.equal((await store.ownerNotice(a))?.message, renderWhy(breaker));
    for (let i = 0; i < 45; i++) await store.addEvent(a, "ok", `1 buy proposal(s) withheld ${i}`);
    assert.equal(await store.ownerNotice(a), null, "the one warning has aged out of the desk's read");
    await ch.tell({ agentId: a, strategyName: "steady-basket", idle: breaker, modeEmptied: null });
    assert.equal((await store.ownerNotice(a))?.message, renderWhy(breaker));
    await ch.tell({ agentId: a, strategyName: "steady-basket", idle: breaker, modeEmptied: null });
    const warns = raw.prepare("SELECT COUNT(*) AS c FROM events WHERE agent_id = ? AND level = 'warn'").get(a) as { c: number };
    assert.equal(warns.c, 2, "said again once, not once a tick");
    assert.deepEqual(decisions(a), []);
  });

  const TRIPPED = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 875_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });
  const CLEAR = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 990_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });
  const warnCount = (a: string) => (raw.prepare("SELECT COUNT(*) AS c FROM events WHERE agent_id = ? AND level = 'warn'").get(a) as { c: number }).c;

  it("TRIP, RESTATE, RESET on the real store: the desk says buying resumes, and nothing is written after it", async () => {
    const a = agent();
    const ch = channel();
    await ch.tell({ agentId: a, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    for (let i = 0; i < 45; i++) await store.addEvent(a, "ok", `1 buy proposal(s) withheld ${i}`);
    await ch.tell({ agentId: a, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal((await store.ownerNotice(a))?.message, renderWhy(breaker), "restated");
    await ch.tell({ agentId: a, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    assert.equal((await store.ownerNotice(a))?.message, breakerResetLine(null));
    const warns = warnCount(a);
    for (let i = 0; i < 3; i++) await ch.tell({ agentId: a, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    assert.equal(warnCount(a), warns);
    assert.deepEqual(decisions(a), []);
  });

  it("A WARN WRITTEN ONCE AFTER THE TRIP is carried by the restatement and the reset, on the real store", async () => {
    const a = agent();
    const ch = channel();
    const blocker = "NOT trading for real yet: your trading key is not active yet.";
    await ch.tell({ agentId: a, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    await store.addEvent(a, "warn", blocker);
    // The blocker has had its time on the desk: both rows stamped past the grace, in order.
    const back = Math.ceil(RESTATE_AFTER_MS / 1000) + 60;
    raw.prepare("UPDATE events SET created_at = created_at - ? WHERE agent_id = ? AND message = ?").run(back + 1, a, renderWhy(breaker));
    raw.prepare("UPDATE events SET created_at = created_at - ? WHERE agent_id = ? AND message = ?").run(back, a, blocker);
    await ch.tell({ agentId: a, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal((await store.ownerNotice(a))?.message, withEarlier(renderWhy(breaker), blocker));
    await ch.tell({ agentId: a, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(warnCount(a), 3, "our own carried line is not covered, so it is not said again");
    await ch.tell({ agentId: a, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    assert.equal((await store.ownerNotice(a))?.message, withEarlier(breakerResetLine(null), blocker));
  });

  it("A TRIP THAT STANDS ACROSS A RESTART is told by the new process on a tick that gives no reason, and its reset follows, on the real store", async () => {
    const a = agent();
    await channel().tell({ agentId: a, strategyName: "even-keel", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    const restarted = channel();
    for (let i = 0; i < 3; i++) await restarted.tell({ agentId: a, strategyName: "even-keel", idle: undefined, modeEmptied: null, drawdown: TRIPPED });
    assert.equal((await store.ownerNotice(a))?.message, renderWhy(breaker), "said again, not nested in the old line");
    assert.equal(warnCount(a), 2, "once");
    await restarted.tell({ agentId: a, strategyName: "even-keel", idle: null, modeEmptied: null, drawdown: CLEAR });
    assert.equal((await store.ownerNotice(a))?.message, breakerResetLine(null));
    await restarted.tell({ agentId: a, strategyName: "even-keel", idle: undefined, modeEmptied: null, drawdown: TRIPPED });
    assert.equal((await store.ownerNotice(a))?.message, renderWhy(breaker), "a silent re-trip takes the reset line down");
    assert.equal(warnCount(a), 4);
    assert.deepEqual(decisions(a), []);
  });

  it("A REASON THAT POSTS writes one row, in the public register, and is not said again", async () => {
    const a = agent();
    const ch = channel();
    await ch.tell({ agentId: a, strategyName: "steady-basket", idle: underOne, modeEmptied: null });
    for (let i = 0; i < 45; i++) await store.addEvent(a, "ok", `note ${i}`);
    await ch.tell({ agentId: a, strategyName: "steady-basket", idle: underOne, modeEmptied: null });
    const rows = decisions(a);
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0] }, { source: "strategy:steady-basket", action: null, symbol: null, size_usdg: null, reason: renderWhy(underOne, "public") });
    const said = raw.prepare("SELECT COUNT(*) AS c FROM events WHERE agent_id = ? AND message = ?").get(a, renderWhy(underOne)) as { c: number };
    assert.equal(said.c, 1);
  });
});
