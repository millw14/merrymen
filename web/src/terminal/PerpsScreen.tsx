"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChartNoAxesCombined, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { LIGHTER_MARKETS_V1 } from "@merrymen/core";
import { readPerpsActivity, type PerpsActivityResponse } from "../lib/perps-activity";
import { readChartResponse } from "../lib/perps-chart-response";
import type { ChartResponse, ChartWindow } from "../lib/perps-chart-data";
import { walletUrl } from "../lib/wallet-param";
import { fullDateTime as when } from "../lib/format";
import { usePerpsAccount } from "./usePerpsAccount";
import { fetchAccountForSession } from "./account-session";
import { paperReport, perpsMoney, samePerpsIdentity, submitPerpsAction, type PerpsCommand } from "./perps-client";
import { requestJson } from "./request-json";
import { startRefreshLoop } from "./refresh-loop";
import { SignIn, type AccountState } from "./HostedControls";
import { SkeletonRows } from "./Skeleton";
import { PerpsChart } from "./PerpsChart";
import { marketSummary, marketPrice } from "./perps-market-summary";
import "./perps-desk.css";

type Action = Parameters<typeof submitPerpsAction>[1];
const errorText = (error: unknown) => error instanceof Error ? error.message : "The read could not be completed.";

export function PerpsModeBadge() {
  return <span className="perps-mode-badge" title="Simulated trading. No real funds are used.">Paper</span>;
}

export function PerpsLinks() {
  return <nav className="perps-actions" aria-label="Perps wallet navigation"><a href="/perps">Terminal</a><a href="/settings?wallet=perps">Settings</a><a href="/grant?wallet=perps">Wallet &amp; permission</a><a href="/withdraw?wallet=perps">Withdraw &amp; recover</a><a href="/perps/join">Request access</a></nav>;
}

export function PerpsScreen() {
  const state = usePerpsAccount();
  const identity = state.account?.status.grant?.smartAccount ?? state.account?.session.address ?? "signed-out";
  return <PerpsDesk key={identity} state={state}/>;
}

function PerpsDesk({ state }: { state: ReturnType<typeof usePerpsAccount> }) {
  const { account, report: response, busy, error, refresh } = state;
  const [market, setMarket] = useState("BTC-PERP");
  const [ledgerView, setLedgerView] = useState<"positions" | "activity">("positions");
  const [windowKey, setWindow] = useState<ChartWindow>("24h");
  const [data, setData] = useState<{ chart: ChartResponse | null; activity: PerpsActivityResponse | null; chartError: string; activityError: string }>({ chart: null, activity: null, chartError: "", activityError: "" });
  const [review, setReview] = useState<{ account: AccountState; action: Action } | null>(null);
  const [sending, setSending] = useState(false);
  const reviewPanel = useRef<HTMLElement>(null);
  useEffect(() => { if (review) reviewPanel.current?.focus(); }, [review]);
  const [command, setCommand] = useState<(PerpsCommand & { kind: Action["kind"] }) | null>(null);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const accountKey = account?.status.grant?.smartAccount ?? null;
  const owner = account?.session.hosted ? account.session.address : null;
  const signedIn = account !== null && (!account.session.hosted || account.session.address !== null);
  const hasAccount = !!account?.status.exists;
  const report = response?.report.state === "ok" ? paperReport(response.report.report) : null;
  const loading = !account && !error;

  useEffect(() => {
    let active = true;
    setData({ chart: null, activity: null, chartError: "", activityError: "" });
    if (!account) return;
    const expected = account;
    const loop = startRefreshLoop({ everyMs: 30_000, paused: () => document.hidden, report() {}, pass: async () => {
      const query = { market, book: "paper" as const, window: windowKey };
      const path = accountKey ? "/api/perps/chart" : "/api/perps/market";
      const params = new URLSearchParams({ market, window: windowKey, ...(accountKey ? { book: "paper" } : {}) });
      const chartRead = requestJson<unknown>(walletUrl(`${path}?${params}`, "perps")).then(raw => {
        const parsed = readChartResponse(raw, query);
        if (!parsed || (accountKey && !samePerpsIdentity(parsed, expected))) throw new Error("The chart could not be verified for this wallet.");
        if (active) setData(value => ({ ...value, chart: parsed, chartError: "" }));
      }).catch(error => { if (active) setData(value => ({ ...value, chart: null, chartError: errorText(error) })); });
      const activityRead = accountKey ? requestJson<unknown>(walletUrl("/api/perps/activity?market=all&book=paper", "perps")).then(raw => {
        const parsed = readPerpsActivity(raw, { market: "all", book: "paper" });
        if (!parsed || !samePerpsIdentity(parsed, expected)) throw new Error("Activity could not be verified for this wallet.");
        if (active) setData(value => ({ ...value, activity: parsed, activityError: "" }));
      }).catch(error => { if (active) setData(value => ({ ...value, activity: null, activityError: errorText(error) })); }) : Promise.resolve();
      await Promise.all([chartRead, activityRead]);
      return true;
    } });
    return () => { active = false; loop.stop(); };
  }, [accountKey, owner, account?.session.hosted, market, windowKey]);

  useEffect(() => {
    if (!command?.id || !account || command.state === "done" || command.state === "expired") return;
    let active = true;
    const id = command.id;
    const loop = startRefreshLoop({ everyMs: 5_000, paused: () => document.hidden, report() {}, pass: async () => {
      try {
        const current = await fetchAccountForSession(account.session, "perps");
        if (current.kind !== "ready" || current.account.status.grant?.smartAccount.toLowerCase() !== accountKey?.toLowerCase()) throw new Error("Your wallet changed; this command's outcome has not been confirmed.");
        const query = new URLSearchParams({ id, expectedAccount: accountKey!, ...(owner ? { owner } : {}) });
        const path = command.kind === "reset" ? "/api/paper-reset" : "/api/orders";
        const result = await requestJson<PerpsCommand>(walletUrl(`${path}?${query}`, "perps"));
        if (!result || result.id !== id || !["queued", "running", "done", "expired"].includes(result.state ?? "")) throw new Error("No answer for this command yet. Check the book before asking again.");
        if (active) {
          setCommand({ ...result, kind: command.kind });
          setMessage(result.state === "done" ? result.result || "The worker finished without an explanation. Check the book before asking again." : result.state === "expired" ? "The command expired before it was claimed." : `Command ${result.state}. A queued command is not a completed trade.`);
          if (result.state === "done" || result.state === "expired") refresh();
        }
        return true;
      } catch (error) { if (active) setMessage(errorText(error)); return false; }
    } });
    return () => { active = false; loop.stop(); };
  }, [command?.id, command?.state === "done" || command?.state === "expired", accountKey, owner, refresh]);

  async function confirm() {
    if (!review || inFlight.current) return;
    inFlight.current = true; setSending(true); setMessage("");
    try {
      const checked = await fetchAccountForSession(review.account.session, "perps");
      if (!mounted.current) return;
      if (checked.kind !== "ready" || checked.account.status.grant?.smartAccount.toLowerCase() !== review.account.status.grant?.smartAccount.toLowerCase()) throw new Error("Your account changed. Review the current wallet before confirming.");
      const result = await submitPerpsAction(review.account, review.action);
      if (!mounted.current) return;
      setCommand({ ...result, state: "queued", kind: review.action.kind });
      setMessage("Command queued. Waiting for the worker's answer; no completed trade or reset is confirmed yet.");
      refresh();
    } catch (error) { if (mounted.current) setMessage(errorText(error)); }
    finally { inFlight.current = false; if (mounted.current) { setSending(false); setReview(null); } }
  }
  const actionsBlocked = sending || command?.state === "queued" || command?.state === "running";
  // Never label the last historical candle as a current executable quote.
  const chart = data.chart?.market === market && data.chart.window === windowKey ? data.chart : null;
  const summary = marketSummary(chart);
  const symbol = market.replace(/-PERP$/, "");
  const windowLabel = windowKey === "24h" ? "24H" : windowKey === "7d" ? "7D" : "30D";
  const noAccount = <div className="perps-empty-state"><Wallet size={28} aria-hidden="true"/><h3>Your positions will appear here</h3><p>{signedIn ? "Set up your approved account to start a trading session." : "Sign in to view your positions and activity."}</p></div>;
  return <section className="perps-desk perps-terminal">
    <header className="perps-terminal-header">
      <div><div className="perps-title-row"><h1>Perpetuals</h1><PerpsModeBadge/></div><p>Find your edge. Keep your limits.</p></div>
      <PerpsLinks/>
    </header>
    <nav className="perps-market-tabs" aria-label="Choose a market">
      {["BTC", "ETH", "SOL", "HYPE"].map(value => <button type="button" key={value} aria-pressed={market === `${value}-PERP`} onClick={() => setMarket(`${value}-PERP`)}>{value}<span> / USD</span></button>)}
      <label><span className="sr-only">All markets</span><select aria-label="All markets" value={market} onChange={event => setMarket(event.target.value)}>{LIGHTER_MARKETS_V1.map(item => <option key={item.key} value={item.key}>{item.symbol} / USD</option>)}</select></label>
    </nav>
    <div className="perps-workbench">
      <section className="perps-market-panel" aria-label="Market chart">
        <header className="perps-market-header">
          <div className="perps-market-title"><span className="perps-symbol" aria-hidden="true">{symbol.slice(0, 1)}</span><div><h2>{symbol}<span> / USD</span></h2><span className="perps-eyebrow">Perpetual · Lighter</span></div></div>
          <dl className="perps-market-stats">
            <div><dt>Last candle</dt><dd>{marketPrice(summary?.last ?? null)}</dd></div>
            <div><dt>{windowLabel} window change</dt><dd data-tone={summary && summary.changePct >= 0 ? "up" : summary ? "down" : undefined}>{summary ? `${summary.changePct > 0 ? "+" : ""}${summary.changePct.toFixed(2)}%` : "—"}</dd></div>
            <div><dt>Window high</dt><dd>{marketPrice(summary?.high ?? null)}</dd></div>
            <div><dt>Window low</dt><dd>{marketPrice(summary?.low ?? null)}</dd></div>
          </dl>
        </header>
        <div className="perps-chart-toolbar"><h3><ChartNoAxesCombined size={15} aria-hidden="true"/> Chart <span>MARK PRICE</span></h3><div className="perps-windows" aria-label="Chart history window">{(["24h", "7d", "30d"] as const).map(value => <button key={value} type="button" aria-pressed={windowKey === value} onClick={() => setWindow(value)}>{value.toUpperCase()}</button>)}</div></div>
        <div className="perps-chart-frame">{data.chartError ? <div className="perps-empty-state" role="alert"><ChartNoAxesCombined size={28} aria-hidden="true"/><h3>Chart unavailable</h3><p>{data.chartError}</p></div> : chart ? <PerpsChart data={chart}/> : <div className="perps-empty-state" role="status"><ChartNoAxesCombined size={28} aria-hidden="true"/><p>{error ? "Market history is unavailable while your account is being verified." : "Loading market history…"}</p></div>}</div>
      </section>
      <aside className="perps-account-panel" aria-label="Perps account">
        <div className="perps-panel-heading"><h2>Your account</h2><button type="button" aria-label="Refresh account" title="Refresh account" disabled={busy} onClick={refresh}><RefreshCw size={15} aria-hidden="true"/></button></div>
        <p className="perps-account-status">{loading ? "Checking connection" : error ? "Connection unavailable" : hasAccount ? "Wallet connected" : signedIn ? "Setup required" : "Not connected"}</p>
        {loading && <SkeletonRows rows={3} label="Loading your Perps wallet"/>}
        {error && <p className="perps-notice" role="alert">{error}</p>}
        {account && !signedIn && <div className="perps-access"><div className="perps-access-icon"><Wallet size={26} aria-hidden="true"/></div><h3>Your next move starts here.</h3><p>Sign in to manage your account. Trading access is approved by an administrator.</p><SignIn onDone={refresh}/><a className="perps-text-link" href="/perps/join">Have an access code? <ArrowUpRight size={14} aria-hidden="true"/></a></div>}
        {signedIn && !hasAccount && <div className="perps-access"><div className="perps-access-icon"><ShieldCheck size={26} aria-hidden="true"/></div><h3>Make it your terminal.</h3><p>Request access with your code. Once approved, set up your separate Perps wallet.</p><a className="flow-primary" href="/perps/join">Request access <ArrowUpRight size={15} aria-hidden="true"/></a><a className="perps-text-link" href="/create?for=perps">Already approved? Set up wallet</a></div>}
        {hasAccount && <>
          <dl className="perps-account-metrics"><div><dt>Collateral</dt><dd>{report ? perpsMoney(report.collateralMicro) : "Not reported"}</dd></div><div><dt>Open notional</dt><dd>{report ? perpsMoney(report.openNotionalMicro) : "Not reported"}</dd></div><div><dt>Missing stops</dt><dd data-tone={report && report.stopsMissing > 0 ? "down" : undefined}>{report?.stopsMissing ?? "Not reported"}</dd></div></dl>
          {report?.entriesHalted && <p className="perps-notice" role="status">Close all has halted new entries. An explicit practice reset is required to start a new book.</p>}
          {report?.incident && <p className="perps-notice" role="alert">The worker reports an incident. Review its status before changing the book.</p>}
          {report?.blocker && <p className="perps-notice" role="status">Entry status: {report.blocker}.</p>}
          <a className="flow-primary" href="/settings?wallet=perps">Manage strategy <ArrowUpRight size={15} aria-hidden="true"/></a>
          <details className="perps-account-details"><summary>Wallet &amp; worker status</summary><p className="perps-address">Account <code>{accountKey}</code></p><p>Worker heartbeat: {account?.status.heartbeatUnread ? "could not be read" : account?.status.workerAliveAt == null ? "not reported" : when(account.status.workerAliveAt * 1000)}.</p>{report && <><p>Worker rail: {report.mode}.</p><p>Venue report: {report.venueReadAt === null ? "not reported" : when(report.venueReadAt)}.</p><p>Protection checked: {report.protectAt === null ? "not reported" : when(report.protectAt)}.</p></>}</details>
          {account?.status.workerStale === true && <p className="perps-notice" role="status">This worker is overdue; its report may be stale.</p>}
        </>}
        <div className="perps-guardrails"><ShieldCheck size={16} aria-hidden="true"/><div><strong>Risk controls, built in.</strong><p>Simulated funds. No deposit required. Approved accounts only.</p></div></div>
        <div className="perps-panel-links"><a href="/grant?wallet=perps">Wallet &amp; permission</a><a href="/withdraw?wallet=perps">Withdraw &amp; recover</a></div>
      </aside>
    </div>
    <section className="perps-ledger" aria-label="Positions and activity">
      <div className="perps-ledger-tabs"><div>{(["positions", "activity"] as const).map(value => <button type="button" key={value} aria-pressed={ledgerView === value} onClick={() => setLedgerView(value)}>{value === "positions" ? "Positions" : "Activity"}{value === "positions" && report && <span>{report.positions.length}</span>}</button>)}</div>{hasAccount && <div className="perps-ledger-actions"><button type="button" disabled={actionsBlocked} onClick={() => setReview({ account: account!, action: { kind: "close-all", unread: !report } })}>Close all &amp; halt entries</button><button type="button" disabled={actionsBlocked} onClick={() => setReview({ account: account!, action: { kind: "reset" } })}>Reset practice book</button></div>}</div>
      {!hasAccount ? noAccount : ledgerView === "positions" ? <>
        {!response ? <p role="status">Loading the worker&apos;s report…</p> : response.report.state === "not-said" ? <p className="perps-notice">The worker has not reported its book yet. This does not mean there are no positions.</p> : !report ? <p className="perps-notice" role="status">The book could not be read. Positions and balances are unknown.</p> : report.positions.length === 0 ? <div className="perps-empty-state"><ChartNoAxesCombined size={28} aria-hidden="true"/><h3>No positions in this report.</h3><p>New positions will appear here when your strategy opens them.</p></div> : <div className="perps-table-wrap"><table><thead><tr><th>Market</th><th>Side / size</th><th>Entry / mark</th><th>Margin / unrealized</th><th>Stop / liquidation</th><th>Action</th></tr></thead><tbody>{report.positions.map(position => <tr key={position.market}><th scope="row">{position.market}</th><td><span data-tone={position.side === "long" ? "up" : "down"}>{position.side} {position.baseAmount}</span><br/>{position.leverage ?? "Unknown"}×</td><td>{position.entryPrice}<br/>{position.markPrice ?? "Not reported"}</td><td>{perpsMoney(position.marginMicro)}<br/>{perpsMoney(position.unrealizedMicro)}</td><td>{position.stopTrigger ?? "Not reported"}<br/>{position.liqPrice ?? "Not reported"}</td><td><button type="button" disabled={actionsBlocked} onClick={() => setReview({ account: account!, action: { kind: "close", market: position.market } })}>Close {position.market}</button></td></tr>)}</tbody></table></div>}
      </> : <>{data.activityError ? <p className="perps-notice" role="alert">{data.activityError}</p> : !data.activity ? <p role="status">Loading recorded activity…</p> : data.activity.state !== "ok" ? <p className="perps-notice">Activity could not be read. An empty list would not be evidence of no trades.</p> : <>{data.activity.items.length === 0 ? <div className="perps-empty-state"><ChartNoAxesCombined size={28} aria-hidden="true"/><h3>No recorded fills or funding in the last 30 days.</h3><p>Execution history will appear here.</p></div> : <ol className="perps-activity">{data.activity.items.map(item => <li key={item.id}><time dateTime={new Date(item.timeMs).toISOString()}>{when(item.timeMs)}</time> · {item.market} · {item.kind === "fill" ? <>{item.effect} {item.side} {item.sizeExact} at {item.priceExact}; fee {perpsMoney(item.feeMicro)}; realized {perpsMoney(item.realizedMicro)}</> : <>Funding {perpsMoney(item.paymentMicro)}</>}</li>)}</ol>}{data.activity.unknownRows > 0 && <p>{data.activity.unknownRows} rows could not be interpreted.</p>}{data.activity.truncated && <p>Only the latest activity is shown.</p>}</>}</>}
    </section>
    {review && <section className="perps-confirm" ref={reviewPanel} tabIndex={-1} role="region" aria-label="Confirm practice action"><h2>{review.action.kind === "reset" ? "Reset this practice book?" : review.action.kind === "close" ? `Close ${review.action.market}?` : "Close all practice positions and halt entries?"}</h2><p>Perps account <code>{review.account.status.grant?.smartAccount}</code></p><p>{review.action.kind === "reset" ? "This starts a new simulated accounting epoch, clears practice positions and lifts the Close-all entry halt. Recorded history remains. It does not change your Spot book or enable live trading." : "The worker attempts the exit using its current book and prices. This is a request, not a guaranteed fill."}</p>{review.action.kind === "close-all" && review.action.unread && <p>The report is unreadable. Close all asks the worker to close every book it holds; this build supports paper only.</p>}<button type="button" disabled={sending} onClick={() => void confirm()}>{sending ? "Sending…" : "Confirm practice action"}</button><button type="button" disabled={sending} onClick={() => setReview(null)}>Cancel</button></section>}
    {message && <p className="perps-notice" role="status">{message}</p>}{command?.id && <p>Command reference: <code>{command.id}</code></p>}
    <footer className="perps-terminal-footer"><span>Robinhood Chain <span aria-hidden="true">/</span> Isolated Perps wallet</span><span>Market history refreshes every 30s</span></footer>
  </section>;
}
