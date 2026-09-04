import { BookBar, bookLegs } from "../glance";
import { money, type LiveMine } from "../live";
import { SAMPLE_RUNS } from "../sample";
import { strategyName, type StrategyId } from "../strategy";
import { Face, Stamp } from "../ui";

export function You({
  onLimits,
  onStop,
  onDesk,
  stopped,
  perTrade,
  perDay,
  mine,
  run,
  onRun,
}: {
  onLimits: () => void;
  onStop: () => void;
  onDesk: () => void;
  stopped: boolean;
  perTrade: string;
  perDay: string;
  mine: LiveMine | null;
  run: StrategyId;
  onRun: (id: StrategyId) => void;
}) {
  const eq = mine?.equity ?? null;
  const chg = mine?.chg24 ?? null;
  const [whole, frac] = money(eq).replace("$", "").split(".");
  const stamp = strategyName(run);
  const pct = eq && eq !== 0 && chg != null ? (chg / eq) * 100 : null;
  const used = spentToday(mine);
  const legs = mine ? bookLegs(mine.glance) : [];
  const bookTotal = legs.reduce((n, l) => n + (l.weight || 1), 0) || 1;

  return (
    <div className="you">
      <header>
        {eq != null && (
          <div className="balance">
            ${whole}
            {frac !== undefined && <sup>.{frac}</sup>}
          </div>
        )}
        {chg != null && (
          <p className={`chg-24 ${chg < 0 ? "down" : "up"}`}>
            {chg < 0 ? "−" : "+"}${Math.abs(chg).toFixed(2)}
            {pct != null ? ` (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)` : ""} today
          </p>
        )}
      </header>

      {mine && (
        <section className="ledger">
          <button type="button" className="crew" onClick={onDesk}>
            <div className="ledger-head">
              <div className="visit-who">
                <Face name={mine.name} slug={mine.slug} />
                <div>
                  <div className="held-id">
                    <strong>{mine.name}</strong>
                    <Stamp>{stamp}</Stamp>
                    {!stopped && <i className="live" aria-hidden />}
                  </div>
                </div>
              </div>
              <div className="ledger-nums">
                <b>{money(eq)}</b>
                {chg != null && (
                  <span className={chg < 0 ? "down" : "up"}>
                    {chg < 0 ? "−" : "+"}${Math.abs(chg).toFixed(2)}
                  </span>
                )}
              </div>
            </div>
            <BookBar glance={mine.glance} />
            {legs.length > 0 && (
              <div className="you-legs">
                {legs.map((l) => (
                  <div key={l.symbol} className="you-leg">
                    <span>{l.symbol}</span>
                    <em>{Math.round(((l.weight || 1) / bookTotal) * 100)}%</em>
                  </div>
                ))}
              </div>
            )}
          </button>

          <div className="pills quiet">
            {SAMPLE_RUNS.map((id) => (
              <button key={id} type="button" className={run === id ? "tag on" : "tag"} onClick={() => onRun(id)}>
                {strategyName(id)}
              </button>
            ))}
          </div>

          <div className="ledger-foot">
            <button type="button" className="cap" onClick={onLimits}>
              <b>${perTrade}</b>
              <span>a trade</span>
            </button>
            <button type="button" className="cap" onClick={onLimits}>
              <b>${used.toFixed(0)}</b>
              <span>of ${perDay} today</span>
            </button>
            <button type="button" className="halt" onClick={onStop}>
              {stopped ? "Resume" : "Stop"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function spentToday(mine: LiveMine | null): number {
  if (!mine) return 0;
  return mine.moves.reduce((n, t) => {
    if (t.action !== "buy" && t.action !== "sell") return n;
    if (t.when && /[wd]|mo/i.test(t.when)) return n;
    const fresh = t.said != null && t.said < 86_400;
    const recent = Boolean(t.when && /^\d+[smh]$/i.test(t.when));
    if (!fresh && !recent) return n;
    return n + (t.sizeUsdg ?? 0);
  }, 0);
}
