/**
 * WHICH READ RUNS ON WHICH CLOCK, AND WHAT EACH ONE'S ANSWER DOES.
 *
 * The shell used to run one pass a minute: quotes, then six reads in one
 * Promise.all, then the account — and nothing rendered until the slowest of
 * them came back. Each read is now a clock of its own (refresh-loop.ts) that
 * applies its answer the moment it arrives, through `update`, as a change to
 * the latest answer of every read (live.ts `withRead`). What the screens show
 * is derived from those (`liveOf`), so no read waits on or overwrites another.
 *
 * Out of App.tsx so it can be executed: App renders under next/navigation and
 * the test runner cannot mount it. Everything that touches the page — fetch,
 * the tab's visibility, React state — comes in through `deps`. The clocks'
 * effect and the state the shell draws from them are a hook here too
 * (useShellClocks, at the bottom), so a test mounts what App mounts.
 */
import { useEffect, useRef, useState } from "react";
import {
  LiveLoadError,
  marketTokensOf,
  parseRead,
  withChanges,
  withQuotes,
  withRead,
  type LiveReadKey,
  type LiveSources,
  type LiveToken,
  type RawRead,
  type ReadState,
} from "./live";
import { tokenPageUnreadable } from "./account-read";
import type { TokenQuote } from "./quotes";
import {
  ACCOUNT_EVERY_MS,
  BOARD_EVERY_MS,
  DISCOVERIES_EVERY_MS,
  MARKET_EVERY_MS,
  THESES_EVERY_MS,
  THESES_HIDDEN_EVERY_MS,
  bannerOf,
  startClocks,
  type Banner,
  type ClockSpec,
  type ClockView,
  type LoopTimers,
} from "./refresh-loop";

export interface LiveClockDeps {
  fetchRead(key: LiveReadKey): Promise<RawRead>;
  /** The Robinhood quotes. Answers an empty map when the venue refuses. */
  loadQuotes(): Promise<ReadonlyMap<string, TokenQuote>>;
  /** The session change for the stocks among these tokens. */
  loadChanges(tokens: LiveToken[]): Promise<ReadonlyMap<string, number>>;
  /** Apply one change to the latest answers — the shell's setState. */
  update(change: (prev: LiveSources) => LiveSources): void;
  /** Session and grants. Throws (a RequestError) when either could not be read. */
  readAccount(): Promise<void>;
  /** Is the tab hidden right now? */
  hidden(): boolean;
  /** The wall clock, in ms. The session-change schedule is measured on it. */
  now?(): number;
}

/**
 * HOW OFTEN THE SESSION CHANGES ARE ASKED FOR: every five minutes, whatever the
 * last answer was. A success is cached that long anyway (quotes.ts), and a
 * failure is 25 chart requests at a venue that is failing, which the market's
 * thirty-second clock asked for twice as often as the old minute did.
 */
export const CHANGES_EVERY_MS = 5 * 60_000;

/**
 * Whether a public read's answer counts as read — and, when nothing answered
 * at all, a throw that says so, which is the only case the outage line may
 * call "Can't reach merrymen" (refresh-loop.ts nothingAnswered).
 */
function verdict(raw: RawRead): boolean {
  if (parseRead(raw).read === "ok") return true;
  if (!raw.answered) throw new LiveLoadError(false);
  return false;
}

export const LIVE_CLOCK_KEYS = ["theses", "market", "board", "discoveries", "account", "feed"] as const;
export type LiveClockKey = (typeof LIVE_CLOCK_KEYS)[number];

/**
 * THE OWNER'S OWN READS — session and grants, and the book — which everything
 * that changes the owner's position asks for again at once: an order that
 * answered, a sign-in, a new agent (App.tsx refreshAccount). A pass already in
 * flight when they ask is followed by one more (refresh-loop.ts retryNow).
 */
export const ACCOUNT_READS = ["account", "feed"] as const satisfies readonly LiveClockKey[];

export function liveClocks(d: LiveClockDeps): (ClockSpec & { key: LiveClockKey })[] {
  const now = () => (d.now ? d.now() : Date.now());
  /**
   * THE SESSION CHANGES, BESIDE THE MARKET READ AND NOT INSIDE IT.
   *
   * The market pass awaited them. They are one chart request per stock, four at
   * a time, each with a ten-second timeout, so a hanging venue held the market
   * and its quotes back for over a minute (about seven rounds), and a failing
   * one was asked for every stock on every market read. Now they are started
   * and not awaited, applied through `update` when they land, one read at a
   * time, and not asked again for CHANGES_EVERY_MS after the last one ended.
   */
  let changesInFlight = false;
  let changesDueAt = -Infinity;
  const readChanges = (tokens: LiveToken[]) => {
    if (changesInFlight || now() < changesDueAt) return;
    changesInFlight = true;
    void d
      .loadChanges(tokens)
      .then(
        (changes) => d.update((prev) => withChanges(prev, changes)),
        () => {},
      )
      .finally(() => {
        changesInFlight = false;
        changesDueAt = now() + CHANGES_EVERY_MS;
      });
  };
  /** A public read: its answer applied, and kept past a later failure — see withRead. */
  const publicRead = (key: LiveReadKey) => async () => {
    const raw = await d.fetchRead(key);
    d.update((prev) => withRead(prev, key, raw, true));
    return verdict(raw);
  };
  return [
    {
      // THE FEED — the one read a person watches for something to happen. Not
      // paused while hidden, only slowed: the tab title counts what arrived
      // while nobody was looking, and it can only count what it has read.
      key: "theses",
      half: "market",
      everyMs: () => (d.hidden() ? THESES_HIDDEN_EVERY_MS : THESES_EVERY_MS),
      pass: publicRead("theses"),
    },
    {
      // THE MARKET AND THE QUOTES TOGETHER, ONCE. The quotes were read twice a
      // pass — once on their own and again inside the Promise.all — and both
      // answers were applied. The session change, which needs the stock list
      // and nothing else, is started beside it and never waited for
      // (readChanges, above).
      key: "market",
      half: "market",
      everyMs: MARKET_EVERY_MS,
      paused: d.hidden,
      pass: async () => {
        const [raw, quotes] = await Promise.all([d.fetchRead("market"), d.loadQuotes()]);
        d.update((prev) => withQuotes(withRead(prev, "market", raw, true), quotes));
        readChanges(marketTokensOf(raw));
        return verdict(raw);
      },
    },
    { key: "board", half: "market", everyMs: BOARD_EVERY_MS, paused: d.hidden, pass: publicRead("board") },
    {
      // Two minutes: the server's memo lives that long, so asking sooner is
      // asking for the same bytes.
      key: "discoveries",
      half: "market",
      everyMs: DISCOVERIES_EVERY_MS,
      paused: d.hidden,
      pass: publicRead("discoveries"),
    },
    {
      key: "account",
      half: "account",
      everyMs: ACCOUNT_EVERY_MS,
      paused: d.hidden,
      pass: async () => {
        await d.readAccount();
        return true;
      },
    },
    {
      // THE OWNER'S BOOK, which is not on the outage line: a signed-out
      // visitor reads it as unreadable by design, so its failure is not an
      // outage and is not retried on the outage backoff. It says what it could
      // not read on its own surface — which is also why a failure REPLACES the
      // last answer here instead of keeping it: nothing on screen would say a
      // kept book was old.
      key: "feed",
      half: "account",
      everyMs: ACCOUNT_EVERY_MS,
      paused: d.hidden,
      outageLine: false,
      pass: async () => {
        const raw = await d.fetchRead("feed");
        d.update((prev) => withRead(prev, "feed", raw, false));
        return true;
      },
    },
  ];
}

/**
 * THE READS THAT LIST TOKENS: every stock is on the market read and every coin
 * on the launchpad sweep. Only these can make a token address come up empty
 * for a reason other than the address.
 */
export const TOKEN_LIST_READS = ["market", "discoveries"] as const satisfies readonly LiveClockKey[];

/**
 * WHAT THE SHELL DRAWS FROM THE CLOCKS, and nothing else.
 *
 * App kept every clock's view in its state, and every clock's start and end
 * replaced that array, so the whole tree re-rendered about twice per pass per
 * clock: some twenty-three times a minute with nothing changed. The feed's
 * ten-second read alone did it twelve times. No screen is memoised, so each one
 * redrew, which undid what withRead's same-bytes no-op was written for. These
 * three facts are all App reads from the clocks; watchShellClocks publishes
 * them only when one of them changes.
 */
export interface ShellClocks {
  /** The one outage line — see bannerOf. Null while every read on it is healthy. */
  banner: Banner | null;
  /** The account or the owner's book is being read right now: a retry's "Retrying…". */
  accountBusy: boolean;
  /** A read that lists tokens is failing now — see tokenMissingOf. */
  tokenListFailing: boolean;
}

export const QUIET_SHELL: ShellClocks = { banner: null, accountBusy: false, tokenListFailing: false };

const among = (keys: readonly string[], key: string) => keys.includes(key);

export function shellClocksOf(views: readonly ClockView[]): ShellClocks {
  return {
    banner: bannerOf(views),
    accountBusy: views.some((v) => among(ACCOUNT_READS, v.key) && v.inFlight),
    tokenListFailing: views.some((v) => among(TOKEN_LIST_READS, v.key) && (v.state?.failuresInARow ?? 0) > 0),
  };
}

function sameBanner(a: Banner | null, b: Banner | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.nextAt === b.nextAt &&
    a.lastOkAt === b.lastOkAt &&
    a.inFlight === b.inFlight &&
    a.failed.account === b.failed.account &&
    a.failed.market === b.failed.market &&
    a.unreachable === b.unreachable
  );
}

export function sameShellClocks(a: ShellClocks, b: ShellClocks): boolean {
  return sameBanner(a.banner, b.banner) && a.accountBusy === b.accountBusy && a.tokenListFailing === b.tokenListFailing;
}

/**
 * An `onChange` for startClocks that tells the shell only when what it draws
 * has changed. A healthy clock starting and ending changes none of it.
 */
export function watchShellClocks(publish: (shell: ShellClocks) => void): (views: ClockView[]) => void {
  let last = QUIET_SHELL;
  return (views) => {
    const next = shellClocksOf(views);
    if (sameShellClocks(last, next)) return;
    last = next;
    publish(next);
  };
}

/**
 * THE TOKEN PAGE'S "UNAVAILABLE", and the reads its Try again asks for — from
 * the same list, so the button can always clear what the page is saying.
 *
 * "Token unavailable" was decided by every clock on the outage line (the feed,
 * the board and the account as well), while the button retried only the market
 * and the sweep. With the feed failing, pressing it re-ran two healthy reads,
 * the banner stayed, and the page kept saying it could not load the token. A
 * feed or an account read failing lists no token and hides none; only the two
 * reads that list tokens decide it now.
 */
export function tokenMissingOf(
  shell: ShellClocks,
  reads: { market: ReadState; discoveries: ReadState },
  liveLoaded: boolean,
): { unreadable: boolean; retry: readonly LiveClockKey[] } {
  return {
    unreadable: tokenPageUnreadable({
      failing: shell.tokenListFailing,
      market: reads.market,
      discoveries: reads.discoveries,
      liveLoaded,
    }),
    retry: TOKEN_LIST_READS,
  };
}

/** What the shell does with its clocks — see useShellClocks. */
export interface ShellClocksHandle {
  /** What the shell draws from the clocks, published only when it changes. */
  shell: ShellClocks;
  /** Ask these reads again now; every other clock stays on its own schedule. */
  refreshReads(...keys: LiveClockKey[]): void;
  /**
   * THE ACCOUNT AND THE OWNER'S BOOK, AGAIN, NOW — for a retry the owner
   * pressed, a sign-in, an agent just created, an order that answered, or
   * anything that knows the owner's position just changed. It used to restart
   * every read, the two-minute launchpad sweep included, to refresh one
   * account. A pass already in flight began before the change, so it is
   * followed by one more rather than taken as the answer (refresh-loop.ts).
   */
  refreshAccount(): void;
  /** The outage line's Retry: every clock that is failing, and no other. */
  retryFailing(): void;
  /** The token page for an address no list carried — see tokenMissing below. */
  tokenMissing(reads: { market: ReadState; discoveries: ReadState }): {
    loading: boolean;
    unreadable: boolean;
    retry(): void;
  };
}

/**
 * EVERY READ ON ITS OWN CLOCK, AS THE SHELL RUNS THEM — the effect and the
 * state that were inline in App.tsx, where no test could mount them.
 *
 * The clocks start on mount and again, from nothing, whenever `epoch` changes
 * (a sign-out): the old ones are stopped, and `alive` — handed to `depsFor` —
 * turns false for the reads they had in flight, so an answer that belonged to
 * the owner leaving is dropped rather than landing after the reset. `update`
 * is guarded here; anything else a dep does after an await checks `alive`.
 *
 * The shell's state is only what watchShellClocks publishes: a healthy clock
 * starting and ending changes nothing it draws, so nothing re-renders for it.
 *
 * A TAB COMING BACK INTO VIEW runs what went stale while it was hidden, and
 * nothing that ran seconds ago (wake), rather than every read at once.
 */
export function useShellClocks(
  epoch: number,
  depsFor: (alive: () => boolean) => LiveClockDeps,
  timers?: LoopTimers,
): ShellClocksHandle {
  const [shell, setShell] = useState<ShellClocks>(QUIET_SHELL);
  const clocks = useRef<ReturnType<typeof startClocks> | null>(null);
  const latest = useRef({ depsFor, timers });
  latest.current = { depsFor, timers };
  useEffect(() => {
    let alive = true;
    // The watcher below publishes only changes from a quiet shell, so the shell
    // starts from one: a sign-out's banner must not outlive the clocks it
    // described.
    setShell(QUIET_SHELL);
    const deps = latest.current.depsFor(() => alive);
    const running = startClocks(
      liveClocks({
        ...deps,
        update: (change) => {
          if (alive) deps.update(change);
        },
      }),
      watchShellClocks((next) => {
        if (alive) setShell(next);
      }),
      latest.current.timers,
    );
    clocks.current = running;
    const onVisible = () => {
      if (!document.hidden) running.wake();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      running.stop();
      if (clocks.current === running) clocks.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [epoch]);
  const refreshReads = (...keys: LiveClockKey[]) => {
    for (const key of keys) clocks.current?.retryNow(key);
  };
  return {
    shell,
    refreshReads,
    refreshAccount: () => refreshReads(...ACCOUNT_READS),
    retryFailing: () => clocks.current?.retryNow(),
    /**
     * HAS THE MARKET LIST COME BACK YET? Without this the token page could not
     * tell three facts apart, and it told the worst of them: the reads start
     * empty, so every token screen said "We could not load this token" for the
     * whole of the first fetch — a claim of failure about a request still in
     * flight, while the sidebar beside it showed the token's price.
     *
     * Still loading, the load failed, and the load succeeded without this
     * address: three remedies (wait, retry, check the address), and a page that
     * renders one for all three is guessing. BOTH reads that list tokens count,
     * now that they arrive apart: every stock is on the market read and every
     * coin on the launchpad sweep, the slower by ten seconds, and "loaded" on
     * the market alone would call a coin's link "Token not listed" while the
     * read that lists it was still out. Only those two decide "unavailable",
     * and Try again retries exactly those two (tokenMissingOf).
     */
    tokenMissing: (reads) => {
      const liveLoaded = reads.market !== "unread" && reads.discoveries !== "unread";
      const missing = tokenMissingOf(shell, reads, liveLoaded);
      return {
        loading: !liveLoaded,
        unreadable: missing.unreadable,
        retry: () => refreshReads(...missing.retry),
      };
    },
  };
}
