/**
 * THE CLI'S COPY OF worker/src/atomic-write.ts — the sync half of it. The CLI
 * is plain Node and cannot import TypeScript. worker/src/settings-atomic.test.ts
 * and worker/src/grant-archive-durable.test.ts run this copy through the same
 * behaviour tests and the same race as the original, so the two cannot quietly
 * drift apart. Read the original for the reasoning behind each step.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Resolve the destination even when a symlink names a file not created yet. */
function writeTarget(file) {
  let target = file;
  const seen = new Set();
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
      if (e?.code === "ENOENT") return target;
      throw e;
    }
    if (!stat.isSymbolicLink()) return target;
    target = path.resolve(path.dirname(target), readlinkSync(target));
  }
}

/** Windows' transient refusal to rename over a file held open elsewhere — retried briefly (see the original). */
export const RENAME_RETRY_MS = [10, 20, 40, 80, 160, 320, 640];
const renameBusy = (e, platform) => platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(e?.code ?? "");

export function renameRetryingSync(from, to, platform = process.platform, rename = renameSync) {
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

/** A filesystem that does not do fsync on this kind of file — not a failure. */
const fsyncUnsupported = (e) => ["EINVAL", "ENOTSUP"].includes(e?.code ?? "");

/** Put a directory's entries on disk. Skipped on Windows (see the original). */
export function fsyncDirSync(dir) {
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

/**
 * Write `data` to `file` atomically, with exactly `mode` (default 0600). With
 * `{ durable: true }` a real fsync failure throws and the directory is synced
 * after the rename. Throws on failure, having removed its temp file.
 */
export function writeFileAtomicSync(file, data, mode = 0o600, opts = {}) {
  // Through a symlink, not over it.
  const target = writeTarget(file);
  // Same directory (rename never crosses a filesystem); pid AND random.
  const tmp = path.join(path.dirname(target), `${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd = null;
  let created = false;
  try {
    fd = openSync(tmp, "wx", mode);
    created = true;
    try {
      fchmodSync(fd, mode);
    } catch {
      /* non-POSIX — the mode on open is the best there is */
    }
    writeFileSync(fd, data, "utf8");
    try {
      fsyncSync(fd);
    } catch (e) {
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
        /* the original error is the one to report */
      }
    }
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
