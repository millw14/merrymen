/**
 * Production-only prerequisite for the one-shot handover. A directory on the
 * container overlay must never be mistaken for the durable book's home.
 * Verification is read-only; only explicit preparation/completion writes here.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";

export const PERSISTENT_HOME_MANIFEST = ".merrymen-persistent-home.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVIDENCE_BYTES = 8 * 1024;
const EPHEMERAL_FS = new Set([
  "overlay", "overlayfs", "tmpfs", "ramfs", "rootfs", "devtmpfs", "proc", "sysfs",
  "cgroup", "cgroup2", "mqueue", "hugetlbfs", "debugfs", "tracefs", "securityfs",
]);

export interface PersistentHomeIdentity {
  id: string;
  mountPath: string;
  homeRoot: string;
  device: string;
  inode: string;
}
export interface PersistentHomeHaltProof {
  path: string;
  device: string;
  inode: string;
  text: string;
  operationToken: string;
}
export interface PreparedPersistentHome extends PersistentHomeIdentity {
  handoverState: "held" | "complete";
  halt: PersistentHomeHaltProof | null;
}
export interface PersistentHomeOptions {
  /** Trusted test seam. Production reads the kernel's mount table directly. */
  readMountInfo?: () => string;
  /** Crash seams run after both the file and its directory have been synced. */
  afterHaltSynced?: () => void;
  afterCompletionSynced?: () => void;
  beforeHaltRemoval?: () => void;
}
interface Manifest {
  version: 1;
  volumeId: string;
  mountPath: string;
  homeRoot: string;
  device: string;
  inode: string;
  handover: { state: "held" | "complete"; operationToken: string; halt: PersistentHomeHaltProof };
}
interface Evidence { text: string; device: string; inode: string }
interface Root { identity: PersistentHomeIdentity; fd: number; env: NodeJS.ProcessEnv; options: PersistentHomeOptions }
const refuse = (reason: string) => new Error(`Persistent home refused: ${reason}.`);
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const nofollow = constants.O_NOFOLLOW ?? 0;

function config(env: NodeJS.ProcessEnv): { id: string; home: string } | null {
  if (env.MERRYMEN_PERSISTENT_HOME_REQUIRED !== "1") {
    if (!env.MERRYMEN_PERSISTENT_HOME_REQUIRED || env.MERRYMEN_PERSISTENT_HOME_REQUIRED === "0") return null;
    throw refuse("MERRYMEN_PERSISTENT_HOME_REQUIRED must be 1 or unset");
  }
  const home = env.MERRYMEN_HOME;
  if (!home || !path.isAbsolute(home) || path.resolve(home) !== home || home === path.parse(home).root
      || home.includes("\0") || home !== env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw refuse("MERRYMEN_HOME must exactly equal the absolute Railway volume mount path");
  }
  // Railway injects volume NAME and MOUNT_PATH, not a provider UUID. The
  // operator must pin this ID from the volume API; names are not identity.
  const id = env.MERRYMEN_HOME_VOLUME_ID;
  if (!id || !UUID.test(id)) throw refuse("an explicit provider volume UUID is required");
  if (env.MERRYMEN_INITIAL_HANDOVER !== undefined && !TOKEN.test(env.MERRYMEN_INITIAL_HANDOVER)) {
    throw refuse("the initial handover operation token is invalid");
  }
  return { id: id.toLowerCase(), home };
}

function directoryStats(home: string, requirePrivate = true): BigIntStats {
  const st = lstatSync(home, { bigint: true });
  if (!st.isDirectory() || realpathSync(home) !== home || (requirePrivate && (st.mode & 0o7777n) !== 0o700n)
      || (process.geteuid && st.uid !== BigInt(process.geteuid()))) {
    throw refuse("the mounted root must be a plain owned directory with mode 0700 and no symlink ancestors");
  }
  return st;
}
function sameRoot(root: Root): void {
  const st = directoryStats(root.identity.homeRoot), opened = fstatSync(root.fd, { bigint: true });
  if (String(st.dev) !== root.identity.device || String(st.ino) !== root.identity.inode
      || st.dev !== opened.dev || st.ino !== opened.ino) throw refuse("the mounted root changed");
  checkMount(root.identity, root.options);
}
function mountField(value: string): string {
  if (/\\(?!040|011|012|134)/.test(value)) throw refuse("the kernel mount table is malformed");
  return value.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}
function checkMount(identity: PersistentHomeIdentity, options: PersistentHomeOptions): void {
  const text = options.readMountInfo ? options.readMountInfo() : readFileSync("/proc/self/mountinfo", "utf8");
  if (typeof text !== "string" || !text || text.length > 1024 * 1024) throw refuse("the kernel mount table is unavailable");
  const exact: { device: string; fs: string; options: string; superOptions: string }[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const parts = line.split(" - "), before = parts[0]?.split(" "), after = parts[1]?.split(" ");
    if (parts.length !== 2 || !before || before.length < 6 || !after || after.length !== 3
        || !/^\d+:\d+$/.test(before[2] ?? "")) throw refuse("the kernel mount table is malformed");
    const mountPath = mountField(before[4]!);
    if (mountPath.startsWith(`${identity.mountPath}/`)) {
      throw refuse("a nested mount would place tenant data outside the verified volume");
    }
    if (mountPath === identity.mountPath) {
      exact.push({ device: before[2]!, fs: after[0]!, options: before[5]!, superOptions: after[2]! });
    }
  }
  if (exact.length !== 1) throw refuse("the exact volume mount is missing or ambiguous");
  const mount = exact[0]!, dev = BigInt(identity.device);
  // Linux's device encoding (gnu_dev_major/minor); use bigint throughout.
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  if (mount.device !== `${major}:${minor}` || EPHEMERAL_FS.has(mount.fs)
      || !mount.options.split(",").includes("rw") || !mount.superOptions.split(",").includes("rw")) {
    throw refuse("the exact mount is not the writable durable device backing the home");
  }
}
function withRoot<T>(
  env: NodeJS.ProcessEnv, options: PersistentHomeOptions, fn: (root: Root) => T, initialPermissions = false,
): T | null {
  const c = config(env);
  if (!c) return null;
  const st = directoryStats(c.home, !initialPermissions);
  const fd = openSync(c.home, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | nofollow);
  try {
    const root: Root = { fd, env, options, identity: {
      id: c.id, mountPath: c.home, homeRoot: c.home, device: String(st.dev), inode: String(st.ino),
    } };
    const opened = fstatSync(fd, { bigint: true });
    if (st.dev !== opened.dev || st.ino !== opened.ino) throw refuse("the mounted root changed");
    checkMount(root.identity, options);
    if ((st.mode & 0o7777n) !== 0o700n) {
      // Railway creates a fresh root with its default mode. This is the sole
      // allowed permission repair: explicit operation, proven mount, no data.
      if (!initialPermissions || !env.MERRYMEN_INITIAL_HANDOVER || readdirSync(c.home).length !== 0) {
        throw refuse("the mounted root must have mode 0700; only explicit empty-volume initialization may set it");
      }
      fchmodSync(fd, 0o700);
      fsyncSync(fd);
    }
    sameRoot(root);
    const result = fn(root);
    sameRoot(root);
    return result;
  } finally { closeSync(fd); }
}
function evidence(file: string, root: Root): Evidence | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | nofollow | (constants.O_NONBLOCK ?? 0)); }
  catch (e) { if (missing(e)) return null; throw refuse("required evidence is not a readable plain file"); }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || String(st.dev) !== root.identity.device
        || (st.mode & 0o7777n) !== 0o600n || (process.geteuid && st.uid !== BigInt(process.geteuid()))
        || st.size > BigInt(MAX_EVIDENCE_BYTES)) throw refuse("required evidence must be a private owned plain file on the volume");
    const buffer = Buffer.alloc(MAX_EVIDENCE_BYTES + 1);
    let n = 0;
    while (n < buffer.length) {
      const got = readSync(fd, buffer, n, buffer.length - n, n);
      if (!got) break;
      n += got;
    }
    const final = fstatSync(fd, { bigint: true });
    if (n > MAX_EVIDENCE_BYTES || BigInt(n) !== st.size || final.size !== st.size
        || final.mtimeNs !== st.mtimeNs || final.ctimeNs !== st.ctimeNs) throw refuse("required evidence changed while reading");
    return { text: buffer.subarray(0, n).toString("utf8"), device: String(st.dev), inode: String(st.ino) };
  } finally { closeSync(fd); }
}
function haltText(id: string, token: string): string {
  return `merrymen persistent-home handover v1\noperation=${token}\nvolume=${id}\n`;
}
function readManifest(root: Root): { manifest: Manifest; evidence: Evidence } | null {
  const e = evidence(path.join(root.identity.homeRoot, PERSISTENT_HOME_MANIFEST), root);
  if (!e) return null;
  let m: Manifest;
  try { m = JSON.parse(e.text) as Manifest; } catch { throw refuse("the persistent manifest is incomplete"); }
  const i = root.identity, h = m?.handover, halt = h?.halt;
  if (m?.version !== 1 || m.volumeId !== i.id || m.mountPath !== i.mountPath || m.homeRoot !== i.homeRoot
      || typeof m.device !== "string" || !/^\d+$/.test(m.device) || m.inode !== i.inode || !h || !["held", "complete"].includes(h.state)
      || typeof h.operationToken !== "string" || !TOKEN.test(h.operationToken) || !halt
      || halt.operationToken !== h.operationToken || halt.path !== path.join(i.homeRoot, "FLEET_HALT")
      || halt.device !== m.device || typeof halt.inode !== "string" || !/^[1-9]\d*$/.test(halt.inode)
      || halt.text !== haltText(i.id, h.operationToken)
      || (root.env.MERRYMEN_INITIAL_HANDOVER !== undefined && root.env.MERRYMEN_INITIAL_HANDOVER !== h.operationToken)) {
    throw refuse("the persistent manifest does not match the configured volume, root or handover");
  }
  // st_dev belongs to this mount namespace and may change when Railway
  // reattaches the same volume on another host. Keep provider UUID/root inode
  // durable; use the CURRENT verified device for all operation-local checks.
  return { manifest: { ...m, device: i.device, handover: { ...h, halt: { ...halt, device: i.device } } }, evidence: e };
}
function assertHalt(root: Root, expected: PersistentHomeHaltProof): void {
  const current = evidence(expected.path, root);
  if (!current || current.device !== expected.device || current.inode !== expected.inode || current.text !== expected.text) {
    throw refuse("the original handover halt is missing or changed");
  }
}
function sameHaltProof(a: PersistentHomeHaltProof, b: PersistentHomeHaltProof): boolean {
  return a.path === b.path && a.device === b.device && a.inode === b.inode && a.text === b.text && a.operationToken === b.operationToken;
}
function verifiedManifest(root: Root): Manifest {
  const saved = readManifest(root);
  if (!saved) throw refuse("the persistent manifest is missing; no ephemeral or implicit initialization is allowed");
  if (saved.manifest.handover.state === "held") assertHalt(root, saved.manifest.handover.halt);
  return saved.manifest;
}
function writeExclusive(root: Root, file: string, text: string): void {
  sameRoot(root);
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600);
  try {
    const data = Buffer.from(text);
    let n = 0;
    while (n < data.length) {
      const written = writeSync(fd, data, n, data.length - n);
      if (!written) throw refuse("a durable evidence write made no progress");
      n += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncSync(root.fd); // Do not swallow unsupported fsync: durability is required.
  sameRoot(root);
}

/** No writes, even when a configured mount is empty. */
export function verifyPersistentHome(
  env: NodeJS.ProcessEnv = process.env, options: PersistentHomeOptions = {},
): PersistentHomeIdentity | null {
  return withRoot(env, options, root => { verifiedManifest(root); return root.identity; });
}

/** Must run before ensureHome, store imports, child homes or any worker writer. */
export function preparePersistentHomeForHandover(
  env: NodeJS.ProcessEnv = process.env, options: PersistentHomeOptions = {},
): PreparedPersistentHome | null {
  return withRoot(env, options, root => {
    const prior = readManifest(root);
    if (prior) {
      const m = verifiedManifest(root);
      return { ...root.identity, handoverState: m.handover.state, halt: m.handover.state === "held" ? m.handover.halt : null };
    }
    const token = env.MERRYMEN_INITIAL_HANDOVER;
    if (!token || readdirSync(root.identity.homeRoot).length !== 0) {
      throw refuse("only an empty mounted root with an explicit initial handover token may initialize");
    }
    const haltPath = path.join(root.identity.homeRoot, "FLEET_HALT");
    // The hold is published and durable BEFORE a manifest or a normal writer.
    // A crash here leaves a held, partial root that subsequent startup refuses.
    writeExclusive(root, haltPath, haltText(root.identity.id, token));
    options.afterHaltSynced?.();
    sameRoot(root);
    if (readdirSync(root.identity.homeRoot).some(name => name !== "FLEET_HALT")) {
      throw refuse("unexpected files appeared during initial handover preparation");
    }
    const created = evidence(haltPath, root);
    if (!created) throw refuse("the newly created handover halt disappeared");
    const halt: PersistentHomeHaltProof = { path: haltPath, device: created.device, inode: created.inode, text: created.text, operationToken: token };
    if (halt.text !== haltText(root.identity.id, token)) throw refuse("the newly created handover halt changed");
    const manifest: Manifest = { version: 1, volumeId: root.identity.id, mountPath: root.identity.mountPath,
      homeRoot: root.identity.homeRoot, device: root.identity.device, inode: root.identity.inode,
      handover: { state: "held", operationToken: token, halt } };
    writeExclusive(root, path.join(root.identity.homeRoot, PERSISTENT_HOME_MANIFEST), JSON.stringify(manifest) + "\n");
    verifiedManifest(root);
    return { ...root.identity, handoverState: "held", halt };
  }, true);
}

/**
 * Explicit reviewed release only: the caller must first verify the source,
 * imported original books, tenant identities and memory. Startup never calls
 * this. A completed receipt is durable before our own unchanged halt is removed.
 */
export function markPersistentHomeHandoverComplete(
  proof: PersistentHomeIdentity, expectedHalt: PersistentHomeHaltProof,
  env: NodeJS.ProcessEnv = process.env, options: PersistentHomeOptions = {},
): PersistentHomeIdentity {
  const result = withRoot(env, options, root => {
    const i = root.identity;
    if (i.id !== proof.id || i.mountPath !== proof.mountPath || i.homeRoot !== proof.homeRoot
        || i.device !== proof.device || i.inode !== proof.inode) throw refuse("the approved target root proof changed");
    const saved = readManifest(root);
    if (!saved || !sameHaltProof(saved.manifest.handover.halt, expectedHalt)) {
      throw refuse("the approved original halt proof does not match the persistent manifest");
    }
    const halt = evidence(expectedHalt.path, root);
    if (!halt) {
      if (saved.manifest.handover.state === "complete") return root.identity;
      throw refuse("the original handover halt is missing");
    }
    assertHalt(root, expectedHalt);
    if (saved.manifest.handover.state === "held") {
      const file = path.join(root.identity.homeRoot, PERSISTENT_HOME_MANIFEST), temp = `${file}.complete-${randomUUID()}`;
      try {
        writeExclusive(root, temp, JSON.stringify({ ...saved.manifest, handover: { ...saved.manifest.handover, state: "complete" } }) + "\n");
        const now = evidence(file, root);
        if (!now || now.device !== saved.evidence.device || now.inode !== saved.evidence.inode || now.text !== saved.evidence.text) {
          throw refuse("the persistent manifest changed before completion");
        }
        assertHalt(root, expectedHalt);
        renameSync(temp, file);
        fsyncSync(root.fd);
      } finally { rmSync(temp, { force: true }); }
      options.afterCompletionSynced?.();
    }
    options.beforeHaltRemoval?.();
    sameRoot(root);
    assertHalt(root, expectedHalt);
    unlinkSync(expectedHalt.path);
    fsyncSync(root.fd);
    return root.identity;
  });
  if (!result) throw refuse("persistent-home opt-in is required for an explicit handover release");
  return result;
}
