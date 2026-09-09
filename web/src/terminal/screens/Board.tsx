import { useMemo, useState } from "react";
import { curveReturn } from "../beat";
import {
  money,
  pctBps,
  sizeOf,
  type LiveAgent,
  type LiveMine,
  type ReadState,
  type Thesis,
} from "../live";
import { strategyName } from "../strategy";
import { Empty, ReadEmpty, Face, Stamp, NameBlock } from "../ui";
import { unrankedLabel, unrankedShort } from "@/lib/rank-pnl";

type WindowId = "24H" | "7D" | "30D" | "ALL";

/** One curve point is one day, so a window is a point count. */
const WINDOWS: { id: WindowId; points: number }[] = [
  { id: "ALL", points: Number.POSITIVE_INFINITY },
];

interface Row {
  agent: LiveAgent;
  rank: number;
  ret: number | null;
}

export function Board({
  compact = false,
  preview = false,
  agents,
  theses,
  mine,
  onProfile,
  onDesk,
  read = "ok",
}: {
  compact?: boolean;
  preview?: boolean;
  /** Whether the leaderboard read happened at all — see ReadEmpty. */
  read?: ReadState;
  agents: LiveAgent[];
  theses: Thesis[];
  mine: LiveMine | null;
  onProfile: (slug: string) => void;
  onDesk: () => void;
}) {
  const [win, setWin] = useState<WindowId>("ALL");
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(
    () => rank(agents, theses, mine, win),
    [agents, theses, mine, win],
  );

  const mineSlug = mine?.slug;

  return (
    <div className={`page board-page${preview ? " board-preview" : ""}`}>
      <header className="board-head">
        {preview ? <h2>Leaderboard</h2> : compact ? <h2>Return</h2> : <h1 className="top-title">Leaderboard</h1>}
        {preview && rows.length > 5 && <button onClick={()=>setShowAll(value=>!value)}>{showAll ? "Show fewer" : "View all"}</button>}
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
        <details className="ranking-help"><summary>How returns are measured</summary><p>No deposit means no capital to measure a return against. No completed trades means no return to measure. Dividing a pretend book by a real deposit publishes a number that never happened, so returns without evidenced capital stay unranked.</p></details>
      )}

      {rows.length === 0 ? (
        <ReadEmpty
          kind="board" compact={preview}
          state={read}
          title="Nobody has traded yet."
          action={preview ? undefined : { label: "Fund an agent", onClick: onDesk }}
        />
      ) : (
        <div className="board">
          <div className="desktop-board-columns" aria-hidden="true">
            <span>#</span>
            <span>Agent</span>
            <span>Strategy / trades</span>
            <span>Capital</span>
            <span>Return</span>
          </div>
          {(preview && !showAll ? rows.slice(0,5) : rows).map((r) => (
            <Rank
              key={r.agent.slug}
              row={r}
              you={r.agent.slug === mineSlug}
              onProfile={onProfile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Rank({
  row,
  you,
  onProfile,
}: {
  row: Row;
  you: boolean;
  onProfile: (slug: string) => void;
}) {
  const a = row.agent;
  const cls = ["rank", you ? "you" : ""].filter(Boolean).join(" ");

  return (
    <div className={cls}>
      <button
        type="button"
        className="rank-hit"
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
          </div>
        </div>
        <div className="rank-nums">
          {/*
            NO HOLDINGS COLUMN. `holdingsUsd` is declared on LiveAgent and set
            by nothing — haveOf falls back to it for every agent but your own,
            so the column rendered one figure and five long dashes, and no
            amount of waiting would have filled them. A column that cannot be
            filled is not an empty column, it is a promise the page cannot keep.
          */}
          <span title={a.unrankedWhy ? unrankedLabel(a.unrankedWhy) : undefined} className={`chg ${row.ret == null ? "" : row.ret >= 0 ? "up" : "down"}`}>
            {row.ret == null ? a.unrankedWhy ? unrankedShort(a.unrankedWhy) : "Unranked" : pctBps(row.ret)}
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
 */
export function tradeLine(agent: LiveAgent): string {
  const landed = agent.landed ?? 0;
  if (landed > 0) return `${landed} trade${landed === 1 ? "" : "s"}`;
  const paper = agent.filledPaper ?? 0;
  if (paper > 0) return `${paper} on paper`;
  return "No trades yet";
}

function rank(
  agents: LiveAgent[],
  theses: Thesis[],
  mine: LiveMine | null,
  win: WindowId,
): Row[] {
  const spec = WINDOWS.find((w) => w.id === win) ?? WINDOWS[2]!;

  const score = (a: LiveAgent): number | null => a.pnlBps;

  const order = (list: { slug: string; ret: number | null }[]) =>
    [...list]
      .sort(
        (a, b) =>
          (b.ret ?? Number.NEGATIVE_INFINITY) -
          (a.ret ?? Number.NEGATIVE_INFINITY),
      )
      .map((r, i) => [r.slug, i + 1] as const);

  const nowScores = agents.map((a) => ({ slug: a.slug, ret: score(a) }));
  const nowRank = new Map(order(nowScores));

  return agents
    .map((agent) => {
      const ret = nowScores.find((s) => s.slug === agent.slug)?.ret ?? null;
      const r = nowRank.get(agent.slug) ?? 0;
      return {
        agent,
        rank: r,
        ret,
      };
    })
    .sort((a, b) => a.rank - b.rank);
}
