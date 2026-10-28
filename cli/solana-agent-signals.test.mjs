import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import {
  installSolanaWorkerStop, SOLANA_WORKER_IPC_ENV, SOLANA_WORKER_PARENT_GRACE_MS, SOLANA_WORKER_REPEAT_MS, SOLANA_WORKER_STOP_MESSAGE,
  solanaWorkerParentPid,
} from "../worker/src/solana-agent-cli.ts";

const BIN = fileURLToPath(new URL("./bin.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKER = fileURLToPath(new URL("../worker/src/solana-agent-cli.ts", import.meta.url));
// POSIX signals only: on Windows the console delivers Ctrl+C to the child itself.
const posix = process.platform !== "win32";

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(100);
  }
}

/**
 * Sends the two copies of one Ctrl+C a moment apart, as a launcher forwards
 * them, so they arrive as two signals rather than one merged pending signal.
 * Returns how far apart this process actually sent them: a test process that
 * stalled for a large part of the merge window may have sent two presses, and
 * then the outcome proves nothing either way.
 */
async function sendCopies(first, second) {
  const started = performance.now();
  first();
  await delay(50);
  // A process that already finished its stop (after a long stall here) is gone.
  try { second(); } catch (error) { if (error.code !== "ESRCH") throw error; }
  return performance.now() - started;
}
const inconclusive = (gap) => gap >= SOLANA_WORKER_REPEAT_MS / 2
  ? `inconclusive: this process sent the two copies ${Math.round(gap)} ms apart, too close to the ${SOLANA_WORKER_REPEAT_MS} ms window` : null;

/**
 * The real `merrymen solana-agent` command and its real TypeScript worker, with
 * a temporary home, no bindings, no keys and every network call refused.
 */
function startAgent(t, { detached = false, wedge = false, stall = false, linger = false, holdStart = false, direct = null } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "msa-signal-"));
  const home = path.join(directory, "home");
  const pids = path.join(directory, "pids");
  const network = path.join(directory, "network-attempt");
  const wedgeFile = path.join(directory, "wedge");
  const lingerFile = path.join(directory, "lingering");
  const stallFile = path.join(directory, "stall");
  const releaseFile = path.join(directory, "release");
  const guard = path.join(directory, "guard.mjs");
  writeFileSync(guard, `
import { appendFileSync, existsSync } from "node:fs";
const isWorker = process.argv.some((arg) => arg.endsWith("solana-agent-cli.ts"));
// A wedged worker: once the file appears, its event loop never runs again, so
// neither signals nor IPC messages reach its JavaScript handlers.
if (${JSON.stringify(wedge)} && isWorker) {
  setInterval(() => { if (existsSync(${JSON.stringify(wedgeFile)})) for (;;) {} }, 20).unref();
}
// A busy worker: once the file appears, its event loop is held for 1.5 s, once.
// Signals sent meanwhile reach its handlers afterwards, one by one.
if (${JSON.stringify(stall)} && isWorker) {
  const timer = setInterval(() => {
    if (!existsSync(${JSON.stringify(stallFile)})) return;
    clearInterval(timer);
    for (const end = Date.now() + 1_500; Date.now() < end;) { /* busy */ }
  }, 20);
  timer.unref();
}
// A worker that lingers after its run finished: some handle (a database pool,
// a socket) keeps the process alive after it closed its channel.
if (${JSON.stringify(linger)} && isWorker) {
  process.on("disconnect", () => { appendFileSync(${JSON.stringify(lingerFile)}, "x"); setTimeout(() => {}, 120_000); });
}
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
appendFileSync(${JSON.stringify(pids)}, process.pid + "\\t" + process.argv.slice(1).join(" ") + "\\n");
// A worker held before its own code runs: no event loop turn, so a closed
// channel is not read yet, until the file appears.
if (${JSON.stringify(holdStart)} && isWorker) {
  for (const end = Date.now() + 30_000; !existsSync(${JSON.stringify(releaseFile)}) && Date.now() < end;) { /* held */ }
}
const refuse = () => { appendFileSync(${JSON.stringify(network)}, "attempt\\n"); throw new Error("network disabled"); };
globalThis.fetch = async () => refuse();
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if ((typeof options === "object" && typeof options?.path === "string" && options.port === undefined) ||
      (typeof options === "string" && !/^[0-9]+$/.test(options))) return connect.apply(this, args);
  return refuse();
};
syncBuiltinESMExports();
`);
  const env = {
    MERRYMEN_HOME: home, NO_COLOR: "1", NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`, MERRYMEN_SOLANA: "1",
    // Configured but never contacted: the worker has no bindings to trade.
    MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example.invalid/",
  };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // `direct`: the worker alone, as a launcher other than the CLI starts it, with extra environment.
  const cli = direct
    ? spawn(process.execPath, ["--import", "tsx", WORKER], { cwd: ROOT, env: { ...env, ...direct }, detached, stdio: ["ignore", "pipe", "pipe"], shell: false })
    : spawn(process.execPath, [BIN, "solana-agent"], { cwd: directory, env, detached, stdio: ["ignore", "pipe", "pipe"], shell: false });
  let output = "";
  cli.stdout.on("data", (chunk) => { output += chunk; });
  cli.stderr.on("data", (chunk) => { output += chunk; });
  const exited = once(cli, "exit");
  let worker;
  const workerPid = () => until(() => {
    if (!existsSync(pids)) return null;
    const line = readFileSync(pids, "utf8").split("\n").find((entry) => entry.includes("solana-agent-cli.ts"));
    return line ? Number(line.split("\t")[0]) : null;
  }, 20_000, "the Solana worker process");
  t.after(async () => {
    for (const pid of [worker, cli.pid]) if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await delay(100);
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    cli, exited, output: () => output, wedge: () => writeFileSync(wedgeFile, ""), lingering: () => existsSync(lingerFile),
    /** Holds the worker's event loop for 1.5 s, starting within about 20 ms. */
    async stall() { writeFileSync(stallFile, ""); await delay(200); },
    database: () => path.join(home, "solana-accounts.sqlite"),
    /** The worker's pid, once its preload ran (before its own code, with holdStart). */
    async started() { worker = await workerPid(); return worker; },
    /** Lets a holdStart worker go on to its own code. */
    release: () => writeFileSync(releaseFile, ""),
    networkAttempted: () => existsSync(network),
    /** Resolves once the worker's first tick wrote its heartbeat, after it installed its handlers. */
    async ready() {
      worker = await workerPid();
      const db = path.join(home, "solana-accounts.sqlite");
      await until(() => {
        if (!existsSync(db)) return false;
        const raw = new DatabaseSync(db, { readOnly: true });
        try {
          return !!raw.prepare("SELECT 1 FROM sqlite_master WHERE name='solana_runtime_worker_heartbeat'").get()
            && !!raw.prepare("SELECT last_seen_at_ms FROM solana_runtime_worker_heartbeat WHERE worker='solana'").get();
        } catch { return false; } finally { raw.close(); }
      }, 20_000, "the worker heartbeat");
      assert.equal(alive(worker), true);
      return worker;
    },
  };
}

test("SIGTERM to the solana-agent CLI stops its worker and exits with it", { skip: !posix, timeout: 60_000 }, async (t) => {
  const agent = startAgent(t);
  const worker = await agent.ready();
  // A pid-based stop (kill, a supervisor, nohup) reaches only the CLI process.
  process.kill(agent.cli.pid, "SIGTERM");
  const [code, signal] = await Promise.race([agent.exited, delay(20_000).then(() => ["timeout", null])]);
  assert.equal(signal, null, `the CLI died on the signal instead of waiting for its worker:\n${agent.output()}`);
  assert.equal(code, 0, agent.output());
  // The CLI exits only from the worker's exit, so the worker is already gone.
  assert.equal(alive(worker), false, "the worker kept running as an orphan after the CLI stopped");
  assert.equal(agent.networkAttempted(), false);
});

test("SIGINT to the CLI alone also reaches the worker", { skip: !posix, timeout: 60_000 }, async (t) => {
  const agent = startAgent(t);
  const worker = await agent.ready();
  process.kill(agent.cli.pid, "SIGINT");
  const [code, signal] = await Promise.race([agent.exited, delay(20_000).then(() => ["timeout", null])]);
  assert.deepEqual([code, signal], [0, null], agent.output());
  assert.equal(alive(worker), false);
});

test("Ctrl+C to the whole process group stops the worker gracefully, not on the forwarded duplicate", { skip: !posix, timeout: 60_000 }, async (t) => {
  // A terminal delivers SIGINT to the CLI and the worker; the CLI then forwards
  // the same signal. The duplicate must not kill the worker mid-tick.
  const agent = startAgent(t, { detached: true });
  const worker = await agent.ready();
  process.kill(-agent.cli.pid, "SIGINT");
  const [code, signal] = await Promise.race([agent.exited, delay(20_000).then(() => ["timeout", null])]);
  assert.deepEqual([code, signal], [0, null], `the worker did not finish its graceful stop:\n${agent.output()}`);
  assert.equal(alive(worker), false);
});

test("SIGKILL of the CLI (or the OOM killer) still stops its worker", { skip: !posix, timeout: 60_000 }, async (t) => {
  const agent = startAgent(t);
  const worker = await agent.ready();
  // Nothing can be forwarded: the worker notices its IPC channel close.
  process.kill(agent.cli.pid, "SIGKILL");
  await agent.exited;
  await until(() => !alive(worker), 20_000, "the orphaned worker to stop");
  assert.equal(agent.networkAttempted(), false);
});

test("a second Ctrl+C forces a wedged worker to stop", { skip: !posix, timeout: 60_000 }, async (t) => {
  const agent = startAgent(t, { wedge: true });
  const worker = await agent.ready();
  agent.wedge();
  await delay(300);
  process.kill(agent.cli.pid, "SIGINT");
  // A deliberate second press, outside the window that merges duplicates.
  await delay(SOLANA_WORKER_REPEAT_MS + 500);
  assert.equal(alive(worker), true, "the first press only asks for a graceful stop");
  const started = Date.now();
  process.kill(agent.cli.pid, "SIGINT");
  const [code, signal] = await Promise.race([agent.exited, delay(20_000).then(() => ["timeout", null])]);
  assert.deepEqual([code, signal], [137, null], `the CLI did not force the stop:\n${agent.output()}`);
  assert.ok(Date.now() - started < 10_000);
  assert.equal(alive(worker), false);
  assert.match(agent.output(), /Forcing the Solana worker to stop/);
});

test("the first Ctrl+C says the stop waits for the tick and how to force it", { skip: !posix, timeout: 60_000 }, async (t) => {
  const agent = startAgent(t, { detached: true });
  await agent.ready();
  process.kill(-agent.cli.pid, "SIGINT");
  const [code] = await agent.exited;
  assert.equal(code, 0, agent.output());
  const notices = agent.output().match(/stopping after the current tick\. Press Ctrl\+C again to force \(presses within 1\.5 s count as this one\)\./g) ?? [];
  assert.equal(notices.length, 1, `one press, one notice, although it reached the worker twice:\n${agent.output()}`);
});

test("one Ctrl+C that a launcher also forwards to the CLI stops gracefully, not forced", { skip: !posix, timeout: 60_000 }, async (t) => {
  // npx or npm run in the same process group: the terminal's SIGINT reaches
  // the CLI and the worker, and the launcher forwards its own copy to the CLI.
  const agent = startAgent(t, { detached: true, stall: true });
  const worker = await agent.ready();
  // The worker is busy, so it still runs its loop when the command's messages arrive.
  await agent.stall();
  const gap = await sendCopies(() => process.kill(-agent.cli.pid, "SIGINT"), () => process.kill(agent.cli.pid, "SIGINT"));
  if (inconclusive(gap)) return t.skip(inconclusive(gap));
  const [code, signal] = await Promise.race([agent.exited, delay(20_000).then(() => ["timeout", null])]);
  assert.deepEqual([code, signal], [0, null], `one press was taken for two:\n${agent.output()}`);
  assert.doesNotMatch(agent.output(), /Forcing|forced stop/);
  assert.equal(alive(worker), false);
});

test("the worker run directly ignores a launcher's duplicate of one Ctrl+C", { skip: !posix, timeout: 60_000 }, async (t) => {
  // npm run start:solana: npm forwards the SIGINT the worker already received.
  const agent = startAgent(t, { direct: {}, stall: true });
  const worker = await agent.ready();
  // End to end only: an idle worker finishes its stop within the first copy's
  // callback, so the second meets a finished run. The repeat window itself is
  // checked mid-transaction in worker/src/solana-agent-cli.test.ts.
  await agent.stall();
  const gap = await sendCopies(() => process.kill(worker, "SIGINT"), () => process.kill(worker, "SIGINT"));
  if (inconclusive(gap)) return t.skip(inconclusive(gap));
  const [code, signal] = await Promise.race([agent.exited, delay(20_000).then(() => ["timeout", null])]);
  assert.deepEqual([code, signal], [0, null], agent.output());
  assert.doesNotMatch(agent.output(), /forced stop/);
});

test("a pid-based stop still ends a worker that lingers after its run finished", { skip: !posix, timeout: 60_000 }, async (t) => {
  const agent = startAgent(t, { linger: true });
  const worker = await agent.ready();
  process.kill(agent.cli.pid, "SIGTERM");
  // The run finished and closed its channel, but a handle keeps the process alive.
  await until(() => agent.lingering(), 20_000, "the worker to finish its run and linger");
  await delay(SOLANA_WORKER_REPEAT_MS + 200);
  assert.equal(alive(worker), true);
  const started = Date.now();
  process.kill(agent.cli.pid, "SIGTERM");
  const [code, signal] = await Promise.race([agent.exited, delay(20_000).then(() => ["timeout", null])]);
  assert.deepEqual([code, signal], [0, null], `the finished worker was not ended with its own exit code:\n${agent.output()}`);
  assert.ok(Date.now() - started < 2_500, "ended at once, not by the forced-stop fallback");
  assert.equal(alive(worker), false);
});

test("a worker whose command is gone before it starts never opens storage or trades", { skip: !posix, timeout: 60_000 }, async (t) => {
  // Started as the CLI starts it, naming its parent, but with no channel: as if
  // the CLI's channel had closed and been read before the worker listened.
  const agent = startAgent(t, { direct: { [SOLANA_WORKER_IPC_ENV]: String(process.pid) } });
  const [code, signal] = await Promise.race([agent.exited, delay(30_000).then(() => ["timeout", null])]);
  assert.deepEqual([code, signal], [1, null], agent.output());
  assert.match(agent.output(), /command that started this worker is gone/);
  assert.equal(existsSync(agent.database()), false, "no storage was opened, so no tick ran");
  assert.equal(agent.networkAttempted(), false);
});

test("a worker whose command is killed before the worker's own code runs never opens storage or trades", { skip: !posix, timeout: 60_000 }, async (t) => {
  // The command dies after spawning the worker but before the worker's main()
  // runs. Its channel still reads as open then: the close is read only on a
  // later event loop turn, which a busy first tick may not reach for a while.
  const agent = startAgent(t, { holdStart: true });
  const worker = await agent.started();
  process.kill(agent.cli.pid, "SIGKILL");
  await agent.exited;
  // The kernel re-parented the worker before the command's exit was reported.
  agent.release();
  await until(() => !alive(worker), 30_000, "the orphaned worker to exit");
  assert.equal(existsSync(agent.database()), false, "no storage was opened, so no tick ran");
  assert.equal(agent.networkAttempted(), false);
});

test("worker stop: the parent named by the command is parsed strictly, and anything else matches no parent", () => {
  assert.equal(solanaWorkerParentPid({}), undefined, "not started by merrymen solana-agent");
  assert.equal(solanaWorkerParentPid({ [SOLANA_WORKER_IPC_ENV]: "4242" }), 4242);
  for (const value of ["", "0", "-1", "01", "1.5", "4242 ", "abc", "99999999999"]) {
    assert.equal(solanaWorkerParentPid({ [SOLANA_WORKER_IPC_ENV]: value }), -1, JSON.stringify(value));
  }
});

/** The worker's stop handling, driven directly: a fake process, abort, exit and timers. */
function stopHarness({ connected = true, ppid = 4242, parentPid = undefined, finishedExitCode = undefined, defaultClock = false } = {}) {
  const host = Object.assign(new EventEmitter(), { connected, ppid, disconnected: 0, disconnect() { this.disconnected++; this.connected = false; } });
  const events = { aborts: 0, exits: [], writes: [], timers: [] };
  const clock = { ms: 1_000_000 };
  const handle = installSolanaWorkerStop(host, {
    abort: () => { events.aborts++; }, exit: (code) => { events.exits.push(code); }, write: (text) => { events.writes.push(text); },
    setTimer: (callback, ms) => { const timer = { callback, ms, unrefed: false, unref() { this.unrefed = true; } }; events.timers.push(timer); return timer; },
    ...(defaultClock ? {} : { now: () => clock.ms }), parentPid, finishedExitCode,
  });
  return { host, events, handle, later: (ms = SOLANA_WORKER_REPEAT_MS) => { clock.ms += ms; } };
}

test("worker stop: the first signal is graceful, a second one forces the exit", () => {
  for (const [first, second, code] of [["SIGINT", "SIGINT", 130], ["SIGTERM", "SIGTERM", 143], ["SIGHUP", "SIGINT", 130]]) {
    for (const connected of [true, false]) {
      const { host, events, later } = stopHarness({ connected });
      host.emit(first);
      assert.deepEqual([events.aborts, events.exits], [1, []]);
      assert.match(events.writes.join(""), /stopping after the current tick\. Press Ctrl\+C again to force/);
      later();
      host.emit(second);
      assert.deepEqual(events.exits, [code], `${first} then ${second}`);
      assert.equal(events.aborts, 1);
    }
  }
});

test("worker stop: the same press delivered twice (terminal and launcher) does not force", () => {
  const { host, events, later } = stopHarness();
  host.emit("SIGINT");
  later(SOLANA_WORKER_REPEAT_MS - 1);
  host.emit("SIGINT");
  host.emit("SIGTERM");
  assert.deepEqual([events.aborts, events.exits, events.writes.length], [1, [], 1], "duplicates within the window are one press");
  later(1);
  host.emit("SIGINT");
  assert.deepEqual(events.exits, [130], "a deliberate second press still forces");
  assert.ok(SOLANA_WORKER_REPEAT_MS >= 1_000 && SOLANA_WORKER_REPEAT_MS <= 2_000, "short enough for a deliberate second press");
});

test("worker stop: a launcher's copy that a loaded machine delivers a second late is still the same press", () => {
  for (const lateMs of [600, 1_000, 1_400]) {
    const { host, events, later } = stopHarness();
    host.emit("SIGINT");
    later(lateMs);
    host.emit("SIGINT");
    assert.deepEqual([events.aborts, events.exits], [1, []], `a copy ${lateMs} ms late must not force a stop mid-tick`);
    assert.match(events.writes.join(""), /Press Ctrl\+C again to force \(presses within 1\.5 s count as this one\)\./);
  }
});

test("the solana-agent command merges duplicate signals over the same window as its worker", () => {
  // cli/bin.mjs cannot import the TypeScript constant; it keeps its own copy.
  const source = readFileSync(BIN, "utf8");
  const windows = [...source.matchAll(/const REPEAT_MS = ([0-9_]+);/g)].map((match) => Number(match[1].replaceAll("_", "")));
  assert.deepEqual(windows, [SOLANA_WORKER_REPEAT_MS]);
  // And on the same monotonic clock: the press handler reads performance.now, never the wall clock.
  const handler = source.slice(source.indexOf("const REPEAT_MS = "), source.indexOf("child.on(\"error\""));
  assert.match(handler, /const at = performance\.now\(\);/);
  assert.doesNotMatch(handler, /Date\.now\(\)/);
  assert.match(source, /^import \{ performance \} from "node:perf_hooks";$/m);
});

test("worker stop: the repeat window runs on the monotonic clock, whatever the wall clock does", (t) => {
  const clocks = { mono: 5_000, wall: 1_790_000_000_000 };
  t.mock.method(performance, "now", () => clocks.mono);
  t.mock.method(Date, "now", () => clocks.wall);
  // NTP steps the wall clock an hour back after the first press; real time moves past the window.
  const back = stopHarness({ defaultClock: true });
  back.host.emit("SIGINT");
  clocks.wall -= 3_600_000; clocks.mono += SOLANA_WORKER_REPEAT_MS;
  back.host.emit("SIGINT");
  assert.deepEqual(back.events.exits, [130], "a deliberate second press still forces the stop");
  // The wall clock jumps an hour ahead between the two copies of one press: still one press.
  const ahead = stopHarness({ defaultClock: true });
  ahead.host.emit("SIGINT");
  clocks.wall += 3_600_000; clocks.mono += 100;
  ahead.host.emit("SIGINT");
  assert.deepEqual([ahead.events.aborts, ahead.events.exits], [1, []], "one press delivered twice never forces");
});

test("worker stop: after the run finished, a stop exits at once with the run's own code, never 130", () => {
  for (const [code, connected] of [[undefined, true], [1, true], [0, false]]) {
    const { host, events, handle } = stopHarness({ connected, finishedExitCode: code === undefined ? undefined : () => code });
    host.emit("SIGINT");
    handle.finished();
    // A late duplicate of the press that stopped it, or a later pid-based stop.
    host.emit("SIGINT");
    assert.deepEqual(events.exits, [code ?? 0]);
    assert.equal(events.aborts, 1);
    assert.doesNotMatch(events.writes.join(""), /forced stop/);
  }
});

test("worker stop: started by the command whose channel is already closed, it stops before trading", () => {
  const { events, handle } = stopHarness({ connected: false, parentPid: 4242 });
  assert.equal(events.aborts, 1, "aborted at install: the loop never runs a tick");
  assert.equal(handle.parentLost(), true);
  assert.match(events.writes.join(""), /command that started this worker is gone/);
  assert.equal(events.timers[0].ms, SOLANA_WORKER_PARENT_GRACE_MS);
  // Started by anything else (npm run start:solana, a supervisor), no channel is expected.
  const plain = stopHarness({ connected: false });
  assert.equal(plain.events.aborts, 0);
  assert.equal(plain.handle.parentLost(), false);
});

test("worker stop: re-parented before it started, it stops before trading although its channel still reads as open", () => {
  // The command died; the channel's close is not read yet, but the kernel already gave the worker a new parent.
  for (const ppid of [1, 777]) {
    const { events, handle } = stopHarness({ connected: true, ppid, parentPid: 4242 });
    assert.equal(events.aborts, 1, `parent ${ppid}: aborted at install`);
    assert.equal(handle.parentLost(), true);
    assert.match(events.writes.join(""), /command that started this worker is gone/);
  }
  // A marker that is not a pid matches no parent.
  assert.equal(stopHarness({ connected: true, parentPid: -1 }).events.aborts, 1);
  // Its own command, channel open: it runs.
  const running = stopHarness({ connected: true, ppid: 4242, parentPid: 4242 });
  assert.equal(running.events.aborts, 0);
  assert.equal(running.handle.parentLost(), false);
  running.host.emit("disconnect");
  assert.equal(running.handle.parentLost(), true, "a close read later is a lost parent too");
});

test("worker stop: the command's message for the same press does not count twice; its force message forces", () => {
  const { host, events } = stopHarness();
  // One terminal Ctrl+C: the signal reaches the worker, and the command reports its own copy.
  host.emit("SIGINT");
  host.emit("message", { type: SOLANA_WORKER_STOP_MESSAGE, force: false, signal: "SIGINT" });
  for (const junk of [null, "stop", { type: "other", force: true }, { type: SOLANA_WORKER_STOP_MESSAGE, force: "yes" }]) host.emit("message", junk);
  assert.deepEqual([events.aborts, events.exits], [1, []]);
  assert.equal(events.writes.length, 1);
  host.emit("message", { type: SOLANA_WORKER_STOP_MESSAGE, force: true, signal: "SIGINT" });
  assert.deepEqual(events.exits, [130]);
  // The forced exit code is the one the command's own signal would give: 128 + its number.
  for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129], ["SIGINT", 130], ["SIGKILL", 130], [undefined, 130], [15, 130], ["toString", 130]]) {
    const forced = stopHarness();
    forced.host.emit("message", { type: SOLANA_WORKER_STOP_MESSAGE, force: false, signal });
    forced.later();
    forced.host.emit("message", { type: SOLANA_WORKER_STOP_MESSAGE, force: true, signal });
    assert.deepEqual(forced.events.exits, [code], `forced by ${String(signal)}`);
  }
  // A stop the command alone received (a pid-based kill) is graceful.
  const solo = stopHarness();
  solo.host.emit("message", { type: SOLANA_WORKER_STOP_MESSAGE, force: false, signal: "SIGTERM" });
  assert.deepEqual([solo.events.aborts, solo.events.exits], [1, []]);
});

test("worker stop: losing the parent stops gracefully, then forces after the grace period", () => {
  const { host, events } = stopHarness();
  host.emit("disconnect");
  assert.equal(events.aborts, 1);
  assert.match(events.writes.join(""), /command that started this worker is gone/);
  assert.equal(events.timers.length, 1);
  assert.equal(events.timers[0].ms, SOLANA_WORKER_PARENT_GRACE_MS);
  assert.equal(events.timers[0].unrefed, true, "a finished tick still lets the process exit at once");
  assert.deepEqual(events.exits, []);
  events.timers[0].callback();
  assert.deepEqual(events.exits, [1]);
});

test("worker stop: the lost-parent timer of a run that has since finished ends it with the run's own code, not forced", () => {
  for (const code of [0, 3]) {
    const { host, events, handle } = stopHarness({ finishedExitCode: () => code });
    host.emit("disconnect");
    assert.equal(events.timers.length, 1);
    // The tick finished after the parent died, but some handle keeps the process alive.
    handle.finished();
    events.timers[0].callback();
    assert.deepEqual(events.exits, [code]);
    assert.doesNotMatch(events.writes.join(""), /forced stop/);
  }
});

test("worker stop: a finished worker closes its channel, and that close is not a lost parent", () => {
  const { host, events, handle } = stopHarness();
  handle.finished();
  assert.equal(host.disconnected, 1, "an open IPC channel with listeners would keep the process alive");
  host.emit("disconnect");
  assert.deepEqual([events.aborts, events.timers.length, events.writes.length], [0, 0, 0]);
  // Without a channel nothing listens for messages or disconnects.
  const plain = stopHarness({ connected: false });
  assert.equal(plain.host.listenerCount("message") + plain.host.listenerCount("disconnect"), 0);
  plain.handle.finished();
  assert.equal(plain.host.disconnected, 0);
});
