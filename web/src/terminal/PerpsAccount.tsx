"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LIGHTER_ROUTE_V1, perpsNumberOk } from "@merrymen/core";
import type { PerpsAccountResponse } from "@/lib/perps-account";
import { FundingPanel, SignIn, type AccountState } from "./HostedControls";
import { realCashOf } from "./account-read";
import { deskPerpsOf, type DeskPerps } from "./live";

type Props = {
  account: AccountState | null; ownerKey: string | null; perps: DeskPerps | null | undefined;
  signOut?: ReactNode; onRefreshAccount: () => void; onCreate: () => void; onPermission: () => void; onProfile: (slug: string) => void;
};
type Budget = { owner: string | null; value: number };
const amount = (v: number | null) => v === null ? "Unavailable" : `${v.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDG`;

class AccountIdentityError extends Error {}
function accountResponse(raw: unknown): PerpsAccountResponse {
  if (!raw || typeof raw !== "object") throw new AccountIdentityError();
  const r = raw as PerpsAccountResponse;
  if (!["ready", "unread", "not-configured"].includes(r.state) ||
      !(r.owner === null || typeof r.owner === "string") || !Number.isFinite(r.generatedAtMs) ||
      !(r.perps === null || Array.isArray(r.perps)) ||
      !(r.perpsAccount === null || (typeof r.perpsAccount === "object" && ["ok", "unreadable"].includes(r.perpsAccount.state)))) throw new AccountIdentityError();
  if (r.account !== null) {
    const a = r.account;
    if (!a || typeof a.smartAccount !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(a.smartAccount) ||
        typeof a.agentId !== "string" || a.agentId.toLowerCase() !== a.smartAccount.toLowerCase() ||
        !Number.isSafeInteger(a.chainId) || a.chainId < 1 ||
        (a.profile !== undefined && (!a.profile || typeof a.profile !== "object" ||
          (a.profile.slug !== undefined && typeof a.profile.slug !== "string"))) ||
        (a.collateral !== null && (!a.collateral || a.collateral.symbol !== "USDG" || a.collateral.decimals !== 6 ||
          a.chainId !== LIGHTER_ROUTE_V1.chainId || a.collateral.address?.toLowerCase() !== LIGHTER_ROUTE_V1.usdg.toLowerCase()))) throw new AccountIdentityError();
  }
  return r;
}

/** Remount all owner-local state and abort outstanding reads when identity changes. */
export function PerpsAccount(props: Props) {
  return <AccountBody key={`${props.ownerKey ?? "signed-out"}:${props.account?.session.address ?? "local"}:${props.account?.status.grant?.smartAccount ?? "none"}:${props.account?.status.grant?.chainId ?? "none"}:${props.account?.session.hosted ?? "unknown"}:${props.account?.status.exists ?? "unknown"}`} {...props}/>;
}
function AccountBody({ account, ownerKey, signOut, onCreate, onPermission, onProfile, onRefreshAccount }: Props) {
  const [data, setData] = useState<PerpsAccountResponse | null>(null);
  const [fresh, setFresh] = useState(false);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [funding, setFunding] = useState<"deposit" | "withdraw" | null>(null);
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const hosted = account?.session.hosted !== false;
  const expectedOwner = hosted ? account?.session.address?.toLowerCase() : null;
  const ownerMatches = (owner: unknown) => hosted ? typeof owner === "string" && owner.toLowerCase() === expectedOwner : owner === null;
  const address = account?.status.grant?.smartAccount;
  async function request(url: string, init?: RequestInit) {
    const signal = controller.current ? AbortSignal.any([controller.current.signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000);
    const res = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store", signal });
    if (res.status === 401 || res.status === 403) throw new AccountIdentityError();
    if (!res.ok) throw new Error("Request unavailable");
    return res.json();
  }
  function failed(error: unknown, message: string) {
    if (!mounted.current || controller.current?.signal.aborted) return;
    setFresh(false); setBudget(null); setFunding(null);
    if (error instanceof AccountIdentityError) setData(null);
    setNote(message);
  }
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController(); controller.current = abort;
    setFresh(false); setBudget(null); setFunding(null);
    async function read() {
      let accountRead = false;
      try {
        const value = accountResponse(await request("/api/perps/account"));
        if (!ownerMatches(value.owner)) throw new AccountIdentityError();
        if (value.account && (value.account.smartAccount.toLowerCase() !== address?.toLowerCase() || value.account.chainId !== account?.status.grant?.chainId)) throw new AccountIdentityError();
        if (!mounted.current || abort.signal.aborted) return;
        setData(value); accountRead = true;
        const s = await request("/api/settings");
        if (!ownerMatches(s?.owner)) throw new AccountIdentityError();
        const n = s.values?.perpsMaxCollateralUsdg ?? s.defaults?.perpsMaxCollateralUsdg;
        if (typeof n !== "number" || !perpsNumberOk("perpsMaxCollateralUsdg", n)) throw new Error("Allocation unread");
        if (mounted.current && !abort.signal.aborted) {
          setBudget({ owner: s.owner, value: n }); setDraft(String(n)); setFresh(true);
        }
      } catch (error) { if (!abort.signal.aborted) failed(error, accountRead ? "Allocation unread. Account controls are disabled until a verified refresh." : "Could not verify this account. Previous information is stale; refresh to try again."); }
    }
    if (account && (!hosted || account.session.address)) void read();
    return () => { mounted.current = false; abort.abort(); };
    // A changed identity remounts this component; refresh intentionally rereads both snapshots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);
  const verified = !!data?.account && data.account.smartAccount.toLowerCase() === address?.toLowerCase();
  const supported = fresh && data?.account?.chainId === 4663 && data.account.collateral !== null;
  const view = data && data.perpsAccount?.state !== "unreadable" ? deskPerpsOf({ perps: data.perps, perpsAccount: data.perpsAccount }, Date.now()) : null;
  const venueValue = fresh && view?.read === "ok" && view.book === "live" && view.venueRead && !view.stale ? view.atLighterUsd : null;
  async function saveBudget() {
    const n = draft.trim() ? Number(draft) : NaN;
    if (!fresh || !verified || !budget || !perpsNumberOk("perpsMaxCollateralUsdg", n)) { setNote("Enter a valid USDG allocation within the supported limits."); return; }
    setBusy(true); setNote("");
    try {
      await request("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: budget.owner, perpsMaxCollateralUsdg: n }) });
      const s = await request("/api/settings");
      if (!ownerMatches(s?.owner)) throw new AccountIdentityError();
      if (s.values?.perpsMaxCollateralUsdg !== n) throw new Error("readback");
      if (mounted.current) { setBudget({ owner: s.owner, value: n }); setNote("Allocation limit saved. No funds were transferred and trading permissions did not change."); }
    } catch (error) { failed(error, "Could not confirm the allocation limit. Account controls are disabled until a verified refresh."); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section className="perps-account" aria-label="Perpetuals account">
    <header><div><p className="perps-account-eyebrow">YOUR ACCOUNT</p><h1>Agent USDG wallet</h1></div>{signOut}</header>
    <p>Your main app login owns this account. Existing Spot users share the on-chain agent wallet; the Perps venue account and its allocation limit are separate.</p>
    {!account ? <p>Reading session…</p> : (hosted && !account.session.address) ? <SignIn onDone={onRefreshAccount}/> : !account.status.exists ? <button onClick={onCreate}>Create an agent wallet</button> : !verified ? <p>Verifying your account…</p> : <>
      <div className="perps-account-balances"><article><span>Wallet USDG</span><strong>{amount(fresh ? realCashOf(account) : null)}</strong><small>On-chain funds. Paper balances are excluded.</small></article>
      <article><span>Real venue equity</span><strong>{amount(venueValue)}</strong><small>Includes collateral, position margin, unrealized P&amp;L and funds in transit. {view?.book === "paper" ? "Current report is simulated." : view?.stale ? "Venue report is stale." : ""}</small></article></div>
      <dl><dt>Network</dt><dd>{data.account!.chainId === 4663 ? "Robinhood Chain · 4663" : `Chain ${data.account!.chainId}`}</dd><dt>Agent wallet address</dt><dd className="perps-account-address">{data.account!.smartAccount}</dd></dl>
      <div className="perps-account-actions"><button disabled={!supported} onClick={() => setFunding("deposit")}>Add USDG</button><button disabled={!fresh} onClick={() => setFunding("withdraw")}>Withdraw / recover</button><button onClick={onPermission}>Trading permissions</button>{data.account?.profile?.slug && <button onClick={() => onProfile(data.account!.profile!.slug!)}>View profile</button>}</div>
      {funding && fresh && (funding !== "deposit" || supported) && <FundingPanel key={`${address}:${funding}`} mode={funding} account={account} onClose={() => { setFunding(null); onRefreshAccount(); }}/>}
      {!fresh && <p>Account information is stale or incomplete. Funding and allocation controls are disabled.</p>}{fresh && !supported && <p>USDG deposits are unavailable on this account’s network.</p>}
      <form onSubmit={e => { e.preventDefault(); void saveBudget(); }}><h2>Maximum Perps allocation</h2><p>This is a collateral ceiling, not a transfer amount. The agent posts USDG as eligible trades need margin, within your signed limits. Lowering it does not withdraw existing collateral.</p><label htmlFor="perps-allocation">USDG allocation limit</label><div className="perps-account-actions"><input id="perps-allocation" inputMode="decimal" value={draft} disabled={!fresh || !budget || busy} onChange={e => setDraft(e.target.value)}/><button disabled={!fresh || !budget || busy}>{busy ? "Saving…" : "Save allocation limit"}</button></div></form>
    </>}
    {note && <p role="status">{note}</p>}<button disabled={busy} onClick={() => { setNote(""); setFresh(false); setBudget(null); setFunding(null); onRefreshAccount(); setRevision(v => v + 1); }}>Refresh account</button>
  </section>;
}
