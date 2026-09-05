import type { StrategyGlance } from "./strategy";

export function Glance({ glance }: { glance: StrategyGlance }) {
  return <div className="inst desk">{body(glance)}</div>;
}

export function bookLegs(glance: StrategyGlance): { symbol: string; weight: number }[] {
  return (
    glance.legs ??
    glance.open?.map((s) => ({ symbol: s.symbol, weight: 1 })) ??
    glance.parked?.map((s) => ({ symbol: s, weight: 1 })) ??
    (glance.deepest ? [{ symbol: glance.deepest.symbol, weight: 1 }] : [])
  );
}

/** The lightest seat is where a topping-up book puts its next dollar. */
export function nextLeg(glance: StrategyGlance): string | null {
  const legs = bookLegs(glance);
  if (legs.length < 2) return null;
  return legs.reduce((low, l) => ((l.weight || 1) < (low.weight || 1) ? l : low)).symbol;
}

/** One bar. Labels sit under their own segments. */
export function BookBar({ glance, target }: { glance: StrategyGlance; target?: string | null }) {
  const legs = bookLegs(glance);
  if (legs.length === 0) return null;
  const total = legs.reduce((n, l) => n + (l.weight || 1), 0) || 1;
  const hit = (symbol: string) => target != null && symbol.toUpperCase() === target.toUpperCase();
  return (
    <div className="bookbar">
      <div className="bookbar-track">
        {legs.map((l, i) => (
          <i
            key={l.symbol}
            className={hit(l.symbol) ? `seg-${i % 5} next` : `seg-${i % 5}`}
            style={{ width: `${((l.weight || 1) / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="bookbar-labs">
        {legs.map((l) => (
          <span
            key={l.symbol}
            className={hit(l.symbol) ? "next" : undefined}
            style={{ width: `${((l.weight || 1) / total) * 100}%` }}
          >
            {l.symbol}
          </span>
        ))}
      </div>
      {glance.cashUsd != null ? <p className="bookbar-cash">${glance.cashUsd} cash</p> : null}
    </div>
  );
}

function body(g: StrategyGlance) {
  switch (g.id) {
    case "steady-basket":
      return (
        <>
          <Legs legs={g.legs ?? []} />
          <p className="inst-note">
            {[
              g.nextBuyUsd != null ? `Next $${g.nextBuyUsd}` : "",
              g.vaultUsd != null ? `$${g.vaultUsd} parked` : "",
              g.cashUsd != null ? `$${g.cashUsd} cash` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </>
      );
    case "even-keel":
      return <Legs legs={g.legs ?? []} keel />;
    case "weekend-gap":
      return (
        <div className="gate">
          <i className={g.market === "open" ? "live" : "rest"} />
          <strong>{(g.parked ?? []).join("  ") || (g.market === "open" ? "Open" : "Closed")}</strong>
        </div>
      );
    case "dip-hunter":
      return g.deepest ? (
        <p className="deep">
          <b>{g.deepest.symbol}</b>
          <span>{g.deepest.offHigh}% off</span>
        </p>
      ) : null;
    case "trencher":
      return (
        <>
          <div className="seats">
            {(g.open ?? []).map((s) => (
              <div key={s.symbol} className="seat">
                <b>{s.symbol}</b>
                <em className={s.pnlPct >= 0 ? "up" : "down"}>
                  {s.pnlPct >= 0 ? "+" : ""}
                  {s.pnlPct}%
                </em>
                {s.stopIn != null && <span>{s.stopIn}%</span>}
              </div>
            ))}
          </div>
          <p className="inst-note">
            {[
              g.watchingN != null ? `${g.watchingN} watching` : "",
              g.scoutLeftUsd != null ? `$${g.scoutLeftUsd} left` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </>
      );
    case "llm-strategist":
      return g.nextLook ? <p className="inst-note">{g.nextLook}</p> : null;
    case "custom":
      return g.legs && g.legs.length > 0 ? <Legs legs={g.legs} /> : null;
    default: {
      const _x: never = g.id;
      return _x;
    }
  }
}

function Legs({ legs, keel }: { legs: { symbol: string; weight: number; drift?: number }[]; keel?: boolean }) {
  if (legs.length === 0) return null;
  return (
    <div className="legs">
      {legs.map((l) => {
        const fill = keel ? Math.min(100, Math.max(8, 50 + (l.drift ?? 0))) : l.weight;
        return (
          <div key={l.symbol} className="leg">
            <span>{l.symbol}</span>
            <i>
              <b style={{ width: `${fill}%` }} />
            </i>
            <em>{Math.round(l.weight)}</em>
          </div>
        );
      })}
    </div>
  );
}
