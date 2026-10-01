import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { AgentStatus } from "@/app/api/grants/route";
import { setupStep } from "@/lib/can-start";
import { fetchAccountForSession } from "./account-session";
import { SIGNED_IN_EVENT } from "@/lib/resign-anchor";
import type { AccountState } from "./HostedControls";

export default function SetupChecklist({onFund,paper}:{onFund:()=>void;paper:boolean}) {
  const [status,setStatus]=useState<AgentStatus|null>(null);
  useEffect(()=>{
    let active=true;
    let previous:AccountState["session"]|null=null;
    let generation=0;
    const load=async()=>{
      const current=++generation;
      let result=await fetchAccountForSession(previous);
      if(!active||current!==generation)return;
      if(result.kind==="changed"){
        setStatus(null);previous=null;
        result=await fetchAccountForSession(null);
      }
      if(!active||current!==generation)return;
      if(result.kind!=="ready"){setStatus(null);previous=null;return;}
      previous=result.account.session;
      setStatus(result.account.status as AgentStatus);
    };
    const signedIn=()=>{generation++;previous=null;setStatus(null);void load();};
    void load();
    const id=setInterval(()=>void load(),15_000);
    window.addEventListener(SIGNED_IN_EVENT,signedIn);
    return()=>{active=false;clearInterval(id);window.removeEventListener(SIGNED_IN_EVENT,signedIn);};
  },[]);
  if(!status) return null;
  return <SetupProgress status={status} paper={paper} onFund={onFund}/>;
}

/**
 * The checklist itself, drawn from a status already read.
 *
 * AN UNREAD BALANCE IS NOT AN UNFUNDED ONE. When the chain read failed the
 * fund step says so and offers no Add funds — see setupStep — rather than
 * telling an owner who may be funded to fund again.
 */
export function SetupProgress({status,paper,onFund}:{status:AgentStatus;paper:boolean;onFund:()=>void}) {
  const step=setupStep(status,paper);
  if(step==="done") return null;
  return <section className="setup-progress" aria-label="Agent setup">
    <header><h2>Finish setting up</h2><span>{status.exists ? "1" : "0"} of {paper ? "1" : "2"}</span></header>
    <div><span className="setup-check">{status.exists && <Check size={14}/>}</span><span><strong>Create your agent</strong><small>A strategy and signed trading limits.</small></span>{!status.exists && <a href="/create">Create agent</a>}</div>
    {!paper && <div><span className="setup-check"/><span><strong>Add trading funds</strong><small>{step==="unread" ? "We couldn’t read your balance just now, so we can’t say whether this is done." : "Fund your agent when you’re ready."}</small></span>{step==="fund" && <button onClick={onFund}>Add funds</button>}</div>}
  </section>;
}
