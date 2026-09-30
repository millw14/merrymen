"use client";
import { useEffect, useRef, useState } from "react";
import { routeAnswer } from "./order-follow";

/** Dashboard-only, separate from the chat registry and the perps opt-in. */
export function PerpsResume({ owner, hosted, mode, incident }: {
  owner: string | null; hosted: boolean | null; mode: "paper" | "live"; incident: boolean;
}) {
  const [question, setQuestion] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<{ id: string; until: number } | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setQuestion(false); setBusy(false); setWaiting(null); setNote(null);
    return () => { generation.current++; };
  }, [owner, mode]);

  useEffect(() => {
    if (!waiting) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const params = new URLSearchParams({ id: waiting.id, ...(owner ? { owner } : {}) });
      const answer = await routeAnswer<{ state?: string; result?: string; error?: string }>(`/api/perps/resume?${params}`, { cache: "no-store" });
      if (!current) return;
      if (answer?.ok && answer.body?.state === "done") {
        setNote(answer.body.result || "The worker finished without a readable result. Check perpetuals status before asking again.");
        setWaiting(null); return;
      }
      if (answer?.ok && answer.body?.state === "expired") {
        setNote("The request expired before the worker picked it up. Entries were not resumed by this request.");
        setWaiting(null); return;
      }
      if (Date.now() > waiting.until || answer?.status === 409) {
        setNote(answer?.body?.error || "The worker has not answered. Entry status is unknown; check perpetuals status before asking again.");
        setWaiting(null); return;
      }
      timer = setTimeout(poll, 5_000);
    };
    void poll();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [waiting, owner]);

  async function resume() {
    if (busy || waiting || incident || hosted === null || (hosted && !owner)) return;
    const started = generation.current;
    setBusy(true); setQuestion(false);
    const answer = await routeAnswer<{ id?: string; expiresInMs?: number; error?: string }>("/api/perps/resume", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, mode, confirm: true }),
    });
    if (generation.current !== started) return;
    setBusy(false);
    if (!answer) { setNote("The response was lost. The request may be queued; check perpetuals status before asking again."); return; }
    if (!answer.ok || !answer.body?.id) { setNote(answer.body?.error || "The request could not be queued."); return; }
    setNote("Queued. New entries stay halted until the worker confirms the change.");
    setWaiting({ id: answer.body.id, until: Date.now() + (answer.body.expiresInMs ?? 15 * 60_000) + 3 * 60_000 });
  }
  return <section className="mm-hint">
    <p>Resume {mode === "paper" ? "paper" : "real-money"} perpetual entries after Close all. Your existing consent, permission and limits still apply.</p>
    {incident ? <p role="alert">An incident must be resolved with key rotation before entries can resume.</p>
      : question ? <div>
          <p>Allow the agent to open new {mode === "paper" ? "paper" : "real-money"} perpetual positions again?</p>
          <button type="button" disabled={busy || waiting !== null} onClick={() => void resume()}>Confirm resume entries</button>{" "}
          <button type="button" onClick={() => setQuestion(false)}>Cancel</button>
        </div>
      : <button type="button" disabled={busy || waiting !== null || hosted === null || (hosted && !owner)} onClick={() => setQuestion(true)}>Resume perpetual entries</button>}
    {note && <p role="status">{note}</p>}
  </section>;
}
