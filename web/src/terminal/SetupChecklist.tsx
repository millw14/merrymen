import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { AgentStatus } from "@/app/api/grants/route";
import { canStart } from "@/lib/can-start";
import { requestJson } from "./HostedControls";

export default function SetupChecklist({onFund,paper}:{onFund:()=>void;paper:boolean}) {
  const [status,setStatus]=useState<AgentStatus|null>(null);
  useEffect(()=>{let active=true;requestJson<AgentStatus>("/api/grants").then(value=>{if(active)setStatus(value);}).catch(()=>{});return()=>{active=false;};},[]);
  if(!status) return null;
  const ready=canStart(status);
  if(status.exists && (paper || ready)) return null;
  return <section className="setup-progress" aria-label="Agent setup">
    <header><h2>Finish setting up</h2><span>{status.exists ? "1" : "0"} of {paper ? "1" : "2"}</span></header>
    <div><span className="setup-check">{status.exists && <Check size={14}/>}</span><span><strong>Create your agent</strong><small>A strategy and signed trading limits.</small></span>{!status.exists && <a href="/create">Create agent</a>}</div>
    {!paper && <div><span className="setup-check"/><span><strong>Add trading funds</strong><small>Fund your agent when you’re ready.</small></span>{status.exists && <button onClick={onFund}>Add funds</button>}</div>}
  </section>;
}
