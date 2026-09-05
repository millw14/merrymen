"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown, Compass, X } from "lucide-react";
import type { AccountState } from "./HostedControls";
import type { Screen } from "./live";
import "./first-visit.css";

const STOPS = ["Welcome", "Markets", "Your agent", "Conversation", "Portfolio", "Your controls", "The community"];
type Progress = { step:number; hidden:boolean; completed:boolean };
const INITIAL:Progress = {step:0,hidden:false,completed:false};
const PREFIX = "merrymen.guide.v1.";

export function FirstVisit({account,screen,replies,onScreen,onQuestion}:{account:AccountState|null;screen:Screen;replies:number;onScreen:(screen:Screen)=>void;onQuestion:()=>void}) {
  const key = account ? PREFIX + (account.session.hosted ? account.session.address?.toLowerCase() || "visitor" : "local") : null;
  const [loadedKey,setLoadedKey]=useState<string|null>(null);
  const [progress,setProgress]=useState<Progress>(INITIAL);
  const [folded,setFolded]=useState(false);
  useEffect(()=>{
    if(!key)return;
    let saved:Progress|undefined;
    try {
      const raw=localStorage.getItem(key) ?? (account?.session.hosted ? localStorage.getItem(PREFIX+"visitor") : null);
      if(raw){const value=JSON.parse(raw);if(Number.isInteger(value.step)&&value.step>=0&&value.step<STOPS.length&&typeof value.hidden==="boolean"&&typeof value.completed==="boolean")saved=value;}
    } catch { /* The guide still works when browser storage is unavailable. */ }
    setProgress(saved ?? {...INITIAL,hidden:!!account?.status.exists});setLoadedKey(key);
  },[key]);
  function save(next:Progress){setProgress(next);if(key)try{localStorage.setItem(key,JSON.stringify(next));}catch{}}
  function next(){save({...progress,step:Math.min(progress.step+1,STOPS.length-1)});setFolded(false);}
  function go(target:Screen){onScreen(target);}
  if(!key||loadedKey!==key)return null;
  if(progress.hidden)return <div className="guide-launch"><button onClick={()=>{save({...progress,step:progress.completed?0:progress.step,hidden:false,completed:false});setFolded(false);}}><Compass size={15}/>{progress.completed || progress.step===0 ? "Show me around" : "Resume my tour"}</button></div>;
  const {step}=progress;
  const hasAgent=!!account?.status.exists;
  const isTab=(tab:string)=>screen.kind==="tab"&&screen.tab===tab;
  const action=(label:string,run:()=>void)=><button className="guide-primary" onClick={run}>{label}<ArrowRight size={15}/></button>;
  let title="",copy="",controls:ReactNode=null;
  if(step===0){title="Welcome to merrymen.";copy="Give an agent a strategy, set its limits, and follow its decisions. Let’s find your way around.";
    controls=<>{action("Explore first",()=>{next();go({kind:"tab",tab:"home"});})}<button onClick={()=>{save({...progress,step:2});go(hasAgent?{kind:"tab",tab:"agent"}:{kind:"create"});}}>{hasAgent ? "Meet my agent" : "Set up my agent"}</button></>;
  } else if(step===1){title=screen.kind==="token"?"A closer look.":"Start with a stock you know.";copy=screen.kind==="token"?"The chart shows price history. Agent activity shows recorded trades when available. A watchlist keeps tokens you want to revisit.":"Open a token from Markets, or use search to find one. You can explore prices and agent activity before creating an agent.";
    controls=screen.kind==="token"?action("Meet my agent",()=>{next();go(hasAgent?{kind:"tab",tab:"agent"}:{kind:"create"});}):action("Find a token",()=>go({kind:"search"}));
  } else if(step===2){title=hasAgent?"Your agent, your boundaries.":"Meet your trading companion.";copy=hasAgent?"Your saved strategy and limits shape what your agent can do. Next, ask it to explain them in its own words.":"Choose a name and strategy, then set a per-trade and daily limit. Start with paper trading to practise with simulated funds. Save your recovery key before leaving setup.";
    controls=hasAgent&&screen.kind!=="create"?action("Open our conversation",()=>{next();go({kind:"tab",tab:"agent"});}):screen.kind==="create"?<span className="guide-wait">Continue with the setup below.</span>:action("Create my agent",()=>go({kind:"create"}));
  } else if(step===3){title="Ask it why.";copy=replies>0?"Your agent has replied. Keep asking questions when you want to understand a decision. Now let’s find its holdings.":"Try: “Explain my strategy and trading limits. Am I using paper or live trading?” Review the message and press Send. If chat needs an AI provider, connect one in Settings.";
    controls=<>{replies>0?action("See my portfolio",()=>{next();go({kind:"tab",tab:"you"});}):hasAgent?action("Prepare my first question",()=>{onQuestion();setFolded(true);}):action("Create an agent",()=>go({kind:"create"}))}{!replies&&<button onClick={()=>{next();go({kind:"tab",tab:"you"});}}>Try chat later</button>}</>;
  } else if(step===4){title="This is your agent’s money.";copy="Portfolio shows its balance, positions, and performance. An empty account starts at $0.00. Paper trades use simulated funds; live trades use deposited funds. Deposit and withdrawal are available here when you need them.";
    controls=isTab("you")?action("Find my controls",()=>{next();go({kind:"limits"});}):action("Open portfolio",()=>go({kind:"tab",tab:"you"}));
  } else if(step===5){title="You stay in control.";copy="Review your signed spending limits here. Settings changes the strategy and AI provider. Wallet & permissions lets you renew or revoke trading access. You don’t need to change anything for this tour.";
    controls=<>{screen.kind==="limits"?action("Meet the community",()=>{next();go({kind:"tab",tab:"feed"});}):action("Review my limits",()=>go({kind:"limits"}))}<button onClick={()=>go({kind:"settings"})}>Settings</button><button onClick={()=>go({kind:"grant"})}>Wallet & permissions</button></>;
  } else {title="Meet the neighbours.";copy="Feed is where agents share their decisions. Discover agents and the leaderboard to explore their records. Returns describe the past, so read the reasoning too. You can revisit this guide anytime with “Show me around.”";
    controls=<>{action("Finish my tour",()=>save({...progress,hidden:true,completed:true}))}<button onClick={()=>go({kind:"tab",tab:"feed"})}>Explore Feed</button><button onClick={()=>go({kind:"tab",tab:"board"})}>Leaderboard</button></>;
  }
  return <section className={`first-visit${folded?" folded":""}`} aria-label="Your guided first session">
    <header><button className="guide-heading" onClick={()=>setFolded(!folded)} aria-expanded={!folded}><Compass size={17}/><span>{STOPS[step]}</span><small>{step+1} / {STOPS.length}</small><ChevronDown size={15}/></button><button className="guide-close" aria-label="Skip tour" onClick={()=>save({...progress,hidden:true})}><X size={16}/></button></header>
    {!folded&&<><h2>{title}</h2><p>{copy}</p>{step===3&&hasAgent&&!account?.status.mode&&<p className="guide-status">Waiting for your worker. Chat setup and trading readiness are separate; check your agent’s status before expecting trades.</p>}<div className="guide-actions">{controls}{step>0&&<button className="guide-back" onClick={()=>save({...progress,step:step-1})}>Back</button>}</div></>}
  </section>;
}
