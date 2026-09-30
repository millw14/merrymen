/**
 * THE HEY RESEARCH LAB ADAPTER — the only file in this repository that knows
 * the name.
 *
 * Everything above it speaks `BuilderRecord` from `builder.ts`; everything
 * below it is one directory's JSON. That boundary is the requirement and it is
 * the same one the news adapter holds against its vendor: Brain must not
 * know this directory exists. It does not — the Brain service receives rendered
 * blocks built from our own schema, and a grep for the name across
 * `services/brain/` returns nothing. There is a test.
 *
 * ── HOW THIS VENDOR DIFFERS FROM THE NEWS VENDOR, AND WHAT THAT CHANGES ──
 *
 * `research-pass.ts` is four hundred lines of rotation, TTL derivation and
 * symbol budgeting, and every line of it exists because the news vendor allows
 * requests in the LOW HUNDREDS PER DAY. None of that machinery belongs here and
 * copying it would be cargo cult: this directory answers a documented 120 per
 * minute unauthenticated, more with a key, from a database read of about
 * 200ms, and caches sixty seconds on its own side. A plain per-contract lookup
 * behind a short cache is the whole design.
 *
 * A KEY IS OPTIONAL, WHICH IS ALSO NEW. The news adapter returns `no-key`
 * because it cannot ask at all without one. Here an absent key is a lower rate
 * limit and nothing else, so the request is made anyway and the credential is
 * simply not attached. That is why there is no `no-key` failure in
 * `BuilderFetchFailure`: it would be a refusal to ask a question we are allowed
 * to ask.
 *
 * WHAT STAYS IDENTICAL, because neither is about this vendor's generosity:
 *
 *   THE KEY NEVER LEAVES ONE PROCESS. It is read from the environment by the
 *   ORCHESTRATOR, which is the only component that calls this function, and
 *   `CHILD_SECRET_STRIP` removes it from every child's environment — so a
 *   tenant worker, the Brain service, a persisted decision and a prompt all
 *   cannot contain it, because none of them ever holds it. This module reads
 *   the environment nowhere — there is a test, and it greps this file, so the
 *   sentence is deliberately written without naming the accessor it forbids.
 *   The key arrives as an argument, which a process that does not hold one
 *   cannot supply. `scrub` is the belt to that braces.
 *
 *   THE NORMALISER IS THE ONLY ROUTE IN, so every string that came from outside
 *   is sanitised on the way through and a second directory added later cannot
 *   forget to do it.
 *
 * ── THE TWO SHAPES OF "NO" ───────────────────────────────────────────────
 *
 * This API answers `found: false` for two completely different reasons and it
 * is the one thing an integrator can get wrong without ever noticing:
 *
 *   NOT LISTED   the directory holds no page for this contract. Common — most
 *                launchpad coins — and a fact about COVERAGE. It is a record,
 *                it is cacheable, and `builder.ts` explains at length why it
 *                must never render as a negative finding.
 *   WRONG CHAIN  the address was not on the chain this directory indexes. A
 *                fact about US, returned with `reason: "chain"`. It is a
 *                FAILURE, not a record, because caching it would let one
 *                misconfigured chain id quietly report an entire universe as
 *                unlisted.
 *
 * AND THE TRAP THAT MAKES IT EASY TO MISS: the wrong-chain response still
 * echoes `chainId: 4663` — the chain the directory indexes, not the chain that
 * was asked about. Measured 2026-09-22. So `reason` is read and `chainId` is
 * not treated as confirmation of anything.
 */

import { readBoundedJson } from "../bounded-read";
import { sanitizeText } from "./news";
import {
  ADDRESS_RE,
  unlisted,
  type BuilderFetchFailure,
  type BuilderRecord,
} from "./builder";

/** The directory's endpoint. Fixed here, never configurable — see safe-url.ts. */
const ENDPOINT = "https://heyresearch.xyz/api/v1/scan";

/**
 * The only chain this directory indexes, stated rather than passed.
 *
 * The parameter is optional on their side and defaults to the same value; it is
 * sent explicitly so that the day a deployment points at another chain, the
 * answer is an honest `wrong-chain` failure instead of a silent lookup against
 * a corpus that was never about the token in hand.
 */
const CHAIN_ID = 4663;

/** Bounds on the response body. One scan is about a kilobyte; this is generous. */
const MAX_RESPONSE_BYTES = 64_000;
/** Well above a ~200ms database read, well below anything that could stall a pass. */
const TIMEOUT_MS = 8_000;

/** Caps applied to every piece of vendor text before it is stored. */
const NAME_MAX = 80;
const SYMBOL_MAX = 32;
const STATUS_MAX = 48;
const HELP_MAX = 240;
const DISCLAIMER_MAX = 480;
const DETAIL_MAX = 200;

/**
 * A ceiling on any count the directory reports.
 *
 * Not defensive padding: these numbers are rendered into a sentence an analyst
 * reads, and a vendor bug that sends 4e9 commits would produce a block that is
 * both absurd and confidently worded. Anything past this is treated as
 * unreadable — null, never a clamp — because a silently truncated count is a
 * number we made up.
 */
const COUNT_MAX = 1_000_000;

export type BuilderFetchResult =
  | { ok: true; record: BuilderRecord }
  | {
      ok: false;
      failure: BuilderFetchFailure;
      detail: string;
      /** Seconds the directory asked us to wait. Only ever set on `rate-limited`. */
      retryAfterSec?: number;
    };

/** One scan as this directory sends it. Only the fields we actually read. */
interface RawScan {
  found?: unknown;
  reason?: unknown;
  status?: unknown;
  status_label?: unknown;
  status_help?: unknown;
  verified_builder?: unknown;
  activity?: unknown;
  project?: unknown;
  project_url?: unknown;
  cta?: unknown;
  disclaimer?: unknown;
}

/**
 * A count, or null.
 *
 * NULL FOR EVERYTHING THAT IS NOT A PLAIN NON-NEGATIVE INTEGER, including a
 * float, a numeric string and a value past `COUNT_MAX`. The whole point of the
 * nullable fields in `BuilderActivity` is that "we do not know" survives the
 * trip, and every coercion that turns an unreadable value into `0` destroys
 * exactly that.
 */
function count(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  return v >= 0 && v <= COUNT_MAX ? v : null;
}

/** A tri-state boolean. Anything that is not a boolean is UNKNOWN, not false. */
function flag(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** An ISO calendar date, or null. Never a parsed clock — the string is the claim. */
function isoDate(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
}

/** https only, and never rendered into a prompt — kept so a human can follow it. */
function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}

/**
 * Directory JSON to our schema. PURE — no network, no clock beyond `asOf`.
 *
 * `found: false` short-circuits to `unlisted()` BEFORE any other field is read,
 * which is deliberate and is the invariant this function exists to hold. A
 * not-found body carries no status, no counts and no project, and reading
 * around it for whatever happens to be present is how a record that means "we
 * have no page" acquires a verdict it was never given.
 */
export function normalizeHey(
  payload: unknown,
  opts: { address: string; asOf: number },
): BuilderRecord {
  const address = opts.address.trim().toLowerCase();
  const row = (payload ?? {}) as RawScan;
  if (row.found !== true) return unlisted(address, opts.asOf);

  const project = (row.project ?? {}) as { name?: unknown; symbol?: unknown };
  const activity = (row.activity ?? {}) as {
    commits_30d?: unknown;
    commits_30d_partial?: unknown;
    releases_30d?: unknown;
    ships_30d?: unknown;
    last_ship?: unknown;
  };
  const cta = (row.cta ?? {}) as { url?: unknown };

  return {
    address,
    readAt: opts.asOf,
    found: true,
    name: sanitizeText(project.name, NAME_MAX) || null,
    symbol: sanitizeText(project.symbol, SYMBOL_MAX) || null,
    // The human-readable label is preferred and the machine key is the
    // fallback, so a directory that adds a status we have never seen is
    // rendered in its own words rather than dropped.
    status:
      sanitizeText(row.status_label, STATUS_MAX) || sanitizeText(row.status, STATUS_MAX) || null,
    statusHelp: sanitizeText(row.status_help, HELP_MAX) || null,
    verified: flag(row.verified_builder),
    activity: {
      commits30d: count(activity.commits_30d),
      // A FLOOR IS NOT A TOTAL. Undocumented on their side and observed in
      // production on 2026-09-22 ("100+ commits since…"), so it is read
      // defensively: anything other than an explicit `true` is a complete
      // count, because assuming partial would understate a real number.
      commitsPartial: activity.commits_30d_partial === true,
      releases30d: count(activity.releases_30d),
      ships30d: count(activity.ships_30d),
      lastShip: isoDate(activity.last_ship),
    },
    url: safeUrl(row.project_url) ?? safeUrl(cta.url),
    disclaimer: sanitizeText(row.disclaimer, DISCLAIMER_MAX) || null,
  };
}

/** Never let a key that a vendor echoed back reach a log line. */
function scrub(text: string, key: string): string {
  return key ? text.split(key).join("***") : text;
}

/** `Retry-After` in seconds, when the header is one we can act on. */
function retryAfter(res: { headers: { get(name: string): string | null } }): number | undefined {
  const raw = res.headers?.get?.("retry-after");
  if (!raw) return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? Math.min(3600, Math.floor(n)) : undefined;
}

/**
 * One lookup, for one contract.
 *
 * NOT BATCHED, unlike the news adapter, because there is nothing to batch: the
 * API is keyed on a single contract and offers no list endpoint. That is also
 * the ceiling on what this integration can ever be — the directory can ENRICH a
 * candidate that discovery already found, and can never be a source of
 * candidates.
 *
 * NO RETRIES, matching `venues/research.ts` and the news adapter. A directory
 * that did not answer is a fact about this window. `rate-limited` carries the
 * wait the directory asked for so the caller can honour it rather than guess.
 */
export async function fetchBuilderRecord(args: {
  /** The contract to look up. */
  address: string;
  /** Optional. An absent key is a lower rate limit, not a refusal — see above. */
  apiKey?: string;
  asOf: number;
  timeoutMs?: number;
  /** Injected by the tests. Production passes nothing and gets global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<BuilderFetchResult> {
  const address = args.address.trim().toLowerCase();
  const key = args.apiKey ?? "";
  // CHECKED BEFORE A REQUEST IS SPENT. The directory answers 400 to a malformed
  // address, and spending a call to be told what a regex knows is a way to
  // reach a rate limit with our own bugs.
  if (!ADDRESS_RE.test(address)) {
    return { ok: false, failure: "bad-address", detail: "not a 20-byte hex address" };
  }

  const qs = new URLSearchParams({ chain: String(CHAIN_ID), token: address });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), args.timeoutMs ?? TIMEOUT_MS);
  try {
    const doFetch = args.fetchImpl ?? fetch;
    const res = await doFetch(ENDPOINT + "?" + qs.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(key ? { authorization: "Bearer " + key } : {}),
      },
      signal: ctl.signal,
    });
    if (!res.ok) {
      // THREE STATUSES THAT MEAN THREE DIFFERENT THINGS ABOUT US. 400 is a
      // malformed address that slipped past the guard above, 401 is a key the
      // house got wrong, 429 is our own cadence. None of them is a fact about
      // the token, and a single `http-error` would have made all three look
      // like one.
      const failure: BuilderFetchFailure =
        res.status === 400
          ? "bad-address"
          : res.status === 401
            ? "unauthorized"
            : res.status === 429
              ? "rate-limited"
              : "http-error";
      return {
        ok: false,
        failure,
        detail: "the directory answered " + res.status,
        ...(failure === "rate-limited" ? { retryAfterSec: retryAfter(res) } : {}),
      };
    }
    const body = await readBoundedJson<unknown>(res, MAX_RESPONSE_BYTES);
    if (!body.ok) {
      return { ok: false, failure: "unreadable", detail: scrub(body.detail, key) };
    }
    const row = (body.value ?? {}) as RawScan;
    // READ `reason`, NOT `chainId` — see the module comment. The wrong-chain
    // answer echoes the chain the directory indexes, so the id proves nothing.
    if (row.found !== true && row.reason === "chain") {
      return {
        ok: false,
        failure: "wrong-chain",
        detail: "the directory does not index the chain this address is on",
      };
    }
    return { ok: true, record: normalizeHey(body.value, { address, asOf: args.asOf }) };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, failure: "unreachable", detail: scrub(detail.slice(0, DETAIL_MAX), key) };
  } finally {
    clearTimeout(timer);
  }
}

/** Exposed so the tests pin the endpoint and the caps rather than restating them. */
export const HEY_GUARDS = {
  ENDPOINT,
  CHAIN_ID,
  MAX_RESPONSE_BYTES,
  TIMEOUT_MS,
  NAME_MAX,
  SYMBOL_MAX,
  STATUS_MAX,
  HELP_MAX,
  DISCLAIMER_MAX,
  COUNT_MAX,
} as const;
