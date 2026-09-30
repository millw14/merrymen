/**
 * WHAT A TICK THAT PROPOSED NOTHING TELLS THE OWNER, AND WHAT IT POSTS.
 *
 * Lifted out of the tick in index.ts so a test can run it: the decision was
 * three ternaries and a guard inside main(), and a revert of any of them passed
 * every test in the repo. Then the writing was lifted too (IdleChannel, below),
 * because a revert of THAT — the change gate, the level, the post's register —
 * passed every test as well. index.ts now only calls `tell`.
 *
 * An empty intent list is what a healthy quiet tick looks like AND what a
 * strategy that cannot act looks like. Over one weekend that ambiguity read, to
 * every owner of a basket agent, as "no trading is being done" — when in fact
 * all 24 equity feeds were stale and the strategy was correctly refusing to buy
 * without a reference price. So a strategy hands back WHY, and it is said:
 *
 *   - to the OWNER, as an event, in the owner's register (renderWhy's default,
 *     remedies included);
 *   - to the FEED, as a `view` decision in the public register — unless the
 *     reason is account state (publishesIdle).
 *
 * ONCE PER CHANGE, not once per tick: a stale weekend is 360 ticks, and this
 * repo already carries the incident where 1,242 identical rows told nobody
 * anything. `last` is the owner sentence already said; IdleChannel keeps it.
 */
import type { AssetMode } from "../../packages/core/src/index";
import { addDecision, addEvent, newDecisionId, ownerNotice } from "./store";
import { publishesIdle, renderWhy, type Why } from "./strategies/reasons";
import { breakerIdle, type Snapshot } from "./strategies/types";
import { publicationSourceFor } from "./thesis-policy";

/**
 * A MODE THAT LEAVES NOTHING TO TRADE MUST SAY SO.
 *
 * The one way the asset mode could be worse than no feature at all: an owner
 * picks "crypto only" with a basket of equities, every strategy resolves zero
 * legs, and the agent goes quiet with nothing on any screen to connect the
 * silence to the dropdown they just moved. That is the exact shape of the
 * trencher incident index.ts already carries — "it didn't take any trades
 * yet", then "I think I'm stuck in paper mode".
 *
 * `legs(mode)` counts what the strategies would resolve under that mode — the
 * caller passes legsForUniverse, the function makeStrategy resolves legs from,
 * so this cannot disagree with them. ONLY WHEN THE MODE IS WHAT EMPTIED IT: an
 * empty basket is an empty basket, and blaming the mode for one would be a
 * different wrong sentence. The count with no mode applied is what tells the
 * two apart. The plain fact, with no remedy; see MODE_EMPTIED_REMEDY.
 */
export function modeEmptiedFact(mode: AssetMode, legs: (mode: AssetMode) => number): string | null {
  if (mode === "all") return null;
  if (legs(mode) > 0 || legs("all") === 0) return null;
  return (
    `nothing in your basket is ${mode === "stocks" ? "a stock" : "a coin"}, and your asset mode is ` +
    `${mode === "stocks" ? "Stocks only" : "Crypto only"} — so there is nothing to trade`
  );
}

/**
 * The owner's half of an emptied asset mode: they are the one person who can
 * change it. The public half is the plain fact — "Change the mode in Settings"
 * on a public feed is an instruction to a stranger about somebody else's
 * account; it was live for weeks and is the exact texture of a worker log
 * leaking onto a desk. `renderWhy` draws the same line for its own
 * remedy-bearing arms.
 */
export const MODE_EMPTIED_REMEDY = "Change the mode in Settings, or add something it allows to your basket.";

export interface IdleNotice {
  /** The owner sentence now standing, for the next tick's change test. */
  last: string | null;
  /** The owner's event, when the sentence changed to something. */
  event: { level: "ok" | "warn"; message: string } | null;
  /** The public view's reason, when there is an event and it may be a post. */
  view: string | null;
}

export function idleNotice(input: {
  /** The strategy's own reason, when it gave one. */
  idle: Why | null | undefined;
  /**
   * A MODE THAT LEAVES NOTHING TO TRADE, as the plain fact, or null. Computed
   * by the caller from the same inputs makeStrategy resolves legs from, so it
   * cannot disagree with them. A strategy's own reason wins over it.
   */
  modeEmptied: string | null;
  last: string | null;
}): IdleNotice {
  const { idle, modeEmptied, last } = input;
  const owner = idle ? renderWhy(idle) : modeEmptied === null ? null : `${modeEmptied}. ${MODE_EMPTIED_REMEDY}`;
  if (owner === last) return { last, event: null, view: null };
  if (owner === null) return { last: null, event: null, view: null };
  const posts = !idle || publishesIdle(idle);
  return {
    last: owner,
    // A REASON THAT DOES NOT POST IS A WARNING. "ok" is the running commentary
    // and no owner surface renders it — the desk notice, the rail and the
    // Android app all read warn and above — so for most reasons the owner
    // meets it as the public view. A tripped breaker has no view: it is the
    // account's losses and stays off the feed. At "ok" it had no surface at
    // all, and the refusal WARN it replaced ("policy rejected swap:
    // drawdown-breaker") stopped being written the moment the strategies
    // stopped proposing — so the desk went on showing whatever warned last,
    // for a Trencher a now-false "no pool passes the entry checks".
    event: { level: posts ? "ok" : "warn", message: owner },
    view: posts ? (idle ? renderWhy(idle, "public") : modeEmptied) : null,
  };
}

/**
 * THE ROW THAT MAKES A SILENCE A POST.
 *
 * A tick that proposes nothing used to write its reason to `events` and
 * nothing else — and only `decisions` can become a post, so an agent that
 * looked at the market and concluded "not today, and here is why" talked to a
 * table nobody reads. A decision with NO ACTION is a `view`: thesis-policy
 * classifies it, and the feed renders it from the publisher's own words. So
 * this row has no action, no symbol and no size — that absence is what makes
 * it a view, and `outcomeOf` is what turns the absence into the word.
 *
 * THROUGH publicationSourceFor, NOT A TEMPLATE. The template spelled the
 * strategist's source `strategy:llm-strategist(anthropic:claude-opus-4)` — a
 * key SOURCE_POLICY has never contained — so the sentence written to prove the
 * agent was thinking published nothing at all (strategist-publish.test.ts).
 */
export function idleViewRow(args: { id: string; agentId: string; strategyName: string; reason: string }): {
  id: string;
  agent_id: string;
  source: string;
  reason: string;
} {
  return { id: args.id, agent_id: args.agentId, source: publicationSourceFor(args.strategyName), reason: args.reason };
}

/**
 * WHAT THE OWNER'S NOTICE SHOWS NOW: the newest warn among the agent's newest
 * events, by the rule the desk, the rail and the Android app apply
 * (store.ownerNotice). `atMs` is when it was written.
 */
export interface ShownNotice {
  message: string;
  atMs: number;
}

/**
 * HOW LONG A NEWER NOTICE KEEPS THE DESK before a standing reason is said again.
 *
 * Long enough that a line somebody else just wrote — a discovery failure, a
 * refusal — is read before it is covered; short against a breaker that stays
 * tripped for days. A warn written every tick is younger than this every time
 * it is asked, so the breaker waits for it rather than alternating with it:
 * the table never carries two warnings a tick.
 */
export const RESTATE_AFTER_MS = 10 * 60_000;

const EARLIER = ". Also from earlier: ";

/**
 * A LINE WRITTEN OVER ANOTHER WARN KEEPS IT.
 *
 * The notice is one line — the newest warn — and the channel writes warns over
 * other lines on purpose: the breaker restated once something replaced it, the
 * line that takes the breaker down, the breaker again after a tick that could
 * not measure it. The warn they cover may still be standing, and the channels
 * that write warns once per change (the live rail's blocker, a per-key refusal,
 * a Trencher notice) never say theirs again while it holds. Covered, it was
 * gone for the rest of the trip: a sell refused under the key, replaced after
 * ten minutes by a sentence ending "Selling is never blocked by this". So the
 * covered line rides after ours — through the trip that covered it and the
 * reset line that ends it, and no further (writeOver). That is longer than the
 * desk alone would have kept it by up to one trip and its reset, since each of
 * our lines is a new event; it is not longer than that.
 */
export function withEarlier(head: string, earlier: string | null): string {
  return earlier ? `${head}${EARLIER}${earlier}` : head;
}

/**
 * THE LINE THAT TAKES THE BREAKER DOWN.
 *
 * The breaker's sentence is a warn, and the notice is the newest warn — so the
 * sentence that said "the breaker refuses buys until it recovers" stood after
 * it had recovered, until forty newer events pushed it out, and for an agent
 * that writes little after a reset, for good. With the restatement keeping it
 * current right up to the reset, every long trip ended with the false line on
 * top. So the reset is said, at the level the notice reads.
 *
 * NO FIGURE: a breaker also clears when a re-sign widens the limit, and "back
 * inside the 10% limit" would then be the old limit. And "buying resumes" only
 * when nothing else is the reason now — with a reason standing (the cash is
 * short, the feeds are stale), the breaker is no longer what stops buying, and
 * that reason is told as it always is.
 */
export function breakerResetLine(next: string | null): string {
  return (
    `the drawdown breaker has reset — the book is back inside the drawdown limit in the signed key, ` +
    (next === null ? `and buying resumes` : `so it no longer stops buying`)
  );
}

/**
 * The breaker's owner sentence either side of its figure, read off renderWhy
 * itself (two limits whose figures share no first or last character), so a
 * line is recognised whatever limit it was written under. Read on first use,
 * not at load, so no import order can matter.
 */
let breakerWordsRead: { head: string; tail: string } | null = null;
function breakerWords(): { head: string; tail: string } {
  if (breakerWordsRead) return breakerWordsRead;
  const a = renderWhy({ code: "breaker-tripped", limitBps: 1_000 });
  const b = renderWhy({ code: "breaker-tripped", limitBps: 2_500 });
  let head = 0;
  while (a[head] === b[head]) head++;
  let tail = 0;
  while (a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return (breakerWordsRead = { head: a.slice(0, head), tail: a.slice(a.length - tail) });
}

/** How long the breaker's sentence is at the start of `line`, or -1 when it does not lead with one. */
function breakerLead(line: string): number {
  const { head, tail } = breakerWords();
  if (!line.startsWith(head)) return -1;
  const at = line.indexOf(tail, head.length);
  return at > 0 && /^[0-9.]{1,8}$/.test(line.slice(head.length, at)) ? at + tail.length : -1;
}

/**
 * IS THIS LINE ONE THE CHANNEL WROTE — the breaker, or its reset, alone or
 * carrying another warn — and if so, what does it carry?
 *
 * Read from the words, not remembered: a worker restarted mid-trip starts with
 * no memory, and the line an earlier process left on the desk (where its own
 * table survived the restart) must still be known as ours — or the first
 * breaker line after the restart would carry the old one after it, the same
 * sentence twice.
 */
function ownLine(line: string): { head: string; earlier: string | null } | null {
  let lead = breakerLead(line);
  for (const reset of [breakerResetLine(null), breakerResetLine("")]) if (lead < 0 && line.startsWith(reset)) lead = reset.length;
  if (lead < 0) return null;
  const head = line.slice(0, lead);
  const rest = line.slice(lead);
  if (rest === "") return { head, earlier: null };
  return rest.startsWith(EARLIER) ? { head, earlier: rest.slice(EARLIER.length) } : null;
}

/** MEASURED clear — a book that could not be totalled is not a recovery. */
function breakerClear(drawdown: Snapshot["drawdown"]): boolean {
  return !!drawdown && Number.isFinite(drawdown.bps) && Number.isFinite(drawdown.limitBps) && drawdown.bps < drawdown.limitBps;
}

/** Where the idle channel writes, and what it reads back. idleChannelOnStore binds the store's own. */
export interface IdleSinks {
  addEvent(agentId: string, level: "ok" | "warn", message: string): Promise<void>;
  addDecision(row: ReturnType<typeof idleViewRow>): Promise<void>;
  newDecisionId(): string;
  /** The owner's notice as it stands: null when none shows, undefined when it could not be read. */
  shownNotice(agentId: string): Promise<ShownNotice | null | undefined>;
  now?(): number;
  log?(line: string): void;
}

/**
 * THE TICK'S IDLE WRITE, WHOLE — what used to be the idle block in main().
 *
 * That block kept `lastIdleReason` itself and wrote what idleNotice decided,
 * and no test booted it: dropping the change gate, or publishing the owner's
 * sentence as the post, passed every test in the repo. So the state and both
 * writes live here, and index.ts only calls `tell` with the store's sinks.
 *
 * AND A WARNING THAT STILL STANDS IS KEPT WHERE THE OWNER READS IT. A reason
 * that cannot be a post (a tripped breaker) reaches the owner only as a warn
 * event, and the desk notice, the rail and the Android app show only the
 * newest warn among the newest 40 events. Written once, at the change, it is
 * covered by the next warn anybody writes — for a Trencher the discovery
 * retry line, which then read as the reason for days — or aged out by the
 * running commentary, and the desk showed nothing while the breaker was still
 * tripped. So while such a reason stands and the notice no longer shows it,
 * it is said again: at once when nothing shows, and otherwise once the notice
 * that replaced it has had RESTATE_AFTER_MS — carrying that notice after it
 * (withEarlier), never burying it. Still once per change for everything else —
 * a reason that posts is never restated, because its view row would repeat
 * with it.
 *
 * AND THE BREAKER'S RESET IS SAID, AND ITS TRIP. Once the owner has been told
 * the breaker, the first tick that measures it clear writes breakerResetLine
 * over it, so the notice never goes on saying buys are refused after they no
 * longer are. And a trip the channel has not told is told on the tick that
 * measures it, whatever reason that tick gives, so the reset line never goes
 * on saying buying resumes while the wall refuses every buy.
 *
 * ACROSS A RESTART the channel starts with no memory, and the only notice it
 * can read is the child's own table (store.ownerNotice) — which a hosted
 * redeploy wipes, while the desk reads the shared table that keeps every line.
 * So nothing here looks for what an earlier process left. A trip still
 * standing is told again on the new process's first tripped tick, and its
 * reset follows. A trip that CLEARED across the restart is unknown to the new
 * process: the owner goes on seeing the old breaker line until a newer warn
 * covers it or the newest 40 events pass it by.
 */
export class IdleChannel {
  /** The owner sentence standing — `lastIdleReason`, as the tick knew it. */
  private last: string | null = null;
  /** The standing sentence, when it went out as a warning — the one kind that is restated. */
  private standing: string | null = null;
  /** The agent whose owner was told the breaker, until they are told it reset. */
  private breakerTold: string | null = null;
  private readonly restateAfterMs: number;

  constructor(
    private readonly sinks: IdleSinks,
    opts: { restateAfterMs?: number } = {},
  ) {
    this.restateAfterMs = opts.restateAfterMs ?? RESTATE_AFTER_MS;
  }

  async tell(input: {
    agentId: string;
    strategyName: string;
    idle: Why | null | undefined;
    modeEmptied: string | null;
    /**
     * The breaker as this tick measured it (Snapshot.drawdown). Only a
     * MEASURED clear is a reset; absent or null — a book that could not be
     * totalled — says nothing either way.
     */
    drawdown?: Snapshot["drawdown"];
  }): Promise<void> {
    const notice = idleNotice({ idle: input.idle, modeEmptied: input.modeEmptied, last: this.last });
    this.last = notice.last;
    if (notice.last === null) this.standing = null;
    // THE RESET, before whatever reason follows it: the owner was told the
    // breaker and this tick measured it clear. Said once; an unread desk
    // defers it to the next tick that can read one, rather than writing it on
    // a guess.
    if (this.breakerTold === input.agentId && input.idle?.code !== "breaker-tripped" && breakerClear(input.drawdown)) {
      const shown = await this.shown(input.agentId);
      if (shown !== undefined) {
        this.breakerTold = null;
        await this.writeOver(input.agentId, breakerResetLine(notice.last), shown);
      }
    }
    // AND THE TRIP, whatever reason the tick gives. The class gate gives the
    // breaker's only when something would have bought, and even-keel in band
    // or weekend-gap while it holds give none — so a re-trip after a reset
    // left "buying resumes" on the desk while the wall refused every buy. A
    // measured trip this channel has not told is told now: after its own
    // reset, and on a restarted process's first tripped tick, which cannot
    // know what an earlier one left. A tick that gives the breaker's reason
    // says it below, as a change. Written even unread, as a change is.
    const trip = breakerIdle({ drawdown: input.drawdown });
    if (trip && this.breakerTold !== input.agentId && input.idle?.code !== "breaker-tripped") {
      this.breakerTold = input.agentId;
      await this.writeOver(input.agentId, renderWhy(trip), (await this.shown(input.agentId)) ?? null);
    }
    if (notice.event) {
      const warn = notice.event.level === "warn";
      this.standing = warn ? notice.event.message : null;
      if (input.idle?.code === "breaker-tripped") this.breakerTold = input.agentId;
      if (warn) {
        // A warning becomes the notice — over whatever shows, and keeping it.
        // A change is said even when the desk cannot be read: then it is
        // written alone, as it always was.
        await this.writeOver(input.agentId, notice.event.message, (await this.shown(input.agentId)) ?? null);
      } else {
        this.sinks.log?.(`[tick] idle — ${notice.event.message}`);
        await this.sinks.addEvent(input.agentId, "ok", notice.event.message);
      }
      // THE STRUCTURAL REASON A QUIET FLEET READS AS A DEAD FEED: only
      // `decisions` can become a post, so the silence is also written as a
      // `view` (idleViewRow) — inside the same change gate as the event, or an
      // unchanged reason would write an identical row every tick. EXCEPT A
      // SILENCE THAT IS ACCOUNT STATE: idleNotice gives it no view.
      if (notice.view !== null) {
        await this.sinks.addDecision(
          idleViewRow({ id: this.sinks.newDecisionId(), agentId: input.agentId, strategyName: input.strategyName, reason: notice.view }),
        );
      }
      return;
    }
    // Nothing new to say. A reason that still stands, and went out as a
    // warning, is said again if the owner's notice no longer shows it. (A new
    // reason always arrives with an event above, which resets `standing`.)
    if (this.standing === null) return;
    const shown = await this.shown(input.agentId);
    // Unread is not "nothing shows": a write on a guess is how a table fills
    // with the same line.
    if (shown === undefined || !this.covered(shown)) return;
    await this.writeOver(input.agentId, this.standing, shown);
  }

  /** The owner's notice as it stands; undefined when it could not be read. */
  private async shown(agentId: string): Promise<ShownNotice | null | undefined> {
    try {
      return await this.sinks.shownNotice(agentId);
    } catch {
      return undefined;
    }
  }

  /**
   * Is the standing sentence no longer the notice — and has whatever replaced
   * it had its grace? Ours by its words (ownLine), and only when it leads with
   * the sentence that stands: our own older line — a reset, a lost write away
   * from a new trip — is not the breaker being shown.
   */
  private covered(shown: ShownNotice | null): boolean {
    if (shown === null) return true;
    if (ownLine(shown.message)?.head === this.standing) return false;
    const now = this.sinks.now?.() ?? Date.now();
    return now - shown.atMs >= this.restateAfterMs;
  }

  /**
   * Write `head` as the notice, over what it shows now, keeping any other
   * warn that shows on it (withEarlier): the one written over ours, or the one
   * our own breaker line already carries.
   *
   * NEVER THROUGH A RESET LINE. What the reset carries was kept because the
   * trip covered it, and that trip has ended. Carried on, a breaker flapping
   * at its limit rewrote the same line on every flip, and a warn written once
   * ("no new token authorized") stood beside "buying resumes" for as long as
   * the flapping lasted.
   */
  private async writeOver(agentId: string, head: string, shown: ShownNotice | null): Promise<void> {
    const own = shown === null ? null : ownLine(shown.message);
    const earlier = shown === null ? null : !own ? shown.message : breakerLead(own.head) >= 0 ? own.earlier : null;
    const line = withEarlier(head, earlier);
    this.sinks.log?.(`[tick] idle — ${line}`);
    await this.sinks.addEvent(agentId, "warn", line);
  }
}

/**
 * THE CHANNEL THE TICK USES: the store's own writers, and the owner's notice
 * read by the desk's rule (store.ownerNotice). Bound here rather than in
 * main(), so the binding itself is run by a test — owner-notice.integration
 * drives this, on the real store — and not only read.
 */
export function idleChannelOnStore(log?: (line: string) => void): IdleChannel {
  return new IdleChannel({ addEvent, addDecision, newDecisionId, shownNotice: ownerNotice, log });
}
