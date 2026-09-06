/**
 * Merrymen AI gateway — SHARED CORE (runtime-agnostic).
 *
 * All the security-critical logic lives here exactly once: HMAC access tokens,
 * single-use domain-bound claim nonces, the on-chain holder check, the cost
 * clamp, and the route handlers. Both runtimes are thin adapters over this:
 *   - server.mjs        → a long-lived Node http server (Docker / Railway / VPS)
 *   - api/*.js          → Vercel serverless functions
 * Each handler returns a plain { status, json | html | text } — the adapter just
 * writes it. State (nonces, rate limits, balance cache) comes from an injected
 * `store` (in-memory for one process; Redis/KV for serverless — see store.mjs).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { erc20Abi, isAddress, verifyMessage } from "viem";

export const DEFAULTS = {
  TOKEN_TTL_SEC: 7 * 24 * 3600, // issued tokens last a week; re-claim to refresh
  NONCE_TTL_SEC: 5 * 60, // a claim nonce must be signed + spent within 5 min
  MAX_COMPLETION_TOKENS: 2048, // hard clamp on client-requested output length
  RATE_PER_MIN: 60, // per-address on /v1, per-IP on /nonce + /claim
  BALANCE_TTL_SEC: 10 * 60, // re-check holdings at most this often
  // Discovery is polled by a worker on a timer, not driven by a human typing, so
  // it gets its OWN tighter bucket. Sharing the chat allowance would let a
  // background poll quietly starve the brain the same holder is paying for.
  BITQUERY_RATE_PER_MIN: 6,
  // How long the PUBLIC memescope is served from one shared answer. This number
  // is the whole cost model of that route: the upstream is hit at most once per
  // this many seconds no matter how many people are watching, so traffic and
  // spend are decoupled. Lower it and you are buying freshness with the
  // operator's own Bitquery allowance.
  MEMESCOPE_TTL_SEC: 45,
  // Per-IP cap on the public route. This protects the gateway PROCESS, not the
  // bill — the bill is already bounded by the shared cache above.
  MEMESCOPE_RATE_PER_MIN: 30,
};

/**
 * Sides of a pair that mean "cash", so the other side is the launch.
 * Mirrors CASH_SIDE in worker/src/discovery.ts — same rule, different runtime.
 */
const CASH_SIDE = new Set([
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // WETH
  "0x0000000000000000000000000000000000000000",
]);

/**
 * A contract-reported symbol, made safe to render.
 *
 * Mirrors sanitizeSymbol in worker/src/discovery.ts. A token name is attacker
 * chosen — it is whatever someone put in their own contract — so it reaches a
 * web page stripped to a known alphabet and hard length-capped, never as
 * arbitrary text. React escapes HTML on its own; this also strips the RTL marks
 * and zero-width characters that let a name disguise itself as another token.
 */
export function sanitizeSymbol(raw) {
  if (typeof raw !== "string") return "?";
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 16);
  return cleaned.length > 0 ? cleaned : "?";
}

/**
 * One Bitquery `Initialize` event → {token, quote, createdAt, txHash}, or null.
 * Ported from parsePoolEvent in worker/src/venues/bitquery.ts; exported so the
 * gateway's own tests can pin the shape third-party JSON has to arrive in.
 */
export function parseInitializeEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  const addrs = [];
  for (const a of ev.Arguments ?? []) {
    const v = a?.Value?.address;
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) addrs.push(v.toLowerCase());
  }
  if (addrs.length < 2) return null;
  const time = ev.Block?.Time ? Math.floor(new Date(ev.Block.Time).getTime() / 1000) : 0;
  if (!Number.isFinite(time) || time <= 0) return null;
  const [a, b] = addrs;
  const aCash = CASH_SIDE.has(a);
  const bCash = CASH_SIDE.has(b);
  // Both cash, or neither, is not a launch — nothing to scope.
  if (aCash === bCash) return null;
  return {
    token: aCash ? b : a,
    quote: aCash ? a : b,
    createdAt: time,
    txHash: typeof ev.Transaction?.Hash === "string" ? ev.Transaction.Hash : "",
  };
}

/** Clamp a client-supplied integer into a server-decided range. */
export function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Best-effort client IP: first X-Forwarded-For hop, else the socket peer. */
export function clientIp(xff, remote) {
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return remote || "unknown";
}

/**
 * The right auth header for whichever Bitquery credential the operator set.
 *
 * Bitquery has two credential types and two eras of endpoint. The legacy V1 API
 * key goes in `X-API-KEY`; the V2 OAuth access token (`ory_at_…`, issued from
 * Authorization → Applications) goes in `Authorization: Bearer`. Sending BOTH
 * headers with the same value — which this did — is fine for a V1 key but hands
 * a V2 endpoint two conflicting credentials and invites exactly the opaque 402
 * we spent a deploy chasing. Send one, chosen by what the value actually is.
 */
export function bitqueryAuthHeaders(key) {
  return String(key).startsWith("ory_at_")
    ? { authorization: `Bearer ${key}` }
    : { "X-API-KEY": key };
}

export function createGateway(cfg) {
  const {
    secret,
    upstreamUrl,
    upstreamKey,
    /** Bitquery key — optional. Absent = the /bitquery route reports 503, and
     * the rest of the gateway works exactly as before. */
    bitqueryKey,
    bitqueryUrl = "https://streaming.bitquery.io/graphql",
    model,
    brandModel = "merrymen-fast",
    domain,
    minTokens,
    tokenAddress,
    decimals = 18n,
    publicClient,
    store,
    tunables = {},
  } = cfg;
  const T = { ...DEFAULTS, ...tunables };

  // ── HMAC access tokens ─────────────────────────────────────────────────────
  const sign = (payload) => createHmac("sha256", secret).update(payload).digest("base64url");

  const issueToken = (addr) => {
    const exp = Math.floor(Date.now() / 1000) + T.TOKEN_TTL_SEC;
    const payload = Buffer.from(JSON.stringify({ a: addr.toLowerCase(), exp })).toString("base64url");
    return `mmk_${payload}.${sign(payload)}`;
  };

  /** Returns the token's address if valid + unexpired, else null. Constant-time mac. */
  const verifyToken = (token) => {
    if (typeof token !== "string" || !token.startsWith("mmk_")) return null;
    const [payload, mac] = token.slice(4).split(".");
    if (!payload || !mac) return null;
    const a = Buffer.from(mac);
    const b = Buffer.from(sign(payload));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const { a: addr, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (!addr || typeof exp !== "number" || exp * 1000 < Date.now()) return null;
      return addr;
    } catch {
      return null;
    }
  };

  // ── single-use, domain-bound claim nonces ──────────────────────────────────
  const issueNonce = (addr) => {
    const exp = Math.floor(Date.now() / 1000) + T.NONCE_TTL_SEC;
    const payload = Buffer.from(
      JSON.stringify({ a: addr.toLowerCase(), exp, r: randomBytes(12).toString("base64url") }),
    ).toString("base64url");
    return `${payload}.${sign(payload)}`;
  };

  /** True if the nonce is authentic, unexpired, and bound to `addr`. Does NOT check
   * replay — that's enforced atomically by store.spendNonce at claim time. */
  const verifyNonceAuthentic = (token, addr) => {
    if (typeof token !== "string" || !token.includes(".")) return false;
    const [payload, mac] = token.split(".");
    if (!payload || !mac) return false;
    const a = Buffer.from(mac);
    const b = Buffer.from(sign(payload));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    let d;
    try {
      d = JSON.parse(Buffer.from(payload, "base64url").toString());
    } catch {
      return false;
    }
    if (!d.a || typeof d.exp !== "number" || d.exp * 1000 < Date.now()) return false;
    return d.a === addr.toLowerCase();
  };

  // The exact message a holder signs — names the domain + the server nonce so a
  // wallet shows real context and the signature can't be replayed.
  const claimMessage = (addr, nonce) =>
    [
      `Merrymen AI — prove you hold $MERRYMEN`,
      `Domain: ${domain}`,
      `Address: ${addr}`,
      `Nonce: ${nonce}`,
      `This signature is free, read-only, and cannot move funds or approve spending.`,
    ].join("\n");

  // ── on-chain holder check (cached) ─────────────────────────────────────────
  async function isHolder(addr) {
    const key = addr.toLowerCase();
    const cached = await store.getBal(key);
    if (cached !== null) return cached;
    let ok = false;
    try {
      const raw = await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
      ok = raw / 10n ** decimals >= minTokens;
    } catch {
      ok = false; // fail closed — never grant access we can't verify
    }
    await store.setBal(key, ok, T.BALANCE_TTL_SEC);
    return ok;
  }

  // ── cost clamp: never trust the client's model/limits ──────────────────────
  function clampPayload(payload) {
    payload.model = model;
    payload.stream = false;
    if (typeof payload.max_tokens !== "number" || payload.max_tokens > T.MAX_COMPLETION_TOKENS) payload.max_tokens = T.MAX_COMPLETION_TOKENS;
    // max_tokens alone doesn't bound cost: n/best_of fan out N completions per
    // request, and newer models honor max_completion_tokens. Pin them all.
    payload.n = 1;
    delete payload.best_of;
    if (typeof payload.max_completion_tokens === "number" && payload.max_completion_tokens > T.MAX_COMPLETION_TOKENS) {
      payload.max_completion_tokens = T.MAX_COMPLETION_TOKENS;
    }
    return payload;
  }

  // ── route handlers (return { status, json | html | text }) ─────────────────
  const health = () => ({ status: 200, json: { ok: true } });

  async function nonce({ address, ip }) {
    if (!(await store.rateHit(`claim:${ip}`, T.RATE_PER_MIN, 60))) return { status: 429, json: { error: "slow down — too many claim attempts" } };
    const addr = typeof address === "string" ? address.trim() : "";
    if (!isAddress(addr)) return { status: 400, json: { error: "valid ?address= required" } };
    const n = issueNonce(addr);
    return { status: 200, json: { nonce: n, message: claimMessage(addr, n), expiresInSec: T.NONCE_TTL_SEC } };
  }

  async function claim({ body, ip }) {
    if (!(await store.rateHit(`claim:${ip}`, T.RATE_PER_MIN, 60))) return { status: 429, json: { error: "slow down — too many claim attempts" } };
    const address = typeof body?.address === "string" ? body.address.trim() : "";
    const signature = typeof body?.signature === "string" ? body.signature.trim() : "";
    const nonceTok = typeof body?.nonce === "string" ? body.nonce.trim() : "";
    if (!isAddress(address) || !signature.startsWith("0x") || !nonceTok) {
      return { status: 400, json: { error: "address, signature and nonce required — GET /nonce first" } };
    }
    if (!verifyNonceAuthentic(nonceTok, address)) {
      return { status: 401, json: { error: "nonce invalid, expired, or already used — refresh the page and sign again" } };
    }
    let valid = false;
    try {
      valid = await verifyMessage({ address, message: claimMessage(address, nonceTok), signature });
    } catch {
      valid = false;
    }
    if (!valid) return { status: 401, json: { error: "signature didn't verify — sign the exact message shown, with this wallet" } };
    // Atomic single-use: the FIRST spend wins; a replay (or concurrent dup) fails.
    if (!(await store.spendNonce(nonceTok, T.NONCE_TTL_SEC))) {
      return { status: 401, json: { error: "nonce already used — refresh the page and sign again" } };
    }
    if (!(await isHolder(address))) {
      return { status: 403, json: { error: `this wallet doesn't hold at least ${minTokens} $MERRYMEN — join the Circle, then claim.` } };
    }
    await store.setBal(address.toLowerCase(), true, T.BALANCE_TTL_SEC);
    return { status: 200, json: { token: issueToken(address), expiresInDays: T.TOKEN_TTL_SEC / 86400, model: brandModel } };
  }

  /**
   * The one model this gateway will ever use, as a list.
   *
   * Not a menu — a fact. `clampPayload` forces `model` server-side, which is
   * the whole point of the proxy, so a client cannot pick anything else. This
   * exists only because every OpenAI-compatible client asks: merrymen's own
   * settings page fetches `<baseUrl>/models` for any openai-transport provider,
   * got the catch-all 404, and printed "Could not load AI models. Check your
   * provider and key" beside a key that was perfectly good. Two testers
   * reported it as a broken key.
   *
   * Unauthenticated on purpose. It discloses the brand name a caller must send
   * back, which is already in llm-providers.ts and on the claim page.
   */
  function models() {
    return {
      status: 200,
      json: { object: "list", data: [{ id: brandModel, object: "model", owned_by: "merrymen" }] },
    };
  }

  async function chat({ token, body, ip }) {
    const addr = verifyToken(token);
    if (!addr) return { status: 401, json: { error: { message: "invalid or expired Merrymen AI token — re-claim at /claim" } } };
    if (!(await store.rateHit(addr, T.RATE_PER_MIN, 60))) return { status: 429, json: { error: { message: "rate limit — slow down (holder quota)" } } };
    if (!(await isHolder(addr))) return { status: 403, json: { error: { message: "this wallet no longer meets the $MERRYMEN holding requirement" } } };
    if (!body || typeof body !== "object") return { status: 400, json: { error: { message: "bad request body" } } };
    clampPayload(body);
    try {
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${upstreamKey}` },
        body: JSON.stringify(body),
      });
      const raw = await upstream.text();
      // THE BRAND SUBSTITUTION HAS TO COVER FAILURES TOO.
      //
      // This matched only `"model":"<upstream>"`, which is the shape of a
      // SUCCESS body. An upstream error names the model in prose instead —
      // "The model `<id>` does not exist" — so for the whole time the forced
      // model was dead, every caller was told the upstream model id in an
      // error string. That is the one fact this proxy exists to withhold,
      // leaking on exactly the path nobody tests.
      //
      // Replace the name wherever it appears, in any body, on any status. The
      // status itself passes through untouched: the strategist has to be able
      // to tell 429 from 404, or it retries a permanent failure forever.
      const text = raw
        .replace(new RegExp(`"model"\\s*:\\s*"${model}"`, "g"), `"model":"${brandModel}"`)
        .split(model)
        .join(brandModel);
      return { status: upstream.status, text, contentType: "application/json" };
    } catch {
      return { status: 502, json: { error: { message: "upstream unavailable" } } };
    }
  }

  /**
   * Bitquery, for holders — the same perk shape as the brain, one hard lesson
   * applied on top.
   *
   * DO NOT PROXY ARBITRARY GRAPHQL. Bitquery bills by query cost, and GraphQL is
   * unbounded by construction: one caller asking for every event since genesis,
   * unfiltered, is a five-figure invoice and a blank cheque written against the
   * operator's account. `max_tokens` was enough to bound the LLM route; there is
   * no equivalent knob here, because the expensive part is the query itself.
   *
   * So the client does not send a query. It sends a NAME, and the gateway owns
   * the GraphQL. The catalogue below is the entire attack surface: every query
   * is written here, every variable is clamped here, and a caller can ask for
   * nothing that isn't in it. Adding a capability is a deliberate act by whoever
   * runs the gateway, not something a client can reach for.
   */
  const BITQUERY_QUERIES = {
    /** Pools initialized recently — v3 factories and the v4 PoolManager alike. */
    recentPools: {
      cost: 2,
      build: (v) => ({
        query: `query ($since: DateTime, $limit: Int) {
          EVM(network: robinhood) {
            Events(
              limit: {count: $limit}
              orderBy: {descending: Block_Time}
              where: {Log: {Signature: {Name: {is: "Initialize"}}}, Block: {Time: {after: $since}}}
            ) {
              Block { Time }
              Transaction { Hash }
              Arguments { Name Value { ... on EVM_ABI_Address_Value_Arg { address } } }
            }
          }
        }`,
        variables: {
          // Clamped server-side. A client asking for "since the beginning of
          // time, limit 100000" is exactly the request that must not be possible.
          since: new Date(Date.now() - clampInt(v.sinceMinutes, 1, 1440, 60) * 60_000).toISOString(),
          limit: clampInt(v.limit, 1, 100, 25),
        },
      }),
    },
    /** Chain height — the cheapest possible liveness/credential check. */
    ping: {
      cost: 1,
      build: () => ({
        query: `{ EVM(network: robinhood) { Blocks(limit: {count: 1}, orderBy: {descending: Block_Number}) { Block { Number } } } }`,
        variables: {},
      }),
    },
  };

  async function bitquery({ token, body, ip }) {
    if (!bitqueryKey) {
      return { status: 503, json: { error: "this gateway has no Bitquery key configured" } };
    }
    const addr = verifyToken(token);
    if (!addr) return { status: 401, json: { error: "invalid or expired Merrymen token — re-claim at /claim" } };
    // A SEPARATE, tighter bucket from the chat route. Discovery is polled on a
    // timer rather than driven by a human typing, so it would otherwise quietly
    // consume the whole per-address allowance that the brain also depends on.
    if (!(await store.rateHit(`bq:${addr}`, T.BITQUERY_RATE_PER_MIN, 60))) {
      return { status: 429, json: { error: "rate limit — discovery is polled, not streamed (holder quota)" } };
    }
    if (!(await isHolder(addr))) {
      return { status: 403, json: { error: "this wallet no longer meets the $MERRYMEN holding requirement" } };
    }
    const name = body && typeof body === "object" ? body.query : null;
    const entry = Object.prototype.hasOwnProperty.call(BITQUERY_QUERIES, name)
      ? BITQUERY_QUERIES[name]
      : null;
    if (!entry) {
      return {
        status: 400,
        json: {
          error: `unknown query "${String(name).slice(0, 40)}"`,
          available: Object.keys(BITQUERY_QUERIES),
        },
      };
    }
    const built = entry.build(body.variables && typeof body.variables === "object" ? body.variables : {});
    try {
      const upstream = await fetch(bitqueryUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...bitqueryAuthHeaders(bitqueryKey),
        },
        body: JSON.stringify(built),
      });
      const text = await upstream.text();
      // Upstream errors can quote the request, and the request carries our key
      // in its headers on the way out. Return the status, not the body, unless
      // the call actually succeeded.
      if (!upstream.ok) {
        return { status: upstream.status === 429 ? 429 : 502, json: { error: `bitquery upstream ${upstream.status}` } };
      }
      return { status: 200, text, contentType: "application/json" };
    } catch {
      return { status: 502, json: { error: "bitquery unavailable" } };
    }
  }

  /**
   * PUBLIC memescope — newly launched pools, no holder token required.
   *
   * COST IS THE ENTIRE DESIGN HERE, because this route has no auth in front of
   * it and every upstream call lands on the operator's Bitquery bill. Two
   * properties keep an unauthenticated route affordable:
   *
   *   ONE SHARED ANSWER. Everybody watching sees the same cache entry, so a
   *   thousand viewers cost exactly what one viewer costs — at most one upstream
   *   query per MEMESCOPE_TTL_SEC, forever, regardless of traffic.
   *
   *   SINGLE FLIGHT. On a cold or expired cache, concurrent requests await the
   *   SAME in-flight promise instead of each starting their own query. Without
   *   this, a burst of 200 visitors the moment the cache expires is 200 upstream
   *   calls — the exact spike the TTL was supposed to prevent.
   *
   * The cache is process-local, which is correct for the long-lived Railway
   * server this route is meant for. On serverless each isolate would keep its
   * own copy and the effective rate becomes (isolates / TTL) — still bounded,
   * but no longer one. Don't deploy this route to a fleet without moving the
   * cache into `store`.
   */
  let scope = { at: 0, rows: [], inflight: null };

  async function fetchScope() {
    // The LIMIT binds here, not the time window. This chain opens pools fast
    // enough that 40 events covered roughly a minute of activity, which made a
    // "last 12 hours" window meaningless — it was really "the most recent 40".
    // 100 is the clamp's ceiling; the window stays generous so it never becomes
    // the binding constraint, and the page reports the span it actually got
    // rather than the one that was asked for.
    const built = BITQUERY_QUERIES.recentPools.build({ sinceMinutes: 720, limit: 100 });
    const upstream = await fetch(bitqueryUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bitqueryAuthHeaders(bitqueryKey),
      },
      body: JSON.stringify(built),
    });
    if (!upstream.ok) throw new Error(`bitquery HTTP ${upstream.status}`);
    const body = await upstream.json();
    // A GraphQL endpoint answers 200 with an `errors` array when the QUERY is
    // wrong, so an HTTP-only check reports "unavailable" for a service that
    // replied perfectly well and told us exactly what it disliked.
    if (Array.isArray(body?.errors) && body.errors.length) {
      throw new Error(`bitquery rejected the query: ${body.errors.map((e) => e?.message).filter(Boolean).join("; ").slice(0, 300)}`);
    }
    const events = body?.data?.EVM?.Events ?? [];

    const pairs = [];
    const seen = new Set();
    for (const ev of events) {
      const p = parseInitializeEvent(ev);
      // One row per token. The same token can initialize several pools (fee
      // tiers, v3 and v4 side by side) and a scope listing it four times reads
      // as four launches.
      if (!p || seen.has(p.token)) continue;
      seen.add(p.token);
      pairs.push(p);
    }

    // Names come from the CONTRACT, never from the indexer. A launch can call
    // itself anything in third-party metadata; what the token itself reports is
    // the only claim that is actually on-chain.
    const named = await Promise.all(
      pairs.map(async (p) => {
        try {
          const [symbol, decimals] = await Promise.all([
            publicClient.readContract({ address: p.token, abi: erc20Abi, functionName: "symbol" }),
            publicClient.readContract({ address: p.token, abi: erc20Abi, functionName: "decimals" }),
          ]);
          return { ...p, symbol: sanitizeSymbol(symbol), decimals: Number(decimals) };
        } catch {
          // Unreadable is a real answer, and a common one for a token that is
          // a proxy, a honeypot, or simply not an ERC-20. Say so rather than
          // inventing a name — the address is still shown and still clickable.
          return { ...p, symbol: null, decimals: null };
        }
      }),
    );
    return named.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function memescope({ ip }) {
    if (!bitqueryKey) {
      return { status: 503, json: { error: "this gateway has no Bitquery key configured" } };
    }
    if (!(await store.rateHit(`ms:${ip}`, T.MEMESCOPE_RATE_PER_MIN, 60))) {
      return { status: 429, json: { error: "rate limit — the scope refreshes every 45s, polling faster shows nothing new" } };
    }
    const fresh = Date.now() - scope.at < T.MEMESCOPE_TTL_SEC * 1000;
    if (fresh) return { status: 200, json: { pools: scope.rows, cached: true, ttl: T.MEMESCOPE_TTL_SEC } };

    if (!scope.inflight) {
      scope.inflight = fetchScope()
        .then((rows) => {
          scope = { at: Date.now(), rows, inflight: null };
          return rows;
        })
        .catch((err) => {
          scope.inflight = null;
          throw err;
        });
    }
    try {
      const rows = await scope.inflight;
      return { status: 200, json: { pools: rows, cached: false, ttl: T.MEMESCOPE_TTL_SEC } };
    } catch (err) {
      // Log the REASON. Returning a bare 502 and swallowing the cause makes an
      // operator guess between a bad key, a plan limit, a rejected query and a
      // network blip — all of which look identical from outside. The message is
      // safe to print; the key only ever travels in a request header.
      console.error(`[gateway] memescope upstream failed: ${err instanceof Error ? err.message : String(err)}`);
      // Serve stale rather than nothing: a scope that briefly stops updating is
      // far better than a page that breaks because a data provider blinked.
      if (scope.rows.length) {
        return { status: 200, json: { pools: scope.rows, cached: true, stale: true, ttl: T.MEMESCOPE_TTL_SEC } };
      }
      return { status: 502, json: { error: "bitquery unavailable" } };
    }
  }

  return {
    health,
    serveClaimPage: (html) => ({ status: 200, html }),
    nonce,
    claim,
    chat,
    models,
    bitquery,
    memescope,
    bitqueryQueries: () => Object.keys(BITQUERY_QUERIES),
    // exposed for the standalone server + tests
    isHolder,
    _tokens: { sign, issueToken, verifyToken, issueNonce, verifyNonceAuthentic, claimMessage, clampPayload },
    tunables: T,
  };
}
