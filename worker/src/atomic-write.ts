/**
 * Replace a file whole: a concurrent reader sees the old contents or the new
 * ones, never an empty or half-written file.
 *
 * WHY NOT writeFileSync. It opens with O_TRUNC and then writes, so between the
 * two — and all through a large write — a reader in another process gets an
 * empty or truncated file. For settings.json that is not a cosmetic glitch:
 * `resolveConfig` read a file that did not parse as "no overrides" and ran
 * that tick on the defaults (paper, the default strategy, an empty allowlist),
 * and the hosted orchestrator rewrote every child's copy every fifteen seconds
 * while the child read it on every tick. (It now keeps the last good read —
 * settingsSource — but that is the fallback, not the fix.)
 *
 * Temp file in the SAME directory, then rename: rename is atomic within a
 * filesystem (POSIX and Windows alike), and a temp file anywhere else could
 * sit on another filesystem, where rename is a copy.
 *
 * TWO SPELLINGS, ONE PROCEDURE. The worker and orchestrator write synchronously
 * (writeFileAtomicSync); the web tier writes from a request handler and must
 * not block the event loop on an fsync, so it gets writeFileAtomic. Both take
 * their temp name from `tempPathFor`, and settings-atomic.test.ts runs the same
 * behaviour tests and the same race against each.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, open, readlink, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

/** Resolve the destination even when a symlink names a file not created yet. */
function writeTarget(file: string): string {
  let target = file;
  const seen = new Set<string>();
  for (;;) {
    // Relative link destinations are relative to the link's real directory,
    // including when the path to that directory itself traverses a symlink.
    target = path.join(realpathSync(path.dirname(target)), path.basename(target));
    if (seen.has(target) || seen.size >= 40) {
      throw Object.assign(new Error(`Too many symbolic links: ${file}`), { code: "ELOOP" });
    }
    seen.add(target);
    let stat;
    try {
      stat = lstatSync(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return target;
      throw e;
    }
    if (!stat.isSymbolicLink()) return target;
    target = path.resolve(path.dirname(target), readlinkSync(target));
  }
}

/** Resolve the destination even when a symlink names a file not created yet. */
async function writeTargetAsync(file: string): Promise<string> {
  let target = file;
  const seen = new Set<string>();
  for (;;) {
    // Relative link destinations are relative to the link's real directory,
    // including when the path to that directory itself traverses a symlink.
    target = path.join(await realpath(path.dirname(target)), path.basename(target));
    if (seen.has(target) || seen.size >= 40) {
      throw Object.assign(new Error(`Too many symbolic links: ${file}`), { code: "ELOOP" });
    }
    seen.add(target);
    let stat;
    try {
      stat = await lstat(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return target;
      throw e;
    }
    if (!stat.isSymbolicLink()) return target;
    target = path.resolve(path.dirname(target), await readlink(target));
  }
}

/**
 * The temp file for `target`: beside it, so the rename never crosses a
 * filesystem. pid AND random: two processes write the same settings.json
 * (orchestrator and child, or web and worker self-hosted), and pids repeat
 * across containers and restarts. Never matched by anything that lists a
 * home — every lister filters on its own names.
 */
function tempPathFor(target: string): string {
  return path.join(path.dirname(target), `${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
}

export interface AtomicWriteOptions {
  /**
   * DURABLE, not just atomic: the file must survive a power loss once this
   * returns, or this must throw. A failed fsync is then an error (unless the
   * filesystem simply does not do fsync), and the directory is synced after the
   * rename — a renamed entry is not on disk until its directory is.
   *
   * For a file whose loss cannot be undone: the grant archive, the only copy
   * of an owner key once grant.json is replaced or removed. Everything else
   * here is rewritten from its source on the next pass, and is not worth a
   * second fsync per write.
   */
  durable?: boolean;
}

/**
 * WINDOWS REFUSES A RENAME OVER A FILE ANOTHER PROCESS HOLDS OPEN without
 * FILE_SHARE_DELETE — an antivirus scan, an indexer, an editor — for as long as
 * it holds it, with EPERM, EACCES or EBUSY. The truncating write this replaced
 * did not care; the rename does, so it is retried for a moment first, as
 * graceful-fs does. Anywhere else those codes are real answers and are not.
 */
export const RENAME_RETRY_MS = [10, 20, 40, 80, 160, 320, 640] as const;
const renameBusy = (e: unknown, platform: NodeJS.Platform) =>
  platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes((e as NodeJS.ErrnoException)?.code ?? "");

/** renameSync, retried briefly on Windows' transient refusals. Blocks this thread for at most ~1.3s. */
export function renameRetryingSync(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
  rename: (from: string, to: string) => void = renameSync,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      const wait = RENAME_RETRY_MS[attempt];
      if (wait === undefined || !renameBusy(e, platform)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

/** renameRetryingSync for a request handler. */
export async function renameRetrying(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
  doRename: (from: string, to: string) => Promise<void> = rename,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await doRename(from, to);
      return;
    } catch (e) {
      const wait = RENAME_RETRY_MS[attempt];
      if (wait === undefined || !renameBusy(e, platform)) throw e;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** A filesystem that does not do fsync on this kind of file — not a failure. */
const fsyncUnsupported = (e: unknown) => ["EINVAL", "ENOTSUP"].includes((e as NodeJS.ErrnoException)?.code ?? "");

/**
 * Put a directory's entries on disk: a new or renamed file inside it survives
 * a power loss only once the directory itself is synced. Skipped on Windows,
 * which cannot open a directory for this and journals its metadata anyway.
 */
export function fsyncDirSync(dir: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } catch (e) {
    if (!fsyncUnsupported(e)) throw e;
  } finally {
    closeSync(fd);
  }
}

/** fsyncDirSync for a request handler. */
export async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const fh = await open(dir, "r");
  try {
    await fh.sync();
  } catch (e) {
    if (!fsyncUnsupported(e)) throw e;
  } finally {
    await fh.close();
  }
}

/**
 * Write `data` to `file` atomically, with exactly `mode` (default 0600 — every
 * file a home holds is owner-only, and settings.json carries plaintext keys).
 * Throws on failure, having removed its temp file; `file` is then untouched.
 */
export function writeFileAtomicSync(file: string, data: string, mode = 0o600, opts: AtomicWriteOptions = {}): void {
  // THROUGH A SYMLINK, NOT OVER IT. writeFileSync followed a link to the file
  // it names; rename would replace the link itself with a regular file, and a
  // self-hosted owner who keeps settings.json elsewhere would lose the link.
  const target = writeTarget(file);
  const tmp = tempPathFor(target);
  let fd: number | null = null;
  let created = false;
  try {
    // "wx": a file this call created or an error. open() applies `mode` only
    // when it creates, so a leftover of the same name must not be reused.
    fd = openSync(tmp, "wx", mode);
    created = true;
    try {
      // Exactly `mode`, not `mode & ~umask`, before the file is visible.
      fchmodSync(fd, mode);
    } catch {
      /* non-POSIX — the mode on open is the best there is */
    }
    writeFileSync(fd, data, "utf8");
    try {
      // Durability, not atomicity: rename alone keeps a reader off half a
      // file. This keeps a crash straight after from leaving an empty one.
      fsyncSync(fd);
    } catch (e) {
      // A filesystem that cannot fsync still gets the atomic replace — unless
      // the caller needs the bytes on disk, and this was a real failure.
      if (opts.durable && !fsyncUnsupported(e)) throw e;
    }
    closeSync(fd);
    fd = null;
    renameRetryingSync(tmp, target);
    if (opts.durable) fsyncDirSync(path.dirname(target));
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already failing — the original error is the one to report */
      }
    }
    // Only a temp file this call created: on EEXIST the name is someone else's.
    if (created) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* the original error is the one to report */
      }
    }
    throw e;
  }
}

/**
 * writeFileAtomicSync for a request handler: the same temp file, fchmod, fsync
 * and rename, without holding the event loop through the fsync. Same contract —
 * throws on failure, having removed its temp file; `file` is then untouched.
 */
export async function writeFileAtomic(file: string, data: string, mode = 0o600, opts: AtomicWriteOptions = {}): Promise<void> {
  // Through a symlink, not over it — see writeFileAtomicSync.
  const target = await writeTargetAsync(file);
  const tmp = tempPathFor(target);
  let fh: FileHandle | null = null;
  let created = false;
  try {
    fh = await open(tmp, "wx", mode);
    created = true;
    try {
      await fh.chmod(mode);
    } catch {
      /* non-POSIX — the mode on open is the best there is */
    }
    await fh.writeFile(data, "utf8");
    try {
      await fh.sync();
    } catch (e) {
      if (opts.durable && !fsyncUnsupported(e)) throw e;
    }
    await fh.close();
    fh = null;
    await renameRetrying(tmp, target);
    if (opts.durable) await fsyncDir(path.dirname(target));
  } catch (e) {
    if (fh !== null) {
      try {
        await fh.close();
      } catch {
        /* already failing — the original error is the one to report */
      }
    }
    if (created) {
      try {
        await rm(tmp, { force: true });
      } catch {
        /* the original error is the one to report */
      }
    }
    throw e;
  }
}
