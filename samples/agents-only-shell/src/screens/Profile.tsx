import { lede, pctBps, thesesForAgent, type LiveAgent, type LiveToken, type Thesis } from "../live";
import { MoveWire } from "../move";
import { strategyName } from "../strategy";
import { Coin, Face, Spark, Stamp } from "../ui";
import { isWhy } from "../why";

export function Profile({
  agent,
  agents,
  theses,
  tokens,
  onBack,
  onToken,
}: {
  agent: LiveAgent;
  agents: LiveAgent[];
  theses: Thesis[];
  tokens: LiveToken[];
  onBack: () => void;
  onToken: (id: string) => void;
}) {
  const posts = thesesForAgent(theses, agent.slug, agent.name);
  const held = [...new Set(posts.filter((p) => p.symbol && p.action !== "sell").map((p) => p.symbol!))];
  const take = agent.thesis && isWhy(agent.thesis) ? lede(agent.thesis) : "";

  return (
    <div className="visit-page">
      <button type="button" className="back" onClick={onBack} aria-label="Back">
        ←
      </button>
      <header className="visit">
        <div className="visit-who">
          <Face name={agent.name} slug={agent.slug} large />
          <div className="held-id">
            <strong>{agent.handle ?? agent.name}</strong>
            <Stamp>{strategyName(agent.glance.id)}</Stamp>
          </div>
        </div>
        {agent.pnlBps != null && (
          <div className={`balance ${agent.pnlBps >= 0 ? "up" : "down"}`}>{pctBps(agent.pnlBps)}</div>
        )}
        <p className="visit-count">{agent.landed} trades so far.</p>
        {take ? <p className="hero-said">{take}</p> : null}
        {agent.curve.length > 1 && <Spark values={agent.curve} down={(agent.pnlBps ?? 0) < 0} />}
      </header>

      {held.length > 0 && (
        <div className="book">
          {held.map((sym) => {
            const tok = tokens.find((x) => x.symbol.toUpperCase() === sym.toUpperCase());
            return (
              <button key={sym} type="button" className="book-coin" onClick={() => tok && onToken(tok.id)}>
                <Coin symbol={sym} logo={tok?.logo ?? ""} />
                <span>{sym}</span>
              </button>
            );
          })}
        </div>
      )}

      <MoveWire posts={posts.slice(0, 10)} agents={agents} tokens={tokens} onToken={onToken} />
    </div>
  );
}
