import { useMemo } from "react";
import { cadenceWords, nextRun, countdown, useNow } from "../clock";
import { bookLegs } from "../glance";
import { money, type LiveAgent, type LiveMine, type LiveToken, type Thesis } from "../live";
import { SAMPLE_RUNS } from "../sample";
import { strategyForSlug, strategyName, type StrategyId } from "../strategy";
import { Coin, Empty, Face, Flip } from "../ui";

export function You({
  onLimits,
  onStop,
  onDesk,
  onDeposit,
  stopped,
  perTrade,
  perDay,
  mine,
  agents,
  tokens,
  theses,
  run,
  onRun,
}: {
  onLimits: () => void;
  onStop: () => void;
  onDesk: () => void;
  onDeposit: () => void;
  stopped: boolean;
  perTrade: string;
  perDay: string;
  mine: LiveMine | null;
  agents: LiveAgent[];
  tokens: LiveToken[];
  theses: Thesis[];
  run: StrategyId;
  onRun: (id: StrategyId) => void;
}) {
  const now = useNow(1000);
  const crews = useMemo(() => crewsOf(agents), [agents]);
  const pace = useMemo(() => paceOf(theses, mine?.slug ?? null, now), [theses, mine, now]);

  if (!mine) {
    return <Empty title="Nothing running." action={{ label: "Fund an agent", onClick: onDeposit }} />;
  }

  const eq = mine.equity;
  const chg = mine.chg24;
  const [whole, frac] = money(eq).replace("$", "").split(".");
  const pct = eq && eq !== 0 && chg != null ? (chg / eq) * 100 : null;
  const spent = spentToday(mine, now);
  const cap = Math.max(1, Number(perDay) || 1);
  const legs = bookLegs(mine.glance);
  const total = legs.reduce((n, l) => n + (l.weight || 1), 0) || 1;
  const left = countdown(nextRun(run, now) - now);

  return (
    <div className="page you-page">
      <header className="you-head">
        <Face name={mine.name} slug={mine.slug} small />
        <strong>{mine.name}</strong>
        <button type="button" className={stopped ? "halt off" : "halt"} onClick={onStop}>
          {stopped ? "Resume" : "Stop"}
        </button>
      </header>

      <div className="wire-top">
        <div className="balance">
          ${whole}
          {frac !== undefined && <sup>.{frac}</sup>}
        </div>
        <p className="hero-lede">
          {chg != null && (
            <span className={chg < 0 ? "down" : "up"}>
              {chg < 0 ? "\u2212" : "+"}${Math.abs(chg).toFixed(2)}
              {pct != null ? ` (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)` : ""} today
            </span>
          )}{" "}
          across {legs.length} names {mine.name} bought for you, {cadenceWords(run)}.
        </p>
        {pace.others > 0 && (
          <p className="pace">
            {mine.name} traded {pace.yours} {pace.yours === 1 ? "time" : "times"} today. The other {pace.agents}{" "}
            agents traded {pace.others}.
          </p>
        )}
      </div>

      <section className="strip">
        <div className="cap-bar">
          <i style={{ width: `${Math.min(100, (spent / cap) * 100)}%` }} />
        </div>
        <div className="cap-grid">
          <button type="button" className="cap" onClick={onLimits}>
            <b>${perTrade}</b>
            <span>most per trade</span>
          </button>
          <button type="button" className="cap" onClick={onLimits}>
            <b>{money(spent)}</b>
            <span>of ${perDay} spent today</span>
          </button>
          <button type="button" className="cap" onClick={onDesk}>
            <b className="mono-fig">{stopped ? "—" : <Flip text={left.text} dir="down" />}</b>
            <span>{stopped ? "stopped by you" : "until it trades again"}</span>
          </button>
        </div>
      </section>

      <section className="strip">
        <div className="book">
          {legs.map((l) => {
            const tok = tokens.find((t) => t.symbol.toUpperCase() === l.symbol.toUpperCase());
            return (
              <div key={l.symbol} className="book-coin">
                <Coin symbol={l.symbol} logo={tok?.logo ?? ""} />
                <span>{l.symbol}</span>
                <em>{Math.round(((l.weight || 1) / total) * 100)}%</em>
              </div>
            );
          })}
        </div>
      </section>

      <section className="strip">
        <div className="crews">
          {SAMPLE_RUNS.map((id) => {
            const crew = crews.get(id) ?? [];
            const best = crew.find((a) => a.pnlBps != null);
            const on = run === id;
            return (
              <div key={id} className={on ? "crew-row on" : "crew-row"}>
                <strong className="crew-who">{strategyName(id)}</strong>
                <div className="crew-cast">
                  <span className="faces">
                    {crew.slice(0, 3).map((a) => (
                      <Face key={a.slug} name={a.name} slug={a.slug} small />
                    ))}
                  </span>
                  <em>
                    {best ? (
                      <>
                        <b>{best.handle ?? best.name}</b> is {best.pnlBps! < 0 ? "down" : "up"}{" "}
                        <b className={best.pnlBps! < 0 ? "down" : "up"}>
                          {(Math.abs(best.pnlBps!) / 100).toFixed(1)}%
                        </b>{" "}
                        running it
                      </>
                    ) : (
                      `${crew.length} ${crew.length === 1 ? "agent runs it" : "agents run it"}`
                    )}
                  </em>
                </div>
                {on ? (
                  <span className="crew-on">
                    <i className="live" aria-hidden />
                    running
                  </span>
                ) : (
                  <button type="button" className="crew-run" onClick={() => onRun(id)}>
                    Run this
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function crewsOf(agents: LiveAgent[]): Map<StrategyId, LiveAgent[]> {
  const by = new Map<StrategyId, LiveAgent[]>();
  for (const a of agents) {
    const id = strategyForSlug(a.slug, a.glance.id);
    const list = by.get(id) ?? [];
    list.push(a);
    by.set(id, list);
  }
  for (const list of by.values()) list.sort((a, b) => (b.pnlBps ?? 0) - (a.pnlBps ?? 0));
  return by;
}

function paceOf(theses: Thesis[], slug: string | null, now: number) {
  let yours = 0;
  let others = 0;
  const cast = new Set<string>();
  for (const t of theses) {
    if (t.action !== "buy" && t.action !== "sell") continue;
    if (t.at == null || now - t.at > 24 * 3_600_000) continue;
    if (t.slug && t.slug === slug) {
      yours += 1;
      continue;
    }
    others += 1;
    if (t.slug) cast.add(t.slug);
  }
  return { yours, others, agents: cast.size };
}

function spentToday(mine: LiveMine, now: number): number {
  return mine.moves.reduce((n, t) => {
    if (t.action !== "buy" && t.action !== "sell") return n;
    if (t.at == null || now - t.at > 24 * 3_600_000) return n;
    return n + (t.sizeUsdg ?? 0);
  }, 0);
}
