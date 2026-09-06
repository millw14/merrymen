"use client";

import { useState } from "react";
import { toHex } from "viem";
import { findInjectedProvider, requestAccount } from "@/lib/wallet";
import { RecoverPanel } from "@/components/RecoverPanel";
import { loadGrant } from "@/lib/session";
import { X } from "lucide-react";
import { PrivySignIn } from "@/terminal/PrivySignIn";
import { privyEnabled } from "@/lib/privy-client";

export interface AccountState {
  session: {hosted: boolean; address: string | null};
  status: {exists: boolean; mode?: string; grant?: {smartAccount: string; chainId:number; caps:{perTradeUsdg:number; dailyUsdg:number}; expiresAt?:number}};
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
  return <section className="hosted-funding"><header className="flow-top"><span>{mode==="deposit" ? "Add funds" : "Withdraw"}</span><button aria-label="Close funding" onClick={onClose}><X size={18}/></button></header>{mode==="withdraw" ? <RecoverPanel initialOwnerKey={ownerKey}/> : grant ? <><h2>Fund your agent</h2><p>Send USDG to your agent’s account on {grant.chainId===4663 ? "Robinhood Chain" : `chain ${grant.chainId}`}. Your balance updates after the transfer is recorded.</p><label>Agent account</label><p className="funding-address">{grant.smartAccount}</p><button className="flow-primary" onClick={()=>{void navigator.clipboard.writeText(grant.smartAccount).then(()=>setCopied(true)).catch(()=>setError("Could not copy. Select the address above to copy it."));}}>{copied ? "Address copied" : "Copy deposit address"}</button>{error && <p role="alert">{error}</p>}<a className="flow-secondary" href="/grant">Wallet setup and funding details</a></> : <a href="/grant">Set up an agent wallet</a>}</section>;
}

export function LimitsPanel({account,onClose}:{account:AccountState|null;onClose:()=>void}) {
  const caps=account?.status.grant?.caps;
  return <section className="hosted-entry money-flow"><header className="flow-top"><h2>Trading limits</h2><button aria-label="Close limits" onClick={onClose}><X size={18}/></button></header><dl className="fund-breakdown"><div><dt>Per trade</dt><dd>{caps ? `$${caps.perTradeUsdg.toFixed(2)}` : "—"}</dd></div><div><dt>Per day</dt><dd>{caps ? `$${caps.dailyUsdg.toFixed(2)}` : "—"}</dd></div></dl><p>Changing these limits requires a new signature for your agent’s trading permission.</p><a className="flow-primary" href="/grant">Edit signed limits</a><a className="flow-secondary" href="/settings">Strategy and account settings</a></section>;
}
