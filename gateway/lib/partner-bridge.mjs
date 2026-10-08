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
 * The code separates the two failures without revealing either:
 *   upstream_unavailable       no complete answer: refused, DNS, timeout, redirect
 *   upstream_invalid_response  the web app answered, but not with its JSON
 *                              envelope: a middleware refusal, a proxy page
 * Both stay 503, the status the contract tells partners to back off on.
 *
 * Logged: method, route, request_id, key id, upstream status, content-type and
 * the fetch error's name and cause. Never a body, a header value or a secret;
 * those live only in the request, which no fetch error repeats.
 */
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
    let status, type, text;
    try {
      const response = await fetchImpl(`${target.origin}/api/partner${path}`, {
        method, headers: { ...headers, "content-type": "application/json" },
        ...(body ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(45_000),
      });
      ({ status } = response);
      type = response.headers.get("content-type");
      text = await response.text();
    } catch (err) {
      const cause = clean(err?.cause?.code ?? err?.cause?.message, "no cause");
      log(`${where} ${status ? `answered HTTP ${status}, then its body failed` : "got no answer"}: ${clean(err?.name, "Error")} (${cause})`);
      return failure("upstream_unavailable", "Agent runtime is temporarily unavailable");
    }
    let json;
    try { json = JSON.parse(text); } catch { /* Reported below. */ }
    if (!json || typeof json !== "object") {
      log(`${where} answered HTTP ${status} ${clean(type, "without a content-type")}, not the runtime's JSON`);
      return failure("upstream_invalid_response", "Agent runtime returned an unexpected response");
    }
    // Relayed as the runtime wrote it; a server-side failure is still worth a line.
    if (status >= 500) log(`${where} answered HTTP ${status} ${clean(json.error?.code, "without an error code")}`);
    return { status, json };
  };
}
