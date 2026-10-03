import assert from "node:assert/strict";
import { test } from "node:test";
import { CoalescedRefresh } from "./coalesced-refresh";

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => {
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>(r => { resolve = r; });
  return { promise, resolve };
};

test("a nomination arriving during an earlier page read gets one subsequent pass with the new set", async () => {
  const nominated = new Set(["first"]);
  const reads: string[][] = [];
  const first = deferred();
  const refresh = new CoalescedRefresh({ run: async () => {
    reads.push([...nominated]);
    return reads.length === 1 ? first.promise : true;
  } });
  refresh.request();
  await settle();
  nominated.add("second");
  refresh.request();
  refresh.request();
  assert.deepEqual(reads, [["first"]], "no overlapping read pass");
  first.resolve(true);
  await settle();
  assert.deepEqual(reads, [["first"], ["first", "second"]], "one follow-up observes the latest nominations");
  assert.equal(refresh.busy(), false);
});

test("failed discovery defers its coalesced follow-up until the retry delay", async () => {
  let now = 0;
  let reads = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  const first = deferred();
  const refresh = new CoalescedRefresh({ now: () => now, retryMs: 60_000,
    setTimer: (fn, ms) => { timers.set(++seq, { fn, at: now + ms }); return seq; },
    clearTimer: handle => { timers.delete(handle as number); },
    run: async () => (++reads === 1 ? first.promise : true),
  });
  refresh.request();
  await settle();
  refresh.request();
  first.resolve(false);
  await settle();
  for (let i = 0; i < 100; i++) refresh.request();
  assert.equal(reads, 1, "requests cannot hammer a failed provider");
  assert.equal(timers.size, 1, "one scheduled follow-up");
  const [id, timer] = [...timers.entries()][0]!;
  assert.equal(timer.at, 60_000);
  now = timer.at;
  timers.delete(id);
  timer.fn();
  await settle();
  assert.equal(reads, 2);
  assert.equal(refresh.busy(), false);
});

test("a failed pass without new evidence does not automatically retry", async () => {
  let reads = 0;
  const refresh = new CoalescedRefresh({ run: async () => { reads++; throw new Error("read failed"); } });
  refresh.request();
  await settle();
  assert.equal(reads, 1);
  assert.equal(refresh.busy(), false);
});
