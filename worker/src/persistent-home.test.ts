import assert from "node:assert/strict";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  markPersistentHomeHandoverComplete, PERSISTENT_HOME_MANIFEST,
  preparePersistentHomeForHandover, verifyPersistentHome,
  type PersistentHomeOptions,
} from "./persistent-home";

const VOLUME = "d6481580-14af-430c-af4a-f3540dfb833d";
const OP = "reviewed-handover-2026-10-04";
const escaped = (s: string) => s.replace(/\\/g, "\\134").replace(/ /g, "\\040").replace(/\t/g, "\\011").replace(/\n/g, "\\012");
function fixture(t: test.TestContext, name = "home") {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-persistent-home-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, name);
  mkdirSync(home, { mode: 0o700 });
  const st = lstatSync(home, { bigint: true });
  // The Linux stat ABI's device fields, including high bits (also makes a
  // realistic injected table when these filesystem tests run on macOS).
  const major = ((st.dev >> 8n) & 0xfffn) | ((st.dev >> 32n) & 0xfffff000n);
  const minor = (st.dev & 0xffn) | ((st.dev >> 12n) & 0xffffff00n);
  const line = `40 20 ${major}:${minor} / ${escaped(home)} rw,relatime shared:2 - ext4 /dev/volume rw\n`;
  const env: NodeJS.ProcessEnv = {
    MERRYMEN_PERSISTENT_HOME_REQUIRED: "1", MERRYMEN_HOME: home,
    RAILWAY_VOLUME_MOUNT_PATH: home, MERRYMEN_HOME_VOLUME_ID: VOLUME,
  };
  const options: PersistentHomeOptions = { readMountInfo: () => line };
  const initial = { ...env, MERRYMEN_INITIAL_HANDOVER: OP };
  return { dir, home, st, line, env, initial, options, halt: path.join(home, "FLEET_HALT"), manifest: path.join(home, PERSISTENT_HOME_MANIFEST) };
}

test("the same volume survives device renumbering while current mount and operation proofs stay exact", t => {
  const f = fixture(t);
  preparePersistentHomeForHandover(f.initial, f.options);
  const saved = JSON.parse(readFileSync(f.manifest, "utf8"));
  saved.device = String(BigInt(saved.device) + 1n);
  saved.handover.halt.device = saved.device;
  writeFileSync(f.manifest, JSON.stringify(saved), { mode: 0o600 });
  const prepared = preparePersistentHomeForHandover(f.initial, f.options)!;
  assert.equal(prepared.device, String(f.st.dev));
  assert.equal(prepared.halt!.device, String(f.st.dev));
  assert.ok(verifyPersistentHome(f.initial, f.options));
  markPersistentHomeHandoverComplete(prepared, prepared.halt!, f.initial, f.options);
  assert.equal(existsSync(f.halt), false);
  assert.ok(verifyPersistentHome(f.initial, f.options));
});

test("self-hosted calls remain read-only and do not inspect a configured directory without opt-in", t => {
  const f = fixture(t);
  const env = { MERRYMEN_HOME: path.join(f.dir, "absent"), MERRYMEN_INITIAL_HANDOVER: OP };
  const options = { readMountInfo: () => { throw new Error("must not read mountinfo"); } };
  assert.equal(verifyPersistentHome(env, options), null);
  assert.equal(preparePersistentHomeForHandover(env, options), null);
  assert.equal(existsSync(env.MERRYMEN_HOME), false);
});

test("production refuses fallback paths, missing IDs and unmounted or ephemeral homes before any write", t => {
  const f = fixture(t);
  for (const env of [
    { ...f.initial, MERRYMEN_HOME: "relative" },
    { ...f.initial, MERRYMEN_HOME: path.join(f.home, "child") },
    { ...f.initial, MERRYMEN_HOME_VOLUME_ID: undefined, RAILWAY_VOLUME_ID: VOLUME },
    { ...f.initial, MERRYMEN_HOME_VOLUME_ID: "a-volume-name" },
  ]) assert.throws(() => preparePersistentHomeForHandover(env, f.options), /Persistent home refused/);
  for (const line of [
    f.line.replace(escaped(f.home), escaped(f.dir)), // Ancestor mount is insufficient.
    f.line.replace(" - ext4 ", " - overlay "),
    f.line.replace(" - ext4 ", " - tmpfs "),
    f.line.replace("rw,relatime", "ro,relatime"),
    f.line.replace(/\d+:\d+/, "999:999"),
    f.line + f.line, // Stacked/ambiguous mounts are not accepted.
    f.line + `41 40 0:1 / ${escaped(path.join(f.home, "children"))} rw - tmpfs tmpfs rw\n`,
    "malformed table\n",
  ]) assert.throws(() => preparePersistentHomeForHandover(f.initial, { readMountInfo: () => line }), /Persistent home refused/);
  assert.deepEqual(readdirSync(f.home), []);
});

test("the mounted root and its ancestors must be plain directories with private permissions", t => {
  const f = fixture(t);
  chmodSync(f.home, 0o755);
  assert.throws(() => verifyPersistentHome(f.initial, f.options), /0700/);
  assert.throws(() => preparePersistentHomeForHandover(f.env, f.options), /0700/);
  assert.deepEqual(readdirSync(f.home), []);
  chmodSync(f.home, 0o700);
  const alias = path.join(f.dir, "alias");
  symlinkSync(f.home, alias);
  const aliasEnv = { ...f.initial, MERRYMEN_HOME: alias, RAILWAY_VOLUME_MOUNT_PATH: alias };
  assert.throws(() => preparePersistentHomeForHandover(aliasEnv, { readMountInfo: () => f.line.replace(escaped(f.home), escaped(alias)) }), /plain owned directory/);
  const parentAlias = path.join(f.dir, "parent-alias");
  symlinkSync(f.dir, parentAlias);
  const nested = path.join(parentAlias, "home");
  assert.throws(() => preparePersistentHomeForHandover({ ...f.initial, MERRYMEN_HOME: nested, RAILWAY_VOLUME_MOUNT_PATH: nested },
    { readMountInfo: () => f.line.replace(escaped(f.home), escaped(nested)) }), /symlink ancestors/);
  assert.deepEqual(readdirSync(f.home), []);
});

test("only explicit empty mounted-volume initialization may make a fresh root private", t => {
  const f = fixture(t);
  chmodSync(f.home, 0o775);
  assert.throws(() => preparePersistentHomeForHandover(f.initial, { readMountInfo: () => f.line.replace(" - ext4 ", " - overlay ") }), /durable device/);
  assert.equal(lstatSync(f.home).mode & 0o777, 0o775);
  writeFileSync(path.join(f.home, "existing-data"), "existing book", { mode: 0o600 });
  assert.throws(() => preparePersistentHomeForHandover(f.initial, f.options), /only explicit empty-volume/);
  assert.equal(lstatSync(f.home).mode & 0o777, 0o775);
  assert.equal(existsSync(f.halt), false);
  rmSync(path.join(f.home, "existing-data"));
  const prepared = preparePersistentHomeForHandover(f.initial, f.options)!;
  assert.equal(lstatSync(f.home).mode & 0o777, 0o700);
  assert.equal(prepared.inode, String(f.st.ino));
  assert.equal(prepared.handoverState, "held");
});

test("empty mounts require explicit initialization; existing data or a halt is never overwritten", t => {
  const f = fixture(t);
  assert.throws(() => verifyPersistentHome(f.env, f.options), /manifest is missing/);
  assert.throws(() => preparePersistentHomeForHandover(f.env, f.options), /explicit initial handover token/);
  assert.deepEqual(readdirSync(f.home), []);
  writeFileSync(f.halt, "operator's existing hold\n", { mode: 0o600 });
  assert.throws(() => preparePersistentHomeForHandover(f.initial, f.options), /only an empty mounted root/);
  assert.equal(readFileSync(f.halt, "utf8"), "operator's existing hold\n");
  assert.equal(existsSync(f.manifest), false);
  rmSync(f.halt);
  writeFileSync(path.join(f.home, "merrymen.db"), "existing original book", { mode: 0o600 });
  assert.throws(() => preparePersistentHomeForHandover(f.initial, f.options), /only an empty mounted root/);
  assert.equal(existsSync(f.halt), false);
});

test("authorized preparation pins the actual root and returns an owned halt proof without unholding on restart", t => {
  const f = fixture(t, "home with spaces");
  const prepared = preparePersistentHomeForHandover(f.initial, f.options)!;
  assert.equal(prepared.handoverState, "held");
  assert.equal(prepared.id, VOLUME);
  assert.equal(prepared.device, String(f.st.dev));
  assert.equal(prepared.inode, String(f.st.ino));
  assert.equal(prepared.halt!.path, f.halt);
  assert.equal(prepared.halt!.inode, String(lstatSync(f.halt, { bigint: true }).ino));
  assert.equal(prepared.halt!.text, readFileSync(f.halt, "utf8"));
  assert.equal(lstatSync(f.halt).mode & 0o777, 0o600);
  assert.equal(lstatSync(f.manifest).mode & 0o777, 0o600);
  writeFileSync(path.join(f.home, "merrymen.db"), "the imported original book", { mode: 0o600 });
  assert.deepEqual(verifyPersistentHome(f.initial, f.options), {
    id: VOLUME, mountPath: f.home, homeRoot: f.home, device: String(f.st.dev), inode: String(f.st.ino),
  });
  assert.deepEqual(preparePersistentHomeForHandover(f.env, f.options), prepared);
  assert.equal(readFileSync(f.halt, "utf8"), prepared.halt!.text);
  assert.throws(() => verifyPersistentHome({ ...f.initial, MERRYMEN_HOME_VOLUME_ID: "12345678-1234-1234-1234-123456789abc" }, f.options), /manifest does not match/);
  assert.throws(() => verifyPersistentHome({ ...f.initial, MERRYMEN_INITIAL_HANDOVER: "different-operation" }, f.options), /manifest does not match/);
});

test("crash after the durable halt leaves a partial root held and startup refuses every retry", t => {
  const f = fixture(t);
  assert.throws(() => preparePersistentHomeForHandover(f.initial, { ...f.options, afterHaltSynced: () => {
    assert.equal(existsSync(f.halt), true);
    assert.equal(existsSync(f.manifest), false);
    throw new Error("simulated crash");
  } }), /simulated crash/);
  const text = readFileSync(f.halt, "utf8");
  assert.throws(() => verifyPersistentHome(f.initial, f.options), /manifest is missing/);
  assert.throws(() => preparePersistentHomeForHandover(f.initial, f.options), /only an empty mounted root/);
  assert.equal(readFileSync(f.halt, "utf8"), text);
});

test("copied manifests cannot rebind a new root, and unsafe or torn evidence fails closed", t => {
  const f = fixture(t);
  preparePersistentHomeForHandover(f.initial, f.options);
  const savedManifest = readFileSync(f.manifest, "utf8");
  const savedHalt = readFileSync(f.halt, "utf8");
  chmodSync(f.manifest, 0o644);
  assert.throws(() => verifyPersistentHome(f.env, f.options), /private owned plain file/);
  chmodSync(f.manifest, 0o600);
  writeFileSync(f.manifest, '{"version":');
  assert.throws(() => verifyPersistentHome(f.env, f.options), /manifest is incomplete/);
  writeFileSync(f.manifest, savedManifest);
  const alternate = JSON.parse(savedManifest);
  alternate.device = "999";
  writeFileSync(f.manifest, JSON.stringify(alternate));
  assert.throws(() => verifyPersistentHome(f.env, f.options), /manifest does not match/);
  writeFileSync(f.manifest, savedManifest);
  renameSync(f.halt, path.join(f.home, "original-halt"));
  symlinkSync(f.manifest, f.halt);
  assert.throws(() => verifyPersistentHome(f.env, f.options), /plain file/);
  rmSync(f.halt);
  writeFileSync(f.halt, savedHalt, { mode: 0o600 });
  // Identical text on a new inode does not prove ownership of the original hold.
  assert.throws(() => verifyPersistentHome(f.env, f.options), /original handover halt/);
  renameSync(f.home, path.join(f.dir, "old-home"));
  mkdirSync(f.home, { mode: 0o700 });
  writeFileSync(f.manifest, savedManifest, { mode: 0o600 });
  writeFileSync(f.halt, savedHalt, { mode: 0o600 });
  assert.throws(() => verifyPersistentHome(f.env, f.options), /manifest does not match/);
});

test("explicit completion releases only its own hold and future restarts pass with the retained initial token", t => {
  const f = fixture(t);
  const prepared = preparePersistentHomeForHandover(f.initial, f.options)!;
  const identity = verifyPersistentHome(f.initial, f.options)!;
  assert.deepEqual(markPersistentHomeHandoverComplete(identity, prepared.halt!, f.initial, f.options), identity);
  assert.equal(existsSync(f.halt), false);
  assert.equal(JSON.parse(readFileSync(f.manifest, "utf8")).handover.state, "complete");
  assert.deepEqual(verifyPersistentHome(f.initial, f.options), identity);
  assert.equal(preparePersistentHomeForHandover(f.initial, f.options)!.handoverState, "complete");
  assert.deepEqual(markPersistentHomeHandoverComplete(identity, prepared.halt!, f.initial, f.options), identity);
  writeFileSync(f.halt, "a new operator halt", { mode: 0o600 });
  assert.deepEqual(verifyPersistentHome(f.initial, f.options), identity);
  assert.throws(() => markPersistentHomeHandoverComplete(identity, prepared.halt!, f.initial, f.options), /original handover halt/);
  assert.equal(readFileSync(f.halt, "utf8"), "a new operator halt");
});

test("a crash after the completed receipt remains held until another explicit completion", t => {
  const f = fixture(t);
  const prepared = preparePersistentHomeForHandover(f.initial, f.options)!;
  assert.throws(() => markPersistentHomeHandoverComplete(prepared, prepared.halt!, f.initial,
    { ...f.options, afterCompletionSynced: () => { throw new Error("simulated release crash"); } }), /simulated release crash/);
  assert.equal(JSON.parse(readFileSync(f.manifest, "utf8")).handover.state, "complete");
  assert.equal(readFileSync(f.halt, "utf8"), prepared.halt!.text);
  assert.equal(preparePersistentHomeForHandover(f.initial, f.options)!.handoverState, "complete");
  assert.equal(existsSync(f.halt), true, "ordinary startup never finishes a release");
  markPersistentHomeHandoverComplete(prepared, prepared.halt!, f.initial, f.options);
  assert.equal(existsSync(f.halt), false);
});

test("a changed hold or target proof refuses completion and the last release check preserves a replacement halt", t => {
  const f = fixture(t);
  const prepared = preparePersistentHomeForHandover(f.initial, f.options)!;
  assert.throws(() => markPersistentHomeHandoverComplete({ ...prepared, inode: "1" }, prepared.halt!, f.initial, f.options), /target root proof/);
  writeFileSync(f.halt, "owner paused the target", { mode: 0o600 });
  assert.throws(() => markPersistentHomeHandoverComplete(prepared, prepared.halt!, f.initial, f.options), /original handover halt/);
  assert.equal(JSON.parse(readFileSync(f.manifest, "utf8")).handover.state, "held");
  writeFileSync(f.halt, prepared.halt!.text);
  assert.throws(() => markPersistentHomeHandoverComplete(prepared, prepared.halt!, f.initial, {
    ...f.options, beforeHaltRemoval: () => writeFileSync(f.halt, "new independent operator halt"),
  }), /original handover halt/);
  assert.equal(readFileSync(f.halt, "utf8"), "new independent operator halt");
  assert.equal(JSON.parse(readFileSync(f.manifest, "utf8")).handover.state, "complete");
  assert.equal(existsSync(f.halt), true);
});
