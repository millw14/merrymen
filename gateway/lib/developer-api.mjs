import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "viem";
import { makeKey, hashSecret, loadRegistry, writeRecord } from "./partners.mjs";

const SCOPES = ["read:agents", "write:agents", "chat:agents"];
// Long enough that a smart-contract wallet's proof (a passkey assertion, an
// ERC-6492 wrapper) is refused by name as unsupported rather than as malformed,
// while the whole /verify body, challenge included, fits the 8 KiB cap.
const MAX_SIGNATURE_BYTES = 3000;
const SIGNATURE = new RegExp(`^0x(?:[0-9a-fA-F]{2}){1,${MAX_SIGNATURE_BYTES}}$`);
const same = (a, b) => { const x = Buffer.from(a || ""), y = Buffer.from(b || ""); return x.length === y.length && timingSafeEqual(x, y); };
const publicKey = r => ({ key_id: r.keyId, app_id: r.appId, name: r.name, status: r.status,
  scopes: r.scopes, rate_per_min: r.rpm, created_at: r.created_at, prefix: `mmp_${r.keyId}_` });

/**
 * Only the first-party portal's server may call this wallet-authenticated surface.
 *
 * TWO SECRETS, TWO JOBS. The portal secret is the site's Bearer credential: it
 * proves a request came through merrymen.dev and nothing more. Challenges and
 * sessions are MAC'd with a key only this gateway can derive. They used to be
 * MAC'd with the portal secret itself, so anyone holding the site's environment
 * could mint a session for ANY wallet, then keys under that developer's app_id,
 * then read and chat with that app's users' agents, without the wallet ever
 * signing anything.
 */
export function createDeveloperApi({ portalSecret, gatewaySecret, partners, partnerApi, store,
  verify = verifyMessage, now = Date.now, read = loadRegistry, write = writeRecord }) {
  const boot = randomBytes(16).toString("hex");
  // A subkey, so the gateway secret itself never MACs attacker-shaped data here.
  // The colon keeps it apart from every other HMAC over that secret: holder
  // tokens and nonces MAC base64url (no colon) and partner hashes MAC `mmp:…`.
  const sessionKey = gatewaySecret && Buffer.byteLength(gatewaySecret) >= 32
    ? createHmac("sha256", gatewaySecret).update("merrymen:developer-session:v1").digest() : null;
  const macOf = encoded => createHmac("sha256", sessionKey).update(`developer-v1:${encoded}`).digest("base64url");
  // WHERE A REVOCATION LIVES DECIDES HOW LONG A SESSION MAY. A durable store
  // remembers a logout across restarts, so its sessions survive a deploy. The
  // memory store forgets, so its sessions are bound to this process the way
  // challenges are: a restart signs every developer out, costing one wallet
  // signature, instead of quietly reviving every session signed out before it.
  const epoch = store.durable ? null : boot;
  let mutations = Promise.resolve();
  const sign = (type, data) => {
    const encoded = Buffer.from(JSON.stringify({ ...data, type })).toString("base64url");
    return `${encoded}.${macOf(encoded)}`;
  };
  /** The payload when the MAC and shape are this gateway's. Freshness is the caller's question. */
  const open = (raw, type) => {
    if (typeof raw !== "string" || raw.length > 4096) return null;
    const [encoded, mac, extra] = raw.split(".");
    if (!encoded || !mac || extra !== undefined || !same(mac, macOf(encoded))) return null;
    try {
      const v = JSON.parse(Buffer.from(encoded, "base64url"));
      return v?.type === type && /^0x[0-9a-f]{40}$/.test(v.address) ? v : null;
    } catch { return null; }
  };
  /** A session is its MAC, its expiry, its process (see `epoch`), and the absence of a logout. */
  async function signedIn(raw) {
    const s = open(raw, "session");
    return s && s.expires > now() && s.epoch === epoch && typeof s.sid === "string"
      && !await store.isRevoked(`developer-session:${s.sid}`) ? s : null;
  }
  const message = c => `Sign in to Merrymen Developers\n\nWebsite: https://merrymen.dev/api\nWallet: ${c.address}\n\nManage API keys for your applications. This does not authorize trading or move funds.\n\nNonce: ${c.nonce}\nExpires: ${new Date(c.expires).toISOString()}`;
  // Codes are for the console and for tests; messages are for the person reading.
  const error = (status, code, message) => ({ status, json: { error: { code, message } } });
  /**
   * null when `signature` is `address`'s own key signing `text`; otherwise the refusal.
   *
   * ECDSA ONLY, CHECKED HERE. A smart-contract wallet's signature (ERC-1271, or
   * ERC-6492 before deployment) can only be judged by asking an RPC, and that
   * makes the RPC an authority over EVERY developer account: one that answers
   * "valid" signs anybody in as any address, an ordinary wallet that already owns
   * keys included. A developer account mints partner keys that read and chat with
   * other people's agents, so a smart wallet signs in with a standard wallet's key.
   */
  async function refusal(address, text, signature) {
    if (signature.length !== 132) return error(401, "wallet_unsupported", "Smart-contract wallets cannot sign in to Merrymen Developers. Sign in with a standard wallet (an EOA).");
    try { if (await verify({ address, message: text, signature })) return null; } catch { /* Not this key. */ }
    return error(401, "signature_invalid", "That is not this wallet's signature of the sign-in message. Sign the exact message shown with a standard wallet and paste the result unchanged.");
  }
  // Raw text in, as the partner API takes it, so what a body must look like is
  // this service's rule. `null`, `[]` and `5` are valid JSON that used to reach
  // a property read here and come back as a 503 "temporarily unavailable".
  const parse = raw => {
    if (raw === undefined) return {};
    try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
  };
  async function dispatch({ method, path, authorization, session, body: raw, ip = "unknown" }) {
    if (!portalSecret || Buffer.byteLength(portalSecret) < 32 || !sessionKey) return error(503, "unavailable", "Developer sign-in is temporarily unavailable");
    if (!same(authorization, `Bearer ${portalSecret}`)) return error(401, "unauthorized_portal", "Unauthorized portal");
    if (!await store.rateHit(`dev:ip:${ip}`, 60, 60)) return error(429, "rate_limited", "Too many requests. Try again in a minute.");
    const body = parse(raw);
    if (!body) return error(400, "bad_request", "Invalid request");
    if (method === "POST" && path === "/challenge") {
      if (typeof body.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) return error(400, "invalid_address", "Choose a wallet address");
      const c = { address: body.address.toLowerCase(), nonce: randomBytes(24).toString("hex"), expires: now() + 300_000, boot };
      return { status: 200, json: { challenge: sign("challenge", c), message: message(c) } };
    }
    if (method === "POST" && path === "/verify") {
      // Every refusal here used to read "Sign-in expired", including a perfectly
      // fresh sign-in from a smart-contract wallet. Each now names its cause.
      const c = open(body.challenge, "challenge");
      if (!c) return error(401, "challenge_invalid", "This sign-in request is not valid. Connect your wallet again.");
      // A challenge from before a restart is as stale as an expired one.
      if (!(c.expires > now()) || c.boot !== boot) return error(401, "challenge_expired", "Sign-in expired. Connect your wallet again.");
      if (typeof body.signature !== "string" || !SIGNATURE.test(body.signature)) return error(400, "signature_malformed", "Paste the complete wallet signature, starting with 0x.");
      const refused = await refusal(c.address, message(c), body.signature);
      if (refused) return refused;
      // Spent only after the proof checks out, so a mistyped paste can be retried.
      // A KV outage throws to handle()'s 503 rather than reading as "already used".
      if (!await store.spendNonce(`developer:${c.nonce}`, 301, { throwOnError: true })) return error(401, "signature_used", "This sign-in was already used. Connect your wallet again.");
      return { status: 200, json: { address: c.address, session: sign("session",
        { address: c.address, sid: randomBytes(16).toString("hex"), epoch, expires: now() + 8 * 3600_000 }) } };
    }
    if (method === "POST" && path === "/logout") {
      // Clearing the site's cookie alone left the token valid for its full eight
      // hours to anyone who had copied it. Idempotent: whatever state the token
      // was in, it does not work once this answers 200.
      const s = await signedIn(session);
      if (s) await store.revoke(`developer-session:${s.sid}`, Math.ceil((s.expires - now()) / 1000));
      return { status: 200, json: { signed_out: true } };
    }
    const user = await signedIn(session);
    if (!user) return error(401, "signed_out", "Sign in to manage your API keys");
    if (method === "GET" && path === "/keys") {
      const keys = [...(await read()).values()].filter(r => r.owner === user.address);
      return { status: 200, json: { address: user.address, keys: keys.map(publicKey) } };
    }
    if (method === "POST" && path === "/test") {
      const checked = await partners.verify(body.key);
      if (!checked.ok) return error(401, "invalid_key", "That API key is invalid or revoked");
      const record = (await read()).get(checked.key.keyId);
      if (record?.owner !== user.address) return error(403, "not_your_key", "Use a key from your developer account");
      return partnerApi.handle({ method: "GET", pathname: "/partner/v1/meta", authorization: `Bearer ${body.key}`, ip });
    }
    if (method !== "POST" || !["/keys", "/revoke"].includes(path)) return error(404, "not_found", "Not found");
    // The registry is on a single gateway's persistent volume. Serialize the
    // limit-check/write pair so concurrent requests cannot exceed the quota.
    const operation = mutations.then(async () => {
      const registry = await read();
      const owned = [...registry.values()].filter(r => r.owner === user.address);
      if (path === "/revoke") {
        const r = registry.get(body.key_id);
        if (!r || r.owner !== user.address) return error(404, "key_not_found", "Key not found");
        await write({ ...r, status: "revoked" });
        partners.reload();
        return { status: 200, json: { revoked: true } };
      }
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 48 || /[\x00-\x1f\x7f]/.test(body.name)) return error(400, "invalid_name", "App name must contain 1–48 characters");
      if (!await store.rateHit(`dev:issue:${user.address}`, 10, 3600)) return error(429, "rate_limited", "Key creation limit reached. Try again in an hour.");
      if (owned.filter(r => r.status === "active").length >= 5) return error(409, "key_limit", "You can have five active keys. Revoke an unused key first.");
      let appId = body.app_id;
      if (appId !== undefined && !owned.some(r => r.appId === appId)) return error(403, "app_not_owned", "App does not belong to this account");
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
    try { return await dispatch(input); } catch { return error(503, "unavailable", "Developer service is temporarily unavailable. Try again."); }
  } };
}
