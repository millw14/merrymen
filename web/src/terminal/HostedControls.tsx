"use client";

import { useEffect, useState } from "react";
import { toHex } from "viem";
import { findInjectedProvider, requestAccount } from "@/lib/wallet";
import { RecoverPanel } from "@/components/RecoverPanel";
import { loadGrant } from "@/lib/session";
import { X } from "lucide-react";
import { PrivySignIn } from "@/terminal/PrivySignIn";
import { announceSignedIn } from "@/lib/resign-anchor";
import { privyEnabled } from "@/lib/privy-client";
import { blockerAdvice } from "@/lib/live-blocker";
import { ENERGY, RISK_LEVELS, RISK_PROFILES, levelOf, type EnergyStatus, type RiskLevel } from "@merrymen/core";
import { count, usd } from "@/lib/format";
import { energyRemedies, energyView } from "./energy-view";
import type { GrantBalances } from "@/lib/grant-balances";
import { requestJson } from "./request-json";
import { SkeletonRows } from "./Skeleton";
import type { ReadState } from "./live";

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
   * is the simulated balance in paper mode, which is the whole confusion. Each
   * field is null when that read failed — never "0", which is an empty account.
   */
  /**
   * `workerAliveAt` and `grant.grantedAt` travel together for ONE comparison:
   * whether the blocker on this row was resolved against a key the owner has
   * since replaced. Both were already on the wire from /api/grants and were
   * simply not declared here, so the shell could not see them.
   *
   * They come from the same response but not the same source — `grantedAt` from
   * the grant store the POST writes synchronously, `workerAliveAt` from the
   * mirrored `agents` row that also carries `liveBlocker`. That pairing is what
   * makes the comparison sound: the blocker and the beat are the same row.
   *
   * `energy` is the worker's own report of what the agent may start on its own
   * today (AgentStatus.energy). Null or absent is "not said yet", never an
   * empty allowance and never a zero balance.
   */
  status: {exists: boolean; /** Authenticated tenant bound to hosted /api/grants responses. */ tenant?: string | null; mode?: "paper" | "live" | "idle" | null; liveBlocker?: string | null; workerAliveAt?: number | null; gasSponsored?: boolean | null; balances?: GrantBalances; energy?: EnergyStatus | null; grant?: {smartAccount: string; chainId:number; caps:{perTradeUsdg:number; dailyUsdg:number}; expiresAt?:number; grantedAt?:number}};
}
// Moved to its own module so it can be executed in a test; re-exported so no import moves.
export { requestJson } from "./request-json";
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
  // Announced as well as reported: a screen that loaded signed-out (the grant
  // page, reached from a "Sign now" link) reloads as the owner — see
  // resign-anchor.ts.
  const done=()=>{announceSignedIn();onDone();};
  if (PRIVY_BETA) return <PrivySignIn onDone={done}/>;
  return <WalletSignIn onDone={done}/>;
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
/**
 * WHERE THE OWNER'S OWN AGENT WOULD BE, before there is one to show.
 *
 * THREE ANSWERS PER READ, NOT ONE. `account` is null both while the first read
 * is in flight and after it failed, and both said "Loading your account…" — so
 * a failed read said loading for ever, with nothing to press. And an owner whose
 * book was still in flight was told "Your portfolio data is not available yet",
 * a verdict about a request that had not answered. Loading draws a skeleton,
 * which claims nothing; failed says so and offers Try again; only a read that
 * succeeded may say what it found.
 *
 * `portfolio` is `live.reads.mine` — the feed read that carries the book.
 *
 * `retrying` is a pass already running. The failure stays true until a read
 * succeeds, so without it "We couldn't load your account" stood unchanged
 * through the retry the reader had just asked for, and Try again looked broken.
 */
export function AccountEntry({account,accountFailed=false,portfolio="ok",retrying=false,onRefresh,onSignedIn}:{account:AccountState|null;accountFailed?:boolean;portfolio?:ReadState;retrying?:boolean;onRefresh:()=>void;onSignedIn:()=>void}) {
  if(account?.status.exists) {
    if(portfolio==="unread") return <section className="hosted-entry"><h2>Your agent</h2><SkeletonRows rows={2} label="Loading your portfolio"/></section>;
    if(portfolio==="unreadable") return <section className="hosted-entry"><h2>Your agent</h2><p role="status">{retrying ? "Trying to load your portfolio again…" : <>We couldn&apos;t load your portfolio. It will retry on its own.</>}</p><RetryButton retrying={retrying} onRetry={onRefresh}/></section>;
    return <section className="hosted-entry"><h2>Your agent</h2><p>Your portfolio data is not available yet.</p><button className="flow-primary" onClick={onRefresh}>Refresh portfolio</button></section>;
  }
  if(!account || (accountFailed && !account.status.exists)) return accountFailed
    ? <section className="hosted-entry"><h2>Your agent</h2><p role="status">{retrying ? "Trying to load your account again…" : <>We couldn&apos;t load your account. It will retry on its own.</>}</p><RetryButton retrying={retrying} onRetry={onRefresh}/></section>
    : <section className="hosted-entry"><SkeletonRows rows={2} label="Loading your account"/></section>;
  return <section className="hosted-entry"><h2>Your agent starts here</h2><p>Create an agent to manage your portfolio and follow its trades here.</p>{account.session.hosted && !account.session.address ? <SignIn onDone={onSignedIn}/> : <a className="flow-primary" href="/create">Create an agent</a>}</section>;
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
    })()}<EnergyFunding energy={account.status.energy} chainId={grant.chainId}/><label>Agent account</label><p className="funding-address">{grant.smartAccount}</p><button className="flow-primary" onClick={()=>{void navigator.clipboard.writeText(grant.smartAccount).then(()=>setCopied(true)).catch(()=>setError("Could not copy. Select the address above to copy it."));}}>{copied ? "Address copied" : "Copy deposit address"}</button>{error && <p role="alert">{error}</p>}<a className="flow-secondary" href="/grant">Wallet setup and funding details</a></> : <a href="/grant">Set up an agent wallet</a>}</section>;
}

/**
 * ENERGY, ON THE SCREEN WITH THE ADDRESS IT IS ABOUT.
 *
 * This is where an owner arrives from "How to top up" on the desk, from the
 * chat's open-deposit, and — through its /deposit WebView — from Android. So
 * it says the same thing the desk says, from the same worker report, in the
 * owner's voice rather than the agent's: where the account stands, what full
 * strength needs, and the two routes to it, each only where it would work.
 *
 * WHAT IT LEAVES OUT. Nothing about the token's price or returns — $MERRYMEN
 * here is capacity. No fee or tax percentage, which the token's owner can
 * change without a line of our code changing. And on another network, not
 * "send it here": tokens sent to this account there would not count.
 *
 * Shown only while the deployment is gating and the agent is below full, for
 * the reported UTC day (energyView): nothing is said about a limit that limits
 * nothing, and an unread balance is said to be unread — never 0.
 */
function EnergyFunding({energy,chainId}:{energy:EnergyStatus|null|undefined;chainId:number}) {
  const view=energyView(energy,Date.now()/1000);
  if(view.kind==="none") return null;
  const remedies=energyRemedies(energy,chainId);
  const full=count(ENERGY.fullTokens);
  // "Couldn't read" ONLY for a read that failed. No wallet that counts (none
  // linked, or it already powers another account) is a knowable nothing, and
  // pointing the owner at an outage that does not exist sends them the wrong way.
  const standing=view.kind==="unread"
    ? "we couldn't read the $MERRYMEN balances — that's our read failing, not your wallet"
    : view.total!==null
      ? view.noWallet
        ? `this account holds ${count(view.total)} $MERRYMEN, ${count(view.short)} short — no wallet of yours counts toward it`
        : `your wallet and this account hold ${count(view.total)} $MERRYMEN between them, ${count(view.short)} short`
      : view.readFailed
        ? "we couldn't read every $MERRYMEN balance just now, so we can't say how far short"
        : "no wallet of yours counts toward it yet";
  const route=!remedies.sendToAgent
    ? `This account is on another network, so $MERRYMEN sent to it would not count — keep ${full} on Robinhood Chain in your own wallet.`
    : remedies.usdg==="ready"
      ? "Send $MERRYMEN on Robinhood Chain to this same address, or send USDG here and ask your agent in chat to get its $MERRYMEN — you confirm the amount first."
      : remedies.usdg==="paper"
        ? "Send $MERRYMEN on Robinhood Chain to this same address. Your agent is in Paper mode, so it won't spend real USDG on it — turn on Live trading first if you'd rather it got them itself."
        : remedies.usdg==="resign"
          ? "Send $MERRYMEN on Robinhood Chain to this same address, or send USDG here, renew your agent's permission (revocation requires network fees — its current key can't buy it), then ask it in chat to get its $MERRYMEN."
          : "Send $MERRYMEN on Robinhood Chain to this same address.";
  return <><p className="fund-energy" role="status">Energy{view.spent ? " — spent for today, back at 00:00 UTC" : ""}: {standing}. Full strength needs {full} $MERRYMEN between your wallet and this account; below that your agent gets about a tenth of a standard day's AI reviews and new trades. Stop-losses, take-profits and your own orders are never limited; its own AI reviews — including of its open positions — are paced along with the rest.</p><p>{route} Or change nothing — it carries on at this pace.</p></>;
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
  return <section className="hosted-entry money-flow"><header className="flow-top"><h2>Trading limits</h2><button aria-label="Close limits" onClick={onClose}><X size={18}/></button></header><RiskBar onDone={()=>{}}/><dl className="fund-breakdown"><div><dt>Per trade</dt><dd>{caps ? usd(caps.perTradeUsdg) : "—"}</dd></div><div><dt>Per day</dt><dd>{caps ? usd(caps.dailyUsdg) : "—"}</dd></div></dl><p>Changing these limits requires a new signature for your agent’s trading permission.</p><a className="flow-primary" href="/grant">Edit signed limits</a><a className="flow-secondary" href="/settings">Strategy and account settings</a></section>;
}

/** Try again — and, while that retry is running, a button that says so and cannot be pressed twice. */
export function RetryButton({retrying,onRetry}:{retrying:boolean;onRetry:()=>void}) {
  return <button className="flow-primary" onClick={onRetry} disabled={retrying}>{retrying ? "Trying again…" : "Try again"}</button>;
}
