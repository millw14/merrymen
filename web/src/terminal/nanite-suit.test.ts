import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { naniteTimeline, playNanites, type NaniteOptions } from "./nanite-suit";

// No 2D context, as in jsdom or a browser that refuses one: the engine must
// still keep its promise to the host on timers alone.
const blind = { getContext: () => null } as unknown as HTMLCanvasElement;

function play(overrides: Partial<NaniteOptions> & Pick<NaniteOptions, "dramatic" | "duration">) {
  const calls: string[] = [];
  const handle = playNanites({
    canvas: blind, origin: { x: 10, y: 10 }, direction: "perps", seed: 7,
    onCovered: () => calls.push("covered"), onDone: () => calls.push("done"),
    ...overrides,
  });
  return { calls, handle };
}

describe("nanite suit timeline", () => {
  for (const dramatic of [true, false]) {
    it(`orders its phases for the ${dramatic ? "dramatic" : "quick"} switch`, () => {
      const tl = naniteTimeline(dramatic);
      assert.ok(tl.coverStart <= tl.coveredAt, "the armour starts pouring before it is complete");
      assert.ok(tl.coveredAt < tl.revealStart, "the frozen screen is hidden before any plate flips away");
      assert.ok(tl.revealStart < tl.duration, "the reveal finishes inside the run");
      assert.ok(tl.lastPop + tl.popDur <= tl.coveredAt, "every plate has landed by the cover instant");
      assert.ok(tl.lastFlip + tl.flipDur <= tl.duration, "every plate has flipped away by the end");
      const scaled = naniteTimeline(dramatic, tl.duration * 2);
      assert.equal(scaled.coveredAt, tl.coveredAt * 2, "a longer run stretches every phase");
      assert.equal(scaled.revealStart, tl.revealStart * 2);
    });
  }
  it("keeps the measured nominal timings", () => {
    const dramatic = naniteTimeline(true);
    assert.deepEqual([dramatic.duration, dramatic.coveredAt, dramatic.revealStart], [2600, 1180, 1760]);
    const quick = naniteTimeline(false);
    assert.deepEqual([quick.duration, quick.coveredAt, quick.revealStart], [950, 430, 505]);
  });
});

describe("nanite suit without a 2D context", () => {
  it("reports cover then completion exactly once each, on the timeline", context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { calls } = play({ dramatic: false, duration: 950 });
    context.mock.timers.tick(429);
    assert.deepEqual(calls, []);
    context.mock.timers.tick(1);
    assert.deepEqual(calls, ["covered"]);
    context.mock.timers.tick(519);
    assert.deepEqual(calls, ["covered"]);
    context.mock.timers.tick(1);
    assert.deepEqual(calls, ["covered", "done"]);
    context.mock.timers.tick(10_000);
    assert.deepEqual(calls, ["covered", "done"]);
  });
  it("uses the dramatic cover instant", context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { calls } = play({ dramatic: true, duration: 2600, direction: "spot" });
    context.mock.timers.tick(1179);
    assert.deepEqual(calls, []);
    context.mock.timers.tick(1);
    assert.deepEqual(calls, ["covered"]);
    context.mock.timers.tick(1420);
    assert.deepEqual(calls, ["covered", "done"]);
  });
  it("calls nothing after cancel", context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { calls, handle } = play({ dramatic: true, duration: 2600 });
    context.mock.timers.tick(100);
    handle.cancel();
    context.mock.timers.tick(10_000);
    assert.deepEqual(calls, []);
    assert.doesNotThrow(() => handle.drawAt(1500), "drawing without a context is a no-op");
  });
  it("cancel after cover suppresses completion", context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { calls, handle } = play({ dramatic: false, duration: 950 });
    context.mock.timers.tick(430);
    handle.cancel();
    handle.cancel();
    context.mock.timers.tick(10_000);
    assert.deepEqual(calls, ["covered"]);
  });
});
