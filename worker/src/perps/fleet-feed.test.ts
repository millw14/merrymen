/**
 * The orchestrator's one public perps feed (fleet-feed.ts): one socket for the
 * replica, only while MERRYMEN_PERPS=paper and nothing halts it, and a failed
 * read never blanks what it carries. Offline: `start` and `api` are seams.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import type { MerrymenSettings } from "../../../packages/core/src/index";
import { createFleetPerpFeed } from "./fleet-feed";
import type { LighterFeedOptions } from "./feed";

const HOME = "/tmp/offline-fleet";

function setup() {
  let halted = false;
  let enabled = true;
  let failSettings = false;
  let failHeld = false;
  let stops = 0;
  let settings: MerrymenSettings[] = [{ perpsEnabled: true, perpsMarkets: ["BTC-PERP", "ETH-PERP"] }];
  let held: number[] = [];
  const starts: LighterFeedOptions[] = [];
  const logs: string[] = [];
  const feed = createFleetPerpFeed({
    home: HOME,
    enabled: () => enabled,
    halted: () => halted,
    env: () => ({ MERRYMEN_PERPS: enabled ? "paper" : "off" }),
    readSettings: async () => {
      if (failSettings) throw new Error("settings unread");
      return settings;
    },
    readHeld: async () => {
      if (failHeld) throw new Error("ledger unread");
      return held;
    },
    api: () => ({ budgetKey: "public" }) as unknown as LighterFeedOptions["api"],
    start: (options) => {
      starts.push(options);
      return { stop: () => { stops += 1; } };
    },
    log: (line) => logs.push(line),
  });
  return {
    feed, starts, logs,
    stops: () => stops,
    set: (s: MerrymenSettings[], h: number[] = []) => { settings = s; held = h; },
    enable: (x: boolean) => { enabled = x; },
    halt: (x: boolean) => { halted = x; },
    failSettings: (x: boolean) => { failSettings = x; },
    failHeld: (x: boolean) => { failHeld = x; },
  };
}

describe("the orchestrator's fleet perps publisher", () => {
  it("starts ONE public feed for the replica's Perps workers, into the fleet home's file, and follows the union without another socket", async () => {
    const t = setup();
    await Promise.all([t.feed.refresh(), t.feed.refresh()]);
    assert.equal(t.starts.length, 1, "two refreshes at once start one feed");
    assert.deepEqual(t.starts[0]!.marketIds(), [0, 1]);
    assert.equal(t.starts[0]!.home, HOME);
    assert.equal(t.starts[0]!.outPath, path.join(HOME, "lighter-feed.json"));
    // A held market rides along (and gets its funding history), and an id outside the table is dropped.
    t.set([{ perpsEnabled: true, perpsMarkets: ["SOL-PERP"] }], [1, 99_999]);
    await t.feed.refresh();
    assert.equal(t.starts.length, 1);
    assert.deepEqual(t.starts[0]!.marketIds(), [1, 3], "SOL wanted (3), BTC held (1)");
    assert.deepEqual(t.starts[0]!.heldMarketIds!(), [1]);
    t.feed.stop();
    assert.equal(t.stops(), 1);
  });

  it("WITH MERRYMEN_PERPS NOT paper, NOTHING STARTS, whatever is held, and a running feed stops", async () => {
    const t = setup();
    t.enable(false);
    t.set([{ perpsEnabled: true, perpsMarkets: ["BTC-PERP"] }], [1]);
    await t.feed.refresh();
    assert.equal(t.starts.length, 0, "no socket, no request");
    t.enable(true);
    await t.feed.refresh();
    assert.equal(t.starts.length, 1);
    t.enable(false);
    await t.feed.refresh();
    assert.equal(t.feed.running, false);
    assert.equal(t.stops(), 1);
  });

  it("an owner with perps switched off adds no market; the last consumer leaving stops the feed", async () => {
    const t = setup();
    t.set([{ perpsEnabled: false, perpsMarkets: ["BTC-PERP"] }]);
    await t.feed.refresh();
    assert.equal(t.starts.length, 0);
    t.set([{ perpsEnabled: false }], [3]);
    await t.feed.refresh();
    assert.deepEqual(t.starts[0]!.marketIds(), [3], "what a book holds is carried");
    t.set([], []);
    await t.feed.refresh();
    assert.equal(t.feed.running, false);
    assert.equal(t.stops(), 1);
  });

  it("FLEET_HALT pauses it and lifting the halt starts it once; shutdown prevents every restart", async () => {
    const t = setup();
    await t.feed.refresh();
    t.halt(true);
    await t.feed.refresh();
    assert.equal(t.feed.running, false);
    assert.equal(t.stops(), 1);
    t.halt(false);
    await t.feed.refresh();
    assert.equal(t.starts.length, 2);
    t.feed.pause();
    assert.equal(t.stops(), 2);
    await t.feed.refresh();
    assert.equal(t.starts.length, 3, "a pause is for now");
    t.feed.stop();
    t.feed.stop();
    await t.feed.refresh();
    assert.equal(t.starts.length, 3, "a stop is for good");
    assert.equal(t.stops(), 3);
  });

  it("A FAILED READ KEEPS WHAT IT HAD, each half on its own, and says so once", async () => {
    const t = setup();
    // BTC is 1, ETH 0, SOL 3, TSLA 16.
    t.set([{ perpsEnabled: true, perpsMarkets: ["BTC-PERP"] }], [16]);
    await t.feed.refresh();
    assert.deepEqual(t.starts[0]!.marketIds(), [1, 16]);
    t.failHeld(true);
    t.set([{ perpsEnabled: true, perpsMarkets: ["ETH-PERP"] }], []);
    await t.feed.refresh();
    await t.feed.refresh();
    assert.deepEqual(t.starts[0]!.marketIds(), [0, 16], "the held half kept; the settings half moved");
    t.failHeld(false);
    t.failSettings(true);
    await t.feed.refresh();
    assert.deepEqual(t.starts[0]!.marketIds(), [0], "and the other way round");
    assert.equal(t.starts.length, 1);
    assert.equal(t.logs.filter((l) => l.includes("kept its last held markets")).length, 1, "said once, not every pass");
    t.feed.stop();
  });

  it("a stop while a refresh awaits its targets can never start a socket, and a refresh never rejects", async () => {
    let resolve!: (x: MerrymenSettings[]) => void;
    let starts = 0;
    const f = createFleetPerpFeed({
      home: HOME, enabled: () => true, halted: () => false,
      readSettings: () => new Promise((r) => { resolve = r; }),
      readHeld: async () => [],
      env: () => ({ MERRYMEN_PERPS: "paper" }),
      api: () => ({ budgetKey: "public" }) as unknown as LighterFeedOptions["api"],
      start: () => { starts += 1; return { stop() {} }; },
    });
    const running = f.refresh();
    await new Promise((r) => setImmediate(r));
    f.stop();
    resolve([{ perpsEnabled: true, perpsMarkets: ["BTC-PERP"] }]);
    await running;
    assert.equal(starts, 0);
    const boom = createFleetPerpFeed({
      home: HOME, enabled: () => true, halted: () => false,
      readSettings: async () => [{ perpsEnabled: true, perpsMarkets: ["BTC-PERP"] }],
      readHeld: async () => [],
      env: () => ({ MERRYMEN_PERPS: "paper" }),
      api: () => ({ budgetKey: "public" }) as unknown as LighterFeedOptions["api"],
      start: () => { throw new Error("no socket"); },
    });
    await boom.refresh();
    assert.equal(boom.running, false);
  });
});
