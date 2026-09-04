import { lede, pctBps, thesesForAgent, type LiveAgent, type LiveToken, type Thesis } from "../live";
import { MoveTicket } from "../move";
import { stampFor } from "../strategy";
import { Coin, Face, Stamp } from "../ui";
import { isWhy } from "../why";

export function Profile({
  agent,
  theses,
  tokens,
  onBack,
  onToken,
}: {
  agent: LiveAgent;
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
            <Stamp>{stampFor(agent.slug, agent.glance.id)}</Stamp>
          </div>
        </div>
        {agent.pnlBps != null && (
          <div className={`balance ${agent.pnlBps >= 0 ? "up" : "down"}`}>{pctBps(agent.pnlBps)}</div>
        )}
        {take ? <p className="hero-said">{take}</p> : null}
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

      {posts.slice(0, 8).map((t, i) => (
        <MoveTicket key={`${t.head}-${i}`} t={t} tokens={tokens} hideWho onToken={onToken} />
      ))}
    </div>
  );
}
