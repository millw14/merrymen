"use client";

import { useEffect, useRef, useState } from "react";
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
import "./perps-desk.css";

type Action = Parameters<typeof submitPerpsAction>[1];
const errorText = (error: unknown) => error instanceof Error ? error.message : "The read could not be completed.";

export function PerpsLinks() {
  return <nav className="perps-actions" aria-label="Perps wallet navigation"><a href="/perps">Paper desk</a><a href="/settings?wallet=perps">Perps settings</a><a href="/grant?wallet=perps">Wallet &amp; permission</a><a href="/withdraw?wallet=perps">Withdraw &amp; recover</a></nav>;
}

export function PerpsScreen() {
  const state = usePerpsAccount();
  const identity = state.account?.status.grant?.smartAccount ?? state.account?.session.address ?? "signed-out";
  return <PerpsDesk key={identity} state={state}/>;
}

function PerpsDesk({ state }: { state: ReturnType<typeof usePerpsAccount> }) {
  const { account, report: response, busy, error, refresh } = state;
  const [market, setMarket] = useState("BTC-PERP");
  const [windowKey, setWindow] = useState<ChartWindow>("24h");
  const [data, setData] = useState<{ chart: ChartResponse | null; activity: PerpsActivityResponse | null; chartError: string; activityError: string }>({ chart: null, activity: null, chartError: "", activityError: "" });
  const [review, setReview] = useState<{ account: AccountState; action: Action } | null>(null);
  const [sending, setSending] = useState(false);
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
  return <section className="perps-desk">
    <header><p className="perps-eyebrow">Robinhood Chain · separate Perps wallet</p><h1>Perpetuals, on paper</h1><p>Simulated USDG and positions. No real-money perpetual trading or funding is enabled.</p><PerpsLinks/></header>
    <button type="button" className="flow-secondary" disabled={busy} onClick={refresh}>{busy ? "Refreshing…" : "Refresh account"}</button>
    {loading && <SkeletonRows rows={3} label="Loading your Perps wallet"/>}
    {error && <p role="alert">{error}</p>}
    {account && !signedIn && <section><h2>Sign in to your Perps wallet</h2><SignIn onDone={refresh}/></section>}
    {signedIn && !hasAccount && <section><h2>Start a separate practice book</h2><p>Your Spot wallet and public profile stay separate.</p><a className="flow-primary" href="/create?for=perps">Create paper Perps wallet</a></section>}
    {hasAccount && <section aria-label="Perps account"><h2>Your practice book</h2><p className="perps-address">Account <code>{accountKey}</code></p><p>Worker heartbeat: {account?.status.heartbeatUnread ? "could not be read" : account?.status.workerAliveAt == null ? "not reported" : when(account.status.workerAliveAt * 1000)}{account?.status.workerStale === true ? ". This worker is overdue; its report may be stale." : "."}</p>
      {!response ? <p>Loading the worker&apos;s report…</p> : response.report.state === "not-said" ? <p>The worker has not reported its book yet. This does not mean there are no positions.</p> : !report ? <p role="status">The practice book could not be read. Positions and balances are unknown.</p> : <>
        <p>Worker rail: {report.mode}. {report.blocker ? `Entry status: ${report.blocker}.` : ""}</p>
        <p>Venue report: {report.venueReadAt === null ? "not reported" : when(report.venueReadAt)}. Protection checked: {report.protectAt === null ? "not reported" : when(report.protectAt)}.</p>
        {report.entriesHalted && <p role="status">Close all has halted new entries. An explicit practice reset is required to start a new book.</p>}
        {report.incident && <p role="alert">The worker reports an incident. Review its status before changing the practice book.</p>}
        <dl className="perps-metrics"><div><dt>Open notional</dt><dd>{perpsMoney(report.openNotionalMicro)}</dd></div><div><dt>Collateral</dt><dd>{perpsMoney(report.collateralMicro)}</dd></div><div><dt>Missing stops</dt><dd>{report.stopsMissing}</dd></div></dl>
        <h3>Positions</h3>{report.positions.length === 0 ? <p>No positions in this report.</p> : <div className="perps-table-wrap"><table><thead><tr><th>Market</th><th>Side / size</th><th>Entry / mark</th><th>Margin / unrealized</th><th>Stop / liquidation</th><th>Action</th></tr></thead><tbody>{report.positions.map(position => <tr key={position.market}><th scope="row">{position.market}</th><td>{position.side} {position.baseAmount}<br/>{position.leverage ?? "Unknown"}×</td><td>{position.entryPrice}<br/>{position.markPrice ?? "Not reported"}</td><td>{perpsMoney(position.marginMicro)}<br/>{perpsMoney(position.unrealizedMicro)}</td><td>{position.stopTrigger ?? "Not reported"}<br/>{position.liqPrice ?? "Not reported"}</td><td><button type="button" disabled={actionsBlocked} onClick={() => setReview({ account: account!, action: { kind: "close", market: position.market } })}>Close {position.market}</button></td></tr>)}</tbody></table></div>}
      </>}
      <div className="perps-actions"><button type="button" disabled={actionsBlocked} onClick={() => setReview({ account: account!, action: { kind: "close-all", unread: !report } })}>Close all &amp; halt entries</button><button type="button" disabled={actionsBlocked} onClick={() => setReview({ account: account!, action: { kind: "reset" } })}>Reset practice book</button></div>
    </section>}
    {review && <section className="perps-confirm" role="region" aria-label="Confirm practice action"><h2>{review.action.kind === "reset" ? "Reset this practice book?" : review.action.kind === "close" ? `Close ${review.action.market}?` : "Close all practice positions and halt entries?"}</h2><p>Perps account <code>{review.account.status.grant?.smartAccount}</code></p><p>{review.action.kind === "reset" ? "This starts a new simulated accounting epoch, clears practice positions and lifts the Close-all entry halt. Recorded history remains. It does not change your Spot book or enable live trading." : "The worker attempts the exit using its current book and prices. This is a request, not a guaranteed fill."}</p>{review.action.kind === "close-all" && review.action.unread && <p>The report is unreadable. Close all asks the worker to close every book it holds; this build supports paper only.</p>}<button type="button" disabled={sending} onClick={() => void confirm()}>{sending ? "Sending…" : "Confirm practice action"}</button><button type="button" disabled={sending} onClick={() => setReview(null)}>Cancel</button></section>}
    {message && <p role="status">{message}</p>}{command?.id && <p>Command reference: <code>{command.id}</code></p>}
    <section><h2>Market &amp; recorded entries</h2><div className="perps-actions"><label>Market <select value={market} onChange={event => setMarket(event.target.value)}>{LIGHTER_MARKETS_V1.map(item => <option key={item.key} value={item.key}>{item.key}</option>)}</select></label><label>Window <select value={windowKey} onChange={event => setWindow(event.target.value as ChartWindow)}><option value="24h">24 hours</option><option value="7d">7 days</option><option value="30d">30 days</option></select></label></div>{data.chartError ? <p role="alert">{data.chartError}</p> : data.chart ? <PerpsChart data={data.chart}/> : <p>Loading market history…</p>}</section>
    {hasAccount && <section><h2>Recorded activity</h2>{data.activityError ? <p role="alert">{data.activityError}</p> : !data.activity ? <p>Loading recorded activity…</p> : data.activity.state !== "ok" ? <p>Activity could not be read. An empty list would not be evidence of no trades.</p> : <>{data.activity.items.length === 0 ? <p>No recorded fills or funding in the last 30 days.</p> : <ol className="perps-activity">{data.activity.items.map(item => <li key={item.id}><time dateTime={new Date(item.timeMs).toISOString()}>{when(item.timeMs)}</time> · {item.market} · {item.kind === "fill" ? <>{item.effect} {item.side} {item.sizeExact} at {item.priceExact}; fee {perpsMoney(item.feeMicro)}; realized {perpsMoney(item.realizedMicro)}</> : <>Funding {perpsMoney(item.paymentMicro)}</>}</li>)}</ol>}{data.activity.unknownRows > 0 && <p>{data.activity.unknownRows} rows could not be interpreted.</p>}{data.activity.truncated && <p>Only the latest activity is shown.</p>}</>}</section>}
  </section>;
}
