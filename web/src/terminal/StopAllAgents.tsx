"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { clearGrant, loadGrant } from "../lib/session";
import { markPermissionForReplacement } from "../lib/permission-replacement";
import { requestJson } from "./request-json";

/** The signed-in login, as the Perps account read reports it (AccountState.session). */
export type StopAllSession = { hosted: boolean; address: string | null };

const loginOf = (s: StopAllSession) => `${s.hosted}:${s.address?.toLowerCase() ?? ""}`;
const UNCONFIRMED = "Check your agents before asking again.";

/**
 * THE STOP FENCE, ONE PER TAB. A sent stop outlives the screen that sent it:
 * that screen can remount while the stop is pending (an in-place navigation,
 * an account re-check), and a stop pressed on the desk covers the wallet page
 * too. A screen that can arm a permission reads this, never its own state.
 * - pending: stops sent and not yet answered. Nothing is armed meanwhile.
 * - generation: moves when a stop is sent and when it is answered. A flow
 *   begun under an older generation is void.
 * - revision: moves when a confirmed stop cleared this browser's copies.
 * - answer: the last stop's sentence, for the login it was sent for, at the
 *   generation that answered it: shown only by a screen that was mounted
 *   while that stop was pending, never by one opened after it.
 */
export type StopFence = { pending: number; generation: number; revision: number; answer: { login: string; text: string; generation: number } | null };
const NO_STOPS: StopFence = { pending: 0, generation: 0, revision: 0, answer: null };
let fence = NO_STOPS;
const listeners = new Set<() => void>();
const stoppedKeys = new Set<string>();
function setFence(next: Partial<StopFence>) {
  fence = { ...fence, ...next };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const currentStopFence = () => fence;
export const useStopFence = () => useSyncExternalStore(subscribe, currentStopFence, currentStopFence);
/**
 * A Perps key the owner asked to stop is never offered for activation again:
 * held for this tab, and in the replacement journal (permission-replacement.ts)
 * so a reload or another tab refuses it too. A lost answer may have killed it.
 * Renewal, which mints a new key, stays open.
 */
export function rememberStopped(grant: { smartAccount: string; chainId: number; sessionKeyAddress: string } | null | undefined) {
  if (!grant?.sessionKeyAddress) return;
  stoppedKeys.add(grant.sessionKeyAddress.toLowerCase());
  try { markPermissionForReplacement(grant); } catch { /* this tab still holds it */ }
}
export const wasStopped = (sessionKey: string) => stoppedKeys.has(sessionKey.toLowerCase());
/** This browser's Perps copy, whatever it holds: the one key a stop can see from any screen. */
function rememberLocalPerps() {
  try { rememberStopped(loadGrant("perps")); } catch { /* an unreadable slot offers nothing to activate */ }
}
export function resetStopFenceForTest() { fence = NO_STOPS; stoppedKeys.clear(); }

/**
 * THE LOGIN-WIDE KILL, ON THE PERPS SCREENS. DELETE /api/grants with purpose
 * "delete-agent" and no wallet stops every wallet the login has: Spot, Perps
 * and Solana (grants route DELETE). The Spot screen offers it only beside a
 * Spot grant, so an owner with only a Perps wallet had no way to send it from
 * the web; the phones gained the same button for that owner in #373.
 *
 * Behind no offering or pilot gate, and fenced on the login alone: a wallet
 * read that fails never disables it (the screen's session is used while it
 * has one, and this asks the session route itself while it has none). One
 * reviewed press sends it once, bound to the login that was reviewed
 * (expectedTenant: the server refuses another). A lost or unconfirmed answer
 * is reported and never retried. A stop already pending never disables
 * another. Renders nothing for a signed-out visitor.
 */
export function StopAllAgents({ session: confirmed, onSend, onDone }: {
  session: StopAllSession | null;
  /** Called as the stop is sent, before its answer: the screen adds what it shows to the fence. */
  onSend?: () => void;
  /** Called once the stop is confirmed. */
  onDone?: () => void;
}) {
  const [own, setOwn] = useState<StopAllSession | null>(null);
  const [ownFailed, setOwnFailed] = useState(false);
  const [ownRevision, setOwnRevision] = useState(0);
  useEffect(() => {
    if (confirmed) return;
    let active = true;
    setOwn(null); setOwnFailed(false);
    requestJson<Partial<StopAllSession>>("/api/auth/session").then((value) => {
      if (!active) return;
      if (typeof value?.hosted === "boolean") setOwn({ hosted: value.hosted, address: typeof value.address === "string" ? value.address : null });
      else setOwnFailed(true);
    }).catch(() => { if (active) setOwnFailed(true); });
    return () => { active = false; };
  }, [confirmed === null, ownRevision]);
  const session = confirmed ?? own;
  const login = session ? loginOf(session) : null;
  const stops = useStopFence();
  /** The fence's generation when this mounted: a stop answered after it was pending while this was here. */
  const mountedAt = useRef(currentStopFence().generation);
  const [review, setReview] = useState<StopAllSession | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const current = useRef(login);
  current.current = login;
  const onFallback = useRef(false);
  onFallback.current = confirmed === null;
  /** On its own session read, a refused or lost stop reads it again: the login may have changed elsewhere. */
  const recheck = () => { if (onFallback.current) setOwnRevision((value) => value + 1); };
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
    // Shown here, and kept with the answer for a screen remounted meanwhile.
    let answer = "";
    const say = (text: string) => { answer = text; if (mounted.current) setMessage(text); };
    let cleared = false;
    // THE FENCE GOES UP BEFORE ANYTHING IS SENT, whatever the answer will be.
    rememberLocalPerps();
    setFence({ pending: fence.pending + 1, generation: fence.generation + 1, answer: null });
    try {
      onSend?.();
      let res: Response;
      try {
        res = await fetch("/api/grants", {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ purpose: "delete-agent", ...(reviewed.hosted ? { expectedTenant: reviewed.address } : {}) }),
        });
      } catch {
        say(`The stop response was not received, so it is not known whether it reached the server. ${UNCONFIRMED}`);
        recheck();
        return;
      }
      const body = await res.json().catch(() => null) as { ok?: unknown; error?: unknown } | null;
      if (!res.ok) {
        // The server's own sentence: a partial kill names what is still running.
        say(typeof body?.error === "string" && body.error ? body.error : `The service did not confirm the stop (${res.status}). ${UNCONFIRMED}`);
        recheck();
        return;
      }
      if (body?.ok !== true) {
        say(`The stop response could not be confirmed. ${UNCONFIRMED}`);
        return;
      }
      // EVERY WALLET'S BROWSER COPY, as the kill stopped every wallet: each is
      // archived (its owner key kept, session.ts clearGrant) and then cleared,
      // so no screen offers to re-arm a permission the kill just removed. Each
      // on its own, so one that cannot be cleared still leaves the other done.
      // The copy about to be cleared is remembered first: another tab may have
      // saved it while the stop was pending, and the kill was login-wide.
      rememberLocalPerps();
      const kept = (["spot", "perps"] as const).filter((wallet) => {
        try { clearGrant(wallet); return false; } catch { return true; }
      });
      cleared = true;
      say("Stop request accepted for Spot, Perps and Solana. Existing assets remain in their accounts." +
        (kept.length ? ` This browser's saved ${kept.join(" and ")} permission could not be cleared; it was kept with its recovery data. Do not re-activate it; reload before renewing.` : ""));
      onDone?.();
    } finally {
      // A copy another tab saved meanwhile is the stop's too: the kill was
      // login-wide. (This tab's flows were voided at the press.)
      rememberLocalPerps();
      const generation = fence.generation + 1;
      setFence({ pending: Math.max(0, fence.pending - 1), generation, ...(cleared ? { revision: fence.revision + 1 } : {}),
        ...(answer ? { answer: { login: loginOf(reviewed), text: answer, generation } } : {}) });
      inFlight.current = false;
      if (mounted.current) { setSending(false); setReview(null); }
    }
  }

  if (session?.hosted && !session.address) return null;
  const ready = !!session;
  // Hosted, the orchestrator also removes the agents' memory; a self-hosted kill
  // removes the permissions and leaves local history where it is.
  const hosted = session?.hosted !== false;
  const shown = message || (stops.answer && stops.answer.login === login && stops.answer.generation > mountedAt.current ? stops.answer.text : "");
  return <section className="perps-stop-all" aria-label="Stop all agents">
    <h2>Stop all agents</h2>
    <p>{hosted
      ? "Stops Spot, Perps and Solana for this login. It removes active server permissions and agent memory. It does not withdraw assets or revoke permissions on-chain."
      : "Stops Spot, Perps and Solana on this install. It removes their active permissions; local agent history is kept. It does not withdraw assets or revoke permissions on-chain."}</p>
    {!review && <button type="button" className="perps-stop-all-button" disabled={!ready || sending} onClick={() => { setMessage(""); setFence({ answer: null }); setReview(session); }}>Stop all agents</button>}
    {!ready && (ownFailed
      ? <p role="status">Your login could not be confirmed, and the stop is bound to it. <button type="button" onClick={() => setOwnRevision((value) => value + 1)}>Check again</button></p>
      : <p role="status">Confirming your login…</p>)}
    {review && <section className="perps-confirm" ref={panel} tabIndex={-1} role="region" aria-label="Confirm stopping all agents">
      <h3>Stop all agents for this login?</h3>
      {review.hosted && <p>Signed in as <code>{review.address}</code></p>}
      <p>{review.hosted
        ? "Spot, Perps and Solana for this login will stop managing positions. Active server permissions and agent memory are removed; re-signing does not restore that memory. This does not close or sell positions, withdraw assets, or revoke permissions on-chain."
        : "Spot, Perps and Solana on this install will stop managing positions. Their active permissions are removed; local agent history is kept. This does not close or sell positions, withdraw assets, or revoke permissions on-chain."}</p>
      <button type="button" className="perps-stop-all-button" disabled={sending} onClick={() => void stop()}>{sending ? "Stopping…" : "Stop all agents now"}</button>
      <button type="button" disabled={sending} onClick={() => setReview(null)}>Cancel</button>
    </section>}
    {shown && <p className="perps-notice" role="status">{shown}</p>}
  </section>;
}
