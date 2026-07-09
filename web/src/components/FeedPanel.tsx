"use client";

import { useEffect, useState } from "react";
import type { AgentStatus } from "@/app/api/grants/route";
import { FEED } from "@/lib/mock";

interface Line {
  time: string;
  agent: string;
  kind: "ok" | "warn" | "err";
  text: string;
}

export function FeedPanel() {
  const [status, setStatus] = useState<AgentStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/grants");
        if (res.ok && alive) setStatus((await res.json()) as AgentStatus);
      } catch {
        /* keep last state */
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (status?.exists && status.grant) {
    const g = status.grant;
    const now = Math.floor(Date.now() / 1000);
    const workerAlive = status.workerAliveAt != null && now - status.workerAliveAt < 90;
    const lines: Line[] = [
      {
        time: new Date(g.grantedAt * 1000).toLocaleTimeString(),
        agent: "Robin",
        kind: "ok",
        text: `permission wall raised — ≤${g.caps.perTradeUsdg} USDG/trade, ≤${g.caps.dailyUsdg}/day, dies ${new Date(g.expiresAt * 1000).toLocaleDateString()}`,
      },
      workerAlive
        ? { time: "now", agent: "worker", kind: "ok", text: "ticking — policy + safety checks live" }
        : { time: "now", agent: "worker", kind: "warn", text: "not running — no heartbeat in 90s" },
    ];
    return (
      <div className="feed">
        {lines.map((l, i) => (
          <div key={i} className="feed-line">
            <span className="feed-time">{l.time}</span>
            <span>
              <b>{l.agent}</b> <span className={l.kind}>{l.text}</span>
            </span>
          </div>
        ))}
        <div className="feed-line">
          <span className="feed-time">—</span>
          <span className="dim">trade history lands with persistence (next up)</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="demo-banner mono" style={{ marginBottom: 8 }}>
        demo data
      </div>
      <div className="feed demo-cards">
        {FEED.map((l, i) => (
          <div key={i} className="feed-line">
            <span className="feed-time">{l.time}</span>
            <span>
              <b>{l.agent}</b> <span className={l.kind}>{l.text}</span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
