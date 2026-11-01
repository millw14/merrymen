"use client";

import { useEffect, useRef, useState } from "react";
import { clearGrant } from "../lib/session";

/** The signed-in login, as the Perps account read reports it (AccountState.session). */
export type StopAllSession = { hosted: boolean; address: string | null };

const loginOf = (s: StopAllSession) => `${s.hosted}:${s.address?.toLowerCase() ?? ""}`;
const UNCONFIRMED = "Check your agents before asking again.";

/**
 * THE LOGIN-WIDE KILL, ON THE PERPS SCREENS. DELETE /api/grants with purpose
 * "delete-agent" and no wallet stops every wallet the login has: Spot, Perps
 * and Solana (grants route DELETE). The Spot screen offers it only beside a
 * Spot grant, so an owner with only a Perps wallet had no way to send it from
 * the web; the phones gained the same button for that owner in #373.
 *
 * Behind no offering or pilot gate: switching a capability off never stands
 * between an owner and the stop. One reviewed press sends it once, bound to the
 * login that was reviewed (expectedTenant: the server refuses another). A lost
 * or unconfirmed answer is reported and never retried.
 */
export function StopAllAgents({ session, onDone }: { session: StopAllSession | null; onDone?: () => void }) {
  const login = session ? loginOf(session) : null;
  const ready = !!session && (!session.hosted || !!session.address);
  const [review, setReview] = useState<StopAllSession | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const current = useRef(login);
  current.current = login;
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // A review belongs to the login it was opened under; any other closes it.
  useEffect(() => { setReview(null); }, [login]);
  useEffect(() => { if (review) panel.current?.focus(); }, [review]);

  async function stop() {
    if (!review || inFlight.current) return;
    const reviewed = review;
    if (current.current !== loginOf(reviewed)) {
      setReview(null);
      setMessage("Your account changed. Review the stop again for the current login.");
      return;
    }
    inFlight.current = true; setSending(true); setMessage("");
    try {
      let res: Response;
      try {
        res = await fetch("/api/grants", {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ purpose: "delete-agent", ...(reviewed.hosted ? { expectedTenant: reviewed.address } : {}) }),
        });
      } catch {
        if (mounted.current) setMessage(`The stop response was not received, so it is not known whether it reached the server. ${UNCONFIRMED}`);
        return;
      }
      const body = await res.json().catch(() => null) as { ok?: unknown; error?: unknown } | null;
      if (!res.ok) {
        // The server's own sentence: a partial kill names what is still running.
        if (mounted.current) setMessage(typeof body?.error === "string" && body.error ? body.error : `The service did not confirm the stop (${res.status}). ${UNCONFIRMED}`);
        return;
      }
      if (body?.ok !== true) {
        if (mounted.current) setMessage(`The stop response could not be confirmed. ${UNCONFIRMED}`);
        return;
      }
      // EVERY WALLET'S BROWSER COPY, as the kill stopped every wallet: each is
      // archived (its owner key kept, session.ts clearGrant) and then cleared,
      // so no screen offers to re-arm a permission the kill just removed.
      try { clearGrant("spot"); clearGrant("perps"); } catch { /* storage unavailable: nothing here to re-arm either */ }
      if (mounted.current) setMessage("Stop request accepted for Spot, Perps and Solana. Existing assets remain in their accounts.");
      onDone?.();
    } finally {
      inFlight.current = false;
      if (mounted.current) { setSending(false); setReview(null); }
    }
  }

  return <section className="perps-stop-all" aria-label="Stop all agents">
    <h2>Stop all agents</h2>
    <p>Stops Spot, Perps and Solana for this login. It removes active server permissions and agent memory. It does not withdraw assets or revoke permissions on-chain.</p>
    {!review && <button type="button" className="perps-stop-all-button" disabled={!ready || sending} onClick={() => { setMessage(""); setReview(session); }}>Stop all agents</button>}
    {!ready && <p role="status">{session === null ? "Waiting for your login to be confirmed." : "Sign in to stop the agents for your login."}</p>}
    {review && <section className="perps-confirm" ref={panel} tabIndex={-1} role="region" aria-label="Confirm stopping all agents">
      <h3>Stop all agents for this login?</h3>
      {review.hosted && <p>Signed in as <code>{review.address}</code></p>}
      <p>Spot, Perps and Solana for this login will stop managing positions. Active server permissions and agent memory are removed; re-signing does not restore that memory. This does not close or sell positions, withdraw assets, or revoke permissions on-chain.</p>
      <button type="button" className="perps-stop-all-button" disabled={sending} onClick={() => void stop()}>{sending ? "Stopping…" : "Stop all agents now"}</button>
      <button type="button" disabled={sending} onClick={() => setReview(null)}>Cancel</button>
    </section>}
    {message && <p className="perps-notice" role="status">{message}</p>}
  </section>;
}
