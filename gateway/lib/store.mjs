/**
 * Shared state for the gateway: single-use nonces, rate-limit counters, the
 * holder-balance cache, and revocations (signed-out developer sessions).
 *
 * On a single long-lived process (the standalone server) an in-memory store is
 * correct. On Vercel serverless, each invocation may be a fresh isolate, so the
 * state MUST live in an external store or the guarantees evaporate (a spent nonce
 * on instance A is unknown to instance B; rate limits become per-isolate). This
 * module auto-selects: Upstash/Vercel-KV REST if its env is present, else memory.
 *
 * Redis gives us ATOMIC single-use via `SET key 1 NX EX ttl` (OK ⇒ first spend,
 * null ⇒ replay) and atomic counters via `INCR`/`EXPIRE` — race-free by design.
 */

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).result;
}

function redisStore() {
  return {
    durable: true,
    /**
     * Atomic single-use: true only the FIRST time this nonce is spent.
     * `throwOnError` lets a caller tell "already spent" from "could not ask":
     * both refuse, but only one should tell a person their proof was used.
     */
    async spendNonce(token, ttlSec, { throwOnError = false } = {}) {
      try {
        return (await redis(["SET", `n:${token}`, "1", "NX", "EX", String(ttlSec)])) === "OK";
      } catch (err) {
        if (throwOnError) throw err;
        return false; // fail closed — if we can't guarantee single-use, reject
      }
    },
    /** true if this key is still within `limit` hits during the rolling window. */
    async rateHit(key, limit, windowSec) {
      try {
        const n = await redis(["INCR", `r:${key}`]);
        if (n === 1) await redis(["EXPIRE", `r:${key}`, String(windowSec)]);
        return n <= limit;
      } catch {
        return true; // fail open — a KV blip shouldn't take the gateway down
      }
    },
    /**
     * Reserve `points` against a shared allowance of `cap`, BEFORE spending
     * them. True when they fit; false when they would pass the cap (and are
     * handed back); null when the store could not be asked. Unlike rateHit,
     * this FAILS CLOSED: a spend the gateway cannot count is not one it makes.
     */
    async reservePoints(key, points, cap, ttlSec) {
      try {
        const n = await redis(["INCRBY", `p:${key}`, String(points)]);
        if (n === points) await redis(["EXPIRE", `p:${key}`, String(ttlSec)]);
        if (n <= cap) return true;
        // Over: give the points back so a refused call costs nothing. Two
        // callers racing past the cap both refuse; the cap is never passed.
        await redis(["DECRBY", `p:${key}`, String(points)]).catch(() => {});
        return false;
      } catch {
        return null;
      }
    },
    /**
     * Hand back points reserved under `key` for a call that was never made
     * (a later purse refused it). Best effort: a failed release leaves them
     * counted, which only ever errs toward spending less.
     */
    async releasePoints(key, points) {
      try {
        await redis(["DECRBY", `p:${key}`, String(points)]);
      } catch {
        /* still counted: the safe side */
      }
    },
    async getBal(addr) {
      try {
        const v = await redis(["GET", `b:${addr}`]);
        return v === null || v === undefined ? null : v === "1";
      } catch {
        return null; // treat as a cache miss
      }
    },
    async setBal(addr, ok, ttlSec) {
      try {
        await redis(["SET", `b:${addr}`, ok ? "1" : "0", "EX", String(ttlSec)]);
      } catch {
        /* best-effort cache */
      }
    },
    /**
     * Revocations THROW when the store is unreachable, unlike everything above.
     * There is no safe default to fall back to: answering "not revoked" revives
     * a signed-out session, and swallowing a failed write reports a logout that
     * did not happen. The caller fails closed with an honest "unavailable".
     */
    async revoke(token, ttlSec) {
      await redis(["SET", `x:${token}`, "1", "EX", String(Math.max(1, Math.ceil(ttlSec)))]);
    },
    async isRevoked(token) {
      return (await redis(["EXISTS", `x:${token}`])) === 1;
    },
  };
}

function memoryStore() {
  const nonces = new Map(); // token -> expiryMs
  const rates = new Map(); // key -> { n, reset }
  const bal = new Map(); // addr -> { ok, at }
  const revocations = new Map(); // token -> expiryMs. Lost on restart: see `durable`.
  const spends = new Map(); // key -> { points, until }. Lost on restart: see `durable`.
  return {
    durable: false,
    async reservePoints(key, points, cap, ttlSec) {
      const now = Date.now();
      const s = spends.get(key);
      const spent = s && s.until > now ? s.points : 0;
      if (spent + points > cap) return false;
      spends.set(key, { points: spent + points, until: now + ttlSec * 1000 });
      if (spends.size > 64) for (const [k, v] of spends) if (v.until <= now) spends.delete(k);
      return true;
    },
    async releasePoints(key, points) {
      const s = spends.get(key);
      if (s && s.until > Date.now()) s.points = Math.max(0, s.points - points);
    },
    async spendNonce(token, ttlSec) {
      const now = Date.now();
      const seen = nonces.get(token);
      if (seen && seen > now) return false; // already spent, still within TTL
      nonces.set(token, now + ttlSec * 1000);
      if (nonces.size > 50_000) for (const [k, until] of nonces) if (until < now) nonces.delete(k);
      return true;
    },
    async rateHit(key, limit, windowSec) {
      const now = Date.now();
      const w = rates.get(key) || { n: 0, reset: now + windowSec * 1000 };
      if (now > w.reset) {
        w.n = 0;
        w.reset = now + windowSec * 1000;
      }
      w.n += 1;
      rates.set(key, w);
      return w.n <= limit;
    },
    async getBal(addr) {
      const c = bal.get(addr);
      return c && Date.now() - c.at < c.ttl ? c.ok : null;
    },
    async setBal(addr, ok, ttlSec) {
      if (bal.size > 10_000 && !bal.has(addr)) bal.delete(bal.keys().next().value);
      bal.set(addr, { ok, at: Date.now(), ttl: ttlSec * 1000 });
    },
    async revoke(token, ttlSec) {
      const now = Date.now();
      revocations.set(token, now + ttlSec * 1000);
      if (revocations.size > 50_000) for (const [k, until] of revocations) if (until < now) revocations.delete(k);
    },
    async isRevoked(token) {
      return (revocations.get(token) ?? 0) > Date.now();
    },
  };
}

/** Auto-select the backing store. `durable` is false for the memory fallback. */
export function createStore() {
  return REDIS_URL && REDIS_TOKEN ? redisStore() : memoryStore();
}

export const hasRedis = !!(REDIS_URL && REDIS_TOKEN);
