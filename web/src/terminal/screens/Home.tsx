import { PerformanceChart } from "../DitherChart";
import { useMemo } from "react";
import { curveReturn } from "../beat";
import {
  coinPrice,
  quoteTitle,
  money,
  pctBps,
  pctPts,
  sizeOf,
  type LiveAgent,
  type LiveMine,
  type LiveToken,
  type Thesis,
  type TokenTab,
} from "../live";
import { Coin, Face, NameBlock, Pill, TopBar } from "../ui";

const WEEK = 8;

export function Home({
  tokens,
  agents,
  theses,
  mine,
  tokenTab,
  onTokenTab,
  onToken,
  onAgent,
  onDeposit,
  onSearch,
  onDesk,
}: {
  tokens: LiveToken[];
  agents: LiveAgent[];
  theses: Thesis[];
  mine: LiveMine | null;
  tokenTab: TokenTab;
  onTokenTab: (tab: TokenTab) => void;
  onToken: (id: string) => void;
  onAgent: (slug: string) => void;
  onDeposit: () => void;
  onSearch: () => void;
  onDesk: () => void;
}) {
  const list =
    tokenTab === "buys"
      ? [...tokens]
          .filter((t) => t.buys > 0 || t.cast.length > 0)
          .sort((a, b) => b.buys - a.buys)
      : [...tokens]
          .filter((t) => t.agents > 0 || t.cast.length > 0)
          .sort(
            (a, b) =>
              b.agents - a.agents || (b.holders ?? 0) - (a.holders ?? 0),
          );
  const shown =
    list.length > 0
      ? list
      : [...tokens]
          .sort((a, b) => (b.change24hPct ?? 0) - (a.change24hPct ?? 0))
          .slice(0, 8);

  const wins = useMemo(
    () => weekWins(agents, theses, mine),
    [agents, theses, mine],
  );
  const eq = mine?.equity ?? null;
  const chg = mine?.chg24 ?? null;
  const [whole, frac] = money(eq).replace("$", "").split(".");

  return (
    <>
      <header className="top">
        <TopBar onSearch={onSearch} onDeposit={onDeposit} />

        {mine ? (
          <button type="button" className="hero" onClick={onDesk}>
            <div className="hero-who">
              <Face name={mine.name} slug={mine.slug} />
              <NameBlock title={mine.name} owner={mine.owner ?? "you"} />
            </div>
            {eq !== null && (
              <div className="balance">
                ${whole}
                {frac !== undefined && <sup>.{frac}</sup>}
              </div>
            )}
            {chg !== null && (
              <p className={`chg-24 ${chg < 0 ? "down" : "up"}`}>
                {chg < 0 ? "−" : "+"}${Math.abs(chg).toFixed(2)} today
              </p>
            )}
          </button>
        ) : (
          <div className="hero empty">
            <h1>This one trades.</h1>
            <button type="button" className="fund solid" onClick={onDeposit}>
              Fund an agent
            </button>
          </div>
        )}
        {mine && (
          <PerformanceChart
            balance values={mine.history ?? []}
            height={56}
          />
        )}
      </header>

      {wins.length > 0 && (
        <section className="week-block">
          <h2 className="week-label">Wins</h2>
          <div className="week">
            {wins.map((w) => (
              <button
                key={w.agent.slug}
                type="button"
                className="week-card"
                onClick={() => onAgent(w.agent.slug)}
              >
                <span className="week-who">
                  <Face name={w.agent.name} slug={w.agent.slug} />
                  <strong>{w.agent.handle ?? w.agent.name}</strong>
                </span>
                <b className="up">{pctBps(w.ret)}</b>
                <em>Reported return</em>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="pills">
          <Pill on={tokenTab === "buys"} onClick={() => onTokenTab("buys")}>
            Buying
          </Pill>
          <Pill on={tokenTab === "held"} onClick={() => onTokenTab("held")}>
            Held
          </Pill>
        </div>
        <div className="desktop-home-table-wrap">
          <table className="desktop-home-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>{tokenTab === "buys" ? "Agents buying" : "Held by"}</th>
                <th>Agents</th>
                <th>Price</th>
                <th>Session change</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id}>
                  <td>
                    <button
                      className="home-token-link"
                      onClick={() => onToken(t.id)}
                    >
                      <Coin symbol={t.symbol} logo={t.logo} />
                      <span>
                        <strong>{t.symbol}</strong>
                        <small>{t.name}</small>
                      </span>
                    </button>
                  </td>
                  <td>
                    <div className="home-agent-links">
                      {t.cast.slice(0, 3).map((a) => (
                        <button key={a.slug} onClick={() => onAgent(a.slug)}>
                          <Face name={a.name} slug={a.slug} small />
                          <span>{a.handle ?? a.name}</span>
                        </button>
                      ))}
                    </div>
                  </td>
                  <td>{t.agents}</td>
                  <td title={quoteTitle(t)}>{coinPrice(t.priceUsd)}</td>
                  <td className={(t.change24hPct ?? 0) < 0 ? "down" : "up"}>
                    {pctPts(t.change24hPct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="home-mobile-market">
          {shown.map((t) => {
            const chgPct = t.change24hPct;
            const who = t.cast.slice(0, 3);
            return (
              <button
                key={t.id}
                type="button"
                className="tok"
                onClick={() => onToken(t.id)}
              >
                <Coin symbol={t.symbol} logo={t.logo} />
                <div>
                  <strong>{t.symbol}</strong>
                  {who.length > 0 ? (
                    <p className="meta cast">
                      <span className="faces">
                        {who.map((a) => (
                          <Face
                            key={a.slug}
                            name={a.name}
                            slug={a.slug}
                            small
                          />
                        ))}
                      </span>
                      {who.map((a) => a.handle ?? a.name).join(", ")}
                      {t.cast.length > who.length
                        ? ` +${t.cast.length - who.length}`
                        : ""}
                    </p>
                  ) : (
                    <p className="meta">{t.name}</p>
                  )}
                </div>
                <div className="px">
                  {coinPrice(t.priceUsd)}
                  {chgPct != null && (
                    <small className={chgPct >= 0 ? "up" : "down"}>
                      {pctPts(chgPct)}
                    </small>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}

function weekWins(
  agents: LiveAgent[],
  theses: Thesis[],
  mine: LiveMine | null,
): { agent: LiveAgent; ret: number; made: null }[] {
  return agents
    .map((agent) => {
      const n = Math.min(WEEK, agent.curve.length);
      const ret = agent.pnlBps;
      const have = mine?.slug === agent.slug ? mine.equity : null;
      const made: null = null;
      return { agent, ret, made };
    })
    .filter(
      (w): w is { agent: LiveAgent; ret: number; made: null } =>
        w.ret != null && w.ret > 0,
    )
    .sort((a, b) => b.ret - a.ret)
    .slice(0, 8);
}
