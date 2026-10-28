import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiscoveryTiming, type DiscoveryTimingEvent } from "./discovery-timing";

function fakeClock() {
  let at = 0;
  const timers = new Map<() => void, number>();
  return {
    now: () => at,
    schedule(callback: () => void, delayMs: number) {
      timers.set(callback, at + delayMs);
      return () => { timers.delete(callback); };
    },
    advance(ms: number) {
      at += ms;
      for (const [callback, due] of timers) {
        if (due <= at) { timers.delete(callback); callback(); }
      }
    },
    pending: () => timers.size,
  };
}

test("fast reads keep their result, run once and leave no timer or log behind", async () => {
  const clock = fakeClock();
  const events: DiscoveryTimingEvent[] = [];
  const timing = createDiscoveryTiming(clock, event => events.push(event));
  const result = { accounts: ["must-not-be-logged"] };
  let calls = 0;
  assert.equal(await timing.measure("identities", async () => { calls++; clock.advance(999); return result; }), result);
  assert.equal(calls, 1);
  assert.equal(clock.pending(), 0);
  clock.advance(10_000);
  assert.deepEqual(events, []);
});

test("a still-hanging read reports its stage, then its eventual completion exactly once", async () => {
  const clock = fakeClock();
  const events: DiscoveryTimingEvent[] = [];
  const timing = createDiscoveryTiming(clock, event => events.push(event));
  let resolve!: (value: string) => void;
  const read = timing.measure("registrations", () => new Promise<string>(done => { resolve = done; }));
  clock.advance(999);
  assert.deepEqual(events, []);
  clock.advance(1);
  assert.deepEqual(events, [{ stage: "registrations", durationMs: 1000, outcome: "pending" }]);
  clock.advance(29_000);
  assert.equal(events.length, 1, "one threshold receipt, not an interval flooding logs");
  resolve("private-result");
  assert.equal(await read, "private-result");
  assert.deepEqual(events[1], { stage: "registrations", durationMs: 30_000, outcome: "ok" });
  assert.equal(clock.pending(), 0);
  clock.advance(10_000);
  assert.equal(events.length, 2);
});

test("slow errors preserve the original rejection and never log its payload", async () => {
  const clock = fakeClock();
  const events: DiscoveryTimingEvent[] = [];
  const timing = createDiscoveryTiming(clock, event => events.push(event));
  const failure = new Error("postgres://secret-host/password SELECT * FROM agent_identity tenant=private");
  let reject!: (error: Error) => void;
  const read = timing.measure("identities", () => new Promise<never>((_done, fail) => { reject = fail; }));
  const rejected = assert.rejects(read, error => error === failure);
  clock.advance(1500);
  reject(failure);
  await rejected;
  assert.deepEqual(events, [
    { stage: "identities", durationMs: 1500, outcome: "pending" },
    { stage: "identities", durationMs: 1500, outcome: "error" },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /postgres|secret|password|SELECT|tenant|private/);
  assert.equal(clock.pending(), 0);
});

test("a synchronous failure cancels its threshold timer without changing the error", async () => {
  const clock = fakeClock();
  const events: DiscoveryTimingEvent[] = [];
  const timing = createDiscoveryTiming(clock, event => events.push(event));
  const failure = new Error("original");
  await assert.rejects(timing.measure("heartbeat", () => { throw failure; }), error => error === failure);
  assert.equal(clock.pending(), 0);
  clock.advance(10_000);
  assert.deepEqual(events, []);
});

test("logging failure cannot fail a read and a stage cannot finish twice", async () => {
  const clock = fakeClock();
  let logs = 0;
  const timing = createDiscoveryTiming(clock, () => { logs++; throw new Error("log sink unavailable"); });
  const finish = timing.start("read-db");
  clock.advance(1000);
  finish("ok");
  finish("error");
  assert.equal(logs, 2);
  assert.equal(clock.pending(), 0);
  assert.equal(await timing.measure("holds", async () => { clock.advance(1000); return 7; }), 7);
});
