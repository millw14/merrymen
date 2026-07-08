import { AgentCard } from "@/components/AgentCard";
import { ChainStats } from "@/components/ChainStats";
import { MarketTable } from "@/components/MarketTable";
import { AGENTS, FEED } from "@/lib/mock";

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
        <button className="connect-btn">connect</button>
      </header>

      <main className="shell">
        <section className="agents">
          <div className="section-title">the band · {AGENTS.length} agents</div>
          <div className="agent-grid">
            {AGENTS.map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
          </div>

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
            <div className="feed">
              {FEED.map((l, i) => (
                <div key={i} className="feed-line">
                  <span className="feed-time">{l.time}</span>
                  <span>
                    <b>{l.agent}</b>{" "}
                    <span className={l.kind}>{l.text}</span>
                  </span>
                </div>
              ))}
            </div>
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
