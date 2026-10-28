import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, mock } from "node:test";
import { Worker } from "node:worker_threads";
import {
  recoveryCommandRefused, writeRecoveryCommandBarrier, RECOVERY_COMMAND_BARRIER_FILE,
  RECOVERY_COMMAND_BARRIER_LOCK, RECOVERY_COMMAND_BARRIER_MAX_BYTES,
} from "./recovery-command-barrier";

const SCOPE = { smartAccount: `0x${"a".repeat(40)}`, chainId: 4663 };
function fixture(): { home: string; file: string; lock: string; close(): void } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mm-command-boundary-")));
  fs.chmodSync(home, 0o700);
  return { home, file: path.join(home, RECOVERY_COMMAND_BARRIER_FILE), lock: path.join(home, RECOVERY_COMMAND_BARRIER_LOCK),
    close: () => fs.rmSync(home, { recursive: true, force: true }) };
}
const cmd = (at: number, kind = "trade") => ({ kind, at });
const text = (at: number, overrides: Record<string, unknown> = {}) => JSON.stringify({ version: 1, ...SCOPE, notBeforeMs: at, ...overrides });

test("absent file is backward compatible; valid private boundary refuses older/equal financial intents", () => {
  const f = fixture();
  try {
    assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(1)), false);
    writeRecoveryCommandBarrier(f.home, SCOPE, 1000);
    for (const kind of ["trade", "selftest", "paper-reset"]) {
      assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(999, kind)), true);
      assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(1000, kind)), true);
      assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(1001, kind)), false);
    }
    assert.equal(fs.statSync(f.file).mode & 0o7777, 0o600);
    assert.equal(fs.statSync(f.file).nlink, 1);
    assert.equal(fs.existsSync(f.lock), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), { version: 1, ...SCOPE, notBeforeMs: 1000 });
    assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(1000)), true, "a fresh invocation still sees the durable file");
  } finally { f.close(); }
});

test("cutoff is a maximum, and account/chain changes preserve the existing boundary", () => {
  const f = fixture();
  try {
    writeRecoveryCommandBarrier(f.home, SCOPE, 3000);
    writeRecoveryCommandBarrier(f.home, { ...SCOPE, smartAccount: SCOPE.smartAccount.toUpperCase().replace("0X", "0x") }, 1000);
    assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).notBeforeMs, 3000);
    writeRecoveryCommandBarrier(f.home, SCOPE, 4000);
    const before = fs.readFileSync(f.file, "utf8");
    for (const scope of [{ ...SCOPE, chainId: 46630 }, { ...SCOPE, smartAccount: `0x${"b".repeat(40)}` }]) {
      assert.throws(() => writeRecoveryCommandBarrier(f.home, scope, 5000), /Recovery command barrier refused/);
      assert.equal(fs.readFileSync(f.file, "utf8"), before);
      assert.equal(recoveryCommandRefused(f.home, scope, cmd(6000)), true);
    }
    assert.equal(fs.existsSync(f.lock), false);
  } finally { f.close(); }
});

test("writer makes an owned plain 0755 home private through its verified directory handle", () => {
  const f = fixture();
  try {
    fs.chmodSync(f.home, 0o755);
    assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(1000)), false, "absent legacy boundary remains compatible");
    writeRecoveryCommandBarrier(f.home, SCOPE, 1000);
    assert.equal(fs.statSync(f.home).mode & 0o7777, 0o700);
    assert.equal(fs.statSync(f.file).mode & 0o7777, 0o600);
    assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(1001)), false);
    fs.chmodSync(f.home, 0o755);
    assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(1001)), true, "reader never tightens or accepts a public home");
    assert.equal(fs.statSync(f.home).mode & 0o7777, 0o755);
  } finally { f.close(); }
});

test("foreign owner or mismatched opened directory inode refuses before any chmod", () => {
  const f = fixture();
  try {
    fs.chmodSync(f.home, 0o755);
    const lstat = fs.lstatSync, fstat = fs.fstatSync;
    const changed = (st: fs.BigIntStats, field: "uid" | "ino") => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { [field]: st[field] + 1n });
    const chmod = mock.method(fs, "fchmodSync", () => { throw new Error("must not chmod a foreign directory"); });
    const owner = mock.method(fs, "lstatSync", (...args: unknown[]) => {
      const st = Reflect.apply(lstat, fs, args);
      return args[0] === f.home && typeof st.uid === "bigint" ? changed(st, "uid") : st;
    });
    try {
      assert.throws(() => writeRecoveryCommandBarrier(f.home, SCOPE, 1000), /Recovery command barrier refused/);
      assert.equal(chmod.mock.callCount(), 0);
    } finally { owner.mock.restore(); }
    const inode = mock.method(fs, "fstatSync", (...args: unknown[]) => {
      const st = Reflect.apply(fstat, fs, args);
      return st.isDirectory() && typeof st.ino === "bigint" ? changed(st, "ino") : st;
    });
    try {
      assert.throws(() => writeRecoveryCommandBarrier(f.home, SCOPE, 1000), /Recovery command barrier refused/);
      assert.equal(chmod.mock.callCount(), 0);
    } finally { inode.mock.restore(); chmod.mock.restore(); }
    assert.equal(fs.statSync(f.home).mode & 0o7777, 0o755);
    assert.equal(fs.existsSync(f.file), false); assert.equal(fs.existsSync(f.lock), false);
  } finally { f.close(); }
});

test("malformed/version/extra/unsafe/oversized barriers and wrong modes are held, never repaired", () => {
  const f = fixture();
  try {
    for (const body of ["", "{", text(1000, { version: 2 }), text(-1), text(Number.MAX_SAFE_INTEGER + 1),
      text(1000, { extra: "private" }), text(1000, { chainId: 0 }), text(1000, { smartAccount: "private" }),
      '{"version":0,"version":1,"smartAccount":"'+SCOPE.smartAccount+'","chainId":4663,"notBeforeMs":1000}',
      "x".repeat(RECOVERY_COMMAND_BARRIER_MAX_BYTES + 1)]) {
      fs.writeFileSync(f.file, body, { mode: 0o600 }); fs.chmodSync(f.file, 0o600);
      assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(2000)), true);
      assert.throws(() => writeRecoveryCommandBarrier(f.home, SCOPE, 3000), /Recovery command barrier refused/);
      assert.equal(fs.readFileSync(f.file, "utf8"), body);
    }
    fs.writeFileSync(f.file, text(1000));
    for (const mode of [0o644, 0o400, 0o660, 0o1600]) {
      fs.chmodSync(f.file, mode);
      assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(2000)), true);
      assert.throws(() => writeRecoveryCommandBarrier(f.home, SCOPE, 3000), /Recovery command barrier refused/);
      assert.equal(fs.statSync(f.file).mode & 0o7777, mode);
    }
  } finally { f.close(); }
});

test("foreign symlink/hardlink/directory and symlinked home cannot be consumed or overwritten", () => {
  const f = fixture();
  try {
    const foreign = path.join(f.home, "foreign.json"); fs.writeFileSync(foreign, text(1000), { mode: 0o600 });
    fs.symlinkSync(foreign, f.file);
    assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(2000)), true);
    assert.throws(() => writeRecoveryCommandBarrier(f.home, SCOPE, 3000), /Recovery command barrier refused/);
    assert.ok(fs.lstatSync(f.file).isSymbolicLink()); assert.equal(fs.readFileSync(foreign, "utf8"), text(1000));
    fs.unlinkSync(f.file); fs.linkSync(foreign, f.file);
    assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(2000)), true);
    assert.throws(() => writeRecoveryCommandBarrier(f.home, SCOPE, 3000), /Recovery command barrier refused/);
    fs.unlinkSync(f.file); fs.mkdirSync(f.file);
    assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(2000)), true);
    fs.rmdirSync(f.file); writeRecoveryCommandBarrier(f.home, SCOPE, 1000);
    const linkedHome = `${f.home}-link`; fs.symlinkSync(f.home, linkedHome);
    try {
      assert.equal(recoveryCommandRefused(linkedHome, SCOPE, cmd(2000)), true);
      assert.throws(() => writeRecoveryCommandBarrier(linkedHome, SCOPE, 3000), /Recovery command barrier refused/);
    } finally { fs.unlinkSync(linkedHome); }
  } finally { f.close(); }
});

test("readonly/unknown kinds remain unchanged while malformed financial timestamps are refused", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.file, "broken", { mode: 0o600 });
    for (const kind of ["status", "history", "forget", "kill", "unknown", "TRADE"]) {
      assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(1, kind)), false);
    }
    for (const at of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(at)), true);
      assert.throws(() => writeRecoveryCommandBarrier(f.home, SCOPE, at), /Recovery command barrier refused/);
    }
  } finally { f.close(); }
});

test("existing/crash-orphan/foreign locks refuse reader and writer and are never stolen", () => {
  const f = fixture();
  try {
    writeRecoveryCommandBarrier(f.home, SCOPE, 1000);
    fs.writeFileSync(f.lock, "orphan\n", { mode: 0o600 });
    const before = fs.readFileSync(f.file, "utf8");
    assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(2000)), true);
    assert.throws(() => writeRecoveryCommandBarrier(f.home, SCOPE, 3000), /Recovery command barrier refused/);
    assert.equal(fs.readFileSync(f.lock, "utf8"), "orphan\n"); assert.equal(fs.readFileSync(f.file, "utf8"), before);
    fs.unlinkSync(f.file);
    assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(2000)), true, "orphan also protects first-publication crashes");
    fs.unlinkSync(f.lock); fs.symlinkSync(path.join(f.home, "missing"), f.lock);
    assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(2000)), true);
    assert.throws(() => writeRecoveryCommandBarrier(f.home, SCOPE, 3000), /Recovery command barrier refused/);
    assert.ok(fs.lstatSync(f.lock).isSymbolicLink());
  } finally { f.close(); }
});

test("actual write/read failures retain the old cutoff and return sanitized refusal", () => {
  const f = fixture();
  try {
    writeRecoveryCommandBarrier(f.home, SCOPE, 1000);
    const before = fs.readFileSync(f.file, "utf8"), write = fs.writeSync;
    const injected = mock.method(fs, "writeSync", (...args: unknown[]) => {
      if (Buffer.isBuffer(args[1]) && args[1].toString().includes("notBeforeMs")) throw new Error("private failure");
      return Reflect.apply(write, fs, args);
    });
    try { assert.throws(() => writeRecoveryCommandBarrier(f.home, SCOPE, 3000), /Recovery command barrier refused/); }
    finally { injected.mock.restore(); }
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
    assert.equal(fs.existsSync(f.lock), false);
    assert.equal(fs.readdirSync(f.home).some(name => name.endsWith(".tmp")), false);
    assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(1000)), true);
    const read = mock.method(fs, "readSync", () => { throw new Error("private read failure"); });
    try { assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(2000)), true); }
    finally { read.mock.restore(); }
  } finally { f.close(); }
});

test("exclusive publication holds readers and refuses another writer before the maximum can regress", () => {
  const f = fixture();
  try {
    writeRecoveryCommandBarrier(f.home, SCOPE, 1000);
    const rename = fs.renameSync;
    const injected = mock.method(fs, "renameSync", (...args: unknown[]) => {
      assert.equal(recoveryCommandRefused(f.home, SCOPE, cmd(9000)), true);
      assert.throws(() => writeRecoveryCommandBarrier(f.home, SCOPE, 5000), /Recovery command barrier refused/);
      assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).notBeforeMs, 1000);
      return Reflect.apply(rename, fs, args);
    });
    try { writeRecoveryCommandBarrier(f.home, SCOPE, 2000); }
    finally { injected.mock.restore(); }
    writeRecoveryCommandBarrier(f.home, SCOPE, 5000);
    writeRecoveryCommandBarrier(f.home, SCOPE, 1000);
    assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).notBeforeMs, 5000);
  } finally { f.close(); }
});

test("concurrent real-file readers see only complete private JSON during repeated durable replacements", async () => {
  const f = fixture();
  const shared = new SharedArrayBuffer(4), done = new Int32Array(shared);
  let worker: Worker | null = null;
  try {
    writeRecoveryCommandBarrier(f.home, SCOPE, 1000);
    worker = new Worker(`const fs=require('node:fs');const {parentPort,workerData}=require('node:worker_threads');
      const done=new Int32Array(workerData.shared), seen=new Set();let reads=0;
      parentPort.postMessage('ready');try { while(!Atomics.load(done,0)) {
        const value=JSON.parse(fs.readFileSync(workerData.file,'utf8'));const st=fs.statSync(workerData.file);
        if(value.version!==1||!Number.isSafeInteger(value.notBeforeMs)||(st.mode&0o7777)!==0o600)throw Error('invalid atomic document');
        seen.add(value.notBeforeMs);reads++;
      } parentPort.postMessage({reads,versions:seen.size}); }catch(e){parentPort.postMessage({failed:true});}`,
    { eval: true, workerData: { file: f.file, shared } });
    const completed = new Promise<{ reads: number; versions: number; failed?: boolean }>((resolve, reject) => {
      worker!.on("message", value => { if (value !== "ready") resolve(value); }); worker!.once("error", reject);
    });
    await new Promise<void>(resolve => worker!.once("message", () => resolve()));
    for (let i = 1; i <= 80; i++) writeRecoveryCommandBarrier(f.home, SCOPE, 1000 + i);
    Atomics.store(done, 0, 1);
    const result = await completed;
    assert.notEqual(result.failed, true); assert.ok(result.reads > 0); assert.ok(result.versions > 1);
    assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).notBeforeMs, 1080);
  } finally { Atomics.store(done, 0, 1); await worker?.terminate(); f.close(); }
});
