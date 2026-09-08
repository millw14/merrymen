import { useRef, useState } from "react";
import Link from "next/link";
import { useWatchlist } from "./watchlist";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Search,
  SlidersHorizontal,
  ArrowDownWideNarrow,
  ChevronDown,
} from "lucide-react";
import { Coin, Face, LogoMark, TabIcon } from "./ui";
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
  deltaClass,
  type LiveState,
} from "./live";
import { positionsOf } from "./account";
import { BalanceFigure } from "./studio";
import { strategyName } from "./strategy";
import { tradeLine } from "./screens/Board";

export type SidebarSection = "markets" | "agents";
const SECTIONS: { id: SidebarSection; label: string }[] = [
  { id: "markets", label: "Markets" },
  { id: "agents", label: "Agents" },
];

type Actions = {
  onScreen: (screen: Screen) => void;
  onTab: (tab: Tab) => void;
};
export function DesktopHeader({
  mine,
  hasAgent = true,
  onScreen,
  onTab,
}: Actions & { hasAgent?: boolean; mine: LiveMine }) {
  const accountMenu = useRef<HTMLDetailsElement>(null);
  const closeAccountMenu = () => { if(accountMenu.current) accountMenu.current.open = false; };
  return (
    <header className="desktop-header">
      <button
        className="desktop-brand"
        onClick={() => onTab("feed")}
        aria-label="Merrymen feed"
      >
        {/*
          THE BRAND IS NOT A TAB. It borrowed the tab bar's icon for `agent`,
          which happened to be the logo — so moving the logo to the feed tab
          would have turned the desktop wordmark into a speech bubble, with
          nothing failing to compile and no test noticing.
        */}
        <LogoMark size={15} />
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
        <Link className="desktop-settings-link" href="/settings">Settings</Link>
        <span>
          <small>Available cash</small>
          <strong>{money(mine.glance.cashUsd ?? null)}</strong>
        </span>
        <button
          className="desktop-fund"
          onClick={() => onScreen({ kind: "deposit" })}
        >
          {hasAgent ? "Add funds" : "Your account"}
        </button>
        <details className="desktop-account-menu" ref={accountMenu} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))closeAccountMenu();}} onKeyDown={event=>{if(event.key==="Escape"){closeAccountMenu();accountMenu.current?.querySelector("summary")?.focus();}}}>
          <summary><Face name={mine.name} slug={mine.slug}/><span>Account</span><ChevronDown size={14}/></summary>
          <nav aria-label="Account navigation" onClick={closeAccountMenu}>
            <Link href="/you">Portfolio</Link>
            <Link href="/settings">Settings</Link>
            <Link href="/grant">Wallet & permissions</Link>
            <Link href="/limits">Trading limits</Link>
            {!hasAgent && <Link href="/create">Create an agent</Link>}
          </nav>
        </details>
      </div>
    </header>
  );
}
export function DesktopSidebar({
  tokens,
  agents,
  theses,
  mine,
  hasAgent = true,
  screen,
  section,
  onSection,
  onScreen,
  onTab,
  reads,
}: Actions & {
  /** Whether each read happened — an empty list is not automatically a quiet one. */
  reads: LiveState["reads"];
  tokens: LiveToken[];
  agents: LiveAgent[];
  theses: Thesis[];
  mine: LiveMine;
  hasAgent?: boolean;
  screen: Screen;
  section: SidebarSection;
  onSection: (section: SidebarSection) => void;
}) {
  const [filter, setFilter] = useState("all");
  const watchlist = useWatchlist();
  const [sort, setSort] = useState<"name" | "change">("name");
  const held = new Set(positionsOf(mine).map((p) => p.symbol));
  const list = tokens.filter((t) => filter === "held" ? held.has(t.symbol) : filter === "watch" ? watchlist.ids.includes(t.id) : true);
  list.sort((a, b) =>
    sort === "name"
      ? a.symbol.localeCompare(b.symbol)
      : (b.change24hPct ?? -Infinity) - (a.change24hPct ?? -Infinity),
  );

  const openToken = (id: string) => onScreen({ kind: "token", id });
  const openProfile = (slug: string) => onScreen({ kind: "profile", slug });

  return (
    <aside className="desktop-sidebar" aria-label="Explore">
      <div className="desktop-explore-row">
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
      <Link className="desktop-explore-link" href="/" aria-current={screen.kind === "tab" && screen.tab === "feed" ? "page" : undefined}>Feed</Link>
      <Link className="desktop-explore-link" href="/leaderboard">Leaderboard</Link>
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
          <span>{list.length} {list.length === 1 ? "token" : "tokens"}</span>
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
          <button aria-pressed={filter === "watch"} onClick={() => setFilter("watch")}>Watchlist</button>
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
                <small className={deltaClass(t.change24hPct)}>
                  {pctPts(t.change24hPct)}
                </small>
              </span>
            </button>
          ))}
          {/* "Markets are unavailable" is a claim about the venue; "we have not
              asked yet" and "we asked and could not be told" are claims about
              us. The list is seeded from the canonical registry, so an empty
              one under the "all" filter really does mean a failed read — but it
              still has to say which kind. */}
          {!list.length && (
            <p className="meta">
              {filter === "watch"
                ? "Watch a token to find it here."
                : filter === "held"
                  ? "No tokens held yet."
                  : reads.market === "unread"
                    ? "Loading markets…"
                    : reads.market === "unreadable"
                      ? "Couldn’t read the market list just now."
                      : "No tokens are listed."}
            </p>
          )}
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
          <span>{hasAgent ? "1 agent" : "0 agents"}</span>
        </div>
        {hasAgent && <button className="sidebar-agent" onClick={() => onTab("agent")}>
          <Face name={mine.name} slug={mine.slug} />
          <span>
            <strong>{mine.name}</strong>
            <small>{strategyName(mine.glance.id)}</small>
          </span>
          <span>
            <strong>{money(mine.equity)}</strong>
            <small>Open chat</small>
          </span>
        </button>}
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
                  {/*
                    WHAT IT HAS DONE, not what we cannot tell you. This read
                    "Strategy not published" on every row — one hard-coded
                    constant (publicGlance) printed once per agent, which no
                    change to any agent could ever alter. See tradeLine.
                  */}
                  <small>{tradeLine(a)}</small>
                </span>
                <span aria-label={`Return ${pctBps(a.pnlBps)}, ${tradeLine(a)}`}>
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
                </span>
              </button>
            ))}
        </div>
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
            {mine.statusLabel ?? "Offline"}
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
        <p className={deltaClass(mine.chg24)}>
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
              className={deltaClass(selectedToken.change24hPct)}
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
