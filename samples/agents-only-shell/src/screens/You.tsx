import { PerformanceChart } from "../DitherChart";
import { dailyChange, spentToday } from "../account";
import { money, pctPts, type LiveMine } from "../live";
import { strategyName } from "../strategy";
import { Empty, Face } from "../ui";
import { BalanceFigure } from "../studio";

export function You({
  onLimits,
  onStop,
  onDesk,
  onDeposit,
  stopped,
  perTrade,
  perDay,
  mine,
  history,
}: {
  onLimits: () => void;
  onStop: () => void;
  onDesk: () => void;
  onDeposit: () => void;
  stopped: boolean;
  perTrade: string;
  perDay: string;
  mine: LiveMine | null;
  history: number[];
}) {
  if (!mine)
    return (
      <Empty
        title="Your agents belong here."
        action={{ label: "Fund an agent", onClick: onDeposit }}
      />
    );
  const owner = mine.owner ?? "You";
  const ownerLabel =
    owner.startsWith("0x") && owner.length > 16
      ? `${owner.slice(0, 6)}…${owner.slice(-4)}`
      : owner;
  const spent = spentToday(mine, Date.now());
  const change = dailyChange(mine);
  return (
    <div className="account-page">
      <header className="account-header">
        <h1>Your profile</h1>
      </header>
      <div className="account-person">
        <span className="account-avatar" aria-hidden>
          {owner.startsWith("0x") ? "◎" : owner.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <h2>{ownerLabel}</h2>
          <p>1 agent · {stopped ? "Paused" : "Running"}</p>
        </div>
      </div>
      <section className="account-balance" aria-label="Account balance">
        <span className="account-label">Your balance</span>
        <strong>
          <BalanceFigure value={mine.equity} />
        </strong>
        <p className={(mine.chg24 ?? 0) < 0 ? "down" : "up"}>
          {mine.chg24 == null
            ? "Daily change unavailable"
            : `${mine.chg24 < 0 ? "−" : "+"}${money(Math.abs(mine.chg24))}${change == null ? "" : ` (${pctPts(change)})`} today`}
        </p>
        <PerformanceChart values={history} height={68} />
        <button type="button" className="account-fund" onClick={onDeposit}>
          Add funds <span aria-hidden>↗</span>
        </button>
      </section>
      <section className="account-section account-agent-section">
        <div className="account-section-title">
          <h2>Your agent</h2>
          <span>1</span>
        </div>
        <button type="button" className="account-agent" onClick={onDesk}>
          <Face name={mine.name} slug={mine.slug} />
          <span>
            <strong>{mine.name}</strong>
            <small>{strategyName(mine.glance.id)}</small>
          </span>
          <span className="account-agent-value">
            <strong>{money(mine.equity)}</strong>
            <small>{stopped ? "Paused" : "Running"} ↗</small>
          </span>
        </button>
        <p className="account-agent-note">
          {stopped
            ? "Trading is paused. Your positions remain open."
            : "View positions, recent trades, and chat with your agent."}
        </p>
      </section>
      <section className="account-section">
        <div className="account-section-title">
          <h2>Trading controls</h2>
        </div>
        <button type="button" className="account-control" onClick={onLimits}>
          <span>
            <strong>Trading limits</strong>
            <small>
              {money(Number(perTrade))} per trade · {money(Number(perDay))} per
              day
            </small>
          </span>
          <span aria-hidden>↗</span>
        </button>
        <div className="account-usage">
          <div>
            <span>Used today</span>
            <span>
              {money(spent)} / {money(Number(perDay))}
            </span>
          </div>
          <progress
            aria-label="Daily trading limit used"
            max={Math.max(1, Number(perDay) || 1)}
            value={Math.min(spent, Math.max(1, Number(perDay) || 1))}
          />
        </div>
        <div className="account-control">
          <span>
            <strong>{stopped ? "Resume trading" : "Pause trading"}</strong>
            <small>
              {stopped
                ? "Allow your agent to trade again"
                : "Keep positions, pause new trades"}
            </small>
          </span>
          <button
            type="button"
            className={`account-pause ${stopped ? "is-paused" : ""}`}
            onClick={onStop}
          >
            {stopped ? "Resume" : "Pause"}
          </button>
        </div>
      </section>
    </div>
  );
}
