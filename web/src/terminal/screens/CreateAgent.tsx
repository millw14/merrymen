"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff } from "lucide-react";
import {
  DEFAULT_BASKET_SYMBOLS,
  ENERGY,
  STOCK_TOKENS,
  isEnergyReserveToken,
  isValidCustomToken,
  type CustomToken,
  isWallTooWide,
} from "@merrymen/core";
import { createPrivyOwnedWallet, isPrivyOwned, loadGrant, type Grant, type GrantCaps } from "@/lib/session";
import { usePrivyOwner } from "@/terminal/usePrivyOwner";
import { verifiedAdapter } from "@/lib/verified-adapter";
import { loadRecoveryGrants, trustedSavedGrant } from "@/lib/saved-grant-binding";
import { needsPermissionReplacement } from "@/lib/permission-replacement";
import { requestJson, RetryButton, SignIn, PRIVY_BETA, type AccountState } from "../HostedControls";
import { fetchAccountForSession } from "../account-session";
import { Face } from "../ui";
import { SkeletonRows } from "../Skeleton";
import { CAP_FIELD, parseAmount } from "@/lib/parse-amount";
import type { TierView } from "@/app/api/tier/route";
import { loadTier, newAgentQualifies } from "../tier";
import { count, decimalSeparator } from "@/lib/format";
import { useT } from "@/lib/i18n";

/**
 * `circle` MARKS A STRATEGY THE WORKER WILL NOT ACTUALLY RUN FOR A NON-HOLDER.
 *
 * `even-keel` and `dip-hunter` are Merry Circle strategies
 * (worker/src/strategies/registry.ts CIRCLE_STRATEGIES). The tick gates them on
 * `holderTier.bonusStrategies` and, for anyone below Merry Man, writes ONE warn
 * event and returns — every tick, for ever.
 *
 * This list offered both with no marking at all, so the flow was: pick "Even
 * keel", read "Keep the stocks in your basket evenly weighted", sign a grant,
 * send real money, and watch an agent that never buys anything. Reported
 * exactly that way: "the agent hasn't bought automatically a single stock token
 * during all day.... I don't know if it makes sense and first buys must be done
 * by user".
 *
 * Marked rather than hidden, and still selectable: a strategy nobody can see is
 * a strategy nobody buys $MERRYMEN for, and an owner who holds it would find it
 * missing. What was wrong was letting somebody choose it without knowing.
 */
const STRATEGIES = [
  {id:"steady-basket",name:"Steady basket",description:"Buy a little of your selected stocks on a schedule."},
  {id:"even-keel",name:"Even keel",description:"Keep the stocks in your basket evenly weighted.",circle:true},
  {id:"dip-hunter",name:"Dip hunter",description:"Look for pullbacks in the stocks you follow.",circle:true},
  {id:"llm-strategist",name:"Strategist",description:"Assess the market with AI and follow its reasoning."},
];
const EXAMPLES:Record<string,string>={
  "steady-basket":"For example, buy small amounts of your selected stocks over time instead of buying everything at once.",
  "even-keel":"For example, if one stock grows to dominate your basket, adjust positions toward your target weights.",
  "dip-hunter":"For example, wait for a pullback that matches the strategy before considering an entry.",
  "llm-strategist":"For example, assess current market information, explain a proposed move, and check it against your limits.",
};
const INITIAL_CAPS: GrantCaps={perTradeUsdg:10,dailyUsdg:50,expiryDays:7,maxDrawdownPct:5,maxOpsPerDay:24};
export function CreateAgent({account,accountFailed=false,retrying=false,onRefresh,onSignedIn,onBack,onDone,onFund}:{account:AccountState|null;accountFailed?:boolean;retrying?:boolean;onRefresh:()=>void;onSignedIn:()=>void;onBack:()=>void;onDone:()=>void;onFund:(grant:Grant)=>void}) {
  const t = useT();
  const [step,setStep]=useState<"agent"|"market"|"limits"|"backup"|"fund">("agent");
  const [name,setName]=useState("");
  const [strategy,setStrategy]=useState("steady-basket");
  /**
   * WHAT IT TRADES, ASKED DURING SETUP — and the reason this step exists at all.
   *
   * The wizard never asked. A new agent got the three-symbol equity default and
   * every universe decision was deferred to Settings, where an owner then found
   * a basket "full of all stocks", added a coin, and discovered it still would
   * not trade. Asking here costs one screen and removes that whole journey.
   *
   * THE SEQUENCING WIN IS THE POINT. `create()` seals `extraTokens` into the
   * grant it mints, so a coin named HERE is covered by the FIRST signature —
   * no re-sign, no coverage banner, no "why isn't it trading". The same coin
   * added afterwards needs a second signature before it can be sold, which is
   * the `no-exit` rule and the whole reason that journey is painful.
   */
  const [assetMode,setAssetMode]=useState<"all"|"stocks"|"crypto">("all");
  const [basket,setBasket]=useState<string[]>([...DEFAULT_BASKET_SYMBOLS]);
  /** Coins added in this wizard. Merged LOCALLY into the mint — see create(). */
  const [wizardTokens,setWizardTokens]=useState<CustomToken[]>([]);
  const [newCoin,setNewCoin]=useState({symbol:"",address:"",decimals:"18"});
  const [coinError,setCoinError]=useState("");
  /**
   * THIS READER STANDING AGAINST THE RULE, not the rule.
   *
   * The badge states the requirement; it never said whether YOU meet it, which
   * is the only half that decides whether to press the button. Reported as
   * "the app should warn more eye-catching when someone has chosen a
   * holder-only strategy and don't have access to it… I had to go to
   * /api/circle to check that and that's not good for normies".
   */
  const [tier,setTier]=useState<TierView|null>(null);
  useEffect(()=>{void loadTier().then(setTier);},[]);
  // Null on a legacy session — which is what keeps an existing Merryman on
  // its existing owner key.
  const privyOwner=usePrivyOwner();
  const [paper,setPaper]=useState(true);
  const [trade,setTrade]=useState("10");
  const [day,setDay]=useState("50");
  const [ack,setAck]=useState(false);
  const [backupAck,setBackupAck]=useState(false);
  const [reveal,setReveal]=useState(false);
  const [grant,setGrant]=useState<Grant|null>(null);
  const [armed,setArmed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [status,setStatus]=useState("");
  const [error,setError]=useState("");
  const savedContext=account ? `${account.session.hosted}:${account.session.address?.toLowerCase()??""}:${account.status.exists}` : "";
  const [savedRecovery,setSavedRecovery]=useState<{context:string;grant:Grant|null;failed:boolean}|null>(null);
  async function recoverableFor(session:AccountState["session"]):Promise<Grant|null>{
    for(const candidate of [loadGrant(),...loadRecoveryGrants()]){
      if(candidate&&await trustedSavedGrant(candidate,session,window.location.origin))return candidate;
    }
    return null;
  }
  useEffect(()=>{
    let active=true;
    if(!account){setSavedRecovery(null);return;}
    setSavedRecovery(null);
    void recoverableFor(account.session).then(saved=>{
      if(active)setSavedRecovery({context:savedContext,grant:saved,failed:false});
    }).catch(()=>{if(active)setSavedRecovery({context:savedContext,grant:null,failed:true});});
    return()=>{active=false;};
  },[account,savedContext]);
  useEffect(()=>{
    if(!account?.status.grant)return;
    void requestJson<{values:{liveTradingEnabled?:boolean;agentName?:string;strategy?:string}}>("/api/settings").then(({values})=>{setPaper(!(values.liveTradingEnabled ?? false));setName(values.agentName ?? "");setStrategy(values.strategy ?? "steady-basket");}).catch(()=>{});
    const local=loadGrant();
    if(local?.smartAccount.toLowerCase()===account.status.grant.smartAccount.toLowerCase()) {
      setGrant(local);setArmed(account.status.exists);
      const saved=localStorage.getItem(`merrymen.backup.${local.smartAccount.toLowerCase()}`)==="1";
      setStep(saved ? "fund" : "backup");
    }
  },[account?.status.grant?.smartAccount]);
  useEffect(()=>{
    if(!grant || step!=="backup")return;
    const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();};
    window.addEventListener("beforeunload",guard);
    return()=>window.removeEventListener("beforeunload",guard);
  },[grant,step]);
  // A FAILED READ IS NOT A SLOW ONE. Both leave `account` null, and this line
  // said "Loading your account…" for either — for ever, after a failure, with
  // nothing to press. See AccountEntry.
  if(!account || accountFailed)return accountFailed
    ? <section className="create-agent"><p role="status">{retrying ? "Trying to load your account again…" : <>We couldn&apos;t load your account. It will retry on its own.</>}</p><RetryButton retrying={retrying} onRetry={onRefresh}/></section>
    : <section className="create-agent"><SkeletonRows rows={3} label="Loading your account"/></section>;
  if(account.session.hosted && !account.session.address)return <section className="create-agent"><h1>Meet your next agent.</h1><p>Sign in to create an agent and keep its portfolio with your account.</p><SignIn onDone={onSignedIn}/></section>;
  if(account.status.exists && !grant)return <section className="create-agent"><h1>Your agent is already set up.</h1><p>Open your agent to view its portfolio, or manage its wallet on this device.</p><button className="flow-primary" onClick={onDone}>Open agent</button><a href="/grant">Manage existing wallet</a></section>;
  const recovery=savedRecovery?.context===savedContext?savedRecovery:null;
  if((grant&&needsPermissionReplacement(grant))||(!account.status.exists&&recovery?.grant))return <section className="create-agent"><h1>Resume your saved wallet.</h1><p>This account already has a wallet. Open Wallet &amp; permissions to finish any pending revocation and review its next permission before trading resumes.</p><a href="/grant#resign">Resume wallet setup</a></section>;
  // This wizard always creates a mainnet account, including in paper mode.
  // Do not write settings or generate a key while the protected signer is
  // unavailable. Existing grants keep their backup, renew and recovery paths.
  if(!grant&&!privyOwner)return <section className="create-agent"><h1>Use a protected signing wallet.</h1><p>New mainnet agents require a Privy wallet so their owner key is not stored in this browser.</p>{PRIVY_BETA?<><p>Sign in with X or email, then wait for your signing wallet to become ready.</p><SignIn onDone={onSignedIn}/><RetryButton retrying={retrying} onRetry={onRefresh}/></>:<p>Protected wallet sign-in is not enabled on this installation. Enable it before creating a mainnet agent, or use testnet from Wallet &amp; permissions.</p>}<a href="/grant">Manage an existing wallet or use testnet</a></section>;
  if(!grant&&!account.status.exists&&!recovery)return <section className="create-agent"><SkeletonRows rows={3} label="Checking your saved wallet"/></section>;
  if(!grant&&recovery?.failed)return <section className="create-agent"><h1>Couldn&apos;t check your saved wallet.</h1><p>Restore access to browser storage and reload before creating or replacing a permission.</p><a href="/grant#resign">Open Wallet &amp; permissions</a><RetryButton retrying={retrying} onRetry={onRefresh}/></section>;
  async function create() {
    if(busy || grant || !account)return;
    if(!privyOwner){setError("Your signing wallet is not ready. Sign in with X or email and try again.");return;}
    // WAS `validAmount`, which took a dot decimal and nothing else — while the
    // field above is `inputMode="decimal"`, which renders a COMMA key on a
    // Spanish, German, French, Portuguese, Turkish or Indonesian keyboard. The
    // app handed people the separator its only validator refused, then said
    // "Enter positive amounts", which names neither thing that is wrong. On
    // the one screen where somebody bounds their own risk, that is a dead end.
    const perTrade=parseAmount(trade,CAP_FIELD),perDay=parseAmount(day,CAP_FIELD);
    for(const [labelKey,r] of [["create.labelPerTrade",perTrade],["create.labelPerDay",perDay]] as const){
      if(r.ok)continue;
      // Each refusal names the actual problem, and the ambiguous one names both
      // readings rather than picking one: "1.000" is a thousand in Berlin and
      // one in Boston, and a cap is sealed into a signature that cannot be
      // edited afterwards.
      //
      // THE FIELD NAME IS A PLACEHOLDER, not a prefix glued on in front. "Per
      // trade: enter an amount" is English word order, and several of the
      // shipped languages put the label somewhere else in the sentence.
      const label=t(labelKey);
      setError(r.reason==="ambiguous"?t("create.errAmbiguous",{label,a:r.readings[0]!,b:r.readings[1]!})
        :r.reason==="out-of-range"?t("create.errRange",{label,min:r.min,max:r.max})
        // The example is written in the reader's own separator. A hint that
        // shows a dot to somebody whose keyboard has a comma is the original
        // bug wearing a helpful expression.
        :t("create.errAmount",{label,sep:decimalSeparator()}));
      return;
    }
    if(!perTrade.ok||!perDay.ok)return;
    if(perTrade.value>perDay.value){setError(t("create.errOrder"));return;}
    if(!paper&&!ack){setError(t("create.errAck"));return;}
    setBusy(true);setError("");
    try {
      // The account prop may have been loaded before another tab changed login.
      // Confirm this tenant and its no-agent status before any settings write.
      const current=await fetchAccountForSession(account.session);
      if(current.kind!=="ready"){
        onRefresh();
        throw new Error("We couldn't confirm your account. Try again after it reloads.");
      }
      if(current.account.status.exists){throw new Error("An agent is already active. Open your agent instead of creating another wallet.");}
      if(current.account.session.hosted&&privyOwner.account.address.toLowerCase()!==current.account.session.address?.toLowerCase())throw new Error("Your signing wallet changed. Wait for the wallet for this signed-in account, then try again.");
      // A stop may have removed the server grant while another tab retained
      // its revocation journal. Re-check immediately before any settings write
      // or new signature; the initial UI check is not an authorization cache.
      const saved=await recoverableFor(current.account.session);
      if(saved){setSavedRecovery({context:savedContext,grant:saved,failed:false});throw new Error("Resume your saved wallet from Wallet & permissions before creating another permission.");}
      const settings=await requestJson<{values:{customTokens?:unknown[];v4AdapterAddress?:string;ponsAdapterAddress?:string;ponsClassVaultFactory?:string}}>("/api/settings");
      const address=(value?:string)=>value&&/^0x[0-9a-fA-F]{40}$/.test(value) ? value as `0x${string}` : undefined;
      const pons=await verifiedAdapter(address(settings.values.ponsAdapterAddress),4663,setStatus);
      // The market answers ride the settings write that was already happening —
      // one round trip, not four.
      await requestJson("/api/settings",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner:account.session.hosted?account.session.address:undefined,agentName:name.trim(),strategy,paperTradingEnabled:true,liveTradingEnabled:!paper,assetMode,basketSymbols:basket,customTokens:[...((settings.values.customTokens??[]) as CustomToken[]),...wizardTokens]})});
      /**
       * MERGED LOCALLY, NOT RE-READ — and getting this wrong would silently
       * undo the whole point of the step.
       *
       * `settings` was fetched BEFORE the PUT above, so re-reading
       * `settings.values.customTokens` here would miss every coin the owner just
       * named in the wizard. They would be stored, and then left out of the
       * signature that is about to be minted — so the agent would watch them and
       * refuse to buy them on `no-exit`, which is precisely the journey this
       * step exists to remove.
       */
      // The PARSED values, not `Number(trade)`. The raw string is what the
      // owner typed, and `Number("10,50")` is NaN while `Number("1.000")` is 1.
      const mintOptions={caps:{...INITIAL_CAPS,perTradeUsdg:perTrade.value,dailyUsdg:perDay.value},chainId:4663,extraTokens:[...((settings.values.customTokens??[]) as CustomToken[]),...wizardTokens].filter(isValidCustomToken) as CustomToken[],v4AdapterAddress:address(settings.values.v4AdapterAddress),ponsAdapterAddress:pons,ponsClassVaultFactory:address(settings.values.ponsClassVaultFactory),hostedAs:account?.session.hosted ? account.session.address as `0x${string}` : undefined,onStatus:setStatus};
      const result=await createPrivyOwnedWallet(privyOwner.account,privyOwner.did,mintOptions);
      setGrant(result.local);setArmed(result.handoff.ok);setStep("backup");setStatus("");
      if(!result.handoff.ok)setError(result.handoff.error ?? "Your wallet was created, but the service could not activate your agent. Save its recovery key before retrying.");
    }catch(e){setError(e instanceof Error ? e.message : "Could not create your agent. Try again.");}
    finally{setBusy(false);}
  }
  async function retryActivation(){
    if(!grant || busy || !account)return;
    setBusy(true);setError("");
    try{
      if(needsPermissionReplacement(grant))throw new Error("This permission was selected for revocation. Resume it from Wallet & permissions instead of activating it again.");
      const current=await fetchAccountForSession(account.session);
      if(current.kind!=="ready"||!await trustedSavedGrant(grant,current.account.session,window.location.origin)){
        onRefresh();throw new Error("This saved wallet could not be verified for your current account. Open Wallet & permissions.");
      }
      if(current.account.status.exists&&current.account.status.grant?.smartAccount.toLowerCase()!==grant.smartAccount.toLowerCase())throw new Error("A different agent is active for this account. Reload before continuing.");
      if(needsPermissionReplacement(grant))throw new Error("This permission is awaiting replacement. Resume it from Wallet & permissions.");
      const {demoOwnerPrivateKey:owner,...publicGrant}=grant;
      await requestJson("/api/grants",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(account?.session.hosted ? publicGrant : grant)});
      setArmed(true);onRefresh();
    }catch(e){setError(e instanceof Error ? e.message : "Could not activate your agent.");}finally{setBusy(false);}
  }
  const index=["agent","market","limits","backup","fund"].indexOf(step);
  return <section className="create-agent">
    <header className="create-heading"><button aria-label="Back" disabled={busy||step==="backup"} onClick={()=>step==="limits"?setStep("market"):step==="market"?setStep("agent"):onBack()}><ArrowLeft size={18}/></button><span>Create an agent</span></header>
    <ol className="create-steps" aria-label="Setup progress">{["Agent","Market","Limits","Backup","Ready"].map((label,i)=><li key={label} aria-current={i===index?"step":undefined}><span>{i<index?<Check size={12}/>:i+1}</span>{label}</li>)}</ol>
    {step==="agent" && <><div className="create-intro"><Face name={name||"Your agent"} slug={null}/><h1>Meet your next agent.</h1><p>A name, a strategy, and room to make its own moves.</p></div><form onSubmit={e=>{e.preventDefault();if(!name.trim()){setError(t("create.errName"));return;}setError("");setStep("market");}}><label className="create-label" htmlFor="agent-name">Agent name</label><input className="create-input" id="agent-name" value={name} maxLength={24} placeholder="What should we call it?" onChange={e=>setName(e.target.value)} required/><fieldset className="create-strategies"><legend>How should it trade?</legend>{STRATEGIES.map(s=><label className={strategy===s.id?"selected":""} key={s.id}><input type="radio" name="strategy" value={s.id} checked={strategy===s.id} onChange={()=>setStrategy(s.id)}/><span><strong>{s.name}{s.circle&&<i className="tag holders" title="Runs only while you hold $MERRYMEN">holders</i>}</strong><small>{s.description}{s.circle?" Runs only while you hold $MERRYMEN — pick it now and it opens nothing new until you do.":""}</small></span><span className="create-radio" aria-hidden>{strategy===s.id&&<Check size={13}/>}</span></label>)}</fieldset><div className="create-example" aria-live="polite"><span>Strategy example</span><p>{EXAMPLES[strategy]}</p></div>
            {/* THE READER'S STANDING, not the rule. The badge above states the
                requirement; this says whether THEY meet it, which is the only
                half that decides whether to press the button. "I had to go to
                /api/circle to check that and that's not good for normies." */}
            {/* JUDGED ON THE WALLET ALONE. The standing counts the owner's
                wallet and their current agent's account together, but a new
                agent is a new, empty account — so a figure that includes the
                old one would promise this agent tokens it will not have. And
                an unread count is a dash, never `?? 0`. */}
            {STRATEGIES.find((x) => x.id === strategy)?.circle &&
              tier &&
              tier.why !== "sign-in" &&
              !newAgentQualifies(tier) && (
                <div className="create-locked" role="status">
                  <strong>This one won&apos;t run yet.</strong>
                  {tier.why === "unreadable" ? (
                    <p>
                      We couldn&apos;t read your $MERRYMEN balance just now, so we can&apos;t tell
                      whether this strategy will run. That&apos;s our read failing, not your wallet
                      — try again in a moment.
                    </p>
                  ) : (
                    <p>
                      Your wallet holds {count(tier.holderTokens)} $MERRYMEN and this one
                      needs {count(tier.needTokens)}. Your agent will arm and read the
                      market, but until you hold enough it opens nothing new and leaves its basket as it
                      is; positions in a class vault are still closed by their own exit rules. Steady
                      basket and Strategist run
                      for everyone
                      {tier.energyGate
                        ? ` — on about a tenth of a standard day's energy below ${count(ENERGY.fullTokens)}`
                        : ""}
                      .
                    </p>
                  )}
                </div>
              )}
            {/* WHAT A NEW AGENT DOES NOT INHERIT. $MERRYMEN in the current
                agent's account counts toward THAT agent; it stays there, and
                a new agent starts without it. Said here, before the owner
                builds a second agent expecting the first one's standing. */}
            {tier && tier.agentTokens !== null && tier.agentTokens > 0 && (
              <p className="create-energy">
                The {count(tier.agentTokens)} $MERRYMEN in your current agent&apos;s account stays with
                that agent — a new agent starts without it.
              </p>
            )}
            {/* AND, ON A DEPLOYMENT THAT GATES ENERGY, THE CAPACITY IT WILL
                HAVE — said before anybody funds it, never after. */}
            {tier &&
              tier.energyGate &&
              tier.why === "ok" &&
              tier.holderTokens !== null &&
              tier.holderTokens < ENERGY.fullTokens &&
              !STRATEGIES.find((x) => x.id === strategy)?.circle && (
                <p className="create-energy">
                  Your agent runs at full energy while your wallet and its account hold{" "}
                  {count(ENERGY.fullTokens)} $MERRYMEN between them; below that it still runs, on about a
                  tenth of a standard day&apos;s AI reviews and new trades. Stop-losses, take-profits and your own
                  orders are never limited; its own AI reviews — including of its open positions — are
                  paced along with the rest.
                </p>
              )}<button className="flow-primary" type="submit">Set trading limits <ArrowRight size={16}/></button></form></>}
    {step==="market" && <>
      {/* WHAT IT TRADES, ASKED ONCE, AT THE ONLY MOMENT IT IS FREE.
          Every answer here rides the settings write create() already makes, and
          any coin named here is sealed into the FIRST signature — so it needs
          no re-sign, no coverage banner, and none of the "why isn't it trading"
          journey that sent several owners to the group. */}
      <div className="create-intro"><h1>What should it trade?</h1><p>You can change any of this later — coins added here are covered by the permission you sign in a moment.</p></div>
      <fieldset className="create-mode">
        <legend>Markets</legend>
        <label><input type="radio" name="assetMode" checked={assetMode==="all"} onChange={()=>setAssetMode("all")}/> All assets · recommended</label>
        <label><input type="radio" name="assetMode" checked={assetMode==="stocks"} onChange={()=>setAssetMode("stocks")}/> Stocks only</label>
        <label><input type="radio" name="assetMode" checked={assetMode==="crypto"} onChange={()=>setAssetMode("crypto")}/> Crypto only</label>
      </fieldset>
      <p className="create-note">{assetMode==="stocks"?"Tokenised equities and ETFs only. Your agent will be idle while US markets are shut.":assetMode==="crypto"?"Coins only. Add at least one below, or your agent will have nothing to trade.":"Everything you pick below, stocks and coins alike."}</p>

      {assetMode!=="crypto" && <>
        <label className="create-label">Stocks &amp; ETFs</label>
        <div className="mm-chips">{STOCK_TOKENS.filter(t=>t.kind!=="memecoin").map(t=>
          <button key={t.symbol} type="button" className={`mm-toggle${basket.includes(t.symbol)?" on":""}`} aria-pressed={basket.includes(t.symbol)} onClick={()=>setBasket(b=>b.includes(t.symbol)?b.filter(s=>s!==t.symbol):[...b,t.symbol])}>{t.symbol}</button>)}
        </div>
      </>}

      {assetMode!=="stocks" && <>
        <label className="create-label">Coins</label>
        {wizardTokens.length===0
          ? <p className="create-note">None yet. Paste a contract address below to add one — it will be covered by the permission you sign next, with no second signature needed.</p>
          : <div className="mm-chips">{wizardTokens.map(t=>
              <button key={t.address} type="button" className={`mm-toggle${basket.includes(t.symbol)?" on":""}`} aria-pressed={basket.includes(t.symbol)} onClick={()=>setBasket(b=>b.includes(t.symbol)?b.filter(s=>s!==t.symbol):[...b,t.symbol])}>{t.symbol}</button>)}
            </div>}
        <div className="create-limits">
          <label>Symbol<input className="create-input" value={newCoin.symbol} maxLength={12} placeholder="CATE" onChange={e=>setNewCoin(n=>({...n,symbol:e.target.value}))}/></label>
          <label>Contract address<input className="create-input" value={newCoin.address} placeholder="0x…" onChange={e=>setNewCoin(n=>({...n,address:e.target.value}))}/></label>
          <label>Decimals<input className="create-input" inputMode="numeric" value={newCoin.decimals} onChange={e=>setNewCoin(n=>({...n,decimals:e.target.value}))}/></label>
        </div>
        <button type="button" className="copy-btn" onClick={()=>{
          setCoinError("");
          const candidate={symbol:newCoin.symbol.trim(),address:newCoin.address.trim(),decimals:Number(newCoin.decimals)};
          if(!isValidCustomToken(candidate)){setCoinError("Needs a short symbol, a full 0x… address (42 characters) and whole-number decimals.");return;}
          // $MERRYMEN is energy, never a coin the permission covers (every signer drops it).
          if(isEnergyReserveToken(candidate.address)){setCoinError("That's $MERRYMEN — your agent's energy, not a coin it trades, so it isn't added here. Once your agent exists, ask it in chat to get its $MERRYMEN, or send it to the agent's account on Robinhood Chain.");return;}
          if(wizardTokens.some(t=>t.address.toLowerCase()===candidate.address.toLowerCase())){setCoinError("That address is already on the list.");return;}
          // BOTH WRITES, as everywhere else: added AND selected. The distinction
          // between "know about this" and "trade it" is real, but hiding the
          // second half is what made it a trap.
          setWizardTokens(t=>[...t,candidate as CustomToken]);
          setBasket(b=>b.includes(candidate.symbol)?b:[...b,candidate.symbol]);
          setNewCoin({symbol:"",address:"",decimals:"18"});
        }}>add coin</button>
        {coinError && <p className="create-note" role="alert">{coinError}</p>}
      </>}

      {basket.length===0 && <p className="create-note" role="status">Pick at least one thing to trade, or your agent will have nothing to do.</p>}
      <button className="flow-primary" disabled={basket.length===0} onClick={()=>{setError("");setStep("limits");}}>Continue</button>
    </>}
    {step==="limits" && <><div className="create-intro"><h1>A little freedom.<br/>Clear limits.</h1><p>Start small. You can change these limits with a new signature later.</p></div><div className="create-limits"><label>Per trade, USD<input className="create-input" inputMode="decimal" value={trade} onChange={e=>setTrade(e.target.value)} maxLength={12}/></label><label>Per day, USD<input className="create-input" inputMode="decimal" value={day} onChange={e=>setDay(e.target.value)} maxLength={12}/></label></div><dl className="fund-breakdown"><div><dt>Trading permission</dt><dd>7 days</dd></div><div><dt>Drawdown limit</dt><dd>5%</dd></div><div><dt>Maximum operations</dt><dd>24 per day</dd></div><div><dt>Network</dt><dd>Robinhood Chain</dd></div></dl><fieldset className="create-mode"><legend>{t("mode.legend")}</legend><label><input type="radio" name="mode" checked={paper} onChange={()=>setPaper(true)}/> {t("mode.paperOption")}</label><label><input type="radio" name="mode" checked={!paper} onChange={()=>setPaper(false)}/> {t("mode.liveOption")}</label></fieldset><p className="create-note">{paper?t("mode.paperNote"):t("mode.liveNote")}</p>{!paper&&<label className="create-check"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>{t("mode.ack")}</label>}<button className="flow-primary" disabled={busy} onClick={()=>void create()}>{busy?"Creating your agent…":"Create agent"}</button></>}
    {/* TWO OWNER MODELS, TWO DIFFERENT TRUTHS TO TELL.
        A Privy-owned account has NO key here, by design — showing dots and
        asking somebody to confirm they saved them is asking them to lie, and
        the sibling screen went further and warned them off funding an account
        that was working. So this step says what is actually true of each. */}
    {step==="backup"&&grant&&isPrivyOwned(grant)&&<><div className="create-intro"><h1>Your agent has a home.</h1><p>Your X login holds the key that owns this account. There is nothing here to write down — merrymen never sees it, so it cannot show it to you or lose it.</p></div><div className="create-secret"><code>Held by your Privy login</code></div><label className="create-check"><input type="checkbox" checked={backupAck} onChange={e=>setBackupAck(e.target.checked)}/>I understand: if I lose access to this X account, merrymen cannot recover these funds for me.</label><button className="flow-primary" disabled={!backupAck} onClick={()=>{localStorage.setItem(`merrymen.backup.${grant.smartAccount.toLowerCase()}`,"1");setStep("fund");}}>Continue</button></>}
    {step==="backup"&&grant&&!isPrivyOwned(grant)&&<><div className="create-intro"><h1>Your agent has a home.</h1><p>Save the recovery key before you go. It lets you recover this wallet if you lose this device.</p></div><label className="create-label">Recovery key</label><div className="create-secret"><code>{reveal ? grant.demoOwnerPrivateKey : "•••• •••• •••• •••• •••• ••••"}</code><button aria-label={reveal?"Hide recovery key":"Reveal recovery key"} onClick={()=>setReveal(!reveal)}>{reveal?<EyeOff size={18}/>:<Eye size={18}/>}</button></div><label className="create-check"><input type="checkbox" checked={backupAck} onChange={e=>setBackupAck(e.target.checked)}/>I saved my recovery key somewhere safe.</label><button className="flow-primary" disabled={!backupAck} onClick={()=>{localStorage.setItem(`merrymen.backup.${grant.smartAccount.toLowerCase()}`,"1");setReveal(false);setStep("fund");}}>Continue</button></>}
    {step==="fund"&&grant&&<><div className="create-intro"><h1>{armed?"Ready when you are.":"One last connection."}</h1><p>{armed?(paper ? "Your wallet is connected. Open your agent to check its status and follow paper trades." : "Your wallet is connected. Add trading funds, then open your agent to check its status."):"Your wallet is saved. Retry activation to connect it to your agent."}</p></div>{armed?<><dl className="fund-breakdown"><div><dt>Agent</dt><dd>{name || "Your agent"}</dd></div><div><dt>Strategy</dt><dd>{STRATEGIES.find(s=>s.id===strategy)?.name ?? strategy}</dd></div><div><dt>Trading mode</dt><dd>{paper ? "Paper trading" : "Live trading"}</dd></div></dl>{strategy==="llm-strategist"&&<p className="create-note">Check your AI provider in <a href="/settings">Settings</a> before your strategist starts.</p>}{!paper&&<button className="flow-primary" onClick={()=>onFund(grant)}>Add trading funds</button>}<button className="flow-primary" onClick={()=>{onRefresh();onDone();}}>Open your agent</button></>:<button className="flow-primary" disabled={busy} onClick={()=>void retryActivation()}>Retry activation</button>}</>}
    {status&&<p role="status" className="create-note">{status}</p>}{error&&<p role="alert" className="flow-error">{error}{isWallTooWide(error)&&<> <a href="/settings">Review custom tokens</a></>}</p>}
  </section>;
}
