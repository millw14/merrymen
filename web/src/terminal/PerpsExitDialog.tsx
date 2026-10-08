import { useEffect, useRef, useState } from "react";
import { perpMarketByKey } from "@merrymen/core";
import { followDeadline, followWindowMs, orderAnswer, routeAnswer, unansweredLine, type OrderPoll } from "./order-follow";
import { receiptOf } from "@/lib/order-state";
export interface PerpsExitRequest { owner: string | null; account: string; market?: string; book: "paper" | "live" }
type Props = PerpsExitRequest & { onClose: () => void; onChanged: () => void };
export function PerpsExitDialog(props: Props) {
  return <ExitReview key={`${props.owner}:${props.account}:${props.book}:${props.market ?? "all"}`} {...props}/>;
}
function ExitReview({ owner, account, market, book, onClose, onChanged }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), mounted = useRef(true), attempted = useRef(false);
  const [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const [waiting, setWaiting] = useState<{ id: string; until: number } | null>(null);
  const [receipt, setReceipt] = useState<ReturnType<typeof receiptOf>>(null);
  const valid = /^0x[a-fA-F0-9]{40}$/.test(account) && (market === undefined || !!perpMarketByKey(market));
  useEffect(() => {
    mounted.current = true;
    const el = dialog.current;
    if (el?.showModal) el.showModal(); else el?.setAttribute("open", "");
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!waiting) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    async function poll() {
      const params = new URLSearchParams({ purpose: "perps", id: waiting!.id, ...(owner ? { owner } : {}) });
      const answer = await routeAnswer<OrderPoll>(`/api/orders?${params}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)]) });
      if (stopped) return;
      if (answer?.status === 401 || answer?.status === 403 || answer?.status === 409) { setWaiting(null); setNote("The account could not be verified. Exit outcome is unknown; sign in and check positions before asking again."); return; }
      const result = answer?.ok ? answer.body : null;
      const line = orderAnswer(result);
      if (line) { setNote(`Worker result: ${line}`); setReceipt(receiptOf(result?.receipt)); setWaiting(null); onChanged(); return; }
      if (Date.now() > waiting!.until) { setNote(unansweredLine(result)); setWaiting(null); return; }
      setNote(result?.state === "running" ? "The worker is processing this exit. A fill is not yet confirmed." : "Exit queued. Waiting for the worker; positions may still be open.");
      timer = setTimeout(() => void poll(), 5_000);
    }
    void poll();
    return () => { stopped = true; abort.abort(); if (timer) clearTimeout(timer); };
  }, [waiting, owner, onChanged]);
  async function confirm() {
    if (!valid || attempted.current) return;
    attempted.current = true; setBusy(true); setNote("");
    const answer = await routeAnswer<{ id?: unknown; error?: unknown }>("/api/orders?purpose=perps", {
      credentials: "same-origin", cache: "no-store", method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, expectedAccount: account, purpose: market ? "close-perp" : "flatten-perps", side: "sell", symbol: market ?? "ALL-PERPS", usdgAmount: 0, book }),
    }, 12_000);
    if (!mounted.current) return;
    setBusy(false);
    if (!answer || !answer.ok || typeof answer.body?.id !== "string" || !answer.body.id) {
      setNote(!answer ? "The response was lost. An exit may have been queued. Check positions and activity before asking again; this request will not be retried automatically." : typeof answer.body?.error === "string" ? answer.body.error : "The exit was not confirmed. Check positions and activity before asking again."); return;
    }
    setNote("Exit queued. This is not a confirmed fill.");
    setWaiting({ id: answer.body.id, until: followDeadline(followWindowMs(answer.body), Date.now()) });
  }
  return <dialog ref={dialog} className="perps-exit-review" aria-labelledby="perps-exit-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id="perps-exit-title">{market ? `Close ${market}` : "Close all perpetual positions"}</h2>
    <p>{book === "live" ? "Real-money" : "Paper simulation"} · dedicated Perps wallet</p><p className="funding-address">{account}</p>
    <p>{market ? "Ask the worker to close the held position in this market." : "Ask the worker to close all held perpetual positions and halt new entries in this book."} The worker applies execution limits; a queued request does not prove positions are closed.</p>
    {!valid && <p role="alert">This account or market could not be verified.</p>}
    {!attempted.current && <button type="button" disabled={!valid || busy} onClick={() => void confirm()}>Confirm {book === "live" ? "real-money" : "paper"} exit</button>}
    {busy && <p role="status">Submitting your confirmed exit…</p>}
    {note && <p role="status">{note}</p>}{receipt && <p>Recorded outcome: {receipt.status}{receipt.rejectRule ? ` · ${receipt.rejectRule}` : ""}</p>}
    <button type="button" onClick={onClose}>{attempted.current ? "Hide status" : "Cancel"}</button>
  </dialog>;
}
