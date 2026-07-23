/**
 * Vercel wiring: build the shared gateway once per warm isolate from the project
 * env, backed by the KV store (see store.mjs). The api/* functions are thin
 * adapters over this. Config errors surface as a 500 with a clear message so a
 * half-set-up deployment tells the operator exactly which env var is missing.
 */
import { createPublicClient, defineChain, http } from "viem";
import { createGateway, clientIp } from "./core.mjs";
import { createStore, hasRedis } from "./store.mjs";

const TOKEN_ADDRESS = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32"; // $MERRYMEN
const CHAIN_ID = 4663; // Robinhood Chain

let _gw = null;
export function getGateway() {
  if (_gw) return _gw;
  const UPSTREAM_KEY = process.env.MERRYMEN_GATEWAY_UPSTREAM_KEY;
  const SECRET = process.env.MERRYMEN_GATEWAY_SECRET;
  const RPC = process.env.MERRYMEN_GATEWAY_RPC;
  const missing = Object.entries({ MERRYMEN_GATEWAY_UPSTREAM_KEY: UPSTREAM_KEY, MERRYMEN_GATEWAY_SECRET: SECRET, MERRYMEN_GATEWAY_RPC: RPC })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`gateway misconfigured: set ${missing.join(", ")} in the Vercel project env`);
  if (Buffer.byteLength(SECRET, "utf8") < 32) throw new Error("gateway misconfigured: MERRYMEN_GATEWAY_SECRET must be >= 32 bytes");
  if (!hasRedis) throw new Error("gateway misconfigured: a KV store is required on serverless — add Upstash/Vercel KV (KV_REST_API_URL + KV_REST_API_TOKEN)");

  const chain = defineChain({
    id: CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  _gw = createGateway({
    secret: SECRET,
    upstreamUrl: process.env.MERRYMEN_GATEWAY_UPSTREAM || "https://api.groq.com/openai/v1/chat/completions",
    upstreamKey: UPSTREAM_KEY,
    model: process.env.MERRYMEN_GATEWAY_MODEL || "llama-3.3-70b-versatile",
    domain: process.env.MERRYMEN_GATEWAY_DOMAIN || "merrymen.dev",
    minTokens: BigInt(process.env.MERRYMEN_GATEWAY_MIN_TOKENS || "10000"),
    tokenAddress: TOKEN_ADDRESS,
    publicClient: createPublicClient({ chain, transport: http(RPC) }),
    store: createStore(),
  });
  return _gw;
}

/** Normalize the request body to an object (Vercel usually parses JSON already). */
export function jsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

/** Write a core handler result ({status, json|html|text}) to a Vercel response.
 * No `access-control-allow-origin` anywhere — a phishing page must not be able to
 * read a minted token. */
export function sendResult(res, r) {
  if (r.html !== undefined) {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.statusCode = r.status;
    return res.end(r.html);
  }
  if (r.text !== undefined) {
    res.setHeader("content-type", r.contentType || "application/json");
    res.statusCode = r.status;
    return res.end(r.text);
  }
  res.setHeader("content-type", "application/json");
  res.statusCode = r.status;
  res.end(JSON.stringify(r.json ?? {}));
}

export function fail(res, e) {
  res.setHeader("content-type", "application/json");
  res.statusCode = 500;
  res.end(JSON.stringify({ error: { message: String((e && e.message) || e) } }));
}

export { clientIp };
