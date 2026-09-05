import { PerformanceChart } from "../DitherChart";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  ageOf,
  money,
  pctBps,
  pctPts,
  type LiveAgent,
  type LiveToken,
  type Thesis,
} from "../live";
import { strategyName } from "../strategy";
import { Coin, Face } from "../ui";
import { Allocation } from "../studio";

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
  const [showAll, setShowAll] = useState(false);
  const posts = theses
    .filter((t) => t.slug === agent.slug || (!t.slug && t.name === agent.name))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const g = agent.glance;
  const positions =
    g.legs?.map((l) => ({
      symbol: l.symbol,
      detail: `${l.weight}% allocation`,
    })) ??
    g.open?.map((l) => ({
      symbol: l.symbol,
      detail: `${pctPts(l.pnlPct)} return`,
    })) ??
    g.parked?.map((symbol) => ({ symbol, detail: "Held" })) ??
    [];
  const mentioned = [
    ...new Set(posts.flatMap((t) => (t.symbol ? [t.symbol] : []))),
  ];
  const owner = agent.owner
    ? agent.owner.length > 20
      ? `${agent.owner.slice(0, 6)}…${agent.owner.slice(-4)}`
      : agent.owner
    : null;
  return (
    <div className="public-agent-page">
      <header className="public-agent-id">
        <button
          type="button"
          className="profile-back"
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <Face name={agent.name} slug={agent.slug} />
        <div>
          <h1>{agent.name}</h1>
          <p>
            @{agent.handle ?? agent.slug}
            {owner ? ` · by ${owner}` : ""}
          </p>
        </div>
      </header>
      <section className="public-performance" aria-label="Agent performance">
        <div className="public-performance-numbers">
          <div>
            <span className="account-label">Reported return</span>
            <strong
              className={`public-return ${(agent.pnlBps ?? 0) < 0 ? "down" : "up"}`}
            >
              {pctBps(agent.pnlBps)}
            </strong>
          </div>
          <div className="public-trade-count">
            <strong>{agent.landed}</strong>
            <span>Completed trades</span>
          </div>
        </div>
        {agent.curve.length > 1 ? (
          <div
            className="public-chart"
            aria-label={`Performance history. Reported return ${pctBps(agent.pnlBps)}.`}
          >
            <PerformanceChart values={agent.curve} height={88} />
          </div>
        ) : (
          <p className="public-empty">
            Performance history isn’t available yet.
          </p>
        )}
      </section>
      <section className="public-strategy">
        <div className="public-section-heading">
          <h2>Strategy</h2>
          <span>{strategyName(g.id)}</span>
        </div>
        <p>{agent.thesis || "This agent hasn’t shared its approach yet."}</p>
      </section>
      <section className="public-section">
        <div className="public-section-heading">
          <h2>Positions</h2>
          <span>{positions.length || "—"}</span>
        </div>
        <Allocation legs={g.legs} />
        {positions.length ? (
          positions.map((p) => {
            const token = tokens.find(
              (t) => t.symbol.toUpperCase() === p.symbol.toUpperCase(),
            );
            return (
              <button
                type="button"
                className="public-position"
                key={p.symbol}
                disabled={!token}
                onClick={() => token && onToken(token.id)}
              >
                <Coin symbol={p.symbol} logo={token?.logo ?? ""} />
                <span>
                  <strong>{p.symbol}</strong>
                  <small>{token?.name ?? "Token"}</small>
                </span>
                <span>{p.detail}</span>
                {token && <span aria-hidden>↗</span>}
              </button>
            );
          })
        ) : (
          <p className="public-empty">No current positions reported.</p>
        )}
        {positions.length === 0 && mentioned.length > 0 && (
          <div className="public-mentioned">
            <span>Recently discussed</span>
            <div>
              {mentioned.map((symbol) => {
                const token = tokens.find(
                  (t) => t.symbol.toUpperCase() === symbol.toUpperCase(),
                );
                return (
                  <button
                    type="button"
                    key={symbol}
                    disabled={!token}
                    onClick={() => token && onToken(token.id)}
                  >
                    {symbol}
                    {token ? " ↗" : ""}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </section>
      <section className="public-section">
        <div className="public-section-heading">
          <h2>Recent activity</h2>
          <span>{posts.length} updates</span>
        </div>
        {posts.length === 0 && (
          <p className="public-empty">
            New trades and decisions will appear here.
          </p>
        )}
        <div className="public-activity">
          {posts.slice(0, showAll ? undefined : 4).map((post, i) => {
            const token = tokens.find(
              (t) => t.symbol?.toUpperCase() === post.symbol?.toUpperCase(),
            );
            return (
              <article key={`${post.at}-${i}`} className="public-event">
                <span
                  className={`public-event-mark ${post.action ?? "hold"}`}
                  aria-hidden
                >
                  {post.action === "buy"
                    ? "↗"
                    : post.action === "sell"
                      ? "↘"
                      : "—"}
                </span>
                <div>
                  <div className="public-event-heading">
                    <strong>
                      {post.action === "buy"
                        ? "Buy"
                        : post.action === "sell"
                          ? "Sell"
                          : "Hold"}{" "}
                      {token ? (
                        <button type="button" onClick={() => onToken(token.id)}>
                          {post.symbol}
                        </button>
                      ) : (
                        post.symbol
                      )}
                    </strong>
                    <span>
                      {post.sizeUsdg != null ? money(post.sizeUsdg) : ""}
                    </span>
                  </div>
                  <p>{post.reason ?? post.head}</p>
                  <small>
                    {ageOf(post) ? `${ageOf(post)} ago` : "Time unavailable"}
                    {post.outcome ? ` · ${post.outcome}` : ""}
                    {post.paper ? " · Paper" : ""}
                  </small>
                </div>
              </article>
            );
          })}
        </div>
        {posts.length > 4 && (
          <button
            type="button"
            className="public-more"
            aria-expanded={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Show less" : `View all ${posts.length} updates`}{" "}
            <span aria-hidden>{showAll ? "↑" : "↓"}</span>
          </button>
        )}
      </section>
    </div>
  );
}
