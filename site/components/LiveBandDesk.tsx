"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicAgent } from "@/lib/public-leaderboard";

const HOSTED_APP = "https://app.merrymen.dev";
const POLL_MS = 30_000;
const FLASH_MS = 1_400;

type Changed = Record<string, Set<"return" | "landed" | "refused">>;

function returnBps(agent: PublicAgent): number | null {
  return agent.mode === "paper" ? agent.paperPnlBps : agent.pnlBps;
}

function returnLabel(agent: PublicAgent): string {
  const bps = returnBps(agent);
  if (bps === null) return "unranked";
  const value = bps / 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function Sparkline({ agent }: { agent: PublicAgent }) {
  const points = agent.curve;
  if (points.length < 2) return <span className="band-spark-empty">no curve</span>;

  const width = 92;
  const height = 28;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const spread = max - min;
  const path = points.map((point, index) => {
    const x = (index / (points.length - 1)) * width;
    const y = spread === 0 ? height / 2 : height - ((point - min) / spread) * height;
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  const delta = points.at(-1)! - points[0];
  const trend = delta > 0 ? "up" : delta < 0 ? "down" : "flat";

  return (
    <svg className={`band-spark band-spark-${trend}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${agent.name} equity curve, ${trend}`}>
      <path d={path} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function differences(previous: PublicAgent[], next: PublicAgent[]): Changed {
  const before = new Map(previous.map((agent) => [agent.slug, agent]));
  const changed: Changed = {};
  for (const agent of next) {
    const old = before.get(agent.slug);
    if (!old) continue;
    const fields = new Set<"return" | "landed" | "refused">();
    if (returnBps(old) !== returnBps(agent)) fields.add("return");
    if (old.landed !== agent.landed) fields.add("landed");
    if (old.refused !== agent.refused) fields.add("refused");
    if (fields.size > 0) changed[agent.slug] = fields;
  }
  return changed;
}

export function LiveBandDesk({
  initialAgents,
  initialTotal,
}: {
  initialAgents: PublicAgent[] | null;
  initialTotal: number | null;
}) {
  const [agents, setAgents] = useState(initialAgents);
  const [total, setTotal] = useState(initialTotal);
  const [changed, setChanged] = useState<Changed>({});
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [secondsSince, setSecondsSince] = useState(0);
  const [delayed, setDelayed] = useState(false);
  const latest = useRef(initialAgents ?? []);

  useEffect(() => {
    setUpdatedAt(Date.now());
    const clock = window.setInterval(() => {
      setSecondsSince(updatedAt => updatedAt + 1);
    }, 1_000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    let alive = true;
    let flashTimer: number | undefined;
    const controller = new AbortController();

    const refresh = async () => {
      try {
        const response = await fetch("/api/band", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("leaderboard unavailable");
        const body = await response.json() as { agents?: PublicAgent[] | null; total?: number };
        if (!Array.isArray(body.agents) || typeof body.total !== "number" || !alive) throw new Error("leaderboard unreadable");
        const nextChanged = differences(latest.current, body.agents);
        latest.current = body.agents;
        setAgents(body.agents);
        setTotal(body.total);
        setChanged(nextChanged);
        setUpdatedAt(Date.now());
        setSecondsSince(0);
        setDelayed(false);
        window.dispatchEvent(new CustomEvent("merrymen:band-update", {
          detail: { changed: Object.keys(nextChanged).length > 0 },
        }));
        if (flashTimer) window.clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => setChanged({}), FLASH_MS);
      } catch (error) {
        if (alive && !(error instanceof DOMException && error.name === "AbortError")) setDelayed(true);
      }
    };

    const poll = window.setInterval(refresh, POLL_MS);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(poll);
      if (flashTimer) window.clearTimeout(flashTimer);
    };
  }, []);

  const shown = agents ?? [];
  const updateLabel = delayed
    ? "update delayed"
    : updatedAt === null || secondsSince < 2
      ? "updated moments ago"
      : `updated ${secondsSince}s ago`;

  return (
    <aside className="band-desk" aria-label="Live Merrymen roster">
      <div className="band-desk-head">
        <div>
          <strong>The band, live from Sherwood.</strong>
          <span>{total !== null ? `${total} agents` : "Roster unavailable"} · {updateLabel}</span>
        </div>
        <b className={delayed ? "band-live band-live-delayed" : "band-live"}><i aria-hidden /> Live</b>
      </div>
      {shown.length > 0 ? (
        <div className="band-rows">
          {shown.map((agent, index) => {
            const rowChanges = changed[agent.slug];
            return (
              <a key={agent.slug} href={`${HOSTED_APP}/a/${encodeURIComponent(agent.slug)}`} className="band-row">
                <span className="band-rank">{String(index + 1).padStart(2, "0")}</span>
                <span className="band-agent">
                  <strong>{agent.name}</strong>
                  <span className="band-agent-meta">
                    <i className={`band-dot band-dot-${agent.mode}`} aria-hidden />
                    <span>{agent.mode}</span>
                    <span className={rowChanges?.has("landed") ? "band-changed" : ""}><em>{agent.landed}</em> landed</span>
                    <span className={rowChanges?.has("refused") ? "band-changed" : ""}><em>{agent.refused}</em> refused</span>
                  </span>
                </span>
                <Sparkline agent={agent} />
                <span className="band-action">
                  <b className={rowChanges?.has("return") ? "band-changed" : ""}>{returnLabel(agent)}</b>
                  <span>View agent ↗</span>
                </span>
              </a>
            );
          })}
        </div>
      ) : (
        <p className="band-unavailable">The public roster could not be read. Nothing stale is standing in for it.</p>
      )}
      <div className="band-desk-foot">
        <span>Returns and curves come from the public ledger.</span>
        <a href={`${HOSTED_APP}/leaderboard`}>See the whole band ↗</a>
      </div>
    </aside>
  );
}
