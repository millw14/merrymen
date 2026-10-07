/**
 * A FOMO TAIL AS THE OWNER'S DM SEES IT (docs/fomo.md "Tailing a trader"):
 * the confirm card, what following would do with a buy, the /tails list, and
 * the running-tail notices' Stop and +1h buttons read back. Pure and
 * code-written: service.ts does the reads, the parking and the sends.
 *
 * A TAIL IS NOT COPY TRADING, AND NOTHING HERE SAYS IT IS. The card offers
 * two things: be told ("👀 Tell me only"), or be told and let the trader's
 * buys be one signal into the unchanged follow review ("👀 + consider their
 * buys"). The second is offered only when following could act right now
 * (fomo-child.ts followReadiness: paper or live, nothing in the way), and the
 * press is checked against it again (service.ts). Her "if you like it, take
 * it" grants nothing: the card says a tail never skips my normal review.
 *
 * Everything returned is Telegram HTML: fixed words, and a handle that is a
 * plain Fomo handle (letters, digits, underscore) or nothing, escaped anyway.
 */

import type { FollowReadiness } from "../fomo-child";
import { TAIL_COVERAGE_LINE } from "../fomo/render";
import { BLOCKER_WORDS } from "../fomo/tail-notices";
import { TAIL_MAX_HOURS } from "../../../packages/core/src/index";
import { esc } from "./api";

const HOUR_MS = 3_600_000;

/**
 * Whether a tail can work in this process at all: "on"; "switched-off"
 * (MERRYMEN_FOMO_TAILS=0, contract.ts fomoTailsOn); "no-live-feed"
 * (self-hosted: only the hosted service has Fomo's live feed).
 */
export type FomoTailsState = "on" | "switched-off" | "no-live-feed";

/** A Fomo handle as it may be shown and parked: a plain handle, or null. */
export function tailHandle(raw: unknown): string | null {
  const h = typeof raw === "string" ? raw.trim().replace(/^@/, "") : "";
  return /^[A-Za-z0-9_]{1,30}$/.test(h) ? h : null;
}

/** "14:05 UTC". */
export function tailClock(ms: number): string {
  if (!Number.isFinite(ms)) return "an unknown time";
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

const hoursWord = (n: number): string => (n === 1 ? "1 hour" : `${n} hours`);

/** Following could act on a considered buy right now: paper or live, nothing in the way. */
export function canConsider(r: FollowReadiness | null | undefined): boolean {
  return !!r && (r.mode === "paper" || r.mode === "live") && Array.isArray(r.blockers) && r.blockers.length === 0;
}

/** Why following cannot act, in the notices' own plain words (tail-notices.ts BLOCKER_WORDS). */
export function blockerWords(r: FollowReadiness): string {
  return [...new Set((r.blockers ?? []).map((b) => BLOCKER_WORDS[b]).filter(Boolean))].join("; ") || "following is off";
}

/**
 * What following would do with their buy, for the card: off, paper, live, or
 * what is in the way. The live line never promises "a probe": a considered
 * buy counts in the unchanged review like a cohort trader's (following.ts
 * cohortFlow counts distinct buyers), so alone it can lead at most to a
 * probe, but beside another buyer it is breadth for a normal follow entry
 * (review 2026-10-07). She grants consider on what this says.
 */
export function tailReadinessLine(r: FollowReadiness | null | undefined): string {
  if (!r) return "I can't tell right now whether following could act on their buys, so this tail can only tell you.";
  if (r.mode === "off") return "Following is off, so this tail can only tell you; nothing of theirs reaches a trade.";
  if (r.blockers.length > 0) return `Following can't act right now (${blockerWords(r)}), so this tail can only tell you.`;
  return r.mode === "live"
    ? "Following is on with real money: with “consider their buys”, each buy counts like one of my tracked traders' buys in my normal review. On its own it can lead at most to a small probe; with another buyer I track on the same coin it can lead to a normal follow entry. Either is sized by my normal rules, inside your scout budget and per-trade limits."
    : "Following is on, on paper: with “consider their buys”, each buy is one signal into my normal review, and any entry would be a paper trade.";
}

export interface TailCardInput {
  handle: string;
  hours: number;
  /** More than TAIL_MAX_HOURS was asked for. */
  clamped: boolean;
  /** Her words asked me to take the trade too ("if you like it, take it"). */
  take: boolean;
  nowMs: number;
  readiness: FollowReadiness | null;
}

/** The card's text (HTML). Its buttons: buttons.ts tailConfirmKeyboard, consider only when canConsider. */
export function tailCardText(c: TailCardInput): string {
  const name = esc(tailHandle(c.handle) ?? "that trader");
  const until = tailClock(c.nowMs + c.hours * HOUR_MS);
  const lines = [`👀 <b>Tail ${name} on Fomo for ${hoursWord(c.hours)}</b> (until ${until})?`];
  if (c.clamped) lines.push(`You asked for more than ${TAIL_MAX_HOURS} hours; a tail runs ${TAIL_MAX_HOURS} at most.`);
  lines.push(
    "",
    "What you'll get, here: each buy, sell or thesis Fomo's live feed shows from them, with their thesis when there is one and my read of the coin, with Stop and +1h buttons.",
    esc(TAIL_COVERAGE_LINE),
    "",
    esc(tailReadinessLine(c.readiness)),
  );
  if (c.take) {
    lines.push(
      "",
      canConsider(c.readiness)
        ? "You asked me to take the trade if I like it: a tail never skips my normal review. “Consider their buys” makes each buy one signal into it, and I only enter if my own checks and the Brain agree."
        : "You asked me to take the trade if I like it: a tail never skips my normal review, and right now following can't act on it, so this tail only tells you.",
    );
  }
  lines.push("", "This waits 10 minutes; nothing starts until you pick.");
  return lines.join("\n");
}

/** A press of "+ consider their buys" that following cannot honour now (or a card that never offered it). */
export function considerRefusedNote(r: FollowReadiness | null, offered: boolean): string {
  if (!offered && canConsider(r)) return "That option wasn't on the card, so I've set this up to tell you only.";
  if (!r) return "I can't tell right now whether following could act, so I've set this up to tell you only.";
  return `Following can't act right now (${r.mode === "off" ? "following is off" : blockerWords(r)}), so I've set this up to tell you only.`;
}

/** More than one Fomo account answers to the handle: up to three, and ask for the exact one. */
export function tailAmbiguousText(asked: string, candidates: { handle: string | null; displayName: string | null }[]): string {
  const shown = candidates
    .slice(0, 3)
    .map((c) => {
      const h = tailHandle(c.handle);
      if (!h) return null;
      const dn = typeof c.displayName === "string" ? c.displayName.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 30) : "";
      return dn ? `${h} (${dn})` : h;
    })
    .filter((x): x is string => x !== null);
  const name = tailHandle(asked) ?? "that";
  return esc(
    shown.length
      ? `More than one Fomo trader answers to ${name}: ${shown.join(", ")}. Which one? Send /tail with their exact handle.`
      : `More than one Fomo trader answers to ${name}. Which one? Send /tail with their exact handle.`,
  );
}

export interface TailListRow {
  handle: string | null;
  expiresAtMs: number;
  consider: boolean;
}

export interface TailListOpts {
  /**
   * She asked to stop a tail without saying which ("stop tailing him",
   * tail-request.ts "stop-which"): the list leads with the question, and
   * nothing has been stopped.
   */
  which?: boolean;
}

/** /tails: what runs now, plainly. */
export function tailListText(rows: readonly TailListRow[], tailsOff: boolean, opts: TailListOpts = {}): string {
  if (rows.length === 0) {
    if (opts.which) return esc("You aren't tailing anyone on Fomo, so there's nothing to stop.");
    return esc(`You aren't tailing anyone on Fomo. /tail <trader> [hours] starts one (1 to ${TAIL_MAX_HOURS} hours, 3 if you don't say).`);
  }
  const named = rows.slice(0, 3).map((r) => ({ ...r, name: tailHandle(r.handle) ?? "a trader" }));
  const ask = opts.which ? [esc("Which tail should I stop? I haven't stopped any yet."), ""] : [];
  if (tailsOff) {
    return [
      ...ask,
      esc(
        `Tailing is switched off on this service right now, so I'm not telling you about ${named.map((r) => r.name).join(", ")}; each tail still ends on time. /untail <trader> stops one, /untail all stops them.`,
      ),
    ].join("\n");
  }
  return [
    ...ask,
    "👀 <b>Tailing on Fomo</b>",
    ...named.map((r) => `• ${esc(r.name)} until ${tailClock(r.expiresAtMs)}${r.consider ? " (their buys go to my normal review)" : " (tell only)"}`),
    esc("/untail <trader> stops one, /untail all stops them all."),
  ].join("\n");
}

/** A running-tail notice's button (tail-notices.ts buttonsFor), read back. Null for anything else. */
export function parseTailCallback(data: unknown): { action: "stop" | "ext"; userId: string } | null {
  if (typeof data !== "string") return null;
  const m = /^ftl:(stop|ext):([A-Za-z0-9_-]{1,56})$/.exec(data);
  return m ? { action: m[1] as "stop" | "ext", userId: m[2]! } : null;
}
