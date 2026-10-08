import { createHash, createHmac, randomBytes } from "node:crypto";

// This service credential is distinct from both the holder signing secret and
// partner keys. It authenticates an exact request, never an arbitrary tenant.
export function signPartnerRequest({ secret, key, method, path, body = "", now = Date.now(), nonce = randomBytes(18).toString("hex") }) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("Partner runtime is not configured");
  const context = Buffer.from(JSON.stringify({ v: 1, app_id: key.appId ?? key.keyId, key_id: key.keyId,
    name: key.name, scopes: key.scopes, iat: Math.floor(now / 1000), nonce })).toString("base64url");
  const digest = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", secret).update(`${method}\n${path}\n${context}\n${digest}`).digest("hex");
  return { "x-merrymen-partner-context": context, "x-merrymen-partner-signature": signature };
}

/** Log-safe: printable ASCII only, bounded, so an upstream header cannot forge a log line. */
const clean = (value, fallback) => String(value ?? fallback).replace(/[^\x20-\x7e]/g, "").slice(0, 80) || fallback;

/**
 * The partner always gets the same safe envelope and never an upstream body.
 * The operator now gets the rest. This used to turn ANY failed or non-JSON
 * answer into an opaque 503 and log nothing, which is how a production-wide
 * 403 from the web app's cross-site block stayed hidden for a week.
 *
 * The code separates the failures without revealing any of them:
 *   upstream_unavailable       no complete answer (refused, DNS, timeout,
 *                              redirect), or the runtime refused this gateway
 *                              itself rather than the partner (see `ours`)
 *   upstream_invalid_response  the web app answered, but not with its JSON
 *                              envelope: a middleware refusal, a proxy page
 * Both stay 503, the status the contract tells partners to back off on.
 *
 * Every answer that is not a 2xx is logged: method, route, request_id, key id,
 * upstream status, then the runtime's error code or the content-type, or the
 * fetch error's name and cause. Never a body, a header value or a secret;
 * those live only in the request, which no fetch error repeats.
 */
const isObject = v => !!v && typeof v === "object" && !Array.isArray(v);
/**
 * THE RUNTIME REFUSING THE GATEWAY, NOT THE PARTNER. A request is forwarded
 * only after the gateway has accepted the partner's key, so these answers are
 * about the bridge: a 401 `unauthorized` comes only from the runtime's check of
 * this bridge's signature (MERRYMEN_PARTNER_BRIDGE_SECRET differs between the
 * two services, their clocks disagree, or its nonce store failed), and "Hosted
 * API only" from a web app not running in hosted mode. Relayed, they read as
 * the contract's "your key is wrong" and "no such endpoint" to a partner whose
 * key is fine. The runtime's own refusals of a partner's input use other codes.
 */
const ours = (status, error) => (status === 401 && error.code === "unauthorized") ||
  (status === 404 && error.message === "Hosted API only");
export function createPartnerBridge({ secret, origin = "https://app.merrymen.dev", fetchImpl = fetch, log = console.error } = {}) {
  const target = new URL(origin);
  if (target.username || target.password || target.pathname !== "/" || target.search || target.hash ||
      (target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1"].includes(target.hostname)))) {
    throw new Error("Partner app origin must be an HTTPS origin (or localhost for development)");
  }
  const failure = (code, message) => ({ status: 503, json: { error: { code, message } } });
  return async ({ key, method, path, body = "", requestId }) => {
    const where = `[gateway] partner bridge: ${method} ${path} ${clean(requestId, "-")} key ${clean(key.keyId, "-")}`;
    let headers;
    try { headers = signPartnerRequest({ secret, key, method, path, body }); } catch {
      log(`${where} not sent: MERRYMEN_PARTNER_BRIDGE_SECRET is unset or under 32 bytes`);
      return failure("upstream_unavailable", "Agent runtime is not configured");
    }
    let status, type, text, retryAfter;
    try {
      const response = await fetchImpl(`${target.origin}/api/partner${path}`, {
        method, headers: { ...headers, "content-type": "application/json" },
        ...(body ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(45_000),
      });
      ({ status } = response);
      type = response.headers.get("content-type");
      retryAfter = response.headers.get("retry-after");
      text = await response.text();
    } catch (err) {
      const cause = clean(err?.cause?.code ?? err?.cause?.message, "no cause");
      log(`${where} ${status ? `answered HTTP ${status}, then its body failed` : "got no answer"}: ${clean(err?.name, "Error")} (${cause})`);
      return failure("upstream_unavailable", "Agent runtime is temporarily unavailable");
    }
    let json;
    try { json = JSON.parse(text); } catch { /* Reported below. */ }
    const ok = status >= 200 && status < 300;
    // The runtime's envelope: an object, and on a refusal an `error` object with
    // a code. `{"error":"Forbidden"}` from a proxy used to pass, then throw where
    // partner-api stamps the request_id, as an opaque 503 that logged nothing.
    if (!isObject(json) || (json.error === undefined ? !ok : !(isObject(json.error) && typeof json.error.code === "string"))) {
      log(`${where} answered HTTP ${status} ${clean(type, "without a content-type")}, not the runtime's JSON`);
      return failure("upstream_invalid_response", "Agent runtime returned an unexpected response");
    }
    if (ok) return { status, json };
    if (ours(status, json.error)) {
      log(`${where} answered HTTP ${status} ${clean(json.error.code, "-")}: the runtime refused this gateway, not the partner. Check MERRYMEN_PARTNER_BRIDGE_SECRET and the clocks on both services, and that the web app runs in hosted mode`);
      return failure("upstream_unavailable", "Agent runtime is temporarily unavailable");
    }
    // Relayed as the runtime wrote it, and still worth a line: a partner's
    // report quotes the request_id, and this is where that id is found.
    log(`${where} answered HTTP ${status} ${clean(json.error.code, "-")}`);
    // A busy conversation or enrollment says when to come back. Delay-seconds
    // only, the one form the runtime writes, so nothing else rides along.
    return { status, json, ...(/^\d{1,5}$/.test(retryAfter ?? "") ? { headers: { "retry-after": retryAfter } } : {}) };
  };
}
