/**
 * WHAT THE CHAT MODEL IS TOLD ABOUT THE BOOK — built here, sent by Agent.tsx.
 *
 * The chat is stateless on the server: the browser holds the book and sends it,
 * and the system prompt tells the model to ground every number in it. So this
 * object IS what the agent knows about its own money when an owner asks. It was
 * assembled inline in the screen, where no test could run it, and every rule
 * about it was pinned by reading the screen's source for a substring.
 */
import { chatPositionsOf } from "./account";
import type { LiveMine } from "./live";

/**
 * How many recent moves the agent is shown.
 *
 * The whole tape used to go, which on its own overran the prompt's state
 * budget before the positions were even added — so the clamp downstream cut it
 * mid-object. Eight is what fits comfortably and is what a person means by
 * "recently".
 */
export const TAPE_SHOWN = 8;

/**
 * The newest moves, reduced to what the model can actually use.
 *
 * `at` travels so the agent can tell last month's refusal from this morning's.
 * Without it, a tape of stale rejections reads as the present tense — which is
 * exactly how a tester's agent came to report a months-old `no-gas` as its
 * current state. `movesShown`/`movesTotal` go beside it so the agent can say
 * "the last 8 of 30" rather than implying it saw everything.
 *
 * IT WAS HANDING OVER THE OLDEST EIGHT AND CALLING THEM THE LAST EIGHT.
 * `slice(-TAPE_SHOWN)` takes the TAIL, and the tape arrives newest-first —
 * /api/feed selects `ORDER BY created_at DESC` — so the model got the eight
 * stalest rows of the window while `movesShown` told it these were the recent
 * ones. That is the same present-tense-stale-refusal failure this comment was
 * written about, rebuilt one line below it; the 7-day window bounded how old
 * the lie could be and did not stop it being told.
 *
 * Sorted here rather than trusting the caller. The order is a fact about a SQL
 * clause two services away, and reading the tape backwards is silent — nothing
 * throws, nothing looks empty, the agent simply narrates the wrong week.
 */
export const tapeFor = (moves: LiveMine["moves"]) =>
  [...moves]
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, TAPE_SHOWN)
    .map((m) => ({
      at: m.at,
      action: m.action,
      symbol: m.symbol,
      sizeUsdg: m.sizeUsdg,
      outcome: m.outcome,
      outcomeText: m.outcomeText,
    }));

/** /api/settings as the screen reads it: the owner's values over the defaults. */
export interface ChatSettings {
  values?: Record<string, unknown> | null;
  defaults?: Record<string, unknown> | null;
}

/**
 * The state the chat is sent.
 *
 * `positions` is the book's HOLDINGS (chatPositionsOf), never the strategy
 * glance. `settings` is null when /api/settings could not be read, and every
 * figure taken from it is then null rather than a default dressed as the
 * owner's choice.
 */
export function chatStateOf(args: {
  mine: LiveMine;
  settings: ChatSettings | null;
  liveBlocker: string | null | undefined;
  perTrade: number | null;
  perDay: number | null;
  stopped: boolean;
}) {
  const { mine, settings, liveBlocker, perTrade, perDay, stopped } = args;
  const values = settings?.values ?? {};
  const defaults = settings?.defaults ?? {};
  const pick = (k: string): unknown => values[k] ?? defaults[k];
  const num = (k: string) => {
    const v = pick(k);
    return typeof v === "number" ? v : null;
  };
  return {
    name: mine.name,
    equity: mine.equity,
    strategy: pick("strategy") ?? mine.glance.id,
    basketSymbols: (pick("basketSymbols") ?? null) as string[] | null,
    paperTradingEnabled: pick("paperTradingEnabled") ?? null,
    liveTradingEnabled: pick("liveTradingEnabled") ?? null,
    workerStatus: mine.statusLabel ?? "Unknown",
    liveBlocker: liveBlocker ?? null,
    positions: chatPositionsOf(mine),
    cashUsd: mine.glance.cashUsd ?? null,
    vaultUsd: mine.glance.vaultUsd ?? null,
    // The two rules that answer "what would make you get out" — the levels
    // that sell WITHOUT asking the model. Null means none is armed, which
    // is a different answer from a level at zero.
    stopLossBps: num("strategistStopLossBps"),
    takeProfitBps: num("takeProfitBps"),
    moves: tapeFor(mine.moves),
    movesShown: Math.min(mine.moves.length, TAPE_SHOWN),
    movesTotal: mine.moves.length,
    perTrade,
    perDay,
    stopped,
  };
}
