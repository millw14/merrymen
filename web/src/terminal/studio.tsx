import { money } from "./live";
import type { BasketLeg } from "./strategy";
import { MovingFigure } from "./ui";

/**
 * The balance, which flips when it changes between two readings — the one
 * number on the desk that should look alive when a fill lands. Never on the
 * first draw, and never into or out of "—": see motion.ts.
 */
export function BalanceFigure({ value }: { value: number | null }) {
  const text = money(value);
  const [whole, decimals] = text.split(".");
  return (
    <span className="balance-figure">
      <MovingFigure value={value} text={text}>
        {whole}
        {decimals && <span className="figure-decimals">.{decimals}</span>}
      </MovingFigure>
    </span>
  );
}

const COLORS = ["#d3e99b", "#92b49e", "#89a7b8", "#b8afd0", "#cfb691"];
export function Allocation({
  legs,
  compact = false,
}: {
  legs?: BasketLeg[];
  compact?: boolean;
}) {
  const valid =
    legs?.filter((l) => Number.isFinite(l.weight) && l.weight > 0) ?? [];
  if (!valid.length) return null;
  return (
    <div
      className={`studio-allocation ${compact ? "compact" : ""}`}
      aria-label="Portfolio allocation"
    >
      <div className="allocation-ribbon" aria-hidden>
        {valid.map((leg, i) => (
          <span
            key={leg.symbol}
            style={{ flex: leg.weight, background: COLORS[i % COLORS.length] }}
          />
        ))}
      </div>
      <div className="allocation-key">
        {valid.map((leg, i) => (
          <span key={leg.symbol}>
            <i style={{ background: COLORS[i % COLORS.length] }} />
            <span>{leg.symbol}</span>
            {!compact && <b>{leg.weight}%</b>}
          </span>
        ))}
      </div>
    </div>
  );
}
