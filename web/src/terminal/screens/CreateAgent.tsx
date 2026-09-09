"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff } from "lucide-react";
import { isValidCustomToken, type CustomToken } from "@merrymen/core";
import { createAgentWallet, createPrivyOwnedWallet, isPrivyOwned, loadGrant, type Grant, type GrantCaps } from "@/lib/session";
import { usePrivyOwner } from "@/terminal/usePrivyOwner";
import { verifiedAdapter } from "@/lib/verified-adapter";
import { requestJson, SignIn, type AccountState } from "../HostedControls";
import { Face } from "../ui";
import { validAmount } from "../amount";
import type { TierView } from "@/app/api/tier/route";

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
export function CreateAgent({account,onRefresh,onBack,onDone,onFund}:{account:AccountState|null;onRefresh:()=>void;onBack:()=>void;onDone:()=>void;onFund:(grant:Grant)=>void}) {
  const [step,setStep]=useState<"agent"|"limits"|"backup"|"fund">("agent");
  const [name,setName]=useState("");
  const [strategy,setStrategy]=useState("steady-basket");
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
  useEffect(()=>{fetch("/api/tier",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(t=>t&&setTier(t as TierView)).catch(()=>{});},[]);
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
  useEffect(()=>{
    if(!account?.status.grant)return;
    void requestJson<{values:{paperTradingEnabled?:boolean;agentName?:string;strategy?:string}}>("/api/settings").then(({values})=>{setPaper(values.paperTradingEnabled ?? true);setName(values.agentName ?? "");setStrategy(values.strategy ?? "steady-basket");}).catch(()=>{});
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
  if(!account)return <p role="status">Loading your account…</p>;
  if(account.session.hosted && !account.session.address)return <section className="create-agent"><h1>Meet your next agent.</h1><p>Sign in to create an agent and keep its portfolio with your account.</p><SignIn onDone={onRefresh}/></section>;
  if(account.status.exists && !grant)return <section className="create-agent"><h1>Your agent is already set up.</h1><p>Open your agent to view its portfolio, or manage its wallet on this device.</p><button className="flow-primary" onClick={onDone}>Open agent</button><a href="/grant">Manage existing wallet</a></section>;
  async function create() {
    if(busy || grant)return;
    if(!validAmount(trade)||!validAmount(day)||Number(trade)>Number(day)){setError("Enter positive amounts. The per-trade limit cannot exceed the daily limit.");return;}
    if(!paper&&!ack){setError("Confirm live trading before creating your agent.");return;}
    setBusy(true);setError("");
    try {
      const current=await requestJson<AccountState["status"]>("/api/grants");
      if(current.exists){throw new Error("An agent is already active. Open your agent instead of creating another wallet.");}
      const settings=await requestJson<{values:{customTokens?:unknown[];v4AdapterAddress?:string;ponsAdapterAddress?:string}}>("/api/settings");
      const address=(value?:string)=>value&&/^0x[0-9a-fA-F]{40}$/.test(value) ? value as `0x${string}` : undefined;
      const pons=await verifiedAdapter(address(settings.values.ponsAdapterAddress),4663,setStatus);
      await requestJson("/api/settings",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({agentName:name.trim(),strategy,paperTradingEnabled:paper})});
      const mintOptions={caps:{...INITIAL_CAPS,perTradeUsdg:Number(trade),dailyUsdg:Number(day)},chainId:4663,extraTokens:(settings.values.customTokens??[]).filter(isValidCustomToken) as CustomToken[],v4AdapterAddress:address(settings.values.v4AdapterAddress),ponsAdapterAddress:pons,hostedAs:account?.session.hosted ? account.session.address as `0x${string}` : undefined,onStatus:setStatus};
      // WHO OWNS THIS MERRYMAN. A Privy session owns it with the embedded
      // wallet it signed in with; everything else keeps the browser-generated
      // key. Same Kernel, same wall, same session key either way.
      const result=privyOwner ? await createPrivyOwnedWallet(privyOwner.account,privyOwner.did,mintOptions) : await createAgentWallet(mintOptions);
      setGrant(result.local);setArmed(result.handoff.ok);setStep("backup");setStatus("");
      if(!result.handoff.ok)setError(result.handoff.error ?? "Your wallet was created, but the service could not activate your agent. Save its recovery key before retrying.");
    }catch(e){setError(e instanceof Error ? e.message : "Could not create your agent. Try again.");}
    finally{setBusy(false);}
  }
  async function retryActivation(){
    if(!grant || busy)return;
    setBusy(true);setError("");
    try{
      const {demoOwnerPrivateKey:owner,...publicGrant}=grant;
      await requestJson("/api/grants",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(account?.session.hosted ? publicGrant : grant)});
      setArmed(true);onRefresh();
    }catch(e){setError(e instanceof Error ? e.message : "Could not activate your agent.");}finally{setBusy(false);}
  }
  const index=["agent","limits","backup","fund"].indexOf(step);
  return <section className="create-agent">
    <header className="create-heading"><button aria-label="Back" disabled={busy||step==="backup"} onClick={()=>step==="limits"?setStep("agent"):onBack()}><ArrowLeft size={18}/></button><span>Create an agent</span></header>
    <ol className="create-steps" aria-label="Setup progress">{["Agent","Limits","Backup","Ready"].map((label,i)=><li key={label} aria-current={i===index?"step":undefined}><span>{i<index?<Check size={12}/>:i+1}</span>{label}</li>)}</ol>
    {step==="agent" && <><div className="create-intro"><Face name={name||"Your agent"} slug={null}/><h1>Meet your next agent.</h1><p>A name, a strategy, and room to make its own moves.</p></div><form onSubmit={e=>{e.preventDefault();if(!name.trim()){setError("Give your agent a name.");return;}setError("");setStep("limits");}}><label className="create-label" htmlFor="agent-name">Agent name</label><input className="create-input" id="agent-name" value={name} maxLength={24} placeholder="What should we call it?" onChange={e=>setName(e.target.value)} required/><fieldset className="create-strategies"><legend>How should it trade?</legend>{STRATEGIES.map(s=><label className={strategy===s.id?"selected":""} key={s.id}><input type="radio" name="strategy" value={s.id} checked={strategy===s.id} onChange={()=>setStrategy(s.id)}/><span><strong>{s.name}{s.circle&&<i className="tag holders" title="Runs only while you hold $MERRYMEN">holders</i>}</strong><small>{s.description}{s.circle?" Runs only while you hold $MERRYMEN — pick it now and it stays idle until you do.":""}</small></span><span className="create-radio" aria-hidden>{strategy===s.id&&<Check size={13}/>}</span></label>)}</fieldset><div className="create-example" aria-live="polite"><span>Strategy example</span><p>{EXAMPLES[strategy]}</p></div>
            {/* THE READER'S STANDING, not the rule. The badge above states the
                requirement; this says whether THEY meet it, which is the only
                half that decides whether to press the button. "I had to go to
                /api/circle to check that and that's not good for normies." */}
            {STRATEGIES.find((x) => x.id === strategy)?.circle &&
              tier &&
              tier.why !== "sign-in" &&
              !tier.bonusStrategies && (
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
                      You hold {(tier.tokens ?? 0).toLocaleString("en-US")} $MERRYMEN and this one
                      needs {tier.needTokens.toLocaleString("en-US")}. Your agent will arm, read the
                      market and stay idle until you hold enough. Steady basket and Strategist run
                      for everyone.
                    </p>
                  )}
                </div>
              )}<button className="flow-primary" type="submit">Set trading limits <ArrowRight size={16}/></button></form></>}
    {step==="limits" && <><div className="create-intro"><h1>A little freedom.<br/>Clear limits.</h1><p>Start small. You can change these limits with a new signature later.</p></div><div className="create-limits"><label>Per trade, USD<input className="create-input" inputMode="decimal" value={trade} onChange={e=>setTrade(e.target.value)} maxLength={12}/></label><label>Per day, USD<input className="create-input" inputMode="decimal" value={day} onChange={e=>setDay(e.target.value)} maxLength={12}/></label></div><dl className="fund-breakdown"><div><dt>Trading permission</dt><dd>7 days</dd></div><div><dt>Drawdown limit</dt><dd>5%</dd></div><div><dt>Maximum operations</dt><dd>24 per day</dd></div><div><dt>Network</dt><dd>Robinhood Chain</dd></div></dl><fieldset className="create-mode"><legend>Start with</legend><label><input type="radio" name="mode" checked={paper} onChange={()=>setPaper(true)}/> Paper trading · recommended</label><label><input type="radio" name="mode" checked={!paper} onChange={()=>setPaper(false)}/> Live trading</label></fieldset><p className="create-note">{paper?"Practice with simulated funds and live market prices. This is a setting, not a different network — your agent stays on Robinhood Chain either way, and you can switch it off any time without a new signature.":"Your agent will trade the real funds you deposit, within these limits."}</p>{!paper&&<label className="create-check"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>I understand this agent can trade real funds.</label>}<button className="flow-primary" disabled={busy} onClick={()=>void create()}>{busy?"Creating your agent…":"Create agent"}</button></>}
    {/* TWO OWNER MODELS, TWO DIFFERENT TRUTHS TO TELL.
        A Privy-owned account has NO key here, by design — showing dots and
        asking somebody to confirm they saved them is asking them to lie, and
        the sibling screen went further and warned them off funding an account
        that was working. So this step says what is actually true of each. */}
    {step==="backup"&&grant&&isPrivyOwned(grant)&&<><div className="create-intro"><h1>Your agent has a home.</h1><p>Your X login holds the key that owns this account. There is nothing here to write down — merrymen never sees it, so it cannot show it to you or lose it.</p></div><div className="create-secret"><code>Held by your Privy login</code></div><label className="create-check"><input type="checkbox" checked={backupAck} onChange={e=>setBackupAck(e.target.checked)}/>I understand: if I lose access to this X account, merrymen cannot recover these funds for me.</label><button className="flow-primary" disabled={!backupAck} onClick={()=>{localStorage.setItem(`merrymen.backup.${grant.smartAccount.toLowerCase()}`,"1");setStep("fund");}}>Continue</button></>}
    {step==="backup"&&grant&&!isPrivyOwned(grant)&&<><div className="create-intro"><h1>Your agent has a home.</h1><p>Save the recovery key before you go. It lets you recover this wallet if you lose this device.</p></div><label className="create-label">Recovery key</label><div className="create-secret"><code>{reveal ? grant.demoOwnerPrivateKey : "•••• •••• •••• •••• •••• ••••"}</code><button aria-label={reveal?"Hide recovery key":"Reveal recovery key"} onClick={()=>setReveal(!reveal)}>{reveal?<EyeOff size={18}/>:<Eye size={18}/>}</button></div><label className="create-check"><input type="checkbox" checked={backupAck} onChange={e=>setBackupAck(e.target.checked)}/>I saved my recovery key somewhere safe.</label><button className="flow-primary" disabled={!backupAck} onClick={()=>{localStorage.setItem(`merrymen.backup.${grant.smartAccount.toLowerCase()}`,"1");setReveal(false);setStep("fund");}}>Continue</button></>}
    {step==="fund"&&grant&&<><div className="create-intro"><h1>{armed?"Ready when you are.":"One last connection."}</h1><p>{armed?(paper ? "Your wallet is connected. Open your agent to check its status and follow paper trades." : "Your wallet is connected. Add trading funds, then open your agent to check its status."):"Your wallet is saved. Retry activation to connect it to your agent."}</p></div>{armed?<><dl className="fund-breakdown"><div><dt>Agent</dt><dd>{name || "Your agent"}</dd></div><div><dt>Strategy</dt><dd>{STRATEGIES.find(s=>s.id===strategy)?.name ?? strategy}</dd></div><div><dt>Trading mode</dt><dd>{paper ? "Paper trading" : "Live trading"}</dd></div></dl>{strategy==="llm-strategist"&&<p className="create-note">Check your AI provider in <a href="/settings">Settings</a> before your strategist starts.</p>}{!paper&&<button className="flow-primary" onClick={()=>onFund(grant)}>Add trading funds</button>}<button className="flow-primary" onClick={()=>{onRefresh();onDone();}}>Open your agent</button></>:<button className="flow-primary" disabled={busy} onClick={()=>void retryActivation()}>Retry activation</button>}</>}
    {status&&<p role="status" className="create-note">{status}</p>}{error&&<p role="alert" className="flow-error">{error}</p>}
  </section>;
}
