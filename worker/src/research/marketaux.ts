/**
 * THE MARKETAUX ADAPTER — the only file in this repository that knows the name.
 *
 * Everything above it speaks `NewsItem` and `NewsSentiment` from `news.ts`;
 * everything below it is one vendor's JSON. That boundary is the requirement,
 * stated plainly: Brain must not know Marketaux exists. It does not — the Brain
 * service receives rendered blocks built from our own schema, and a grep for
 * the vendor's name across `services/brain/` returns nothing. There is a test.
 *
 * WHY AN ADAPTER RATHER THAN A CLIENT INLINE. The first vendor is never the
 * last. When the second arrives it writes `NewsItem[]` and nothing else in the
 * tree changes — not the desk, not the sentiment maths, not the prompt, not the
 * dataset viewer. The seam is also where sanitisation happens, so a vendor
 * cannot be added later that forgets to do it: the normaliser is the only route
 * in, and it sanitises unconditionally.
 *
 * THE KEY NEVER LEAVES THIS PROCESS. It is read from the environment by the
 * ORCHESTRATOR, which is the only component that calls `fetchMarketauxNews`,
 * and `CHILD_SECRET_STRIP` removes it from every child's environment — so a
 * tenant worker, the Brain service, a persisted decision and a prompt all
 * cannot contain it, because none of them ever holds it. `scrub` below is the
 * belt to that braces: a vendor that echoes the token back inside an error
 * message must not put it into our logs.
 *
 * WHAT IS DELIBERATELY NOT TAKEN. The full article body is available from this
 * provider and is not requested. A prompt is not the place for a scraped
 * article: it is unbounded, it is billed per token on every analyst call, and
 * every extra sentence is extra surface for the one thing news text is not
 * allowed to become. Headline, the provider's own short description, and a
 * bounded highlight are the whole of it.
 */

import { readBoundedJson } from "../bounded-read";
import { NEWS_WINDOW_SEC, sanitizeText, stableId, type NewsItem } from "./news";

/** The vendor's endpoint. Fixed here, never configurable — see safe-url.ts. */
const ENDPOINT = "https://api.marketaux.com/v1/news/all";

/** Bounds on the response body. A news page is kilobytes; this is generous. */
const MAX_RESPONSE_BYTES = 512_000;
/** Above the vendor's own timeout, below anything that could stall a pass. */
const TIMEOUT_MS = 12_000;

/** Caps applied to every piece of vendor text before it is stored. */
const HEADLINE_MAX = 200;
const SUMMARY_MAX = 320;
const SOURCE_MAX = 64;

/** Why a fetch produced nothing. Each is a different fact, and they log apart. */
export type NewsFetchFailure =
  | "no-key" // the house never configured a token — OUR gap, not the vendor's
  | "no-symbols" // nothing to ask about
  | "budget-exhausted" // the day's request allowance is spent
  | "unreachable" // the request did not complete
  | "http-error" // the vendor answered with a status we cannot use
  | "vendor-error" // the vendor answered with its own error object
  | "unreadable"; // the body was too large or would not parse

export type NewsFetchResult =
  | { ok: true; items: NewsItem[]; asked: string[] }
  | { ok: false; failure: NewsFetchFailure; detail: string; asked: string[] };

/** One article as this vendor sends it. Only the fields we actually read. */
interface RawEntity {
  symbol?: unknown;
  type?: unknown;
  match_score?: unknown;
  sentiment_score?: unknown;
  highlights?: unknown;
}
interface RawArticle {
  uuid?: unknown;
  title?: unknown;
  description?: unknown;
  snippet?: unknown;
  url?: unknown;
  published_at?: unknown;
  source?: unknown;
  relevance_score?: unknown;
  entities?: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The vendor's entity match strength, on our 0..1 scale.
 *
 * IT ARRIVES ON TWO DIFFERENT SCALES depending on the field, and guessing wrong
 * silently changes every sentiment weight. `match_score` is documented as a
 * relevance figure that runs past 1; `relevance_score` is a 0..1 fraction and
 * is frequently null. So: anything above 1 is treated as a percentage, anything
 * at or below 1 is taken as given, and both are clamped. A value we cannot
 * interpret becomes null rather than a number — the aggregator floors a null
 * match at 0.5 and says it did.
 */
function normalizeMatch(raw: unknown): number | null {
  const n = num(raw);
  if (n === null || n < 0) return null;
  const scaled = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, scaled));
}

/** ISO 8601 to unix seconds. Anything unparseable is 0 and gets dropped. */
function isoSeconds(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/** https only, and never rendered into a prompt — kept so a human can follow it. */
function safeUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString().slice(0, 500) : "";
  } catch {
    return "";
  }
}

/**
 * Vendor JSON to our schema. PURE — no network, no clock beyond `asOf`.
 *
 * Every string that came from outside goes through `sanitizeText` on the way
 * in, so a caller cannot construct a `NewsItem` holding raw vendor text by any
 * route that exists. The summary prefers the provider's own description, falls
 * back to its snippet, and falls back again to the first highlight — ONE of the
 * three, never a concatenation, because a summary field that grows with the
 * article defeats the point of having one.
 *
 * An article matching none of the symbols we asked about is DROPPED. The
 * provider returns entities we did not ask for when a story mentions several
 * companies, and a story about a competitor filed under our symbol would be
 * read by an analyst as coverage of the instrument it is reasoning about.
 */
export function normalizeMarketaux(
  payload: unknown,
  opts: { asOf: number; wantSymbols: readonly string[] },
): NewsItem[] {
  const want = new Set(opts.wantSymbols.map((s) => s.trim().toUpperCase()));
  const root = payload as { data?: unknown } | null;
  const rows = Array.isArray(root?.data) ? (root!.data as RawArticle[]) : [];
  const out: NewsItem[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const headline = sanitizeText(row.title, HEADLINE_MAX);
    const publishedAt = isoSeconds(row.published_at);
    if (!headline || publishedAt <= 0) continue;

    const entities = Array.isArray(row.entities) ? (row.entities as RawEntity[]) : [];
    const matched = entities.filter(
      (e) => typeof e?.symbol === "string" && want.has(e.symbol.trim().toUpperCase()),
    );
    if (!matched.length) continue;

    const symbols = [...new Set(matched.map((e) => String(e.symbol).trim().toUpperCase()))];

    // THE STRONGEST MATCH WINS, and its sentiment travels with it. A story
    // about two of our names carries the entity we matched hardest; averaging
    // across entities would blend one company's tone into another's reading.
    const best = matched.reduce((a, b) =>
      (normalizeMatch(b.match_score) ?? 0) > (normalizeMatch(a.match_score) ?? 0) ? b : a,
    );
    const relevance = normalizeMatch(best.match_score) ?? normalizeMatch(row.relevance_score);
    const rawSentiment = num(best.sentiment_score);
    const sentiment =
      rawSentiment === null ? null : Math.min(1, Math.max(-1, rawSentiment));

    const highlights = Array.isArray(best.highlights) ? (best.highlights as { highlight?: unknown }[]) : [];
    const summary =
      sanitizeText(row.description, SUMMARY_MAX) ||
      sanitizeText(row.snippet, SUMMARY_MAX) ||
      sanitizeText(highlights[0]?.highlight, SUMMARY_MAX) ||
      null;

    const url = safeUrl(row.url);
    const source = sanitizeText(row.source, SOURCE_MAX) || "unattributed";
    // The vendor's uuid is used where it exists because it is stable across
    // pages; the content hash is the fallback so an item is never id-less.
    const id =
      typeof row.uuid === "string" && row.uuid.trim() ? row.uuid.trim().slice(0, 64) : stableId(url, headline);

    out.push({ id, source, publishedAt, headline, summary, url, symbols, relevance, sentiment });
  }

  // Newest first, so `dedupeNews` downstream keeps the freshest copy of a story
  // that was syndicated more than once.
  return out.sort((a, b) => b.publishedAt - a.publishedAt);
}

/** Never let a token that a vendor echoed back reach a log line. */
function scrub(text: string, key: string): string {
  return key ? text.split(key).join("***") : text;
}

/**
 * One batched request for every symbol the fleet needs this window.
 *
 * BATCHED ON PURPOSE. The binding constraint on this vendor is requests per
 * day, not articles per request, so one call naming eight symbols costs what
 * one call naming one symbol costs. The orchestrator turns that budget into a
 * refresh interval; this function just spends one unit of it.
 *
 * NO RETRIES, matching `venues/research.ts`. A vendor that did not answer is a
 * fact about this window, and a retry inside a pass that runs every fifteen
 * seconds is a way to burn a daily allowance in an afternoon.
 */
export async function fetchMarketauxNews(args: {
  apiKey: string;
  symbols: readonly string[];
  asOf: number;
  /** How far back to ask. Defaults to the desk's own research window. */
  windowSec?: number;
  /** Articles per request. The free tier caps this at 3; paid tiers allow more. */
  limit?: number;
  timeoutMs?: number;
  /** Injected by the tests. Production passes nothing and gets global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<NewsFetchResult> {
  const asked = [...new Set(args.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!args.apiKey) {
    return {
      ok: false,
      failure: "no-key",
      detail: "no news provider token is configured for this deployment",
      asked,
    };
  }
  if (!asked.length) return { ok: false, failure: "no-symbols", detail: "nothing to ask about", asked };

  const from = new Date((args.asOf - (args.windowSec ?? NEWS_WINDOW_SEC)) * 1000)
    .toISOString()
    .slice(0, 19);
  const qs = new URLSearchParams({
    api_token: args.apiKey,
    symbols: asked.join(","),
    // Entity-filtered: without this the provider returns stories that merely
    // mention the ticker in passing, and the desk would report them as coverage.
    filter_entities: "true",
    must_have_entities: "true",
    language: "en",
    published_after: from,
    limit: String(args.limit ?? 3),
  });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), args.timeoutMs ?? TIMEOUT_MS);
  try {
    const doFetch = args.fetchImpl ?? fetch;
    const res = await doFetch(ENDPOINT + "?" + qs.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: ctl.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        failure: "http-error",
        detail: "the provider answered " + res.status,
        asked,
      };
    }
    const body = await readBoundedJson<unknown>(res, MAX_RESPONSE_BYTES);
    if (!body.ok) {
      return { ok: false, failure: "unreadable", detail: scrub(body.detail, args.apiKey), asked };
    }
    const err = (body.value as { error?: { message?: unknown } } | null)?.error;
    if (err) {
      const message = typeof err.message === "string" ? err.message : "unspecified";
      return { ok: false, failure: "vendor-error", detail: scrub(message.slice(0, 200), args.apiKey), asked };
    }
    return { ok: true, items: normalizeMarketaux(body.value, { asOf: args.asOf, wantSymbols: asked }), asked };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, failure: "unreachable", detail: scrub(detail.slice(0, 200), args.apiKey), asked };
  } finally {
    clearTimeout(timer);
  }
}

/** Exposed so the tests pin the endpoint and the caps rather than restating them. */
export const MARKETAUX_GUARDS = {
  ENDPOINT,
  MAX_RESPONSE_BYTES,
  TIMEOUT_MS,
  HEADLINE_MAX,
  SUMMARY_MAX,
  SOURCE_MAX,
} as const;
