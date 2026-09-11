/**
 * WHEN TO SPEND A VENDOR REQUEST, AND ON WHICH SYMBOLS.
 *
 * The scheduling half of the news desk. It exists because the constraint that
 * actually binds is not latency or tokens — it is REQUESTS PER DAY, a number in
 * the low hundreds, against a fleet that wakes several times an hour and grows
 * by tenant. Left implicit, that budget is spent by lunchtime and every
 * afternoon decision is blind while believing itself informed.
 *
 * BRAIN WAKING DOES NOT IMPLY FETCHING. The refresh runs on this module's own
 * clock inside the orchestrator; a child reads whatever file is there. Ten
 * agents thinking at once cost zero requests.
 *
 * THE THREE NUMBERS, and how each is derived rather than chosen:
 *
 *   ttlSec       86400 / (daily allowance, less a tenth held back) — the
 *                fastest refresh the allowance can sustain for a whole day,
 *                floored at five minutes and capped at an hour. If the budget
 *                cannot afford hourly refresh, the answer is fewer symbols, not
 *                a staler desk.
 *   maxSymbols   never more than the articles one request may return. This is
 *                the honesty constraint and it is easy to miss: asking about
 *                eight symbols on a tier that returns three stories guarantees
 *                five symbols come back empty, and the desk would report those
 *                five as "we asked and the world was quiet" when the truth is
 *                that they were crowded out. A symbol we cannot actually hear
 *                about must be reported as not-fetched, not as quiet.
 *   rotation     when the fleet wants more symbols than one request can carry,
 *                the window index selects which slice is asked. Deterministic,
 *                so a replay of window N asks what window N asked.
 *
 * Batching is free in the only currency that matters: one request naming three
 * symbols costs exactly what one request naming one symbol costs.
 */

import { fetchMarketauxNews, type NewsFetchFailure } from "./research/marketaux";
import { NEWS_WINDOW_SEC, dedupeNews, type NewsItem } from "./research/news";

/**
 * How many stories the desk keeps.
 *
 * A CAP, not a target. The window already drops anything older than 24h, so
 * this only binds on a genuinely busy tape — and the file is written to a
 * child home on every fetch, so an unbounded list is an unbounded write.
 * Comfortably above the 3-articles-from-2-publishers a reading needs, for many
 * more symbols than one window asks about.
 */
const NEWS_CACHE_MAX = 200;

/** Requests we assume are available in a day when nothing says otherwise. */
export const DEFAULT_DAILY_LIMIT = 100;
/** Articles one request may return. The free tier's ceiling; paid tiers raise it. */
export const DEFAULT_ARTICLES_PER_REQUEST = 3;
/** Never refresh faster than this, whatever the allowance permits. */
const MIN_TTL_SEC = 300;
/**
 * The freshness we WANT, and deliberately not a clamp.
 *
 * Capping the window here was the first version and it was wrong in exactly the
 * way this module exists to avoid. On a small allowance a one-hour cap means
 * twenty-four refreshes against ten permitted requests: the ledger then stops
 * the desk dead at request ten, and the fleet reasons with no news at all from
 * mid-morning onward while the plan line still promises hourly news. Letting
 * the window stretch spends the same allowance evenly across the whole day and
 * says out loud that it is doing so. The budget wins; the preference is a
 * preference.
 */
const PREFERRED_MAX_TTL_SEC = 3600;
/** But refresh at least once a day, whatever the allowance. */
const ABSOLUTE_MAX_TTL_SEC = 86_400;
/** Hold back a tenth of the day's allowance for the passes that fail and matter. */
const RESERVE_FRACTION = 0.1;
/** A hard ceiling on one request's symbol list, independent of the tier. */
const MAX_BATCH_SYMBOLS = 10;

export interface NewsWindowPlan {
  ttlSec: number;
  maxSymbols: number;
  why: string;
}

export function planNewsWindow(
  dailyLimit = DEFAULT_DAILY_LIMIT,
  articlesPerRequest = DEFAULT_ARTICLES_PER_REQUEST,
  /**
   * An operator's own refresh interval, overriding the derived one.
   *
   * The derived window is a DEFAULT chosen so the allowance lasts a whole day,
   * not a law: a paid tier may want a five-minute desk and a shared key may
   * want an hourly one. Overriding it is exactly how the daily ledger below
   * becomes reachable, which is the honest description of that guard — it is
   * the backstop for a cadence somebody chose, not for the one we compute.
   */
  windowSec?: number,
): NewsWindowPlan {
  const usable = Math.max(1, Math.floor(dailyLimit * (1 - RESERVE_FRACTION)));
  const raw = windowSec && windowSec > 0 ? windowSec : Math.ceil(86_400 / usable);
  const ttlSec = Math.min(ABSOLUTE_MAX_TTL_SEC, Math.max(MIN_TTL_SEC, raw));
  const maxSymbols = Math.max(1, Math.min(MAX_BATCH_SYMBOLS, Math.floor(articlesPerRequest)));
  const slow =
    ttlSec > PREFERRED_MAX_TTL_SEC
      ? " — SLOWER THAN THE HOUR THIS DESK WANTS, because the allowance cannot pay for it"
      : "";
  const chosen = windowSec && windowSec > 0 ? " (interval set by the operator, not derived)" : "";
  return {
    ttlSec,
    maxSymbols,
    why:
      "refresh every " + Math.round(ttlSec / 60) + "m (" + Math.floor(86_400 / ttlSec) +
      " requests/day against an allowance of " + dailyLimit + ", a tenth held back), " +
      "at most " + maxSymbols + " symbol(s) per request because a request returns at most " +
      articlesPerRequest + " article(s) and a symbol we cannot hear about must not be " +
      "reported as quiet" + slow + chosen,
  };
}

/**
 * Which slice of the fleet's wanted symbols this window asks about.
 *
 * The rotation is anchored on the window index so the same window always
 * produces the same ask, and when everything fits, everything is asked and
 * rotation never runs.
 *
 * `alwaysAsk` IS THE PART THAT HAD TO BE ADDED. The caller passes its symbols
 * in priority order and this function used to throw that order away the moment
 * rotation ran: `start` is derived from the clock, so a held position could sit
 * unheard-about for hours while the window walked a watch universe of names
 * nobody owns. Production showed it — the fleet held TSLA and asked about
 * GOOGL, AMZN and NVDA. Priority order that only survives while it makes no
 * difference is not priority order.
 *
 * So held names take their slots first and the rotation fills what is left. If
 * the held book alone is larger than one request can carry, the rotation runs
 * INSIDE it — a big book still gets round-robin coverage, and never loses a
 * slot to a name it does not own.
 */
export function chooseSymbols(
  wanted: readonly string[],
  opts: { maxSymbols: number; asOf: number; ttlSec: number; alwaysAsk?: readonly string[] },
): string[] {
  const norm = (xs: readonly string[]): string[] => [
    ...new Set(xs.map((s) => s.trim().toUpperCase()).filter(Boolean)),
  ];
  const uniq = norm(wanted);
  if (uniq.length <= opts.maxSymbols) return uniq;

  const window = Math.floor(opts.asOf / Math.max(1, opts.ttlSec));
  const slice = (pool: readonly string[], n: number): string[] => {
    if (n <= 0 || pool.length === 0) return [];
    if (pool.length <= n) return [...pool];
    const start = (window * n) % pool.length;
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) out.push(pool[(start + i) % pool.length]!);
    return [...new Set(out)];
  };

  const held = norm(opts.alwaysAsk ?? []).filter((s) => uniq.includes(s));
  const first = slice(held, opts.maxSymbols);
  const rest = uniq.filter((s) => !first.includes(s));
  return [...first, ...slice(rest, opts.maxSymbols - first.length)];
}

/** What the desk holds right now, and how it came to hold it. */
export interface NewsDeskState {
  /** Unix seconds of the last SUCCESSFUL answer. 0 when there has never been one. */
  fetchedAt: number;
  /**
   * THE SYMBOLS THIS DESK CAN SPEAK FOR, and it is a WINDOW, not a window's ask.
   *
   * It used to be exactly the last request's three symbols, which threw away
   * coverage of everything else the moment the scheduler moved on. `items` was
   * already merged across windows — the desk keeps 24h of stories it paid for —
   * but `news.ts` checks THIS list first, before the cache is ever consulted,
   * and returns `not-fetched` with a null reading for anything absent from it.
   * So five fresh NVDA stories sitting in `items` were discarded outright
   * because the most recent window happened to ask about AAPL, MU and SPCX.
   *
   * Derived from `askedAt` below and bounded by the same 24h window the stories
   * are, so the two can never disagree: a symbol is claimed exactly as long as
   * its material could still be selected.
   */
  asked: string[];
  /**
   * When each symbol was last actually asked about, unix seconds.
   *
   * The reason coverage can be merged without lying. A naive union of every
   * symbol ever asked would report a three-day-old ask as current — trading one
   * false statement for another — so coverage expires on the same clock as the
   * stories it describes.
   */
  askedAt: Record<string, number>;
  failure: string | null;
  items: NewsItem[];
}

/**
 * Coverage after this window: what is still in date, plus what we just asked.
 *
 * `add` is stamped at `asOf`; everything carried over keeps its own timestamp
 * and drops out once it is older than the window. Pure, so the retention rule
 * is testable without a clock or a provider.
 */
export function retainAsked(
  prev: Record<string, number>,
  add: readonly string[],
  asOf: number,
  windowSec: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [sym, at] of Object.entries(prev)) {
    if (at > asOf - windowSec) out[sym] = at;
  }
  for (const sym of add) out[sym] = asOf;
  return out;
}

/** The covered list, newest ask first so a log line reads usefully. */
export function coveredSymbols(askedAt: Record<string, number>): string[] {
  return Object.entries(askedAt)
    .sort((a, b) => b[1] - a[1])
    .map(([sym]) => sym);
}

export interface NewsDeskConfig {
  /** Empty when the house configured none. The desk then fails honestly. */
  apiKey: string;
  dailyLimit?: number;
  articlesPerRequest?: number;
  /** Operator override for the refresh interval. Derived from the allowance if unset. */
  windowSec?: number;
  fetchImpl?: typeof fetch;
}

export interface NewsDesk {
  /** Refresh if the window has elapsed and the day's allowance permits. */
  /**
   * @param wanted every symbol the fleet cares about, in priority order.
   * @param alwaysAsk the ones with a position behind them. They keep their
   *   slots when the allowance cannot carry the whole universe.
   */
  refresh(
    wanted: readonly string[],
    asOf: number,
    alwaysAsk?: readonly string[],
  ): Promise<{ fetched: boolean; log: string | null }>;
  state(): NewsDeskState;
  plan(): NewsWindowPlan;
}

/** UTC, so the allowance resets on the same boundary the vendor's does. */
const dayKey = (asOf: number): string => new Date(asOf * 1000).toISOString().slice(0, 10);

/**
 * The fleet's one news desk, with its own cache and its own daily ledger.
 *
 * ONE PER ORCHESTRATOR PROCESS. A second instance would keep a second ledger
 * and the two would spend the same allowance twice.
 *
 * A FAILED FETCH DOES NOT DISCARD THE LAST GOOD ONE. It records the failure and
 * keeps the items, because a window-old story is still a story and the reader
 * has `fetchedAt` to judge it by. What it must not do — and does not — is
 * report the stale window as a fresh success.
 */
export function makeNewsDesk(cfg: NewsDeskConfig): NewsDesk {
  const plan = planNewsWindow(cfg.dailyLimit, cfg.articlesPerRequest, cfg.windowSec);
  let state: NewsDeskState = { fetchedAt: 0, asked: [], askedAt: {}, failure: null, items: [] };
  let ledger = { day: "", used: 0 };
  let lastAttemptAt = 0;

  const limit = cfg.dailyLimit ?? DEFAULT_DAILY_LIMIT;

  return {
    plan: () => plan,
    state: () => ({ ...state, asked: [...state.asked], askedAt: { ...state.askedAt }, items: [...state.items] }),

    async refresh(wanted, asOf, alwaysAsk) {
      // ATTEMPTS ARE RATE-LIMITED, NOT SUCCESSES. Keying the window on
      // `fetchedAt` would let a provider outage turn a fifteen-second
      // orchestrator pass into a fifteen-second retry loop and burn the day's
      // allowance in under an hour.
      if (asOf - lastAttemptAt < plan.ttlSec) return { fetched: false, log: null };

      const symbols = chooseSymbols(wanted, {
        maxSymbols: plan.maxSymbols,
        asOf,
        ttlSec: plan.ttlSec,
        alwaysAsk,
      });
      if (!symbols.length) return { fetched: false, log: null };

      const today = dayKey(asOf);
      if (ledger.day !== today) ledger = { day: today, used: 0 };
      if (ledger.used >= limit) {
        lastAttemptAt = asOf;
        // A GENUINE UNAVAILABILITY, and it says which. The desk reports
        // fetch-failed rather than pretending the world was quiet.
        // Same rule as a failed fetch: the allowance is spent, so these symbols
        // were not asked about and coverage must not claim they were. What is
        // already in date stays in date.
        const askedAt = retainAsked(state.askedAt, [], asOf, NEWS_WINDOW_SEC);
        state = { ...state, askedAt, asked: coveredSymbols(askedAt), failure: "budget-exhausted" };
        return {
          fetched: false,
          log: "news: the day's allowance of " + limit + " request(s) is spent — no fetch this window",
        };
      }

      lastAttemptAt = asOf;
      ledger.used += 1;
      const r = await fetchMarketauxNews({
        apiKey: cfg.apiKey,
        symbols,
        asOf,
        limit: cfg.articlesPerRequest ?? DEFAULT_ARTICLES_PER_REQUEST,
        fetchImpl: cfg.fetchImpl,
      });

      if (!r.ok) {
        // A FAILED WINDOW DOES NOT EXTEND COVERAGE, and does not revoke it.
        //
        // The symbols we just tried were not answered, so stamping them would
        // claim a fetch that did not happen. The symbols already in date were
        // answered, earlier, and their stories are still here — revoking them
        // because an unrelated request failed would blame the provider for
        // material we already hold. So coverage is carried and expired, and
        // nothing new is added.
        const askedAt = retainAsked(state.askedAt, [], asOf, NEWS_WINDOW_SEC);
        state = {
          fetchedAt: state.fetchedAt,
          askedAt,
          asked: coveredSymbols(askedAt),
          failure: r.failure,
          items: state.items,
        };
        return {
          fetched: false,
          log: newsFailureLine(r.failure, r.detail, r.asked, ledger.used, limit),
        };
      }

      // ── MERGED, NOT REPLACED, AND THAT IS THE WHOLE FIX ─────────────────
      //
      // This was `items: r.items`, which threw away every story the previous
      // request had paid for. `news-sentiment` needs THREE scored articles from
      // TWO publishers about ONE symbol inside a 24h window, and a request
      // fetches a handful of articles across at most three symbols — so the
      // cache never held enough about anything to produce a reading, and that
      // lens reported no-data forever. Arithmetically unreachable, not unlucky.
      //
      // NOTHING IS INVENTED BY KEEPING THEM. The point-in-time rule is enforced
      // downstream and is untouched: selectNews and aggregateNewsSentiment both
      // filter on `publishedAt <= asOf`, so a story cannot influence a decision
      // dated before it was published, however long it has been in the cache.
      // What changes is only that the desk stops discarding evidence it already
      // bought.
      //
      // BOUNDED TWO WAYS. Stories older than the window can never be selected,
      // so they are dropped here rather than accumulating; and the list is
      // capped so a busy tape cannot grow the file without limit. dedupeNews is
      // the existing rule for "the same story twice" — the ids are stable
      // across fetches precisely so this works.
      const fresh = dedupeNews([...r.items, ...state.items]).filter(
        (it) => it.publishedAt > asOf - NEWS_WINDOW_SEC,
      );
      // ── AND COVERAGE IS MERGED TOO, WHICH IS THE OTHER HALF OF THAT FIX ──
      //
      // Merging `items` alone bought nothing, because `news.ts` checks `asked`
      // FIRST and returns a null reading for any symbol absent from it. So the
      // stories this desk had already paid for were still thrown away — not
      // deleted, just unreachable — the moment the scheduler asked about three
      // different names. A 25-symbol universe against 3 slots meant a given
      // symbol was speakable-for roughly one window in eight.
      //
      // BOUNDED BY THE SAME CLOCK AS THE STORIES. Coverage expires after the
      // same 24h window, so the desk can never claim a three-day-old ask as
      // current — that would be a different false statement, not a fix. And the
      // ask itself is unchanged: still at most `maxSymbols` names, still one
      // request, still the same daily ledger. Nothing here spends more budget;
      // it stops discarding what the budget already bought.
      const askedAt = retainAsked(state.askedAt, r.asked, asOf, NEWS_WINDOW_SEC);
      state = {
        fetchedAt: asOf,
        askedAt,
        asked: coveredSymbols(askedAt),
        failure: null,
        items: fresh.slice(0, NEWS_CACHE_MAX),
      };
      return {
        fetched: true,
        log:
          "news: " + r.items.length + " story/stories for " + r.asked.join(",") +
          " (request " + ledger.used + "/" + limit + " today, next in " +
          Math.round(plan.ttlSec / 60) + "m)",
      };
    },
  };
}

/**
 * The failure line, phrased so an operator can tell whose fault it is.
 *
 * `no-key` is OUR gap and reads as one — it is the case the whole honesty rule
 * was written for, where a desk reports no-data and the truth is that nobody
 * ever asked. The rest are the provider's, and they say so.
 */
export function newsFailureLine(
  failure: NewsFetchFailure,
  detail: string,
  asked: readonly string[],
  used: number,
  limit: number,
): string {
  const who =
    failure === "no-key"
      ? "NOT CONFIGURED — no news provider token is set, so this desk has never asked anything"
      : failure === "no-symbols"
        ? "nothing to ask about"
        : "the provider did not answer (" + failure + ": " + detail + ")";
  return "news: " + who + " · asked " + (asked.join(",") || "nothing") + " · " + used + "/" + limit + " today";
}
