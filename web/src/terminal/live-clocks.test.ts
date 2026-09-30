/**
 * THE SHELL'S READS, EACH ON ITS OWN CLOCK — executed with a fake clock and a
 * fake network, because the property is who waits for whom.
 *
 * Before this, one 60s pass read quotes, then six reads in one Promise.all,
 * then the account, and applied nothing until the slowest was back: the
 * launchpad sweep, at 10-12s cold. A trade that landed could wait a minute to
 * be asked for and twelve seconds more to be drawn.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act, createElement } from "react";

import { liveOf, seedSources, type LiveReadKey, type LiveSources, type RawRead } from "./live";
import {
  ACCOUNT_READS,
  liveClocks,
  QUIET_SHELL,
  tokenMissingOf,
  useShellClocks,
  watchShellClocks,
  type LiveClockDeps,
  type ShellClocks,
  type ShellClocksHandle,
} from "./live-clocks";
import { bannerOf, startClocks, type ClockView } from "./refresh-loop";
import { testDom } from "./test-dom";

function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout(fn: () => void, ms: number) {
        const id = ++seq;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(h: unknown) {
        pending.delete(h as number);
      },
      now: () => now,
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await settle();
      }
      now = until;
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

const ok = (body: unknown): RawRead => ({ text: JSON.stringify(body), answered: true });
const BODIES: Record<LiveReadKey, unknown> = {
  theses: { source: "sqlite", theses: [{ name: "Shogun", slug: "shogun", handle: null, action: "buy", symbol: "TSLA", sizeUsdg: 5, reason: "r", paper: false, head: "bought TSLA", outcome: "landed", at: 1 }] },
  market: { source: "chain", tokens: [] },
  board: { source: "sqlite", agents: [] },
  discoveries: { source: "index", rows: [], fresh: [] },
  feed: { source: "sqlite", agent: { name: "Shogun", slug: "shogun" }, equity: [{ equity_usdg: 20 }] },
};

/** A shell with a network whose answers the test decides, read by key. */
function shell(opts: {
  answer?: (key: LiveReadKey) => Promise<RawRead> | RawRead;
  account?: () => Promise<void>;
  hidden?: () => boolean;
  changes?: () => Promise<Map<string, number>>;
} = {}) {
  const clock = fakeClock();
  let sources: LiveSources = seedSources();
  let views: ClockView[] = [];
  const asked: string[] = [];
  const specs = liveClocks({
    fetchRead: async (key) => {
      asked.push(key);
      return opts.answer ? opts.answer(key) : ok(BODIES[key]);
    },
    loadQuotes: async () => {
      asked.push("quotes");
      return new Map();
    },
    loadChanges: async () => {
      asked.push("changes");
      return opts.changes ? opts.changes() : new Map();
    },
    update: (change) => {
      sources = change(sources);
    },
    readAccount: opts.account ?? (async () => {}),
    hidden: opts.hidden ?? (() => false),
    now: clock.timers.now,
  });
  const clocks = startClocks(specs, (v) => (views = v), clock.timers);
  return {
    clock,
    clocks,
    live: () => liveOf(sources),
    banner: () => bannerOf(views),
    count: (key: string) => asked.filter((k) => k === key).length,
  };
}

describe("the shell's reads", () => {
  it("THE FEED IS DRAWN WHILE THE LAUNCHPAD SWEEP IS STILL OUT", async () => {
    const s = shell({ answer: (key) => (key === "discoveries" ? new Promise<RawRead>(() => {}) : ok(BODIES[key])) });
    await settle();
    assert.equal(s.live().reads.theses, "ok");
    assert.equal(s.live().theses.length, 1);
    assert.equal(s.live().reads.discoveries, "unread", "and the sweep says it is still out, not that it failed");
    s.clocks.stop();
  });

  it("each read keeps its own cadence: feed 10s, market 30s, board 60s, sweep 120s", async () => {
    const s = shell();
    await settle();
    await s.clock.advance(120_000);
    assert.equal(s.count("theses"), 13);
    assert.equal(s.count("market"), 5);
    assert.equal(s.count("board"), 3);
    assert.equal(s.count("discoveries"), 2);
    assert.equal(s.count("feed"), 3);
    s.clocks.stop();
  });

  it("the quotes are read once per market read, and by nothing else", async () => {
    const s = shell();
    await settle();
    await s.clock.advance(60_000);
    assert.equal(s.count("quotes"), s.count("market"));
    s.clocks.stop();
  });

  it("a hidden tab keeps only the feed, once a minute — so the title can count what arrived", async () => {
    let hidden = false;
    const s = shell({ hidden: () => hidden });
    await settle();
    hidden = true;
    const before = { theses: s.count("theses"), market: s.count("market") };
    await s.clock.advance(180_000);
    assert.equal(s.count("market"), before.market, "nothing else is asked for from a hidden tab");
    assert.ok(s.count("theses") - before.theses <= 4, "and the feed slows to a minute");
    assert.ok(s.count("theses") - before.theses >= 2, "but keeps reading");
    hidden = false;
    s.clocks.wake();
    await settle();
    assert.equal(s.count("market"), before.market + 1, "coming back reads what went stale at once");
    s.clocks.stop();
  });
});

describe("the session change beside each stock", () => {
  // loadSessionChanges asks the chart venue once per stock, four at a time,
  // and caches only an answer that read something. The market pass awaited it,
  // so a hanging venue (10s timeout, about seven rounds) held the market and
  // its quotes back for over a minute, and a failing one was asked for every
  // stock every thirty seconds — twice the old rate, at the endpoint failing.
  it("A HANGING CHART VENUE HOLDS NO MARKET READ — prices keep their thirty seconds", async () => {
    const s = shell({ changes: () => new Promise<Map<string, number>>(() => {}) });
    await settle();
    await s.clock.advance(120_000);
    assert.equal(s.count("market"), 5, "every market read ran on time");
    assert.equal(s.count("changes"), 1, "and the hung change read was not asked again beside itself");
    s.clocks.stop();
  });

  it("a venue that answers nothing is asked again in five minutes, not every market read", async () => {
    const s = shell();
    await settle();
    await s.clock.advance(10 * 60_000);
    assert.equal(s.count("market"), 21);
    assert.ok(s.count("changes") <= 3, `asked ${s.count("changes")} times in ten minutes`);
    assert.ok(s.count("changes") >= 2, "but asked again all the same");
    s.clocks.stop();
  });

  it("the changes land when they arrive, after the prices", async () => {
    let answer!: (m: Map<string, number>) => void;
    const s = shell({ changes: () => new Promise<Map<string, number>>((r) => (answer = r)) });
    await settle();
    assert.equal(s.live().reads.market, "ok", "the market was applied without waiting");
    const id = s.live().tokens.find((t) => t.kind !== "memecoin")!.id;
    answer(new Map([[id, 1.25]]));
    await settle();
    assert.equal(s.live().tokens.find((t) => t.id === id)!.change24hPct, 1.25);
    s.clocks.stop();
  });
});

describe("asking for the owner's reads again", () => {
  it("AN ORDER THAT ANSWERED MID-PASS IS STILL READ — the account and the book run again after the pass in flight", async () => {
    // What the chat's onOutcome, a sign-in and a new agent all call. The pass
    // in flight began before the fill, so its grants and its tape are the old
    // ones; dropping the ask left the fill off the desk for up to a minute.
    const pending: Array<() => void> = [];
    let accountReads = 0;
    let bookReads = 0;
    const s = shell({
      account: () => {
        accountReads++;
        return accountReads === 1 ? new Promise<void>((r) => void pending.push(r)) : Promise.resolve();
      },
      answer: (key) => {
        if (key !== "feed") return ok(BODIES[key]);
        bookReads++;
        return bookReads === 1 ? new Promise<RawRead>((r) => void pending.push(() => r(ok(BODIES.feed)))) : ok(BODIES.feed);
      },
    });
    await settle();
    assert.deepEqual([accountReads, bookReads], [1, 1]);
    for (const key of ACCOUNT_READS) s.clocks.retryNow(key);
    await settle();
    assert.deepEqual([accountReads, bookReads], [1, 1], "not beside the passes in flight");
    for (const release of pending) release();
    await settle();
    assert.deepEqual([accountReads, bookReads], [2, 2], "but straight after them, not a minute later");
    s.clocks.stop();
  });
});

describe("what the shell draws from the clocks", () => {
  /** A shell whose App-level state is only what watchShellClocks publishes. */
  function drawn(opts: Parameters<typeof shell>[0] = {}) {
    const clock = fakeClock();
    let sources: LiveSources = seedSources();
    const published: ShellClocks[] = [];
    const specs = liveClocks({
      fetchRead: async (key) => (opts.answer ? opts.answer(key) : ok(BODIES[key])),
      loadQuotes: async () => new Map(),
      loadChanges: async () => new Map(),
      update: (change) => {
        sources = change(sources);
      },
      readAccount: opts.account ?? (async () => {}),
      hidden: opts.hidden ?? (() => false),
    });
    const clocks = startClocks(specs, watchShellClocks((s) => published.push(s)), clock.timers);
    return { clock, clocks, published, live: () => liveOf(sources), now: () => published.at(-1) ?? QUIET_SHELL };
  }

  it("A HEALTHY FEED READ EVERY TEN SECONDS DOES NOT REDRAW THE SHELL", async () => {
    // Every clock's start and end replaced the views array in App's state, so
    // the whole tree re-rendered about twice per pass per clock — some
    // twenty-three times a minute with nothing changed, which undid what
    // withRead's same-bytes no-op was for.
    const s = drawn();
    await settle();
    await s.clock.advance(61_000);
    const settled = s.published.length;
    await s.clock.advance(10_000);
    await s.clock.advance(10_000);
    assert.equal(s.published.length, settled, "two feed reads, one market read: nothing the shell draws changed");
    assert.ok(
      s.published.every((p) => p.banner === null && !p.tokenListFailing),
      "and in the minute before, only the account and the book starting and ending",
    );
    assert.ok(settled <= 8, `two account passes and two book passes, each a start and an end at most (${settled})`);
    s.clocks.stop();
  });

  it("nor does it during an outage somewhere else — a healthy read's pass changes nothing on the line", async () => {
    let fail = false;
    const s = drawn({ answer: (key) => (key === "board" && fail ? { text: null, answered: true } : ok(BODIES[key])) });
    await settle();
    fail = true;
    await s.clock.advance(60_000);
    await s.clock.advance(5_000 + 15_000);
    assert.ok(s.now().banner, "the board is failing, settled on its minute");
    const settled = s.published.length;
    await s.clock.advance(10_000);
    await s.clock.advance(10_000);
    assert.equal(s.published.length, settled, "two feed reads beside it moved nothing on the line");
    s.clocks.stop();
  });

  it("says when the account or the book is being read, and when it is not", async () => {
    const release: Array<() => void> = [];
    let reads = 0;
    const s = drawn({ account: () => (++reads === 2 ? new Promise<void>((r) => void release.push(r)) : Promise.resolve()) });
    await settle();
    assert.equal(s.now().accountBusy, false);
    s.clocks.retryNow("account");
    await settle();
    assert.equal(s.now().accountBusy, true, "a retry the owner pressed is running");
    release[0]!();
    await settle();
    assert.equal(s.now().accountBusy, false);
    s.clocks.stop();
  });

  it("a read that lists tokens recovering is published even when the line reads the same", () => {
    // The board still failing holds the line's countdown and its date; the
    // market recovering changes neither, but it does change whether a token
    // page may say "unavailable".
    const views = (marketFailing: boolean): ClockView[] => [
      { key: "board", half: "market", inFlight: false, state: { failuresInARow: 3, nextAt: 5, lastOkAt: 1, silent: false } },
      {
        key: "market",
        half: "market",
        inFlight: false,
        state: marketFailing ? { failuresInARow: 1, nextAt: 9, lastOkAt: 2, silent: false } : { failuresInARow: 0, nextAt: 30, lastOkAt: 8, silent: false },
      },
    ];
    const published: ShellClocks[] = [];
    const watch = watchShellClocks((next) => published.push(next));
    watch(views(true));
    watch(views(false));
    assert.equal(published.length, 2);
    assert.equal(published[0]!.tokenListFailing, true);
    assert.equal(published[1]!.tokenListFailing, false);
  });

  it("an outage is still published as it moves — the countdown and the retry in flight", async () => {
    let fail = false;
    const s = drawn({ answer: (key) => (key === "board" && fail ? { text: null, answered: true } : ok(BODIES[key])) });
    await settle();
    assert.equal(s.now().banner, null);
    fail = true;
    await s.clock.advance(60_000);
    const first = s.now().banner!;
    assert.deepEqual(first.failed, { account: false, market: true });
    await s.clock.advance(5_000);
    assert.notEqual(s.now().banner!.nextAt, first.nextAt, "the next retry's countdown reached the line");
    fail = false;
    await s.clock.advance(15_000);
    assert.equal(s.now().banner, null, "and the recovery took it down");
    s.clocks.stop();
  });

  it("THE TOKEN PAGE SAYS 'UNAVAILABLE' ONLY FOR A READ THAT LISTS TOKENS — and its Try again retries exactly those", async () => {
    // "Token unavailable" was decided by every clock on the outage line, while
    // its button retried only the market and the sweep. With the feed or the
    // board failing, Try again re-ran two healthy reads and the page kept
    // saying it could not load the token, with nothing the reader could do.
    let failing: string | null = "theses";
    const s = drawn({ answer: (key) => (key === failing ? { text: null, answered: true } : ok(BODIES[key])) });
    await settle();
    const page = () => tokenMissingOf(s.now(), s.live().reads, true);
    assert.ok(s.now().banner, "the feed's failure is on the outage line");
    assert.equal(page().unreadable, false, "but it lists no token: the address is simply not on the list");

    failing = "market";
    await s.clock.advance(30_000);
    assert.equal(page().unreadable, true, "a failing market read is a reason the token may be missing");
    failing = null;
    for (const key of page().retry) s.clocks.retryNow(key);
    await settle();
    assert.equal(page().unreadable, false, "and Try again, retrying what it names, clears it");
    assert.deepEqual([...page().retry].sort(), ["discoveries", "market"]);
    s.clocks.stop();
  });
});

/**
 * THE CLOCKS AS THE SHELL MOUNTS THEM — useShellClocks, the effect and state
 * App ran inline, where a test could not reach them: App renders under
 * next/navigation. Reverting App's side of LV6 and LV7 (every clock change in
 * its state; the token page decided by any clock on the line) left every test
 * green, because only the helpers were executed. Here the hook is mounted and
 * the shell's renders and reads are counted.
 */
describe("the clocks, mounted as the shell mounts them", () => {
  function mounted(opts: {
    answer?: (key: LiveReadKey, epoch: number) => Promise<RawRead> | RawRead;
    hidden?: () => boolean;
  } = {}) {
    const clock = fakeClock();
    const t = testDom();
    let sources: LiveSources = seedSources();
    const asked: Array<{ key: string; epoch: number }> = [];
    const alive: Array<() => boolean> = [];
    let renders = 0;
    let handle!: ShellClocksHandle;
    const depsFor = (epoch: number) => (isAlive: () => boolean): LiveClockDeps => {
      alive[epoch] = isAlive;
      return {
        fetchRead: async (key) => {
          asked.push({ key, epoch });
          return opts.answer ? opts.answer(key, epoch) : ok(BODIES[key]);
        },
        loadQuotes: async () => new Map(),
        loadChanges: async () => new Map(),
        update: (change) => {
          sources = change(sources);
        },
        readAccount: async () => {
          asked.push({ key: "account", epoch });
        },
        hidden: opts.hidden ?? (() => false),
      };
    };
    function Shell({ epoch }: { epoch: number }) {
      renders++;
      handle = useShellClocks(epoch, depsFor(epoch), clock.timers);
      return null;
    }
    return {
      t,
      render: (epoch = 0) => t.render(createElement(Shell, { epoch })),
      advance: (ms: number) => act(async () => void (await clock.advance(ms))),
      settle: () => act(async () => void (await settle())),
      /** Something the shell does in response to a person: a button, a sign-in. */
      press: (fn: (h: ShellClocksHandle) => void) =>
        act(async () => {
          fn(handle);
          await settle();
        }),
      handle: () => handle,
      renders: () => renders,
      live: () => liveOf(sources),
      alive: (epoch: number) => alive[epoch]!(),
      count: (key: string, epoch?: number) => asked.filter((a) => a.key === key && (epoch === undefined || a.epoch === epoch)).length,
    };
  }

  it("A HEALTHY FEED READ EVERY TEN SECONDS DOES NOT RE-RENDER THE SHELL", async () => {
    const s = mounted();
    try {
      await s.render();
      await s.settle();
      await s.advance(61_000);
      const settled = s.renders();
      await s.advance(10_000);
      await s.advance(10_000);
      assert.equal(s.count("theses"), 9, "the feed was read, twice more in those twenty seconds");
      assert.equal(s.renders(), settled, "and the shell drew nothing for it");
    } finally {
      await s.t.close();
    }
  });

  it("the account and the owner's book, again, now — and nothing else", async () => {
    const s = mounted();
    try {
      await s.render();
      await s.settle();
      const before = { account: s.count("account"), feed: s.count("feed"), theses: s.count("theses"), market: s.count("market") };
      await s.press((h) => h.refreshAccount());
      assert.equal(s.count("account"), before.account + 1);
      assert.equal(s.count("feed"), before.feed + 1, "the book is the owner's position too");
      assert.equal(s.count("theses"), before.theses, "the feed keeps its own clock");
      assert.equal(s.count("market"), before.market);
    } finally {
      await s.t.close();
    }
  });

  it("the outage line's Retry asks again for what is failing, and only that", async () => {
    let failing = true;
    const s = mounted({ answer: (key) => (key === "board" && failing ? { text: null, answered: true } : ok(BODIES[key])) });
    try {
      await s.render();
      await s.settle();
      assert.ok(s.handle().shell.banner, "the board is on the line");
      const before = { board: s.count("board"), market: s.count("market"), theses: s.count("theses") };
      failing = false;
      await s.press((h) => h.retryFailing());
      assert.equal(s.count("board"), before.board + 1);
      assert.equal(s.count("market"), before.market, "a healthy read is left on its schedule");
      assert.equal(s.count("theses"), before.theses);
      assert.equal(s.handle().shell.banner, null, "and the line comes down");
    } finally {
      await s.t.close();
    }
  });

  it("THE TOKEN PAGE SAYS 'UNAVAILABLE' ONLY FOR A READ THAT LISTS TOKENS — and its Try again clears it", async () => {
    let failing: string | null = "theses";
    let sweep: (() => void) | null = null;
    const s = mounted({
      answer: (key) => {
        if (key === "discoveries" && s.count("discoveries") === 1) {
          return new Promise<RawRead>((r) => (sweep = () => r(ok(BODIES.discoveries))));
        }
        return key === failing ? { text: null, answered: true } : ok(BODIES[key]);
      },
    });
    try {
      await s.render();
      await s.settle();
      const page = () => s.handle().tokenMissing(s.live().reads);
      assert.equal(s.live().reads.market, "ok");
      assert.deepEqual([page().loading, page().unreadable], [true, false], "the sweep still out is loading, not failing");
      await act(async () => {
        sweep!();
        await settle();
      });
      assert.ok(s.handle().shell.banner, "the feed's failure is on the outage line");
      assert.deepEqual([page().loading, page().unreadable], [false, false], "but it lists no token");

      failing = "market";
      await s.advance(30_000);
      assert.equal(page().unreadable, true, "a failing market read is a reason the token may be missing");
      failing = null;
      const before = { market: s.count("market"), discoveries: s.count("discoveries"), board: s.count("board") };
      await s.press(() => page().retry());
      assert.equal(s.count("market"), before.market + 1);
      assert.equal(s.count("discoveries"), before.discoveries + 1, "both reads that list tokens, not only the failing one");
      assert.equal(s.count("board"), before.board, "and no read that lists none");
      assert.equal(page().unreadable, false, "Try again cleared what the page said");
    } finally {
      await s.t.close();
    }
  });

  it("A SIGN-OUT STARTS FROM NOTHING — the old clocks stop, their late answers are dropped, the old line comes down", async () => {
    const late: Array<() => void> = [];
    const s = mounted({
      answer: (key, epoch) => {
        if (key === "board" && epoch === 0) return { text: null, answered: true };
        if (key === "theses" && epoch === 0 && s.count("theses", 0) === 2) {
          return new Promise<RawRead>((r) => void late.push(() => r(ok({ source: "sqlite", theses: [] }))));
        }
        return ok(BODIES[key]);
      },
    });
    try {
      await s.render(0);
      await s.settle();
      await s.advance(10_000);
      assert.ok(s.handle().shell.banner, "the leaving owner's session has a failing read on the line");
      assert.equal(late.length, 1, "and a feed read still out");
      const asked = s.count("theses", 0) + s.count("board", 0);
      assert.equal(s.alive(0), true);

      await s.render(1);
      await s.settle();
      assert.equal(s.alive(0), false, "the old session's reads know they are over");
      assert.equal(s.alive(1), true);
      assert.equal(s.handle().shell.banner, null, "its failure is not this session's");
      late[0]!();
      await s.settle();
      assert.equal(s.live().theses.length, 1, "its late answer did not land over this session's");
      await s.advance(5 * 60_000);
      assert.equal(s.count("theses", 0) + s.count("board", 0), asked, "and its clocks asked for nothing more");
    } finally {
      await s.t.close();
    }
  });

  it("a tab coming back into view reads what went stale while it was hidden", async () => {
    let hidden = false;
    const s = mounted({ hidden: () => hidden });
    Object.defineProperty(s.t.dom.window.document, "hidden", { configurable: true, get: () => hidden });
    try {
      await s.render();
      await s.settle();
      hidden = true;
      await s.advance(3 * 60_000);
      const market = s.count("market");
      hidden = false;
      await act(async () => {
        s.t.dom.window.document.dispatchEvent(new s.t.dom.window.Event("visibilitychange"));
        await settle();
      });
      assert.equal(s.count("market"), market + 1);
    } finally {
      await s.t.close();
    }
  });
});

describe("the outage line over them", () => {
  it("a failed feed read is on the line, and the feed stays on screen dated", async () => {
    let fail = false;
    const s = shell({ answer: (key) => (key === "theses" && fail ? { text: null, answered: true } : ok(BODIES[key])) });
    await settle();
    fail = true;
    await s.clock.advance(10_000);
    const b = s.banner()!;
    assert.deepEqual(b.failed, { account: false, market: true });
    assert.equal(b.unreachable, false, "a route answered");
    assert.equal(b.lastOkAt, 1_000_000, "dated from the read still on screen");
    assert.equal(s.live().theses.length, 1);
    s.clocks.stop();
  });

  it("the owner's book failing is not an outage — a signed-out visitor reads it that way by design", async () => {
    const s = shell({ answer: (key) => (key === "feed" ? ok({ source: "none" }) : ok(BODIES[key])) });
    await settle();
    assert.equal(s.banner(), null);
    assert.equal(s.live().reads.mine, "unreadable", "it says so on its own surface");
    s.clocks.stop();
  });

  it("'Can't reach merrymen' when nothing answered anywhere, and not when the book alone did", async () => {
    const offline = Object.assign(new Error("offline"), { status: 0 });
    const s = shell({
      answer: (key) => (key === "feed" ? ok(BODIES.feed) : { text: null, answered: false }),
      account: async () => {
        throw offline;
      },
    });
    await settle();
    assert.equal(s.banner()!.unreachable, true);
    assert.deepEqual(s.banner()!.failed, { account: true, market: true });
    s.clocks.stop();
  });
});
