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
import { createPartners } from "./lib/partners.mjs";
import { createPartnerApi, partnerError } from "./lib/partner-api.mjs";
import { createPartnerBridge } from "./lib/partner-bridge.mjs";
import { createDeveloperApi } from "./lib/developer-api.mjs";
import { createBilling, createPaymentsClient, parseBillingConfig } from "./lib/billing.mjs";

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
/**
 * An oversized upload is refused, not cut off. This used to destroy the socket
 * on the first byte over the cap, before any handler could answer, so every
 * documented 413 arrived as a connection reset that a caller cannot tell from
 * an outage. Past the cap nothing is buffered: the rest is read and discarded
 * while the refusal goes out, up to a ceiling past which nobody is owed one.
 */
const DRAIN_LIMIT_BYTES = 16 * MAX_BODY_BYTES;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > DRAIN_LIMIT_BYTES) return req.destroy();
      if (size > MAX_BODY_BYTES) return reject(new Error("payload too large"));
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
  // `headers` come from the partner API alone: a relayed Retry-After, and the
  // quota headers on a metered answer.
  res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store", ...r.headers, ...cors });
  res.end(JSON.stringify(r.json ?? {}));
}

// ── the partner API ─────────────────────────────────────────────────────────
//
// A SECOND credential system on the same host, sharing only the rate-limit
// store. It reuses MERRYMEN_GATEWAY_SECRET as an HMAC PEPPER over per-key
// secrets rather than as the key material itself, so revoking one partner does
// not invalidate every holder token at the same time.
//
// BILLING: MERRYMEN-paid plans for that API (lib/billing.mjs). OFF unless every
// requirement holds, an explicit MERRYMEN_DATA_DIR on a persistent volume among
// them; each reason it is not on is a [billing] line here at boot. Its ledger
// is the only record of who paid, so it is built ONCE and shared by the
// partner gate (metering) and the developer API (accounts, plans, payments): a
// second instance would keep a second index and credit one transfer twice. Its
// chain client is its own, read-only, and asked about payments alone; the
// holder gate's client above is not touched.
const billingConfig = parseBillingConfig(process.env);
for (const note of billingConfig.notes) console.error(`[billing] ${note}`);
const billing = await createBilling({ ...billingConfig,
  publicClient: billingConfig.rpc ? createPaymentsClient(billingConfig.rpc) : null });
{
  // Said at every boot, before "listening", so the deploy log shows a degraded
  // mode rather than a developer's 503 or a partner's missing quota headers.
  const asked = JSON.stringify(billingConfig.requested.slice(0, 20));
  const on = billing.mode !== "off";
  const degraded = billing.mode !== billingConfig.requested || (on && !billing.paymentsReady) || !!billing.blocked;
  (degraded ? console.error : console.log)(`[gateway] partner billing: ${billing.mode}`
    + (billing.mode !== billingConfig.requested ? ` (MERRYMEN_BILLING=${asked}; see the [billing] lines above)` : "")
    + (!on ? ", nothing is metered"
      : `, ${billing.enforced ? "quotas enforced" : "metered, never refused"}; payments ${billing.paymentsReady ? `to ${billingConfig.treasury}` : "UNAVAILABLE"}`)
    + (billing.blocked ? `; ledger writes REFUSED (${billing.blocked})` : ""));
}

const partners = createPartners({ secret: SECRET });
const partnerApi = createPartnerApi({ partners, store, billing,
  forward: createPartnerBridge({ secret: process.env.MERRYMEN_PARTNER_BRIDGE_SECRET,
    origin: process.env.MERRYMEN_PARTNER_APP_ORIGIN || "https://app.merrymen.dev" }),
});
// No chain client for sign-in, deliberately: developer sign-in is checked
// locally, so no RPC can vouch for a signature (see refusal() in
// lib/developer-api.mjs). Billing's client checks payment transfers and nothing else.
const developerApi = createDeveloperApi({ portalSecret: process.env.MERRYMEN_DEVELOPER_PORTAL_SECRET,
  gatewaySecret: SECRET, partners, partnerApi, store, billing });

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
    if (pathname.startsWith("/developer/v1/")) {
      // Size is plumbing; shape is the developer API's rule, so it gets raw text.
      let body;
      if (req.method === "POST") {
        try { body = await readBody(req); } catch { body = null; }
        if (body === null || Buffer.byteLength(body) > 8192) return respond(res, { status: 413, json: { error: { code: "request_too_large", message: "Request too large" } } });
      }
      return respond(res, await developerApi.handle({ method: req.method, path: pathname.slice("/developer/v1".length),
        authorization: req.headers.authorization, session: req.headers["x-developer-session"], body,
        ip: req.headers["x-developer-ip"] || ip }));
    }
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

    // Partner routes carry their OWN error envelope, so they are matched before
    // the catch-all rather than falling through to the holder-shaped 404.
    if (partnerApi.owns(pathname)) {
      let body = "";
      if (req.method === "POST") {
        // partnerError, like every other partner refusal: a report needs its request_id.
        try { body = await readBody(req); }
        catch { return respond(res, partnerError(413, "bad_request", "Request body is too large")); }
      }
      const r = await partnerApi.handle({
        method: req.method,
        pathname,
        authorization: req.headers.authorization,
        ip,
        body,
      });
      if (r) return respond(res, r);
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
  // Optional services, so not fatal, but say so at boot: otherwise the first
  // sign of a missing secret is a partner's or developer's 503.
  for (const [name, routes] of [["MERRYMEN_PARTNER_BRIDGE_SECRET", "partner agent routes"], ["MERRYMEN_DEVELOPER_PORTAL_SECRET", "developer portal routes"]]) {
    if (Buffer.byteLength(process.env[name] || "") < 32) console.error(`[gateway] ${name} is unset or under 32 bytes: ${routes} will answer 503.`);
  }
});

/**
 * A deploy (SIGTERM) or Ctrl-C (SIGINT) saves the partner usage counts before
 * the process goes. usage.json is otherwise written every 10 s, so every deploy
 * would drop up to that much metering. New connections stop at once; requests
 * already inside get up to 3 s to finish, so their answers reach the partner
 * and what they counted, or gave back on a platform failure, is in what is
 * saved (one still running after that is cut off, as it always was). Then
 * queued billing writes finish (5 s at most, lib/billing.mjs close()). The
 * ledger itself needs nothing here: each record is flushed by the append that
 * made it. A second signal exits at once, and so does a close still hanging
 * after 10 s, rather than waiting for the host's SIGKILL. The host must allow
 * that long between SIGTERM and SIGKILL for the save to land; otherwise a
 * deploy loses what a crash would.
 */
const DRAIN_MS = 3_000;
let stopping = false;
async function stop(signal) {
  if (stopping) process.exit(1);
  stopping = true;
  console.log(`[gateway] ${signal}: saving usage counts, then exiting`);
  setTimeout(() => process.exit(1), 10_000).unref();
  const drained = new Promise((resolve) => server.close(() => resolve()));
  // A kept-alive connection goes idle once its answer is out, and would hold
  // the close open for the whole 3 s: close each as it does.
  server.closeIdleConnections();
  const sweep = setInterval(() => server.closeIdleConnections(), 50);
  await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, DRAIN_MS))]);
  clearInterval(sweep);
  await billing.close();
  process.exit(0);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
