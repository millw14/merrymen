"use client";

import { useEffect, useState } from "react";
import type { AgentStatus } from "@/app/api/grants/route";
import type { FeedResponse } from "@/app/api/feed/route";

export function FeedPanel() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [feed, setFeed] = useState<FeedResponse | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [gRes, fRes] = await Promise.all([fetch("/api/grants"), fetch("/api/feed")]);
        if (!alive) return;
        if (gRes.ok) setStatus((await gRes.json()) as AgentStatus);
        if (fRes.ok) setFeed((await fRes.json()) as FeedResponse);
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

  const hasGrant = status?.exists && status.grant;
  const name = feed?.agent?.name ?? "Robin";

  // Real history from the worker (recorded events), newest first.
  if (hasGrant && feed && feed.events.length > 0) {
    return (
      <div className="feed">
        {feed.events.map((e, i) => (
          <div key={i} className="feed-line">
            <span className="feed-time">
              {new Date(e.created_at).toLocaleTimeString([], { hour12: false })}
            </span>
            <span>
              <b>{name}</b> <span className={e.level}>{e.message}</span>
            </span>
          </div>
        ))}
      </div>
    );
  }

  // Grant exists but the worker hasn't recorded anything yet.
  if (hasGrant && status.grant) {
    const g = status.grant;
    const now = Math.floor(Date.now() / 1000);
    const workerAlive = status.workerAliveAt != null && now - status.workerAliveAt < 90;
    return (
      <div className="feed">
        <div className="feed-line">
          <span className="feed-time">
            {new Date(g.grantedAt * 1000).toLocaleTimeString([], { hour12: false })}
          </span>
          <span>
            <b>{name}</b>{" "}
            <span className="ok">
              permission wall raised — ≤{g.caps.perTradeUsdg} USDG/trade, ≤{g.caps.dailyUsdg}/day
            </span>
          </span>
        </div>
        <div className="feed-line">
          <span className="feed-time">now</span>
          <span>
            <b>worker</b>{" "}
            <span className={workerAlive ? "ok" : "warn"}>
              {workerAlive ? "ticking — awaiting first recorded event" : "not running — no heartbeat in 90s"}
            </span>
          </span>
        </div>
      </div>
    );
  }

  // No grant yet — nothing to narrate. Honest emptiness, not demo theater.
  return (
    <div className="feed">
      <div className="feed-line">
        <span className="feed-time">—</span>
        <span className="dim">
          the campfire is quiet — create your agent wallet and every event lands here, unedited
        </span>
      </div>
    </div>
  );
}
