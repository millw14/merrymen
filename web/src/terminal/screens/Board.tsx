import { useMemo, useState } from "react";
import { curveReturn } from "../beat";
import {
  money,
  pctBps,
  sizeOf,
  type LiveAgent,
  type LiveMine,
  type ReadState,
  type RetiredAgent,
  type Thesis,
} from "../live";
import { strategyName } from "../strategy";
import { Empty, ReadEmpty, Face, Stamp, NameBlock } from "../ui";
import { unrankedShort } from "@/lib/rank-pnl";
import { performanceOf } from "../agent-performance";
import { boardOrder, type BoardRow } from "../board-order";
import { useNow } from "../clock";
import { shortDateTime } from "@/lib/format";

type WindowId = "24H" | "7D" | "30D" | "ALL";

/** One curve point is one day, so a window is a point count. */
const WINDOWS: { id: WindowId; points: number }[] = [
  { id: "ALL", points: Number.POSITIVE_INFINITY },
];

export function Board({
  compact = false,
  preview = false,
  agents,
  theses,
  mine,
  onProfile,
  onDesk,
  read = "ok",
  retired = null,
  retiredAgents = [],
}: {
  compact?: boolean;
  preview?: boolean;
  /** Whether the leaderboard read happened at all — see ReadEmpty. */
  read?: ReadState;
  /**
   * Accounts the leaderboard folded into a count instead of a row. Null when it
   * could not tell, and then nothing was folded and nothing is said.
   */
  retired?: number | null;
  /** The folded accounts with their final returns, listed under the count. */
  retiredAgents?: RetiredAgent[];
  agents: LiveAgent[];
  theses: Thesis[];
  mine: LiveMine | null;
  onProfile: (slug: string) => void;
  onDesk: () => void;
}) {
  const [win, setWin] = useState<WindowId>("ALL");
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => boardOrder(agents), [agents]);

  const mineSlug = mine?.slug;
  const folded = typeof retired === "number" && Number.isFinite(retired) ? retired : 0;
  // A minute is fine enough for "how old is this valuation", and it is the
  // only clock on this page.
  const nowSec = Math.floor(useNow(60_000) / 1000);

  return (
    <div className={`page board-page${preview ? " board-preview" : ""}`}>
      <header className="board-head">
        {preview ? <h2>Leaderboard</h2> : compact ? <h2>Return</h2> : <h1 className="top-title">Leaderboard</h1>}
        {preview && rows.length > 5 && <button onClick={()=>setShowAll(value=>!value)}>{showAll ? "Show fewer" : `View all ${rows.length}`}</button>}
        {!preview && rows.length > 0 && (
          <div className="wins">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                className={win === w.id ? "on" : ""}
                onClick={() => setWin(w.id)}
              >
                {w.id}
              </button>
            ))}
          </div>
        )}
      </header>
      {/* WHY AN AGENT IS UNRANKED, kept off the compact Home preview and kept on
          the full board. "No deposit" and "never filled" are different facts
          about somebody's agent and only one of them is fixed by depositing —
          and a paper book divided by a real deposit is the +2643.3% incident
          this repo already has. Collapsed, so it costs a line and not a screen. */}
      {!preview && (
        // ONE LINE ON PURPOSE: captions.test.ts reads this file as text, so a
        // wrapped sentence breaks a guard that is about the words being present.
        <details className="ranking-help"><summary>How returns are measured</summary><p>All agents are listed; only eligible live returns are ranked. Paper returns measure the change since the first recorded valuation of the paper book in the current accounting period and remain outside live rankings. Switching between paper and live does not reset that paper baseline. Inactive agents remain unranked. No deposit means no capital to measure a return against. No completed trades means no return to measure, so a book that has not traded shows No trades yet rather than a flat return, and trades no valuation includes yet show Awaiting first valuation. Dividing a pretend book by a real deposit publishes a number that never happened, so returns without evidenced capital stay unranked. Below the ranked live returns, every other agent that shows a return is listed by it, highest first, paper included, and then those with no return to show.</p></details>
      )}

      {rows.length === 0 ? (
        <ReadEmpty
          kind="board" compact={preview}
          state={read}
          // Not "nobody" when accounts were folded away: they ran, and the line
          // below counts them.
          title={folded > 0 ? "No agent is running right now." : "Nobody has traded yet."}
          action={preview ? undefined : { label: "Fund an agent", onClick: onDesk }}
        />
      ) : (
        <div className="board">
          <div className="desktop-board-columns" aria-hidden="true">
            <span>#</span>
            <span>Agent</span>
            <span>Strategy / trades</span>
            <span>Current value</span>
            <span>Return</span>
          </div>
          {(preview && !showAll ? rows.slice(0,5) : rows).map((r) => (
            <Rank
              key={r.agent.slug}
              row={r}
              you={r.agent.slug === mineSlug}
              nowSec={nowSec}
              onProfile={onProfile}
            />
          ))}
        </div>
      )}
      {/* THE ROWS THIS BOARD DOES NOT SHOW, counted. Killed, lapsed and
          unlinked accounts nothing is running are folded out of the list, and
          hiding them without a word would misstate how many there have been.
          Only a number is printed: null means the server could not tell, and
          then it folded nothing. Zero folded nothing either. */}
      {folded > 0 && (
        <details className="board-retired">
          <summary title="Accounts nothing is running any more: killed, expired, or never linked to a named agent. One agent re-granted can leave more than one.">
            Retired accounts ({folded})
          </summary>
          {/* FROZEN FINAL RETURNS: nothing runs these, so each figure is the
              last its book recorded, never ranked among the agents above. */}
          {retiredAgents.length > 0 && (
            <div className="board-retired-list">
              {retiredAgents.map((r, i) => (
                <RetiredRank key={`${r.slug ?? r.name}-${i}`} row={r} onProfile={onProfile} />
              ))}
            </div>
          )}
        </details>
      )}
    </div>
  );
}

function Rank({
  row,
  you,
  nowSec,
  onProfile,
}: {
  row: BoardRow;
  you: boolean;
  nowSec: number;
  onProfile: (slug: string) => void;
}) {
  const a = row.agent;
  const performance = performanceOf(a, nowSec);
  // A state stands in for the figure (performanceOf), so it is never also
  // coloured as a gain or a loss.
  const displayedReturn = performance.state === null ? performance.bps : null;
  const cls = ["rank", you ? "you" : ""].filter(Boolean).join(" ");

  return (
    <div className={cls}>
      <button
        type="button"
        className="rank-hit"
        disabled={a.profileAvailable === false}
        onClick={() => onProfile(a.slug)}
      >
        <span className="n">{row.ret == null ? "—" : row.rank}</span>
        <Face name={a.name} slug={a.slug} />
        <div className="rank-who">
          <div className="rank-name">
            <NameBlock title={a.name} owner={a.owner} verified={a.ownerVerified === true} />
            {you && <i className="tag on">you</i>}
          </div>
          <div className="rank-meta">
            {a.glance.known === false ? null : <Stamp>{strategyName(a.glance.id)}</Stamp>}
            <span className="rank-trades">{tradeLine(a)}</span>
            {a.mode && a.mode !== "live" && (!a.performance || a.mode !== performance.book) && !performance.notRunning
              && <Stamp>{a.mode === "paper" ? "Paper" : "Inactive"}</Stamp>}
            {/* KEPT THROUGH THE RECOVERY HOLD, and said neutrally: never
                "expired", never "re-sign" — see read-leaderboard.ts. */}
            {performance.notRunning && <Stamp>Not running</Stamp>}
          </div>
        </div>
        <div className="rank-nums">
          <span className="rank-value" title={performance.title}>
            <span className="rank-have" aria-label={`Current value ${performance.value}`}>{performance.value}</span>
            {/* CLEAN ON PURPOSE: when it was valued, and whether a newer
                trade is in it, are in the title — not lines under the figure. */}
            {a.performance && <small className="rank-book">{performance.bookLabel}</small>}
          </span>
          <span className="rank-return" title={performance.title}>
            <span className={`chg ${displayedReturn == null || displayedReturn === 0 ? "" : displayedReturn > 0 ? "up" : "down"}${performance.state !== null ? " performance-state" : ""}`}>
              {performance.state ?? (displayedReturn == null ? noReturn(a) : `${performance.estimated ? "≈ " : ""}${pctBps(displayedReturn)}`)}
            </span>
            {performance.pnl !== null && <small className="rank-pnl">{performance.pnl} P&L</small>}
          </span>
        </div>
      </button>
    </div>
  );
}

/**
 * WHAT A ROW WITH NO MEASURED RETURN SAYS — never a blank. A book that never
 * traded says so; one from an older server prints its figure, approximate;
 * one whose trades no valuation includes yet says that. The row's tooltip
 * (performanceOf's title) carries the detail.
 */
function noReturn(a: LiveAgent): string {
  const trades = (a.liveFills ?? a.landed ?? 0) + (a.paperFills ?? a.filledPaper ?? 0);
  if (trades === 0) return "No trades yet";
  // Only from an older server that sent no performance: a current one's
  // performance supersedes these, and they are not a fallback for it.
  const legacy = a.performance ? undefined
    : [a.pnlBps, a.paperPnlBps].find((n): n is number => typeof n === "number" && Number.isFinite(n) && n !== 0);
  if (legacy !== undefined) return `≈ ${pctBps(legacy)}`;
  // The actual reason when the server gave one, unless the fills show the
  // valuation simply has not caught up yet.
  const pending = a.performance?.valuation === "awaiting" || a.performance?.fillsAtMark === 0;
  if (!pending && a.unrankedWhy) return unrankedShort(a.unrankedWhy);
  return "Awaiting valuation";
}

function RetiredRank({ row, onProfile }: { row: RetiredAgent; onProfile: (slug: string) => void }) {
  const ret = row.pnlBps;
  const approx = row.estimated ? "≈ " : "";
  const pnl = row.pnlUsdg === null ? null
    : `${approx}${row.pnlUsdg > 0 ? "+" : row.pnlUsdg < 0 ? "−" : ""}${money(Math.abs(row.pnlUsdg))}`;
  return (
    <div className="rank retired" title={row.lastValuedAt !== null ? `Last valued ${shortDateTime(row.lastValuedAt * 1000)}` : undefined}>
      <button
        type="button"
        className="rank-hit"
        disabled={row.slug === null}
        onClick={() => row.slug && onProfile(row.slug)}
      >
        <span className="n">—</span>
        <Face name={row.name} slug={row.slug ?? row.name} />
        <div className="rank-who">
          <div className="rank-name"><NameBlock title={row.name} /></div>
          <div className="rank-meta">
            <span className="rank-trades">
              {row.trades > 0 ? `${row.trades} ${row.book === "paper" ? "paper " : ""}trade${row.trades === 1 ? "" : "s"}` : "No trades"}
            </span>
            <Stamp>Retired</Stamp>
          </div>
        </div>
        <div className="rank-nums">
          <span className="rank-value">
            {row.book && <small className="rank-book">{row.book === "paper" ? "Paper" : "Live"}</small>}
          </span>
          <span className="rank-return">
            <span className={`chg ${ret == null || ret === 0 ? "" : ret > 0 ? "up" : "down"}`}>
              {ret == null ? (row.trades === 0 ? "No trades" : "Not valued") : `${approx}${pctBps(ret)}`}
            </span>
            {pnl !== null && <small className="rank-pnl">{pnl} P&L</small>}
          </span>
        </div>
      </button>
    </div>
  );
}

/**
 * WHAT THIS AGENT HAS ACTUALLY DONE — the one line about it that is true.
 *
 * The row used to read "Strategy not published", which is not a fact about the
 * agent at all: `publicGlance()` takes no arguments and hard-codes it, so six
 * agents printed one constant six times and nothing could ever change it. The
 * public wire has never carried a strategy and is not going to — an owner's
 * configuration is theirs — so the honest move is to stop putting a blank
 * where a fact goes and print a fact the wire DOES carry.
 *
 * LANDED AND PAPER STAY APART, as read-agent.ts insists: the page once read
 * "filled 0" beside ten posts saying "filled on paper", and folding them
 * together is what re-arms that. A simulated fill is a real thing to have
 * done, and it is not a trade.
 *
 * AND A TRADE IS A TRADE. `landed` and `filledPaper` count operations, so a
 * book whose only simulated activity was transfers read "11 paper trades"
 * beside a profile that found none. Where the server counted trades
 * (paperFills, liveFills) those are what is called trades; an operation that
 * landed and is not one — a vault deposit — is still something the agent did,
 * and says so. An older server sends operations only, read as before.
 */
export function tradeLine(agent: LiveAgent): string {
  const paper = agent.paperFills ?? agent.filledPaper ?? 0;
  if (agent.mode === "paper") return `${paper} paper trades`;
  const live = agent.liveFills ?? agent.landed ?? 0;
  if (live > 0) return `${live} trade${live === 1 ? "" : "s"}`;
  const landed = agent.landed ?? 0;
  if (landed > 0) return `${landed} operation${landed === 1 ? "" : "s"}`;
  if (paper > 0) return `${paper} on paper`;
  return "No trades yet";
}

