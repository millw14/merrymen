/**
 * POSTING ON X, AS THE WEB SEES IT: where the tables are, whether the feature
 * is here at all, and what an owner's own browser is allowed to read back.
 *
 * docs/x-posting.md is the contract. worker/src/xpost/store.ts owns the SQL and
 * worker/src/xpost/client.ts owns every call to X; this file owns neither. It is
 * the glue the two routes under app/api/x/ share, and it lives in lib because a
 * route.ts may export ONLY its handlers and Next's config names (see the note in
 * app/api/x-proof/route.ts) — a helper or a test seam exported from a route file
 * fails the build.
 *
 * THE TABLES LIVE IN THE SHARED POSTGRES OR NOWHERE. The orchestrator reads
 * them from there, so a web process without DATABASE_URL has nowhere to put a
 * connection — and `withReadDb`'s no-URL fallback is the self-hosted ledger,
 * opened read-only, which is the wrong database and cannot take a write. So "no
 * DATABASE_URL" is answered as "no database" here, before that fallback can be
 * reached (the same rule as app/api/groupchat/room.ts).
 *
 * WHAT A BROWSER MAY READ BACK IS SHAPED HERE, IN ONE FUNCTION (accountBody),
 * FROM TYPES THAT HAVE NO TOKEN IN THEM. XAccount carries no token by
 * construction (store.ts reads tokens only through readTokens), so there is no
 * field to forget to delete. What IS shown is the owner's own: the handle X
 * named, whether posting is on, and the drafts about to go out — X's policy
 * asks that an owner see exactly what will be published before it is.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: refresh tokens, draft posts or send
 * them. Refresh and sending belong to the orchestrator that holds the tenant's
 * lease; a web process doing either would race it, and X refresh tokens are
 * single use.
 */
import { withReadDb } from "@/lib/ledger";
import { normaliseXHandle } from "@/lib/x-handle";
import { readBounded } from "../../../worker/src/bounded-read";
import type { Db } from "../../../worker/src/db";
import { canonicalTz } from "../../../worker/src/groupchat/clock";
import { storeDek } from "../../../worker/src/store-crypto";
import { xAppFromEnv, type FetchLike, type XApp } from "../../../worker/src/xpost/client";
import {
  DEFAULT_PREFS,
  OWNER_PER_DAY_MAX,
  ensureXpostSchema,
  type XAccount,
  type XPost,
  type XPostKind,
  type XPostPrefs,
} from "../../../worker/src/xpost/store";

// ── the test seam ───────────────────────────────────────────────────────────

interface Seam {
  /** An in-memory sqlite through the ledger's driver: the store's real SQL on a real engine. */
  db: Db;
  /** X, scripted. Absent means the real fetch, which a test never wants. */
  fetch?: FetchLike;
  now?: () => number;
  /** The X app's configuration (MERRYMEN_X_*, MERRYMEN_PUBLIC_ORIGIN) instead of process.env. */
  env?: Record<string, string | undefined>;
}

let seam: Seam | null = null;

/**
 * THE TEST SEAM: a database other than the shared Postgres, a scripted X, a
 * clock and the X app's configuration. Nothing reachable from a request can set
 * it. The DEK and hosted mode are still read from the environment, because
 * those are the switches a test has to be seen to flip.
 */
export function setXpostForTest(next: Seam | null): void {
  seam = next;
}

/** Wall-clock ms, or the test's. The routes never read the process clock themselves. */
export function xpostNow(): number {
  return seam?.now ? seam.now() : Date.now();
}

/** The fetch the X client should use: the test's, or undefined for the real one. */
export function xpostFetch(): FetchLike | undefined {
  return seam?.fetch;
}

/** The house X app, or null when it is not configured. */
export function xpostApp(): XApp | null {
  return xAppFromEnv(seam?.env ?? process.env);
}

/** The key tokens and verifiers are sealed under, or null when there is none. */
export function xpostDek(): Buffer | null {
  return storeDek();
}

function hasDatabase(): boolean {
  return seam !== null || Boolean(process.env.DATABASE_URL);
}

/**
 * CAN AN OWNER CONNECT AN X ACCOUNT HERE AT ALL?
 *
 * Hosted, with somewhere to keep the connection (the shared database), a key
 * to seal it under, and an X app whose callback can be built. Every one of
 * these missing is "unavailable", never "broken": the Settings section says so
 * in one line and offers nothing that would fail on the first press.
 *
 * `hosted` is the caller's isHostedMode(), handed in rather than read here:
 * that check belongs in route handlers (lib/client-env.test.ts), because it
 * reads process.env and is always false in a browser bundle. Every caller is
 * a route under app/api/x/, which has already answered 404 when it is false.
 */
export function xpostAvailable(hosted: boolean): boolean {
  if (!hosted || !hasDatabase() || xpostDek() === null) return false;
  const app = xpostApp();
  return app !== null && app.redirectUri !== null;
}

/** Reply consent is available only after the operator has enabled this feature. */
export function xpostRepliesAvailable(hosted: boolean): boolean {
  return xpostAvailable(hosted) && (seam?.env ?? process.env).MERRYMEN_XPOST_REPLIES_APPROVED === "1";
}

/**
 * Run `fn` against the X-posting tables, or against null when this deploy has
 * nowhere to keep them. The schema is ensured once per Db for the life of the
 * process (the store memoises it and retries after a failure). A connection or
 * schema failure THROWS: the caller answers 503, never "not connected".
 */
export async function withXpostDb<T>(fn: (db: Db | null) => Promise<T>): Promise<T> {
  if (seam) {
    await ensureXpostSchema(seam.db, "sqlite");
    return fn(seam.db);
  }
  if (!process.env.DATABASE_URL) return fn(null);
  return withReadDb(async (db) => {
    if (!db) return fn(null);
    await ensureXpostSchema(db, "postgres");
    return fn(db);
  });
}

// ── what the routes say ─────────────────────────────────────────────────────

/** Per-owner answers. A shared cache holding one owner's reply would hand it to the next reader. */
export const X_PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;

/**
 * The owner-facing sentences, in one place so the web page and the iOS app
 * (which shows the route's `error` verbatim) say the same thing. None of them
 * carries anything X said: X's answers are classified, never echoed.
 */
export const X_COPY = {
  unavailable: "Posting on X isn't available right now.",
  repliesUnavailable: "Comment replies aren’t available yet.",
  repliesNeedPosting: "Turn posting on for this X account before enabling comment replies.",
  storeDown: "Couldn't reach merrymen just now — try again in a moment.",
  expired: "That sign-in link expired or was already used — start again.",
  wrongOwner:
    "This X connection was started from a different merrymen account, so it wasn't saved. Sign in with the account you started from and connect again.",
  xFailed: "X didn't accept the connection — try again.",
  accountChanged: "The connected X account changed — check which account is connected and try again.",
  alreadySending: "That post is already on its way.",
  notConnected: "Connect an X account first.",
  signedOut: "Sign in to change this.",
  noOwner: "Say which merrymen account this is for.",
  tooLarge: "That request is too large.",
  badJson: "expected JSON",
} as const;

/**
 * A JSON object body, bounded while it streams. The bodies here are a few
 * short fields; anything past `limit` bytes is refused unread (413) and
 * anything that is not a JSON object is a 400.
 */
export async function readXBody(
  req: Request,
  limit: number,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 413 }> {
  let text: string;
  try {
    const r = await readBounded(req, limit);
    if (!r.ok) return { ok: false, status: 413 };
    text = r.text;
  } catch {
    return { ok: false, status: 400 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400 };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, status: 400 };
  return { ok: true, value: parsed as Record<string, unknown> };
}

// ── the zone a consent carries ──────────────────────────────────────────────

/**
 * What a device reports when it will not say where it is: UTC under each of
 * its names, the Etc/* zones, and Iceland's zone under both of its names (Tor
 * Browser since 13.5, Mullvad Browser and Firefox's resistFingerprinting spoof
 * Atlantic/Reykjavik). The same list as the room's browser capture
 * (app/api/groupchat/me/route.ts), which a route file cannot export.
 */
const PLACELESS = new Set([
  "utc",
  "etc/utc",
  "etc/gmt",
  "gmt",
  "universal",
  "zulu",
  "uct",
  "greenwich",
  "gmt0",
  "gmt+0",
  "gmt-0",
  "atlantic/reykjavik",
  "iceland",
]);

function placeless(zone: string): boolean {
  const z = zone.trim().toLowerCase();
  return PLACELESS.has(z) || z.startsWith("etc/");
}

/**
 * THE ZONE AN OWNER TURNED POSTING ON FROM, as the store may keep it: a
 * canonical IANA name, or null. The Merryman's quiet hours fall back to it
 * when the room has no zone for this owner (store.ts XAccount.tz); without
 * one, the owner is never asleep and their account can post at 4am.
 *
 * NULL, NOT A REFUSAL, for anything unusable — missing, not a zone, or
 * placeless. The owner confirmed a warning; a zone the device got wrong is
 * no reason to refuse that, and null keeps whatever zone was stored before.
 * A placeless zone is dropped because storing it would put the owner to
 * sleep through the UTC night, which is somebody's afternoon. Matched on the
 * spelling sent AND the one Intl resolves it to, since engines differ on
 * which alias they hand back.
 */
export function xpostTz(raw: unknown): string | null {
  const tz = canonicalTz(raw);
  if (tz === null || placeless(tz) || placeless(String(raw))) return null;
  return tz;
}

// ── what an owner reads back ────────────────────────────────────────────────

export type { XPostPrefs };

export interface XUpcomingPost {
  id: number;
  kind: XPostKind;
  body: string;
  dueAt: number;
  replyToTweetId?: string;
  replyRootTweetId?: string;
}

export interface XRecentPost {
  id: number;
  kind: XPostKind;
  body: string;
  sentAt: number;
  url: string;
  replyToTweetId?: string;
  replyRootTweetId?: string;
}

/** GET /api/x/account, exactly. Shared by the route and the Settings section. */
export interface XAccountBody {
  available: boolean;
  connected: boolean;
  username: string | null;
  xUserId: string | null;
  status: "ok" | "revoked" | null;
  postingEnabled: boolean;
  /**
   * What the owner lets it post beside the switch: coins it bought, passing
   * thoughts, and how many a day (null: the server's number). The defaults
   * when nothing is connected.
   */
  prefs: XPostPrefs;
  /** The most posts a day an owner may choose (store.ts OWNER_PER_DAY_MAX). */
  perDayMax: number;
  replyEnabled: boolean;
  repliesAvailable: boolean;
  upcoming: XUpcomingPost[];
  recent: XRecentPost[];
}

/** How far back Settings looks for posts. Drafts are hours old at most; this is for "Posted". */
export const X_POSTS_WINDOW_MS = 30 * 86_400_000;
const UPCOMING_MAX = 20;
const RECENT_MAX = 10;
const TWEET_ID = /^\d{1,25}$/;

/**
 * THE ONE PLACE A BROWSER'S VIEW OF THE CONNECTION IS BUILT.
 *
 * `postingEnabled` is XAccount.posting — the switch AND a consent naming this
 * exact X user id AND a connection X still honours — never the raw column, so
 * the switch can never read "on" for an account the owner was not shown.
 *
 * Only posts written for the account connected NOW: a reconnect of a different
 * account cancels the old drafts in the store, and its old posts are not this
 * account's to list. "Coming up" is only `scheduled` (what Skip can still
 * stop); "Posted" is only `posted` with an id X gave, linked through a handle
 * that passes X's own rule — anything else is left out rather than linked.
 */
export function accountBody(available: boolean, account: XAccount | null, posts: readonly XPost[], replies: { enabled: boolean; available: boolean } = { enabled: false, available: false }): XAccountBody {
  if (!account) {
    return {
      available,
      connected: false,
      username: null,
      xUserId: null,
      status: null,
      postingEnabled: false,
      prefs: { ...DEFAULT_PREFS },
      perDayMax: OWNER_PER_DAY_MAX,
      replyEnabled: false,
      repliesAvailable: replies.available,
      upcoming: [],
      recent: [],
    };
  }
  const handle = normaliseXHandle(account.username);
  const mine = posts.filter((p) => p.xUserId === account.xUserId);
  // A kind the owner turned off is not coming up, even a draft planned in the
  // instant they changed it: the send-time check cancels it (planner.ts
  // sendDecision `kind-off`), so it never goes out.
  const allowed = (k: XPostKind) => (k === "buy" ? account.prefs.buys : k === "casual" ? account.prefs.casual : true);
  const upcoming = mine
    .filter((p) => p.status === "scheduled" && allowed(p.kind))
    .sort((a, b) => a.dueAtMs - b.dueAtMs || a.id - b.id)
    .slice(0, UPCOMING_MAX)
    .map((p) => ({ id: p.id, kind: p.kind, body: p.body, dueAt: p.dueAtMs, ...replyContext(p) }));
  const recent = handle
    ? mine
        .filter((p) => p.status === "posted" && p.tweetId !== null && TWEET_ID.test(p.tweetId) && p.sentAtMs !== null)
        .sort((a, b) => (b.sentAtMs ?? 0) - (a.sentAtMs ?? 0) || b.id - a.id)
        .slice(0, RECENT_MAX)
        .map((p) => ({
          id: p.id,
          kind: p.kind,
          body: p.body,
          sentAt: p.sentAtMs ?? 0,
          url: `https://x.com/${handle}/status/${p.tweetId}`,
          ...replyContext(p),
        }))
    : [];
  return {
    available,
    connected: true,
    username: handle,
    xUserId: account.xUserId || null,
    status: account.status,
    postingEnabled: account.posting,
    prefs: { ...account.prefs },
    perDayMax: OWNER_PER_DAY_MAX,
    replyEnabled: account.posting && replies.enabled,
    repliesAvailable: replies.available,
    upcoming,
    recent,
  };
}

function replyContext(post: XPost): { replyToTweetId?: string; replyRootTweetId?: string } {
  return {
    ...(post.replyToTweetId && TWEET_ID.test(post.replyToTweetId) ? { replyToTweetId: post.replyToTweetId } : {}),
    ...(post.replyRootTweetId && TWEET_ID.test(post.replyRootTweetId) ? { replyRootTweetId: post.replyRootTweetId } : {}),
  };
}
