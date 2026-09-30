/**
 * THE DESK'S PERPS PANEL — the agent's perpetuals on Lighter, as its worker
 * reported them (docs/perps.md "Surfaces"; screens/Agent.tsx draws it inside
 * the portfolio list, beside the holdings and never among them).
 *
 * Its own module so it can be rendered and read in a test without the whole
 * desk: every sentence here is a claim about somebody's leveraged money.
 */
import { perpsBlockerText } from "@merrymen/core";
import { whenOf } from "./clock";
import { coinPrice, money, type DeskPerpRow, type DeskPerps } from "./live";

/** A venue price as printed: its own decimals kept when it is small, a dash when not read. */
const venuePrice = (s: string | null): string => (s === null ? "—" : coinPrice(Number(s)));
/** Signed dollars, holder's view: + received or gained, − paid or lost. */
const signedMoney = (n: number): string => `${n >= 0 ? "+" : "−"}${money(Math.abs(n))}`;
/** 2 → "2x", 3.33 → "3.33x"; null is "not read", never a guess at the default. */
const leverageText = (n: number | null): string => (n === null ? "leverage not read" : `${Math.round(n * 100) / 100}x`);

/**
 * THE AGENT'S PERPETUALS ON LIGHTER, as its worker reported them — market,
 * side, size, entry and mark, leverage, margin, liquidation price and how far
 * away it is, the stop, funding and unrealized P&L (docs/perps.md "Surfaces").
 *
 * EVERY FIGURE IS THE WORKER'S, and every missing one says it is missing: a
 * mark nobody read is "—", a liquidation distance without both prices is not
 * computed, a stop not SEEN resting is "no stop seen" rather than the level
 * it was meant to be. The practice book is labelled on the panel and on every
 * row. A report that could not be read, a venue the worker could not read, and
 * a read that has gone stale are each said in words above the rows — never
 * drawn as a quiet, empty book.
 *
 * Close controls only propose the existing owner-confirmed chat cards. They
 * never send an order from a single tap, and remain available on unread books.
 *
 * WHICH MONEY IS ALWAYS SAID. `book` "paper" is tagged Paper on the panel and
 * every row; a book the report does not place is said as not stated, never
 * drawn as real money at Lighter (lib/perps-view.ts perpsBookOf).
 */
/**
 * WHAT THE DESK COUNTS FOR PERPS, AND WHAT IT SAYS BESIDE THE COUNT.
 *
 * A venue the worker could not read is not "0 positions": the worker's
 * report then lists only the ledger positions it could still render, and
 * counts every held one in `stopsMissing` (none is seen resting when nothing
 * was read). So the count is the larger of the two — what was last held, never
 * fewer — and the line says the venue (or the practice book) was not read.
 */
export function perpsDeskCount(perps: DeskPerps | null): { count: number; suffix: string } {
  if (perps === null) return { count: 0, suffix: "" };
  if (perps.read === "unreadable") return { count: 0, suffix: " · Lighter unread" };
  if (!perps.venueRead) {
    return {
      count: Math.max(perps.rows.length, perps.stopsMissing),
      suffix: perps.paper ? " · practice book unread" : " · Lighter unread",
    };
  }
  return { count: perps.rows.length, suffix: "" };
}

/**
 * The label of the money row beside "In vaults": real money at Lighter, the
 * practice book's simulated money, or — when the report does not place the
 * book — neither claim.
 */
export function perpsMoneyLabel(perps: Pick<DeskPerps, "paper" | "book">): string {
  if (perps.paper) return "Paper perps";
  if (perps.book === null) return "Perps · paper or real not stated";
  return "At Lighter";
}

/** The incident's words are core's (perpsBlockerText), so the desk and every other surface say the same thing. */
const INCIDENT = perpsBlockerText("perps-unknown-activity");

export function PerpsPanel({ perps, nowMs = Date.now(), onClose, onFlatten, busy = false }: {
  perps: DeskPerps; nowMs?: number; onClose?: (market: string) => void; onFlatten?: () => void; busy?: boolean;
}) {
  if (perps.read === "unreadable") {
    return (
      <section className="desk-perps" aria-label="Perpetuals on Lighter">
        <div className="desk-perps-head">
          <strong>Perpetuals · Lighter</strong>
          {onFlatten && <button type="button" disabled={busy} onClick={onFlatten}>Close all</button>}
        </div>
        <p className="desk-perps-note is-warn">
          Your agent’s perpetuals report couldn’t be read, so what it holds on Lighter is unknown — it may have open
          leveraged positions there. That’s our read failing, not an empty account.
        </p>
      </section>
    );
  }
  // What the worker last held, when it could not look: its listed rows, or its
  // count of held positions (stopsMissing counts every one it holds when the
  // venue is unread) — whichever is larger. Unknown is never fewer.
  const recorded = perps.venueRead ? perps.rows.length : Math.max(perps.rows.length, perps.stopsMissing);
  const unlisted = recorded - perps.rows.length;
  return (
    <section className={perps.paper ? "desk-perps is-paper" : "desk-perps"} aria-label="Perpetuals on Lighter">
      <div className="desk-perps-head">
        <strong>Perpetuals · Lighter</strong>
          {onFlatten && <button type="button" disabled={busy} onClick={onFlatten}>Close all</button>}
        {perps.paper && <span className="desk-perps-tag">Paper</span>}
        {perps.book === null && <span className="desk-perps-tag">Paper or real: not stated</span>}
      </div>
      {perps.book === null && (perps.rows.length > 0 || perps.atLighterUsd !== 0) && (
        <p className="desk-perps-note is-warn">
          Your agent’s report doesn’t say whether these are practice (paper) or real-money positions, so they are shown
          without either label.
        </p>
      )}
      {perps.incident && (
        <p className="desk-perps-note is-warn">
          {INCIDENT.what}
          {INCIDENT.remedy ? ` ${INCIDENT.remedy}` : ""}
        </p>
      )}
      {!perps.venueRead ? (
        <p className="desk-perps-note is-warn">
          {perps.paper ? "The practice book" : "Lighter"} couldn’t be read just now
          {perps.rows.length > 0 ? ". These are the positions last recorded, without a current mark" : ""}
          {unlisted > 0
            ? `${perps.rows.length > 0 ? ";" : "."} ${unlisted === 1 ? "one more position was" : `${unlisted} ${perps.rows.length > 0 ? "more " : ""}positions were`} held at the last record and ${unlisted === 1 ? "isn’t" : "aren’t"} listed`
            : ""}
          {" "}— what is there now is unknown.
        </p>
      ) : perps.stale && perps.venueReadAt !== null ? (
        <p className="desk-perps-note">Last read {whenOf(perps.venueReadAt, nowMs)} ago — this may have changed since.</p>
      ) : null}
      {perps.rows.length === 0 && perps.venueRead && (
        <p className="desk-perps-note">
          {perps.stale ? "No open positions at the last read." : "No open positions."}
        </p>
      )}
      {perps.rows.map((r) => (
        <PerpRow key={`${r.market}:${r.side}`} r={r} onClose={onClose} busy={busy} />
      ))}
      {perps.stopsMissing > 0 && (
        <p className="desk-perps-note is-warn">
          {perps.stopsMissing === 1 ? "One position has" : `${perps.stopsMissing} positions have`} no stop seen resting
          {perps.paper ? "" : " at Lighter"}.
        </p>
      )}
      {perps.blocker && !(perps.incident && perps.blocker.what === INCIDENT.what) && (
        <p className="desk-perps-note">
          {perps.blocker.what}
          {perps.blocker.remedy ? ` ${perps.blocker.remedy}` : ""}
        </p>
      )}
    </section>
  );
}

function PerpRow({ r, onClose, busy }: { r: DeskPerpRow; onClose?: (market: string) => void; busy: boolean }) {
  const liq =
    r.liqPrice === null
      ? "no liquidation price read"
      : `liq. ${venuePrice(r.liqPrice)}${r.liqDistancePct === null ? "" : ` (${r.liqDistancePct}% away)`}`;
  return (
    <div className="desk-perp">
      <span className="desk-perp-main">
        <strong>
          {r.market} <span className={r.side === "long" ? "up" : "down"}>{r.side === "long" ? "Long" : "Short"}</span>
        </strong>
        <small>
          {r.size} @ {venuePrice(r.entry)} · mark {venuePrice(r.mark)} · {leverageText(r.leverage)}
          {r.paper ? " · paper" : ""}
        </small>
      </span>
      <span className="desk-perp-money">
        <strong className={r.unrealisedUsd === null ? "" : r.unrealisedUsd < 0 ? "down" : "up"}>
          {r.unrealisedUsd === null ? "P&L not read" : signedMoney(r.unrealisedUsd)}
        </strong>
        <small>margin {money(r.marginUsd)}</small>
      </span>
      {onClose && <button type="button" disabled={busy} onClick={() => onClose(r.market)}>Close {r.market}</button>}
      <small className="desk-perp-risk">
        {liq} · {r.stopTrigger === null ? "no stop seen" : `stop ${venuePrice(r.stopTrigger)}`} ·{" "}
        {r.fundingUsd === null ? "funding not read" : `funding ${signedMoney(r.fundingUsd)}`}
      </small>
    </div>
  );
}
