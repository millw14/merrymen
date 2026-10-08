/**
 * PARTNER KEYS — a second credential system, deliberately separate from `mmk_`.
 *
 * `mmk_` tokens (lib/core.mjs) identify a PERSON by wallet and re-check an
 * on-chain $MERRYMEN balance on every request. That is right for a holder perk
 * and wrong for a business: Prism is not a token holder and must not be made
 * into one to read public data. Three concrete mismatches:
 *
 *   - it is an address. `chat()` and `bitquery()` 403 the moment a balance dips.
 *   - it cannot be revoked. Stateless HMAC + 7-day TTL means a leaked token is
 *     live for a week, and the only remedy — rotating MERRYMEN_GATEWAY_SECRET —
 *     invalidates every holder's token at the same time.
 *   - it has no scopes. A token is a binary "holder or not".
 *
 * So the two coexist on one host with SEPARATE registries, prefixes and
 * verifiers, and `partner-cross.test.mjs` asserts each rejects the other's
 * credential in both directions. This module must never import from core.mjs —
 * `imports.test.mjs` enforces that, so the two systems cannot grow a shared code
 * path by accident.
 *
 * THE SECRET IS NEVER STORED. The registry keeps `HMAC(gatewaySecret, secret)`,
 * so a stolen registry file on its own is not offline-crackable without the
 * server secret too. HMAC rather than a bare hash for exactly that reason, and
 * the gateway secret is used as a PEPPER here rather than as the key material
 * itself — otherwise rotating it to revoke one partner would also invalidate
 * every holder's chat token.
 *
 * REVOCATION IS AN APPENDED LINE, NEVER AN EDIT. The file is JSONL and the last
 * record for a keyId wins, the same discipline lib/signups.mjs uses and the same
 * one the ledger's `journal` table uses. An edit-in-place can half-write; an
 * append cannot leave the registry in a state that grants access it should not.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Where the Railway volume is mounted. Same variable lib/signups.mjs uses. */
const DIR = () => process.env.MERRYMEN_DATA_DIR || "/data";
const FILE = () => path.join(DIR(), "partners.jsonl");

/**
 * Crockford base32, lowercased: no i, l, o or u.
 *
 * Borrowed wholesale from worker/src/identity-store.ts, and for its reason: a
 * key id gets read off a screen and typed into a support message, and those four
 * characters are the ones that turn into each other when a human does that.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const KEY_ID_LEN = 12;

/** Every scope that exists. A key carrying one not listed here is malformed. */
export const SCOPES = Object.freeze([
  "read:agents",
  "read:theses",
  "read:market",
  /** Positions — consent-gated per agent on top of this. */
  "read:book",
  /** Trade history — consent-gated per agent on top of this. */
  "read:trades",
  "write:agents",
  "chat:agents",
]);

/** What a new key gets unless asked otherwise: everything that is already public. */
export const DEFAULT_SCOPES = Object.freeze(["read:agents", "read:theses", "read:market"]);

/** How long a loaded registry is trusted before re-reading, so a revocation lands. */
export const REGISTRY_TTL_MS = 30_000;

const KEY_RE = /^mmp_([0-9a-hjkmnp-tv-z]{12})_([A-Za-z0-9_-]{16,128})$/;

/** A random keyId. Not secret — it goes in logs and in the rate-limit bucket. */
export function newKeyId() {
  const bytes = randomBytes(KEY_ID_LEN);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Mint a key. The plaintext is returned once and never stored anywhere. */
export function makeKey() {
  const keyId = newKeyId();
  const secret = randomBytes(32).toString("base64url");
  return { key: `mmp_${keyId}_${secret}`, keyId, secret };
}

/**
 * Split a presented key. Returns null for anything that is not our shape — the
 * caller turns that into a 404, not a 401, so a partner route never confirms the
 * existence of the holder system to someone probing with an `mmk_`.
 */
export function parseKey(raw) {
  if (typeof raw !== "string") return null;
  const m = KEY_RE.exec(raw.trim());
  return m ? { keyId: m[1], secret: m[2] } : null;
}

/** The stored verifier for a secret. Never reversible to the secret. */
export function hashSecret(gatewaySecret, secret) {
  return createHmac("sha256", gatewaySecret).update(`mmp:${secret}`).digest("base64url");
}

function sameHash(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  // timingSafeEqual throws on a length mismatch, which is itself a signal — so
  // compare lengths first and return the same `false` either way.
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * A key's display name as the bridge signs it: at most 64 UTF-16 units, never
 * ending in half a surrogate pair, and well-formed. The hosted runtime refuses
 * text that is not, so a 63-character name plus an emoji, cut here, left its
 * key unable to create a single connection.
 */
function displayName(name, keyId) {
  // Control characters are refused there too; a CLI --name is written as given.
  let cut = name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 64);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.toWellFormed().trim() || keyId;
}

/** One registry record, normalised. Unknown scopes are dropped, not honoured. */
function normalize(rec) {
  if (!rec || typeof rec !== "object") return null;
  const keyId = typeof rec.keyId === "string" ? rec.keyId : null;
  if (!keyId || !/^[0-9a-hjkmnp-tv-z]{12}$/.test(keyId)) return null;
  const scopes = Array.isArray(rec.scopes) ? rec.scopes.filter((s) => SCOPES.includes(s)) : [];
  return {
    keyId,
    // Stable across key rotation. Old registry rows retain their original id.
    appId: typeof rec.appId === "string" && /^[a-zA-Z0-9_-]{12,64}$/.test(rec.appId) ? rec.appId : keyId,
    owner: typeof rec.owner === "string" && /^0x[0-9a-fA-F]{40}$/.test(rec.owner) ? rec.owner.toLowerCase() : null,
    name: typeof rec.name === "string" ? displayName(rec.name, keyId) : keyId,
    hash: typeof rec.hash === "string" ? rec.hash : "",
    scopes,
    rpm: Number.isFinite(rec.rpm) && rec.rpm > 0 ? Math.floor(rec.rpm) : null,
    status: rec.status === "revoked" ? "revoked" : "active",
    created_at: typeof rec.created_at === "string" ? rec.created_at : null,
  };
}

function parseEnvKeys(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    // A malformed env var must not silently mean "no partners" on a box where
    // partners are configured — the server's startup check reports it instead.
    return [];
  }
}

async function readFileRecords() {
  try {
    const raw = await readFile(FILE(), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // a torn final line must not break the whole registry
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * The live registry: env first, then the file.
 *
 * The FILE WINS for any keyId it mentions, so a revocation written to the volume
 * can always override a stale env var — the env is the zero-infrastructure path,
 * and it must never be the thing that keeps a revoked key alive.
 */
export async function loadRegistry() {
  const byId = new Map();
  for (const rec of parseEnvKeys(process.env.MERRYMEN_PARTNER_KEYS)) {
    const n = normalize(rec);
    if (n) byId.set(n.keyId, n);
  }
  for (const rec of await readFileRecords()) {
    const n = normalize(rec);
    if (n) byId.set(n.keyId, n); // last line wins, including a revocation
  }
  return byId;
}

/**
 * Cut a JSONL file back to its last complete line. Returns the bytes removed.
 *
 * A write that dies part-way (a full volume, a container killed mid-append)
 * leaves a line with no newline. Skipping it on read is not enough: the NEXT
 * append is glued onto the fragment, and that whole merged line, a record that
 * was acknowledged, then fails to parse. In this registry the record lost that
 * way is typically a revocation, and the key it revoked comes back. Shared with
 * the billing ledger (lib/billing.mjs), which has the same failure with money.
 */
export async function repairTail(file) {
  let fh;
  try { fh = await open(file, "r+"); } catch (err) { if (err.code === "ENOENT") return 0; throw err; }
  try {
    const { size } = await fh.stat();
    if (size === 0) return 0;
    const last = Buffer.alloc(1);
    await fh.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a) return 0;
    let keep = 0;
    const chunk = Buffer.alloc(64 * 1024);
    for (let end = size; end > 0;) {
      const start = Math.max(0, end - chunk.length);
      const { bytesRead } = await fh.read(chunk, 0, end - start, start);
      const nl = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (nl >= 0) { keep = start + nl + 1; break; }
      end = start;
    }
    await fh.truncate(keep);
    await fh.sync();
    return size - keep;
  } finally {
    await fh.close();
  }
}

/** withAppendLock() gave up: another writer held the file for the whole wait. Nothing was written. */
export class FileBusy extends Error {}

const LOCK_POLL_MS = 25;
/** A lock this old belongs to a writer that died mid-append: one ≤ 4 KiB append and its flush never take this long. */
const LOCK_STALE_MS = 10_000;

/**
 * Run `fn` (a repairTail() and the append after it) holding `<file>.lock`,
 * so no OTHER PROCESS repairs or appends to `file` meanwhile. The gateway and
 * the operator CLIs (partners-cli, billing-cli) write the same files. Without
 * this, one could read the other's line while that write was still being
 * copied in (a line crossing a page lands in two steps), take it for a torn
 * tail and truncate it; the truncate waits for the write to finish, then
 * removes a complete, acknowledged record.
 *
 * The lock is a file created exclusively ("wx") and removed after. One left
 * by a writer that died is broken once LOCK_STALE_MS old. The wait is bounded
 * by a count of attempts, then FileBusy, with nothing written.
 */
export async function withAppendLock(file, fn, { waitMs = 5_000 } = {}) {
  const lock = `${file}.lock`;
  await mkdir(path.dirname(file), { recursive: true });
  const attempts = Math.max(1, Math.ceil(waitMs / LOCK_POLL_MS));
  for (let i = 0; i < attempts; i++) {
    let fh;
    try {
      fh = await open(lock, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let age = null;
      try { age = Date.now() - (await stat(lock)).mtimeMs; } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (age !== null && age > LOCK_STALE_MS) {
        console.error(`[partners] ${path.basename(lock)} is ${Math.round(age / 1000)} s old: a writer died holding it; removing it`);
        await rm(lock, { force: true });
      } else if (age !== null) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
      continue;
    }
    await fh.close();
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  }
  throw new FileBusy(`${path.basename(file)} is locked by another writer`);
}

/** Append a record. Creating and revoking are the same operation on this file. */
export async function writeRecord(rec) {
  await mkdir(DIR(), { recursive: true });
  // Under the lock the CLI takes too (withAppendLock), so neither cuts a line
  // the other is still writing.
  await withAppendLock(FILE(), async () => {
    // Before every append, not only the first: the CLI writes this file too, and
    // a torn line it leaves would otherwise swallow the gateway's next record.
    const removed = await repairTail(FILE());
    if (removed) console.error(`[partners] partners.jsonl ended in a torn line: removed ${removed} bytes before appending`);
    // flush:true for the same reason signups.mjs does it: a container can stop
    // between the write and the flush, and a revocation is exactly the write that
    // must not be the one that is lost.
    await appendFile(FILE(), `${JSON.stringify(rec)}\n`, { encoding: "utf8", flush: true });
  });
}

/**
 * The verifier the server holds.
 *
 * Each refusal is its own code so an operator reading a log knows which step
 * failed — "unauthorized" for a key we cannot place, "key_revoked" for one we
 * can, and "forbidden_scope" for a key that is real but not entitled.
 */
export function createPartners({ secret, ttlMs = REGISTRY_TTL_MS, now = () => Date.now() }) {
  if (!secret) throw new Error("createPartners: secret is required");
  let cache = null;
  let loadedAt = 0;
  let inflight = null;

  async function registry() {
    if (cache && now() - loadedAt < ttlMs) return cache;
    // Single-flight: a burst of requests on a cold cache must read the file once.
    if (!inflight) {
      inflight = loadRegistry()
        .then((m) => {
          cache = m;
          loadedAt = now();
          return m;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  return {
    /** Drop the cache, so a freshly issued key works without waiting out the TTL. */
    reload() {
      cache = null;
      loadedAt = 0;
    },

    /**
     * Verify a presented credential.
     *
     * `{ ok: false, notOurs: true }` means "this is not an mmp_ key at all" —
     * the caller answers 404 rather than 401, so probing a partner route with a
     * holder token teaches nothing about what else lives on this host.
     */
    async verify(raw) {
      const parsed = parseKey(raw);
      if (!parsed) return { ok: false, notOurs: true, status: 404, code: "not_found" };

      const rec = (await registry()).get(parsed.keyId);
      if (!rec) return { ok: false, status: 401, code: "unauthorized" };
      if (rec.status !== "active") return { ok: false, status: 401, code: "key_revoked" };
      if (!rec.hash || !sameHash(rec.hash, hashSecret(secret, parsed.secret))) {
        return { ok: false, status: 401, code: "unauthorized" };
      }
      // owner and created_at are for metering (lib/billing.mjs): who a request
      // counts against, and where a Free owner's usage window is anchored. An
      // operator key has no owner and is never metered.
      return { ok: true, key: { keyId: rec.keyId, appId: rec.appId, name: rec.name, scopes: rec.scopes, rpm: rec.rpm,
        owner: rec.owner, created_at: rec.created_at } };
    },

    /** Does this verified key carry `scope`? */
    allows(key, scope) {
      return !!key && Array.isArray(key.scopes) && key.scopes.includes(scope);
    },
  };
}
