/**
 * THE STAND-DOWN REQUEST, WRITTEN BY THE CLI ITSELF — the fallback `merrymen
 * kill` uses when the TypeScript helper (worker/src/perps-cli.ts, run with tsx)
 * cannot write it: tsx missing, the helper crashing, or the helper refusing a
 * grant whose perp block core's grantPerp does not accept.
 *
 * WHY THE CLI CARRIES A COPY. docs/perps.md rule 13: "every kill path writes
 * standdown-request.json before archiving the grant", and a kill that cannot
 * ask must not archive (standdown-files.ts writeStanddownRequest). If the only
 * way to ask ran through tsx, a broken install would turn every perps kill
 * into a refusal. The request is tiny and fixed — a version, a kind, a nonce,
 * a reason and a time — so it is written here, zero-dependency, in exactly the
 * shape and with exactly the discipline of the worker's own writer:
 *
 *   - one file per request, `standdown-request-<nonce>.json`, never rewritten
 *   - written under a dot-prefixed temporary name no reader lists, fsync'd,
 *     then moved into place with link() — which refuses to replace an
 *     existing request, so a nonce is used once — and the directory fsync'd
 *   - no key of any kind: reason "kill", a time and a nonce
 *
 * The worker's strict reader (readPendingStanddownRequests) is the judge; a
 * test holds this writer's file against it.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STANDDOWN_REQUEST_PREFIX = "standdown-request-";
const NONCE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

function safeUnlink(file) {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

function fsyncDir(dir) {
  let fd = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* best effort: the file is whole either way */
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/**
 * Write a kill stand-down request into `home` and return its nonce. Throws on
 * any failure — and a kill that gets a throw must not archive the grant as if
 * the worker had been asked. The home must already exist (the grant is in it).
 */
export function writeKillStanddownRequest(home, now = Date.now()) {
  const nonce = randomUUID();
  if (!NONCE_RE.test(nonce)) throw new Error("could not make a stand-down nonce");
  const requestedAt = Math.floor(now);
  if (!Number.isSafeInteger(requestedAt) || requestedAt <= 0) throw new Error("the clock does not give a usable time");
  const name = `${STANDDOWN_REQUEST_PREFIX}${nonce}.json`;
  const final = path.join(home, name);
  const tmp = path.join(home, `.${name}.${randomUUID()}.tmp`);
  const body = JSON.stringify({ v: 1, kind: "standdown-request", nonce, reason: "kill", requestedAt });
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    safeUnlink(tmp);
    throw e;
  }
  closeSync(fd);
  try {
    try {
      linkSync(tmp, final);
    } catch (e) {
      const code = e && typeof e === "object" ? e.code : undefined;
      if (code === "EEXIST") throw new Error(`${name} already exists; a stand-down nonce is used once`);
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") throw e;
      // A filesystem without hard links: check, then rename.
      let taken = true;
      try {
        lstatSync(final);
      } catch (err) {
        taken = !(err && typeof err === "object" && err.code === "ENOENT");
      }
      if (taken) throw new Error(`${name} already exists; a stand-down nonce is used once`);
      renameSync(tmp, final);
    }
  } finally {
    safeUnlink(tmp);
  }
  fsyncDir(home);
  return nonce;
}
