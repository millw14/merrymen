"use client";

import { useEffect, useState } from "react";
import { toHex } from "viem";
import { findInjectedProvider, requestAccount } from "@/lib/wallet";
import { RecoverPanel } from "@/components/RecoverPanel";
import { loadGrant } from "@/lib/session";
import { X } from "lucide-react";
import { PrivySignIn } from "@/terminal/PrivySignIn";
import { privyEnabled } from "@/lib/privy-client";
import { blockerAdvice } from "@/lib/live-blocker";
import { RISK_LEVELS, RISK_PROFILES, levelOf, type RiskLevel } from "@merrymen/core";

export interface AccountState {
  session: {hosted: boolean; address: string | null};
  /**
   * `mode` is the published rail, and it is the THREE the worker publishes —
   * not `string`. It was widened here and the widening reached `autonomyOf`,
   * which switches on it: a fourth value would have fallen out of every arm as
   * "idle" and rendered a blocked agent as merely quiet.
   *
   * `balances` is the CHAIN's answer (a multicall in /api/grants), and it is
   * the only figure that may decide whether real money exists. The book's cash
   * is the simulated balance in paper mode, which is the whole confusion.
   */
  status: {exists: boolean; mode?: "paper" | "live" | "idle" | null; liveBlocker?: string | null; balances?: {ethWei: string; cashUsdg: string; vaultUsdg: string}; grant?: {smartAccount: string; chainId:number; caps:{perTradeUsdg:number; dailyUsdg:number}; expiresAt?:number}};
}
export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {...init, cache:"no-store", signal: AbortSignal.timeout(20000)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.errors?.join(" ") || data.why || `Request failed (${response.status})`);
  return data as T;
}
/**
 * WHICH SIGN-IN THE DEPLOYMENT OFFERS.
 *
 * Inlined at build time by Next. Present means Privy is configured, and X is
 * the primary route; absent means this deployment falls back to the injected
 * wallet login exactly as before. One flag, one fork, and the legacy path is
 * never removed — it is what an existing owner still uses to prove possession
 * of their tenant before linking a DID to it.
 */
export const PRIVY_BETA = privyEnabled();

export function SignIn({onDone}:{onDone:()=>void}) {
  if (PRIVY_BETA) return <PrivySignIn onDone={onDone}/>;
  return <WalletSignIn onDone={onDone}/>;
}

/** The original injected-wallet login. Still the ONLY way an existing owner proves their tenant. */
export function WalletSignIn({onDone}:{onDone:()=>void}) {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function signIn() {
    setBusy(true);setError("");
    try {
      const provider=findInjectedProvider();
      if (!provider) throw new Error("Open this page in your wallet’s browser, or enable your browser wallet.");
      const address=await requestAccount(provider);
      const challenge=await requestJson<{nonce:string;message:string}>("/api/auth/challenge");
      const signature=await provider.request({method:"personal_sign",params:[toHex(challenge.message),address]});
      await requestJson("/api/auth/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nonce:challenge.nonce,signature})});
      onDone();
    } catch(e) {setError(e instanceof Error ? e.message : "Sign-in failed. Try again.");}
    finally {setBusy(false);}
  }
  return <div className="hosted-auth"><button className="flow-primary" disabled={busy} onClick={()=>void signIn()}>{busy ? "Waiting for wallet…" : "Sign in with wallet"}</button>{error && <p role="alert" className="flow-error">{error}</p>}</div>;
}
export function AccountEntry({account,onRefresh}:{account:AccountState|null;onRefresh:()=>void}) {
  if(account?.status.exists) return <section className="hosted-entry"><h2>Your agent</h2><p>Your portfolio data is not available yet.</p><button className="flow-primary" onClick={onRefresh}>Refresh portfolio</button></section>;
  return <section className="hosted-entry"><h2>Your agent starts here</h2><p>Create an agent to manage your portfolio and follow its trades here.</p>{!account ? <p>Loading your account…</p> : account.session.hosted && !account.session.address ? <SignIn onDone={onRefresh}/> : <a className="flow-primary" href="/create">Create an agent</a>}</section>;
}
export function FundingPanel({mode,account,onClose}:{mode:"deposit"|"withdraw";account:AccountState;onClose:()=>void}) {
  const [copied,setCopied]=useState(false);
  const [error,setError]=useState("");
  const [ownerKey]=useState(()=>{const grant=loadGrant();return grant?.smartAccount.toLowerCase()===account.status.grant?.smartAccount.toLowerCase() ? grant?.demoOwnerPrivateKey ?? "" : "";});
  const grant=account.status.grant;
  return <section className="hosted-funding"><header className="flow-top"><span>{mode==="deposit" ? "Add funds" : "Withdraw"}</span><button aria-label="Close funding" onClick={onClose}><X size={18}/></button></header>{mode==="withdraw" ? <RecoverPanel initialOwnerKey={ownerKey}/> : grant ? <><h2>Fund your agent</h2><p>Send USDG to your agent’s account on {grant.chainId===4663 ? "Robinhood Chain" : `chain ${grant.chainId}`}. Your balance updates after the transfer is recorded.</p>
    {/* WHAT THIS AGENT IS ACTUALLY SHORT OF, on the screen where it can be fixed.
        The verdict is the child's — `AgentStatus.liveBlocker`, resolved every
        tick — and this panel only says what to do about it. Measured after the
        fleet stopped being killed mid-tick: no-gas 12, wrong-chain 9,
        dead-policy 6, no-cash 2. Twelve owners were reading the line above,
        sending USDG exactly as told, and getting no trades, because the thing
        missing was ETH for fees. And where money is NOT the fix, this says so
        rather than letting a deposit address imply that it is. */}
    {(() => {
      const advice = blockerAdvice(account?.status.liveBlocker);
      if (!advice) return null;
      return (
        <p className={advice.funding ? "fund-blocker" : "fund-blocker not-money"} role="status">
          {advice.say}
        </p>
      );
    })()}<label>Agent account</label><p className="funding-address">{grant.smartAccount}</p><button className="flow-primary" onClick={()=>{void navigator.clipboard.writeText(grant.smartAccount).then(()=>setCopied(true)).catch(()=>setError("Could not copy. Select the address above to copy it."));}}>{copied ? "Address copied" : "Copy deposit address"}</button>{error && <p role="alert">{error}</p>}<a className="flow-secondary" href="/grant">Wallet setup and funding details</a></> : <a href="/grant">Set up an agent wallet</a>}</section>;
}

/**
 * HOW MUCH RISK, AS ONE QUESTION.
 *
 * From the beta: "would it be helpful for beginners to have risk level bar or
 * options rather than setting trade limit or trades per day". Right — nobody
 * arriving here has a view on 300 basis points of price impact. They have a
 * view on how much they mind losing money, and this turns that into the six
 * settings dials that follow from it.
 *
 * THE TWO CAPS BELOW ARE NOT AMONG THEM, and the panel says so rather than
 * quietly stopping at the boundary. `perTradeUsdg` and `dailyUsdg` live in the
 * signature and are enforced on-chain; no settings write can move them, which
 * is exactly why they are the limits worth having.
 */
function RiskBar({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState<RiskLevel | null>(null);
  const [busy, setBusy] = useState<RiskLevel | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<RiskLevel | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { values?: Record<string, unknown> } | null) => {
        // `levelOf` returns null for a hand-tuned book, and null is rendered as
        // nothing selected — never rounded to the nearest level, or opening this
        // screen and touching nothing would move five dials on the next save.
        if (alive) setCurrent(levelOf((s?.values ?? {}) as never));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const choose = async (level: RiskLevel) => {
    setBusy(level); setError(""); setSaved(null);
    try {
      const put = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(RISK_PROFILES[level].settings),
      });
      if (!put.ok) {
        const j = (await put.json().catch(() => null)) as { errors?: string[] } | null;
        throw new Error(j?.errors?.join(" ") ?? `that was refused (${put.status})`);
      }
      setCurrent(level); setSaved(level); onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="risk-bar">
      <h3>How much risk?</h3>
      <div className="risk-options" role="group" aria-label="Risk level">
        {RISK_LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            className={`risk-option${current === l ? " on" : ""}`}
            aria-pressed={current === l}
            disabled={busy !== null}
            onClick={() => choose(l)}
          >
            <b>{RISK_PROFILES[l].name}</b>
            <span>{RISK_PROFILES[l].blurb}</span>
          </button>
        ))}
      </div>
      {current === null && !saved && (
        <p className="risk-note">Your dials are set by hand right now — picking a level replaces them.</p>
      )}
      {saved && <p className="risk-note" role="status">Saved. {RISK_PROFILES[saved].blurb}</p>}
      {error && <p className="risk-note" role="alert">{error}</p>}
      {/* NAMED, NOT WRITTEN. See risk-level.ts. */}
      <p className="risk-note">
        This sets how I size and when I sell. The two caps below are sealed into my key and only a
        new signature can change them.
      </p>
    </div>
  );
}

export function LimitsPanel({account,onClose}:{account:AccountState|null;onClose:()=>void}) {
  const caps=account?.status.grant?.caps;
  return <section className="hosted-entry money-flow"><header className="flow-top"><h2>Trading limits</h2><button aria-label="Close limits" onClick={onClose}><X size={18}/></button></header><RiskBar onDone={()=>{}}/><dl className="fund-breakdown"><div><dt>Per trade</dt><dd>{caps ? `$${caps.perTradeUsdg.toFixed(2)}` : "—"}</dd></div><div><dt>Per day</dt><dd>{caps ? `$${caps.dailyUsdg.toFixed(2)}` : "—"}</dd></div></dl><p>Changing these limits requires a new signature for your agent’s trading permission.</p><a className="flow-primary" href="/grant">Edit signed limits</a><a className="flow-secondary" href="/settings">Strategy and account settings</a></section>;
}
