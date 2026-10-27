"use client";

import { useEffect, useRef, useState } from "react";
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
import { createPrivyOwnedWallet, isPrivyOwned, loadGrant, retryGrantHandoff, sameGrantPermission, type Grant, type GrantCaps } from "@/lib/session";
import { usePrivyOwner } from "@/terminal/usePrivyOwner";
import { verifiedAdapter } from "@/lib/verified-adapter";
import { TRENCHER_FACTORY } from "@/lib/trencher-permission";
import { loadRecoveryGrants, trustedSavedGrant } from "@/lib/saved-grant-binding";
import { needsPermissionReplacement } from "@/lib/permission-replacement";
import { requestJson, RetryButton, SignIn, PRIVY_BETA, type AccountState } from "../HostedControls";
import { fetchAccountForSession } from "../account-session";
import { Face } from "../ui";
import { SkeletonRows } from "../Skeleton";
import { CAP_FIELD, parseAmount } from "@/lib/parse-amount";
import type { TierView } from "@/app/api/tier/route";
import { loadTier, newAgentQualifies } from "../tier";
import { count, decimalSeparator, fullDateTime, usd } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { approveMcpCreateSetup, declineMcpCreateSetup, loadMcpCreateReview, mcpSetupRequest, type McpCreateReview } from "../mcp-create-setup";

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
  {id:"trencher",name:"Trencher",description:"Find verified memecoin pools, with Brain reviews and automatic exits."},
  {id:"steady-basket",name:"Steady basket",description:"Buy a little of your selected stocks on a schedule."},
  {id:"weekend-gap",name:"Weekend gap",description:"Buy selected tokenised stocks while their underlying market is closed, then sell when it reopens."},
  {id:"even-keel",name:"Even keel",description:"Keep the stocks in your basket evenly weighted.",circle:true},
  {id:"dip-hunter",name:"Dip hunter",description:"Look for pullbacks in the stocks you follow.",circle:true},
  {id:"llm-strategist",name:"Strategist",description:"Assess the market with AI and follow its reasoning."},
];
const EXAMPLES:Record<string,string>={
  "trencher":"For example, assess an active memecoin pool, buy within your limits, and monitor it for an exit. No token addresses to add.",
  "steady-basket":"For example, buy small amounts of your selected stocks over time instead of buying everything at once.",
  "weekend-gap":"For example, enter a selected stock after its underlying market closes and exit when its price feed becomes fresh again, within your limits.",
  "even-keel":"For example, if one stock grows to dominate your basket, adjust positions toward your target weights.",
  "dip-hunter":"For example, wait for a pullback that matches the strategy before considering an entry.",
  "llm-strategist":"For example, assess current market information, explain a proposed move, and check it against your limits.",
};
const INITIAL_CAPS: GrantCaps={perTradeUsdg:10,dailyUsdg:50,expiryDays:7,maxDrawdownPct:5,maxOpsPerDay:24};
const STATUS_PROMPT="Check my Merryman's setup and current worker status, then show me what I can manage here.";
const RISK_LABELS:Record<string,string>={strategistStopLossBps:"Stop loss",takeProfitBps:"Take profit",buyPerTickUsdg:"Amount per buy",llmMaxActionUsdg:"Maximum AI trade",slippageBps:"Slippage"};
function AssistantSetupSummary({setup,showSigningGuidance=false}:{setup:McpCreateReview;showSigningGuidance?:boolean}){
  const strategy=STRATEGIES.find(s=>s.id===setup.strategy);
  return <div className="create-example">
    <span>Prepared with {setup.requestedBy}</span><h2>{setup.name}</h2>
    <p>{strategy?.name??setup.strategy}{setup.riskLevel?` · ${setup.riskLevel} settings`:""}{setup.basket.length?` · ${setup.basket.join(", ")}`:""}</p>
    <p>{setup.assetMode==="stocks"?"Stocks only":setup.assetMode==="crypto"?"Crypto only":"Stocks and crypto"}. {strategy?.description}</p>
    <p>Setup expires {fullDateTime(setup.expiresAt*1000)}.</p>
    {Object.keys(setup.riskSettings).length>0&&<details><summary>Review strategy settings</summary><dl className="fund-breakdown">{Object.entries(setup.riskSettings).map(([key,value])=><div key={key}><dt>{RISK_LABELS[key]}</dt><dd>{key.endsWith("Bps")?`${value/100}%`:usd(value)}</dd></div>)}</dl><p>Price-impact safety limits stay unchanged.</p></details>}
    {showSigningGuidance&&<p>Your wallet confirms the limits below. Then return to your chat.</p>}
    {strategy?.circle&&<p>This strategy requires a qualifying $MERRYMEN holding. Until you qualify, it opens no new positions. Ask your assistant for a different strategy if you want to start without that requirement.</p>}
  </div>;
}
export function CreateAgent({account,accountFailed=false,retrying=false,assistantProposalId,onRefresh,onSignedIn,onBack,onDone,onFund}:{account:AccountState|null;accountFailed?:boolean;retrying?:boolean;assistantProposalId?:string;onRefresh:()=>void;onSignedIn:()=>void;onBack:()=>void;onDone:()=>void;onFund:(grant:Grant)=>void}) {
  const t = useT();
  const [step,setStep]=useState<"quick"|"agent"|"market"|"limits"|"backup"|"fund">("quick");
  const [name,setName]=useState("My Merryman");
  const [strategy,setStrategy]=useState("trencher");
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
  const inFlight=useRef(false);
  const [status,setStatus]=useState("");
  const [error,setError]=useState("");
  const [declined,setDeclined]=useState(false);
  const [copied,setCopied]=useState(false);
  const [setupRequest,setSetupRequest]=useState<ReturnType<typeof mcpSetupRequest>|null>(null);
  const setupOwner=account?.session.address?.toLowerCase()??"";
  const activeOwner=useRef(setupOwner);
  activeOwner.current=setupOwner;
  const mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [assistantSetup,setAssistantSetup]=useState<{owner:string;id:string;setup:McpCreateReview|null;error:string}|null>(null);
  useEffect(()=>{setSetupRequest(mcpSetupRequest(assistantProposalId===undefined?window.location.search:`?proposal=${encodeURIComponent(assistantProposalId)}`));},[assistantProposalId]);
  useEffect(()=>{
    if(!setupRequest?.id||!setupOwner||grant)return;
    let active=true;
    const id=setupRequest.id;
    setAssistantSetup(null);
    setDeclined(false);
    void loadMcpCreateReview(id,setupOwner).then(setup=>{
      if(!active)return;
      setAssistantSetup({owner:setupOwner,id,setup,error:""});
      setName(setup.name);setStrategy(setup.strategy);setAssetMode(setup.assetMode);setBasket(setup.basket);
      setPaper(true);setAck(false);setStep("limits");
    }).catch(e=>{if(active)setAssistantSetup({owner:setupOwner,id,setup:null,error:e instanceof Error?e.message:"Could not load your assistant's setup."});});
    return()=>{active=false;};
  },[setupRequest,setupOwner,grant]);
  const reviewedSetup=assistantSetup?.owner===setupOwner&&assistantSetup.id===setupRequest?.id?assistantSetup:null;
  const savedContext=account ? `${account.session.hosted}:${account.session.address?.toLowerCase()??""}:${account.status.exists}` : "";
  const [savedRecovery,setSavedRecovery]=useState<{context:string;grant:Grant|null;failed:boolean}|null>(null);
  async function recoverableFor(session:AccountState["session"]):Promise<Grant|null>{
    for(const candidate of [loadGrant("spot"),...loadRecoveryGrants("spot")]){
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
    // Assistant drafts describe a new wallet. Never adopt an existing wallet
    // or its settings into that review; it stays blocked below, but declinable.
    if(!account?.status.grant||!setupRequest||setupRequest.id||setupRequest.invalid)return;
    void requestJson<{values:{liveTradingEnabled?:boolean;agentName?:string;strategy?:string}}>("/api/settings").then(({values})=>{setPaper(!(values.liveTradingEnabled ?? false));setName(values.agentName ?? "");setStrategy(values.strategy ?? "steady-basket");}).catch(()=>{});
    const local=loadGrant("spot");
    if(local?.smartAccount.toLowerCase()===account.status.grant.smartAccount.toLowerCase()) {
      setGrant(local);setArmed(account.status.exists);
      const saved=localStorage.getItem(`merrymen.backup.${local.smartAccount.toLowerCase()}`)==="1";
      setStep(isPrivyOwned(local) || saved ? "fund" : "backup");
    }
  },[account?.status.grant?.smartAccount,setupRequest]);
  useEffect(()=>{
    if(!grant || step!=="backup")return;
    const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();};
    window.addEventListener("beforeunload",guard);
    return()=>window.removeEventListener("beforeunload",guard);
  },[grant,step]);
  // Reading or rejecting a validated pending draft only needs the owner
  // session. Wallet/recovery blockers must not hide that decision from them.
  const blockedReview=setupRequest?.id?reviewedSetup?.setup?.status==="awaiting_approval"?<>
    <AssistantSetupSummary setup={reviewedSetup.setup}/>
    <button className="copy-btn" disabled={busy} onClick={()=>void declineSetup()}>{busy?"Declining setup…":"Decline setup"}</button>
    {error&&<p role="alert" className="flow-error">{error}</p>}
  </>:reviewedSetup?.error?<p role="alert" className="flow-error">{reviewedSetup.error}</p>:!reviewedSetup?<p role="status">Loading your assistant&apos;s setup…</p>:null:null;
  // A FAILED READ IS NOT A SLOW ONE. Both leave `account` null, and this line
  // said "Loading your account…" for either — for ever, after a failure, with
  // nothing to press. See AccountEntry.
  if(!account || accountFailed)return accountFailed
    ? <section className="create-agent"><p role="status">{retrying ? "Trying to load your account again…" : assistantProposalId ? "We couldn't load your account. Try again before signing." : <>We couldn&apos;t load your account. It will retry on its own.</>}</p><RetryButton retrying={retrying} onRetry={onRefresh}/></section>
    : <section className="create-agent"><SkeletonRows rows={3} label="Loading your account"/></section>;
  if(account.session.hosted && !account.session.address)return <section className="create-agent"><h1>{assistantProposalId?"One quick sign-in.":"Meet your next agent."}</h1><p>{assistantProposalId?"Sign in with the same account you connected to your assistant. Your chosen name and strategy will be waiting here.":"Sign in to create an agent and keep its portfolio with your account."}</p><SignIn onDone={onSignedIn}/></section>;
  if(declined)return <section className="create-agent"><h1>Setup declined.</h1><p>No wallet was created and no settings changed. Return to your chat if you want a different setup.</p><a href="/connect/apps">Connected apps</a></section>;
  if(account.status.exists && !grant)return <section className="create-agent"><h1>Your agent is already set up.</h1><p>{assistantProposalId?"You can return to your chat to check its current status and manage it. No new wallet is needed.":"Open your agent to view its portfolio, or manage its wallet on this device."}</p>{assistantProposalId?<a className="flow-primary" href="/agent">Open your agent</a>:<button className="flow-primary" onClick={onDone}>Open agent</button>}<a href="/grant">Manage existing wallet</a>{blockedReview}</section>;
  const recovery=savedRecovery?.context===savedContext?savedRecovery:null;
  if((grant&&needsPermissionReplacement(grant))||(!account.status.exists&&recovery?.grant))return <section className="create-agent"><h1>Resume your saved wallet.</h1><p>This account already has a wallet. Open Wallet &amp; permissions to finish any pending revocation and review its next permission before trading resumes.</p><a href="/grant#resign">Resume wallet setup</a>{blockedReview}</section>;
  // This wizard always creates a mainnet account, including in paper mode.
  // Do not write settings or generate a key while the protected signer is
  // unavailable. Existing grants keep their backup, renew and recovery paths.
  // An owner session is enough to review or decline a proposal. Only wallet
  // creation needs the protected signer, enforced again by create() below.
  // Ordinary creation can explain this on the first render, before the URL
  // effect runs. Explicit or parsed assistant requests keep their review path.
  if(!grant&&!privyOwner&&!assistantProposalId&&!setupRequest?.id)return <section className="create-agent"><h1>Use a protected signing wallet.</h1><p>New mainnet agents require a Privy wallet so their owner key is not stored in this browser.</p>{PRIVY_BETA?<><p>Sign in with X or email, then wait for your signing wallet to become ready.</p><SignIn onDone={onSignedIn}/><RetryButton retrying={retrying} onRetry={onRefresh}/></>:<p>Protected wallet sign-in is not enabled on this installation. Enable it before creating a mainnet agent, or use testnet from Wallet &amp; permissions.</p>}<a href="/grant">Manage an existing wallet or use testnet</a></section>;
  if(!grant&&!account.status.exists&&!recovery)return <section className="create-agent"><SkeletonRows rows={3} label="Checking your saved wallet"/>{blockedReview}</section>;
  if(!grant&&recovery?.failed)return <section className="create-agent"><h1>Couldn&apos;t check your saved wallet.</h1><p>Restore access to browser storage and reload before creating or replacing a permission.</p><a href="/grant#resign">Open Wallet &amp; permissions</a><RetryButton retrying={retrying} onRetry={onRefresh}/>{blockedReview}</section>;
  if(!grant&&!setupRequest)return <section className="create-agent"><SkeletonRows rows={3} label="Loading your setup"/></section>;
  if(!grant&&(setupRequest?.invalid||reviewedSetup?.error))return <section className="create-agent"><h1>Review your setup again.</h1><p role="alert">{reviewedSetup?.error||"This setup link is invalid. Return to your assistant for a new setup."}</p>{assistantProposalId?<p>Return to the same chat and ask your assistant for a fresh setup link.</p>:<a href="/create">Start a new setup</a>}</section>;
  if(!grant&&setupRequest?.id&&!reviewedSetup?.setup)return <section className="create-agent"><SkeletonRows rows={3} label="Loading your assistant's setup"/></section>;
  async function create(practice=paper, liveConsent=false) {
    if(inFlight.current || busy || grant || !account)return;
    if(!privyOwner){setError("Your signing wallet is not ready. Sign in with X or email and try again.");return;}
    if(!name.trim()){setError(t("create.errName"));return;}
    if(strategy==="trencher"&&!TRENCHER_FACTORY){setError("Trencher's verified trading vault is not configured on this installation. Choose another strategy or try again after setup is complete.");return;}
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
    if(!practice&&!ack&&!liveConsent){setError(t("create.errAck"));return;}
    inFlight.current=true;
    setPaper(practice);setBusy(true);setError("");
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
      // Recheck expiry, connection standing and owner immediately before the
      // settings write/signature. A loaded setup is not an authorization cache.
      let setup:McpCreateReview|null=null;
      if(setupRequest?.id){
        const review=reviewedSetup?.setup;
        if(!review||review.owner!==current.account.session.address?.toLowerCase())throw new Error("Review your setup again before signing.");
        setStatus(review.status==="awaiting_approval"?"Approving your setup…":"Checking your approved setup…");
        setup=await approveMcpCreateSetup(review);
        // Approval can involve a slow request. Do not carry its result across
        // a login change, unmount, or a wallet created in another tab.
        const afterApproval=await fetchAccountForSession(current.account.session);
        if(!mounted.current||activeOwner.current!==review.owner||afterApproval.kind!=="ready"){
          onRefresh();
          throw new Error("Your signed-in account changed. Review the setup again before signing.");
        }
        if(afterApproval.account.status.exists)throw new Error("An agent is already active. Open your agent instead of creating another wallet.");
        if(await recoverableFor(afterApproval.account.session))throw new Error("Resume your saved wallet from Wallet & permissions before creating another permission.");
        setAssistantSetup({owner:setup.owner,id:setup.id,setup,error:""});
      }
      const settings=await requestJson<{values:{customTokens?:unknown[];v4AdapterAddress?:string;ponsAdapterAddress?:string;ponsClassVaultFactory?:string}}>("/api/settings");
      const address=(value?:string)=>value&&/^0x[0-9a-fA-F]{40}$/.test(value) ? value as `0x${string}` : undefined;
      const pons=await verifiedAdapter(address(settings.values.ponsAdapterAddress),4663,setStatus);
      // The market answers ride the settings write that was already happening —
      // one round trip, not four.
      await requestJson("/api/settings",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({...setup?.riskSettings,owner:account.session.hosted?account.session.address:undefined,agentName:name.trim(),strategy,paperTradingEnabled:true,liveTradingEnabled:!practice,assetMode:strategy==="trencher"?"crypto":assetMode,basketSymbols:strategy==="trencher"?[]:basket,customTokens:[...((settings.values.customTokens??[]) as CustomToken[]),...wizardTokens],...(strategy==="trencher"?{discoveryEnabled:true,officialCoinsEnabled:true,trencherFastEnabled:true,trencherLiveEnabled:!practice,tickSeconds:15}:{})})});
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
      const mintOptions={caps:{...INITIAL_CAPS,perTradeUsdg:perTrade.value,dailyUsdg:perDay.value},chainId:4663,extraTokens:[...((settings.values.customTokens??[]) as CustomToken[]),...wizardTokens].filter(isValidCustomToken) as CustomToken[],v4AdapterAddress:address(settings.values.v4AdapterAddress),ponsAdapterAddress:pons,ponsClassVaultFactory:address(settings.values.ponsClassVaultFactory),...(strategy==="trencher"?{trencherFactory:TRENCHER_FACTORY as `0x${string}`} : {}),hostedAs:account?.session.hosted ? account.session.address as `0x${string}` : undefined,onStatus:setStatus};
      const result=await createPrivyOwnedWallet(privyOwner.account,privyOwner.did,mintOptions);
      setGrant(result.local);setArmed(result.handoff.ok);setStep(isPrivyOwned(result.local)?"fund":"backup");setStatus("");
      if(!result.handoff.ok)setError(result.handoff.error ?? "Your wallet was created, but the service could not activate your agent. Retry activation with this saved permission.");
    }catch(e){setStatus("");setError(e instanceof Error ? e.message : "Could not create your agent. Try again.");}
    finally{inFlight.current=false;setBusy(false);}
  }
  async function declineSetup(){
    const review=reviewedSetup?.setup;
    if(!review||!account||inFlight.current||busy)return;
    inFlight.current=true;setBusy(true);setError("");
    try{
      const current=await fetchAccountForSession(account.session);
      if(current.kind!=="ready"||current.account.session.address?.toLowerCase()!==review.owner)throw new Error("Your signed-in account changed. Reload before deciding this setup.");
      await declineMcpCreateSetup(review);
      if(mounted.current&&activeOwner.current===review.owner)setDeclined(true);
    }catch(e){setError(e instanceof Error?e.message:"Could not decline this setup. Try again.");}
    finally{inFlight.current=false;setBusy(false);}
  }
  async function retryActivation(){
    if(!grant || inFlight.current || busy || !account)return;
    inFlight.current=true;
    setBusy(true);setError("");
    try{
      if(needsPermissionReplacement(grant))throw new Error("This permission was selected for revocation. Resume it from Wallet & permissions instead of activating it again.");
      const current=await fetchAccountForSession(account.session);
      if(current.kind!=="ready"||!await trustedSavedGrant(grant,current.account.session,window.location.origin)){
        onRefresh();throw new Error("This saved wallet could not be verified for your current account. Open Wallet & permissions.");
      }
      if(needsPermissionReplacement(grant))throw new Error("This permission is awaiting replacement. Resume it from Wallet & permissions.");
      if(current.account.status.exists){
        if(!sameGrantPermission(current.account.status.grant,grant))throw new Error("Another permission is active for this account. Reload before continuing.");
        // A lost response can leave this permission durably stored. Match all
        // public bounds/provenance before skipping another handoff or signature.
        setArmed(true);onRefresh();return;
      }
      if(account.session.hosted&&(!privyOwner||!isPrivyOwned(grant)))throw new Error("Open Wallet & permissions to confirm the signer for this saved wallet.");
      const handoff=await retryGrantHandoff(grant,account.session.hosted&&privyOwner?{
        ownerSigner:{account:privyOwner.account,binding:"privy-did-owner-v1",did:privyOwner.did},
        tenant:current.account.session.address as `0x${string}`,
        beforeSubmit:async()=>{
          if(needsPermissionReplacement(grant))throw new Error("This permission is awaiting replacement. Resume it from Wallet & permissions.");
          const latest=await fetchAccountForSession(account.session);
          if(latest.kind!=="ready"||!await trustedSavedGrant(grant,latest.account.session,window.location.origin))throw new Error("Your signed-in account changed while confirming the wallet. Reload before retrying activation.");
          if(needsPermissionReplacement(grant))throw new Error("This permission is awaiting replacement. Resume it from Wallet & permissions.");
          if(latest.account.status.exists&&!sameGrantPermission(latest.account.status.grant,grant))throw new Error("Another permission is active for this account. Reload before continuing.");
        },
      }:undefined);
      if(!handoff.ok)throw new Error(handoff.error??"Could not activate your agent. Your saved permission is ready to retry.");
      setArmed(true);onRefresh();
    }catch(e){setError(e instanceof Error ? e.message : "Could not activate your agent.");}finally{inFlight.current=false;setBusy(false);}
  }
  const steps=assistantProposalId?["limits","fund"]:(strategy==="trencher"?["agent","limits","fund"]:["agent","market","limits","fund"]);
  if(grant?.demoOwnerPrivateKey)steps.splice(steps.length-1,0,"backup");
  const index=steps.indexOf(step);
  return <section className="create-agent">
    <header className="create-heading">{!assistantProposalId&&<button aria-label="Back" disabled={busy||step==="backup"} onClick={()=>step==="limits"?setStep(strategy==="trencher"?"agent":"market"):step==="market"?setStep("agent"):onBack()}><ArrowLeft size={18}/></button>}<span>{assistantProposalId?"Review and create your Merryman":"Create an agent"}</span></header>
    {reviewedSetup?.setup&&!grant&&<AssistantSetupSummary setup={reviewedSetup.setup} showSigningGuidance/>}
    {step!=="quick"&&<ol className="create-steps" aria-label="Setup progress">{steps.map((stage,i)=><li key={stage} aria-current={i===index?"step":undefined}><span>{i<index?<Check size={12}/>:i+1}</span>{stage==="fund"?"Connected":assistantProposalId&&stage==="limits"?"Review & sign":stage[0]!.toUpperCase()+stage.slice(1)}</li>)}</ol>}
    {step==="quick"&&<>
      <div className="create-intro"><Face name={name||"Your agent"} slug={null}/><h1>Start your Trencher.</h1><p>Finds verified memecoin pools, asks Brain before buying, and monitors exits. No token addresses to enter.</p></div>
      <fieldset disabled={busy} style={{border:0,padding:0,margin:0}}>
        <label className="create-label" htmlFor="agent-name">Agent name</label><input className="create-input" id="agent-name" value={name} maxLength={24} onChange={e=>setName(e.target.value)}/>
        <dl className="fund-breakdown"><div><dt>Planned entries</dt><dd>$2.50</dd></div><div><dt>Trencher vault limits</dt><dd>$5 per buy · $25 per 24 hours</dd></div><div><dt>Signed trading limits</dt><dd>$10 per trade · $50 per day</dd></div><div><dt>Permission</dt><dd>7 days · 5% drawdown · 24 operations/day</dd></div><div><dt>Network</dt><dd>Robinhood Chain</dd></div></dl>
        <p className="create-note">Starting live authorizes real-money trades once funded. Every entry needs Brain approval and must pass your limits. Memecoins can lose all their value.</p>
        <p className="create-note">Approve the wallet prompts to finish. Your signing wallet keeps ownership; keep access to your sign-in account.</p>
        {!TRENCHER_FACTORY&&<p className="flow-error" role="status">Trencher's verified trading vault is not configured on this installation. You can choose another strategy below.</p>}
        <div className="create-quick-actions"><button className="flow-primary" disabled={!TRENCHER_FACTORY} onClick={()=>void create(false,true)}>{busy?"Setting up your agent…":"Start live Trencher"}</button>
        <button className="copy-btn" disabled={!TRENCHER_FACTORY} onClick={()=>void create(true)}>Practise first</button>
        <button className="copy-btn" onClick={()=>{setError("");setStep("agent");}}>Customise strategy and limits</button></div>
      </fieldset>
    </>}
    {step==="agent" && <><div className="create-intro"><Face name={name||"Your agent"} slug={null}/><h1>Meet your next agent.</h1><p>A name, a strategy, and room to make its own moves.</p></div><form onSubmit={e=>{e.preventDefault();if(!name.trim()){setError(t("create.errName"));return;}setError("");setStep(strategy==="trencher"?"limits":"market");}}><label className="create-label" htmlFor="agent-name">Agent name</label><input className="create-input" id="agent-name" value={name} maxLength={24} placeholder="What should we call it?" onChange={e=>setName(e.target.value)} required/><fieldset className="create-strategies"><legend>How should it trade?</legend>{STRATEGIES.map(s=><label className={strategy===s.id?"selected":""} key={s.id}><input type="radio" name="strategy" value={s.id} checked={strategy===s.id} onChange={()=>setStrategy(s.id)}/><span><strong>{s.name}{s.circle&&<i className="tag holders" title="Runs only while you hold $MERRYMEN">holders</i>}</strong><small>{s.description}{s.circle?" Runs only while you hold $MERRYMEN — pick it now and it opens nothing new until you do.":""}</small></span><span className="create-radio" aria-hidden>{strategy===s.id&&<Check size={13}/>}</span></label>)}</fieldset><div className="create-example" aria-live="polite"><span>Strategy example</span><p>{EXAMPLES[strategy]}</p></div>
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
    {step==="limits" && <><div className="create-intro"><h1>{assistantProposalId?"Your limits. Your call.":<>A little freedom.<br/>Clear limits.</>}</h1><p>{assistantProposalId?"Start in practice with simulated funds, or choose live trading. Only your wallet can authorize the limits you choose.":"Start small. You can change these limits with a new signature later."}</p></div>
      <div className="create-limits"><label>Per trade, USD<input className="create-input" inputMode="decimal" value={trade} disabled={busy} onChange={e=>setTrade(e.target.value)} maxLength={12}/></label><label>Per day, USD<input className="create-input" inputMode="decimal" value={day} disabled={busy} onChange={e=>setDay(e.target.value)} maxLength={12}/></label></div>
      <dl className="fund-breakdown"><div><dt>Trading permission</dt><dd>7 days</dd></div><div><dt>Drawdown limit</dt><dd>5%</dd></div><div><dt>Maximum operations</dt><dd>24 per day</dd></div><div><dt>Network</dt><dd>Robinhood Chain</dd></div></dl>
      <fieldset className="create-mode" disabled={busy}><legend>{t("mode.legend")}</legend><label><input type="radio" name="mode" checked={paper} onChange={()=>setPaper(true)}/> {t("mode.paperOption")}</label><label><input type="radio" name="mode" checked={!paper} onChange={()=>setPaper(false)}/> {t("mode.liveOption")}</label></fieldset><p className="create-note">{paper?t("mode.paperNote"):t("mode.liveNote")}</p>
      {!paper&&<label className="create-check"><input type="checkbox" checked={ack} disabled={busy} onChange={e=>setAck(e.target.checked)}/>{t("mode.ack")}</label>}
      {!privyOwner&&<div className="connect-boundary"><p>Your protected signing wallet is not ready. {reviewedSetup?.setup?.status==="awaiting_approval"?"You can review or decline this setup now. ":""}Creating the agent requires that wallet. {PRIVY_BETA?"Sign in with the same account you connected to your assistant, then wait for its wallet to become ready.":"Protected wallet sign-in is not enabled on this installation."}</p>{PRIVY_BETA&&<SignIn onDone={onSignedIn}/>}<RetryButton retrying={retrying} onRetry={onRefresh}/><a href="/grant">Wallet &amp; permissions</a></div>}
      <button className="flow-primary" disabled={busy||!privyOwner} onClick={()=>void create()}>{busy?"Creating your agent…":reviewedSetup?.setup?.status==="awaiting_approval"?(paper?"Approve and create practice agent":"Approve and create live agent"):assistantProposalId?(paper?"Create practice agent":"Create live agent"):"Create agent"}</button>
      {reviewedSetup?.setup?.status==="awaiting_approval"&&<button className="connect-cancel" disabled={busy} onClick={()=>void declineSetup()}>Decline setup</button>}
    </>}
    {/* TWO OWNER MODELS, TWO DIFFERENT TRUTHS TO TELL.
        A Privy-owned account has NO key here, by design — showing dots and
        asking somebody to confirm they saved them is asking them to lie, and
        the sibling screen went further and warned them off funding an account
        that was working. So this step says what is actually true of each. */}
    {step==="backup"&&grant&&isPrivyOwned(grant)&&<><div className="create-intro"><h1>Your agent has a home.</h1><p>Your signing wallet holds the key that owns this account. There is nothing here to write down — merrymen never sees it, so it cannot show it to you or lose it.</p></div><div className="create-secret"><code>Held by your Privy login</code></div><label className="create-check"><input type="checkbox" checked={backupAck} onChange={e=>setBackupAck(e.target.checked)}/>I understand: if I lose access to my sign-in account, merrymen cannot recover these funds for me.</label><button className="flow-primary" disabled={!backupAck} onClick={()=>{localStorage.setItem(`merrymen.backup.${grant.smartAccount.toLowerCase()}`,"1");setStep("fund");}}>Continue</button></>}
    {step==="backup"&&grant&&!isPrivyOwned(grant)&&<><div className="create-intro"><h1>Your agent has a home.</h1><p>Save the recovery key before you go. It lets you recover this wallet if you lose this device.</p></div><label className="create-label">Recovery key</label><div className="create-secret"><code>{reveal ? grant.demoOwnerPrivateKey : "•••• •••• •••• •••• •••• ••••"}</code><button aria-label={reveal?"Hide recovery key":"Reveal recovery key"} onClick={()=>setReveal(!reveal)}>{reveal?<EyeOff size={18}/>:<Eye size={18}/>}</button></div><label className="create-check"><input type="checkbox" checked={backupAck} onChange={e=>setBackupAck(e.target.checked)}/>I saved my recovery key somewhere safe.</label><button className="flow-primary" disabled={!backupAck} onClick={()=>{localStorage.setItem(`merrymen.backup.${grant.smartAccount.toLowerCase()}`,"1");setReveal(false);setStep("fund");}}>Continue</button></>}
    {step==="fund"&&grant&&<><div className="create-intro"><h1>{armed?(assistantProposalId?"Wallet connected.":"Ready when you are."):"One last connection."}</h1><p>{armed?(assistantProposalId?"Your signed permission is saved. Return to your chat and refresh Merryman to check activation and manage your agent.":paper ? "Your wallet is connected. Open your agent to check its status and follow paper trades." : "Your wallet is connected. Add trading funds, then open your agent to check its status."):"Your wallet is saved. Retry activation and confirm a fresh account-link signature. Your wallet, trading permission and limits stay the same."}</p></div>{armed?<><dl className="fund-breakdown"><div><dt>Agent</dt><dd>{name || "Your agent"}</dd></div><div><dt>Strategy</dt><dd>{STRATEGIES.find(s=>s.id===strategy)?.name ?? strategy}</dd></div><div><dt>Trading mode</dt><dd>{paper ? "Paper trading" : "Live trading"}</dd></div></dl>{strategy==="trencher"&&<p className="create-note">Brain reviews and eligible pools are required before Trencher buys. Open your agent to check its current status. Keep access to the sign-in account that controls your wallet.</p>}{strategy==="llm-strategist"&&<p className="create-note">Check your AI provider in <a href="/settings">Settings</a> before your strategist starts.</p>}{!paper&&<button className="flow-primary" onClick={()=>onFund(grant)}>Add trading funds</button>}{assistantProposalId?<><p className="create-note">A saved permission does not confirm a running worker. Return to the same chat and ask for its latest status. You can close this tab; Merrymen runs the worker.</p><button className="flow-primary" onClick={()=>{void navigator.clipboard?.writeText(STATUS_PROMPT).then(()=>setCopied(true)).catch(()=>setCopied(false));}}>{copied?"Copied":"Copy a status-check message"}</button><p className="mcp-setup-prompt">{STATUS_PROMPT}</p><a href="/agent">Open your agent</a><p className="create-note">If your assistant cannot see this agent, reconnect it and choose the agent to share. <a href="/connect/apps">Connected apps</a></p></>:<button className="flow-primary" onClick={()=>{onRefresh();onDone();}}>Open your agent</button>}</>:<button className="flow-primary" disabled={busy} onClick={()=>void retryActivation()}>Retry activation</button>}</>}
    {status&&<p role="status" className="create-note">{status}</p>}{error&&<p role="alert" className="flow-error">{error}{isWallTooWide(error)&&<> <a href="/settings">Review custom tokens</a></>}</p>}
  </section>;
}
