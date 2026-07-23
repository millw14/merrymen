/**
 * Shared state for the gateway: single-use nonces, rate-limit counters, and the
 * holder-balance cache.
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
    /** Atomic single-use: true only the FIRST time this nonce is spent. */
    async spendNonce(token, ttlSec) {
      try {
        return (await redis(["SET", `n:${token}`, "1", "NX", "EX", String(ttlSec)])) === "OK";
      } catch {
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
  };
}

function memoryStore() {
  const nonces = new Map(); // token -> expiryMs
  const rates = new Map(); // key -> { n, reset }
  const bal = new Map(); // addr -> { ok, at }
  return {
    durable: false,
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
  };
}

/** Auto-select the backing store. `durable` is false for the memory fallback. */
export function createStore() {
  return REDIS_URL && REDIS_TOKEN ? redisStore() : memoryStore();
}

export const hasRedis = !!(REDIS_URL && REDIS_TOKEN);
