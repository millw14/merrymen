/**
 * Merrymen AI gateway — the holder perk, done safely.
 *
 * WHY THIS EXISTS: you cannot ship your LLM key inside merrymen (it's open
 * source — a key in the client is public and gets abused in hours). Instead you
 * run THIS tiny server. It holds the upstream key server-side and exposes an
 * OpenAI-compatible endpoint. A holder proves they hold $MERRYMEN by signing a
 * message on /  (the claim page); the gateway checks their on-chain balance and
 * issues a signed token. They paste that token into merrymen as the "Merrymen
 * AI" provider. The client never sees the upstream key.
 *
 * SAFETY:
 *  - The upstream key lives only in env (MERRYMEN_GATEWAY_UPSTREAM_KEY), never
 *    logged, never sent to the client.
 *  - Tokens are HMAC-signed (stateless, no DB) and expire; access is re-checked
 *    against a cached on-chain balance so a holder who sells loses access.
 *  - Per-address rate limit + a hard max_tokens clamp + body-size cap bound cost
 *    and abuse. (For multi-instance scale, back the limiter with Redis — noted.)
 *  - The gateway forces its own model server-side, so the client can't run up an
 *    expensive model and never even learns which one it is.
 *
 * No framework — Node http + crypto + viem (for balanceOf and signature verify).
 */

import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, defineChain, erc20Abi, http, isAddress, verifyMessage } from "viem";

// ── config (env) ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8787);
const UPSTREAM_URL = process.env.MERRYMEN_GATEWAY_UPSTREAM || "https://api.groq.com/openai/v1/chat/completions";
const UPSTREAM_KEY = process.env.MERRYMEN_GATEWAY_UPSTREAM_KEY; // REQUIRED — the real key, server-only
const MODEL = process.env.MERRYMEN_GATEWAY_MODEL || "llama-3.3-70b-versatile"; // forced server-side
const SECRET = process.env.MERRYMEN_GATEWAY_SECRET; // REQUIRED — HMAC token-signing secret (32+ random bytes)
const RPC = process.env.MERRYMEN_GATEWAY_RPC; // REQUIRED — Robinhood Chain RPC for balanceOf
const MIN_TOKENS = BigInt(process.env.MERRYMEN_GATEWAY_MIN_TOKENS || "10000"); // whole $MERRYMEN to qualify

// $MERRYMEN — mirrors packages/core/src/token.ts (kept inline; the gateway is standalone).
const TOKEN_ADDRESS = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32";
const DECIMALS = 18n;
const CHAIN_ID = 4663;

// tunables
const TOKEN_TTL_SEC = 7 * 24 * 3600; // issued tokens last a week; re-claim to refresh
const MAX_COMPLETION_TOKENS = 2048; // hard clamp on client-requested max_tokens
const MAX_BODY_BYTES = 256 * 1024; // reject oversized chat payloads
const RATE_PER_MIN = 60; // per-address requests/minute
const BALANCE_TTL_MS = 10 * 60 * 1000; // re-check holdings at most this often

const HERE = path.dirname(fileURLToPath(import.meta.url));

for (const [k, v] of Object.entries({ MERRYMEN_GATEWAY_UPSTREAM_KEY: UPSTREAM_KEY, MERRYMEN_GATEWAY_SECRET: SECRET, MERRYMEN_GATEWAY_RPC: RPC })) {
  if (!v) {
    console.error(`[gateway] refusing to start: ${k} is not set (see .env.example).`);
    process.exit(1);
  }
}
if (SECRET.length < 24) {
  console.error("[gateway] refusing to start: MERRYMEN_GATEWAY_SECRET is too short — use 32+ random bytes.");
  process.exit(1);
}

// ── on-chain holder check (read-only balanceOf, cached) ──────────────────────
const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const balCache = new Map(); // addrLower -> { ok, at }

async function isHolder(addr) {
  const key = addr.toLowerCase();
  const c = balCache.get(key);
  if (c && Date.now() - c.at < BALANCE_TTL_MS) return c.ok;
  let ok = false;
  try {
    const raw = await pub.readContract({ address: TOKEN_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
    ok = raw / 10n ** DECIMALS >= MIN_TOKENS;
  } catch (e) {
    ok = false; // fail closed — never grant access we can't verify
  }
  balCache.set(key, { ok, at: Date.now() });
  return ok;
}

// ── stateless HMAC access tokens ─────────────────────────────────────────────
const sign = (payload) => createHmac("sha256", SECRET).update(payload).digest("base64url");

function issueToken(addr) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const payload = Buffer.from(JSON.stringify({ a: addr.toLowerCase(), exp })).toString("base64url");
  return `mmk_${payload}.${sign(payload)}`;
}

/** Returns the token's address if valid + unexpired, else null. Constant-time mac compare. */
function verifyToken(token) {
  if (typeof token !== "string" || !token.startsWith("mmk_")) return null;
  const [payload, mac] = token.slice(4).split(".");
  if (!payload || !mac) return null;
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { a: addr, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!addr || typeof exp !== "number" || exp * 1000 < Date.now()) return null;
    return addr;
  } catch {
    return null;
  }
}

// The message the claim page asks the holder to sign. Must match claim.html.
export function claimMessage(addr) {
  const day = new Date().toISOString().slice(0, 10);
  return `Merrymen AI — prove you hold $MERRYMEN\nAddress: ${addr}\nDate (UTC): ${day}`;
}

// ── per-address rate limit (in-memory; back with Redis for multi-instance) ───
const buckets = new Map();
function rateOk(addr) {
  const now = Date.now();
  const w = buckets.get(addr) || { n: 0, reset: now + 60_000 };
  if (now > w.reset) {
    w.n = 0;
    w.reset = now + 60_000;
  }
  w.n += 1;
  buckets.set(addr, w);
  return w.n <= RATE_PER_MIN;
}

// ── http helpers ─────────────────────────────────────────────────────────────
function send(res, code, obj, extraHeaders = {}) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, { "content-type": typeof obj === "string" ? "text/html; charset=utf-8" : "application/json", "access-control-allow-origin": "*", ...extraHeaders });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── routes ───────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    return send(res, 204, "", { "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type, authorization" });
  }

  // health
  if (req.method === "GET" && pathname === "/healthz") return send(res, 200, { ok: true });

  // claim page (serve the static signer)
  if (req.method === "GET" && (pathname === "/" || pathname === "/claim")) {
    try {
      return send(res, 200, readFileSync(path.join(HERE, "public", "claim.html"), "utf8"));
    } catch {
      return send(res, 200, "Merrymen AI gateway is running. POST /claim with {address, signature}.");
    }
  }

  // claim: verify a wallet signature + holdings, issue a token
  if (req.method === "POST" && pathname === "/claim") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: "bad request" });
    }
    const address = typeof body.address === "string" ? body.address.trim() : "";
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";
    if (!isAddress(address) || !signature.startsWith("0x")) return send(res, 400, { error: "address and signature required" });
    let valid = false;
    try {
      valid = await verifyMessage({ address, message: claimMessage(address), signature });
    } catch {
      valid = false;
    }
    if (!valid) return send(res, 401, { error: "signature didn't verify — sign today's exact message with this wallet" });
    if (!(await isHolder(address))) {
      return send(res, 403, { error: `this wallet doesn't hold at least ${MIN_TOKENS} $MERRYMEN — join the Circle, then claim.` });
    }
    balCache.set(address.toLowerCase(), { ok: true, at: Date.now() }); // fresh
    return send(res, 200, { token: issueToken(address), expiresInDays: TOKEN_TTL_SEC / 86400, model: "merrymen-fast" });
  }

  // the OpenAI-compatible endpoint the merrymen client calls
  if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const addr = verifyToken(token);
    if (!addr) return send(res, 401, { error: { message: "invalid or expired Merrymen AI token — re-claim at /claim" } });
    if (!rateOk(addr)) return send(res, 429, { error: { message: "rate limit — slow down (holder quota)" } });
    if (!(await isHolder(addr))) return send(res, 403, { error: { message: "this wallet no longer meets the $MERRYMEN holding requirement" } });

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: { message: "bad request body" } });
    }
    // Force our model + clamp cost; never trust the client's model/limits.
    payload.model = MODEL;
    payload.stream = false;
    if (typeof payload.max_tokens !== "number" || payload.max_tokens > MAX_COMPLETION_TOKENS) payload.max_tokens = MAX_COMPLETION_TOKENS;

    try {
      const upstream = await fetch(UPSTREAM_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${UPSTREAM_KEY}` },
        body: JSON.stringify(payload),
      });
      const text = await upstream.text();
      // Pass the model name back as our brand, not the upstream's, if present.
      res.writeHead(upstream.status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(text.replace(new RegExp(`"model"\\s*:\\s*"${MODEL}"`, "g"), '"model":"merrymen-fast"'));
    } catch (e) {
      return send(res, 502, { error: { message: "upstream unavailable" } });
    }
    return;
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`[gateway] Merrymen AI listening on :${PORT} — model forced to "${MODEL}", min hold ${MIN_TOKENS} $MERRYMEN`);
});
