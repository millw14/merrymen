import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  adoptPopulatedPersistentHome, controlAdoptedPersistentHomeHalt,
  markPersistentHomeHandoverComplete, PERSISTENT_HOME_MANIFEST, PERSISTENT_HOME_PREADOPTION,
  PERSISTENT_HOME_REHALT_RECEIPT, preparePersistentHomeForHandover, verifyPersistentHome,
  type PersistentHomeOptions,
} from "./persistent-home";
import { proveRecoveryReplyRoot } from "./recovery-reply-proof";

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

// THE POPULATED INCIDENT VOLUME: tenant homes, an operator's hand-made halt,
// and no manifest. Adoption, release and re-halt (docs/fleet-resume.md).
const ORIGINAL_HALT = "operator incident halt: stand every child down, listener only\n";
const SCOPE = `0x${"1".repeat(40)}:trade`;
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const crash = () => { throw new Error("simulated crash"); };
function tree(dir: string): unknown {
  return readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name), st = lstatSync(file);
    return [name, st.mode, st.ino, st.nlink, st.isDirectory() ? tree(file) : readFileSync(file).toString("base64")];
  });
}
function populated(t: test.TestContext) {
  const f = fixture(t), book = path.join(f.home, "children", "0xabc", "merrymen.db");
  mkdirSync(path.dirname(book), { recursive: true, mode: 0o700 });
  writeFileSync(book, "original populated book", { mode: 0o600 });
  writeFileSync(f.halt, ORIGINAL_HALT, { mode: 0o600 });
  const adopt = { ...f.initial, MERRYMEN_ADOPT_HOME_HALT_SHA256: sha(ORIGINAL_HALT) };
  return {
    ...f, book, adopt, originalInode: String(lstatSync(f.halt, { bigint: true }).ino),
    record: path.join(f.home, PERSISTENT_HOME_PREADOPTION), receipt: path.join(f.home, PERSISTENT_HOME_REHALT_RECEIPT),
    release: { ...adopt, MERRYMEN_RELEASE_HOME_HALT: OP, MERRYMEN_FLEET_ROLLOUT: SCOPE },
    rehalt: { ...adopt, MERRYMEN_REHALT_HOME: OP },
    // The recovery-reply listener's own mode, as the runbook keeps it during the hold.
    listener: { ...f.initial, MERRYMEN_HOSTED: "1", MERRYMEN_FLEET_RECOVERY_REPORT_ONLY: "1", MERRYMEN_FLEET_RECOVERY_REPLIES: "1",
      DATABASE_URL: "postgresql://synthetic@127.0.0.1:1/synthetic" } as NodeJS.ProcessEnv,
  };
}
const manifestState = (f: { manifest: string }) => JSON.parse(readFileSync(f.manifest, "utf8")).handover.state;

test("adoption refuses a wrong pin, a loose or linked halt, an empty root and a manifest it did not make, before any write", t => {
  const f = populated(t), before = tree(f.home);
  assert.equal(adoptPopulatedPersistentHome(f.initial, f.options), null, "not asked for, not attempted");
  for (const env of [
    { ...f.adopt, MERRYMEN_ADOPT_HOME_HALT_SHA256: sha("a different halt\n") },
    { ...f.adopt, MERRYMEN_ADOPT_HOME_HALT_SHA256: sha(ORIGINAL_HALT).slice(1) },
    { ...f.adopt, MERRYMEN_INITIAL_HANDOVER: undefined },
    { ...f.adopt, MERRYMEN_INITIAL_HANDOVER: "not a token" },
    { ...f.adopt, MERRYMEN_PERSISTENT_HOME_REQUIRED: undefined },
  ]) assert.throws(() => adoptPopulatedPersistentHome(env, f.options), /Persistent home refused/);
  assert.deepEqual(tree(f.home), before);
  chmodSync(f.halt, 0o644);
  assert.throws(() => adoptPopulatedPersistentHome(f.adopt, f.options), /private owned plain file/);
  chmodSync(f.halt, 0o600);
  const second = path.join(f.dir, "second-name");
  linkSync(f.halt, second);
  assert.throws(() => adoptPopulatedPersistentHome(f.adopt, f.options), /private owned plain file/);
  rmSync(second);
  renameSync(f.halt, path.join(f.dir, "away"));
  assert.throws(() => adoptPopulatedPersistentHome(f.adopt, f.options), /original halt to be present/);
  renameSync(path.join(f.dir, "away"), f.halt);
  assert.deepEqual(tree(f.home), before);
  // A halt too large to keep byte for byte inside its record is refused even when pinned.
  const large = "x".repeat(4097);
  writeFileSync(f.halt, large);
  assert.throws(() => adoptPopulatedPersistentHome({ ...f.adopt, MERRYMEN_ADOPT_HOME_HALT_SHA256: sha(large) }, f.options), /pinned original halt hash/);
  assert.equal(existsSync(f.record), false);

  const empty = fixture(t);
  assert.throws(() => adoptPopulatedPersistentHome({ ...empty.initial, MERRYMEN_ADOPT_HOME_HALT_SHA256: sha(ORIGINAL_HALT) }, empty.options), /populated root/);
  writeFileSync(empty.halt, ORIGINAL_HALT, { mode: 0o600 });
  assert.throws(() => adoptPopulatedPersistentHome({ ...empty.initial, MERRYMEN_ADOPT_HOME_HALT_SHA256: sha(ORIGINAL_HALT) }, empty.options), /populated root/);
  assert.deepEqual(readdirSync(empty.home), ["FLEET_HALT"]);

  const fresh = fixture(t), prepared = preparePersistentHomeForHandover(fresh.initial, fresh.options)!;
  writeFileSync(path.join(fresh.home, "merrymen.db"), "a book written after initialization", { mode: 0o600 });
  const initialized = tree(fresh.home);
  assert.throws(() => adoptPopulatedPersistentHome({ ...fresh.initial, MERRYMEN_ADOPT_HOME_HALT_SHA256: sha(prepared.halt!.text) }, fresh.options), /not created by this adoption/);
  assert.deepEqual(tree(fresh.home), initialized);
});

test("adoption puts a canonical halt in the original's place in one rename, keeps the original's bytes, and holds", t => {
  const f = populated(t), present: boolean[] = [];
  const watch = () => { present.push(existsSync(f.halt)); };
  const prepared = adoptPopulatedPersistentHome(f.adopt, { ...f.options,
    afterPreAdoptionSynced: watch, afterAdoptionHaltSynced: watch, afterAdoptionRenamed: watch })!;
  assert.deepEqual(present, [true, true, true], "FLEET_HALT is never absent");
  assert.equal(prepared.handoverState, "held");
  assert.equal(prepared.halt!.text, readFileSync(f.halt, "utf8"));
  assert.match(prepared.halt!.text, new RegExp(`operation=${OP}\nvolume=${VOLUME}\n$`));
  assert.notEqual(prepared.halt!.inode, f.originalInode);
  assert.equal(lstatSync(f.halt).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(f.record, "utf8")).halt, { path: f.halt, inode: f.originalInode,
    size: Buffer.byteLength(ORIGINAL_HALT), sha256: sha(ORIGINAL_HALT), bytes: Buffer.from(ORIGINAL_HALT).toString("base64") });
  assert.equal(lstatSync(f.record).mode & 0o777, 0o600);
  assert.equal(manifestState(f), "held");
  assert.deepEqual(readdirSync(f.home).sort(), [PERSISTENT_HOME_PREADOPTION, PERSISTENT_HOME_MANIFEST, "FLEET_HALT", "children"].sort());
  assert.equal(readFileSync(f.book, "utf8"), "original populated book");
  // Ordinary startup now verifies it, and a restart with the variable still set changes nothing.
  assert.deepEqual(preparePersistentHomeForHandover(f.env, f.options), prepared);
  const after = tree(f.home);
  assert.deepEqual(adoptPopulatedPersistentHome(f.adopt, f.options), prepared);
  // The token may be retired once adopted; the pin left behind still changes nothing.
  assert.deepEqual(adoptPopulatedPersistentHome({ ...f.adopt, MERRYMEN_INITIAL_HANDOVER: undefined }, f.options), prepared);
  assert.deepEqual(tree(f.home), after);
  assert.throws(() => adoptPopulatedPersistentHome({ ...f.adopt, MERRYMEN_ADOPT_HOME_HALT_SHA256: sha("another halt") }, f.options), /pinned original halt/);
});

test("every adoption crash seam converges under the same variables while ordinary startup refuses", t => {
  for (const seam of ["afterPreAdoptionSynced", "afterAdoptionHaltSynced", "afterAdoptionRenamed"] as const) {
    const f = populated(t);
    assert.throws(() => adoptPopulatedPersistentHome(f.adopt, { ...f.options, [seam]: crash }), /simulated crash/);
    assert.equal(existsSync(f.halt), true, seam);
    assert.equal(existsSync(f.manifest), false, seam);
    assert.throws(() => preparePersistentHomeForHandover(f.initial, f.options), /only an empty mounted root/, seam);
    assert.throws(() => adoptPopulatedPersistentHome({ ...f.adopt, MERRYMEN_ADOPT_HOME_HALT_SHA256: sha("another halt") }, f.options), /pinned original halt/, seam);
    // The listener keeps standing behind whichever halt is there.
    proveRecoveryReplyRoot(f.listener, f.options.readMountInfo).assert();
    const prepared = adoptPopulatedPersistentHome(f.adopt, f.options)!;
    assert.equal(prepared.handoverState, "held", seam);
    assert.equal(readFileSync(f.halt, "utf8"), prepared.halt!.text, seam);
    assert.equal(JSON.parse(readFileSync(f.record, "utf8")).halt.inode, f.originalInode, seam);
    assert.deepEqual(readdirSync(f.home).sort(), [PERSISTENT_HOME_PREADOPTION, PERSISTENT_HOME_MANIFEST, "FLEET_HALT", "children"].sort(), seam);
    assert.ok(verifyPersistentHome(f.env, f.options));
  }
});

test("the env release needs the held adopted manifest, its token, the pin and a rollout scope; asked again it changes nothing", t => {
  const f = populated(t);
  adoptPopulatedPersistentHome(f.adopt, f.options);
  assert.equal(controlAdoptedPersistentHomeHalt(f.adopt, f.options), null, "not asked for, not attempted");
  const before = tree(f.home);
  for (const env of [
    { ...f.release, MERRYMEN_RELEASE_HOME_HALT: "another-operation" },
    { ...f.release, MERRYMEN_RELEASE_HOME_HALT: "not a token" },
    { ...f.release, MERRYMEN_ADOPT_HOME_HALT_SHA256: undefined },
    { ...f.release, MERRYMEN_ADOPT_HOME_HALT_SHA256: sha("another halt") },
    { ...f.release, MERRYMEN_PERSISTENT_HOME_REQUIRED: undefined },
    { ...f.release, MERRYMEN_INITIAL_HANDOVER: "another-operation" },
    // The generation is a positive integer after one `@`, or absent for the adoption's own halt.
    ...[`${OP}@0`, `${OP}@01`, `${OP}@`, `${OP}@1@1`, `${OP}@-1`, "@1"].map(MERRYMEN_RELEASE_HOME_HALT => ({ ...f.release, MERRYMEN_RELEASE_HOME_HALT })),
  ]) assert.throws(() => controlAdoptedPersistentHomeHalt(env, f.options), /Persistent home refused/);
  for (const MERRYMEN_FLEET_ROLLOUT of ["none", " none "]) {
    const withheld = controlAdoptedPersistentHomeHalt({ ...f.release, MERRYMEN_FLEET_ROLLOUT }, f.options)!;
    assert.deepEqual([withheld.action, withheld.handoverState], ["withheld", "held"]);
  }
  // A generation no re-halt has put back yet lifts nothing either.
  const ahead = controlAdoptedPersistentHomeHalt({ ...f.release, MERRYMEN_RELEASE_HOME_HALT: `${OP}@1` }, f.options)!;
  assert.deepEqual([ahead.action, ahead.handoverState], ["withheld", "held"]);
  assert.match(ahead.detail, /generation 1, but the standing halt is generation 0/);
  // B1's parser reads the scope, so a typo or a missing value is a refusal
  // and never permission: unset is refused because this is the Railway fleet.
  for (const MERRYMEN_FLEET_ROLLOUT of [undefined, "", "None", "NONE", "off", "0", "false", "nobody", "none,", "halt", "pause", "0xabc",
    `0x${"1".repeat(40)}`, `0x${"1".repeat(40)}:Trade`, `${SCOPE},${SCOPE}`]) {
    assert.throws(() => controlAdoptedPersistentHomeHalt({ ...f.release, MERRYMEN_FLEET_ROLLOUT }, f.options), /MERRYMEN_FLEET_ROLLOUT/,
      String(MERRYMEN_FLEET_ROLLOUT));
  }
  assert.deepEqual(tree(f.home), before);
  assert.equal(manifestState(f), "held");
  const released = controlAdoptedPersistentHomeHalt(f.release, f.options)!;
  assert.deepEqual([released.action, released.handoverState], ["released", "complete"]);
  assert.equal(existsSync(f.halt), false);
  assert.equal(manifestState(f), "complete");
  assert.ok(verifyPersistentHome(f.adopt, f.options));
  assert.equal(controlAdoptedPersistentHomeHalt(f.release, f.options)!.action, "already-released");
  // A halt made by hand after the release is honoured, and the variable never lifts it, private or not.
  writeFileSync(f.halt, "operator stop\n", { mode: 0o644 });
  assert.ok(verifyPersistentHome(f.adopt, f.options));
  for (const MERRYMEN_FLEET_ROLLOUT of [SCOPE, "none"]) {
    const kept = controlAdoptedPersistentHomeHalt({ ...f.release, MERRYMEN_FLEET_ROLLOUT }, f.options)!;
    assert.equal(kept.action, "already-released");
    assert.doesNotMatch(JSON.stringify(kept), new RegExp(`${OP}|${sha(ORIGINAL_HALT)}`), "log-safe detail");
  }
  assert.equal(readFileSync(f.halt, "utf8"), "operator stop\n");
  assert.equal(readFileSync(f.book, "utf8"), "original populated book");
  assert.equal(JSON.parse(readFileSync(f.record, "utf8")).halt.bytes, Buffer.from(ORIGINAL_HALT).toString("base64"));
});

test("a freshly initialized volume is not released or re-halted by the env variables, whatever hash is pinned", t => {
  const f = fixture(t), prepared = preparePersistentHomeForHandover(f.initial, f.options)!;
  writeFileSync(path.join(f.home, "merrymen.db"), "a book", { mode: 0o600 });
  const env = { ...f.initial, MERRYMEN_ADOPT_HOME_HALT_SHA256: sha(prepared.halt!.text), MERRYMEN_FLEET_ROLLOUT: "all" };
  for (const control of [{ MERRYMEN_RELEASE_HOME_HALT: OP }, { MERRYMEN_REHALT_HOME: OP }]) {
    assert.throws(() => controlAdoptedPersistentHomeHalt({ ...env, ...control }, f.options), /adopted under the pinned original halt/);
  }
  assert.equal(readFileSync(f.halt, "utf8"), prepared.halt!.text);
  assert.equal(manifestState(f), "held");
});

test("a release that crashed after its durable receipt finishes on the next start, and only into a scope", t => {
  const f = populated(t), prepared = adoptPopulatedPersistentHome(f.adopt, f.options)!;
  assert.throws(() => controlAdoptedPersistentHomeHalt(f.release, { ...f.options, afterCompletionSynced: crash }), /simulated crash/);
  assert.equal(manifestState(f), "complete");
  assert.equal(readFileSync(f.halt, "utf8"), prepared.halt!.text);
  assert.equal(controlAdoptedPersistentHomeHalt({ ...f.release, MERRYMEN_FLEET_ROLLOUT: "none" }, f.options)!.action, "withheld");
  assert.equal(existsSync(f.halt), true);
  assert.equal(controlAdoptedPersistentHomeHalt(f.release, f.options)!.action, "released");
  assert.equal(existsSync(f.halt), false);
});

test("the env re-halt publishes a canonical halt without replacing one, records it first, and returns the manifest to held", t => {
  const f = populated(t);
  adoptPopulatedPersistentHome(f.adopt, f.options);
  controlAdoptedPersistentHomeHalt(f.release, f.options);
  for (const env of [{ ...f.rehalt, MERRYMEN_REHALT_HOME: "another-operation" }, { ...f.rehalt, MERRYMEN_ADOPT_HOME_HALT_SHA256: undefined }]) {
    assert.throws(() => controlAdoptedPersistentHomeHalt(env, f.options), /Persistent home refused/);
  }
  assert.equal(existsSync(f.halt), false);
  // A release variable left behind, naming another operation, does not stop the rollback.
  const rehalted = controlAdoptedPersistentHomeHalt({ ...f.rehalt, MERRYMEN_RELEASE_HOME_HALT: "an-earlier-operation" }, f.options)!;
  assert.deepEqual([rehalted.action, rehalted.handoverState], ["rehalted", "held"]);
  assert.match(rehalted.detail, /MERRYMEN_RELEASE_HOME_HALT is ignored/);
  const manifest = JSON.parse(readFileSync(f.manifest, "utf8")), st = lstatSync(f.halt, { bigint: true });
  assert.equal(manifest.handover.state, "held");
  assert.equal(manifest.handover.halt.inode, String(st.ino));
  assert.equal(st.nlink, 1n);
  assert.equal(st.mode & 0o777n, 0o600n);
  assert.equal(readFileSync(f.halt, "utf8"), manifest.handover.halt.text);
  assert.equal(JSON.parse(readFileSync(f.receipt, "utf8")).halt.inode, String(st.ino));
  assert.equal(lstatSync(f.receipt).mode & 0o777, 0o600);
  assert.equal(preparePersistentHomeForHandover(f.env, f.options)!.handoverState, "held");
  assert.equal(controlAdoptedPersistentHomeHalt(f.rehalt, f.options)!.action, "already-held");
  // A release variable left behind never defeats the rollback, whatever it says.
  for (const MERRYMEN_RELEASE_HOME_HALT of [OP, "not a token", "another-operation"]) {
    const both = controlAdoptedPersistentHomeHalt({ ...f.rehalt, MERRYMEN_RELEASE_HOME_HALT, MERRYMEN_FLEET_ROLLOUT: SCOPE }, f.options)!;
    assert.deepEqual([both.action, both.handoverState], ["already-held", "held"]);
    assert.match(both.detail, /MERRYMEN_RELEASE_HOME_HALT is ignored/);
  }
  assert.equal(existsSync(f.halt), true);
  // The re-halt consumed the release before it; releasing again names the new generation.
  assert.equal(controlAdoptedPersistentHomeHalt({ ...f.release, MERRYMEN_RELEASE_HOME_HALT: `${OP}@1` }, f.options)!.action, "released");
  assert.equal(existsSync(f.halt), false);
  // An operator's halt is never replaced, and the released manifest is left alone with it.
  writeFileSync(f.halt, "operator stop\n", { mode: 0o600 });
  const withheld = controlAdoptedPersistentHomeHalt(f.rehalt, f.options)!;
  assert.deepEqual([withheld.action, withheld.handoverState], ["withheld", "complete"]);
  assert.equal(readFileSync(f.halt, "utf8"), "operator stop\n");
  assert.equal(manifestState(f), "complete");
  assert.equal(readFileSync(f.book, "utf8"), "original populated book");
});

test("a re-halt consumes the release before it: the release variable left set after a rollback lifts nothing", t => {
  const f = populated(t), rollback = () => controlAdoptedPersistentHomeHalt(f.rehalt, f.options)!;
  adoptPopulatedPersistentHome(f.adopt, f.options);
  assert.equal(controlAdoptedPersistentHomeHalt(f.release, f.options)!.action, "released");
  for (const generation of [1, 2]) {
    const rehalted = rollback();
    assert.deepEqual([rehalted.action, rehalted.handoverState], ["rehalted", "held"]);
    assert.match(rehalted.detail, new RegExp(`generation ${generation}; only MERRYMEN_RELEASE_HOME_HALT=<operation token>@${generation} releases it`));
    assert.equal(JSON.parse(readFileSync(f.manifest, "utf8")).handover.haltGeneration, generation);
    const held = tree(f.home);
    // The operator removes the re-halt variable and leaves every earlier
    // release value set: each names a generation a re-halt has consumed.
    for (const MERRYMEN_RELEASE_HOME_HALT of [OP, ...Array.from({ length: generation - 1 }, (_, k) => `${OP}@${k + 1}`)]) {
      const stale = controlAdoptedPersistentHomeHalt({ ...f.release, MERRYMEN_RELEASE_HOME_HALT }, f.options)!;
      assert.deepEqual([stale.action, stale.handoverState], ["withheld", "held"], MERRYMEN_RELEASE_HOME_HALT);
      assert.match(stale.detail, new RegExp(`standing halt is generation ${generation}, so it stays`));
      assert.doesNotMatch(stale.detail, new RegExp(OP), "log-safe detail");
    }
    assert.deepEqual(tree(f.home), held, "a stale release writes nothing");
    assert.ok(verifyPersistentHome(f.env, f.options));
    const again = controlAdoptedPersistentHomeHalt({ ...f.release, MERRYMEN_RELEASE_HOME_HALT: `${OP}@${generation}` }, f.options)!;
    assert.deepEqual([again.action, again.handoverState], ["released", "complete"]);
    assert.equal(existsSync(f.halt), false);
    assert.equal(JSON.parse(readFileSync(f.manifest, "utf8")).handover.haltGeneration, generation, "completion keeps the generation");
  }
  // A manifest whose generation is not a positive integer is refused, not read as 0.
  const saved = JSON.parse(readFileSync(f.manifest, "utf8"));
  for (const haltGeneration of [0, -1, 1.5, "2", null]) {
    writeFileSync(f.manifest, JSON.stringify({ ...saved, handover: { ...saved.handover, haltGeneration } }) + "\n", { mode: 0o600 });
    assert.throws(() => verifyPersistentHome(f.env, f.options), /does not match the configured volume/, String(haltGeneration));
  }
});

test("every re-halt crash seam converges, and a halt made by hand meanwhile is kept", t => {
  for (const seam of ["afterRehaltHaltSynced", "afterRehaltReceiptSynced", "afterRehaltLinked", "afterRehaltPublished"] as const) {
    const f = populated(t);
    adoptPopulatedPersistentHome(f.adopt, f.options);
    controlAdoptedPersistentHomeHalt(f.release, f.options);
    assert.throws(() => controlAdoptedPersistentHomeHalt(f.rehalt, { ...f.options, [seam]: crash }), /simulated crash/);
    assert.equal(manifestState(f), "complete", seam);
    const rehalted = controlAdoptedPersistentHomeHalt(f.rehalt, f.options)!;
    assert.equal(rehalted.action, "rehalted", seam);
    const st = lstatSync(f.halt, { bigint: true });
    assert.equal(st.nlink, 1n, seam);
    assert.equal(JSON.parse(readFileSync(f.manifest, "utf8")).handover.halt.inode, String(st.ino), seam);
    assert.deepEqual(readdirSync(f.home).sort(),
      [PERSISTENT_HOME_PREADOPTION, PERSISTENT_HOME_MANIFEST, PERSISTENT_HOME_REHALT_RECEIPT, "FLEET_HALT", "children"].sort(), seam);
    assert.equal(preparePersistentHomeForHandover(f.env, f.options)!.handoverState, "held", seam);
  }
  for (const seam of ["afterRehaltReceiptSynced", "afterRehaltLinked"] as const) {
    const f = populated(t);
    adoptPopulatedPersistentHome(f.adopt, f.options);
    controlAdoptedPersistentHomeHalt(f.release, f.options);
    assert.throws(() => controlAdoptedPersistentHomeHalt(f.rehalt, { ...f.options, [seam]: crash }), /simulated crash/);
    // The operator stops the fleet by hand before the next start: a new
    // file in FLEET_HALT's place, which the re-halt must not take as its own.
    rmSync(f.halt, { force: true });
    writeFileSync(f.halt, "operator stop\n", { mode: 0o600 });
    assert.equal(controlAdoptedPersistentHomeHalt(f.rehalt, f.options)!.action, "withheld", seam);
    assert.equal(readFileSync(f.halt, "utf8"), "operator stop\n", seam);
    assert.equal(existsSync(path.join(f.home, ".fleet-halt-rehalt.tmp")), false, seam);
    assert.equal(manifestState(f), "complete", seam);
  }
});

test("the recovery-reply listener's current proof accepts the adopted and the re-halted manifests", t => {
  for (const token of [OP, undefined]) {
    const f = populated(t), env = { ...f.listener, MERRYMEN_INITIAL_HANDOVER: token }, mount = f.options.readMountInfo!;
    proveRecoveryReplyRoot(env, mount).assert(); // The incident's shape: the original halt and no manifest.
    adoptPopulatedPersistentHome(f.adopt, f.options);
    proveRecoveryReplyRoot(env, mount).assert();
    controlAdoptedPersistentHomeHalt(f.release, f.options);
    // Released, there is no halt for the listener to stand behind until the re-halt.
    assert.throws(() => proveRecoveryReplyRoot(env, mount), /Reply-only prerequisites/);
    controlAdoptedPersistentHomeHalt(f.rehalt, f.options);
    proveRecoveryReplyRoot(env, mount).assert();
  }
});
