"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Sparkline } from "@/components/Sparkline";
import { ThesisCard } from "@/components/ThesisCard";
import { KillSwitch } from "@/components/KillSwitch";
import { railNotices } from "@/lib/rail-notices";
import { rankPnl, unrankedLabel } from "@/lib/rank-pnl";
import { statusLine, type AgentSnapshot } from "@/lib/status-line";
import { timeAgo } from "@/lib/time";
import type { PublicThesis } from "@/lib/thesis";

/**
 * YOUR agent. One tab in a social product, not a control room.
 *
 * The console this replaces was 1,866 lines showing five numbers and about
 * eleven hundred words. Everything cut was cut for a stated reason:
 *
 *   - the chat: a slash-command bot with dangerouslySetInnerHTML, a
 *     browser-built prompt and five hand-rolled intent regexes. The Telegram
 *     agent is the real conversational surface.
 *   - "ways out": a PRIVATE KEY REVEAL BUTTON on the home screen. It belongs on
 *     /grant, where the wallet lives and the user is already in a deliberate
 *     money-moving frame.
 *   - the self-test: a diagnostic with a four-second poll, on the front page.
 *   - the embers: thirty particles on an unbounded animation loop over a
 *     full-viewport canvas, on every phone, forever.
 *
 * What survives is every FIGURE, plus the one sentence that explains them.
 */

interface FeedTrade {
  status: string;
  kind: string;
  amount_usdg: number;
  created_at: string;
  reject_rule?: string | null;
}
interface FeedPosition {
  symbol: string;
  token?: string | null;
  value_usdg: number;
  price_stale?: number | boolean;
}
interface FeedResponse {
  events?: { level: string; message: string; created_at: string }[];
  equity?: { equity_usdg: number }[];
  positions?: FeedPosition[];
  trades?: FeedTrade[];
  agent?: { name?: string; strategy?: string; basket?: string[] } | null;
  netContributionsUsdg?: number | null;
  gasUsdg?: number;
  /** Landed fills whose gas could not be priced. Non-zero means GROSS of gas. */
  gasUnpricedTrades?: number;
  /** Fills that landed. Zero means there is no return to measure. */
  landed?: number;
  /**
   * The worker's verdict on the denominator: true, false, or null for never
   * assessed. Absent is treated as null — never as permission.
   */
  contributionsKnown?: boolean | null;
}
interface GrantsResponse {
  exists?: boolean;
  mode?: string;
  gasSponsored?: boolean;
  grant?: { chainId?: number; caps?: Record<string, number>; expiresAt?: number } | null;
  balances?: { ethWei?: string; cashUsdg?: number; vaultUsdg?: number } | null;
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function YouClient() {
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [grants, setGrants] = useState<GrantsResponse | null>(null);
  const [mine, setMine] = useState<PublicThesis[]>([]);
  const [session, setSession] = useState<{ hosted: boolean; address: string | null } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    // GATE THE POLL, NEVER THE FIRST LOAD. Skipping the initial fetch when the
    // document is hidden leaves the skeleton on screen forever — a tab opened
    // in the background, or restored by a session manager, never resolves and
    // there is no second chance because the interval is gated too.
    let first = true;
    const load = async () => {
      if (!first && document.visibilityState !== "visible") return;
      first = false;
      try {
        const [f, g, s] = await Promise.all([
          fetch("/api/feed").then((r) => r.json()),
          fetch("/api/grants").then((r) => r.json()),
          fetch("/api/auth/session").then((r) => r.json()),
        ]);
        if (!alive) return;
        setFeed(f);
        setGrants(g);
        setSession(s);
      } catch {
        /* leave the last good state on screen rather than blanking it */
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Own posts come from the public feed, filtered by name — the only join
  // available without sending this browser an agent id it has no use for.
  useEffect(() => {
    const name = feed?.agent?.name;
    if (!name) return;
    let alive = true;
    void fetch("/api/theses")
      .then((r) => r.json())
      .then((d: { theses?: PublicThesis[] }) => {
        if (alive) setMine((d.theses ?? []).filter((t) => t.name === name).slice(0, 12));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [feed?.agent?.name]);

  const hasAgent = grants?.exists === true;

  if (loading) {
    return (
      <>
        <PageHeader title="You" />
        <div className="mm-wrap">
          <div className="mm-skel">
            <i className="face" />
            <div>
              <i className="l" style={{ width: "40%" }} />
              <i className="l" style={{ width: "70%" }} />
            </div>
          </div>
        </div>
      </>
    );
  }

  if (!hasAgent) {
    return (
      <>
        <PageHeader title="You" />
        <div className="mm-wrap">
          <div className="mm-empty">
            <h2>You don&rsquo;t have an agent yet</h2>
            <p>
              {session?.address
                ? "Your wallet is connected. The next step is signing the permissions your agent trades under — you decide the caps, and it cannot exceed them."
                : "Agents here trade under permissions you sign, with caps you set. Nothing can be moved outside them."}
            </p>
            <p style={{ marginTop: 16 }}>
              <Link href="/grant" className="mm-btn primary">
                Deploy an agent
              </Link>
            </p>
          </div>
        </div>
      </>
    );
  }

  const equity = feed?.equity ?? [];
  const curve = equity.map((e) => Number(e.equity_usdg)).filter(Number.isFinite);
  // NULL, NOT ZERO, when there is no equity history.
  //
  // This fell back to 0, and the P&L below divided by it — so an agent with a
  // deposit and no equity rows rendered "-100.0% all time". A fabricated number
  // out of an absence, on the owner's own dashboard.
  const latest = curve.length ? curve[curve.length - 1]! : null;
  const contributed = feed?.netContributionsUsdg ?? null;
  const gas = feed?.gasUsdg ?? 0;

  // THROUGH THE SHARED GATE, not a fifth copy of the formula.
  //
  // This computed its own P&L inline with no landed-trade guard — which is
  // exactly the +2643.3% incident `rank-pnl.ts` was written about, on the one
  // page whose reader owns the money. It also had no quality term, so a
  // contribution total assembled from inference published a confident
  // percentage over an unevidenced denominator.
  const rank = rankPnl({
    contributed,
    latest,
    gasUsdg: gas,
    landed: feed?.landed ?? 0,
    contributionsKnown: feed?.contributionsKnown ?? null,
  });
  const pnlPct = rank.pnlBps === null ? null : rank.pnlBps / 100;
  const pnl = rank.pnlBps === null || contributed === null || latest === null ? null : latest - contributed - gas;

  const positions = feed?.positions ?? [];
  const trades = (feed?.trades ?? []).slice(0, 7);
  const name = feed?.agent?.name ?? "Your agent";
  const cash = grants?.balances?.cashUsdg ?? 0;
  const vault = grants?.balances?.vaultUsdg ?? 0;
  const positionsUsdg = positions.reduce((s, p) => s + Number(p.value_usdg ?? 0), 0);

  const today = Date.now() - 86_400_000;
  const landedToday = (feed?.trades ?? []).filter(
    (t) => t.status === "landed" && Date.parse(`${t.created_at}Z`) > today,
  ).length;
  const refusedToday = (feed?.trades ?? []).filter(
    (t) => (t.status === "rejected" || t.status === "reverted") && Date.parse(`${t.created_at}Z`) > today,
  ).length;

  const rail = railNotices(feed?.events);

  const snap: AgentSnapshot = {
    name,
    mode: (grants?.mode as AgentSnapshot["mode"]) ?? "idle",
    testnet: grants?.grant?.chainId === 46630,
    gasSponsored: grants?.gasSponsored,
    hasGas: BigInt(grants?.balances?.ethWei ?? "0") > 0n,
    cashUsdg: cash,
    positionsUsdg,
    positionCount: positions.length,
    tradableCount: feed?.agent?.basket?.length ?? 0,
    landedToday,
    refusedToday,
    daysLeft: grants?.grant?.expiresAt
      ? Math.max(0, Math.ceil((grants.grant.expiresAt * 1000 - Date.now()) / 86_400_000))
      : null,
    lastError: feed?.events?.find((e) => e.level === "err")?.message ?? null,
  };
  const status = statusLine(snap);
  const tone = pnl === null ? "flat" : pnl >= 0 ? "up" : "down";

  return (
    <>
      <PageHeader
        title={name}
        sub={<span className="mono">{[grants?.mode, feed?.agent?.strategy].filter(Boolean).join(" · ")}</span>}
      />
      <div className="mm-wrap">
        {/* The one sentence for somebody who does not already know what they are
            looking at. 286 lines, pure and tested, kept verbatim. */}
        <div className={`mm-status ${status.tone}`}>
          <span className="dot" aria-hidden />
          <div>
            <p className="head">{status.headline}</p>
            <p className="next">{status.next}</p>
          </div>
        </div>

        {/* WHAT THE RAIL IS SAYING.

            The worker has been writing `warn` events since it was built, /api/feed
            has always returned them, and no surface in the product has ever
            rendered one: the only consumer of `events` took `level === "err"`
            for the status line and dropped the rest.

            Among the messages that went nowhere is index.ts's "no bundler key —
            this agent CANNOT trade live, and nothing it does will reach the
            chain", whose own comment reads SAY IT WHERE THE OWNER WILL LOOK. It
            was written, raised, stored, and filtered out of the only page that
            reads events — so an audit of 1,311 intents and zero fills read as a
            broken execution path, when the truth was that execution had never
            been configured. */}
        {rail.length > 0 && (
          <section className="mm-notices" aria-label="Warnings from the trading rail">
            <h2 className="mm-kicker">What the rail is saying</h2>
            <ul>
              {rail.map((e) => (
                <li key={e.message}>
                  <p>{e.message}</p>
                  <span className="mono">{timeAgo(Date.parse(`${e.created_at}Z`) / 1000)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mm-hero">
          <div className="mm-hero-top">
            <AgentAvatar name={name} size={44} />
            <div>
              <p className="mm-kicker">everything it holds</p>
              <p className="big mono">{money(latest || cash + vault + positionsUsdg)}</p>
            </div>
            <div className="mm-hero-pnl">
              {pnlPct === null ? (
                // The REASON, not a guess at one. This said "no deposit on
                // record" for every refusal, including the ones where a deposit
                // is plainly on record and simply cannot be evidenced.
                <span className="mono flat">{rank.unrankedWhy ? unrankedLabel(rank.unrankedWhy) : "unranked"}</span>
              ) : (
                <span className={`mono ${tone}`}>
                  {pnlPct > 0 ? "+" : ""}
                  {pnlPct.toFixed(1)}% all time
                  {/* GROSS OR NET, said rather than implied. On a small book the
                      difference is most of the number: the canary's four fills
                      read -0.13 gross and -6.65 net. */}
                  {(feed?.gasUnpricedTrades ?? 0) > 0 ? ", gross of some gas" : ""}
                </span>
              )}
            </div>
          </div>
          {curve.length > 1 && (
            <Sparkline points={curve.slice(-60)} width={640} height={64} tone={tone} />
          )}
          <dl className="mm-slices">
            <Slice label="cash" value={money(cash)} />
            <Slice label="vault" value={money(vault)} />
            <Slice label="positions" value={money(positionsUsdg)} />
          </dl>
        </section>

        <section className="mm-you-cols">
          <div>
            <h2 className="mm-kicker">Lately</h2>
            {trades.length === 0 ? (
              <p className="mm-note">Nothing yet.</p>
            ) : (
              <ul className="mm-tape">
                {trades.map((t, i) => (
                  <li key={i} className={t.status}>
                    <span className="k mono">{t.kind}</span>
                    <span className="a mono">{money(Number(t.amount_usdg ?? 0))}</span>
                    <span className="s mono">{t.reject_rule ?? t.status}</span>
                    <span className="w mono">{timeAgo(Date.parse(`${t.created_at}Z`) / 1000)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h2 className="mm-kicker">Holding</h2>
            {positions.length === 0 ? (
              <p className="mm-note">Nothing right now.</p>
            ) : (
              <ul className="mm-tape">
                {positions.map((p) => (
                  <li key={p.symbol}>
                    <span className="k mono">
                      {p.token ? <Link href={`/t/${p.token}`}>{p.symbol}</Link> : p.symbol}
                    </span>
                    <span className="a mono">{money(Number(p.value_usdg ?? 0))}</span>
                    {/* QUIET, NOT WARN. --mm-warn is the wall saying no, and a
                        price nobody has refreshed is not something the wall
                        did. The token page already chips this case quietly. */}
                    {p.price_stale ? (
                      <span className="mm-chip quiet" title="This mark has not been refreshed recently">
                        stale
                      </span>
                    ) : (
                      <span />
                    )}
                    <span />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {mine.length > 0 && (
          <section className="mm-agent-feed">
            <h2 className="mm-kicker">What it said in public</h2>
            <div className="mm-feed">
              {mine.map((t, i) => (
                <ThesisCard key={`${t.at}:${i}`} t={t} hideAgent />
              ))}
            </div>
          </section>
        )}

        <section className="mm-money">
          <h2 className="mm-kicker">Money &amp; control</h2>
          <p className="mm-note">
            The wallet, the caps, withdrawal and the kill switch all live where the keys do.
          </p>
          <p style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link href="/swap" className="mm-btn primary">
              Swap ETH → USDG
            </Link>
            <Link href="/grant" className="mm-btn">
              Wallet &amp; permissions
            </Link>
            <Link href="/settings" className="mm-btn">
              Settings
            </Link>
          </p>
          {/* THE KILL SWITCH SURVIVES THE REDESIGN. It lived on /home, which is
              gone; dropping it with the page would have removed the one control
              that stops an agent immediately, which is a safety regression
              rather than a simplification. */}
          <div className="mm-kill">
            <KillSwitch />
          </div>
        </section>
      </div>
    </>
  );
}

function Slice({ label, value }: { label: string; value: string }) {
  return (
    <div className="mm-slice">
      <dt className="mm-kicker">{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}
