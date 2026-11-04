/**
 * WHAT THE MERRYMAN IS DOING, AND WHY: STATE IN, ANIMATION AND WORDS OUT.
 *
 * The character is a READING of the agent, never decoration. Every pose here
 * is chosen from a fact the shell already holds — the autonomy verdict from
 * core, the recovery hold, the expiry, the chat controller, a landed fill —
 * and the bubble says that fact in plain words. So he naps only when trading
 * is genuinely off, looses an arrow only when a buy actually landed, and
 * celebrates a sale only when the tape vouched for a profit. A mascot that
 * cheers a trade that did not happen is the same lie as a balance that was
 * never read, and the honesty tests hold this module to the same rule.
 *
 * Pure: no React, no three, so the whole mapping is testable in node.
 */
import type { Autonomy } from "@merrymen/core";

export type Tone = "good" | "calm" | "warn" | "bad";

export type Mood = {
  /** The base loop (clips.ts). */
  clip: string;
  /** What he says, or null for nothing. */
  bubble: string | null;
  tone: Tone;
  /** One plain word for a status chip. Never an all-caps machine state. */
  word: string;
};

export type ChatPhase = "idle" | "thinking" | "replying" | "failed";

export type MoodInput = {
  /** Where the shell is: still reading, failed to read, signed out, signed in with no agent, or an agent. */
  phase: "loading" | "failed" | "signed-out" | "no-agent" | "agent";
  autonomy?: Pick<Autonomy, "state" | "rule" | "needsOwnerAction" | "headline" | "reason" | "expiresSoon" | "simulated"> | null;
  /** A fleet recovery hold (recovery-view.ts pausedRecovery). */
  recovery?: boolean;
  chat?: ChatPhase;
};

/** The words on the chip, from core's verdict. Same verdict, kinder words. */
export function wordOf(state: Autonomy["state"] | null | undefined, opts: { recovery?: boolean; expired?: boolean; needsOwner?: boolean } = {}): string {
  if (opts.recovery) return "Paused";
  if (opts.expired) return "Needs you";
  switch (state) {
    case "live": return "Trading";
    case "paper": return "Practising";
    case "checking": return "Waking up";
    case "not-running": return "Asleep";
    case "blocked": return opts.needsOwner ? "Needs you" : "Waiting";
    case "idle": return "Resting";
    default: return "Ready";
  }
}

export function moodOf(input: MoodInput): Mood {
  switch (input.phase) {
    case "loading":
      return { clip: "idle", bubble: null, tone: "calm", word: "…" };
    case "failed":
      return { clip: "think", bubble: "I can't reach camp right now. Trying again…", tone: "warn", word: "Offline" };
    case "signed-out":
      return { clip: "happy", bubble: "Hi! I'm a merryman. Sign in and I'll trade for you.", tone: "calm", word: "Hello" };
    case "no-agent":
      return { clip: "happy", bubble: "Dress me up, then I'll start trading for you.", tone: "calm", word: "New" };
  }

  const a = input.autonomy;
  if (input.recovery) {
    return { clip: "counting", bubble: "Trading is paused while my books are double-checked. Your money stays put.", tone: "calm", word: "Paused" };
  }
  // Chat outranks the trading state on the screen where you are talking to him:
  // the reply in flight is the newest fact on that screen.
  if (input.chat === "thinking") return { clip: "think", bubble: null, tone: "calm", word: "Thinking" };
  if (input.chat === "replying") return { clip: "talk", bubble: null, tone: "calm", word: "Talking" };

  if (!a) return { clip: "idle", bubble: null, tone: "calm", word: "Ready" };
  const word = wordOf(a.state, { expired: a.rule === "expired", needsOwner: a.needsOwnerAction });
  if (a.rule === "expired") {
    return { clip: "sad", bubble: "My trading pass ran out. Renew it and I'm back on the hunt.", tone: "warn", word };
  }
  switch (a.state) {
    case "blocked":
      return a.needsOwnerAction
        ? { clip: "beckon", bubble: a.headline ?? "I need you for something before I can trade.", tone: "warn", word }
        : { clip: "think", bubble: a.reason ?? "Something on our side is holding me up. We're on it.", tone: "calm", word };
    case "not-running":
      return { clip: "sleep", bubble: "I've gone quiet. We're waking me up — your money is safe.", tone: "warn", word };
    case "checking":
      return { clip: "think", bubble: "Checking my new trading pass…", tone: "calm", word };
    case "idle":
      return { clip: "sit", bubble: "Resting. Start me when you're ready.", tone: "calm", word };
    case "paper":
    case "live": {
      const soon = a.expiresSoon;
      const bubble = soon
        ? `My trading pass runs out in ${soon.days} day${soon.days === 1 ? "" : "s"}. Renew it so I keep going.`
        : a.state === "paper"
          ? "Practising with pretend money."
          : "Watching the market for a good shot.";
      return { clip: a.state === "paper" ? "aim" : "scout", bubble, tone: soon ? "warn" : a.state === "live" ? "good" : "calm", word };
    }
  }
  return { clip: "idle", bubble: null, tone: "calm", word };
}

/** A move from the owner's own tape (live.ts Thesis), as much of it as this needs. */
export type Move = {
  action: "buy" | "sell" | "hold" | null;
  outcome?: "landed" | "refused" | "reverted" | "dropped" | "pending" | "view" | "shadow" | null;
  shadow?: boolean;
  paper?: boolean;
  symbol?: string | null;
  at?: number;
  realizedPnlUsdg?: number | null;
  realizedVouched?: boolean;
};

export type Reaction = { clip: string; bubble: string; tone: Tone };

/**
 * HOW HE REACTS TO ONE MOVE — or null for a move that is not an event.
 *
 * Only a LANDED trade is a shot fired. A shadow row would-have-bought and
 * nothing was connected; a pending one has not happened; a hold or a view is
 * a thought. A sale's win or loss is claimed only when the tape vouched for
 * both halves (`realizedVouched`); otherwise he just pockets it.
 */
export function reactionTo(m: Move): Reaction | null {
  if (m.shadow || m.outcome === "shadow") return null;
  const coin = m.symbol ? m.symbol : "it";
  const practice = m.paper ? " (practice)" : "";
  if (m.outcome === "refused") return { clip: "shrug", bubble: `My safety limits said no to that ${coin} trade.`, tone: "calm" };
  if (m.outcome === "reverted" || m.outcome === "dropped") return { clip: "shakeNo", bubble: `That ${coin} trade didn't go through. No money moved.`, tone: "calm" };
  if (m.outcome !== "landed") return null;
  if (m.action === "buy") return { clip: "shoot", bubble: `Bought ${coin}${practice}!`, tone: "good" };
  if (m.action === "sell") {
    if (m.realizedVouched && typeof m.realizedPnlUsdg === "number") {
      if (m.realizedPnlUsdg > 0) return { clip: "celebrate", bubble: `Sold ${coin} for a profit${practice}!`, tone: "good" };
      if (m.realizedPnlUsdg < 0) return { clip: "facepalm", bubble: `Sold ${coin} at a small loss${practice}. On to the next.`, tone: "bad" };
    }
    return { clip: "coinToss", bubble: `Sold ${coin}${practice}.`, tone: "calm" };
  }
  return null;
}

/**
 * THE NEWEST EVENT SINCE `seenAt` — or null.
 *
 * `seenAt` null means "nothing has been read yet": the first reading of a
 * tape is not news, any more than a price drawn for the first time moved
 * (motion.ts trendOf). So the first call only establishes where "now" is.
 */
export function newestReaction(moves: readonly Move[], seenAt: number | null): { at: number; reaction: Reaction } | null {
  if (seenAt === null) return null;
  let best: { at: number; reaction: Reaction } | null = null;
  for (const m of moves) {
    if (typeof m.at !== "number" || m.at <= seenAt) continue;
    const r = reactionTo(m);
    if (r && (!best || m.at > best.at)) best = { at: m.at, reaction: r };
  }
  return best;
}

/** The newest timestamp on a tape, for `seenAt`. */
export function latestAt(moves: readonly Move[]): number {
  let at = 0;
  for (const m of moves) if (typeof m.at === "number" && m.at > at) at = m.at;
  return at;
}
