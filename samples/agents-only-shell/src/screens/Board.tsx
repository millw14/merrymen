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
  { id: "24H", points: 2 },
  { id: "7D", points: 8 },
  { id: "30D", points: 31 },
  { id: "ALL", points: Number.POSITIVE_INFINITY },
];

interface Row {
  agent: LiveAgent;
  rank: number;
  ret: number | null;
  have: number;
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
  const [win, setWin] = useState<WindowId>("30D");
  const rows = useMemo(
    () => rank(agents, theses, mine, win),
    [agents, theses, mine, win],
  );

  const mineSlug = mine?.slug ?? "northstar";

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

export function haveOf(
  agent: LiveAgent,
  theses: Thesis[],
  mine: LiveMine | null,
): number {
  if (mine?.slug === agent.slug && mine.equity != null) return mine.equity;
  const seats = new Map<string, number>();
  const posts = theses
    .filter((t) => t.slug === agent.slug)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  for (const t of posts) {
    const size = sizeOf(t);
    if (size == null || !t.symbol) continue;
    const sym = t.symbol.toUpperCase();
    if (t.action === "sell")
      seats.set(sym, Math.max(0, (seats.get(sym) ?? 0) - size));
    else seats.set(sym, (seats.get(sym) ?? 0) + size);
  }
  const n = [...seats.values()].reduce((sum, v) => sum + v, 0);
  if (n > 0) return n;
  return stakeOf(agent);
}

function stakeOf(agent: LiveAgent): number {
  let h = 0;
  for (let i = 0; i < agent.slug.length; i++)
    h = (h * 31 + agent.slug.charCodeAt(i)) >>> 0;
  const start = 60 + (h % 160);
  return Math.round(start * (1 + (agent.pnlBps ?? 0) / 10_000) * 100) / 100;
}

function rank(
  agents: LiveAgent[],
  theses: Thesis[],
  mine: LiveMine | null,
  win: WindowId,
): Row[] {
  const spec = WINDOWS.find((w) => w.id === win) ?? WINDOWS[2]!;

  const score = (a: LiveAgent): number | null => {
    const n = Math.min(spec.points, a.curve.length);
    if (n < 2) return a.pnlBps;
    return curveReturn(a.curve.slice(a.curve.length - n), n);
  };

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
