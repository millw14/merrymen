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

export const PARTNER_TUNABLES = {
  /** Per-key, per-minute. Generous — these reads are cached and cheap. */
  RATE_PER_MIN: 120,
  /** Per-IP, per-minute. Protects the PROCESS, not the bill. */
  IP_RATE_PER_MIN: 240,
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
 */
export function createPartnerApi({ partners, store, forward, tunables = {}, version = "2026-09-18" }) {
  const T = { ...PARTNER_TUNABLES, ...tunables };

  /**
   * Authenticate, then meter. In that order on purpose: metering an
   * unauthenticated caller would let anyone burn a known partner's quota by
   * presenting their key id with a wrong secret.
   */
  async function gate(authorization, ip, scope) {
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

    // Buckets keyed on the keyId, NEVER the secret — a rate-limit key can end up
    // in a log or a Redis dump.
    const perKey = T[`RATE_PER_MIN_${v.key.keyId}`] ?? v.key.rpm ?? T.RATE_PER_MIN;
    if (!(await store.rateHit(`p:${v.key.keyId}`, perKey, 60))) {
      return { fail: partnerError(429, "rate_limited", `${perKey} requests/minute for this key`, rid) };
    }
    if (ip && !(await store.rateHit(`pip:${ip}`, T.IP_RATE_PER_MIN, 60))) {
      return { fail: partnerError(429, "rate_limited", "too many requests from this address", rid) };
    }

    return { key: v.key, rid };
  }

  return {
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
      if (method === "GET" && route === "/meta") {
        const g = await gate(authorization, ip, null);
        if (g.fail) return g.fail;
        return {
          status: 200,
          json: {
            key_id: g.key.keyId,
            app_id: g.key.appId ?? g.key.keyId,
            name: g.key.name,
            scopes: g.key.scopes,
            rate_per_min: g.key.rpm ?? T.RATE_PER_MIN,
            api_version: version,
          },
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
        if (!forward) return partnerError(503, "upstream_unavailable", "Agent runtime is not configured", g.rid);
        try {
          const result = await forward({ key: g.key, method, path: route, body });
          if (result.json?.error) result.json.error.request_id = g.rid;
          return result;
        } catch {
          return partnerError(503, "upstream_unavailable", "Agent runtime is temporarily unavailable", g.rid);
        }
      }

      // An unknown partner route still authenticates first, so the 404 set is not
      // enumerable by an unauthenticated caller.
      const g = await gate(authorization, ip, null);
      if (g.fail) return g.fail;
      if (method !== "GET") return partnerError(405, "bad_request", "method not supported for this endpoint", g.rid);
      return partnerError(404, "not_found", `no such endpoint: ${route}`, g.rid);
    },
  };
}
