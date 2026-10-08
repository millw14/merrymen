import { useEffect, useRef, useState } from "react";
import { readPerpsActivity, type PerpsActivityResponse } from "../lib/perps-activity";
import type { ChartBook } from "../lib/perps-chart-data";
import { usdExact } from "../lib/format";
import { startRefreshLoop } from "./refresh-loop";

/** USD micro-units are ledger integers; never round them through Number. */
function ledgerMoney(value: string | null, signed = true) {
  if (value === null || !/^-?\d+$/.test(value)) return "Not reported";
  const negative = value.startsWith("-");
  const absolute = BigInt(negative ? value.slice(1) : value);
  const decimal = `${absolute / 1_000_000n}.${String(absolute % 1_000_000n).padStart(6, "0")}`;
  return `${negative ? "−" : signed ? "+" : ""}${usdExact(decimal)}`;
}
const recordedAt = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", " UTC");

export function PerpsActivity({ market, book }: { market: string; book: ChartBook }) {
  const [data, setData] = useState<PerpsActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const retry = useRef<(() => void) | null>(null);
  useEffect(() => {
    let stopped = false;
    let request: AbortController | null = null;
    let retryAt = 0;
    setData(null); setError(null);
    const loop = startRefreshLoop({ everyMs: 30_000, paused: () => document.hidden || Date.now() < retryAt, report() {}, onFlight: (value) => { if (!stopped) setBusy(value); }, pass: async () => {
      if (Date.now() < retryAt) return false;
      request = new AbortController();
      const timeout = globalThis.setTimeout(() => request?.abort(), 12_000);
      try {
        const response = await fetch(`/api/perps/activity?${new URLSearchParams({ market, book, purpose: "perps" })}`, { credentials: "same-origin", cache: "no-store", signal: request.signal });
        if (stopped) return false;
        if (response.status === 401 || response.status === 403) { setData(null); throw new Error("Sign in again to read your private activity."); }
        if (response.status === 429) { retryAt = Date.now() + 60_000; throw new Error("Activity refresh is limited. Retrying after a short pause."); }
        if (!response.ok) throw new Error("Activity could not be refreshed. Showing the last successful read, if available.");
        const next = readPerpsActivity(await response.json(), { market, book });
        if (stopped) return false;
        if (!next) throw new Error("The activity report could not be read.");
        setData(next); setError(null);
        return true;
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "Activity refresh timed out. Retrying automatically.");
        return false;
      } finally { globalThis.clearTimeout(timeout); }
    } });
    retry.current = loop.retryNow;
    const wake = () => { if (!document.hidden) loop.wake(); };
    document.addEventListener("visibilitychange", wake);
    return () => { stopped = true; request?.abort(); loop.stop(); retry.current = null; document.removeEventListener("visibilitychange", wake); };
  }, [market, book]);
  return <section className="perps-activity" aria-label="Your execution and funding activity">
    <div className="perps-section-heading"><h2>Execution journal</h2><button type="button" disabled={busy} onClick={() => retry.current?.()}>{busy ? "Reading…" : "Refresh activity"}</button></div>
    <p className="perps-history-help">{book === "paper" ? "Paper" : "Live"} · {market === "all" ? "All markets" : market} · latest 30 days. Entries, reductions, closes and funding from your agent’s records.</p>
    {error ? <p className="perps-data-note is-warning" role="status">{error}{data ? ` Last successful read ${recordedAt(data.generatedAtMs)}.` : " Activity is unknown until a read succeeds."}</p> : null}
    {!data ? <p className="perps-history-empty">{busy ? "Reading private activity…" : "Activity has not been read."}</p> : data.state !== "ok" ? <p className="perps-history-empty">{data.state === "not-configured" ? "No activity configuration is available for your account." : "Your execution journal could not be read."} This does not establish whether positions are open.</p> : <>
      {data.truncated || data.unknownRows > 0 ? <p className="perps-data-note is-warning">This journal is incomplete. {data.truncated ? "Only the latest 100 records are shown. " : ""}{data.unknownRows > 0 ? `${data.unknownRows} records could not be read.` : ""}</p> : null}
      {data.items.length === 0 ? <p className="perps-history-empty">No readable records {market === "all" ? "across these markets" : "in this market"} and book for the last 30 days. Current positions are reported separately.</p> : <ol className="perps-activity-list">{data.items.map((item) => <li key={item.id}>
        <div className="perps-activity-kind"><span>{market === "all" ? `${item.market} · ` : ""}{item.kind === "funding" ? "FUNDING" : item.effect === "unknown" ? "UNCLASSIFIED FILL" : item.effect.toUpperCase()}</span><time dateTime={new Date(item.timeMs).toISOString()}>{recordedAt(item.timeMs)}</time></div>
        {item.kind === "funding" ? <strong>{ledgerMoney(item.paymentMicro)}</strong> : <><div><strong className={item.side === "long" ? "up" : "down"}>{item.effect === "reverse" ? `Reversed from ${item.side}` : item.side} · {item.sizeExact}{item.effect === "reverse" ? " total executed" : ""} @ {usdExact(item.priceExact)}</strong><span className="perps-activity-detail">{item.attribution} · {item.tradeType}</span></div><dl><div><dt>Realized P&amp;L</dt><dd>{ledgerMoney(item.realizedMicro)}</dd></div><div><dt>Fee</dt><dd>{ledgerMoney(item.feeMicro, false)}</dd></div></dl></>}
      </li>)}</ol>}
    </>}
  </section>;
}
