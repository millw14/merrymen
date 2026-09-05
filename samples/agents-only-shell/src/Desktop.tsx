import { useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Search,
  SlidersHorizontal,
  ArrowDownWideNarrow,
} from "lucide-react";
import { Coin, Face, TabIcon } from "./ui";
import {
  money,
  coinPrice,
  quoteTitle,
  pctPts,
  pctBps,
  type LiveAgent,
  type Thesis,
  type LiveMine,
  type LiveToken,
  type Screen,
  type Tab,
} from "./live";
import { positionsOf } from "./account";
import { BalanceFigure } from "./studio";
import { strategyName } from "./strategy";
import { Feed } from "./screens/Feed";
import { Board, haveOf } from "./screens/Board";

export type SidebarSection = "markets" | "agents" | "feed" | "board";
const SECTIONS: { id: SidebarSection; label: string }[] = [
  { id: "markets", label: "Markets" },
  { id: "agents", label: "Agents" },
  { id: "feed", label: "Feed" },
  { id: "board", label: "Leaderboard" },
];

type Actions = {
  onScreen: (screen: Screen) => void;
  onTab: (tab: Tab) => void;
};
export function DesktopHeader({
  mine,
  onScreen,
  onTab,
}: Actions & { mine: LiveMine }) {
  return (
    <header className="desktop-header">
      <button
        className="desktop-brand"
        onClick={() => onTab("home")}
        aria-label="Merrymen home"
      >
        <TabIcon id="agent" />
        <span>merrymen</span>
      </button>
      <button
        className="desktop-search"
        onClick={() => onScreen({ kind: "search" })}
      >
        <Search size={17} />
        <span>Search tokens or agents</span>
      </button>
      <div className="desktop-header-account">
        <span>
          <small>Available cash</small>
          <strong>{money(mine.glance.cashUsd ?? null)}</strong>
        </span>
        <button
          className="desktop-fund"
          onClick={() => onScreen({ kind: "deposit" })}
        >
          Add funds
        </button>
        <button aria-label="Your profile" onClick={() => onTab("you")}>
          <Face name={mine.name} slug={mine.slug} />
        </button>
      </div>
    </header>
  );
}
export function DesktopSidebar({
  tokens,
  agents,
  theses,
  mine,
  screen,
  section,
  onSection,
  onScreen,
  onTab,
}: Actions & {
  tokens: LiveToken[];
  agents: LiveAgent[];
  theses: Thesis[];
  mine: LiveMine;
  screen: Screen;
  section: SidebarSection;
  onSection: (section: SidebarSection) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<"name" | "change">("name");
  const held = new Set(positionsOf(mine).map((p) => p.symbol));
  const list = tokens.filter((t) => filter !== "held" || held.has(t.symbol));
  list.sort((a, b) =>
    sort === "name"
      ? a.symbol.localeCompare(b.symbol)
      : (b.change24hPct ?? -Infinity) - (a.change24hPct ?? -Infinity),
  );

  const openToken = (id: string) => onScreen({ kind: "token", id });
  const openProfile = (slug: string) => onScreen({ kind: "profile", slug });

  return (
    <aside className="desktop-sidebar" aria-label="Explore">
      <div
        className="desktop-explore-tabs"
        role="tablist"
        aria-label="Explore sections"
      >
        {SECTIONS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`explore-tab-${item.id}`}
            aria-selected={section === item.id}
            aria-controls={`explore-panel-${item.id}`}
            tabIndex={section === item.id ? 0 : -1}
            onClick={() => onSection(item.id)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "ArrowRight")
                next = (index + 1) % SECTIONS.length;
              else if (event.key === "ArrowLeft")
                next = (index + SECTIONS.length - 1) % SECTIONS.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = SECTIONS.length - 1;
              else return;
              event.preventDefault();
              const target = SECTIONS[next]!;
              onSection(target.id);
              document.getElementById(`explore-tab-${target.id}`)?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <section
        className="desktop-explore-panel"
        id="explore-panel-markets"
        role="tabpanel"
        aria-labelledby="explore-tab-markets"
        hidden={section !== "markets"}
      >
        <div className="desktop-market-heading">
          <h2>Robinhood Chain</h2>
          <span>{list.length} tokens</span>
        </div>
        <div className="desktop-market-tabs">
          <button
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All tokens
          </button>
          <button
            aria-pressed={filter === "held"}
            onClick={() => setFilter("held")}
          >
            Your holdings
          </button>
          <button
            className="desktop-sort"
            title={
              sort === "name" ? "Sort by daily change" : "Sort alphabetically"
            }
            aria-label={
              sort === "name"
                ? "Sort markets by daily change"
                : "Sort markets alphabetically"
            }
            onClick={() =>
              setSort((value) => (value === "name" ? "change" : "name"))
            }
          >
            <ArrowDownWideNarrow size={15} />
          </button>
        </div>
        <div className="desktop-market-list">
          {list.map((t) => (
            <button
              key={t.id}
              className={`desktop-market-row ${screen.kind === "token" && screen.id === t.id ? "selected" : ""}`}
              onClick={() => openToken(t.id)}
            >
              <Coin symbol={t.symbol} logo={t.logo} />
              <span>
                <strong>{t.symbol}</strong>
                <small>{t.name}</small>
              </span>
              <span>
                <strong title={quoteTitle(t)}>{coinPrice(t.priceUsd)}</strong>
                <small className={(t.change24hPct ?? 0) < 0 ? "down" : "up"}>
                  {pctPts(t.change24hPct)}
                </small>
              </span>
            </button>
          ))}
          {!list.length && <p className="meta">No tokens held yet.</p>}
        </div>
      </section>
      <section
        className="desktop-explore-panel"
        id="explore-panel-agents"
        role="tabpanel"
        aria-labelledby="explore-tab-agents"
        hidden={section !== "agents"}
      >
        <div className="desktop-market-heading">
          <h2>Your agents</h2>
          <span>1 agent</span>
        </div>
        <button className="sidebar-agent" onClick={() => onTab("agent")}>
          <Face name={mine.name} slug={mine.slug} />
          <span>
            <strong>{mine.name}</strong>
            <small>{strategyName(mine.glance.id)}</small>
          </span>
          <span>
            <strong>{money(mine.equity)}</strong>
            <small>Open chat</small>
          </span>
        </button>
        <div className="desktop-market-heading">
          <h2>Discover agents</h2>
          <span>{agents.filter((a) => a.slug !== mine.slug).length}</span>
        </div>
        <div className="desktop-market-list">
          {agents
            .filter((a) => a.slug !== mine.slug)
            .map((a) => (
              <button
                className="sidebar-agent"
                key={a.slug}
                onClick={() => openProfile(a.slug)}
              >
                <Face name={a.name} slug={a.slug} />
                <span>
                  <strong>{a.handle ?? a.name}</strong>
                  <small>{strategyName(a.glance.id)}</small>
                </span>
                <span
                  aria-label={`Return ${pctBps(a.pnlBps)}, holdings ${money(haveOf(a, theses, mine))}`}
                >
                  <strong
                    className={
                      a.pnlBps == null
                        ? ""
                        : a.pnlBps < 0
                          ? "down"
                          : a.pnlBps > 0
                            ? "up"
                            : ""
                    }
                  >
                    {pctBps(a.pnlBps)}
                  </strong>
                  <small>{money(haveOf(a, theses, mine))}</small>
                </span>
              </button>
            ))}
        </div>
      </section>
      <section
        className="desktop-explore-panel"
        id="explore-panel-feed"
        role="tabpanel"
        aria-labelledby="explore-tab-feed"
        hidden={section !== "feed"}
      >
        <Feed
          compact
          theses={theses}
          tokens={tokens}
          agents={agents}
          onToken={openToken}
          onProfile={openProfile}
          onDesk={() => onTab("agent")}
        />
      </section>
      <section
        className="desktop-explore-panel"
        id="explore-panel-board"
        role="tabpanel"
        aria-labelledby="explore-tab-board"
        hidden={section !== "board"}
      >
        <Board
          compact
          agents={agents}
          theses={theses}
          mine={mine}
          onProfile={openProfile}
          onDesk={() => onTab("agent")}
        />
      </section>
    </aside>
  );
}
export function DesktopPortfolio({
  selectedToken,
  mine,
  tokens,
  stopped,
  perTrade,
  perDay,
  onScreen,
  onTab,
}: Actions & {
  mine: LiveMine;
  selectedToken?: LiveToken;
  tokens: LiveToken[];
  stopped: boolean;
  perTrade: string;
  perDay: string;
}) {
  return (
    <aside className="desktop-portfolio" aria-label="Your portfolio">
      <section>
        <div className="desktop-section-heading">
          <h2>Your agent</h2>
          <span className={`desktop-running ${stopped ? "paused" : ""}`}>
            {stopped ? "Paused" : "Running"}
          </span>
        </div>
        <button className="desktop-agent-id" onClick={() => onTab("agent")}>
          <Face name={mine.name} slug={mine.slug} />
          <span>
            <strong>{mine.name}</strong>
            <small>{strategyName(mine.glance.id)}</small>
          </span>
          <ArrowUpRight size={16} />
        </button>
        <div className="desktop-balance">
          <BalanceFigure value={mine.equity} />
        </div>
        <p className={(mine.chg24 ?? 0) < 0 ? "down" : "up"}>
          {mine.chg24 == null
            ? "—"
            : `${mine.chg24 < 0 ? "−" : "+"}${money(Math.abs(mine.chg24))} today`}
        </p>
        <div className="desktop-money-actions">
          <button onClick={() => onScreen({ kind: "deposit" })}>
            <ArrowDownLeft size={15} />
            Add funds
          </button>
          <button onClick={() => onScreen({ kind: "withdraw" })}>
            <ArrowUpRight size={15} />
            Withdraw
          </button>
        </div>
        <div className="desktop-cash">
          <span>Available cash</span>
          <strong>{money(mine.glance.cashUsd ?? null)}</strong>
        </div>
      </section>
      {selectedToken && (
        <section className="desktop-token-context">
          <div className="desktop-section-heading">
            <h2>About {selectedToken.symbol}</h2>
            <Coin symbol={selectedToken.symbol} logo={selectedToken.logo} />
          </div>
          <p>{selectedToken.name}</p>
          <div className="desktop-cash">
            <span>Asset</span>
            <strong>
              {selectedToken.kind === "etf"
                ? "Tokenized ETF"
                : selectedToken.kind === "memecoin"
                  ? "Token"
                  : "Tokenized stock"}
            </strong>
          </div>
          <div className="desktop-cash">
            <span>Session change</span>
            <strong
              className={(selectedToken.change24hPct ?? 0) < 0 ? "down" : "up"}
            >
              {pctPts(selectedToken.change24hPct)}
            </strong>
          </div>
          <div className="desktop-cash">
            <span>Your position</span>
            <strong>
              {positionsOf(mine).find((p) => p.symbol === selectedToken.symbol)
                ?.detail ?? "Not held"}
            </strong>
          </div>
        </section>
      )}
      <section>
        <div className="desktop-section-heading">
          <h2>Positions</h2>
          <span>{positionsOf(mine).length}</span>
        </div>
        {positionsOf(mine).map((p) => {
          const t = tokens.find((t) => t.symbol === p.symbol);
          return (
            <button
              key={p.symbol}
              className="desktop-position"
              disabled={!t}
              onClick={() => t && onScreen({ kind: "token", id: t.id })}
            >
              <Coin symbol={p.symbol} logo={t?.logo ?? ""} />
              <strong>{p.symbol}</strong>
              <span className={p.pnl == null ? "" : p.pnl < 0 ? "down" : "up"}>
                {p.pnl == null ? p.detail : pctPts(p.pnl)}
              </span>
            </button>
          );
        })}
      </section>
      <section>
        <div className="desktop-section-heading">
          <h2>Trading limits</h2>
          <button
            aria-label="Edit trading limits"
            onClick={() => onScreen({ kind: "limits" })}
          >
            <SlidersHorizontal size={16} />
          </button>
        </div>
        <div className="desktop-cash">
          <span>Per trade</span>
          <strong>{money(Number(perTrade))}</strong>
        </div>
        <div className="desktop-cash">
          <span>Per day</span>
          <strong>{money(Number(perDay))}</strong>
        </div>
        <button className="desktop-chat-link" onClick={() => onTab("agent")}>
          Chat with {mine.name}
          <ArrowUpRight size={15} />
        </button>
      </section>
    </aside>
  );
}
