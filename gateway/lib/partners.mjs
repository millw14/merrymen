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
import { appendFile, mkdir, readFile } from "node:fs/promises";
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
    name: typeof rec.name === "string" ? rec.name.slice(0, 64) : keyId,
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

/** Append a record. Creating and revoking are the same operation on this file. */
export async function writeRecord(rec) {
  await mkdir(DIR(), { recursive: true });
  // flush:true for the same reason signups.mjs does it: a container can stop
  // between the write and the flush, and a revocation is exactly the write that
  // must not be the one that is lost.
  await appendFile(FILE(), `${JSON.stringify(rec)}\n`, { encoding: "utf8", flush: true });
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
      return { ok: true, key: { keyId: rec.keyId, appId: rec.appId, name: rec.name, scopes: rec.scopes, rpm: rec.rpm } };
    },

    /** Does this verified key carry `scope`? */
    allows(key, scope) {
      return !!key && Array.isArray(key.scopes) && key.scopes.includes(scope);
    },
  };
}
