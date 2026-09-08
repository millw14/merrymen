import { Board } from "./Board";
import { PerformanceChart } from "../DitherChart";
import { useState } from "react";
import { Search } from "lucide-react";
import {
  coinPrice,
  quoteTitle,
  money,
  pctBps,
  pctPts,
  type LiveAgent,
  type LiveMine,
  type LiveToken,
  type Thesis,
  type TokenTab,
  deltaClass,
} from "../live";
import { Coin, Face, NameBlock, Pill } from "../ui";

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
  read,
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
  /** Whether the leaderboard READ landed — quiet and unreadable are different. */
  read: import("../live").ReadState;
}) {
  // A count we do not have sorts last and filters out — it is not a zero, but
  // it is also not evidence that anybody bought anything, so an unread row does
  // not get to sit at the top of "most bought".
  const [showAll, setShowAll] = useState(false);
  const count = (n: number | null) => n ?? 0;
  /**
   * COINS ABOVE STOCKS, everywhere this screen ranks anything.
   *
   * An admin's words: "can we show memecoins first instead of stocks? nobody
   * here is trading stocks." They were right, and it was deliberately NOT done
   * at the time, for a reason worth keeping written down: the memecoin path did
   * not exist, so putting a coin at the top would have advertised something the
   * product could not do. An owner who tapped one found an asset their agent
   * was structurally unable to buy, with no route to changing that.
   *
   * That is no longer true. The wall can cover a curve coin, the default
   * strategy trades one when the equity feeds are shut, and the agent proposes
   * the ones it has vetted with a one-tap path to watching and signing them. So
   * the ordering can now say what the room is actually here for.
   *
   * A SORT KEY, NOT A FILTER. Stocks are still listed, still ranked among
   * themselves, and an owner whose basket is equities loses nothing — this
   * decides what the top of the table is, not what the table contains.
   */
  const coinFirst = (a: { kind: string }, b: { kind: string }) =>
    Number(b.kind === "memecoin") - Number(a.kind === "memecoin");
  const list =
    tokenTab === "buys"
      ? [...tokens]
          .filter((t) => count(t.buys) > 0 || t.cast.length > 0)
          .sort((a, b) => coinFirst(a, b) || count(b.buys) - count(a.buys))
      : [...tokens]
          .filter((t) => count(t.agents) > 0 || t.cast.length > 0)
          .sort(
            (a, b) =>
              coinFirst(a, b) ||
              count(b.agents) - count(a.agents) ||
              (b.holders ?? 0) - (a.holders ?? 0),
          );
  // THE FALLBACK IS WHAT THE ROOM ACTUALLY SEES. Nothing has traded, so both
  // ranked lists are empty and this is the table on the screen — which is
  // exactly where a wall of untraded stocks was being shown to people who came
  // for coins.
  const shown =
    list.length > 0
      ? list
      : [...tokens]
          .sort((a, b) => coinFirst(a, b) || (b.change24hPct ?? 0) - (a.change24hPct ?? 0))
          .slice(0, 8);

  const visibleTokens = showAll ? shown : shown.slice(0, 8);
  const eq = mine?.equity ?? null;
  const chg = mine?.chg24 ?? null;
  const [whole, frac] = money(eq).replace("$", "").split(".");

  return (
    <div className="home-page">
      <header className="top home-overview">
        <div className="home-heading"><h1 className="top-title">Home</h1></div>

        {mine ? (
          <button type="button" className="hero" onClick={onDesk}>
            <div className="hero-who">
              <Face name={mine.name} slug={mine.slug} />
              <NameBlock title={mine.name} owner={mine.owner ?? "you"} />
            </div>
            <span className="home-balance-label">Portfolio balance</span>
              <div className="balance">
                {eq === null ? "—" : `$${whole}`}
                {frac !== undefined && <sup>.{frac}</sup>}
              </div>
            {chg !== null && (
              <p className={`chg-24 ${chg < 0 ? "down" : "up"}`}>
                {chg < 0 ? "−" : "+"}${Math.abs(chg).toFixed(2)} today
              </p>
            )}
          </button>
        ) : (
          <div className="hero empty">
            <h2>This one trades.</h2>
          </div>
        )}
        <button type="button" className="home-deposit" onClick={onDeposit}>{mine ? "Deposit" : "Set up your agent"}<span aria-hidden="true">↗</span></button>
        {mine && (
          <PerformanceChart
            balance values={mine.history ?? []}
            height={56}
          />
        )}
      </header>

      {/*
        THE LEADERBOARD, NOT A SECOND COPY OF IT.

        This was a "Wins" strip ranking `agent.pnlBps` — the identical quantity
        Board ranks, under a different heading, two taps away. With the board
        tab retired into Home they would have been the same list twice on one
        screen.

        Mounted rather than reimplemented on purpose: Board carries the
        unreadable-vs-quiet distinction through ReadEmpty, and honesty.test.ts
        pins that by reading Board.tsx. A local reimplementation would pass that
        test and lose the property — which is the exact shape of bug the test
        exists to catch.
      */}
      <Board
        preview
        read={read}
        agents={agents}
        theses={theses}
        mine={mine}
        onProfile={onAgent}
        onDesk={onDeposit}
      />

      <section className="home-markets">
        <div className="home-market-heading"><h2 className="week-label">Market activity</h2><button type="button" className="icon-btn" aria-label="Search tokens or agents" onClick={onSearch}><Search size={22}/></button></div>
        <div className="pills">
          <Pill on={tokenTab === "buys"} onClick={() => {setShowAll(false);onTokenTab("buys");}}>
            Buying
          </Pill>
          <Pill on={tokenTab === "held"} onClick={() => {setShowAll(false);onTokenTab("held");}}>
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
              {visibleTokens.map((t) => (
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
                  {/* "—" until the ledger answers. Zero agents and an unread
                      ledger are different facts about a listed instrument. */}
                  <td>{t.agents ?? "—"}</td>
                  <td title={quoteTitle(t)}>{coinPrice(t.priceUsd)}</td>
                  <td className={deltaClass(t.change24hPct)}>
                    {pctPts(t.change24hPct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="home-mobile-market">
          {visibleTokens.map((t) => {
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
        {shown.length > 8 && <button className="home-show-more" onClick={()=>setShowAll(value=>!value)}>{showAll ? "Show fewer tokens" : `Show all ${shown.length} tokens`}</button>}
      </section>
    </div>
  );
}
