"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { PRIVY_BETA, SignIn } from "../terminal/HostedControls";
import { SignOut } from "../terminal/SignOut";
import { usePrivyOwner } from "../terminal/usePrivyOwner";
import { requestJson } from "../terminal/request-json";
import { parsePilotAccess, pilotError } from "./pilot-client";
import { usePilotAccess } from "./usePilotAccess";
import { PilotFrame } from "./PilotFrame";

export interface PilotIdentity { did: string; owner: string; getAccessToken: () => Promise<string | null> }
export function PilotJoin() { return PRIVY_BETA ? <PrivyPilotJoin/> : <PilotJoinView identity={null} signInEnabled={false}/>; }
function PrivyPilotJoin() {
  const { authenticated, user, getAccessToken } = usePrivy();
  const signer = usePrivyOwner();
  const identity = authenticated && user?.id && signer?.did === user.id ? { did: user.id, owner: signer.account.address.toLowerCase(), getAccessToken } : null;
  return <PilotJoinView identity={identity} signInEnabled/>;
}

export function PilotJoinView({ identity, signInEnabled }: { identity: PilotIdentity | null; signInEnabled: boolean }) {
  const session = usePilotAccess();
  const [code, setCode] = useState(""), [requested, setRequested] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const flight = useRef(false), mounted = useRef(false);
  const requestedTenant = useRef<string | null>(null), previousTenant = useRef<string | null>(null);
  const authority = `${session.access?.tenant ?? ""}:${identity?.did ?? ""}:${identity?.owner ?? ""}`;
  const active = useRef(authority), generation = useRef(0);
  if (active.current !== authority) { active.current = authority; generation.current++; }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const access = session.access;
  useEffect(() => {
    const next = access?.tenant ?? null;
    if (previousTenant.current && next && previousTenant.current !== next) {
      setCode(""); setRequested(false); setMessage("Your account changed. Enter the invitation again for this account."); requestedTenant.current = null;
    }
    if (next) previousTenant.current = next;
  }, [access?.tenant]);

  async function redeem() {
    if (!access || !identity || !requested || flight.current) return;
    setRequested(false);
    if (requestedTenant.current && requestedTenant.current !== access.tenant) { setCode(""); setMessage("Your account changed. Enter the invitation again for this account."); return; }
    requestedTenant.current = access.tenant;
    if (identity.owner.toLowerCase() !== access.tenant) { setMessage("This sign-in's protected wallet does not own the account on this session. Sign out and reconnect the account you want to register."); return; }
    const selectedCode = code.trim();
    if (!selectedCode || selectedCode.length > 128) { setMessage("Enter a valid invitation code."); return; }
    const expectedTenant = access.tenant, started = generation.current;
    const guard = session.guard(expectedTenant);
    const assertCurrent = () => { guard.assertCurrent(); if (!mounted.current || generation.current !== started || active.current !== authority) throw new Error("Your account changed. Enter the invite again for the account you want to register."); };
    flight.current = true; setBusy(true); setMessage("");
    try {
      await guard.verify(); assertCurrent();
      const token = await identity.getAccessToken(); assertCurrent();
      if (!token) throw new Error("Your sign-in expired. Sign in again before using the invitation.");
      const result = parsePilotAccess(await requestJson("/api/perps/pilot/redeem?wallet=perps", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ code: selectedCode, expectedTenant }) }));
      assertCurrent();
      if (result.tenant !== expectedTenant || result.status !== "allowed") throw new Error("Admission was not confirmed for this account. Refresh to check access.");
      await guard.verify(); assertCurrent();
      setCode(""); setMessage("Your account is registered for the paper pilot."); session.refresh();
    } catch (error) {
      if (mounted.current && generation.current === started) setMessage(pilotError(error));
    } finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  // The only automatic write follows an explicit invitation submission. Login
  // creates its owner wallet; this POST only registers admission, never a grant.
  useEffect(() => { if (requested && access && identity && !busy) void redeem(); }, [requested, access?.tenant, identity?.did, identity?.owner, busy]);

  function submit(event: FormEvent) { event.preventDefault(); if (!code.trim() || busy) return; requestedTenant.current = access?.tenant ?? null; setMessage(""); setRequested(true); }
  const admitted = access?.status === "allowed";
  return <PilotFrame><p className="pilot-eyebrow">Invite-only · simulated trading</p><h1>Join the paper Perps pilot</h1><p className="pilot-intro">Use your invitation, then sign in with email or X. We connect your account’s wallet automatically.</p>
    {session.state === "loading" && <p role="status">Checking your account…</p>}
    {session.state === "error" && <div role="alert"><p>{session.error}</p><button onClick={session.refresh}>Try again</button></div>}
    {admitted ? <section className="pilot-card"><h2>{access.paperAvailable ? "Your paper access is ready" : "You’re registered. Launch is next."}</h2><p>{access.paperAvailable ? "Choose your paper permission and limits when you’re ready. Entries stay off until you enable them." : "Your account is on the list. Paper trading is not available on this deployment yet."}</p>{access.paperAvailable && <div className="pilot-actions"><a className="flow-primary" href="/create?for=perps">Set up paper Perps</a><a href="/perps">Open paper desk</a></div>}</section> : <section className="pilot-card"><h2>Your invitation</h2>{access?.status === "revoked" && <p>Your pilot access was removed. Existing recovery access remains available; an administrator must restore your admission.</p>}<form onSubmit={submit}><label htmlFor="pilot-code">Invitation code</label><input id="pilot-code" name="invite" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={128} value={code} disabled={busy} onChange={event => { setCode(event.target.value); setRequested(false); }}/><button className="flow-primary" disabled={!code.trim() || busy || requested || session.state === "loading" || session.state === "error" || !signInEnabled}>{busy ? "Registering your account…" : requested && !access ? "Sign in below to continue" : "Use invitation"}</button></form>{requested && session.state === "signed-out" && <div className="pilot-signin"><h3>Sign in or create your account</h3><SignIn onDone={session.refresh}/></div>}{requested && access && !identity && <div role="status"><p>Waiting for your protected signing wallet.</p><SignIn onDone={session.refresh}/></div>}{!signInEnabled && <p role="status">Protected sign-in is not configured here. Registration will be available when it is enabled.</p>}</section>}
    {message && <p role="status">{message}</p>}
    {access && <div className="pilot-account"><p>Signed in as <code>{access.tenant}</code></p><SignOut onStart={() => { setCode(""); setRequested(false); setMessage(""); session.invalidate(); }} after={session.refresh} onError={setMessage}/>{access.admin && <a href="/admin/perps">Manage pilot access</a>}</div>}
    <p className="pilot-note">Registration does not sign a trading permission, enable entries, or move funds. You’ll review those choices separately.</p>
  </PilotFrame>;
}
