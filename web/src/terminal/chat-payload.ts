/**
 * WHAT THE CHAT MODEL IS TOLD ABOUT THE BOOK — built here, sent by Agent.tsx.
 *
 * The browser supplies a recent display snapshot for conversation. Questions
 * about executed trades and their reasons are separately read from the ledger
 * on the server, so a short or stale browser tape cannot answer for today's book.
 */
import { chatPositionsOf } from "./account";
import type { LiveMine } from "./live";
import { pausedRecovery } from "./recovery-view";

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
      tradeId: m.tradeId ?? null,
      action: m.action,
      symbol: m.symbol,
      displayName: m.displayName ?? null,
      paper: m.paper,
      reason: m.reason?.slice(0, 400) ?? null,
      // Requested size is not proof of executed cash. The server lookup checks receipts.
      sizeUsdg: m.sizeUsdg,
      realizedPnlUsdg: m.realizedVouched ? m.realizedPnlUsdg ?? null : null,
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
  const recovery = pausedRecovery(mine.recovery);
  const recorded = {
    equity: mine.equity,
    positions: mine.positions ? chatPositionsOf(mine) : null,
    cashUsd: mine.glance.cashUsd ?? null,
    vaultUsd: mine.glance.vaultUsd ?? null,
    paperTradingEnabled: pick("paperTradingEnabled") ?? null,
    liveTradingEnabled: pick("liveTradingEnabled") ?? null,
    stopLossBps: num("strategistStopLossBps"),
    takeProfitBps: num("takeProfitBps"),
  };
  return {
    name: mine.name,
    equity: recovery ? null : recorded.equity,
    strategy: pick("strategy") ?? mine.glance.id,
    basketSymbols: (pick("basketSymbols") ?? null) as string[] | null,
    paperTradingEnabled: recovery ? null : recorded.paperTradingEnabled,
    liveTradingEnabled: recovery ? null : recorded.liveTradingEnabled,
    workerStatus: recovery ? "Trading paused for recovery" : mine.statusLabel ?? "Unknown",
    /**
     * HAS THIS AGENT EVER STARTED — the fact `stopped` cannot carry. IDLE is
     * what a never-spawned agent shows, and also what a beating worker shows
     * before its first pass or with nothing to trade; a tester's new agent,
     * handed only `stopped: true`, told him the flag was "just a record".
     * Whether any heartbeat ever reached us (App.tsx, from `workerAliveAt`)
     * tells the two apart. Null is a screen that never said, and the prompt
     * then claims neither way.
     *
     * `workerReason` is the desk's own sentence for why it is not trading, so
     * the chat names the cause the screen names and invents none. Both give
     * way to a hold, like everything above.
     */
    workerHeardFrom: recovery ? null : mine.workerHeardFrom ?? null,
    workerReason: recovery ? null : mine.autonomy?.reason?.slice(0, 400) ?? null,
    liveBlocker: recovery ? null : liveBlocker ?? null,
    positions: recovery ? null : chatPositionsOf(mine),
    cashUsd: recovery ? null : recorded.cashUsd,
    vaultUsd: recovery ? null : recorded.vaultUsd,
    // Displayed records remain useful history, never proof of the current book.
    ...(recovery ? { recovery, lastRecorded: recorded } : {}),
    // The two rules that answer "what would make you get out" — the levels
    // that sell WITHOUT asking the model. Null means none is armed, which
    // is a different answer from a level at zero.
    stopLossBps: recovery ? null : recorded.stopLossBps,
    takeProfitBps: recovery ? null : recorded.takeProfitBps,
    moves: tapeFor(mine.moves),
    movesShown: Math.min(mine.moves.length, TAPE_SHOWN),
    movesTotal: mine.moves.length,
    perTrade,
    perDay,
    stopped: recovery ? true : stopped,
  };
}
