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
import { addSignup, signupCount } from "./lib/signups.mjs";

// ── config (env) ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8787);
const UPSTREAM_URL = process.env.MERRYMEN_GATEWAY_UPSTREAM || "https://api.groq.com/openai/v1/chat/completions";
const UPSTREAM_KEY = process.env.MERRYMEN_GATEWAY_UPSTREAM_KEY; // REQUIRED — the real key, server-only
const BITQUERY_KEY = process.env.MERRYMEN_GATEWAY_BITQUERY_KEY; // optional — enables /bitquery for holders
// FORCED SERVER-SIDE, and it must be a model that still exists. Groq retired
// the whole Llama 3.x chat line; see packages/core/src/llm-providers.ts for
// the trace. That fix landed for the groq provider and missed this file, so
// every completion through the merrymen provider 404'd — chat answered
// nothing and the strategist silently proposed nothing, for weeks.
// Pinned against SETTINGS_DEFAULTS.groqModel by packages/core/src/gateway-model.test.ts.
const MODEL = process.env.MERRYMEN_GATEWAY_MODEL || "qwen/qwen3.8-27b";
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

// Hoisted rather than inlined into createGateway: the signup route needs the
// same rate limiter, and two stores would mean two independent counters.
const store = createStore();

const gw = createGateway({
  secret: SECRET,
  bitqueryKey: BITQUERY_KEY,
  upstreamUrl: UPSTREAM_URL,
  upstreamKey: UPSTREAM_KEY,
  model: MODEL,
  domain: GATEWAY_DOMAIN,
  minTokens: MIN_TOKENS,
  tokenAddress: TOKEN_ADDRESS,
  publicClient,
  store,
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

// CORS is OFF by default and stays off. The claim page is same-origin and the
// merrymen client is a server-side (Node) caller exempt from CORS, so no route
// needs ACAO to work — while withholding it is what stops a phishing page from
// minting a token in a victim's browser and reading it back.
//
// A handler opts in per-response with `cors: true`, and exactly one does:
// /memescope, which returns public pool data, requires no token, and has to be
// readable from the marketing site's origin. Never widen this to a blanket
// header — the value of the default is that it applies to everything holding a
// credential.
/**
 * Origins allowed to POST personal data to this gateway.
 *
 * A wildcard is fine for /memescope, which is a public GET returning market data
 * that reveals nobody. It is NOT fine for the signup route: `*` would let any
 * page on the internet drive the form, so a phishing clone could collect
 * addresses into YOUR list and point at the real endpoint to look legitimate.
 * Named origins only, and the browser enforces it.
 */
const SIGNUP_ORIGINS = new Set([
  "https://merrymen.dev",
  "https://www.merrymen.dev",
  "http://localhost:3000",
  "http://localhost:3999",
]);

function signupCorsHeaders(origin) {
  if (!origin || !SIGNUP_ORIGINS.has(origin)) return undefined;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function respond(res, r) {
  const cors = r.corsHeaders ?? (r.cors ? { "access-control-allow-origin": "*" } : undefined);
  if (r.html !== undefined) {
    res.writeHead(r.status, { "content-type": "text/html; charset=utf-8", ...cors });
    return res.end(r.html);
  }
  if (r.text !== undefined) {
    res.writeHead(r.status, { "content-type": r.contentType || "application/json", ...cors });
    return res.end(r.text);
  }
  res.writeHead(r.status, { "content-type": "application/json", ...cors });
  res.end(JSON.stringify(r.json ?? {}));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  const ip = clientIp(req.headers["x-forwarded-for"], req.socket?.remoteAddress);

  try {
    // Blanket preflight answer, with NO cors headers — which is what makes every
    // other route uncallable from a page. /ios-beta is the one route that must
    // answer a real preflight, so it is excluded here and handles its own below.
    // Without this exclusion the browser gets a 204 carrying no
    // access-control-allow-origin and blocks the POST it was checking.
    if (req.method === "OPTIONS" && pathname !== "/ios-beta") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "GET" && pathname === "/healthz") return respond(res, gw.health());
    if (req.method === "GET" && (pathname === "/" || pathname === "/claim")) return respond(res, gw.serveClaimPage(CLAIM_HTML));
    if (req.method === "GET" && pathname === "/nonce") return respond(res, await gw.nonce({ address: url.searchParams.get("address"), ip }));
    // The list every OpenAI-compatible client asks for before it will show a
    // model picker. Without it the catch-all below answered 404 and merrymen's
    // own settings page blamed the user's key.
    if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) return respond(res, gw.models());

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

    // Discovery. Same holder token as the brain; a named query, never raw
    // GraphQL — see the catalogue in lib/core.mjs for why.
    if (req.method === "POST" && pathname === "/bitquery") {
      const auth = req.headers["authorization"] || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return respond(res, { status: 400, json: { error: "bad request body" } });
      }
      return respond(res, await gw.bitquery({ token, body, ip }));
    }
    // So a client can discover what this gateway will answer without guessing.
    if (req.method === "GET" && pathname === "/bitquery") {
      return respond(res, { status: 200, json: { queries: gw.bitqueryQueries() } });
    }

    // The PUBLIC scope — no token, readable cross-origin by the website. It is
    // affordable only because every caller shares one cached answer; see the
    // cost note on memescope() in lib/core.mjs before changing anything here.
    if (req.method === "GET" && pathname === "/memescope") {
      const r = await gw.memescope({ ip });
      return respond(res, { ...r, cors: true });
    }

    /**
     * The iOS beta waiting list.
     *
     * The ONLY route on this gateway that accepts personal data, and the only
     * one whose CORS is a named-origin allowlist rather than absent or `*`.
     *
     * Deliberately unauthenticated: it is a public sign-up form, so there is no
     * session to forge and CSRF is meaningless. What it does need is abuse
     * control, which is the rate limit below plus a honeypot — a real person
     * never fills a field they cannot see.
     */
    if (pathname === "/ios-beta") {
      const corsHeaders = signupCorsHeaders(req.headers.origin);

      // Preflight. A cross-origin JSON POST always sends one.
      if (req.method === "OPTIONS") {
        return respond(res, { status: corsHeaders ? 204 : 403, json: {}, corsHeaders });
      }

      if (req.method === "GET") {
        // A count reveals nobody and lets the page say "join N others".
        return respond(res, { status: 200, json: { count: await signupCount() }, corsHeaders });
      }

      if (req.method === "POST") {
        // Ten attempts an hour per address is far above any honest use and far
        // below what makes this endpoint worth abusing. Fails OPEN on a store
        // blip — a rate-limiter outage must not silently eat real signups.
        if (!(await store.rateHit(`ios:${ip}`, 10, 3600))) {
          return respond(res, { status: 429, json: { error: "too many attempts — try again later" }, corsHeaders });
        }

        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return respond(res, { status: 400, json: { error: "bad body" }, corsHeaders });
        }

        // Honeypot: a hidden field no human can see or fill. Accept the request
        // so the bot learns nothing, and write nothing.
        if (typeof body?.company === "string" && body.company.trim() !== "") {
          return respond(res, { status: 200, json: { ok: true, already: true }, corsHeaders });
        }

        const r = await addSignup({ email: body?.email, platform: "ios" });
        if (!r.ok) return respond(res, { status: 400, json: { error: r.reason }, corsHeaders });
        return respond(res, { status: 200, json: { ok: true, already: r.already, count: r.count }, corsHeaders });
      }

      return respond(res, { status: 405, json: { error: "method not allowed" }, corsHeaders });
    }

    respond(res, { status: 404, json: { error: "not found" } });
  } catch {
    respond(res, { status: 500, json: { error: "internal error" } });
  }
});

server.listen(PORT, () => {
  console.log(`[gateway] Merrymen AI listening on :${PORT} — model forced to "${MODEL}", min hold ${MIN_TOKENS} $MERRYMEN`);
  console.log(`[gateway] discovery: ${BITQUERY_KEY ? "Bitquery ON (named queries only)" : "Bitquery OFF (no key set)"}`);
  if (!hasRedis) console.log("[gateway] state store: in-memory (fine for a single process; set KV_REST_API_URL/TOKEN for multi-instance).");
});
