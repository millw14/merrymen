import { PerformanceChart } from "../DitherChart";
import { dailyChange, spentToday } from "../account";
import { money, pctPts, type LiveMine } from "../live";
import { strategyName } from "../strategy";
import { Empty, Face } from "../ui";
import { BalanceFigure } from "../studio";
import Link from "next/link";
import { SlidersHorizontal, Wallet, Settings, ChevronRight } from "lucide-react";

export function You({
  onLimits,
  onStop,
  onDesk,
  onDeposit,
  onWithdraw,
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
  onWithdraw: () => void;
  stopped: boolean;
  perTrade: string;
  perDay: string;
  mine: LiveMine | null;
  history: number[];
}) {
  if (!mine)
    return (
      <Empty
        kind="profile"
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
        <h1>Profile</h1>
      </header>
      <div className="account-person">
        <span className="account-avatar" aria-hidden>
          {owner.startsWith("0x") ? "◎" : owner.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <h2>{ownerLabel}</h2>
          <p>1 agent</p>
        </div>
        <span className="profile-mode">{mine.statusLabel ?? "Offline"}</span>
      </div>
      <section className="account-balance" aria-label="Account balance">
        <span className="account-label">Portfolio balance</span>
        <strong>
          <BalanceFigure value={mine.equity} />
        </strong>
        <p className={mine.chg24 == null ? "meta" : mine.chg24 < 0 ? "down" : "up"}>
          {mine.chg24 == null
            ? "Daily change unavailable"
            : `${mine.chg24 < 0 ? "−" : "+"}${money(Math.abs(mine.chg24))}${change == null ? "" : ` (${pctPts(change)})`} today`}
        </p>
        <PerformanceChart balance values={history} height={68} restate={false} />
        <div className="profile-funding">
        <button type="button" className="account-fund" onClick={onDeposit}>
          Add funds
        </button>
        <button type="button" className="account-fund" onClick={onWithdraw}>
          Withdraw
        </button>
        </div>
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
            <small>{mine.statusLabel ?? "Offline"} ↗</small>
          </span>
        </button>
      </section>
      <section className="account-section profile-account">
        <div className="account-section-title">
          <h2>Account</h2>
        </div>
        <button type="button" className="account-control" onClick={onLimits}>
          <SlidersHorizontal size={24} aria-hidden="true"/>
          <span>
            <strong>Trading limits</strong>
            <small>
              {money(Number(perTrade))} per trade · {money(Number(perDay))} per
              day
            </small>
          </span>
          <ChevronRight size={18} aria-hidden="true"/>
        </button>
        <button type="button" className="account-control" onClick={onStop}><Wallet size={24} aria-hidden="true"/><span><strong>Wallet & permissions</strong></span><ChevronRight size={18} aria-hidden="true"/></button>
        <Link className="account-control" href="/settings"><Settings size={24} aria-hidden="true"/><span><strong>Settings</strong></span><ChevronRight size={18} aria-hidden="true"/></Link>
        <section className="profile-usage" aria-label="Daily limit usage">
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
        </section>
      </section>
    </div>
  );
}
