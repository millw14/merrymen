/**
 * THE X API, AS MERRYMEN USES IT: OAuth 2.0 (authorization code + PKCE) as a
 * CONFIDENTIAL client, "who is this token", post, revoke. Plain fetch and
 * node:crypto — no SDK, so no dependency and nothing new in package-lock.json
 * (which ios-native/Signing hashes).
 *
 * EVERY CALL RETURNS, NONE THROWS. An answer is `{ok:true, value}` or a
 * `failure` from a closed set, and the set is chosen by what the CALLER must do
 * next — above all, whether X might have acted:
 *
 *   auth        401: the token is expired or revoked. X did nothing.
 *   rate        429: X did nothing; `resetAtMs` says when to try again.
 *   duplicate   403 duplicate content. X did nothing — and never will for this text.
 *   forbidden   403 otherwise: the ACCOUNT may not post (locked, restricted).
 *   credits     402, or a credits-depleted refusal: the APP may not post.
 *   grant       the token endpoint refused the code or refresh token itself
 *               (a 400 invalid_grant, or X's invalid_request for a spent one).
 *   app         the token endpoint refused the APP — our client id or secret
 *               (a 401, invalid_client, unauthorized_client). Nothing is wrong
 *               with the owner's grant, so it is never read as a revocation.
 *   invalid     400-class: our request was wrong. X did nothing.
 *   uncertain   a network error, a timeout, a 5xx, an unreadable 2xx: X MAY
 *               HAVE ACTED. A post answered this way is never sent again
 *               (docs/x-posting.md rule 4): X has no idempotency key, and a
 *               duplicate on somebody's personal timeline is worse than a gap.
 *
 * NOTHING X SAYS IS ECHOED. A token endpoint's error body can carry the code;
 * a response can carry a token. Results hold a status and a classification —
 * never a body, never a header value other than the rate-limit reset.
 *
 * THE CLIENT SECRET IS READ HERE AND NOWHERE ELSE (xAppFromEnv), and the
 * orchestrator strips it from every worker child.
 */
import { createHash, randomBytes } from "node:crypto";
import { readBounded } from "../bounded-read";

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_REVOKE_URL = "https://api.x.com/2/oauth2/revoke";
export const X_ME_URL = "https://api.x.com/2/users/me";
export const X_POSTS_URL = "https://api.x.com/2/tweets";

/**
 * What posting needs, and nothing more. POST /2/tweets declares all three of
 * tweet.write, tweet.read and users.read; offline.access is what makes X issue
 * a refresh token at all, without which the connection dies in two hours.
 */
export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access"] as const;

/** A request to X that has not answered in this long is an answer: uncertain. */
const TIMEOUT_MS = 10_000;
/** No legitimate X answer here is near this; a bigger one is not read. */
const MAX_BODY_BYTES = 64 * 1024;

export interface XApp {
  clientId: string;
  clientSecret: string;
  /** The registered callback, `${MERRYMEN_PUBLIC_ORIGIN}/connect/x`, or null when it cannot be built. */
  redirectUri: string | null;
}

/**
 * The house X app, or null when it is not configured (the feature is then
 * unavailable, not broken). THE ONE PLACE the client secret is read.
 *
 * The redirect URI is explicit or built from MERRYMEN_PUBLIC_ORIGIN — never from
 * a request's Host, which a client chooses, and never from `req.url`, which
 * Next rewrites (127.0.0.1 → localhost). It must match the one registered on
 * the X app byte for byte.
 */
export function xAppFromEnv(env: Record<string, string | undefined> = process.env): XApp | null {
  const clientId = env.MERRYMEN_X_CLIENT_ID?.trim();
  const clientSecret = env.MERRYMEN_X_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const explicit = env.MERRYMEN_X_REDIRECT_URI?.trim();
  const origin = env.MERRYMEN_PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  const candidate = explicit || (origin ? `${origin}/connect/x` : "");
  return { clientId, clientSecret, redirectUri: redirectOk(candidate) ? candidate : null };
}

/** https anywhere, http only on a loopback host — the same rule X applies to callbacks. */
function redirectOk(raw: string): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

// ── PKCE and state ──────────────────────────────────────────────────────────

/**
 * A PKCE pair. S256 only: X also accepts "plain", which would send the
 * verifier itself through the browser. 32 random bytes → a 43-character
 * verifier, inside RFC 7636's 43..128.
 */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Who finishes a connect: the web page itself, or the iOS app it hands the code to. */
export type ConnectClient = "web" | "ios";

const STATE_PREFIX: Readonly<Record<ConnectClient, string>> = { web: "w", ios: "i" };

/**
 * A fresh OAuth state. The one-letter prefix only ROUTES the callback page
 * (finish here, or hand to the app); it authorizes nothing — the finish
 * checks the pending row, whose tenant came from a session.
 */
export function newState(client: ConnectClient): string {
  return `${STATE_PREFIX[client]}.${randomBytes(24).toString("base64url")}`;
}

/** The client a state was minted for, or null for anything that is not one of ours. */
export function stateClient(state: unknown): ConnectClient | null {
  if (typeof state !== "string" || !/^[wi]\.[A-Za-z0-9_-]{32}$/.test(state)) return null;
  return state.startsWith("i.") ? "ios" : "web";
}

export function authorizeUrl(app: XApp, p: { state: string; challenge: string; redirectUri: string }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: p.redirectUri,
    scope: X_SCOPES.join(" "),
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  });
  return `${X_AUTHORIZE_URL}?${q.toString()}`;
}

// ── results ─────────────────────────────────────────────────────────────────

export type XFailure = "auth" | "rate" | "duplicate" | "forbidden" | "credits" | "grant" | "app" | "invalid" | "uncertain";

export type XResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: XFailure; status: number | null; resetAtMs?: number };

export interface XTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute, ms. X says two hours; the answer's own expires_in is used. */
  accessExpiresAtMs: number;
  scope: string;
}

export interface XMe {
  id: string;
  username: string;
}

/** The slice of fetch this module uses, so a test can hand in a double. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; body?: unknown; text(): Promise<string> }>;

const realFetch: FetchLike = (url, init) => fetch(url, init);

type Response = Awaited<ReturnType<FetchLike>>;

async function call(fetchImpl: FetchLike, url: string, init: Parameters<FetchLike>[1]): Promise<Response | null> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
}

async function jsonOf(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const r = await readBounded(res, MAX_BODY_BYTES);
    if (!r.ok) return null;
    const v: unknown = JSON.parse(r.text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function basic(app: XApp): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret)}`).toString("base64")}`;
}

/** The reset X names, or fifteen minutes (its rate-limit window) when it names none. */
function resetOf(res: Response, nowMs: number): number {
  const sec = Number(res.headers.get("x-rate-limit-reset"));
  if (Number.isFinite(sec) && sec > nowMs / 1000 && sec < nowMs / 1000 + 86_400) return Math.ceil(sec * 1000);
  return nowMs + 15 * 60_000;
}

function fail<T>(failure: XFailure, status: number | null, resetAtMs?: number): XResult<T> {
  return resetAtMs === undefined ? { ok: false, failure, status } : { ok: false, failure, status, resetAtMs };
}

// ── the token endpoint ──────────────────────────────────────────────────────

async function tokenCall(app: XApp, form: Record<string, string>, fetchImpl: FetchLike, nowMs: number): Promise<XResult<XTokens>> {
  const res = await call(fetchImpl, X_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: basic(app),
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({ ...form, client_id: app.clientId }).toString(),
  });
  if (!res) return fail("uncertain", null);
  if (res.status === 429) return fail("rate", 429, resetOf(res, nowMs));
  if (res.status >= 500) return fail("uncertain", res.status);
  const body = await jsonOf(res);
  if (res.status >= 400) {
    const code = typeof body?.error === "string" ? body.error : "";
    // THE APP, NOT THE OWNER. RFC 6749 answers 401 (invalid_client) when the
    // client's own Basic auth is refused — a rotated or mistyped secret. Read
    // as a dead grant, one bad deploy would revoke every owner's connection
    // over the next few hours, although every grant is still good.
    if (res.status === 401 || code === "invalid_client" || code === "unauthorized_client") return fail("app", res.status);
    // invalid_grant is the RFC's word; X also answers invalid_request for a
    // refresh token it no longer honours. Either way the grant is gone.
    if (res.status === 400 && (code === "invalid_grant" || code === "invalid_request")) return fail("grant", res.status);
    return fail("invalid", res.status);
  }
  const access = body?.access_token;
  const refresh = body?.refresh_token;
  const expiresIn = Number(body?.expires_in);
  if (typeof access !== "string" || access.length < 8) return fail("uncertain", res.status);
  return {
    ok: true,
    value: {
      accessToken: access,
      refreshToken: typeof refresh === "string" && refresh.length >= 8 ? refresh : null,
      // A missing or absurd lifetime is read as X's documented two hours.
      accessExpiresAtMs: nowMs + (Number.isFinite(expiresIn) && expiresIn > 0 && expiresIn < 30 * 86_400 ? expiresIn : 7200) * 1000,
      scope: typeof body?.scope === "string" ? body.scope : X_SCOPES.join(" "),
    },
  };
}

/**
 * Redeem an authorization code. Immediately: X's codes live about thirty
 * seconds. The caller must already have checked the state — this function
 * cannot, and must never be handed a code it did not ask for.
 */
export function exchangeCode(
  app: XApp,
  p: { code: string; verifier: string; redirectUri: string },
  opts: { fetch?: FetchLike; nowMs?: number } = {},
): Promise<XResult<XTokens>> {
  return tokenCall(
    app,
    { grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier },
    opts.fetch ?? realFetch,
    opts.nowMs ?? Date.now(),
  );
}

/**
 * Trade a refresh token for a new pair. X REFRESH TOKENS ARE SINGLE USE: the
 * old one is dead the moment this answers, so the caller stores the new pair
 * (compare-and-swap) before doing anything else with it. An `uncertain` answer
 * may still have rotated it server-side; nothing can recover that but a
 * reconnect, which the next refresh's `grant` failure will ask for.
 */
export function refreshTokens(
  app: XApp,
  refreshToken: string,
  opts: { fetch?: FetchLike; nowMs?: number } = {},
): Promise<XResult<XTokens>> {
  return tokenCall(app, { grant_type: "refresh_token", refresh_token: refreshToken }, opts.fetch ?? realFetch, opts.nowMs ?? Date.now());
}

/** Revoke a token at X. Best effort: the caller forgets it either way. */
export async function revokeToken(
  app: XApp,
  token: string,
  hint: "access_token" | "refresh_token",
  opts: { fetch?: FetchLike } = {},
): Promise<XResult<null>> {
  const res = await call(opts.fetch ?? realFetch, X_REVOKE_URL, {
    method: "POST",
    headers: { authorization: basic(app), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ token, token_type_hint: hint, client_id: app.clientId }).toString(),
  });
  if (!res) return fail("uncertain", null);
  if (res.status >= 200 && res.status < 300) return { ok: true, value: null };
  return fail(res.status >= 500 ? "uncertain" : "invalid", res.status);
}

// ── the API ─────────────────────────────────────────────────────────────────

/** X's own rule for a handle. A username outside it is not one we display. */
const USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const ID = /^\d{1,25}$/;

/**
 * WHICH ACCOUNT THIS TOKEN POSTS AS — the only source of the handle the
 * warning names. Never a typed handle, never the Privy sign-in's.
 */
export async function fetchMe(accessToken: string, opts: { fetch?: FetchLike; nowMs?: number } = {}): Promise<XResult<XMe>> {
  const res = await call(opts.fetch ?? realFetch, X_ME_URL, {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res) return fail("uncertain", null);
  const read = await classify(res, opts.nowMs ?? Date.now());
  if (!read.ok) return read;
  const data = read.value.data;
  const d = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const id = typeof d?.id === "string" && ID.test(d.id) ? d.id : null;
  const username = typeof d?.username === "string" && USERNAME.test(d.username) ? d.username : null;
  if (!id || !username) return fail("invalid", res.status);
  return { ok: true, value: { id, username } };
}

/**
 * POST ONE TEXT. The caller has CLAIMED the post first (xpost/store.ts
 * claimPost) and treats `uncertain` as final. Text only: no media, no reply,
 * no quote — a link would also cost thirteen times as much.
 */
export async function createPost(
  accessToken: string,
  text: string,
  opts: { fetch?: FetchLike; nowMs?: number } = {},
): Promise<XResult<{ id: string }>> {
  const res = await call(opts.fetch ?? realFetch, X_POSTS_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res) return fail("uncertain", null);
  const read = await classify(res, opts.nowMs ?? Date.now());
  if (!read.ok) return read;
  const data = read.value.data;
  const id = data !== null && typeof data === "object" ? (data as Record<string, unknown>).id : null;
  // A 2xx we cannot read an id from DID create something, or might have.
  if (typeof id !== "string" || !ID.test(id)) return fail("uncertain", res.status);
  return { ok: true, value: { id } };
}

/**
 * An API answer, sorted. A 2xx hands back its JSON (or `uncertain` if there is
 * none to read). Every refusal is sorted by what X did — nothing — except a
 * 5xx, which is `uncertain` because a gateway error can follow a write.
 */
async function classify(res: Response, nowMs: number): Promise<XResult<Record<string, unknown>>> {
  if (res.status >= 200 && res.status < 300) {
    const body = await jsonOf(res);
    return body ? { ok: true, value: body } : fail("uncertain", res.status);
  }
  if (res.status === 401) return fail("auth", 401);
  if (res.status === 402) return fail("credits", 402);
  if (res.status === 429) return fail("rate", 429, resetOf(res, nowMs));
  if (res.status === 403) {
    const body = await jsonOf(res);
    const said = [body?.title, body?.detail, body?.type, body?.reason]
      .filter((v): v is string => typeof v === "string")
      .join(" ");
    if (/duplicate/i.test(said)) return fail("duplicate", 403);
    if (/credit/i.test(said)) return fail("credits", 403);
    return fail("forbidden", 403);
  }
  if (res.status >= 500) return fail("uncertain", res.status);
  return fail("invalid", res.status);
}

// ── counting like X counts ──────────────────────────────────────────────────

/**
 * X's weighted length (twitter-text v3): a code point in these ranges counts
 * one, everything else — CJK, most emoji — two, against a limit of 280.
 * The gate's own ceiling is far below, so this is a backstop, not a budget.
 */
const WEIGHT_ONE: readonly [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

export const X_MAX_WEIGHTED = 280;

export function xWeightedLength(text: string): number {
  let n = 0;
  for (const ch of String(text).normalize("NFC")) {
    const cp = ch.codePointAt(0) ?? 0;
    n += WEIGHT_ONE.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
  }
  return n;
}
