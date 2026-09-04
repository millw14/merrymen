import { useMemo, useState } from "react";
import { curveReturn } from "../beat";
import { elapsed, useNow } from "../clock";
import { pctBps, type LiveAgent, type LiveMine, type LiveToken } from "../live";
import { ownerTag, strategyName } from "../strategy";
import { Coin, Delta, Empty, Face, Spark, Stamp } from "../ui";

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
  move: number;
}

export function Board({
  agents,
  tokens,
  mine,
  onProfile,
  onDesk,
}: {
  agents: LiveAgent[];
  tokens: LiveToken[];
  mine: LiveMine | null;
  onProfile: (slug: string) => void;
  onDesk: () => void;
}) {
  const now = useNow(1000);
  const [win, setWin] = useState<WindowId>("30D");
  const rows = useMemo(() => rank(agents, win), [agents, win]);

  if (rows.length === 0) {
    return <Empty title="Nobody has traded yet." action={{ label: "Fund an agent", onClick: onDesk }} />;
  }

  const mineSlug = mine?.slug ?? "northstar";

  return (
    <div className="page board-page">
      <div className="wire-top">
        <div className="wins">
          {WINDOWS.map((w) => (
            <button key={w.id} type="button" className={win === w.id ? "on" : ""} onClick={() => setWin(w.id)}>
              {w.id}
            </button>
          ))}
        </div>
      </div>

      <div className="board">
        {rows.map((r, i) => {
          const above = rows[i - 1];
          const isYou = r.agent.slug === mineSlug;
          const gap = isYou && above && r.ret != null && above.ret != null ? above.ret - r.ret : null;
          return (
            <Rank
              key={r.agent.slug}
              row={r}
              tokens={tokens}
              now={now}
              tier={i < 3 ? "podium" : i < 6 ? "chaser" : "plain"}
              you={isYou}
              gap={gap}
              onProfile={onProfile}
            />
          );
        })}
      </div>
    </div>
  );
}

function Rank({
  row,
  tokens,
  now,
  tier,
  you,
  gap,
  onProfile,
}: {
  row: Row;
  tokens: LiveToken[];
  now: number;
  tier: "podium" | "chaser" | "plain";
  you: boolean;
  gap: number | null;
  onProfile: (slug: string) => void;
}) {
  const a = row.agent;
  const last = a.last;
  const sym = last?.symbol?.toUpperCase() ?? null;
  const tok = sym ? tokens.find((t) => t.symbol.toUpperCase() === sym) : undefined;
  const cold = last?.at != null && now - last.at > 24 * 3_600_000;
  const podium = tier === "podium";
  const cls = ["rank", tier, you ? "you" : ""].filter(Boolean).join(" ");

  return (
    <div className={cls}>
      {gap != null && (
        <div className="rank-gapline">
          <span>
            <i>{"\u25B2"}</i>
            {pctBps(gap).replace("+", "")}
          </span>
        </div>
      )}
      <button type="button" className="rank-hit" onClick={() => onProfile(a.slug)}>
        <span className="n">{row.rank}</span>
        <Face name={a.name} slug={a.slug} large={podium} />
        <div className="rank-who">
          <div className="rank-name">
            <strong>{a.handle ?? a.name}</strong>
            {you && <i className="tag on">you</i>}
          </div>
          <div className="rank-meta">
            <Stamp>{strategyName(a.glance.id)}</Stamp>
          </div>
          {podium && (
            <p className="rank-run">
              {a.landed} trades{a.owner && a.owner !== "you" ? ` · ${ownerTag(a.owner)}` : ""}
            </p>
          )}
        </div>
        <div className="rank-nums">
          <span className={`chg ${(row.ret ?? 0) >= 0 ? "up" : "down"}`}>{pctBps(row.ret)}</span>
          <Delta value={row.move} size={12} />
        </div>
      </button>

      {tier !== "plain" && a.curve.length > 1 && (
        <div className="rank-spark">
          <Spark values={a.curve} down={(row.ret ?? 0) < 0} small />
        </div>
      )}

      {last && sym && tier !== "chaser" && (
        <button
          type="button"
          className={cold ? "rank-last cold" : "rank-last"}
          onClick={() => onProfile(a.slug)}
        >
          <Coin symbol={sym} logo={tok?.logo ?? ""} />
          <span>
            <strong>{a.handle ?? a.name}</strong> {verb(last.action)} {sym}
          </span>
          <em>{last.at != null ? elapsed(last.at, now).text : ""}</em>
        </button>
      )}

    </div>
  );
}

function verb(action: string | null): string {
  if (action === "buy") return "bought";
  if (action === "sell") return "sold";
  return "is holding";
}

function rank(agents: LiveAgent[], win: WindowId): Row[] {
  const spec = WINDOWS.find((w) => w.id === win) ?? WINDOWS[2]!;

  /** The same window length, slid back `back` days. That is what "since yesterday" means. */
  const score = (a: LiveAgent, back: number): number | null => {
    const end = a.curve.length - back;
    const n = Math.min(spec.points, end);
    if (n < 2) return a.pnlBps;
    return curveReturn(a.curve.slice(end - n, end), n);
  };

  const order = (list: { slug: string; ret: number | null }[]) =>
    [...list]
      .sort((a, b) => (b.ret ?? Number.NEGATIVE_INFINITY) - (a.ret ?? Number.NEGATIVE_INFINITY))
      .map((r, i) => [r.slug, i + 1] as const);

  const nowScores = agents.map((a) => ({ slug: a.slug, ret: score(a, 0) }));
  const nowRank = new Map(order(nowScores));
  const thenRank = new Map(order(agents.map((a) => ({ slug: a.slug, ret: score(a, 1) }))));

  return agents
    .map((agent) => {
      const ret = nowScores.find((s) => s.slug === agent.slug)?.ret ?? null;
      const r = nowRank.get(agent.slug) ?? 0;
      return { agent, rank: r, ret, move: (thenRank.get(agent.slug) ?? r) - r };
    })
    .sort((a, b) => a.rank - b.rank);
}
