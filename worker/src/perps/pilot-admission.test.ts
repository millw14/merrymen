import assert from "node:assert/strict";
import { test } from "node:test";
import { PerpsPilotAdmission } from "./pilot-admission";
import type { PerpsPilotSnapshot } from "./pilot-store";

const A = `0x${"ab".repeat(20)}` as const;
const B = `0x${"cd".repeat(20)}` as const;
const snapshot = (owners: readonly `0x${string}`[] = [A], revision = 1): PerpsPilotSnapshot => ({ owners, revision });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("only a complete fresh snapshot admits an owner; changed membership restricts before refresh returns", async () => {
  let value = snapshot();
  const observations: boolean[] = [];
  const cache = new PerpsPilotAdmission({ read: async () => value, onRestriction: () => { observations.push(cache.allowed(A)); } });
  assert.equal(cache.allowed(A), false);
  assert.equal(await cache.refresh(), true);
  assert.equal(cache.allowed(A.toUpperCase().replace("0X", "0x")), true);
  assert.equal(cache.allowed(B), false);
  assert.equal(cache.allowed("owner"), false);
  value = snapshot([B], 2);
  assert.equal(await cache.refresh(true), true);
  assert.deepEqual(observations, [true, false]);
  assert.equal(cache.allowed(B), true);
  cache.stop();
});

test("read failures immediately revoke the last good permission without an environment fallback", async () => {
  let fail = false;
  const cache = new PerpsPilotAdmission({ read: async () => { if (fail) throw new Error("offline"); return snapshot(); }, onRestriction() {} });
  await cache.refresh();
  assert.equal(cache.allowed(A), true);
  fail = true;
  assert.equal(await cache.refresh(true), false);
  assert.equal(cache.allowed(A), false);
  cache.stop();
});

test("a changed revision invalidates delivered permission even when revoke and re-admit leave the same owners", async () => {
  let value = snapshot();
  const revisions: Array<number | null> = [];
  const cache = new PerpsPilotAdmission({ read: async () => value, onRestriction: () => { revisions.push(cache.revision()); } });
  assert.equal(cache.revision(), null);
  await cache.refresh();
  value = snapshot([A], 3);
  await cache.refresh(true);
  assert.deepEqual(revisions, [1, 3]);
  assert.equal(cache.allowed(A), true);
  cache.stop();
  assert.equal(cache.revision(), null);
});

test("a synchronous final check expires permission even when the refresh clock has not run", async () => {
  let now = 100;
  let restrictions = 0;
  const cache = new PerpsPilotAdmission({ read: async () => snapshot(), now: () => now, maxAgeMs: 20, onRestriction: () => { restrictions++; } });
  await cache.refresh();
  now = 119;
  assert.equal(cache.allowed(A), true);
  now = 120;
  assert.equal(cache.allowed(A), false);
  assert.equal(restrictions, 2);
  cache.stop();
});

test("snapshot age starts with the query and slow responses never renew permission", async () => {
  let now = 0;
  const read = deferred<PerpsPilotSnapshot>();
  const cache = new PerpsPilotAdmission({ read: () => read.promise, now: () => now, maxAgeMs: 20, timeoutMs: 100, onRestriction() {} });
  const result = cache.refresh();
  now = 20;
  read.resolve(snapshot());
  assert.equal(await result, false);
  assert.equal(cache.allowed(A), false);
  cache.stop();
});

test("a query timeout invalidates permission, retains physical singleflight, and discards its late answer", async () => {
  let calls = 0;
  let restrictions = 0;
  const hanging = deferred<PerpsPilotSnapshot>();
  const cache = new PerpsPilotAdmission({ read: () => { calls++; return calls === 2 ? hanging.promise : Promise.resolve(snapshot()); },
    refreshMs: 1, timeoutMs: 20, onRestriction: () => { restrictions++; } });
  await cache.refresh();
  const timedOut = cache.refresh(true);
  assert.equal(await timedOut, false);
  assert.equal(cache.allowed(A), false);
  assert.equal(restrictions, 2);
  for (let n = 0; n < 20; n++) assert.equal(await cache.refresh(true), false);
  assert.equal(calls, 2, "one stalled query cannot amplify into a query per child or clock tick");
  hanging.resolve(snapshot([B], 2));
  await flush();
  assert.equal(cache.allowed(B), false, "the timed-out result cannot repopulate the cache");
  assert.equal(await cache.refresh(true), true);
  assert.equal(cache.allowed(A), true);
  cache.stop();
});

test("refreshes are shared and frequency bounded", async () => {
  let now = 0, calls = 0;
  const first = deferred<PerpsPilotSnapshot>();
  const cache = new PerpsPilotAdmission({ read: () => { calls++; return calls === 1 ? first.promise : Promise.resolve(snapshot()); },
    now: () => now, refreshMs: 10, onRestriction() {} });
  const one = cache.refresh(), two = cache.refresh();
  assert.equal(one, two);
  first.resolve(snapshot());
  await one;
  for (let n = 0; n < 20; n++) await cache.refresh();
  assert.equal(calls, 1);
  now = 10;
  await cache.refresh();
  assert.equal(calls, 2);
  cache.stop();
});

test("the independent timer withdraws permission while unrelated work is waiting", async () => {
  let calls = 0;
  const restricted = deferred<void>();
  const cache = new PerpsPilotAdmission({ read: async () => snapshot(calls++ === 0 ? [A] : [], calls), refreshMs: 5,
    onRestriction: () => { if (!cache.allowed(A)) restricted.resolve(); } });
  cache.start();
  await cache.refresh();
  assert.equal(cache.allowed(A), true);
  const deadline = setTimeout(() => restricted.reject(new Error("independent restriction did not run")), 1_000);
  try { await restricted.promise; } finally { clearTimeout(deadline); cache.stop(); }
  assert.equal(cache.allowed(A), false);
});

test("stop prevents an in-flight response from restoring admission", async () => {
  const read = deferred<PerpsPilotSnapshot>();
  const cache = new PerpsPilotAdmission({ read: () => read.promise, onRestriction() {} });
  const result = cache.refresh();
  cache.stop();
  assert.equal(await result, false);
  read.resolve(snapshot());
  await flush();
  assert.equal(cache.allowed(A), false);
});

for (const [name, bad] of [
  ["malformed owner", { owners: ["not-an-owner"], revision: 2 }],
  ["noncanonical owner", { owners: [A.toUpperCase()], revision: 2 }],
  ["duplicate owners", { owners: [A, A], revision: 2 }],
  ["oversized cohort", { owners: Array(101).fill(A), revision: 2 }],
  ["unsafe revision", { owners: [A], revision: Number.MAX_SAFE_INTEGER + 1 }],
  ["regressed revision", { owners: [A], revision: 0 }],
  ["changed membership without revision", { owners: [B], revision: 1 }],
] as const) {
  test(`${name} fails closed instead of retaining a previous positive snapshot`, async () => {
    let value = snapshot();
    const cache = new PerpsPilotAdmission({ read: async () => value, onRestriction() {} });
    await cache.refresh();
    value = bad as unknown as PerpsPilotSnapshot;
    assert.equal(await cache.refresh(true), false);
    assert.equal(cache.allowed(A), false);
    assert.equal(cache.allowed(B), false);
    cache.stop();
  });
}

test("a restriction callback failure cannot leave a pending refresh or positive permission", async () => {
  const cache = new PerpsPilotAdmission({ read: async () => snapshot(), onRestriction: () => { throw new Error("delivery unavailable"); } });
  assert.equal(await cache.refresh(), false);
  assert.equal(cache.allowed(A), false);
  cache.stop();
});
