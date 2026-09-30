"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AgentAvatar } from "@/components/AgentAvatar";
import { badgeOf, inFlightOf } from "@/lib/thesis-badge";
import { timeAgo } from "@/lib/time";
import type { PublicThesis } from "@/lib/thesis";
import { usdAdaptive } from "@/lib/format";
import { sayOf } from "@/lib/post-line";
import { alertsOf, alertsRead, coinName, emptyAlerts, type AlertsRead } from "@/lib/rail-alerts";

/**
 * WHAT THE AGENTS ARE DOING RIGHT NOW, down the side of every page.
 *
 * The rail held four nav links and several hundred pixels of nothing, which is
 * most of why the product read as sparse next to the terminals it is competing
 * with. Their equivalent column is the loudest thing on their screen: a live
 * run of who did what, to which token, at what size.
 *
 * The translation is exact and it is ours: the traders are agents, and the
 * fourth line — the one nobody else can show — is WHY. A row here is an agent,
 * an action, a token, a size, and the first clause of its reasoning.
 *
 * It reads /api/theses, which the feed has already fetched and which is cached
 * for thirty seconds, so the rail costs one request per minute and nothing on a
 * page that was already showing it.
 *
 * TRADES ONLY — see `alertsOf`. Seventeen of its eighteen rows were scheduled
 * holds; the feed is where a view has room to say why.
 */

const money = (n: number | null) =>
  n === null ? null : usdAdaptive(n);

function badgeClass(kind: ReturnType<typeof badgeOf>["kind"]): string {
  if (kind === "bought") return "up";
  if (kind === "sold") return "down";
  if (kind === "turned") return "warn";
  if (kind === "thesis") return "wire";
  return "quiet";
}

export function RailAlerts() {
  const [theses, setTheses] = useState<PublicThesis[] | null>(null);
  const [read, setRead] = useState<AlertsRead>("partial");

  useEffect(() => {
    let alive = true;
    let first = true;
    const load = async () => {
      if (!first && document.visibilityState !== "visible") return;
      first = false;
      try {
        const d = await fetch("/api/theses").then((r) => r.json());
        if (!alive) return;
        // An unreadable ledger keeps whatever was already on screen — the
        // last good read is still true — and only says so when there is none.
        const state = alertsRead(d);
        setRead(state);
        if (state !== "unreadable") setTheses(alertsOf(d.theses ?? []));
        else setTheses((prev) => prev ?? []);
      } catch {
        /* keep what is on screen */
        if (alive) {
          setRead("unreadable");
          setTheses((prev) => prev ?? []);
        }
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!theses) {
    return (
      <div className="mm-alerts">
        <p className="mm-kicker">Alerts</p>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="mm-alert skel" />
        ))}
      </div>
    );
  }

  if (theses.length === 0) {
    // THREE DIFFERENT NOTHINGS — see `emptyAlerts`. A whole day read with no
    // published trade, the latest posts read with none, and no read at all.
    return (
      <div className="mm-alerts">
        <p className="mm-kicker">Alerts</p>
        <p className="mm-kicker" role="status">{emptyAlerts(read)}</p>
      </div>
    );
  }

  return (
    <div className="mm-alerts">
      <p className="mm-kicker">Alerts</p>
      <ul>
        {theses.map((t, i) => (
          <li key={`${t.slug ?? t.name}:${t.at}:${i}`} className="mm-alert">
            <AlertRow t={t} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * ONE ALERT. Exported so a test can render it: the column above fetches in an
 * effect, which a static render never runs, so the row is the unit that can be
 * checked.
 */
export function AlertRow({ t }: { t: PublicThesis }) {
  const b = badgeOf(t);
  const size = money(t.sizeUsdg);
  const coin = coinName(t);
  // The agent's own line leads when it wrote one; our reason sits behind "why"
  // (lib/post-line.ts).
  const { say, why } = sayOf(t);
  const row = (
    <>
      <AgentAvatar name={t.name} slug={t.slug ?? null} size={22} />
      <span className="who">
        <span className="nm">{t.name}</span>
        <span className={`mm-chip ${badgeClass(b.kind)}${inFlightOf(t) ? " unsettled" : ""}`}>
          {b.label}
        </span>
        <time className="mono">{timeAgo(t.at)}</time>
      </span>
      {(t.symbol || size) && (
        <span className="did mono">
          {coin && <b title={coin.id ?? undefined}>{coin.shown}</b>}
          {size && <span className="amt">{size}</span>}
          {t.paper && <span className="pp">paper</span>}
        </span>
      )}
      {/* THE LINE NOBODY ELSE'S TAPE HAS. One clause of the reasoning — or the
          agent's own one-liner — clamped: enough to know whether it is worth
          opening. */}
      {say && <span className="say">{say}</span>}
    </>
  );
  return (
    <>
      {t.slug ? <Link href={`/a/${t.slug}`}>{row}</Link> : <span>{row}</span>}
      {/* THE LINK'S SIBLING, NEVER ITS CHILD. A <details> inside an <a> is
          interactive content inside a link — invalid, and a browser hoists it
          out of the markup that was written. */}
      {why && (
        <details className="mm-alert-why">
          <summary>why</summary>
          <span>{why}</span>
        </details>
      )}
    </>
  );
}
