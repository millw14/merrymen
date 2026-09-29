/**
 * WHERE THE LIGHTER PRIVATE KEY LIVES, AND THE ONLY WAY IN OR OUT.
 *
 * docs/perps.md rule 5: signers only ever see the PUBLIC key; the private key
 * has the session key's custody or better. Self-hosted, keygen writes
 * `$MERRYMEN_HOME/perp-keys/<pubkey>.json` (0600). Hosted, the orchestrator
 * decrypts the sealed blob and writes `perp-key.json` (0600) into the
 * tenant's child home beside grant.json; the child never holds the DEK. This
 * module reads either — and never settings, never the environment, never the
 * grant.
 *
 * WHY THE FILE IS KEYED BY THE PUBLIC KEY and the load demands it. The grant
 * seals one public key into the wall (changePubKey EQUAL w4, w5). A key file
 * whose public half is anything else is a key for a different registration:
 * signing with it would produce txs the venue rejects (21120) — or, worse,
 * that it accepts because someone registered that other key. The binary
 * cannot derive a public key from a private one, so the pairing written at
 * keygen is the evidence we have, and it is checked on every load; the venue
 * read at arm (/apikeys + an authenticated request) is the proof.
 *
 * WHY THE MODE CHECK REFUSES rather than warns and continues. A group- or
 * world-readable key file has already leaked to every account on the box
 * that wanted it. Loading it anyway would arm a key we have to assume is
 * shared. The owner gets the path and the one command that fixes it.
 *
 * NO ERROR FROM THIS FILE CARRIES KEY MATERIAL. Not the key, not a slice of
 * the file (JSON.parse messages quote their input, so they are replaced), not
 * the file's bytes in any form. Paths and reasons only.
 */

import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { validatePerpPubKey } from "../../../packages/core/src/index";

export interface PerpKeyPair {
  /** 0x + 80 lowercase hex */
  privateKey: `0x${string}`;
  /** 0x + 80 lowercase hex, canonical (validatePerpPubKey) */
  publicKey: `0x${string}`;
}

export type PerpKeystoreReason = "missing" | "insecure-mode" | "not-a-file" | "malformed" | "pubkey-mismatch" | "conflict" | "io";

export class PerpKeystoreError extends Error {
  override readonly name = "PerpKeystoreError";
  readonly kind = "perp-keystore" as const;
  constructor(
    readonly reason: PerpKeystoreReason,
    message: string,
  ) {
    super(`perp key: ${message}`);
  }
}

/** The directory self-hosted keygen writes into. */
export function perpKeysDir(home: string): string {
  return path.join(home, "perp-keys");
}

/** `$home/perp-keys/<pubkey hex, lowercase, no 0x>.json` for a canonical public key. */
export function perpKeyFileFor(home: string, apiPublicKey: string): string {
  const pub = validatePerpPubKey(apiPublicKey);
  if (pub === null) throw new PerpKeystoreError("malformed", "the sealed public key is not a canonical Lighter API key");
  return path.join(perpKeysDir(home), `${pub.slice(2)}.json`);
}

/** The hosted child's single slot, written by the orchestrator. */
export function hostedPerpKeyFile(home: string): string {
  return path.join(home, "perp-key.json");
}

/** A key file is small; anything larger is not one, and is not read into memory to find out. */
const MAX_KEY_FILE_BYTES = 4096;
const PRIV_RE = /^0x[0-9a-f]{80}$/;

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and check one key file against the sealed public key.
 *
 * A regular file (not a symlink: a link could point at another tenant's key
 * in a shared home), no group/world bits on POSIX, at most 4 KB, JSON with
 * exactly a private key of the right shape and the SAME canonical public key.
 */
function readKeyFile(file: string, sealed: `0x${string}`): PerpKeyPair {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    throw new PerpKeystoreError("missing", `no key file at ${file}`);
  }
  if (!st.isFile()) throw new PerpKeystoreError("not-a-file", `${file} is not a regular file (symlinks are refused)`);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    const mode = (st.mode & 0o777).toString(8).padStart(3, "0");
    console.warn(`[perps] refusing ${file}: mode ${mode} lets other users read the Lighter key. Fix with: chmod 600 ${file}`);
    throw new PerpKeystoreError("insecure-mode", `${file} has mode ${mode}; it must be 600 (owner read/write only)`);
  }
  if (st.size > MAX_KEY_FILE_BYTES) throw new PerpKeystoreError("malformed", `${file} is too large to be a key file`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new PerpKeystoreError("io", `${file} could not be read (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let j: unknown;
  try {
    j = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    // Deliberately not the parser's message: it quotes the file.
    throw new PerpKeystoreError("malformed", `${file} is not valid JSON`);
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) throw new PerpKeystoreError("malformed", `${file} is not a JSON object`);
  const rec = j as Record<string, unknown>;
  const priv = typeof rec.privateKey === "string" ? rec.privateKey.toLowerCase() : null;
  if (priv === null || !PRIV_RE.test(priv) || /^0x0+$/.test(priv)) {
    throw new PerpKeystoreError("malformed", `${file} has no well-formed privateKey (0x + 80 hex)`);
  }
  const pub = typeof rec.publicKey === "string" ? validatePerpPubKey(rec.publicKey) : null;
  if (pub === null) throw new PerpKeystoreError("malformed", `${file} has no canonical publicKey`);
  if (pub !== sealed) {
    throw new PerpKeystoreError("pubkey-mismatch", `${file} holds the key for ${pub.slice(0, 10)}…, not the sealed ${sealed.slice(0, 10)}…`);
  }
  return { privateKey: priv as `0x${string}`, publicKey: pub };
}

/**
 * The private key for the grant's sealed public key.
 *
 * Self-hosted `perp-keys/<pubkey>.json` first — it names the key it holds —
 * then the hosted child's `perp-key.json`. Either must pair with `apiPublicKey`
 * exactly. Throws PerpKeystoreError; the caller leaves live perps unarmed and
 * says why (exits already resting at the venue keep working without us).
 */
export function loadPerpPrivateKey(args: { home: string; apiPublicKey: string }): PerpKeyPair {
  const sealed = validatePerpPubKey(args.apiPublicKey);
  if (sealed === null) throw new PerpKeystoreError("malformed", "the sealed public key is not a canonical Lighter API key");
  const selfHosted = perpKeyFileFor(args.home, sealed);
  if (exists(selfHosted)) return readKeyFile(selfHosted, sealed);
  const hosted = hostedPerpKeyFile(args.home);
  if (exists(hosted)) return readKeyFile(hosted, sealed);
  throw new PerpKeystoreError("missing", `no Lighter key for ${sealed.slice(0, 10)}… in ${perpKeysDir(args.home)} or ${hosted}`);
}

/**
 * Every spelling of the loaded private key — 0x and bare, lower and upper —
 * for a known-secrets list (the Telegram agent's redactSecrets strips exact
 * values). Rule 5 wants the key redacted by value AND by shape; the 80-hex
 * shape redactor catches mixed case and anything this misses. Never throws:
 * no perp block, no key file, or one that does not pair is simply nothing to
 * list — a redaction list must not be the thing that fails a task.
 */
export function perpKeySecretForms(home: string, apiPublicKey: string | null | undefined): string[] {
  if (typeof apiPublicKey !== "string") return [];
  let priv: string;
  try {
    priv = loadPerpPrivateKey({ home, apiPublicKey }).privateKey;
  } catch {
    return [];
  }
  const bare = priv.slice(2);
  return [priv, `0x${bare.toUpperCase()}`, bare, bare.toUpperCase()];
}

/**
 * Write a freshly generated pair (self-hosted keygen). Returns the file path.
 *
 * 0600 from the first byte (the temp file is created with that mode, never
 * chmod'ed down afterwards), fsync'd, then LINKED into place: link(2) fails if
 * the target exists, so two keygens racing for one public key cannot replace
 * each other's file the way rename(2) would. Writing the same pair again is a
 * no-op; a DIFFERENT private key for a public key that already has one is
 * refused — overwriting it would strand whatever that key controls.
 */
export function writePerpKeyFile(home: string, pair: PerpKeyPair): string {
  const priv = typeof pair?.privateKey === "string" ? pair.privateKey.toLowerCase() : "";
  if (!PRIV_RE.test(priv) || /^0x0+$/.test(priv)) throw new PerpKeystoreError("malformed", "privateKey must be 0x + 80 hex (value not shown)");
  const pub = typeof pair?.publicKey === "string" ? validatePerpPubKey(pair.publicKey) : null;
  if (pub === null) throw new PerpKeystoreError("malformed", "publicKey is not a canonical Lighter API key");
  const dir = perpKeysDir(home);
  const target = perpKeyFileFor(home, pub);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new PerpKeystoreError("io", `${dir} could not be created (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }

  const sameAsExisting = (): boolean => {
    const existing = readKeyFile(target, pub);
    if (existing.privateKey !== priv) {
      throw new PerpKeystoreError("conflict", `${target} already holds a different private key for this public key; refusing to overwrite it`);
    }
    return true;
  };
  if (exists(target) && sameAsExisting()) return target;

  const tmp = path.join(dir, `.${pub.slice(2, 18)}.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify({ v: 1, publicKey: pub, privateKey: priv }, null, 2)}\n`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new PerpKeystoreError("io", `could not write a temporary key file in ${dir} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  try {
    linkSync(tmp, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      // Someone got there first: fine if it is this pair, refused if not.
      try {
        sameAsExisting();
      } finally {
        rmSync(tmp, { force: true });
      }
      return target;
    }
    rmSync(tmp, { force: true });
    throw new PerpKeystoreError("io", `could not place ${target} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  rmSync(tmp, { force: true });
  // Durable before we tell the caller the key exists: fsync the directory so
  // the new name survives a crash (best effort — not every platform allows it).
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* best effort */
  }
  return target;
}
