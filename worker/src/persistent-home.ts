/**
 * Production-only prerequisite for the one-shot handover. A directory on the
 * container overlay must never be mistaken for the durable book's home.
 * Verification is read-only; only explicit preparation, adoption, completion
 * and re-halt write here (docs/fleet-resume.md).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";

export const PERSISTENT_HOME_MANIFEST = ".merrymen-persistent-home.json";
/** What the adopted volume's original operator halt was, kept byte for byte. */
export const PERSISTENT_HOME_PREADOPTION = ".fleet-halt-preadoption.json";
/** Which canonical halt the latest env re-halt created, before its manifest said so. */
export const PERSISTENT_HOME_REHALT_RECEIPT = ".fleet-halt-rehalt.json";
// Private second names for a canonical halt before it is published as
// FLEET_HALT. Only this file writes them, and only inside the 0700 root.
const ADOPTION_HALT = ".fleet-halt-adoption.tmp";
const REHALT_HALT = ".fleet-halt-rehalt.tmp";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_EVIDENCE_BYTES = 8 * 1024;
/** The original halt's bytes travel inside a record that must itself fit MAX_EVIDENCE_BYTES. */
const MAX_ORIGINAL_HALT_BYTES = 4 * 1024;
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
  /** Adoption: the record is durable; the canonical halt is durable beside the original; it replaced it. */
  afterPreAdoptionSynced?: () => void;
  afterAdoptionHaltSynced?: () => void;
  afterAdoptionRenamed?: () => void;
  /** Re-halt: the private halt, its receipt, the FLEET_HALT link, then the single-link halt are durable. */
  afterRehaltHaltSynced?: () => void;
  afterRehaltReceiptSynced?: () => void;
  afterRehaltLinked?: () => void;
  afterRehaltPublished?: () => void;
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
interface Evidence { text: string; bytes: Buffer; device: string; inode: string }
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
    const bytes = buffer.subarray(0, n);
    return { text: bytes.toString("utf8"), bytes, device: String(st.dev), inode: String(st.ino) };
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

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
interface PreAdoption {
  version: 1; volumeId: string; homeRoot: string; inode: string; operationToken: string;
  halt: { path: string; inode: string; size: number; sha256: string; bytes: string };
}
/** The operator's pin on the one original halt an adoption may replace, or null when none was asked for. */
function pinnedHalt(env: NodeJS.ProcessEnv): string | null {
  const pinned = env.MERRYMEN_ADOPT_HOME_HALT_SHA256;
  if (pinned === undefined) return null;
  if (!SHA256.test(pinned)) throw refuse("MERRYMEN_ADOPT_HOME_HALT_SHA256 must be the 64-hex SHA-256 of the original halt");
  return pinned.toLowerCase();
}
function presentStat(file: string): BigIntStats | null {
  try { return lstatSync(file, { bigint: true }); }
  catch (e) { if (missing(e)) return null; throw refuse("a halt name on the volume could not be inspected"); }
}
function readPreAdoption(root: Root, pinned: string, token: string): PreAdoption | null {
  const e = evidence(path.join(root.identity.homeRoot, PERSISTENT_HOME_PREADOPTION), root);
  if (!e) return null;
  let r: PreAdoption;
  try { r = JSON.parse(e.text) as PreAdoption; } catch { throw refuse("the pre-adoption halt record is incomplete"); }
  const i = root.identity, h = r?.halt;
  const bytes = typeof h?.bytes === "string" ? Buffer.from(h.bytes, "base64") : null;
  if (r?.version !== 1 || r.volumeId !== i.id || r.homeRoot !== i.homeRoot || r.inode !== i.inode
      || r.operationToken !== token || !h || h.path !== path.join(i.homeRoot, "FLEET_HALT")
      || typeof h.inode !== "string" || !/^[1-9]\d*$/.test(h.inode) || h.sha256 !== pinned
      || !bytes || bytes.toString("base64") !== h.bytes || bytes.length !== h.size || sha256(bytes) !== pinned) {
    throw refuse("the pre-adoption record does not match the pinned original halt, volume or handover");
  }
  return r;
}

/**
 * ADOPTING THE POPULATED INCIDENT VOLUME UNDER THE HALT IT ALREADY HAS.
 *
 * The fleet's volume was written before this file existed: tenant homes, an
 * operator's hand-made FLEET_HALT, and no manifest. Ordinary preparation
 * refuses that root, rightly, because it cannot tell an old book from a stray
 * directory. Adoption is the one reviewed way in (docs/fleet-resume.md), and
 * it asks for two explicit things: MERRYMEN_ADOPT_HOME_HALT_SHA256, the hash
 * the operator recorded of that hand-made halt, and the initial handover token.
 *
 * THE HALT IS NEVER ABSENT. The original is recorded first (hash, inode and
 * its exact bytes, durable), a canonical halt is written beside it under a
 * private name, and one rename puts it in FLEET_HALT's place. Only then is the
 * manifest written, `held`, naming that canonical halt as its own, so the
 * existing release and verification paths work on this volume unchanged.
 *
 * A CRASH AT ANY SEAM CONVERGES on the next start with the same variables:
 * a record whose original is still in place carries on to the rename, and a
 * record whose FLEET_HALT is already this adoption's canonical text carries on
 * to the manifest. A restart after the manifest changes nothing. Any other
 * shape (a wrong hash, a loose or hard-linked halt, an empty root, a manifest
 * this adoption did not make) refuses before writing. No book, grant, lease or
 * ledger is opened.
 */
export function adoptPopulatedPersistentHome(
  env: NodeJS.ProcessEnv = process.env, options: PersistentHomeOptions = {},
): PreparedPersistentHome | null {
  const pinned = pinnedHalt(env);
  if (pinned === null) return null;
  const result = withRoot(env, options, root => {
    const token = env.MERRYMEN_INITIAL_HANDOVER, i = root.identity;
    if (!token) throw refuse("adoption requires the explicit initial handover operation token");
    const haltPath = path.join(i.homeRoot, "FLEET_HALT"), canonical = haltText(i.id, token);
    let record = readPreAdoption(root, pinned, token);
    if (readManifest(root)) {
      if (!record) throw refuse("an existing persistent manifest was not created by this adoption");
      const m = verifiedManifest(root);
      return { ...i, handoverState: m.handover.state, halt: m.handover.state === "held" ? m.handover.halt : null };
    }
    const names = readdirSync(i.homeRoot);
    if (!names.some(name => !["FLEET_HALT", PERSISTENT_HOME_PREADOPTION, ADOPTION_HALT].includes(name))) {
      throw refuse("only a populated root is adopted; an empty root uses explicit initialization");
    }
    const found = evidence(haltPath, root);
    if (!found) throw refuse("adoption requires the original halt to be present");
    if (!record) {
      if (names.includes(ADOPTION_HALT)) throw refuse("an adoption halt exists without its pre-adoption record");
      if (found.bytes.length > MAX_ORIGINAL_HALT_BYTES || sha256(found.bytes) !== pinned) {
        throw refuse("the existing halt does not match the pinned original halt hash");
      }
      const pre: PreAdoption = { version: 1, volumeId: i.id, homeRoot: i.homeRoot, inode: i.inode, operationToken: token,
        halt: { path: haltPath, inode: found.inode, size: found.bytes.length, sha256: pinned, bytes: found.bytes.toString("base64") } };
      writeExclusive(root, path.join(i.homeRoot, PERSISTENT_HOME_PREADOPTION), JSON.stringify(pre) + "\n");
      options.afterPreAdoptionSynced?.();
      record = readPreAdoption(root, pinned, token);
      if (!record) throw refuse("the pre-adoption record disappeared");
    }
    const original = (e: Evidence | null) => !!e && e.inode === record!.halt.inode && sha256(e.bytes) === pinned;
    if (original(found)) {
      // A leftover private halt from a crash before the rename is this
      // adoption's own, possibly torn: replace it rather than trust it.
      const temp = path.join(i.homeRoot, ADOPTION_HALT);
      if (presentStat(temp)) { unlinkSync(temp); fsyncSync(root.fd); }
      writeExclusive(root, temp, canonical);
      options.afterAdoptionHaltSynced?.();
      if (!original(evidence(haltPath, root))) throw refuse("the original halt changed during adoption");
      sameRoot(root);
      renameSync(temp, haltPath);
      fsyncSync(root.fd);
      options.afterAdoptionRenamed?.();
    } else if (found.text !== canonical || names.includes(ADOPTION_HALT)) {
      throw refuse("FLEET_HALT is neither the recorded original nor this adoption's canonical halt");
    }
    // The explicit resume branch joins here: the record holds the pinned hash
    // and FLEET_HALT already is haltText(id, token) on a new inode.
    const created = evidence(haltPath, root);
    if (!created || created.text !== canonical || created.inode === record.halt.inode) {
      throw refuse("the adopted canonical halt is missing or changed");
    }
    const halt: PersistentHomeHaltProof = { path: haltPath, device: created.device, inode: created.inode, text: created.text, operationToken: token };
    const manifest: Manifest = { version: 1, volumeId: i.id, mountPath: i.mountPath, homeRoot: i.homeRoot,
      device: i.device, inode: i.inode, handover: { state: "held", operationToken: token, halt } };
    writeExclusive(root, path.join(i.homeRoot, PERSISTENT_HOME_MANIFEST), JSON.stringify(manifest) + "\n");
    verifiedManifest(root);
    return { ...i, handoverState: "held" as const, halt };
  });
  if (!result) throw refuse("persistent-home opt-in is required to adopt a populated volume");
  return result;
}

/**
 * Explicit reviewed release only: the caller must first verify the source,
 * imported original books, tenant identities and memory. Ordinary startup
 * never calls this. The one reviewed exception (decision 5 of the resume
 * plan) is controlAdoptedPersistentHomeHalt below, which calls it at startup
 * only for an ADOPTED volume, only when MERRYMEN_RELEASE_HOME_HALT names this
 * manifest's operation, the pinned original-halt hash still matches the
 * pre-adoption record, and the rollout scope is not `none`. A completed
 * receipt is durable before our own unchanged halt is removed.
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

export interface PersistentHomeHaltControl {
  action: "released" | "rehalted" | "already-released" | "already-held" | "withheld";
  handoverState: "held" | "complete";
  /** Log-safe: never the operation token, a hash or a tenant. */
  detail: string;
}
interface RehaltReceipt {
  version: 1; volumeId: string; homeRoot: string; inode: string; operationToken: string;
  halt: { path: string; inode: string; text: string };
}
/**
 * B1's MERRYMEN_FLEET_ROLLOUT, whose grammar the orchestrator validates at
 * boot. A release needs a scope that admits someone: `none`, or no value at
 * all, keeps the halt where it is.
 */
function rolloutAdmitsRelease(env: NodeJS.ProcessEnv): boolean {
  const scope = env.MERRYMEN_FLEET_ROLLOUT?.trim();
  return !!scope && scope !== "none";
}
/** Is FLEET_HALT exactly this proof's halt? Never throws over somebody else's file. */
function ownHalt(root: Root, proof: PersistentHomeHaltProof): boolean {
  const st = presentStat(proof.path);
  if (!st || String(st.ino) !== proof.inode) return false;
  try { assertHalt(root, proof); return true; } catch { return false; }
}
function readRehaltReceipt(root: Root, token: string): RehaltReceipt | null {
  const e = evidence(path.join(root.identity.homeRoot, PERSISTENT_HOME_REHALT_RECEIPT), root);
  if (!e) return null;
  let r: RehaltReceipt;
  try { r = JSON.parse(e.text) as RehaltReceipt; } catch { throw refuse("the re-halt receipt is incomplete"); }
  const i = root.identity, h = r?.halt;
  if (r?.version !== 1 || r.volumeId !== i.id || r.homeRoot !== i.homeRoot || r.inode !== i.inode || r.operationToken !== token
      || !h || h.path !== path.join(i.homeRoot, "FLEET_HALT") || typeof h.inode !== "string" || !/^[1-9]\d*$/.test(h.inode)
      || h.text !== haltText(i.id, token)) throw refuse("the re-halt receipt does not match the configured volume or handover");
  return r;
}
/** Write-new-then-rename, like the completion receipt: a torn file never takes the real name. */
function replaceDurably(root: Root, file: string, text: string, unchanged: () => void): void {
  const temp = `${file}.${randomUUID()}`;
  try {
    writeExclusive(root, temp, text);
    unchanged();
    renameSync(temp, file);
    fsyncSync(root.fd);
  } finally { rmSync(temp, { force: true }); }
}

function releaseAdopted(root: Root, saved: { manifest: Manifest; evidence: Evidence }): PersistentHomeHaltControl {
  const handover = saved.manifest.handover;
  if (handover.state === "complete" && !ownHalt(root, handover.halt)) {
    // Released. Whatever FLEET_HALT is here now was put there by hand, and a
    // hand-made halt still stands every child down: it is never ours to lift.
    return { action: "already-released", handoverState: "complete", detail: "already released; any FLEET_HALT present is an operator halt and stays" };
  }
  // Held, or a release that crashed after its durable receipt and before it
  // removed its own unchanged halt: both finish through the reviewed path.
  if (handover.state === "held") assertHalt(root, handover.halt);
  if (!rolloutAdmitsRelease(root.env)) {
    return { action: "withheld", handoverState: handover.state, detail: "MERRYMEN_FLEET_ROLLOUT is none or unset, so the halt stays" };
  }
  markPersistentHomeHandoverComplete(root.identity, handover.halt, root.env, root.options);
  return { action: "released", handoverState: "complete", detail: "released into the configured rollout scope" };
}

function rehaltAdopted(root: Root, saved: { manifest: Manifest; evidence: Evidence }, releaseIgnored: boolean): PersistentHomeHaltControl {
  const i = root.identity, m = saved.manifest, token = m.handover.operationToken, options = root.options;
  const ignored = releaseIgnored ? "; MERRYMEN_RELEASE_HOME_HALT is ignored while a re-halt is asked for" : "";
  if (m.handover.state === "held") {
    assertHalt(root, m.handover.halt);
    return { action: "already-held", handoverState: "held", detail: `already held${ignored}` };
  }
  const haltPath = path.join(i.homeRoot, "FLEET_HALT"), temp = path.join(i.homeRoot, REHALT_HALT), canonical = haltText(i.id, token);
  const withheld: PersistentHomeHaltControl = { action: "withheld", handoverState: "complete",
    detail: `an operator FLEET_HALT is already standing the fleet down; it and the released manifest stay as they are${ignored}` };
  const isCanonical = (file: string) => { try { return evidence(file, root)?.text === canonical; } catch { return false; } };
  const present = presentStat(haltPath), pending = presentStat(temp);
  if (present) {
    // Ours only by proof: our private name still links it (a crash after the
    // link), or the receipt written before the link names it (a crash after
    // the private name went). Identical text alone proves nothing.
    const ours = pending ? pending.ino === present.ino
      : readRehaltReceipt(root, token)?.halt.inode === String(present.ino) && isCanonical(haltPath);
    if (!ours) {
      if (pending) { unlinkSync(temp); fsyncSync(root.fd); }
      return withheld;
    }
  } else {
    if (pending) { unlinkSync(temp); fsyncSync(root.fd); } // A crash before the link; possibly torn.
    writeExclusive(root, temp, canonical);
    options.afterRehaltHaltSynced?.();
    const created = evidence(temp, root);
    if (!created || created.text !== canonical) throw refuse("the re-halt's canonical halt changed");
    const receipt: RehaltReceipt = { version: 1, volumeId: i.id, homeRoot: i.homeRoot, inode: i.inode, operationToken: token,
      halt: { path: haltPath, inode: created.inode, text: canonical } };
    replaceDurably(root, path.join(i.homeRoot, PERSISTENT_HOME_REHALT_RECEIPT), JSON.stringify(receipt) + "\n", () => {});
    options.afterRehaltReceiptSynced?.();
    sameRoot(root);
    // O_EXCL at the real name: link() never replaces a halt that appeared meanwhile.
    try { linkSync(temp, haltPath); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      unlinkSync(temp); fsyncSync(root.fd);
      return withheld;
    }
    fsyncSync(root.fd);
    options.afterRehaltLinked?.();
  }
  // FLEET_HALT is ours. Drop the private name so it is a single-link plain
  // file again, which every verifier of a held manifest requires.
  const linked = presentStat(temp);
  if (linked) {
    if (linked.ino !== presentStat(haltPath)?.ino) throw refuse("the re-halt's private halt no longer names FLEET_HALT");
    unlinkSync(temp);
    fsyncSync(root.fd);
  }
  options.afterRehaltPublished?.();
  const published = evidence(haltPath, root);
  if (!published || published.text !== canonical || readRehaltReceipt(root, token)?.halt.inode !== published.inode) {
    throw refuse("the re-halt's own canonical halt is missing or changed");
  }
  const halt: PersistentHomeHaltProof = { path: haltPath, device: published.device, inode: published.inode, text: published.text, operationToken: token };
  const file = path.join(i.homeRoot, PERSISTENT_HOME_MANIFEST);
  replaceDurably(root, file, JSON.stringify({ ...m, handover: { ...m.handover, state: "held", halt } }) + "\n", () => {
    const now = evidence(file, root);
    if (!now || now.device !== saved.evidence.device || now.inode !== saved.evidence.inode || now.text !== saved.evidence.text) {
      throw refuse("the persistent manifest changed before the re-halt");
    }
    assertHalt(root, halt);
  });
  verifiedManifest(root);
  return { action: "rehalted", handoverState: "held", detail: `re-halted under this volume's canonical halt${ignored}` };
}

/**
 * THE REVIEWED ENV RELEASE AND RE-HALT OF AN ADOPTED VOLUME, so neither the
 * pilot's first release nor a rollback to listener-only mode needs a shell on
 * the container (docs/fleet-resume.md).
 *
 * MERRYMEN_RELEASE_HOME_HALT=<operation token> releases only a `held`
 * manifest, through markPersistentHomeHandoverComplete itself, and only while
 * MERRYMEN_FLEET_ROLLOUT admits someone. Asked again, it changes nothing:
 * a FLEET_HALT made by hand after a release is never lifted by this variable.
 *
 * MERRYMEN_REHALT_HOME=<operation token> puts a canonical halt back with a
 * no-replace link, records which inode it is in a receipt BEFORE publishing
 * it, and returns the manifest to `held`. When both are set the re-halt wins:
 * a rollback must never fail because the release variable was left behind.
 *
 * Both need the pinned original-halt hash and a pre-adoption record that
 * matches it, so neither applies to a volume this code initialized fresh.
 * Neither opens a book, a grant, a lease or the ledger.
 */
export function controlAdoptedPersistentHomeHalt(
  env: NodeJS.ProcessEnv = process.env, options: PersistentHomeOptions = {},
): PersistentHomeHaltControl | null {
  const release = env.MERRYMEN_RELEASE_HOME_HALT, rehalt = env.MERRYMEN_REHALT_HOME;
  if (release === undefined && rehalt === undefined) return null;
  if ([release, rehalt].some(token => token !== undefined && !TOKEN.test(token))) {
    throw refuse("the halt release or re-halt operation token is invalid");
  }
  const pinned = pinnedHalt(env);
  if (pinned === null) throw refuse("a halt release or re-halt also requires the pinned original halt hash");
  const result = withRoot(env, options, root => {
    const saved = readManifest(root);
    if (!saved) throw refuse("a halt release or re-halt requires the adopted persistent manifest");
    const token = saved.manifest.handover.operationToken;
    if ([release, rehalt].some(value => value !== undefined && value !== token)) {
      throw refuse("the halt release or re-halt operation token does not match the persistent manifest");
    }
    if (!readPreAdoption(root, pinned, token)) {
      throw refuse("an env halt release or re-halt applies only to a volume adopted under the pinned original halt");
    }
    return rehalt !== undefined ? rehaltAdopted(root, saved, release !== undefined) : releaseAdopted(root, saved);
  });
  if (!result) throw refuse("persistent-home opt-in is required for an env halt release or re-halt");
  return result;
}
