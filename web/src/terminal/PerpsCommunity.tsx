import { useEffect, useRef, useState } from "react";
import type { AgentProfile } from "../lib/read-agent";
import { Feed } from "./screens/Feed";
import { Profile } from "./screens/Profile";
import { glanceOfHow, thesisOfHow, type ProfileAgent } from "./profile-view";
import type { LiveAgent, LiveToken, ReadState, Thesis } from "./live";
import { startRefreshLoop } from "./refresh-loop";

export interface PerpsCommunityProps {
  theses: Thesis[]; tokens: LiveToken[]; agents: LiveAgent[]; read: ReadState;
  mineSlug: string | null; ownerKey: string | null;
  onToken: (id: string) => void; onDesk: () => void;
  requestedProfile?: {slug: string; revision: number};
}
type PublicProfile = AgentProfile & { theses: Thesis[]; thesesRead: boolean };

/** The shared endpoint publishes this projection; private perpetual positions are never inputs. */
export function communityProfile(raw: unknown, slug: string): {agent: ProfileAgent; theses: Thesis[]; activityError: string} | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as PublicProfile;
  if (p.slug !== slug || typeof p.name !== "string" || typeof p.mode !== "string" || typeof p.publicBook !== "boolean" ||
    !Array.isArray(p.growth) || !Array.isArray(p.holdings) || !Array.isArray(p.theses) || !Array.isArray(p.recentTrades) ||
    !p.growth.every(v => v && Number.isFinite(v.at) && Number.isFinite(v.g)) ||
    !p.holdings.every(h => h && typeof h.symbol === "string" && Number.isFinite(h.valueUsdg) && (h.shareBps === null || Number.isFinite(h.shareBps))) ||
    (p.how !== null && (!p.how || (p.how.kind !== "strategy" && p.how.kind !== "model")))) return null;
  return {agent: {
    mode:p.mode,recentTrades:p.recentTrades,activityRead:p.activityRead,slug:p.slug,name:p.name,handle:p.handle,owner:p.handle,
    pnlBps:p.pnlBps,paperPnlBps:p.paperPnlBps,unrankedWhy:p.unrankedWhy,gas:p.gas,holdingsRead:p.holdingsRead,
    curve:p.growth.map(v=>v.g),curveKind:"growth",contributionsEvidenced:p.contributionsEvidenced,landed:p.landed,filledPaper:p.filledPaper,last:null,
    publicBook:p.publicBook,holdingsUsd:p.publicBook && p.holdingsRead ? p.holdings.reduce((sum,h)=>sum+h.valueUsdg,0) : null,
    thesis:thesisOfHow(p.how),glance:{...glanceOfHow(p.how),legs:p.publicBook ? p.holdings.map(h=>({symbol:h.symbol,weight:(h.shareBps??0)/100})) : undefined},
    growthPoints:p.growth,growthComplete:p.growthComplete,topTrades:p.topTrades,topTradesRead:p.topTradesRead,
    tradeCount:p.tradeCount,tradeCountFloor:p.tradeCountFloor,avgHoldSec:p.avgHoldSec,joinedAt:p.joinedAt,gasless:p.gasless,
  }, theses:p.thesesRead === false ? [] : p.theses, activityError:p.thesesRead === false ? "Recent decisions could not be loaded." : ""};
}

export function PerpsCommunity(props: PerpsCommunityProps) {
  return <OwnerCommunity key={props.ownerKey ?? "visitor"} {...props} />;
}
function OwnerCommunity({requestedProfile, ...props}: PerpsCommunityProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const returnToFeed = () => {
    setSlug(null);
    requestAnimationFrame(() => heading.current?.focus());
  };
  const [slug, setSlug] = useState<string | null>(requestedProfile?.slug ?? null);
  useEffect(() => { if (requestedProfile) setSlug(requestedProfile.slug); }, [requestedProfile]);
  return <div className="perps-community">
    <header className="perps-community-heading"><div><span className="perps-eyebrow">MERRYMEN / PUBLIC FLEET</span><h2 ref={heading} tabIndex={-1}>{slug ? "Agent profile" : "Fleet feed"}</h2><p>Published decisions across the fleet. Your perpetual positions and private execution journal stay in your desk.</p></div>{props.mineSlug && slug !== props.mineSlug ? <button type="button" className="perps-settings" onClick={() => setSlug(props.mineSlug)}>Your public profile ↗</button> : null}</header>
    <div hidden={slug !== null}><Feed compact theses={props.theses} tokens={props.tokens} agents={props.agents} read={props.read} onToken={props.onToken} onProfile={setSlug} onDesk={props.onDesk} /></div>
    {slug ? <CommunityProfile key={slug} slug={slug} isMine={props.mineSlug === slug && props.ownerKey !== null} tokens={props.tokens} onToken={props.onToken} onBack={returnToFeed} /> : null}
  </div>;
}
function CommunityProfile({slug,isMine,tokens,onToken,onBack}:{slug:string;isMine:boolean;tokens:LiveToken[];onToken:(id:string)=>void;onBack:()=>void}) {
  const profilePanel = useRef<HTMLDivElement>(null);
  useEffect(() => { profilePanel.current?.focus(); }, []);
  const [data,setData] = useState<ReturnType<typeof communityProfile>>(null);
  const [error,setError] = useState<string | null>(null);
  const [busy,setBusy] = useState(false);
  const retry = useRef<(() => void) | null>(null);
  useEffect(() => {
    let stopped=false; let controller:AbortController | null=null;
    const loop=startRefreshLoop({everyMs:30_000,paused:()=>document.hidden,report(){},onFlight(value){if(!stopped)setBusy(value);},pass:async()=>{
      controller=new AbortController(); const timeout=globalThis.setTimeout(()=>controller?.abort(),12_000);
      try {
        const response=await fetch(`/api/agents/${encodeURIComponent(slug)}`,{credentials:"same-origin",cache:"no-store",signal:controller.signal});
        if(stopped)return false;
        if(!response.ok){if(response.status===401||response.status===403||response.status===404)setData(null);throw new Error(response.status===404 ? "This public profile is unavailable." : "The public profile could not be refreshed.");}
        const next=communityProfile(await response.json(),slug);
        if(stopped)return false;
        if(!next)throw new Error("The public profile response could not be read.");
        setData(next);setError(null);return true;
      }catch(cause){if(!stopped)setError(cause instanceof Error && cause.name!=="AbortError" ? cause.message : "The profile read timed out.");return false;}
      finally{globalThis.clearTimeout(timeout);}
    }});
    retry.current=loop.retryNow;
    const wake=()=>{if(!document.hidden)loop.wake();}; document.addEventListener("visibilitychange",wake);
    return()=>{stopped=true;controller?.abort();loop.stop();retry.current=null;document.removeEventListener("visibilitychange",wake);};
  },[slug]);
  return <div className="perps-community-profile" ref={profilePanel} tabIndex={-1}>
    <div className="perps-community-actions"><button type="button" className="perps-control-secondary" onClick={onBack}>← Fleet feed</button><button type="button" className="perps-control-secondary" onClick={()=>retry.current?.()} disabled={busy}>{busy ? "Reading profile…" : "Refresh profile"}</button></div>
    <p className="perps-profile-scope">Growth and return figures follow recorded account equity, which can include perpetuals. Holdings, trade counts and trade lists here cover spot / on-chain activity. Private perpetual positions and execution history stay in your desk.</p>
    {error ? <p className="perps-data-note is-warning" role="status">{error}{data ? " Showing the previous public read; it may have changed." : ""}</p> : null}
    {data ? <Profile agent={data.agent} theses={data.theses} tokens={tokens} isMine={isMine} onBack={onBack} onToken={onToken} activityError={data.activityError} onBookChanged={()=>retry.current?.()} /> : !error ? <p className="perps-data-note" aria-busy="true">Reading the public profile…</p> : null}
  </div>;
}
