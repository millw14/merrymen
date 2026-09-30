/**
 * HOW THE SHELL KEEPS ITS DATA FRESH, AND WHAT IT SAYS WHEN IT CANNOT.
 *
 * App refreshed on a fixed 60s interval whose first line was "return unless the
 * first load succeeded". So a first load that failed was never tried again —
 * the owner sat under the raw DOMException, "signal timed out", until they
 * found a button — and a later refresh that DID succeed never cleared the
 * alert, so a healthy screen kept announcing an outage that had ended.
 *
 * NOW EVERY PASS BOOKS THE NEXT ONE, whatever happened to it: a minute after a
 * success, and 5s, 15s, then 60s after failures in a row. The backoff is short
 * at first because the usual failure is a blip, and it stops at a minute
 * because a real outage should not be answered with a request every five
 * seconds from every open tab.
 *
 * ONE PASS AT A TIME. Retry, the timer and the tab becoming visible all land
 * here, and a second pass started while one is in flight would race it to
 * setState with an older answer.
 *
 * BUT A RETRY ASKED FOR MID-PASS IS NOT DROPPED. It is how an order that
 * answered, a sign-in or a new agent says "read the account again, now", and
 * the pass in flight started before that change, so its answer is the old
 * state. The ask is queued, and exactly one more pass runs the moment the one
 * in flight ends, however many times it was asked. The old shell restarted
 * every read to get the same effect.
 *
 * The timers are injected so the schedule can be executed in a test; the shell
 * passes the window's.
 */
import { timeAgo } from "@/lib/time";

export const REFRESH_EVERY_MS = 60_000;
export const RETRY_AFTER_MS = [5_000, 15_000, 60_000] as const;

/**
 * EACH READ ON ITS OWN CLOCK — the cadence of the thing it reads, not of the
 * slowest thing beside it.
 *
 * All of these rode one 60s pass that waited on every read before anything
 * rendered, so a trade that landed sat unseen for up to a minute, and then
 * for as long as the launchpad sweep took on top. Now:
 *
 *   theses       every 10s while the tab is visible — this is the feed, the
 *                one read a person watches for something to happen; once a
 *                minute while hidden, so the tab title can count what arrived
 *   market       every 30s, with the Robinhood quotes, which is the venue's TTL
 *   board        once a minute; a ranking does not move by the second
 *   discoveries  every 2 minutes — the server's own memo lives that long, so
 *                asking sooner is asking for the same bytes
 *   account      once a minute, as before: session, grants and the owner's book
 */
export const THESES_EVERY_MS = 10_000;
export const THESES_HIDDEN_EVERY_MS = 60_000;
export const MARKET_EVERY_MS = 30_000;
export const BOARD_EVERY_MS = 60_000;
export const DISCOVERIES_EVERY_MS = 120_000;
export const ACCOUNT_EVERY_MS = REFRESH_EVERY_MS;

/** How long until the next pass, given how many have failed in a row. */
export function nextRefreshIn(failuresInARow: number): number {
  return nextReadIn(failuresInARow, REFRESH_EVERY_MS);
}

/**
 * The same schedule for a read with its own healthy cadence.
 *
 * The backoff steps are the shell's — 5s, 15s, 60s — because the usual failure
 * is a blip whatever the read. But ONCE SETTLED INTO AN OUTAGE a read never
 * asks faster than it would when healthy: the discoveries read is a two-minute
 * read, and holding it at a minute during an outage would be answering a
 * failure with more requests than success earns, which is the retry-storm
 * shape this repo has already paid for once.
 */
export function nextReadIn(failuresInARow: number, everyMs: number): number {
  if (failuresInARow <= 0) return everyMs;
  const settled = failuresInARow >= RETRY_AFTER_MS.length;
  const step = RETRY_AFTER_MS[Math.min(failuresInARow, RETRY_AFTER_MS.length) - 1]!;
  return settled ? Math.max(step, everyMs) : step;
}

/**
 * Whether a failure was one where NOTHING ANSWERED — the only case the line may
 * call "Can't reach merrymen". A RequestError carries status 0 for it, and a
 * LiveLoadError carries `answered: false`; anything else is merrymen answering
 * and failing, which is a different sentence.
 */
export function nothingAnswered(error: unknown): boolean {
  const e = error as { status?: unknown; answered?: unknown } | null;
  return e?.status === 0 || e?.answered === false;
}

export interface LoopTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

/** What the shell renders from: zero failures means healthy. */
export interface LoopState {
  failuresInARow: number;
  /** When the next pass will run — the countdown. */
  nextAt: number;
  /** When a pass last succeeded; null until one has. */
  lastOkAt: number | null;
  /**
   * The last pass failed with nothing answering at all (see nothingAnswered).
   * False after a success, and after a failure where something did answer.
   */
  silent?: boolean;
}

const WINDOW_TIMERS: LoopTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Runs `pass` now, then keeps running it. `pass` resolves true when every read
 * it needed came back; false or a throw is a failure.
 *
 * `paused` is consulted on TIMER passes only — a hidden tab does no work but
 * keeps its next tick booked. The first pass and `retryNow` always run: one is
 * the page loading, the other is a person asking.
 */
export function startRefreshLoop(opts: {
  pass: () => Promise<boolean>;
  report: (state: LoopState) => void;
  /**
   * Told when a pass starts and when it ends. `report` speaks only when a pass
   * has ended, so without this a Retry pressed during an outage left the line
   * counting down to a retry that was already running, and the button looked
   * like it had done nothing.
   */
  onFlight?: (inFlight: boolean) => void;
  paused?: () => boolean;
  timers?: LoopTimers;
  /**
   * How long a healthy pass waits for the next, in ms — or a function, read
   * each time a pass is booked, for a read whose cadence depends on whether
   * anybody is looking. Defaults to REFRESH_EVERY_MS, the shell's old minute.
   */
  everyMs?: number | (() => number);
}): { retryNow(): void; wake(): void; stop(): void } {
  const t = opts.timers ?? WINDOW_TIMERS;
  const every = () => {
    const e = opts.everyMs ?? REFRESH_EVERY_MS;
    return typeof e === "function" ? e() : e;
  };
  let failuresInARow = 0;
  let lastOkAt: number | null = null;
  let lastStartAt: number | null = null;
  let lastSilent = false;
  let handle: unknown = null;
  /** When the booked pass fires; null while none is booked. */
  let bookedAt: number | null = null;
  let inFlight = false;
  /** A retry was asked for while a pass was in flight: run once more after it. */
  let again = false;
  let stopped = false;

  const book = (ms: number) => {
    if (handle !== null) t.clearTimeout(handle);
    handle = t.setTimeout(tick, ms);
    bookedAt = t.now() + ms;
    return bookedAt;
  };

  const run = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    lastStartAt = t.now();
    if (handle !== null) t.clearTimeout(handle);
    handle = null;
    bookedAt = null;
    opts.onFlight?.(true);
    let ok: boolean;
    let silent = false;
    try {
      ok = await opts.pass();
    } catch (error) {
      ok = false;
      silent = nothingAnswered(error);
    }
    inFlight = false;
    if (stopped) return;
    opts.onFlight?.(false);
    failuresInARow = ok ? 0 : failuresInARow + 1;
    if (ok) lastOkAt = t.now();
    lastSilent = silent;
    const nextAt = book(nextReadIn(failuresInARow, every()));
    opts.report({ failuresInARow, nextAt, lastOkAt, silent });
    if (again) {
      again = false;
      void run();
    }
  };

  function tick() {
    handle = null;
    bookedAt = null;
    if (stopped) return;
    if (opts.paused?.()) {
      // No request from a hidden tab — but the loop must not die of it, or a
      // tab left in the background would come back to data it never refreshes.
      book(nextReadIn(failuresInARow, every()));
      return;
    }
    void run();
  }

  void run();
  return {
    /** Run now — or, if a pass is in flight, once more as soon as it ends. */
    retryNow: () => {
      if (inFlight) {
        again = true;
        return;
      }
      void run();
    },
    /**
     * RUN NOW IF A PASS IS DUE, otherwise leave the booked one alone.
     *
     * For a tab coming back into view. A hidden tab skips its passes, so a
     * read that was due while nobody looked runs the moment somebody does —
     * but one that ran seconds ago is not asked again just because the tab was
     * switched, which from six clocks at once would be a burst per glance.
     *
     * AND A PASS NOT YET DUE IS BROUGHT FORWARD TO WHEN IT IS. The feed's
     * clock books a minute ahead while the tab is hidden; without this, a tab
     * that came back seconds after a hidden pass kept that minute, and the
     * feed a person was now watching refreshed once a minute instead of every
     * ten seconds until it ran out.
     */
    wake: () => {
      if (inFlight || stopped) return;
      const wait = nextReadIn(failuresInARow, every());
      if (lastStartAt === null || t.now() - lastStartAt >= wait) {
        void run();
        return;
      }
      const dueAt = lastStartAt + wait;
      if (bookedAt === null || bookedAt > dueAt) {
        const nextAt = book(dueAt - t.now());
        // A failing clock's countdown is on the outage line, so it must move
        // with the booking; a healthy one's is nobody's business.
        if (failuresInARow > 0) opts.report({ failuresInARow, nextAt, lastOkAt, silent: lastSilent });
      }
    },
    stop: () => {
      stopped = true;
      if (handle !== null) t.clearTimeout(handle);
      handle = null;
    },
  };
}

/** Which half of the outage line a read belongs to — see failureCopy. */
export type Half = "account" | "market";

export interface ClockSpec {
  key: string;
  half: Half;
  everyMs: number | (() => number);
  /** Resolves true when its read came back readable; false or a throw fails. */
  pass: () => Promise<boolean>;
  paused?: () => boolean;
  /**
   * False for a read the outage line does not speak for — see bannerOf.
   * Defaults to true.
   */
  outageLine?: boolean;
}

/** One clock as the shell sees it. `state` is null until its first pass ends. */
export interface ClockView {
  key: string;
  half: Half;
  state: LoopState | null;
  inFlight: boolean;
  /** As on the spec; absent means on the line. */
  outageLine?: boolean;
}

/**
 * SEVERAL READS, EACH ON ITS OWN CLOCK, AND ONE OUTAGE LINE OVER ALL OF THEM.
 *
 * Every clock is a startRefreshLoop of its own — its own cadence, its own
 * backoff, one pass at a time — so a slow read delays nothing but itself. What
 * is shared is the report: every time any clock starts, ends or fails, the
 * shell is handed every clock's view, and `bannerOf` turns that into the one
 * line. Each read applies its own answer as it arrives; nothing here waits for
 * a set of reads to finish together, which is the thing this replaced.
 */
export function startClocks(
  specs: readonly ClockSpec[],
  onChange: (views: ClockView[]) => void,
  timers?: LoopTimers,
): { retryNow(key?: string): void; wake(): void; stop(): void } {
  const views = new Map<string, ClockView>();
  for (const s of specs) views.set(s.key, { key: s.key, half: s.half, state: null, inFlight: false, outageLine: s.outageLine !== false });
  let stopped = false;
  const changed = (key: string, patch: Partial<ClockView>) => {
    if (stopped) return;
    views.set(key, { ...views.get(key)!, ...patch });
    onChange([...views.values()]);
  };
  const loops = new Map<string, { retryNow(): void; wake(): void; stop(): void }>();
  for (const s of specs) {
    loops.set(
      s.key,
      startRefreshLoop({
        pass: s.pass,
        everyMs: s.everyMs,
        paused: s.paused,
        timers,
        report: (state) => changed(s.key, { state }),
        onFlight: (inFlight) => changed(s.key, { inFlight }),
      }),
    );
  }
  return {
    /**
     * One clock by name, or — with no name, which is the outage line's Retry —
     * every clock that is failing. A clock that is healthy has nothing to retry
     * and is left on its own schedule.
     */
    retryNow: (key) => {
      if (key !== undefined) {
        loops.get(key)?.retryNow();
        return;
      }
      for (const v of views.values()) if (v.state && v.state.failuresInARow > 0) loops.get(v.key)?.retryNow();
    },
    wake: () => {
      for (const l of loops.values()) l.wake();
    },
    stop: () => {
      stopped = true;
      for (const l of loops.values()) l.stop();
    },
  };
}

/** What the outage line needs, or null while every clock is healthy. */
export interface Banner {
  /** The soonest retry among the failing clocks — the countdown. */
  nextAt: number;
  /**
   * When the OLDEST thing still on screen from a failing read was read. A
   * failing read that never succeeded put nothing on screen, so it has no say;
   * null when no failing read ever did.
   */
  lastOkAt: number | null;
  /** A failing clock's retry is running now. */
  inFlight: boolean;
  failed: { account: boolean; market: boolean };
  /** Every clock's last pass failed with nothing answering. */
  unreachable: boolean;
}

/**
 * THE ONE LINE, FROM EVERY CLOCK — and only what is true of this failure.
 *
 * The same three questions the single pass answered (which half, since when,
 * did anything answer), asked across clocks that no longer finish together:
 *
 *   - a half has failed while ANY of its reads is failing;
 *   - "since when" is the oldest successful read among the failing ones,
 *     because that is the oldest figure still on screen, and the line must
 *     never understate how old what it is apologising for is;
 *   - "Can't reach merrymen" needs EVERY clock that has reported to be failing
 *     with nothing answering, in both halves. One read answering — even with
 *     an error — means merrymen is there.
 *
 * A CLOCK OFF THE LINE (`outageLine: false`) has no say in any of it. That is
 * the owner's book: a signed-out visitor reads it as unreadable by design, so
 * its failures are not an outage, and its successes are not counted as
 * evidence that the reads that ARE failing were answered. It says what it
 * could not read on its own surface (portfolioReadOf).
 */
export function bannerOf(views: readonly ClockView[]): Banner | null {
  const reported = views.filter(
    (v): v is ClockView & { state: LoopState } => v.state !== null && v.outageLine !== false,
  );
  const failing = reported.filter((v) => v.state.failuresInARow > 0);
  if (failing.length === 0) return null;
  const read = failing.map((v) => v.state.lastOkAt).filter((t): t is number => t !== null);
  const halves = new Set(reported.map((v) => v.half));
  return {
    nextAt: Math.min(...failing.map((v) => v.state.nextAt)),
    lastOkAt: read.length ? Math.min(...read) : null,
    inFlight: failing.some((v) => v.inFlight),
    failed: {
      account: failing.some((v) => v.half === "account"),
      market: failing.some((v) => v.half === "market"),
    },
    unreachable:
      halves.has("account") &&
      halves.has("market") &&
      reported.every((v) => v.state.failuresInARow > 0 && v.state.silent === true),
  };
}

/**
 * THE SENTENCE, NOT THE STACK. The reader needs three facts: what failed, that
 * we are already trying again, and whether what is on screen is old. The
 * error's own message answers none of them.
 *
 * AND ONLY WHAT IS TRUE OF THIS FAILURE. It said "Can't reach merrymen" for
 * every one, including a 500 from a route that answered, and "Showing what we
 * last read" over the whole screen when one half had been refreshed this very
 * pass. `unreachable` is for the case where nothing answered at all; otherwise
 * the line names what could not be loaded (`failed`, which half), and the
 * stale line speaks for that half. Both are optional so a caller that knows
 * nothing more gets the old sentence.
 *
 * `inFlight` is a retry already running: the countdown is to a pass that has
 * started, so it says so rather than counting on.
 */
export function failureCopy(p: {
  nextAt: number;
  lastOkAt: number | null;
  now: number;
  inFlight?: boolean;
  failed?: { account: boolean; market: boolean };
  unreachable?: boolean;
}): {
  /** What went wrong, alone — for a screen reader, which is not read the countdown. */
  lead: string;
  line: string;
  stale: string | null;
} {
  const secs = Math.ceil((p.nextAt - p.now) / 1000);
  const onlyAccount = !!p.failed && p.failed.account && !p.failed.market;
  const onlyMarket = !!p.failed && p.failed.market && !p.failed.account;
  const what = onlyAccount ? "your account" : onlyMarket ? "market data" : "your account or market data";
  const lead = p.unreachable === false ? `Couldn't load ${what}` : "Can't reach merrymen";
  const when = p.inFlight || secs <= 0 ? "retrying now…" : `retrying in ${secs}s.`;
  const shown = onlyAccount ? "your account as" : onlyMarket ? "market data as" : "what";
  return {
    lead,
    line: `${lead}, ${when}`,
    stale: p.lastOkAt === null ? null : `Showing ${shown} we last read ${timeAgo(p.lastOkAt / 1000)}.`,
  };
}
