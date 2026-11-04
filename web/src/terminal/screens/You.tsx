import { PerformanceChart } from "../DitherChart";
import { dailyChange, spentToday } from "../account";
import { money, pctPts, type LiveMine } from "../live";
import { strategyName } from "../strategy";
import { Empty } from "../ui";
import { BalanceFigure } from "../studio";
import Link from "../Link";
import { ChartNoAxesCombined, SlidersHorizontal, Wallet, Settings, ChevronRight, Plug, Shirt } from "lucide-react";
import { MerrymanPortrait } from "@/merryman/Merryman";
import { wordOf } from "@/merryman/mood";
import { useOutfit } from "@/merryman/wardrobe-store";
import { CONNECT_ASSISTANT_HREF, useConnectAssistantOffered } from "../assistant-connect";
import { RecoveryNotice } from "../RecoveryNotice";
import { pausedRecovery } from "../recovery-view";

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
  hasAgent = false,
  onCreate,
}: {
  onLimits: () => void;
  onStop: () => void;
  onDesk: () => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  stopped: boolean;
  /** Null until the signed caps are read — a dash, never "$0.00 per trade". */
  perTrade: number | null;
  perDay: number | null;
  mine: LiveMine | null;
  history: number[];
  /** Has the server said an agent exists? `mine` is null while it loads too. */
  hasAgent?: boolean;
  onCreate?: () => void;
}) {
  // Before the early return: a hook may not be skipped on some renders.
  const assistants = useConnectAssistantOffered();
  const { outfit } = useOutfit(mine?.slug ?? null, mine?.slug ?? mine?.name ?? "draft");
  // With no agent, the shell sends a "deposit" to /create (App openScreen),
  // so this button now leads somewhere instead of back to this same page.
  // An owner whose book has not loaded is not offered creation: the account
  // card above says what is loading or failed. Only with no agent at all does
  // this become the invitation — and it goes to /create, not to Add money.
  if (!mine)
    return hasAgent ? (
      <Empty kind="profile" title="Fetching your merryman…" />
    ) : (
      <Empty
        kind="profile"
        title="Your merryman lives here."
        action={{ label: "Create your merryman", onClick: onCreate ?? onDeposit }}
      />
    );
  const word = wordOf(mine.autonomy?.state, { recovery: pausedRecovery(mine.recovery) !== null, expired: mine.autonomy?.rule === "expired", needsOwner: mine.autonomy?.needsOwnerAction });
  const owner = mine.owner ?? "You";
  const ownerLabel =
    owner.startsWith("0x") && owner.length > 16
      ? `${owner.slice(0, 6)}…${owner.slice(-4)}`
      : owner;
  const spent = spentToday(mine, Date.now());
  const change = dailyChange(mine);
  const recovery = pausedRecovery(mine.recovery);
  return (
    <div className="account-page">
      <header className="account-header">
        <h1>Me</h1>
      </header>
      <div className="account-person">
        <span className="account-avatar" aria-hidden>
          {owner.startsWith("0x") ? "◎" : owner.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <h2>{ownerLabel}</h2>
          <p>1 agent</p>
        </div>
        <span className="profile-mode" title={recovery ? "RECOVERING" : mine.statusLabel ?? "Offline"}>{word}</span>
      </div>
      <RecoveryNotice recovery={recovery} funds={mine.recoveryFunds}/>
      <section className="account-balance" aria-label="Account balance">
        <span className={recovery ? "account-label recovery-balance-label" : "account-label"}>{recovery ? "Last recorded portfolio balance" : "Portfolio balance"}</span>
        <strong>
          <BalanceFigure value={mine.equity} />
        </strong>
        <p className={recovery || mine.chg24 == null ? "meta" : mine.chg24 < 0 ? "down" : "up"}>
          {recovery ? "Reconciliation pending" : mine.chg24 == null
            ? "Daily change unavailable"
            : `${mine.chg24 < 0 ? "−" : "+"}${money(Math.abs(mine.chg24))}${change == null ? "" : ` (${pctPts(change)})`} today`}
        </p>
        <PerformanceChart balance values={history} height={68} restate={false} />
        <div className="profile-funding">
        <button type="button" className="account-fund" onClick={onDeposit}>
          Add money
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
          <MerrymanPortrait outfit={outfit} size={44} title={mine.name} />
          <span>
            <strong>{mine.name}</strong>
            <small>{strategyName(mine.glance.id)}</small>
          </span>
          <span className="account-agent-value">
            <strong>{money(mine.equity)}</strong>
            <small>{word} ↗</small>
          </span>
        </button>
      </section>
      <section className="account-section profile-account">
        <div className="account-section-title">
          <h2>Account</h2>
        </div>
        <Link className="account-control" href="/wardrobe">
          <Shirt size={24} aria-hidden="true"/>
          <span><strong>Dress your merryman</strong><small>Hats, outfits, pets and 40+ moves</small></span>
          <ChevronRight size={18} aria-hidden="true"/>
        </Link>
        <Link className="account-control owner-trades-link" href="/agent#trades">
          <ChartNoAxesCombined size={24} aria-hidden="true"/>
          <span><strong>Trades &amp; P&amp;L</strong><small>View results and P&amp;L cards</small></span>
          <ChevronRight size={18} aria-hidden="true"/>
        </Link>
        <button type="button" className="account-control" onClick={onLimits}>
          <SlidersHorizontal size={24} aria-hidden="true"/>
          <span>
            <strong>Trading limits</strong>
            <small>
              {money(perTrade)} per trade · {money(perDay)} per
              day
            </small>
          </span>
          <ChevronRight size={18} aria-hidden="true"/>
        </button>
        <button type="button" className="account-control" onClick={onStop}><Wallet size={24} aria-hidden="true"/><span><strong>Wallet & permissions</strong></span><ChevronRight size={18} aria-hidden="true"/></button>
        <Link className="account-control" href="/settings"><Settings size={24} aria-hidden="true"/><span><strong>Settings</strong></span><ChevronRight size={18} aria-hidden="true"/></Link>
        {/* Hosted only: a self-hosted install has no assistant connections (assistant-connect.ts). */}
        {assistants && <Link className="account-control" href={CONNECT_ASSISTANT_HREF}><Plug size={24} aria-hidden="true"/><span><strong>Connect to Claude</strong><small>Ask Claude about your agent</small></span><ChevronRight size={18} aria-hidden="true"/></Link>}
        <section className="profile-usage" aria-label="Daily limit usage">
        {recovery ? <div className="account-usage"><span>Daily usage</span><span>Reconciliation pending</span></div> : <>
        <div className="account-usage">
          <div>
            <span>Used today</span>
            <span>
              {money(spent)} / {money(perDay)}
            </span>
          </div>
          {/* NO BAR AGAINST A CAP WE HAVE NOT READ. The old fallback of 1
              drew any spend at all as a full bar — a limit reached, measured
              against nothing. */}
          {perDay !== null && (
            <progress
              aria-label="Daily trading limit used"
              max={Math.max(1, perDay)}
              value={Math.min(spent, Math.max(1, perDay))}
            />
          )}
        </div>
        </>}
        </section>
      </section>
    </div>
  );
}
