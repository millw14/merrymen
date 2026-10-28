import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SOLANA_LIVE_ROLLOUT_PUBLISH_MS, solanaLiveRolloutFingerprint } from "../../../worker/src/solana-live-rollout";
import { SOLANA_ROLLOUT_UNPUBLISHED_ALERT, solanaWebRolloutPublisher, startSolanaRolloutPublisher, startSolanaWebRolloutPublisher } from "./solana-rollout-publisher";
import { register } from "../instrumentation";

/** A timer the test runs by hand: `tick()` is one interval passing. */
function manualTimer() {
  const timer = { ms: undefined as number | undefined, run: undefined as (() => void) | undefined, stopped: false,
    every: (run: () => void, ms: number) => { timer.run = run; timer.ms = ms; return { stop: () => { timer.stopped = true; } }; },
    tick: () => timer.run!() };
  return timer;
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("the web publishes nothing, and loads nothing, while this deployment does not offer Solana", () => {
  let calls = 0;
  const timer = manualTimer();
  assert.equal(startSolanaRolloutPublisher({ enabled: () => false, publish: async () => { calls++; }, every: timer.every }), null);
  assert.equal(calls, 0); assert.equal(timer.run, undefined, "no timer");
});

test("the web publishes its rollout settings as it starts and again every 30 s, one publish at a time", async () => {
  let calls = 0, release: (() => void) | undefined;
  const timer = manualTimer();
  const publisher = startSolanaRolloutPublisher({ enabled: () => true, every: timer.every, log: () => assert.fail("nothing to say"),
    publish: () => { calls++; return new Promise<void>(resolve => { release = resolve; }); } })!;
  assert.equal(calls, 1, "published as it starts, before any request"); assert.equal(timer.ms, SOLANA_LIVE_ROLLOUT_PUBLISH_MS);
  // A tick while the start's publish is still running starts no second one.
  timer.tick(); assert.equal(calls, 1);
  release!(); await publisher.started;
  timer.tick(); assert.equal(calls, 2, "every interval after"); release!(); await settle();
  timer.tick(); assert.equal(calls, 3); release!(); await settle();
  publisher.stop(); assert.equal(timer.stopped, true);
});

test("a publish that fails never throws and never stops the next one: the operator is told once a minute, naming no value", async () => {
  const lines: string[] = [], clock = { now: 1_000_000 };
  let failing = true, calls = 0;
  const timer = manualTimer();
  const publisher = startSolanaRolloutPublisher({ enabled: () => true, every: timer.every, now: () => clock.now, log: line => lines.push(line),
    publish: async () => { calls++; if (failing) throw new Error("connect ECONNREFUSED postgres://user:secret@db"); } })!;
  await publisher.started;
  assert.deepEqual(lines, [SOLANA_ROLLOUT_UNPUBLISHED_ALERT]);
  assert.ok(!lines[0]!.includes("secret") && !lines[0]!.includes("postgres://"), "the error's text is never said");
  clock.now += 30_000; timer.tick(); await settle();
  assert.equal(calls, 2, "retried"); assert.equal(lines.length, 1, "at most once a minute");
  clock.now += 30_000; timer.tick(); await settle();
  assert.equal(lines.length, 2, "said again after a minute");
  failing = false; clock.now += 60_000; timer.tick(); await settle();
  assert.equal(calls, 4); assert.equal(lines.length, 2, "nothing to say once it publishes");
  publisher.stop();
});

test("register(): on the Node.js server of a deployment offering Solana, the web's rollout digest is written as it starts, with no request served; never at build, on the edge runtime or with Solana off", async () => {
  const home = mkdtempSync(join(tmpdir(), "merrymen-rollout-boot-"));
  const saved = { ...process.env };
  const restore = () => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); };
  const webRow = () => {
    const db = new DatabaseSync(join(home, "solana-accounts.sqlite"));
    try {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name='solana_runtime_live_rollout_seen'").get();
      return table ? db.prepare("SELECT fingerprint FROM solana_runtime_live_rollout_seen WHERE service='web'").get() as { fingerprint: string } | undefined : undefined;
    } finally { db.close(); }
  };
  try {
    for (const key of ["DATABASE_URL", "MERRYMEN_HOSTED", "NEXT_PHASE"]) delete process.env[key];
    Object.assign(process.env, { MERRYMEN_HOME: home, MERRYMEN_SOLANA: "1", MERRYMEN_SOLANA_LIVE_TENANTS: `0x${"11".repeat(20)}` });
    // `next build` prerendering, the edge runtime, and a deployment without Solana start nothing.
    for (const env of [{ NEXT_RUNTIME: "nodejs", NEXT_PHASE: "phase-production-build" }, { NEXT_RUNTIME: "edge" }, { NEXT_RUNTIME: "nodejs", MERRYMEN_SOLANA: "" }]) {
      const before = { ...process.env };
      Object.assign(process.env, env);
      await register();
      for (const key of Object.keys(env)) { if (key in before) process.env[key] = before[key]; else delete process.env[key]; }
    }
    assert.equal(webRow(), undefined, "nothing was written"); assert.equal(solanaWebRolloutPublisher(), undefined, "nothing was started");
    // The Node.js server of a deployment offering Solana: the digest of this process's settings, at once.
    process.env.NEXT_RUNTIME = "nodejs";
    await register();
    const publisher = solanaWebRolloutPublisher();
    assert.ok(publisher, "register() started it");
    await publisher.started;
    assert.equal(webRow()?.fingerprint, solanaLiveRolloutFingerprint(process.env));
    // Registered again (a dev server): the same publisher, not a second timer.
    await register(); assert.equal(solanaWebRolloutPublisher(), publisher); assert.equal(startSolanaWebRolloutPublisher(), publisher);
    publisher.stop();
  } finally { restore(); rmSync(home, { recursive: true, force: true }); }
});
