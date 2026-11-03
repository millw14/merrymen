import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandDir, markRunning, writeCommand, writeCommandResult } from "./command-files";
const setup = (t: { after(fn: () => void): void }) => { const home = mkdtempSync(path.join(tmpdir(), "mm-durable-command-")); t.after(() => rmSync(home, { recursive: true, force: true })); return home; };

test("durable command publication replaces a destination link without changing its target", t => {
  const home = setup(t), dir = commandDir(home), other = path.join(home, "other-wallet.json");
  mkdirSync(dir); writeFileSync(other, "other wallet's record"); symlinkSync(other, path.join(dir, "order.json"));
  writeCommand(home, { id: "order", kind: "trade", at: Date.now() });
  assert.equal(readFileSync(other, "utf8"), "other wallet's record");
  assert.equal(fs.lstatSync(path.join(dir, "order.json")).isSymbolicLink(), false);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "order.json"), "utf8")).kind, "trade");
});

test("a queue's first acknowledgement syncs its directory entry as well as its bytes", t => {
  const home = setup(t), actual = fs.fsyncSync; let files = 0, directories = 0;
  fs.fsyncSync = ((fd: number) => { if (fs.fstatSync(fd).isDirectory()) directories++; else files++; actual(fd); }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try { writeCommand(home, { id: "order", kind: "trade", at: Date.now() }); assert.ok(files >= 1); assert.ok(directories >= 2); }
  finally { fs.fsyncSync = actual; syncBuiltinESMExports(); }
});

test("failed command fsync is never acknowledged as queued", t => {
  const home = setup(t), actual = fs.fsyncSync;
  fs.fsyncSync = ((fd: number) => { if (fs.fstatSync(fd).isFile()) throw Error("queue fsync failed"); actual(fd); }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try { assert.throws(() => writeCommand(home, { id: "order", kind: "trade", at: Date.now() }), /fsync failed/); assert.equal(existsSync(path.join(commandDir(home), "order.json")), false); }
  finally { fs.fsyncSync = actual; syncBuiltinESMExports(); }
});

test("running markers and receipts also replace links without following them outside the queue", t => {
  const home = setup(t), dir = commandDir(home), other = path.join(home, "other-wallet.json");
  mkdirSync(dir); writeFileSync(other, "other wallet's record");
  symlinkSync(other, path.join(dir, "order.running")); assert.equal(markRunning(home, "order", "trade"), true);
  assert.equal(readFileSync(other, "utf8"), "other wallet's record");
  symlinkSync(other, path.join(dir, "order.done.json")); writeCommandResult(home, { id: "order", ok: false, line: "refused", at: Date.now() });
  assert.equal(readFileSync(other, "utf8"), "other wallet's record");
  assert.equal(fs.lstatSync(path.join(dir, "order.done.json")).isSymbolicLink(), false);
});
