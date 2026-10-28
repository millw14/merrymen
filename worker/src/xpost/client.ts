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
export const X_MEDIA_UPLOAD_URL = "https://api.x.com/2/media/upload";

/** X's ceiling for one image upload (docs.x.com, media: images up to 5 MB). */
export const X_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** X's media id: a decimal of at most nineteen digits (POST /2/tweets `media.media_ids`). */
const MEDIA_ID = /^\d{1,19}$/;

/**
 * What posting needs, and nothing more. POST /2/tweets declares all three of
 * tweet.write, tweet.read and users.read; offline.access is what makes X issue
 * a refresh token at all, without which the connection dies in two hours.
 * media.write is POST /2/media/upload's, for the profit card an active owner's
 * sale carries (docs/x-posting.md "Sale posts"). A grant made before it was
 * asked for lacks it: those sales post without the card, as they always did,
 * until the owner reconnects X.
 */
export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"] as const;

/** The scope a card upload needs. */
export const X_MEDIA_SCOPE = "media.write";

/** Whether a stored grant's scope string (space-separated, as X answers it) holds `scope`. */
export function grantHolds(granted: string | null | undefined, scope: string): boolean {
  return typeof granted === "string" && granted.split(/\s+/).includes(scope);
}

/** A request to X that has not answered in this long is an answer: uncertain. */
const TIMEOUT_MS = 10_000;
/** No legitimate X answer here is near this; a bigger one is not read. */
const MAX_BODY_BYTES = 64 * 1024;
/** A hundred bounded mention texts plus their metadata, including multibyte text. */
const MAX_MENTIONS_BODY_BYTES = 2 * 1024 * 1024;
/** X and the host may disagree slightly about wall-clock time. */
const MENTION_CLOCK_SKEW_MS = 30_000;

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

async function call(fetchImpl: FetchLike, url: string, init: Parameters<FetchLike>[1], timeoutMs = TIMEOUT_MS): Promise<Response | null> {
  try {
    const ms = Number.isFinite(timeoutMs) ? Math.min(TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs))) : TIMEOUT_MS;
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch {
    return null;
  }
}

async function jsonOf(res: Response, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  try {
    const r = await readBounded(res, maxBytes);
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
      // A grant X does not name is read WITHOUT media.write: a token issued
      // before it was asked for would otherwise be stored as holding it, and
      // its owner never told to reconnect. Posting needs nothing it adds.
      scope: typeof body?.scope === "string" ? body.scope : X_SCOPES.filter((s) => s !== X_MEDIA_SCOPE).join(" "),
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
 * claimPost) and treats `uncertain` as final. A reply target comes only from
 * the durable, owner-bound reply record checked by the sender.
 */
export async function createPost(
  accessToken: string,
  text: string,
  opts: { fetch?: FetchLike; nowMs?: number; replyToTweetId?: string; mediaIds?: readonly string[] } = {},
): Promise<XResult<{ id: string }>> {
  if (opts.replyToTweetId !== undefined && !ID.test(opts.replyToTweetId)) return fail("invalid", null);
  // Only ids X itself handed back from an upload (uploadImage), at most X's four.
  const media = opts.mediaIds ?? [];
  if (media.length > 4 || media.some((id) => typeof id !== "string" || !MEDIA_ID.test(id))) return fail("invalid", null);
  const res = await call(opts.fetch ?? realFetch, X_POSTS_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      text,
      ...(opts.replyToTweetId ? { reply: { in_reply_to_tweet_id: opts.replyToTweetId } } : {}),
      ...(media.length ? { media: { media_ids: [...media] } } : {}),
    }),
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
 * UPLOAD ONE IMAGE for a post, as the owner (OAuth 2.0 user token holding
 * media.write): POST /2/media/upload with the image base64-encoded in a JSON
 * body and `media_category: "tweet_image"`, answered with `data.id`, the id
 * POST /2/tweets takes in `media.media_ids`. One image, one request: X's
 * single-request upload takes an image whole, under its 5 MB image limit.
 *
 * AN UPLOAD IS NOT A POST. Nothing appears on anybody's timeline until a post
 * names the id, and an id no post names expires at X. So every failure here,
 * `uncertain` included, costs only the picture: the caller posts the text on
 * its own and never uploads again for that post. The answers are sorted by the
 * same `classify` as a post (401 auth, 403 forbidden, 429 rate, 5xx uncertain).
 *
 * `timeoutMs` bounds the call below the client's own ten seconds, so a slow
 * upload cannot hold the post it was for past the caller's budget.
 */
export async function uploadImage(
  accessToken: string,
  image: Uint8Array,
  opts: { fetch?: FetchLike; nowMs?: number; timeoutMs?: number } = {},
): Promise<XResult<{ id: string }>> {
  if (!(image instanceof Uint8Array) || image.byteLength === 0 || image.byteLength > X_MAX_IMAGE_BYTES) return fail("invalid", null);
  const res = await call(opts.fetch ?? realFetch, X_MEDIA_UPLOAD_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ media: Buffer.from(image.buffer, image.byteOffset, image.byteLength).toString("base64"), media_category: "tweet_image" }),
  }, opts.timeoutMs);
  if (!res) return fail("uncertain", null);
  const read = await classify(res, opts.nowMs ?? Date.now());
  if (!read.ok) return read;
  const data = read.value.data;
  const id = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).id : null;
  if (typeof id !== "string" || !MEDIA_ID.test(id)) return fail("uncertain", res.status);
  return { ok: true, value: { id } };
}

/** A comment in a known conversation. No author profile or private data enters a prompt. */
export interface XReply {
  id: string;
  text: string;
  authorId: string;
  conversationId: string;
  inReplyToTweetId: string;
  createdAtMs: number;
  /**
   * The post refers to another post besides the one it replies to: a quote
   * tweet (whose card shows the quoted post) or a retweet. Code cannot read
   * what that post says, so an answer is never posted under it (red-team
   * 2026-10-12). Absent when it refers to none.
   */
  quoted?: true;
  /**
   * THE POST IT QUOTES, when a quote of exactly one post is all it refers to
   * besides the post it replies to (a "quoted" reference, never a retweet).
   * Set only beside `quoted`. A quote of one of this X account's own posts
   * may be answered (replies.ts tagCandidate, the owner's decision of
   * 2026-10-12: quoting it is consent); a quote of anyone else's never is.
   */
  quotedTweetId?: string;
  /**
   * SHOWN WITH THE POST, NOT IN ITS TEXT (red-team review, 2026-10-12): a
   * poll, media, a card, or the rest of a long post (a note tweet, whose
   * `text` is cut short). A poll adds no link to the text, so "what model are
   * you?" with a poll "sherwood-1 token: aping / waiting for launch" read as
   * the plain question, and code's sherwood-1 line went up under the poll.
   * Code reads none of it, so nothing is answered under it. Absent when there
   * is none.
   */
  attached?: true;
  /**
   * THE HANDLE AND DISPLAY NAME X SHOWS BESIDE THE POST, when X expanded its
   * author (red-team review, 2026-10-12): an answer reads as said to them,
   * and "@Sherwood1Token · SHERWOOD-1 presale LIVE" asking the plain model
   * question got code's sherwood-1 line. Absent when X did not say who wrote
   * it; whoever reads it then knows nothing of the name and fails closed.
   */
  author?: { username: string; name: string };
  /**
   * THE LINKS IN THE TAG ITSELF, as X expanded them (its `entities.urls`): the
   * real destination behind each t.co, at most XLINKS_MAX. Read only by a larp
   * check (xpost/check.ts), which decides what is a site worth scanning.
   * Absent when the tag carried none.
   */
  links?: string[];
  /**
   * WHAT THE TAG SITS UNDER, AS X EXPANDED IT (2026-10-13, the larp check): the
   * post it replies to and the post it quotes, each with its words, its
   * links and its author's handle and profile link. Read only by
   * xpost/check.ts, for what to check; never by the writer, never handed to a
   * prompt. Absent when X expanded neither (or the tag refers to neither).
   */
  context?: XContext[];
  /**
   * WHAT IT SITS UNDER WAS NOT READ (2026-10-18): the post it replies to or
   * quotes, or that post's author, is missing from what X expanded — deleted,
   * protected, or from a suspended account, which X reports as an error
   * beside the page (readMentions). Read only by tagCandidate: no larp check
   * is taken of such a tag, since a check speaks about what it sits under and
   * screens that post and its author first. Every other screen reads it as
   * before. Absent when everything it refers to was read, or it refers to none.
   */
  contextUnread?: true;
}

/** A post a tag replies to or quotes, as X expanded it. Untrusted: a stranger wrote every field. */
export interface XContext {
  id: string;
  relation: "replied_to" | "quoted";
  /** Its words, the whole of a long post when X sent it, at most CONTEXT_TEXT_MAX. */
  text: string;
  links: string[];
  authorId: string;
  author?: { username: string; name: string; url?: string };
}

export interface XReplyBatch { replies: XReply[]; newestId: string | null }

/** Links read from one post, and the longest one kept. */
export const XLINKS_MAX = 5;
const XLINK_CHARS = 300;
/** The most of a post a tag sits under that is read. */
const CONTEXT_TEXT_MAX = 4000;

/** The real destinations of a post's links (X's `entities.urls`), http(s) only, deduplicated, at most XLINKS_MAX. Malformed: none. */
function linksOf(entities: unknown): string[] {
  const urls = entities !== null && typeof entities === "object" && !Array.isArray(entities) ? (entities as Record<string, unknown>).urls : null;
  if (!Array.isArray(urls)) return [];
  const out: string[] = [];
  for (const u of urls) {
    if (!u || typeof u !== "object" || Array.isArray(u)) continue;
    const r = u as Record<string, unknown>;
    const href = [r.unwound_url, r.expanded_url].find((v): v is string => typeof v === "string" && /^https?:\/\/\S+$/i.test(v) && v.length <= XLINK_CHARS);
    if (href && !out.includes(href)) out.push(href);
    if (out.length >= XLINKS_MAX) break;
  }
  return out;
}

/** The profile link each expanded author shows (`url`, expanded through `entities.url`), by id. */
function profileLinksOf(includes: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const users = includes !== null && typeof includes === "object" && !Array.isArray(includes) ? (includes as Record<string, unknown>).users : null;
  if (!Array.isArray(users)) return out;
  for (const u of users) {
    if (!u || typeof u !== "object" || Array.isArray(u)) continue;
    const r = u as Record<string, unknown>;
    if (typeof r.id !== "string" || !ID.test(r.id)) continue;
    const e = r.entities !== null && typeof r.entities === "object" ? (r.entities as Record<string, unknown>).url : null;
    const link = linksOf(e)[0];
    if (link) out.set(r.id, link);
  }
  return out;
}

/** The posts X expanded beside a page (`includes.tweets`), by id: words, links, author. A malformed one is left out. */
function referencedOf(includes: unknown): Map<string, { text: string; links: string[]; authorId: string }> {
  const out = new Map<string, { text: string; links: string[]; authorId: string }>();
  const tweets = includes !== null && typeof includes === "object" && !Array.isArray(includes) ? (includes as Record<string, unknown>).tweets : null;
  if (!Array.isArray(tweets)) return out;
  for (const t of tweets) {
    if (!t || typeof t !== "object" || Array.isArray(t)) continue;
    const r = t as Record<string, unknown>;
    if (typeof r.id !== "string" || !ID.test(r.id) || typeof r.author_id !== "string" || !ID.test(r.author_id) || typeof r.text !== "string") continue;
    // A long post's whole text and links, when X sent them; else what the post shows.
    const note = r.note_tweet !== null && typeof r.note_tweet === "object" ? r.note_tweet as Record<string, unknown> : null;
    const text = typeof note?.text === "string" && note.text.trim() ? note.text : r.text;
    const links = [...linksOf(r.entities), ...linksOf(note?.entities)].filter((l, i, all) => all.indexOf(l) === i).slice(0, XLINKS_MAX);
    out.set(r.id, { text: text.slice(0, CONTEXT_TEXT_MAX), links, authorId: r.author_id });
  }
  return out;
}

/** The longest handle or display name read: X's own limits, with room. A longer one is no name code can vouch for. */
const AUTHOR_FIELD_MAX = 100;

/** The authors X expanded on a page (`includes.users`), by id. A malformed entry is left out: its author is then unknown. */
function authorsOf(includes: unknown): Map<string, { username: string; name: string }> {
  const out = new Map<string, { username: string; name: string }>();
  const users = includes !== null && typeof includes === "object" && !Array.isArray(includes) ? (includes as Record<string, unknown>).users : null;
  if (!Array.isArray(users)) return out;
  for (const u of users) {
    if (!u || typeof u !== "object" || Array.isArray(u)) continue;
    const r = u as Record<string, unknown>;
    if (typeof r.id !== "string" || !ID.test(r.id) || typeof r.username !== "string" || typeof r.name !== "string") continue;
    if (r.username.length > AUTHOR_FIELD_MAX || r.name.length > AUTHOR_FIELD_MAX) continue;
    out.set(r.id, { username: r.username, name: r.name });
  }
  return out;
}

/** Anything shown with the post that its text does not carry: attachments of any kind, a card, a long post's rest. */
function attachedTo(d: Record<string, unknown>): boolean {
  const a = d.attachments;
  const attachments = a !== undefined && a !== null
    && !(typeof a === "object" && !Array.isArray(a) && Object.values(a as Record<string, unknown>).every((v) => Array.isArray(v) && v.length === 0));
  const card = d.card_uri !== undefined && d.card_uri !== null && d.card_uri !== "";
  const note = d.note_tweet !== undefined && d.note_tweet !== null;
  return attachments || card || note;
}

interface Expanded {
  authors: ReadonlyMap<string, { username: string; name: string }>;
  profiles: ReadonlyMap<string, string>;
  tweets: ReadonlyMap<string, { text: string; links: string[]; authorId: string }>;
}
const NOTHING_EXPANDED: Expanded = { authors: new Map(), profiles: new Map(), tweets: new Map() };

function parsedReply(item: unknown, now: number, excludeAuthorId: string, expanded: Expanded = NOTHING_EXPANDED): XReply | null {
  const authors = expanded.authors;
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const d = item as Record<string, unknown>;
  const refs = Array.isArray(d.referenced_tweets) ? d.referenced_tweets : [];
  const parents = refs.filter((r) => r !== null && typeof r === "object" && r.type === "replied_to");
  const createdAtMs = typeof d.created_at === "string" ? Date.parse(d.created_at) : NaN;
  if (typeof d.id !== "string" || !ID.test(d.id) ||
      typeof d.author_id !== "string" || !ID.test(d.author_id) || d.author_id === excludeAuthorId ||
      (d.conversation_id !== undefined && (typeof d.conversation_id !== "string" || !ID.test(d.conversation_id))) ||
      parents.length > 1 || (parents.length === 1 && (typeof parents[0]!.id !== "string" || !ID.test(parents[0]!.id))) ||
      typeof d.text !== "string" || !d.text.trim() || d.text.length > 4000 ||
      !Number.isFinite(createdAtMs) || createdAtMs <= 0 || createdAtMs > now) return null;
  if (parents.length && (typeof d.conversation_id !== "string" || d.id === d.conversation_id)) return null;
  const besides = refs.filter((r) => r === null || typeof r !== "object" || r.type !== "replied_to");
  const quoted = besides.length > 0;
  // Which post it quotes: only one reference besides its parent, of type "quoted", with an id X could have sent.
  const only = besides.length === 1 ? besides[0] as Record<string, unknown> | null : null;
  const quotedTweetId = only !== null && typeof only === "object" && only.type === "quoted" && typeof only.id === "string" && ID.test(only.id) ? only.id : null;
  const author = authors.get(d.author_id);
  const links = linksOf(d.entities);
  // What it sits under, parent first: each post X expanded, with its author's handle and profile link when X sent them.
  const context: XContext[] = [];
  // Any of them, or its author, X did not hand over: what it sits under is unread (XReply.contextUnread).
  let unread = false;
  for (const r of [...parents, ...besides.filter((b) => b !== null && typeof b === "object" && b.type === "quoted")]) {
    const ref = r as Record<string, unknown>;
    const t = typeof ref.id === "string" ? expanded.tweets.get(ref.id) : undefined;
    if (!t) {
      unread = true;
      continue;
    }
    const who = authors.get(t.authorId);
    if (!who) unread = true;
    const url = expanded.profiles.get(t.authorId);
    context.push({ id: ref.id as string, relation: ref.type === "quoted" ? "quoted" : "replied_to", text: t.text, links: t.links, authorId: t.authorId,
      ...(who || url ? { author: { username: who?.username ?? "", name: who?.name ?? "", ...(url ? { url } : {}) } } : {}) });
  }
  return { id: d.id, text: d.text, authorId: d.author_id, conversationId: typeof d.conversation_id === "string" ? d.conversation_id : d.id,
    inReplyToTweetId: parents.length ? parents[0]!.id as string : "", createdAtMs, ...(quoted ? { quoted: true as const } : {}),
    ...(quotedTweetId ? { quotedTweetId } : {}),
    ...(attachedTo(d) ? { attached: true as const } : {}), ...(author ? { author: { ...author } } : {}),
    ...(links.length ? { links } : {}), ...(context.length ? { context } : {}), ...(unread ? { contextUnread: true as const } : {}) };
}

/**
 * WHAT X COULD NOT EXPAND, AND NOTHING ELSE (2026-10-18). Mentions expand the
 * posts a tag refers to and their authors (the larp check, 2026-10-13), and X
 * answers a page with one of them deleted, protected or suspended with the
 * page whole and an `errors` entry beside it. Read as a failed page, one such
 * tag held every answer and every STOP behind it: the cursor stayed, and the
 * same page failed every thirty minutes. Only these are read past: each
 * entry's `parameter` is an expansion this read asks for, its `resource_type`
 * the kind that expansion names, its `resource_id` (and `value`, when sent) an
 * id, never one of the page's own mentions, and a missing post one a mention
 * on the page refers to. Any other error, or any entry off this shape, still
 * fails the page.
 */
const EXPANSION_MISSES: ReadonlyMap<string, "tweet" | "user"> = new Map([
  ["referenced_tweets.id", "tweet"],
  ["referenced_tweets.id.author_id", "user"],
  ["author_id", "user"],
]);

function onlyExpansionMisses(errors: unknown, data: readonly unknown[]): boolean {
  if (!Array.isArray(errors) || errors.length === 0) return false;
  const mentions = new Set<string>();
  const referred = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const d = item as Record<string, unknown>;
    if (typeof d.id === "string") mentions.add(d.id);
    for (const r of Array.isArray(d.referenced_tweets) ? d.referenced_tweets : []) {
      const id = r !== null && typeof r === "object" ? (r as Record<string, unknown>).id : undefined;
      if (typeof id === "string") referred.add(id);
    }
  }
  return errors.every((e) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) return false;
    const r = e as Record<string, unknown>;
    const kind = typeof r.parameter === "string" ? EXPANSION_MISSES.get(r.parameter) : undefined;
    const id = r.resource_id;
    return kind !== undefined && r.resource_type === kind && typeof id === "string" && ID.test(id) && (r.value === undefined || r.value === id)
      && !mentions.has(id) && (kind !== "tweet" || referred.has(id));
  });
}

/**
 * Read the authenticated account's mentions, including replies in old threads,
 * so a STOP on a previous bot reply is seen before choosing any new reply.
 * A partial batch is never success: a failed page, repeated cursor, malformed
 * reply or more than the endpoint's eight hundred mentions fails closed. A
 * page whose only errors are posts or authors X could not expand is whole:
 * its tags are all there, and a tag that lost what it sits under says so
 * (XReply.contextUnread, onlyExpansionMisses).
 */
export async function readMentions(
  accessToken: string,
  xUserId: string,
  opts: { fetch?: FetchLike; nowMs?: number; sinceId?: string; startTimeMs?: number } = {},
): Promise<XResult<XReplyBatch>> {
  if (!ID.test(xUserId) || (opts.sinceId !== undefined && !ID.test(opts.sinceId))) return fail("invalid", null);
  const now = opts.nowMs ?? Date.now();
  if (opts.startTimeMs !== undefined && (!Number.isFinite(opts.startTimeMs) || opts.startTimeMs <= 0 || opts.startTimeMs > now)) return fail("invalid", null);
  const started = performance.now();
  const replies: XReply[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let newestId: string | null = null;
  for (let page = 0; page < 8; page++) {
    // Attachments, cards and long posts, and the author's handle and display name: what X shows with a tag (XReply.attached, XReply.author).
    // AND WHAT IT SITS UNDER (2026-10-13, the larp check): the links behind each
    // t.co (entities), the posts it replies to and quotes, their authors and
    // those authors' profile links (XReply.links, XReply.context).
    const query = new URLSearchParams({
      max_results: "100", "tweet.fields": "author_id,conversation_id,referenced_tweets,created_at,attachments,card_uri,note_tweet,entities",
      expansions: "author_id,referenced_tweets.id,referenced_tweets.id.author_id", "user.fields": "username,name,url,entities",
    });
    if (opts.sinceId) query.set("since_id", opts.sinceId);
    else if (opts.startTimeMs !== undefined) query.set("start_time", new Date(Math.floor(opts.startTimeMs / 1000) * 1000).toISOString());
    if (cursor) query.set("pagination_token", cursor);
    const res = await call(opts.fetch ?? realFetch, `https://api.x.com/2/users/${xUserId}/mentions?${query}`, {
      method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!res) return fail("uncertain", null);
    const read = await classify(res, now, MAX_MENTIONS_BODY_BYTES);
    if (!read.ok) return read;
    const meta = read.value.meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return fail("invalid", res.status);
    const m = meta as Record<string, unknown>;
    const data = read.value.data === undefined && m.result_count === 0 ? [] : read.value.data;
    if (!Array.isArray(data) || data.length > 100 || m.result_count !== data.length) return fail("invalid", res.status);
    // A partial page fails, unless all X could not do was expand what a tag refers to (onlyExpansionMisses).
    if (read.value.errors !== undefined && !onlyExpansionMisses(read.value.errors, data)) return fail("invalid", res.status);
    const expanded: Expanded = { authors: authorsOf(read.value.includes), profiles: profileLinksOf(read.value.includes), tweets: referencedOf(read.value.includes) };
    for (const item of data) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return fail("invalid", res.status);
      const d = item as Record<string, unknown>;
      if (typeof d.id !== "string" || !ID.test(d.id)) return fail("invalid", res.status);
      if (!newestId || BigInt(d.id) > BigInt(newestId)) newestId = d.id;
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      // Plain mentions and quotes remain visible for opt-outs. An empty reply
      // target makes them ineligible for a generated response in the planner.
      if (d.author_id === xUserId) continue;
      const arrivedAtMs = now + Math.max(0, performance.now() - started) + MENTION_CLOCK_SKEW_MS;
      const reply = parsedReply(d, arrivedAtMs, xUserId, expanded);
      if (!reply) return fail("invalid", res.status);
      replies.push(reply);
    }
    if (seen.size >= 800) return fail("invalid", res.status);
    if (m.next_token === undefined) return { ok: true, value: { replies, newestId } };
    if (typeof m.next_token !== "string" || !m.next_token || m.next_token.length > 2048 || cursors.has(m.next_token)) return fail("invalid", res.status);
    cursors.add(m.next_token);
    cursor = m.next_token;
  }
  return fail("invalid", null);
}

/**
 * An API answer, sorted. A 2xx hands back its JSON (or `uncertain` if there is
 * none to read). Every refusal is sorted by what X did — nothing — except a
 * 5xx, which is `uncertain` because a gateway error can follow a write.
 */
async function classify(res: Response, nowMs: number, maxBytes = MAX_BODY_BYTES): Promise<XResult<Record<string, unknown>>> {
  if (res.status >= 200 && res.status < 300) {
    const body = await jsonOf(res, maxBytes);
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
    // WHY X SAID NO, for the operator: a bare "forbidden" hid that a market
    // answer had more than one cashtag (2026-10-13). X's own words only, plain
    // characters, bounded; they carry no token and no post text.
    const why = said.replace(/[^A-Za-z0-9 .,:;'()/_-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    if (why) console.warn(`[xpost] X refused the request (403): ${why}`);
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
