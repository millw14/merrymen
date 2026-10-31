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
  useEffect(() => {
    if (access && access.status !== "not-admitted") {
      setCode(""); setRequested(false); setMessage("");
    }
  }, [access?.status]);

  async function redeem() {
    if (!access || !identity || !requested || flight.current) return;
    setRequested(false);
    if (access.status !== "not-admitted") return;
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
      if (result.tenant !== expectedTenant || !["pending", "allowed", "revoked"].includes(result.status)) throw new Error("The request was not confirmed for this account. Refresh to check its status.");
      await guard.verify(); assertCurrent();
      setCode(""); setMessage(result.status === "pending" ? "Your request was submitted for administrator review." : result.status === "allowed" ? "This account is already approved for the paper pilot." : "Your request was reviewed and access was not approved."); session.refresh();
    } catch (error) {
      if (mounted.current && generation.current === started) setMessage(pilotError(error));
    } finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  // The only automatic write follows an explicit invitation submission. Login
  // creates its owner wallet; this POST requests review, never grants access.
  useEffect(() => { if (requested && access && identity && !busy) void redeem(); }, [requested, access?.tenant, access?.status, identity?.did, identity?.owner, busy]);

  function submit(event: FormEvent) { event.preventDefault(); if (!code.trim() || busy || requested || flight.current || access && access.status !== "not-admitted") return; requestedTenant.current = access?.tenant ?? null; setMessage(""); setRequested(true); }
  const admitted = access?.status === "allowed";
  return <PilotFrame><p className="pilot-eyebrow">Administrator approval · simulated trading</p><h1>Request paper Perps access</h1><p className="pilot-intro">Enter your invitation and sign in with email or X. We submit your account’s wallet automatically for an administrator to review. A code does not grant access.</p>
    {session.state === "loading" && <p role="status">Checking your account…</p>}
    {session.state === "error" && <div role="alert"><p>{session.error}</p><button onClick={session.refresh}>Try again</button></div>}
    {admitted ? <section className="pilot-card"><h2>{access.paperAvailable ? "Your paper access is approved" : "You’re approved. Launch is next."}</h2><p>{access.paperAvailable ? "Choose your paper permission and limits when you’re ready. Entries stay off until you enable them." : "An administrator approved your account. Paper trading is not available on this deployment yet."}</p>{access.paperAvailable && <div className="pilot-actions"><a className="flow-primary" href="/create?for=perps">Set up paper Perps</a><a href="/perps">Open paper desk</a></div>}</section>
      : access?.status === "pending" ? <section className="pilot-card" aria-label="Pending approval"><h2>Waiting for administrator approval</h2><p>Your account’s wallet is in the review queue. You do not need to submit another code. Access remains off until an administrator approves your request.</p><p>This page checks for updates automatically while it is open.</p><button onClick={session.refresh}>Check approval status</button></section>
      : access?.status === "revoked" ? <section className="pilot-card"><h2>Access is not approved</h2><p>An administrator declined your request or removed your access. Another invitation cannot override that decision. Existing recovery access remains available.</p><button onClick={session.refresh}>Check approval status</button></section>
      : <section className="pilot-card"><h2>Your invitation</h2><form onSubmit={submit}><label htmlFor="pilot-code">Invitation code</label><input id="pilot-code" name="invite" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={128} value={code} disabled={busy} onChange={event => { setCode(event.target.value); setRequested(false); }}/><button className="flow-primary" disabled={!code.trim() || busy || requested || session.state === "loading" || session.state === "error" || !signInEnabled}>{busy ? "Submitting your request…" : requested && !access ? "Sign in below to continue" : "Submit access request"}</button></form>{requested && session.state === "signed-out" && <div className="pilot-signin"><h3>Sign in or create your account</h3><SignIn onDone={session.refresh}/></div>}{requested && access && !identity && <div role="status"><p>Waiting for your protected signing wallet.</p><SignIn onDone={session.refresh}/></div>}{!signInEnabled && <p role="status">Protected sign-in is not configured here. Requests will be available when it is enabled.</p>}</section>}
    {message && <p role="status">{message}</p>}
    {access && <div className="pilot-account"><p>Signed in as <code>{access.tenant}</code></p><SignOut onStart={() => { setCode(""); setRequested(false); setMessage(""); session.invalidate(); }} after={session.refresh} onError={setMessage}/>{access.admin && <a href="/admin/perps">Manage pilot access</a>}</div>}
    <p className="pilot-note">Submitting a request does not approve access, sign a trading permission, enable entries, or move funds. After approval, you’ll review your permission and entry settings separately.</p>
  </PilotFrame>;
}
