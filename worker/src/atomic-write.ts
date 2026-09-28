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
import { closeSync, fchmodSync, fsyncSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

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

/**
 * Write `data` to `file` atomically, with exactly `mode` (default 0600 — every
 * file a home holds is owner-only, and settings.json carries plaintext keys).
 * Throws on failure, having removed its temp file; `file` is then untouched.
 */
export function writeFileAtomicSync(file: string, data: string, mode = 0o600): void {
  // THROUGH A SYMLINK, NOT OVER IT. writeFileSync followed a link to the file
  // it names; rename would replace the link itself with a regular file, and a
  // self-hosted owner who keeps settings.json elsewhere would lose the link.
  let target = file;
  try {
    target = realpathSync(file);
  } catch {
    // Not there yet (or a dangling link): create it at the name given.
  }
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
    } catch {
      /* a filesystem that cannot fsync still gets the atomic replace */
    }
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
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
export async function writeFileAtomic(file: string, data: string, mode = 0o600): Promise<void> {
  // Through a symlink, not over it — see writeFileAtomicSync.
  let target = file;
  try {
    target = await realpath(file);
  } catch {
    // Not there yet (or a dangling link): create it at the name given.
  }
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
    } catch {
      /* a filesystem that cannot fsync still gets the atomic replace */
    }
    await fh.close();
    fh = null;
    await rename(tmp, target);
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
