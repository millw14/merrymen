import Link from "next/link";
import { BandSection } from "@/components/BandSection";
import { ChainStats } from "@/components/ChainStats";
import { FeedPanel } from "@/components/FeedPanel";
import { MarketTable } from "@/components/MarketTable";

export default function Dashboard() {
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="arrow">➳</span>
          <span>merrymen</span>
          <span className="tagline">your band works Sherwood 24/7</span>
        </div>
        <span className="chain-pill">
          <span className="dot" />
          Robinhood Chain · 4663
        </span>
        <ChainStats />
        <Link href="/grant" className="connect-btn" style={{ textDecoration: "none" }}>
          deploy an agent
        </Link>
      </header>

      <main className="shell">
        <section className="agents">
          <div className="section-title">the band</div>
          <BandSection />

          <div className="section-title market-title">sherwood market · chainlink prices</div>
          <MarketTable />
        </section>

        <aside className="rail">
          <div className="panel">
            <button className="killall">◉ kill all agents</button>
            <div className="killall-note">
              revokes every session key on-chain · positions untouched
            </div>
          </div>

          <div className="panel">
            <div className="section-title">activity</div>
            <FeedPanel />
          </div>
        </aside>
      </main>

      <footer className="statusbar">
        <span className="live">● sequencer up</span>
        <span>oracles: chainlink 24/5 · weekend staleness expected</span>
        <span>execution: rialto meta-router · morpho vault v2</span>
        <span>every trade simulated before it is signed</span>
      </footer>
    </>
  );
}
