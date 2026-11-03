import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, beforeEach, test } from "node:test";
import { capturePublicFeed, publicFeedOnly, readPublicFeedFrame } from "./capture-public-feed";
import { runPerpsReplay, type PerpsReplayConfig, type PerpsReplayFrame } from "./backtest";
import { specToJson, type LighterFeedFile } from "./feed-reader";
import { marketView, NOW_SEC, breakout } from "./testkit-perps";

const AT = (NOW_SEC + 120) * 1000;
const homes: string[] = [];
let home: string, source: string;
function feed(at = AT): LighterFeedFile {
  const mark = 805000n, endHour = Math.floor(at / 3_600_000) * 3600;
  return { v: 1, observedAt: at, markets: { "1": {
    observedAt: at, priceSource: "ws", mark: String(mark), index: String(mark), fundingRatePctPerHour: "0.0010",
    status: "active", spec: specToJson(marketView("BTC-PERP").spec), specObservedAt: at, takerFeePpm: 200, makerFeePpm: 0,
    bids: [[String(mark - 1n), "100000"]], asks: [[String(mark + 1n), "100000"]], bookSource: "ws", bookObservedAt: at,
    closed4h: breakout("BTC-PERP", 5000n).map(c => ({ t: c.t, o: String(c.o), h: String(c.h), l: String(c.l), c: String(c.c) })), candlesObservedAt: at,
    fundings1h: Array.from({ length: 12 }, (_, i) => ({ t: endHour - (11 - i) * 3600, rate: "0.0010", direction: "long" })), fundingsObservedAt: at,
  } } };
}
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "merrymen-public-capture-")); homes.push(home); source = path.join(home, "lighter-feed.json"); writeFileSync(source, JSON.stringify(feed())); });
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });
const options = () => ({ source, output: path.join(home, "capture"), samples: 3, intervalMs: 1000, optIn: "1" });

test("records unchanged public snapshots with their actual read clocks and replays deterministically", async () => {
  let now = AT;
  const optionsValue = options();
  const result = await capturePublicFeed(optionsValue, { now: () => now, wait: async ms => { now += ms; } });
  assert.equal(result.complete, true); assert.equal(result.unreadFrames, 0);
  const replay = JSON.parse(readFileSync(path.join(optionsValue.output, "replay.json"), "utf8")) as { config: PerpsReplayConfig; frames: PerpsReplayFrame[] };
  assert.deepEqual(replay.frames.map(frame => frame.atMs), [AT, AT + 1000, AT + 2000]);
  assert.deepEqual(replay.frames.map(frame => frame.feed), [feed(), feed(), feed()], "capture never rewrites feed observation times");
  assert.equal(statSync(optionsValue.output).mode & 0o777, 0o700); assert.equal(statSync(path.join(optionsValue.output, "replay.json")).mode & 0o777, 0o600);
  const first = runPerpsReplay(replay.config, replay.frames); assert.equal(first.complete, true); assert.deepEqual(first, runPerpsReplay(replay.config, replay.frames));
  assert.equal(readFileSync(path.join(optionsValue.output, "frames.ndjson"), "utf8").trim().split("\n").length, 3);
});

test("a missing frame is kept as an unread gap and stops replay before inventing continuity", async () => {
  let now = AT;
  const optionsValue = options();
  const result = await capturePublicFeed(optionsValue, { now: () => now, wait: async ms => { now += ms; if (now === AT + 1000) rmSync(source); else writeFileSync(source, JSON.stringify(feed(now))); } });
  assert.equal(result.complete, true); assert.equal(result.unreadFrames, 1);
  const replay = JSON.parse(readFileSync(path.join(optionsValue.output, "replay.json"), "utf8"));
  assert.equal(replay.frames[1].feed, null); assert.ok(replay.frames[2].feed);
  const outcome = runPerpsReplay(replay.config, replay.frames); assert.equal(outcome.complete, false); assert.equal(outcome.finalEquityMicro, null); assert.equal(outcome.failure?.atMs, AT + 1000);
});

test("refuses unexpected fields at every nested level and never persists their contents", async () => {
  const malicious = feed() as unknown as Record<string, any>;
  for (const contaminate of [
    (v: typeof malicious) => { v.privateKey = "DO-NOT-RECORD"; },
    (v: typeof malicious) => { v.markets["1"].token = "DO-NOT-RECORD"; },
    (v: typeof malicious) => { v.markets["1"].spec.secret = "DO-NOT-RECORD"; },
    (v: typeof malicious) => { v.markets["1"].closed4h[0].password = "DO-NOT-RECORD"; },
    (v: typeof malicious) => { v.markets["1"].fundings1h[0].credential = "DO-NOT-RECORD"; },
  ]) { const changed = structuredClone(malicious); contaminate(changed); assert.equal(publicFeedOnly(changed, AT), false); }
  malicious.privateKey = "DO-NOT-RECORD"; writeFileSync(source, JSON.stringify(malicious));
  const o = { ...options(), samples: 1 }; await capturePublicFeed(o, { now: () => AT, wait: async () => {} });
  for (const name of ["frames.ndjson", "replay.json", "capture.json"]) assert.doesNotMatch(readFileSync(path.join(o.output, name), "utf8"), /DO-NOT-RECORD|privateKey/);
});

test("opt-in, bounded arguments and a fresh destination precede recording", async () => {
  for (const change of [{ optIn: undefined }, { samples: 8641 }, { samples: 0 }, { intervalMs: 999 }, { intervalMs: 60001 }, { samples: 8640, intervalMs: 60000 }, { source: path.join(home, "grant.json") }]) await assert.rejects(capturePublicFeed({ ...options(), ...change }));
  const o = { ...options(), samples: 1 }; await capturePublicFeed(o, { now: () => AT, wait: async () => {} });
  const before = readFileSync(path.join(o.output, "replay.json")); await assert.rejects(capturePublicFeed(o)); assert.deepEqual(readFileSync(path.join(o.output, "replay.json")), before);
});

test("oversized, symlinked, invalid and future feeds become unread frames", () => {
  writeFileSync(source, "x".repeat(1_048_577)); assert.equal(readPublicFeedFrame(source, AT).feed, null);
  writeFileSync(source, JSON.stringify(feed(AT + 1000))); assert.equal(readPublicFeedFrame(source, AT).feed, null);
  writeFileSync(source, "{broken"); assert.equal(readPublicFeedFrame(source, AT).feed, null);
  rmSync(source); const target = path.join(home, "private.json"); writeFileSync(target, JSON.stringify(feed())); symlinkSync(target, source); assert.equal(readPublicFeedFrame(source, AT).feed, null);
});

test("interruption finalizes a partial recording; backwards clocks never get fabricated timestamps", async () => {
  const stop = new AbortController();
  const a = await capturePublicFeed({ ...options(), signal: stop.signal }, { now: () => AT, wait: async () => { stop.abort(); } });
  assert.equal(a.reason, "interrupted"); assert.equal(a.frames, 1); assert.equal(a.complete, false);
  const b = await capturePublicFeed({ ...options(), output: path.join(home, "clock") }, { now: () => AT, wait: async () => {} });
  assert.equal(b.reason, "clock-invalid"); assert.equal(b.frames, 1); assert.equal(b.complete, false);
});


test("the opt-in CLI produces replay input accepted by the offline CLI without a worker or network", () => {
  writeFileSync(source, JSON.stringify(feed(Date.now())));
  const output = path.join(home, "cli");
  const cli = fileURLToPath(new URL("./capture-public-feed-cli.ts", import.meta.url));
  const env = { ...process.env, MERRYMEN_PERPS_CAPTURE_PUBLIC_FEED: "1" };
  const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", cli, source, output, "1"], { env, encoding: "utf8" }));
  assert.equal(result.complete, true); assert.equal(result.unreadFrames, 0);
  const replay = fileURLToPath(new URL("./backtest-cli.ts", import.meta.url));
  const args = ["--import", "tsx", replay, path.join(output, "replay.json")];
  const first = execFileSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(JSON.parse(first).complete, true);
  assert.equal(first, execFileSync(process.execPath, args, { encoding: "utf8" }));
});
