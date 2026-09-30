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
/** One spot holding as the chat model is handed it. */
export interface ChatSpotPosition {
  symbol: string;
  valueUsd: number;
  costUsd: number | null;
  costConfirmed: boolean | null;
  unrealisedPct: number | null;
  priceStale: boolean;
  stopLossBps: number | null;
  stopWhy: string | null;
}

/** One perp position as the chat model is handed it — see chatPerpsOf. */
export interface ChatPerpFields {
  kind: "perp";
  side: "long" | "short";
  /** Practice (true), real (false), or null when the report does not say which — never guessed. */
  paper: boolean | null;
  size: string;
  entryPrice: string;
  markPrice: string | null;
  leverage: number | null;
  marginUsd: number;
  unrealisedUsd: number | null;
  liquidationPrice: string | null;
  liquidationDistancePct: number | null;
  stopTrigger: string | null;
  fundingUsd: number | null;
  note: string;
}

/** What the perps account line adds: the money in the perps book, beside the positions. */
export interface ChatPerpsAccountFields {
  /** Rule 12's perpAccountUsdg in whole USD; null when a term of it was not read. */
  atLighterUsd: number | null;
}

/** The fields a row of another kind does not carry, said as absent so any row can be asked for them. */
type Absent<T> = { [K in keyof T]?: undefined };

export type ChatPosition =
  | (ChatSpotPosition & Absent<ChatPerpFields> & Absent<ChatPerpsAccountFields>)
  | (Absent<Omit<ChatSpotPosition, "symbol">> & ChatPerpFields & { symbol: string } & Absent<ChatPerpsAccountFields>)
  | (Absent<ChatSpotPosition> &
      Absent<Omit<ChatPerpFields, "kind" | "note">> &
      Absent<ChatPerpsAccountFields> & { kind: "perps-unread"; venue: "Lighter"; note: string })
  | (Absent<ChatSpotPosition> &
      Absent<Omit<ChatPerpFields, "kind" | "note" | "paper">> &
      ChatPerpsAccountFields & { kind: "perps-account"; venue: "Lighter"; paper: boolean | null; note: string });

export function chatPositionsOf(mine: LiveMine): ChatPosition[] {
  const spot: ChatPosition[] = (mine.positions ?? []).map((p) => {
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
  return [...spot, ...chatPerpsOf(mine.perps)];
}

/**
 * THE PERPS, AS THE CHAT MODEL IS HANDED THEM — so an agent holding a 3x short
 * never tells its owner it holds nothing but cash (docs/perps.md rule 11).
 *
 * Each row says what it is in its own words (`kind`, `note`), because the
 * system prompt was written for spot holdings and a leveraged position read
 * as one — a value, a cost, a % — is the wrong thing to reason from. Same
 * honesty as the spot rows: a null is "not read", never 0; the practice book
 * says `paper`; a book the report does not place says `paper: null` and that
 * it is not known which; a stale or unread venue read says so on every row.
 *
 * UNKNOWN IS A ROW, NOT A SILENCE. Leaving the list without perps when the
 * model cannot see them is the "I hold nothing" this exists to stop, so it is
 * handed a `perps-unread` line when the report could not be read at all, AND
 * when the report says Lighter (or the practice book) could not be read —
 * even with no position listed, which is exactly what a restart during an
 * outage reports (live positions are re-read at arm, never seeded). When
 * fewer positions are listed than were last recorded, it says how many more.
 *
 * MONEY AT LIGHTER WITH NO POSITION IS STILL MONEY. A flat account with
 * collateral at the venue, or margin in transit, is handed as a
 * `perps-account` line with the amount (null said as not read), so "what do I
 * have" is not answered from the smart account alone.
 *
 * A report the worker has not written (null/undefined) adds nothing: that is
 * an agent that has not said it uses perps, and the model is told nothing
 * about them rather than something invented.
 */
export function chatPerpsOf(perps: LiveMine["perps"]): ChatPosition[] {
  if (!perps) return [];
  if (perps.read === "unreadable") {
    return [
      {
        kind: "perps-unread",
        venue: "Lighter",
        note: "Your perpetual futures on Lighter could not be read. You may hold leveraged positions there: never say you hold nothing — say you cannot see them right now.",
      },
    ];
  }
  const paper: boolean | null = perps.book === null ? null : perps.book === "paper";
  const out: ChatPosition[] = [];
  if (!perps.venueRead) {
    // The worker's own count of what it last held (stopsMissing counts every
    // held position when it could not look), against what it could list.
    const recorded = Math.max(perps.rows.length, perps.stopsMissing);
    const unlisted = recorded - perps.rows.length;
    const where = paper === true ? "Your practice (paper) perpetuals book" : "Lighter";
    out.push({
      kind: "perps-unread",
      venue: "Lighter",
      note:
        `${where} could not be read just now, so what is held there now is unknown. ` +
        (perps.rows.length > 0
          ? "The positions listed are the last recorded ones, with no current mark or P&L. "
          : "") +
        (unlisted > 0
          ? `${unlisted} position${unlisted === 1 ? " was" : "s were"} held at the last record and ${unlisted === 1 ? "is" : "are"} not listed here. `
          : "") +
        (paper === null ? "Whether they are practice or real positions is not stated. " : "") +
        "Never say you hold nothing there — say you cannot see it right now.",
    });
  }
  const when = !perps.venueRead
    ? "Lighter could not be read, so this is the last recorded position, with no current mark"
    : perps.stale
      ? "Its last read is stale, so it may have changed since"
      : null;
  for (const r of perps.rows) {
    const rowPaper: boolean | null = paper === null ? null : r.paper;
    out.push({
      kind: "perp" as const,
      symbol: r.market,
      side: r.side,
      paper: rowPaper,
      size: r.size,
      entryPrice: r.entry,
      markPrice: r.mark,
      leverage: r.leverage,
      marginUsd: r.marginUsd,
      unrealisedUsd: r.unrealisedUsd,
      liquidationPrice: r.liqPrice,
      liquidationDistancePct: r.liqDistancePct,
      stopTrigger: r.stopTrigger,
      fundingUsd: r.fundingUsd,
      note:
        `${rowPaper === true ? "A PRACTICE (paper) " : "A "}${r.side} leveraged perpetual future on Lighter — not a holding in the smart account. ` +
        (rowPaper === null ? "Whether it is a practice (paper) or a real-money position is not stated: do not call it either. " : "") +
        `Its margin can be lost if the mark reaches the liquidation price. ` +
        // Only a stop SEEN resting reaches the report (worker perps/view.ts), so
        // a null is "none seen", which the model must not round up to "protected".
        (r.stopTrigger === null
          ? "No resting stop was seen for it."
          : rowPaper === true
            ? "Its practice stop is simulated by the agent."
            : "Its stop was seen resting at the venue.") +
        (when ? ` ${when}.` : ""),
    });
  }
  // WHAT IS IN THE PERPS BOOK, when there is anything to say about it: a
  // known non-zero amount, or one that could not be summed. A zero is the
  // known empty book and says nothing; an unread venue already has its line.
  if (perps.active && perps.venueRead && perps.atLighterUsd !== 0) {
    const amount = perps.atLighterUsd === null ? null : Math.round(perps.atLighterUsd * 100) / 100;
    const what =
      paper === true
        ? "Practice (paper) money in the perpetuals book — simulated, not real money"
        : paper === false
          ? "Money at Lighter (collateral, position margin, unrealised P&L and transfers in transit) — part of the agent's equity, not in the smart account"
          : "Money in the perpetuals book at Lighter — whether it is practice or real money is not stated";
    out.push({
      kind: "perps-account",
      venue: "Lighter",
      paper,
      atLighterUsd: amount,
      note:
        amount === null
          ? `${what}. Its total could not be read (a figure in it was not read): it is unknown, not zero.`
          : `${what}: ${amount.toFixed(2)} USD${perps.stale ? ", at a read that is now stale" : ""}.`,
    });
  }
  return out;
}
