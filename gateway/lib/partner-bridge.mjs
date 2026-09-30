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

export function createPartnerBridge({ secret, origin = "https://app.merrymen.dev", fetchImpl = fetch } = {}) {
  const target = new URL(origin);
  if (target.username || target.password || target.pathname !== "/" || target.search || target.hash ||
      (target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1"].includes(target.hostname)))) {
    throw new Error("Partner app origin must be an HTTPS origin (or localhost for development)");
  }
  return async ({ key, method, path, body = "" }) => {
    try {
      const headers = signPartnerRequest({ secret, key, method, path, body });
      const response = await fetchImpl(`${target.origin}/api/partner${path}`, {
        method, headers: { ...headers, "content-type": "application/json" },
        ...(body ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(45_000),
      });
      const json = await response.json();
      if (!json || typeof json !== "object") throw new Error("Invalid runtime response");
      return { status: response.status, json };
    } catch {
      return { status: 503, json: { error: { code: "upstream_unavailable", message: "Agent runtime is temporarily unavailable" } } };
    }
  };
}
