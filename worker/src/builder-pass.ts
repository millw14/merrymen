/**
 * WHEN TO SPEND A BUILDER LOOKUP, AND ON WHICH CONTRACTS.
 *
 * The scheduling half of the builder desk, and it is deliberately a tenth the
 * size of `research-pass.ts`. That module is four hundred lines of rotation,
 * TTL derivation and symbol budgeting because the news vendor allows requests
 * in the LOW HUNDREDS PER DAY, and every line of it is an answer to that
 * number. This directory answers 120 a minute unauthenticated from a database
 * read, so the binding constraint is not an allowance at all — it is that a
 * fleet with two hundred discovered candidates must not fire two hundred
 * requests inside one fifteen-second pass.
 *
 * So there is a per-pass ceiling, a cache, and nothing else. No rotation index,
 * no derived window, no honesty constraint about how many names one request can
 * carry — this API answers about ONE contract per call, which removes the whole
 * class of problem that made the news scheduler complicated.
 *
 * ── TWO LIFETIMES, BECAUSE TWO DIFFERENT THINGS ARE BEING CACHED ─────────
 *
 * A FOUND record ages on the timescale its numbers move: commits and ships are
 * daily events, so a few hours old is a fair reading and the renderer says so
 * when it is older.
 *
 * AN UNLISTED record ages on the timescale of somebody submitting a project to
 * a directory, which is not a daily event. It also describes the overwhelming
 * majority of a launchpad universe, and re-asking about every unlisted coin on
 * every pass is precisely how a free rate limit becomes a problem we created
 * for ourselves. So it is cached for much longer, and the cost of that is
 * bounded and worth naming: a project listed this morning is not seen until
 * this evening. A lens that arrives late is a lens that arrives; a rate limit
 * spent on two hundred known-empty answers is one that is not available for
 * the coin the agent is actually about to buy.
 *
 * ── A FAILURE IS NEVER CACHED AS A RECORD ────────────────────────────────
 *
 * The distinction `hey.ts` draws between the two shapes of "no" is only worth
 * drawing if this file honours it. An unlisted answer is a RECORD and is
 * stored. A wrong chain, a timeout, a 500, a rate limit — none of those is an
 * answer about the token, so none of them is written, and the lens is simply
 * absent for that contract until something is. Storing a failure as an empty
 * record would turn one bad afternoon into a day of coins silently reported as
 * having no builder.
 *
 * ── AND A RATE LIMIT STOPS THE WHOLE PASS ────────────────────────────────
 *
 * Not just the request that hit it. The limit is per key and per minute, so the
 * next twenty addresses in the queue would hit the same wall; honouring the
 * directory's own `Retry-After` costs us a few minutes of staleness and costs
 * them nothing, which is the trade this side of it should want to make.
 */

import { fetchBuilderRecord } from "./research/hey";
import { ADDRESS_RE, type BuilderRecord } from "./research/builder";

/** How long a FOUND record is quoted without re-asking. */
export const DEFAULT_TTL_SEC = 6 * 3600;
/** How long an UNLISTED record is trusted. See the module comment. */
export const DEFAULT_UNLISTED_TTL_SEC = 24 * 3600;
/**
 * Lookups one pass may spend.
 *
 * The orchestrator's pass runs on a fifteen-second clock, so this is also a
 * rate: twelve every fifteen seconds is well inside 120 a minute even before
 * the cache does any work, and it drains a two-hundred-address fleet universe
 * in about four minutes of wall clock the first time it is ever run.
 */
export const DEFAULT_PER_PASS = 12;
/** A cap on the cache, so a long-lived process cannot grow one without bound. */
const CACHE_MAX = 2_000;

interface Entry {
  record: BuilderRecord;
  at: number;
}

export interface BuilderDeskOptions {
  /** Optional — the directory answers without one at a lower rate limit. */
  apiKey?: string;
  ttlSec?: number;
  unlistedTtlSec?: number;
  perPass?: number;
  /** Injected by the tests. Production passes nothing. */
  fetchImpl?: typeof fetch;
}

export interface BuilderRefresh {
  /** A line for the operator, or null when the pass did nothing worth saying. */
  log: string | null;
  /** How many lookups were actually spent. */
  asked: number;
}

export interface BuilderDesk {
  /**
   * Look up whatever the budget allows, in the order given.
   *
   * ORDER IS THE CALLER'S AND IS HONOURED EXACTLY. The orchestrator puts held
   * coins before candidates for the same reason the news desk does: a position
   * is a live question and a candidate is one of twenty.
   */
  refresh(addresses: readonly string[], now: number): Promise<BuilderRefresh>;
  /** Every cached record among these addresses. Nothing is fetched. */
  recordsFor(addresses: readonly string[], now: number): BuilderRecord[];
  /** One line, at construction, so a deployment says what it will do. */
  plan(): { why: string };
}

/** Lowercased, deduped, malformed dropped, order preserved. */
export function addressesOf(list: readonly unknown[] | undefined): string[] {
  const out = new Set<string>();
  for (const raw of list ?? []) {
    const a = String(raw ?? "").trim().toLowerCase();
    if (ADDRESS_RE.test(a)) out.add(a);
  }
  return [...out];
}

export function makeBuilderDesk(opts: BuilderDeskOptions = {}): BuilderDesk {
  const ttl = Math.max(60, opts.ttlSec ?? DEFAULT_TTL_SEC);
  const unlistedTtl = Math.max(ttl, opts.unlistedTtlSec ?? DEFAULT_UNLISTED_TTL_SEC);
  const perPass = Math.max(1, opts.perPass ?? DEFAULT_PER_PASS);
  const cache = new Map<string, Entry>();
  /** Unix seconds before which no request may be made. Set by a rate limit. */
  let holdUntil = 0;

  const fresh = (e: Entry, now: number): boolean =>
    now - e.at < (e.record.found ? ttl : unlistedTtl);

  return {
    plan() {
      return {
        why:
          `builder desk: ${perPass} lookups per pass, ` +
          `${Math.round(ttl / 60)}m on a listed record and ${Math.round(unlistedTtl / 3600)}h on an unlisted one` +
          (opts.apiKey ? " (keyed)" : " (anonymous — a lower rate limit, not a lesser answer)"),
      };
    },

    recordsFor(addresses, now) {
      const out: BuilderRecord[] = [];
      for (const a of addressesOf(addresses)) {
        const e = cache.get(a);
        // STALE IS STILL AN ANSWER. The renderer states the age of anything
        // past its own staleness threshold, which is a better outcome than a
        // lens that goes silent every time a refresh is behind.
        if (e) out.push(e.record);
      }
      return out;
    },

    async refresh(addresses, now) {
      if (now < holdUntil) {
        return { log: null, asked: 0 };
      }
      const want = addressesOf(addresses);
      let asked = 0;
      let found = 0;
      let unlistedCount = 0;
      let failed: string | null = null;

      for (const address of want) {
        if (asked >= perPass) break;
        const have = cache.get(address);
        if (have && fresh(have, now)) continue;
        asked += 1;
        const r = await fetchBuilderRecord({
          address,
          apiKey: opts.apiKey,
          asOf: now,
          fetchImpl: opts.fetchImpl,
        });
        if (r.ok) {
          // EVICTION IS OLDEST-FIRST AND ONLY WHEN FULL. Map preserves
          // insertion order, and a re-fetch deletes before it sets, so a
          // frequently-refreshed address does not keep its original slot and
          // age out ahead of one nobody asks about.
          cache.delete(address);
          if (cache.size >= CACHE_MAX) {
            const oldest = cache.keys().next();
            if (!oldest.done) cache.delete(oldest.value);
          }
          cache.set(address, { record: r.record, at: now });
          if (r.record.found) found += 1;
          else unlistedCount += 1;
          continue;
        }
        // NOT STORED. See the module comment: a failure is not an answer about
        // the token, and writing one would report an outage as an empty result.
        failed = r.failure;
        if (r.failure === "rate-limited") {
          // The directory's own number when it gave one; otherwise a minute,
          // which is the window its documented limit is measured over.
          holdUntil = now + (r.retryAfterSec ?? 60);
          break;
        }
      }

      if (!asked) return { log: null, asked: 0 };
      const parts = [`builder: asked about ${asked} contract${asked === 1 ? "" : "s"}`];
      if (found) parts.push(`${found} listed`);
      if (unlistedCount) parts.push(`${unlistedCount} not listed`);
      if (failed) parts.push(`last failure ${failed}`);
      if (holdUntil > now) parts.push(`holding off until ${new Date(holdUntil * 1000).toISOString()}`);
      return { log: parts.join(", "), asked };
    },
  };
}
