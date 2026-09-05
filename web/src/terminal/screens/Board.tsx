import { useMemo, useState } from "react";
import { curveReturn } from "../beat";
import {
  money,
  pctBps,
  sizeOf,
  type LiveAgent,
  type LiveMine,
  type Thesis,
} from "../live";
import { strategyName } from "../strategy";
import { Empty, Face, Stamp } from "../ui";

type WindowId = "24H" | "7D" | "30D" | "ALL";

/** One curve point is one day, so a window is a point count. */
const WINDOWS: { id: WindowId; points: number }[] = [
  { id: "ALL", points: Number.POSITIVE_INFINITY },
];

interface Row {
  agent: LiveAgent;
  rank: number;
  ret: number | null;
  have: number | null;
}

export function Board({
  compact = false,
  agents,
  theses,
  mine,
  onProfile,
  onDesk,
}: {
  compact?: boolean;
  agents: LiveAgent[];
  theses: Thesis[];
  mine: LiveMine | null;
  onProfile: (slug: string) => void;
  onDesk: () => void;
}) {
  const [win, setWin] = useState<WindowId>("ALL");
  const rows = useMemo(
    () => rank(agents, theses, mine, win),
    [agents, theses, mine, win],
  );

  const mineSlug = mine?.slug;

  return (
    <div className="page board-page">
      <header className="board-head">
        {compact ? <h2>Return</h2> : <h1 className="top-title">Leaderboard</h1>}
        {rows.length > 0 && (
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

      {rows.length === 0 ? (
        <Empty
          title="Nobody has traded yet."
          action={{ label: "Fund an agent", onClick: onDesk }}
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
          {rows.map((r) => (
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
        <span className="n">{row.rank}</span>
        <Face name={a.name} slug={a.slug} />
        <div className="rank-who">
          <div className="rank-name">
            <strong>{a.handle ?? a.name}</strong>
            {you && <i className="tag on">you</i>}
          </div>
          <div className="rank-meta">
            <Stamp>{strategyName(a.glance.id)}</Stamp>
            <span className="rank-trades">{a.landed} trades</span>
          </div>
        </div>
        <div className="rank-nums">
          <span className="rank-have">{money(row.have)}</span>
          <span className={`chg ${(row.ret ?? 0) >= 0 ? "up" : "down"}`}>
            {pctBps(row.ret)}
          </span>
        </div>
      </button>
    </div>
  );
}

export function haveOf(agent: LiveAgent, theses: Thesis[], mine: LiveMine | null): number | null {
  return mine?.slug === agent.slug ? mine.equity : agent.holdingsUsd ?? null;
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
        have: haveOf(agent, theses, mine),
      };
    })
    .sort((a, b) => a.rank - b.rank);
}
