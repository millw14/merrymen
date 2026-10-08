import { useEffect, useState } from "react";
import { PerpsActivity } from "./PerpsActivity";
import { PerpsCommunity, type PerpsCommunityProps } from "./PerpsCommunity";
import type { ChartBook } from "../lib/perps-chart-data";

export interface PerpsFeedProps extends PerpsCommunityProps {
  hasAgent: boolean;
  currentBook: ChartBook | null;
  onAccount: () => void;
}

/** Public discussion and the owner's execution journal have different audiences. */
export function PerpsFeed(props: PerpsFeedProps) {
  return <OwnerFeed key={props.ownerKey ?? "visitor"} {...props} />;
}

function OwnerFeed({hasAgent, currentBook, onAccount, ...community}: PerpsFeedProps) {
  const [view, setView] = useState<"fleet" | "mine">("fleet");
  const [chosenBook, setBook] = useState<ChartBook | null>(null);
  const book = chosenBook ?? currentBook ?? "paper";
  useEffect(() => { if (community.requestedProfile) setView("fleet"); }, [community.requestedProfile]);
  return <div className="perps-feed">
    <nav className="perps-trade-navigation" aria-label="Feed audience">
      <button type="button" aria-pressed={view === "fleet"} onClick={() => setView("fleet")}>Fleet feed</button>
      <button type="button" aria-pressed={view === "mine"} onClick={() => setView("mine")}>My activity</button>
    </nav>
    <div hidden={view !== "fleet"}><PerpsCommunity {...community} /></div>
    {view === "mine" ? <section className="perps-private-feed" aria-label="Your private perpetuals activity">
      <header className="perps-community-heading"><div><span className="perps-eyebrow">YOUR AGENT / PRIVATE JOURNAL</span><h2>Every recorded move.</h2><p>Your perpetual fills and funding across all markets. Visible only to you.</p></div></header>
      {!community.ownerKey || !hasAgent ? <p className="perps-data-note">{!community.ownerKey ? "Sign in with your Merrymen account" : "Create your agent"} to read private executions. <button type="button" onClick={onAccount}>Open account</button></p> : <>
        <div className="perps-segment" role="group" aria-label="Activity book">{(["paper", "live"] as const).map(value => <button key={value} type="button" aria-pressed={book === value} onClick={() => setBook(value)}>{value === "paper" ? "Paper" : "Live"}</button>)}</div>
        <p className="perps-data-note">{book === "paper" ? "Paper executions are simulations; no real money moves." : "Live records describe real-money executions."} Changing this view does not change your agent’s trading mode.</p>
        <PerpsActivity key={book} market="all" book={book} />
      </>}
    </section> : null}
  </div>;
}
