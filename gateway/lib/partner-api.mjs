/**
 * The partner surface: `/partner/v1/...`
 *
 * NOT `/v1`. That prefix on this host is already the OpenAI-compatible contract —
 * it returns `{"error":{"message":…}}` because that is what an OpenAI client
 * parses, and `/v1/models` is unauthenticated because such a client demands it
 * before it will show a model picker. Serving resources under the same prefix
 * would mean one path carrying two incompatible error envelopes and two auth
 * schemes, and the first person to touch it would have to guess which.
 *
 * NO CORS, EVER. A partner key is a server-side secret. A browser-callable
 * partner API is a key-leaking API, and the gateway's blanket preflight answer
 * (server.mjs) already makes every route here uncallable from a page — that is a
 * property to preserve, not an oversight to fix.
 *
 * THE TUNABLES LIVE HERE, not in core.mjs's DEFAULTS. Those numbers are the cost
 * model of a paid LLM key; these are a read quota over cached public data. Put
 * them side by side and somebody eventually edits them as if they were the same
 * knob.
 */

import { randomBytes } from "node:crypto";
import { isPlatformFailure } from "./billing.mjs";

export const PARTNER_TUNABLES = {
  /**
   * Per-key, per-minute, for a key with no stored rate of its own (portal keys
   * store 30). Generous — these reads are cached and cheap. Under billing
   * enforce, a metered key gets its account's plan rate instead
   * (lib/billing-plans.mjs); under observe, the higher of the two.
   */
  RATE_PER_MIN: 120,
  /**
   * Per-IP, per-minute. Protects the PROCESS, not the bill. With billing off
   * (or no billing service) it is what it was before billing: no plan bounds
   * an account then, so a higher one would only let one address put more load
   * on the process that also serves the holder routes.
   */
  IP_RATE_PER_MIN: 240,
  /**
   * Per-IP, per-minute while billing meters accounts (observe or enforce):
   * plans bound accounts, and this sits above every plan's rate (Feast is
   * 300), so a partner's one backend can use what its account paid for;
   * selftest.mjs pins that.
   */
  IP_RATE_PER_MIN_METERED: 600,
};

/** Short, non-secret, and logged next to the keyId so a report locates a request. */
const requestId = () => `req_${randomBytes(6).toString("hex")}`;

/**
 * One envelope for everything under /partner/*.
 *
 * Deliberately not the OpenAI shape used by /v1 — a partner writing an error
 * handler should not have to discover that two endpoints on one host disagree.
 */
export function partnerError(status, code, message, rid = requestId()) {
  return { status, json: { error: { code, message, request_id: rid } } };
}

export const PARTNER_PREFIX = "/partner/v1";

/**
 * @param partners  from createPartners() in partners.mjs
 * @param store     the shared rate-limit store (same one the holder routes use)
 * @param billing   from createBilling() in billing.mjs, or null: nothing is metered
 */
export function createPartnerApi({ partners, store, forward, billing = null, tunables = {}, version = "2026-10-08" }) {
  const T = { ...PARTNER_TUNABLES, ...tunables };
  /**
   * Units reserved by requests that have not been answered yet. Each leaves
   * through metered(), counted or given back; what is still here at shutdown
   * is a request the process is about to cut off (releaseUnfinished()).
   */
  const unfinished = new Set();

  /**
   * The wallet a key's requests count against, or null when nothing is
   * metered: billing is off, or the key is an operator's, which has no owner.
   * Off must stay exactly the gateway from before billing, so every metered
   * path below starts from this.
   */
  const ownerOf = (key) => (billing && billing.mode !== "off" && key?.owner) || null;

  /**
   * The rate a key gets, and the bucket that counts it. Under enforce, a
   * metered key gets its ACCOUNT's plan rate in one bucket per wallet: five
   * keys must not mean five times what the plan sells. Anything else keeps
   * its own rate and bucket.
   *
   * Observe is the dry run before enforce, and refuses nothing billing off
   * would answer: each key keeps its own bucket, at its own rate or its
   * plan's when that is higher (a paying account is not held below what it
   * bought). One shared bucket at Free's 30 would turn a developer's second
   * key into 429s the moment observe is switched on.
   *
   * The plan is the one the request will be served on: when a renewal or an
   * activation is due, the plan that charge makes. The rate is checked before
   * the settle that makes it, so the plan as it stands (Free, the moment a
   * paid period ends) would refuse a busy account's renewing request at
   * Free's rate, and nothing would renew until that minute had passed.
   */
  function rateOf(key) {
    const owner = ownerOf(key);
    const own = T[`RATE_PER_MIN_${key.keyId}`] ?? key.rpm ?? T.RATE_PER_MIN;
    if (!owner) return { rpm: own, bucket: `p:${key.keyId}`, per: "key" };
    const plan = billing.nextPlanFor(owner, key.created_at).rpm;
    if (billing.enforced) return { rpm: plan, bucket: `pa:${owner}`, per: "account" };
    return { rpm: Math.max(own, plan), bucket: `p:${key.keyId}`, per: "key" };
  }

  /**
   * Authenticate, then meter. In that order on purpose: metering an
   * unauthenticated caller would let anyone burn a known partner's quota by
   * presenting their key id with a wrong secret.
   *
   * `metered: false` is for /meta, which is free: rate-limited like anything
   * else, never counted, and never the request that makes a charge.
   */
  async function gate(authorization, ip, scope, { metered = true } = {}) {
    const rid = requestId();
    const raw = typeof authorization === "string" ? authorization.replace(/^Bearer\s+/i, "").trim() : "";

    const v = await partners.verify(raw);
    if (!v.ok) {
      // notOurs → 404. A 401 would confirm to someone probing with an mmk_ token
      // that a partner system exists here at all.
      if (v.notOurs) return { fail: partnerError(404, "not_found", "no such endpoint", rid) };
      return {
        fail: partnerError(
          v.status,
          v.code,
          v.code === "key_revoked" ? "this key has been revoked" : "invalid or unknown key",
          rid,
        ),
      };
    }

    if (scope && !partners.allows(v.key, scope)) {
      return { fail: partnerError(403, "forbidden_scope", `this key does not carry ${scope}`, rid) };
    }

    // Buckets keyed on the keyId or the owning wallet, NEVER the secret — a
    // rate-limit key can end up in a log or a Redis dump.
    const { rpm, bucket, per } = rateOf(v.key);
    if (!(await store.rateHit(bucket, rpm, 60))) {
      return { fail: partnerError(429, "rate_limited", `${rpm} requests/minute for this ${per}`, rid) };
    }
    const ipRate = billing && billing.mode !== "off" ? T.IP_RATE_PER_MIN_METERED : T.IP_RATE_PER_MIN;
    if (ip && !(await store.rateHit(`pip:${ip}`, ipRate, 60))) {
      return { fail: partnerError(429, "rate_limited", "too many requests from this address", rid) };
    }

    const owner = metered ? ownerOf(v.key) : null;
    if (!owner) return { key: v.key, rid, rpm };
    // Counted only past every refusal above: a request this gate turns away
    // costs no quota. A charge that is due (a payment waiting to activate, a
    // lapsed period with credit to renew) is made first, so the request counts
    // against the plan that was paid for. That wait is bounded (2 s), then the
    // request is served on what was there before.
    await billing.prepare(owner);
    const r = billing.reserve({ owner, keyId: v.key.keyId, keyCreatedAt: v.key.created_at });
    if (!r.ok) {
      // Structured, so a partner's client never parses the message for when to come back.
      const { code, message, ...quota } = r.error;
      return { fail: { status: r.status, json: { error: { code, message, request_id: rid, ...quota } }, headers: r.headers } };
    }
    if (r.ticket) {
      // Visible to shutdown's give-back from the moment it is counted.
      unfinished.add(r.ticket);
      if (billing.enforced) {
        // On disk before it is served: a crash after the answer must not forget
        // the unit, or the partner gets those requests again for free. Requests
        // arriving together share a write; the wait is bounded (2 s), and a
        // count that did not land is given back and refused rather than served.
        const saved = await billing.durable();
        // Shutdown gave it back while it waited: the process is going away.
        if (!unfinished.has(r.ticket)) return { fail: partnerError(503, "upstream_unavailable", "The gateway is restarting; resend this request", rid) };
        if (!saved) {
          unfinished.delete(r.ticket);
          billing.release(r.ticket);
          return { fail: partnerError(503, "billing_unavailable", "Usage could not be recorded just now; try again shortly", rid) };
        }
      } else {
        void billing.flush(); // observe enforces nothing, so it does not wait on the disk
      }
    }
    return { key: v.key, rid, rpm, ticket: r.ticket, quota: r.headers };
  }

  /**
   * A metered answer carries the quota headers, merged so a relayed
   * Retry-After survives. One the platform failed (a 5xx, an upstream_* code,
   * a busy runtime the contract says to resend to) gives its unit back first,
   * and its headers count without it. A partner's own 4xx stays counted.
   */
  function metered(g, result) {
    if (!g.ticket) return result;
    let quota = g.quota;
    // Already given back by a shutdown that gave up on it: nothing more to do.
    if (!unfinished.delete(g.ticket)) return { ...result, headers: { ...result.headers, ...quota } };
    const code = result.json?.error?.code;
    if (isPlatformFailure(result.status, typeof code === "string" ? code : undefined)) {
      billing.release(g.ticket);
      void billing.flush(); // saved soon, not awaited: the answer is not held for a give-back
      quota = billing.meta(g.key.owner, g.key.created_at).headers;
    }
    return { ...result, headers: { ...result.headers, ...quota } };
  }

  return {
    /** The per-minute rate a key gets, as /meta reports it; the developer portal lists keys with it. */
    ratePerMin: (key) => rateOf(key).rpm,

    /**
     * At shutdown, once the drain has given up: give back the unit of every
     * request still running. The process exits before they are answered, so
     * the partner never gets the answer it would be charged for, and resends.
     * Returns how many.
     */
    releaseUnfinished() {
      const n = unfinished.size;
      for (const ticket of unfinished) billing.release(ticket);
      unfinished.clear();
      return n;
    },

    /** Is this ours to answer at all? */
    owns(pathname) {
      return pathname === PARTNER_PREFIX || pathname.startsWith(`${PARTNER_PREFIX}/`);
    },

    /**
     * Returns `{status, json}`, or null when the path is not a partner path.
     * Never throws — the server's catch-all is a backstop, not the design.
     */
    async handle({ method, pathname, authorization, ip, body = "" }) {
      if (!this.owns(pathname)) return null;
      const route = pathname.slice(PARTNER_PREFIX.length) || "/";

      // The hosted runtime's own body limits (web/src/lib/partner-service.ts):
      // 32 KiB, 256 KiB for an activation's grant. Refused here, before the key
      // is checked or a request metered, so a body the runtime could never take
      // costs no quota and never reaches it.
      if (method === "POST" && Buffer.byteLength(body) > (route.endsWith("/activate") ? 256 * 1024 : 32 * 1024)) {
        return partnerError(413, "bad_request", "Request body is too large");
      }

      if (method === "GET" && route === "/") {
        return { status: 200, json: {
          service: "merrymen-partner-api", api_version: version,
          description: "Create a Merryman with its owner's permission, follow its worker status, and chat from your app.",
          authentication: "Server-side Authorization: Bearer <partner key>",
          endpoints: { health: "GET /health", meta: "GET /meta", create_agent: "POST /agents",
            authorization_challenge: "POST /agents/{id}/challenge", activate_agent: "POST /agents/{id}/activate",
            agents: "GET /agents", agent: "GET /agents/{id}", chat: "POST /agents/{id}/messages",
            history: "GET /agents/{id}/messages", disconnect: "DELETE /agents/{id}/connection" },
          onboarding: "Keep setup in your app: prepare capped wallet permissions with the browser SDK, request a challenge through your backend, ask the owner to sign it, then activate the agent. A hosted onboarding_url is optional.",
        } };
      }

      // Liveness, unauthenticated. Distinct from /healthz, which describes the
      // holder gateway — a partner checking the wrong one learns nothing useful.
      if (method === "GET" && route === "/health") {
        return { status: 200, json: { ok: true, service: "merrymen-partner-api", api_version: version } };
      }

      // The first call a partner makes: does my key work, and what does it carry?
      // Free, and never the request that makes a charge: it reads the plan as
      // it stands, and says whether the next metered request would renew it.
      if (method === "GET" && route === "/meta") {
        const g = await gate(authorization, ip, null, { metered: false });
        if (g.fail) return g.fail;
        const owner = ownerOf(g.key);
        const m = owner ? billing.meta(owner, g.key.created_at) : null;
        return {
          status: 200,
          json: {
            key_id: g.key.keyId,
            app_id: g.key.appId ?? g.key.keyId,
            name: g.key.name,
            scopes: g.key.scopes,
            // The rate this key actually gets: its account's plan when metered.
            rate_per_min: g.rpm,
            api_version: version,
            billing: m?.billing ?? null,
          },
          ...(m ? { headers: m.headers } : {}),
        };
      }

      const scope = route === "/agents" ? (method === "POST" ? "write:agents" : method === "GET" ? "read:agents" : null)
        : /^\/agents\/[a-zA-Z0-9_-]+\/(challenge|activate)$/.test(route) && method === "POST" ? "write:agents"
        : /^\/agents\/[a-zA-Z0-9_-]+\/messages$/.test(route) && ["GET", "POST"].includes(method) ? "chat:agents"
        : /^\/agents\/[a-zA-Z0-9_-]+\/connection$/.test(route) && method === "DELETE" ? "write:agents"
        : /^\/agents\/[a-zA-Z0-9_-]+$/.test(route) && method === "GET" ? "read:agents" : null;
      if (scope) {
        const g = await gate(authorization, ip, scope);
        if (g.fail) return g.fail;
        if (!forward) return metered(g, partnerError(503, "upstream_unavailable", "Agent runtime is not configured", g.rid));
        try {
          // The request_id goes along so the bridge's log line matches the partner's report.
          const result = await forward({ key: g.key, method, path: route, body, requestId: g.rid });
          if (result.json?.error && typeof result.json.error === "object") result.json.error.request_id = g.rid;
          return metered(g, result);
        } catch {
          return metered(g, partnerError(503, "upstream_unavailable", "Agent runtime is temporarily unavailable", g.rid));
        }
      }

      // An unknown partner route still authenticates first, so the 404 set is not
      // enumerable by an unauthenticated caller. Asked with a working key, it is
      // a request like any other, so it counts.
      const g = await gate(authorization, ip, null);
      if (g.fail) return g.fail;
      if (method !== "GET") return metered(g, partnerError(405, "bad_request", "method not supported for this endpoint", g.rid));
      return metered(g, partnerError(404, "not_found", `no such endpoint: ${route}`, g.rid));
    },
  };
}
