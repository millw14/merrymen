/**
 * Merrymen AI gateway — standalone Node server (Docker / Railway / Fly / a VPS).
 *
 * A long-lived http server that holds the upstream LLM key and exposes an
 * OpenAI-compatible endpoint gated on $MERRYMEN holdings. All the security logic
 * lives in lib/core.mjs (shared with the Vercel functions in api/); this file is
 * just env wiring + http plumbing over it.
 *
 * SAFETY (enforced in lib/core.mjs):
 *  - Upstream key server-only (MERRYMEN_GATEWAY_UPSTREAM_KEY), never logged/sent.
 *  - HMAC-signed expiring tokens; access re-checked against a cached on-chain balance.
 *  - Claim uses a single-use, domain-bound nonce (no replay); no wildcard CORS.
 *  - Per-address rate limit + per-IP claim limit + hard completion clamp + body cap.
 *  - The gateway forces its own model server-side; the client never learns it.
 */
import { createServer } from "node:http";
import { createPublicClient, defineChain, http } from "viem";
import { createGateway, clientIp } from "./lib/core.mjs";
import { createStore, hasRedis } from "./lib/store.mjs";
import { CLAIM_HTML } from "./lib/claimPage.mjs";

// ── config (env) ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8787);
const UPSTREAM_URL = process.env.MERRYMEN_GATEWAY_UPSTREAM || "https://api.groq.com/openai/v1/chat/completions";
const UPSTREAM_KEY = process.env.MERRYMEN_GATEWAY_UPSTREAM_KEY; // REQUIRED — the real key, server-only
const MODEL = process.env.MERRYMEN_GATEWAY_MODEL || "llama-3.3-70b-versatile"; // forced server-side
const SECRET = process.env.MERRYMEN_GATEWAY_SECRET; // REQUIRED — HMAC token-signing secret (32+ random bytes)
const RPC = process.env.MERRYMEN_GATEWAY_RPC; // REQUIRED — Robinhood Chain RPC for balanceOf
const MIN_TOKENS = BigInt(process.env.MERRYMEN_GATEWAY_MIN_TOKENS || "10000"); // whole $MERRYMEN to qualify
const GATEWAY_DOMAIN = process.env.MERRYMEN_GATEWAY_DOMAIN || "merrymen.dev"; // shown in the signed message

// $MERRYMEN — mirrors packages/core/src/token.ts (kept inline; the gateway is standalone).
const TOKEN_ADDRESS = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32";
const CHAIN_ID = 4663;
const MAX_BODY_BYTES = 256 * 1024; // reject oversized chat payloads

for (const [k, v] of Object.entries({ MERRYMEN_GATEWAY_UPSTREAM_KEY: UPSTREAM_KEY, MERRYMEN_GATEWAY_SECRET: SECRET, MERRYMEN_GATEWAY_RPC: RPC })) {
  if (!v) {
    console.error(`[gateway] refusing to start: ${k} is not set (see .env.example).`);
    process.exit(1);
  }
}
if (Buffer.byteLength(SECRET, "utf8") < 32) {
  console.error("[gateway] refusing to start: MERRYMEN_GATEWAY_SECRET is too short — use 32+ random bytes (see .env.example).");
  process.exit(1);
}

const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC) });

const gw = createGateway({
  secret: SECRET,
  upstreamUrl: UPSTREAM_URL,
  upstreamKey: UPSTREAM_KEY,
  model: MODEL,
  domain: GATEWAY_DOMAIN,
  minTokens: MIN_TOKENS,
  tokenAddress: TOKEN_ADDRESS,
  publicClient,
  store: createStore(),
});

// ── http plumbing ────────────────────────────────────────────────────────────
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

// No `access-control-allow-origin`: the claim page is same-origin and the client
// is a server-side (Node) caller exempt from CORS. Withholding ACAO stops a
// phishing page from reading a minted token.
function respond(res, r) {
  if (r.html !== undefined) {
    res.writeHead(r.status, { "content-type": "text/html; charset=utf-8" });
    return res.end(r.html);
  }
  if (r.text !== undefined) {
    res.writeHead(r.status, { "content-type": r.contentType || "application/json" });
    return res.end(r.text);
  }
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(JSON.stringify(r.json ?? {}));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  const ip = clientIp(req.headers["x-forwarded-for"], req.socket?.remoteAddress);

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "GET" && pathname === "/healthz") return respond(res, gw.health());
    if (req.method === "GET" && (pathname === "/" || pathname === "/claim")) return respond(res, gw.serveClaimPage(CLAIM_HTML));
    if (req.method === "GET" && pathname === "/nonce") return respond(res, await gw.nonce({ address: url.searchParams.get("address"), ip }));

    if (req.method === "POST" && pathname === "/claim") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return respond(res, { status: 400, json: { error: "bad request" } });
      }
      return respond(res, await gw.claim({ body, ip }));
    }

    if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
      const auth = req.headers["authorization"] || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return respond(res, { status: 400, json: { error: { message: "bad request body" } } });
      }
      return respond(res, await gw.chat({ token, body, ip }));
    }

    respond(res, { status: 404, json: { error: "not found" } });
  } catch {
    respond(res, { status: 500, json: { error: "internal error" } });
  }
});

server.listen(PORT, () => {
  console.log(`[gateway] Merrymen AI listening on :${PORT} — model forced to "${MODEL}", min hold ${MIN_TOKENS} $MERRYMEN`);
  if (!hasRedis) console.log("[gateway] state store: in-memory (fine for a single process; set KV_REST_API_URL/TOKEN for multi-instance).");
});
