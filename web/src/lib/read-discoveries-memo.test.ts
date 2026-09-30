/**
 * THE DISCOVERIES MEMO SERVES WHAT IT HAS WHILE IT FETCHES WHAT IS NEXT.
 *
 * It had no stale arm, so the first caller after the two-minute life waited for
 * the whole rebuild — a sweep, three enrichment reads and a model call, 10-12s
 * cold in production — and the terminal's feed waited behind it. These run the
 * memo's own rules (payloadMemo) against builds that resolve when told, with a
 * fake clock, because the property is who waits for what.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { payloadMemo } from "./read-discoveries";

type P = { payload: { degraded: boolean }; tag: string };
const whole = (tag: string): P => ({ payload: { degraded: false }, tag });
const degraded = (tag: string): P => ({ payload: { degraded: true }, tag });

/** A build per call that resolves (or fails) only when the test says so. */
function memo() {
  let clock = 1_000_000;
  const pending: Array<{ resolve: (v: P) => void; reject: (e: Error) => void }> = [];
  const m = payloadMemo<P>(
    () => new Promise<P>((resolve, reject) => pending.push({ resolve, reject })),
    () => clock,
  );
  return {
    m,
    builds: () => pending.length,
    finish: (i: number, v: P) => pending[i]!.resolve(v),
    fail: (i: number) => pending[i]!.reject(new Error("upstream refused")),
    advance: (ms: number) => (clock += ms),
  };
}
const settle = () => new Promise<void>((r) => setImmediate(r));
const tagOf = async (p: Promise<P>) => (await p).tag;

describe("the discoveries memo has a stale arm", () => {
  it("a cold memo waits for its first build — there is nothing to serve", async () => {
    const { m, finish } = memo();
    let got: string | null = null;
    void m.get().then((v) => (got = v.tag));
    await settle();
    assert.equal(got, null, "no answer exists yet, so nobody is handed one");
    finish(0, whole("first"));
    await settle();
    assert.equal(got, "first");
  });

  it("a whole answer is served for its two minutes without a rebuild", async () => {
    const { m, finish, builds, advance } = memo();
    const first = m.get();
    finish(0, whole("first"));
    await first;
    advance(119_000);
    assert.equal(await tagOf(m.get()), "first");
    assert.equal(builds(), 1);
  });

  it("AN EXPIRED ANSWER IS SERVED AT ONCE while exactly one rebuild runs", async () => {
    const { m, finish, builds, advance } = memo();
    const first = m.get();
    finish(0, whole("first"));
    await first;
    advance(121_000);
    // The whole point: these resolve now, not when the 12-second rebuild does.
    assert.equal(await tagOf(m.get()), "first");
    assert.equal(await tagOf(m.get()), "first");
    assert.equal(await tagOf(m.get()), "first");
    assert.equal(builds(), 2, "three callers past the life started ONE rebuild between them");
    assert.equal(m.rebuilding(), true);
    finish(1, whole("second"));
    await settle();
    assert.equal(await tagOf(m.get()), "second", "and the next caller gets what it built");
    assert.equal(m.rebuilding(), false);
  });

  it("an answer too old to pass for current is waited on, not served", async () => {
    const { m, finish, advance } = memo();
    const first = m.get();
    finish(0, whole("first"));
    await first;
    advance(10 * 60_000 + 1);
    let got: string | null = null;
    void m.get().then((v) => (got = v.tag));
    await settle();
    assert.equal(got, null, "ten minutes old is a different answer, not a late one");
    finish(1, whole("second"));
    await settle();
    assert.equal(got, "second");
  });

  it("a failed rebuild keeps the last answer, and the next caller tries once more", async () => {
    const { m, finish, fail, builds, advance } = memo();
    const first = m.get();
    finish(0, whole("first"));
    await first;
    advance(121_000);
    assert.equal(await tagOf(m.get()), "first");
    fail(1);
    await settle();
    assert.equal(m.rebuilding(), false, "the failure ended the rebuild");
    assert.equal(await tagOf(m.get()), "first", "the stale answer is still served");
    assert.equal(builds(), 3, "and one new rebuild is under way");
  });

  it("a caller that had to wait is handed the failure, as before", async () => {
    const { m, fail } = memo();
    const cold = m.get();
    fail(0);
    await assert.rejects(cold, /upstream refused/);
  });

  it("a degraded answer keeps its ten-second life, and still does not make anybody wait", async () => {
    const { m, finish, builds, advance } = memo();
    const first = m.get();
    finish(0, degraded("blink"));
    await first;
    advance(9_000);
    await m.get();
    assert.equal(builds(), 1, "inside its ten seconds");
    advance(2_000);
    assert.equal(await tagOf(m.get()), "blink", "served while the retry runs");
    assert.equal(builds(), 2, "and the retry is under way after ten seconds, not two minutes");
    finish(1, whole("recovered"));
    await settle();
    advance(60_000);
    assert.equal(await tagOf(m.get()), "recovered");
    assert.equal(builds(), 2, "a whole answer then lives its two minutes");
  });
});
