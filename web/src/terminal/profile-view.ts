/**
 * WHAT THE PUBLIC PROFILE SAYS, decided where a test can run it.
 *
 * Profile.tsx and App.tsx's profile mapping are .tsx, and the runner globs
 * *.test.ts only — so every rule the page applies lives here: which rulebook
 * an agent may be said to run, which chart windows its history can back, what
 * the stats line may claim, and how the owner's book switch reports back.
 */
import type { HowItTrades } from "@/lib/read-agent";
import type { ProfileTrade } from "@/lib/profile-trades";
import { holdWords } from "@/lib/hold-time";
import { count, displayLocale, pctBps, usd } from "@/lib/format";
import { isStrategyId, strategyLabel, type StrategyGlance, type StrategyId } from "./strategy";
import { requestJson, UNREACHABLE } from "./request-json";
import type { LiveAgent } from "./live";

/**
 * The profile's own fields, beside what every LiveAgent carries.
 *
 * OPTIONAL, all of them: a profile that has not loaded yet falls back to the
 * leaderboard row (profileShown), which has none of these, and an older server
 * sends none either. Absent renders as nothing — never as a zero.
 */
export interface ProfileExtras {
  /** The growth index with its timestamps, so the page can slice windows. */
  growthPoints?: { at: number; g: number }[];
  growthComplete?: boolean;
  topTrades?: ProfileTrade[];
  topTradesRead?: boolean;
  tradeCount?: number | null;
  tradeCountFloor?: boolean;
  avgHoldSec?: number | null;
  joinedAt?: number | null;
  gasless?: boolean;
}

export type ProfileAgent = LiveAgent & ProfileExtras;

/** The glance for a rulebook nobody published — the same shape live.ts uses. */
const UNPUBLISHED: StrategyGlance = { id: "custom", label: "Strategy", known: false };

/**
 * The strategy an agent may be SAID to run, from how its decisions were filed.
 *
 * App mapped every profile to `{id:"custom"}`, which renders "Its own rules" —
 * a claim, about a Trencher or a steady basket, that it wrote its own. read-agent
 * already knew the answer from `decisions.source`; this only carries it.
 *
 * A model-driven agent is the strategist: its decisions publish as source
 * `strategist`, which is exactly why llm-strategist is absent from
 * PUBLISHABLE_STRATEGIES. A strategy name the page does not know is not
 * guessed at; it is unpublished.
 */
export function glanceOfHow(how: HowItTrades | null | undefined): StrategyGlance {
  if (!how) return UNPUBLISHED;
  const id: StrategyId | null = how.kind === "model" ? "llm-strategist" : isStrategyId(how.name) ? how.name : null;
  if (id === null || id === "custom") return UNPUBLISHED;
  return { id, label: strategyLabel(id) };
}

/**
 * One sentence on the approach, in the third person.
 *
 * Only what each rulebook actually does — the worker's own headers are the
 * source — because this sits under a public agent's name. Empty when nothing
 * was published, so the page prints its own "hasn't shared its approach yet".
 */
const APPROACH: Record<Exclude<StrategyId, "custom" | "llm-strategist">, string> = {
  "steady-basket": "Buys a little of a chosen basket on a schedule, rather than all at once.",
  "weekend-gap": "Buys stock tokens while their market is closed and sells when it reopens.",
  "even-keel": "Keeps its basket evenly weighted, trimming whatever grows to dominate it.",
  "dip-hunter": "Waits for a pullback in the names it follows before it buys.",
  trencher: "Trades newly launched coins through a risk filter, and leaves the moment one condition breaks.",
};

export function thesisOfHow(how: HowItTrades | null | undefined): string {
  const g = glanceOfHow(how);
  if (g.known === false || !how) return "";
  if (how.kind === "model") {
    return `Reads the market and decides each trade with ${how.model ?? "a language model"}${how.provider ? ` via ${how.provider}` : ""}.`;
  }
  return g.id === "custom" || g.id === "llm-strategist" ? "" : APPROACH[g.id];
}

// ── the chart ─────────────────────────────────────────────────────────────────

export type ChartWindow = "24H" | "7D" | "30D" | "ALL";

export const CHART_WINDOWS: readonly { id: ChartWindow; sec: number | null; words: string }[] = [
  { id: "24H", sec: 86_400, words: "the last 24 hours" },
  { id: "7D", sec: 7 * 86_400, words: "the last 7 days" },
  { id: "30D", sec: 30 * 86_400, words: "the last 30 days" },
  { id: "ALL", sec: null, words: "this whole trading period" },
];

export type WindowSlice =
  | { state: "ok"; values: number[]; from: number }
  /** The history does not reach back the whole window. */
  | { state: "short" }
  /** Nothing was read inside the window. */
  | { state: "empty" }
  /** ALL, from a read that was capped — not the whole period. */
  | { state: "partial" };

/**
 * The growth index over one window, ending at the newest reading.
 *
 * A window starts from the LAST reading at or before its start — the book's
 * value then, as last observed — so its first point is the baseline the change
 * is measured from. A history that does not reach back that far has no such
 * baseline, and the window is refused rather than relabelled: a "24H" drawn
 * over nine hours is a nine-hour change with a day's name on it.
 *
 * `points` are oldest first, as read-agent sends them.
 */
export function growthWindow(
  points: readonly { at: number; g: number }[],
  win: ChartWindow,
  nowSec: number,
  complete: boolean | undefined,
): WindowSlice {
  const spec = CHART_WINDOWS.find((w) => w.id === win)!;
  if (spec.sec === null) {
    if (complete === false) return { state: "partial" };
    return points.length >= 2 ? { state: "ok", values: points.map((p) => p.g), from: points[0]!.at } : { state: "empty" };
  }
  const start = nowSec - spec.sec;
  let base = -1;
  for (let i = 0; i < points.length; i++) {
    if (points[i]!.at <= start) base = i;
    else break;
  }
  if (base < 0) return { state: "short" };
  const inWindow = points.slice(base);
  return inWindow.length >= 2 ? { state: "ok", values: inWindow.map((p) => p.g), from: points[base]!.at } : { state: "empty" };
}

/** Every window, and whether this history can back it. */
export function chartWindows(points: readonly { at: number; g: number }[], complete: boolean | undefined, nowSec: number) {
  return CHART_WINDOWS.map((w) => {
    const s = growthWindow(points, w.id, nowSec, complete);
    return { id: w.id, words: w.words, available: s.state !== "short" && s.state !== "partial" };
  });
}

/**
 * ALL, whenever the read reached the whole period — the span the headline
 * above the chart measures. Otherwise the longest window the history backs.
 */
export function defaultWindow(points: readonly { at: number; g: number }[], complete: boolean | undefined, nowSec: number): ChartWindow {
  const ok = chartWindows(points, complete, nowSec).filter((w) => w.available);
  return ok.find((w) => w.id === "ALL")?.id ?? ok.at(-1)?.id ?? "ALL";
}

// ── the stats line ────────────────────────────────────────────────────────────

/** A date for "Joined", in the reader's own locale. */
function joinedWords(sec: number): string {
  return new Intl.DateTimeFormat(displayLocale(), { dateStyle: "medium", numberingSystem: "latn" }).format(new Date(sec * 1000));
}

/**
 * "12 trades · avg hold 3h 20m · Joined Sep 14, 2026", as parts.
 *
 * EACH TERM ONLY WHEN IT WAS READ. No round trip means no average hold, not
 * "0s"; an unread join date is left out, not guessed; a count from a capped
 * read says "+". Gasless only when measured on every landed operation, and
 * never for a paper book, whose trades cost nobody gas.
 */
export function statsParts(s: {
  tradeCount: number | null | undefined;
  tradeCountFloor: boolean | undefined;
  avgHoldSec: number | null | undefined;
  joinedAt: number | null | undefined;
  paper: boolean;
  gasless: boolean | undefined;
}): string[] {
  const out: string[] = [];
  if (s.tradeCount != null && Number.isFinite(s.tradeCount)) {
    const n = s.tradeCount;
    out.push(`${count(n)}${s.tradeCountFloor ? "+" : ""} ${s.paper ? "paper " : ""}trade${n === 1 && !s.tradeCountFloor ? "" : "s"}`);
  }
  const hold = holdWords(s.avgHoldSec ?? null);
  if (hold) out.push(`avg hold ${hold}`);
  if (s.joinedAt != null && Number.isFinite(s.joinedAt) && s.joinedAt > 0) out.push(`Joined ${joinedWords(s.joinedAt)}`);
  if (s.gasless === true && !s.paper) out.push("Gasless: every trade sponsored");
  return out;
}

/**
 * A top trade's figures: its return always, its dollars only when the server
 * sent them AND this viewer may see dollars — a published book, or the owner's
 * own view. The server already withholds a private book's dollars; this refuses
 * one it was handed anyway, the rule the swaps table on the same page applies
 * (swaps.ts), so the page does not rest a private P&L on one server line.
 */
export function topTradeFigures(t: ProfileTrade, showMoney: boolean): { pct: string; usd: string | null; tone: "up" | "down" } {
  const bps = t.realizedPnlBps ?? 0;
  const dollars = showMoney && t.realizedPnlUsdg != null && Number.isFinite(t.realizedPnlUsdg) ? t.realizedPnlUsdg : null;
  return {
    pct: pctBps(t.realizedPnlBps),
    usd: dollars === null ? null : `${dollars >= 0 ? "+" : "−"}${usd(Math.abs(dollars))}`,
    tone: bps < 0 ? "down" : "up",
  };
}

// ── the owner's own view ──────────────────────────────────────────────────────

/** The owner's own trades with their money in — see read-agent.ts ownBookOf. */
export interface OwnBookView {
  recentTrades: ProfileTrade[] | null;
  topTrades: ProfileTrade[] | null;
}

/**
 * THE OWNER'S OWN FIGURES, from the session-checked /api/agents/<slug>/own.
 *
 * The spec's rule for a profile's money is "the book is public OR it is the
 * owner's own view", and the public read withholds a private book's sizes from
 * everyone — the owner included. The page asks for this only on the owner's
 * own page of a private book; the SERVER decides whether the session owns the
 * slug, so a page that wrongly thought it was the owner's gets a refusal.
 *
 * Null on any failure — signed out, not theirs, unreachable, a malformed
 * answer — and the page then shows the public figures, which carry no money.
 * A list the server could not read comes back null rather than empty.
 */
export async function fetchOwnBook(slug: string): Promise<OwnBookView | null> {
  try {
    const r = await requestJson<{ recentTrades?: unknown; activityRead?: unknown; topTrades?: unknown; topTradesRead?: unknown }>(
      `/api/agents/${encodeURIComponent(slug)}/own`,
    );
    return {
      recentTrades: r.activityRead === true && Array.isArray(r.recentTrades) ? (r.recentTrades as ProfileTrade[]) : null,
      topTrades: r.topTradesRead === true && Array.isArray(r.topTrades) ? (r.topTrades as ProfileTrade[]) : null,
    };
  } catch {
    return null;
  }
}

// ── the owner's switch ────────────────────────────────────────────────────────

/**
 * Publish or close the book. Says what happened, in words, every time.
 *
 * A server that does not know the field answers {ok:true} and lists it under
 * `ignored` — the silent drop that kept every book private for months. That is
 * NOT a save, and the owner is told so rather than shown a switch that moved
 * and a page that did not.
 */
export async function saveBook(next: boolean): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const r = await requestJson<{ ok?: boolean; ignored?: unknown }>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicBook: next }),
    });
    if (Array.isArray(r.ignored) && r.ignored.includes("publicBook")) {
      return { ok: false, message: "This server can't publish a book yet, so nothing changed." };
    }
    if (r.ok !== true) return { ok: false, message: "merrymen didn't confirm the change, so nothing changed." };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error && e.message ? e.message : UNREACHABLE };
  }
}
