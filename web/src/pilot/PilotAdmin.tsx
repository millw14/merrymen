"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SignIn } from "../terminal/HostedControls";
import { SignOut } from "../terminal/SignOut";
import { requestJson } from "../terminal/request-json";
import { fullDateTime } from "../lib/format";
import { isOwner, PILOT_ADMIN_URL, parsePilotAdmin, parsePilotInvite, pilotError, type PilotAdminAction, type PilotAdminData, type PilotInvite } from "./pilot-client";
import { usePilotAccess } from "./usePilotAccess";
import { PilotFrame } from "./PilotFrame";

interface Review { tenant: string; action: PilotAdminAction; label: string }
export function PilotAdmin() {
  const session = usePilotAccess();
  const [data, setData] = useState<PilotAdminData | null>(null), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [owner, setOwner] = useState(""), [filter, setFilter] = useState(""), [uses, setUses] = useState("1"), [days, setDays] = useState("7");
  const [reload, setReload] = useState(0);
  const [review, setReview] = useState<Review | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<{ tenant: string; code: string; invite: PilotInvite } | null>(null);
  const flight = useRef(false), mounted = useRef(false), reads = useRef(0);
  const current = useRef(session.access); current.current = session.access;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current++; }; }, []);
  const tenant = session.access?.admin ? session.access.tenant : null;
  const revision = session.access?.revision;
  useEffect(() => { setCreated(null); setOwner(""); setFilter(""); }, [tenant]);
  useEffect(() => {
    const id = ++reads.current;
    setData(null); setReview(null); setError(""); setMessage("");
    if (!tenant) { setLoading(false); return; }
    const guard = session.guard(tenant); setLoading(true);
    void (async () => {
      const parsed = parsePilotAdmin(await requestJson(PILOT_ADMIN_URL), tenant);
      await guard.verify(); guard.assertCurrent();
      if (mounted.current && reads.current === id) setData(parsed);
    })().catch(e => { if (mounted.current && reads.current === id) setError(pilotError(e)); })
      .finally(() => { if (mounted.current && reads.current === id) setLoading(false); });
    return () => { reads.current++; };
  }, [tenant, revision, reload, session.guard]);

  const visible = data?.tenant === tenant ? data : null;
  function ask(action: PilotAdminAction, label: string) {
    if (!visible || !tenant || busy) return;
    setError(""); setMessage(""); setReview({ tenant, action, label });
  }
  function invite(event: FormEvent) {
    event.preventDefault();
    const maxUses = Number(uses), expiresInDays = Number(days);
    if (!/^\d+$/.test(uses) || !/^\d+$/.test(days) || maxUses < 1 || maxUses > 100 || expiresInDays < 1 || expiresInDays > 30) { setError("Use 1–100 requests and an expiry of 1–30 days."); return; }
    ask({ action: "create-invite", maxUses, expiresInDays }, `Create an invitation for ${maxUses} access request${maxUses === 1 ? "" : "s"}, valid for ${expiresInDays} day${expiresInDays === 1 ? "" : "s"}?`);
  }
  function allow(event: FormEvent) {
    event.preventDefault(); const normalized = owner.trim().toLowerCase();
    if (!isOwner(normalized) || !visible) { setError("Enter the login owner wallet: 0x followed by 40 hexadecimal characters."); return; }
    ask({ action: "set-admission", owner: normalized, status: "allowed", expectedRevision: visible.revision }, `Allow paper-pilot access for ${normalized}?`);
  }
  async function confirm() {
    if (!review || flight.current || !visible || tenant !== review.tenant) return;
    const chosen = review, guard = session.guard(chosen.tenant);
    const live = () => mounted.current && current.current?.tenant === chosen.tenant && current.current.admin;
    flight.current = true; setBusy(true); setError(""); setMessage("");
    try {
      await guard.verify(); guard.assertCurrent();
      if (!live()) throw new Error("Admin access changed. Refresh before making changes.");
      const result = await requestJson<unknown>(PILOT_ADMIN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedTenant: chosen.tenant, ...chosen.action }) });
      guard.assertCurrent(); await guard.verify(); guard.assertCurrent();
      if (!live()) return;
      if (chosen.action.action === "create-invite") {
        const raw = result as { code?: unknown; invite?: unknown } | null;
        if (!raw || typeof raw.code !== "string" || !raw.code || raw.code.length > 256) throw new Error("The invitation may have been created, but its code was not received. Refresh the list before creating another.");
        setCreated({ tenant: chosen.tenant, code: raw.code, invite: parsePilotInvite(raw.invite) });
        setMessage("Invitation created. Save the code now; it is not returned by the list.");
      } else {
        if ((result as { ok?: unknown } | null)?.ok !== true) throw new Error("The change was not confirmed. Refresh before trying again.");
        setMessage(chosen.action.action === "revoke-invite" ? "Invitation revoked. Submitted requests and existing admissions are unchanged." : "Admission updated. Permission signing and entry enablement remain owner actions.");
      }
      const refreshed = parsePilotAdmin(await requestJson(PILOT_ADMIN_URL), chosen.tenant);
      guard.assertCurrent(); await guard.verify(); guard.assertCurrent();
      if (live()) setData(refreshed);
    } catch (e) {
      if (live()) setError(`${pilotError(e)} The action was not automatically retried. Refresh to check its outcome.`);
    } finally { flight.current = false; if (mounted.current) { setBusy(false); setReview(null); } }
  }
  const admissions = visible?.admissions.filter(row => row.owner.includes(filter.trim().toLowerCase())) ?? [];
  return <PilotFrame><p className="pilot-eyebrow">Administration</p><h1>Paper pilot access</h1><p className="pilot-intro">Review requests and choose which login owner wallets may join. Invitations only submit requests; approval is separate from wallet permissions and entry settings.</p>
    {session.state === "loading" && <p role="status">Checking admin access…</p>}
    {session.state === "signed-out" && <section className="pilot-card"><h2>Sign in as an administrator</h2><SignIn onDone={session.refresh}/></section>}
    {session.state === "error" && <p role="alert">{session.error}</p>}
    {session.access && !session.access.admin && <section className="pilot-card"><h2>Admin access is required</h2><p>This account cannot view or change the pilot list.</p><a href="/perps/join">Check your access request</a></section>}
    {session.access && <div className="pilot-account"><p>Signed in as <code>{session.access.tenant}</code></p><SignOut onStart={() => { session.invalidate(); setData(null); setCreated(null); setReview(null); }} after={session.refresh} onError={setError}/></div>}
    <button disabled={busy || loading} onClick={() => { session.refresh(); setReload(value => value + 1); }}>{loading ? "Loading pilot records…" : "Refresh access"}</button>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {visible && <><p>{visible.admissions.filter(row => row.status === "allowed").length} of {visible.capacity} admission slots used. Worker capacity is managed separately.</p>
      <section className="pilot-card" aria-label="Pending requests"><h2>Pending requests</h2><p>{visible.requests.length} of {visible.requestLimit} review queue places used. Requests do not reserve admission slots. Use Refresh access to check for new requests.</p>
        <div className="pilot-table-wrap"><table><thead><tr><th>Owner</th><th>Submitted</th><th>Invitation</th><th>Review</th></tr></thead><tbody>{visible.requests.map(row => <tr key={row.owner}><th scope="row"><code>{row.owner}</code></th><td>{fullDateTime(row.submittedAt)}</td><td><code>{row.inviteId}</code></td><td><div className="pilot-actions"><button disabled={busy} onClick={() => ask({ action: "set-admission", owner: row.owner, status: "allowed", expectedRevision: visible.revision }, `Approve paper-pilot access for ${row.owner}?`)}>Approve</button><button disabled={busy} onClick={() => ask({ action: "set-admission", owner: row.owner, status: "revoked", expectedRevision: visible.revision }, `Reject the request from ${row.owner}? Another invitation cannot override this decision.`)}>Reject</button></div></td></tr>)}</tbody></table></div>
        {!visible.requests.length && <p>No requests awaiting review.</p>}<p>Approval lets the owner review a paper permission. Entries remain off until the owner enables them.</p>
      </section>
      <div className="pilot-columns"><section className="pilot-card"><h2>Create an invitation</h2><p>A code submits a request for review. It does not approve access.</p><form onSubmit={invite}><label htmlFor="invite-uses">Maximum requests</label><input id="invite-uses" inputMode="numeric" value={uses} disabled={busy} onChange={e => setUses(e.target.value)}/><label htmlFor="invite-days">Expires after days</label><input id="invite-days" inputMode="numeric" value={days} disabled={busy} onChange={e => setDays(e.target.value)}/><button disabled={busy}>Review invitation</button></form></section>
      <section className="pilot-card"><h2>Allow an owner wallet</h2><p>Use the login owner address, not its Spot or Perps smart-account address.</p><form onSubmit={allow}><label htmlFor="pilot-owner">Login owner wallet</label><input id="pilot-owner" autoComplete="off" autoCapitalize="none" spellCheck={false} value={owner} disabled={busy} onChange={e => setOwner(e.target.value)}/><button disabled={busy || !owner.trim()}>Review wallet access</button></form></section></div>
      {created?.tenant === tenant && <section className="pilot-card" aria-label="New invitation"><h2>Save this invitation code</h2><p>Shown only now. Share it privately with the intended participants.</p><code className="pilot-code">{created.code}</code><p>Expires {fullDateTime(created.invite.expiresAt)}.</p><button onClick={() => setCreated(null)}>Hide code</button></section>}
      <section className="pilot-card"><h2>Owner wallets</h2><label htmlFor="pilot-filter">Filter by wallet address</label><input id="pilot-filter" value={filter} onChange={e => setFilter(e.target.value)}/><div className="pilot-table-wrap"><table><thead><tr><th>Owner</th><th>Access</th><th>Updated</th><th>Action</th></tr></thead><tbody>{admissions.map(row => <tr key={row.owner}><th scope="row"><code>{row.owner}</code></th><td>{row.status}</td><td>{fullDateTime(row.updatedAt)}</td><td><button disabled={busy} onClick={() => ask({ action: "set-admission", owner: row.owner, status: row.status === "allowed" ? "revoked" : "allowed", expectedRevision: visible.revision }, `${row.status === "allowed" ? "Remove" : "Restore"} pilot access for ${row.owner}?`)}>{row.status === "allowed" ? "Remove access" : "Restore access"}</button></td></tr>)}</tbody></table></div>{!admissions.length && <p>No matching owner wallets.</p>}<p>Removing access stops new entries on worker refresh. Existing recovery remains available; storage failures hold the worker until entries-off can be delivered.</p></section>
      <section className="pilot-card"><h2>Invitations</h2><div className="pilot-table-wrap"><table><thead><tr><th>Reference</th><th>Requests</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead><tbody>{visible.invites.map(row => <tr key={row.id}><th scope="row"><code>{row.id}</code></th><td>{row.uses} / {row.maxUses}</td><td>{fullDateTime(row.expiresAt)}</td><td>{row.revoked ? "Revoked" : row.expiresAt <= Date.now() ? "Expired" : row.uses >= row.maxUses ? "Used" : "Active"}</td><td><button disabled={busy || row.revoked} onClick={() => ask({ action: "revoke-invite", id: row.id }, "Revoke this invitation? Submitted requests remain in the review queue and approved accounts keep their access.")}>Revoke invite</button></td></tr>)}</tbody></table></div>{!visible.invites.length && <p>No invitations created yet.</p>}</section>
    </>}
    {review && review.tenant === tenant && <section className="pilot-confirm" role="region" aria-label="Confirm pilot change"><h2>{review.label}</h2><p>No grant will be signed and no trade will be placed.</p><div className="pilot-actions"><button className="flow-primary" disabled={busy} onClick={() => void confirm()}>{busy ? "Saving…" : "Confirm change"}</button><button disabled={busy} onClick={() => setReview(null)}>Cancel</button></div></section>}
  </PilotFrame>;
}
