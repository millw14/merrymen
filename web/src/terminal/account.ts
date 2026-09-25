import {money, pctPts, type LiveMine, type Thesis} from "./live";
import type { OrderReceipt } from "@/lib/order-state";

/**
 * A QUESTION AND ITS ANSWER — the shape the chat was stored in before it had
 * messages. Kept only so a conversation saved in that shape still loads
 * (chat-thread.ts turnsToMessages); nothing new is written this way.
 *
 * It could not say what an order became: an outcome had to be forced into a
 * fake pair with a question of "" or "✓ confirmed", and nothing the agent did
 * on its own could enter the thread at all.
 */
export interface ChatTurn {
  question: string;
  answer: string;
  trade?: Thesis;
}

/**
 * Why a reply did not arrive, as the agent says it (chat-thread.ts failureLine).
 *
 * "server" is the route, or whatever stands in front of it, answering with an
 * error status: nobody answered, so it is never "unreadable", which is a 2xx
 * body that could not be read.
 */
export type ChatFailure = "signed-out" | "no-llm" | "llm-error" | "unreadable" | "network" | "timeout" | "cut-off" | "server";

/**
 * ONE LINE OF THE CONVERSATION.
 *
 * `owner` is what they typed or confirmed; `agent` is the agent's words — a
 * model's reply, or the worker's own sentence about an order it ran; `event`
 * is something that HAPPENED, templated from ledger fields and never written
 * by a model: one of the agent's own fills, merged in from the tape.
 */
export interface ChatMessage {
  id: string;
  role: "owner" | "agent" | "event";
  /** Epoch ms on this browser's clock; null for a line kept from before times were. */
  at: number | null;
  text: string;
  /** An event's side, for its Buy/Sell pill. */
  side?: "buy" | "sell" | null;
  /**
   * The order this line is about, and — once the worker answered — its receipt
   * (C3). The line that placed it also keeps `serverPlacedAt`: the SERVER's
   * epoch ms for the placement, the one time on a line not read off this
   * browser's clock, which lets the thread read the order's life on the
   * ledger's clock (chat-thread.ts lifeOf).
   */
  order?: { id: string; receipt?: OrderReceipt | null; serverPlacedAt?: number };
  /** Which trade this line is, so the tape can join it exactly once. */
  tradeKey?: string;
  /** That trade, as the tape last read it. Never stored: re-read each session. */
  trade?: Thesis;
  /** Set on a failure said in the agent's voice. Kept out of what the model is told it said. */
  failed?: ChatFailure;
  /** The question to put again, for the Retry chip. This session only. */
  retry?: string;
}

export function dailyChange(mine: LiveMine): number | null {
  if (mine.equity == null || mine.chg24 == null) return null;
  const previous = mine.equity - mine.chg24;
  return previous > 0 ? (mine.chg24 / previous) * 100 : null;
}

export function spentToday(mine: Pick<LiveMine, "moves">, now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return mine.moves.reduce((total, move) => {
    if (move.action !== "buy" && move.action !== "sell") return total;
    // AN ALLOW-LIST, because this number is the answer to "how much of today's
    // budget is gone". It was `move.outcome && move.outcome !== "landed"`,
    // which counted a move with NO outcome — and until `tradeOutcome` became an
    // allow-list of its own, an unconfirmed 'submitted' trade arrived here
    // wearing `outcome: "landed"` and was spent against the day before the
    // chain had agreed it happened.
    if (move.outcome !== "landed") return total;
    if (move.at == null || move.at * 1000 < start.getTime() || move.at * 1000 > now)
      return total;
    return total + Math.max(0, move.sizeUsdg ?? 0);
  }, 0);
}

export function positionsOf(mine: Pick<LiveMine, "positions" | "glance">) {
  // THE POSITION'S OWN %, which mineOf computed from the recorded cost and this
  // mapping threw away as `pnl: null` — so the desk never showed one. Null
  // stays null and says why: no cost on record is "cost unknown", never 0%.
  // A stale mark keeps its value and its "last mark" note but not a %, which
  // would print an old price's return beside nothing that says it is old.
  //
  // AND NOT ON A COST THE LEDGER CANNOT VOUCH FOR. When a fill's receipt could
  // not be read, the worker books its cost from the pre-trade quote, and the
  // basis table keeps no note of that. /api/feed replays the fills behind each
  // holding and says whether a quote-booked one may still be in its cost; a %
  // on that cost is a precise figure computed from an estimate, so it is
  // withheld and the row says "cost unconfirmed". A provenance nobody could
  // read is withheld the same way, because it is not a receipt either.
  //
  // `detail` ALWAYS carries the value. The % goes beside it (positionFigures),
  // never in its place: "+20%" alone tells an owner how a position is doing and
  // nothing about how much of their money is in it.
  if(mine.positions) return mine.positions.filter(p=>p.valueUsd>0).map(p=>{
    const unconfirmed = p.costUsd !== null && p.costFromQuote !== false;
    return {symbol:p.symbol,
      detail:`${money(p.valueUsd)}${p.stale ? " · last mark" : ""}${p.costUsd === null ? " · cost unknown" : unconfirmed ? " · cost unconfirmed" : ""}`,
      pnl:!p.stale && !unconfirmed && p.pnlPct !== null && Number.isFinite(p.pnlPct) ? p.pnlPct : null};
  });
  const g = mine.glance;
  return (
    g.legs?.map((l) => ({
      symbol: l.symbol,
      detail: `${l.weight}% allocation`,
      pnl: null as number | null,
    })) ??
    g.open?.map((l) => ({
      symbol: l.symbol,
      detail: "Open position",
      pnl: l.pnlPct,
    })) ??
    g.parked?.map((symbol) => ({
      symbol,
      detail: "Held",
      pnl: null as number | null,
    })) ??
    []
  );
}

/**
 * WHAT ONE ROW OF THE OWNER'S POSITIONS LIST PRINTS: the money, and the %
 * beside it when there is one.
 *
 * Both desks printed `p.pnl == null ? p.detail : pctPts(p.pnl)`, so the first
 * position with a cost and a fresh mark lost its dollar value to its return.
 * One function for both renderers, so neither can go back to choosing.
 */
export function positionFigures(p: { detail: string; pnl: number | null }): {
  value: string;
  pct: string | null;
  tone: "up" | "down" | "";
} {
  if (p.pnl === null || !Number.isFinite(p.pnl)) return { value: p.detail, pct: null, tone: "" };
  return { value: p.detail, pct: pctPts(p.pnl), tone: p.pnl < 0 ? "down" : "up" };
}

/**
 * THE HOLDINGS, AS THE CHAT MODEL IS HANDED THEM, under the key the system
 * prompt names.
 *
 * `positions` used to be `mine.glance` — a STRATEGY descriptor whose `legs`
 * are percentage weights. So an owner asked their agent what NVDA and QQQ had
 * cost and when it would sell, and it answered that it held nothing but cash,
 * while the panel beside the chat listed both. It was not hallucinating; it was
 * reading the payload it was given.
 *
 * Cost and P&L travel with each holding, because "should I take this profit"
 * cannot be answered from a value alone. NULL, never 0, when the ledger has no
 * basis — the difference between not knowing what something cost and believing
 * it was free. And no return on a cost the ledger cannot vouch for: the same
 * rule the desk applies (positionsOf), so the chat cannot state a "+20%" the
 * panel beside it withholds. `costConfirmed` says which case it is.
 */
export function chatPositionsOf(mine: LiveMine) {
  return (mine.positions ?? []).map((p) => {
    const confirmed = p.costUsd !== null && p.costFromQuote === false;
    return {
      symbol: p.symbol,
      valueUsd: p.valueUsd,
      costUsd: p.costUsd,
      costConfirmed: p.costUsd === null ? null : confirmed,
      unrealisedPct: p.pnlPct === null || !confirmed ? null : Math.round(p.pnlPct * 10) / 10,
      priceStale: p.stale,
      // THIS holding's own stop, graded when it was bought. Null means it
      // carries no grade and the book-wide `stopLossBps` applies — the
      // distinction matters because "what would make you sell THIS" is the
      // question owners actually ask, and one number for a whole book was
      // never the honest answer to it.
      stopLossBps: p.floorBps,
      stopWhy: p.floorWhy,
    };
  });
}
