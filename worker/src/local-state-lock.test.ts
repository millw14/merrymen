import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LOCAL_STATE_LOCK_FILE, LocalStateBusyError, withLocalStateLock } from "./local-state-lock";

test("local writers wait their turn and release on a failed write", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "mm-local-lock-"));
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const first = withLocalStateLock(home, async () => {
    order.push("first");
    entered();
    await released;
    throw new Error("write failed");
  });
  const rejected = assert.rejects(first, /write failed/);
  try {
    await held;
    await assert.rejects(withLocalStateLock(home, async () => assert.fail("busy writer must not run"), 0), LocalStateBusyError);
    const second = withLocalStateLock(home, async () => { order.push("second"); });
    assert.deepEqual(order, ["first"]);
    release();
    await rejected;
    await second;
    assert.deepEqual(order, ["first", "second"]);
  } finally {
    release();
    await rejected;
    await rm(home, { recursive: true, force: true });
  }
});

test("another process's lock is honored and process death releases it", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "mm-local-lock-process-"));
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('held');
    setInterval(() => {}, 1000);
  `, path.join(home, LOCAL_STATE_LOCK_FILE)], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    const [ready] = await once(child.stdout!, "data");
    assert.equal(ready.toString(), "held");
    await assert.rejects(withLocalStateLock(home, async () => assert.fail("cross-process writer must wait"), 0), LocalStateBusyError);
    child.kill("SIGKILL");
    await exited;
    assert.equal(await withLocalStateLock(home, async () => "acquired"), "acquired");
  } finally {
    child.kill("SIGKILL");
    await exited;
    await rm(home, { recursive: true, force: true });
  }
});
