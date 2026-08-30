import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * TWO INTENTS MUST NOT BE IN FLIGHT AT ONCE.
 *
 * index.ts already named half of this hazard, at the budget reservation: "a
 * chat trade interleaved with a tick could both pass checkPolicy against the
 * same stale spend figure and overshoot the daily cap by one action". The
 * reservation narrows that window and cannot close it — `state` is snapshotted,
 * `await scoutContextFor(intent)` yields BEFORE checkPolicy judges it, and
 * reserveBudget comes several awaits later still.
 *
 * The second half the reservation cannot touch at all: two concurrent
 * sendUserOperation calls read the same account nonce and the bundler drops one.
 *
 * The lock itself is exercised as a model below, because processIntent needs a
 * live grant, a chain and a database. The wiring — that the exported name is
 * the wrapper and not the body — is asserted against the source, which is the
 * part a refactor would silently undo.
 */

/** The wrapper as index.ts implements it. */
function makeSerializer() {
  let chain: Promise<unknown> = Promise.resolve();
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
}

test("overlapping calls run one at a time, in order", async () => {
  const run = makeSerializer();
  const log: string[] = [];
  const work = (id: string) => async () => {
    log.push(`${id}:start`);
    await new Promise((r) => setTimeout(r, 5));
    log.push(`${id}:end`);
  };
  // Fired together, the way a tick and a Telegram callback would.
  await Promise.all([run(work("a")), run(work("b")), run(work("c"))]);
  assert.deepEqual(log, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

test("no two bodies overlap even when each yields several times", async () => {
  // processIntent yields at scoutContextFor, at the quote, at the gas read, at
  // the receipt wait and at every ledger write. A lock that only covered the
  // synchronous head would be worthless.
  const run = makeSerializer();
  let inside = 0;
  let maxInside = 0;
  const work = async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 1));
    inside -= 1;
  };
  await Promise.all(Array.from({ length: 8 }, () => run(work)));
  assert.equal(maxInside, 1, "the whole body is the critical section, not its first await");
});

test("A THROWN INTENT MUST NOT POISON THE QUEUE", async () => {
  // The classic way a lock like this fails: the chain keeps the rejection and
  // every later caller inherits it. processIntent absorbs almost everything,
  // but "almost" is the word that matters for a lock.
  const run = makeSerializer();
  const results: string[] = [];
  const bad = run(async () => {
    throw new Error("boom");
  }).catch(() => results.push("bad rejected"));
  const good = run(async () => {
    results.push("good ran");
  });
  await Promise.all([bad, good]);
  assert.deepEqual(results, ["bad rejected", "good ran"]);
});

test("the rejection still reaches ITS OWN caller, not just the queue", async () => {
  const run = makeSerializer();
  await assert.rejects(
    run(async () => {
      throw new Error("boom");
    }),
    /boom/,
    "swallowing it here would hide a failure from the code that asked for the work",
  );
});

test("index.ts routes every caller through the wrapper", () => {
  const src = readFileSync("worker/src/index.ts", "utf8");
  // The body is renamed, so a call to the old name cannot bypass the lock by
  // accident — it would not compile. This asserts the shape survives a refactor.
  assert.match(src, /function processIntent\(intent: TradeIntent[\s\S]{0,400}?intentChain\.then\(/, "the exported name must be the wrapper");
  assert.match(src, /async function processIntentLocked\(/, "and the body must be separately named");

  // Every call site uses the wrapper. processIntentLocked is referenced exactly
  // twice — the two arms of the .then — and nowhere else.
  const locked = src.match(/processIntentLocked/g) ?? [];
  assert.equal(locked.length, 3, "declaration plus the two .then arms; a fourth would be a bypass");
});

test("no timeout, deliberately", () => {
  // A caller that gave up waiting would proceed into exactly the concurrency
  // this prevents. Unbounded waiting is the correct behaviour here, and this
  // pins it so nobody "fixes" it later.
  const src = readFileSync("worker/src/index.ts", "utf8");
  const region = src.slice(src.indexOf("let intentChain"), src.indexOf("async function processIntentLocked"));
  assert.equal(/setTimeout|race|timeout/i.test(region), false, "a timed-out lock is not a lock");
});
