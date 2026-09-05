import { money } from "./live";
import type { BasketLeg } from "./strategy";

export function BalanceFigure({ value }: { value: number | null }) {
  const [whole, decimals] = money(value).split(".");
  return (
    <span className="balance-figure">
      {whole}
      {decimals && <span className="figure-decimals">.{decimals}</span>}
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
