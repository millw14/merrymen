import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "viem";
import { makeKey, hashSecret, loadRegistry, writeRecord } from "./partners.mjs";

const SCOPES = ["read:agents", "write:agents", "chat:agents"];
const same = (a, b) => { const x = Buffer.from(a || ""), y = Buffer.from(b || ""); return x.length === y.length && timingSafeEqual(x, y); };
const publicKey = r => ({ key_id: r.keyId, app_id: r.appId, name: r.name, status: r.status,
  scopes: r.scopes, rate_per_min: r.rpm, created_at: r.created_at, prefix: `mmp_${r.keyId}_` });

/** Only the first-party portal's server may call this wallet-authenticated surface. */
export function createDeveloperApi({ portalSecret, gatewaySecret, partners, partnerApi, store,
  verify = verifyMessage, now = Date.now, read = loadRegistry, write = writeRecord }) {
  const boot = randomBytes(16).toString("hex");
  let mutations = Promise.resolve();
  const sign = (type, data) => {
    const encoded = Buffer.from(JSON.stringify({ ...data, type })).toString("base64url");
    return `${encoded}.${createHmac("sha256", portalSecret).update(`developer-v1:${encoded}`).digest("base64url")}`;
  };
  const decode = (raw, type) => {
    if (typeof raw !== "string" || raw.length > 4096) return null;
    const [encoded, mac, extra] = raw.split(".");
    if (!encoded || !mac || extra || !same(mac, createHmac("sha256", portalSecret).update(`developer-v1:${encoded}`).digest("base64url"))) return null;
    try {
      const v = JSON.parse(Buffer.from(encoded, "base64url"));
      return v.type === type && v.expires > now() && /^0x[0-9a-f]{40}$/.test(v.address) ? v : null;
    } catch { return null; }
  };
  const message = c => `Sign in to Merrymen Developers\n\nWebsite: https://merrymen.dev/api\nWallet: ${c.address}\n\nManage API keys for your applications. This does not authorize trading or move funds.\n\nNonce: ${c.nonce}\nExpires: ${new Date(c.expires).toISOString()}`;
  const error = (status, message) => ({ status, json: { error: { message } } });
  async function dispatch({ method, path, authorization, session, body = {}, ip = "unknown" }) {
    if (!portalSecret || Buffer.byteLength(portalSecret) < 32) return error(503, "Developer sign-in is temporarily unavailable");
    if (!same(authorization, `Bearer ${portalSecret}`)) return error(401, "Unauthorized portal");
    if (!await store.rateHit(`dev:ip:${ip}`, 60, 60)) return error(429, "Too many requests. Try again in a minute.");
    if (method === "POST" && path === "/challenge") {
      if (typeof body.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) return error(400, "Choose a wallet address");
      const c = { address: body.address.toLowerCase(), nonce: randomBytes(24).toString("hex"), expires: now() + 300_000, boot };
      return { status: 200, json: { challenge: sign("challenge", c), message: message(c) } };
    }
    if (method === "POST" && path === "/verify") {
      const c = decode(body.challenge, "challenge");
      if (!c || c.boot !== boot || typeof body.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) return error(401, "Sign-in expired. Connect your wallet again.");
      let valid = false;
      try { valid = await verify({ address: c.address, message: message(c), signature: body.signature }); } catch { /* Invalid proof. */ }
      if (!valid || !await store.spendNonce(`developer:${c.nonce}`, 301)) return error(401, "Invalid or already used wallet signature");
      return { status: 200, json: { address: c.address, session: sign("session", { address: c.address, expires: now() + 8 * 3600_000 }) } };
    }
    const user = decode(session, "session");
    if (!user) return error(401, "Sign in to manage your API keys");
    if (method === "GET" && path === "/keys") {
      const keys = [...(await read()).values()].filter(r => r.owner === user.address);
      return { status: 200, json: { address: user.address, keys: keys.map(publicKey) } };
    }
    if (method === "POST" && path === "/test") {
      const checked = await partners.verify(body.key);
      if (!checked.ok) return error(401, "That API key is invalid or revoked");
      const record = (await read()).get(checked.key.keyId);
      if (record?.owner !== user.address) return error(403, "Use a key from your developer account");
      return partnerApi.handle({ method: "GET", pathname: "/partner/v1/meta", authorization: `Bearer ${body.key}`, ip });
    }
    if (method !== "POST" || !["/keys", "/revoke"].includes(path)) return error(404, "Not found");
    // The registry is on a single gateway's persistent volume. Serialize the
    // limit-check/write pair so concurrent requests cannot exceed the quota.
    const operation = mutations.then(async () => {
      const registry = await read();
      const owned = [...registry.values()].filter(r => r.owner === user.address);
      if (path === "/revoke") {
        const r = registry.get(body.key_id);
        if (!r || r.owner !== user.address) return error(404, "Key not found");
        await write({ ...r, status: "revoked" });
        partners.reload();
        return { status: 200, json: { revoked: true } };
      }
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 48 || /[\x00-\x1f\x7f]/.test(body.name)) return error(400, "App name must contain 1–48 characters");
      if (!await store.rateHit(`dev:issue:${user.address}`, 10, 3600)) return error(429, "Key creation limit reached. Try again in an hour.");
      if (owned.filter(r => r.status === "active").length >= 5) return error(409, "You can have five active keys. Revoke an unused key first.");
      let appId = body.app_id;
      if (appId !== undefined && !owned.some(r => r.appId === appId)) return error(403, "App does not belong to this account");
      if (!appId) appId = `app_${randomBytes(12).toString("hex")}`;
      const minted = makeKey();
      const record = { keyId: minted.keyId, appId, owner: user.address, name: body.name.trim(),
        hash: hashSecret(gatewaySecret, minted.secret), scopes: SCOPES, rpm: 30, status: "active", created_at: new Date(now()).toISOString() };
      await write(record);
      partners.reload();
      return { status: 201, json: { ...publicKey(record), key: minted.key } };
    });
    mutations = operation.then(() => {}, () => {});
    return operation;
  }
  return { async handle(input) {
    try { return await dispatch(input); } catch { return error(503, "Developer service is temporarily unavailable. Try again."); }
  } };
}
