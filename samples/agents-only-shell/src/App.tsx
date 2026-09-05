import {
  applyTokenQuotes,
  loadTokenQuotes,
  loadSessionChanges,
} from "./quotes";
import {
  DesktopHeader,
  DesktopSidebar,
  DesktopPortfolio,
  type SidebarSection,
} from "./Desktop";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChatTurn } from "./account";
import "./profile-flow.css";
import {
  loadLive,
  seedLive,
  tokenById,
  type LiveState,
  type Screen,
  type Tab,
  type TokenTab,
} from "./live";
import { mineFor } from "./sample";
import type { StrategyId } from "./strategy";
import { Agent } from "./screens/Agent";
import { Board } from "./screens/Board";
import { Deposit } from "./screens/Deposit";
import { Feed } from "./screens/Feed";
import { Home } from "./screens/Home";
import { Limits } from "./screens/Limits";
import { Profile } from "./screens/Profile";
import { Search } from "./screens/Search";
import { Token } from "./screens/Token";
import { You } from "./screens/You";
import { TabIcon } from "./ui";

const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "feed", label: "Feed" },
  { id: "agent", label: "Agent" },
  { id: "board", label: "Board" },
  { id: "you", label: "You" },
];

const HOME_SCREEN: Screen = { kind: "tab", tab: "home" };
const desktopSnapshot = () => window.matchMedia("(min-width: 1100px)").matches;
function subscribeDesktop(onChange: () => void) {
  const media = window.matchMedia("(min-width: 1100px)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function App() {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<LiveState>(seedLive);
  const [requestedScreen, setScreen] = useState<Screen>(HOME_SCREEN);
  const [sidebarSection, setSidebarSection] =
    useState<SidebarSection>("markets");
  const desktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot);
  const [moneyMode, setMoneyMode] = useState<"deposit" | "withdraw" | null>(
    null,
  );
  const screen: Screen =
    moneyMode && !desktop
      ? { kind: moneyMode }
      : desktop &&
          requestedScreen.kind === "tab" &&
          (requestedScreen.tab === "feed" || requestedScreen.tab === "board")
        ? HOME_SCREEN
        : requestedScreen;
  const [tab, setTab] = useState<Tab>("home");
  const [tokenTab, setTokenTab] = useState<TokenTab>("buys");
  const [run] = useState<StrategyId>("steady-basket");
  const [perTrade, setPerTrade] = useState("25");
  const [perDay, setPerDay] = useState("200");
  const [stopped, setStopped] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [screen]);

  useEffect(() => {
    let alive = true;
    let refreshing = false;
    let loaded: LiveState | undefined;
    const refreshChanges = async (tokens: LiveState["tokens"]) => {
      const changes = await loadSessionChanges(tokens);
      if (alive && changes.size)
        setLive((previous) => ({
          ...previous,
          tokens: previous.tokens.map((t) =>
            changes.has(t.id) ? { ...t, change24hPct: changes.get(t.id)! } : t,
          ),
        }));
    };
    void loadLive()
      .then((data) => {
        if (!alive) return;
        loaded = data;
        setLive(data);
        void refreshChanges(data.tokens);
      })
      .catch((error) => console.error("loadLive", error));
    const refresh = async () => {
      if (!loaded || refreshing || document.hidden) return;
      refreshing = true;
      try {
        const quotes = await loadTokenQuotes();
        if (alive && quotes.size)
          setLive((previous) => ({
            ...previous,
            tokens: applyTokenQuotes(previous.tokens, quotes),
          }));
        await refreshChanges(loaded.tokens);
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 60_000);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const openScreen = (next: Screen) => {
    if (next.kind === "deposit" || next.kind === "withdraw") {
      setMoneyMode(next.kind);
      return;
    }
    setMoneyMode(null);
    setScreen(next);
  };
  const goTab = (next: Tab) => {
    setMoneyMode(null);
    if (next === "feed" || next === "board") setSidebarSection(next);
    setTab(next);
    setScreen({ kind: "tab", tab: next });
  };
  const activeTab = tab;
  const token =
    screen.kind === "token" ? tokenById(live.tokens, screen.id) : undefined;
  const agent =
    screen.kind === "profile"
      ? live.agents.find((a) => a.slug === screen.slug)
      : undefined;
  const drafted = mineFor(run);
  const mine = live.mine
    ? {
        ...drafted,
        name: live.mine.name || drafted.name,
        slug: live.mine.slug || drafted.slug,
        handle: live.mine.handle || drafted.handle,
        equity: live.mine.equity ?? drafted.equity,
        chg24: live.mine.chg24 ?? drafted.chg24,
      }
    : drafted;

  return (
    <div
      className="app"
      data-screen={screen.kind === "tab" ? screen.tab : screen.kind}
    >
      <DesktopHeader mine={mine} onScreen={openScreen} onTab={goTab} />
      {desktop && (
        <DesktopSidebar
          mine={mine}
          tokens={live.tokens}
          agents={live.agents}
          theses={live.theses}
          screen={screen}
          section={sidebarSection}
          onSection={setSidebarSection}
          onScreen={openScreen}
          onTab={goTab}
        />
      )}
      <div
        ref={bodyRef}
        className={screen.kind === "token" ? "body token-body" : "body"}
      >
        {screen.kind === "tab" && screen.tab === "home" && (
          <Home
            tokens={live.tokens}
            agents={live.agents}
            theses={live.theses}
            mine={mine}
            tokenTab={tokenTab}
            onTokenTab={setTokenTab}
            onToken={(id) => openScreen({ kind: "token", id })}
            onAgent={(slug) => openScreen({ kind: "profile", slug })}
            onDeposit={() => openScreen({ kind: "deposit" })}
            onSearch={() => openScreen({ kind: "search" })}
            onDesk={() => goTab("agent")}
          />
        )}
        {screen.kind === "tab" && screen.tab === "feed" && (
          <Feed
            theses={live.theses}
            tokens={live.tokens}
            agents={live.agents}
            onToken={(id) => openScreen({ kind: "token", id })}
            onProfile={(slug) => openScreen({ kind: "profile", slug })}
            onDesk={() => goTab("agent")}
          />
        )}
        {screen.kind === "tab" && screen.tab === "agent" && (
          <Agent
            mine={mine}
            tokens={live.tokens}
            stopped={stopped}
            turns={turns}
            draft={chatDraft}
            onDraft={setChatDraft}
            onTurn={(turn) => setTurns((previous) => [...previous, turn])}
            perTrade={perTrade}
            perDay={perDay}
            onToken={(id) => openScreen({ kind: "token", id })}
            onDeposit={() => openScreen({ kind: "deposit" })}
            onWithdraw={() => openScreen({ kind: "withdraw" })}
            onLimits={() => openScreen({ kind: "limits" })}
          />
        )}
        {screen.kind === "tab" && screen.tab === "board" && (
          <Board
            agents={live.agents}
            theses={live.theses}
            mine={mine}
            onProfile={(slug) => openScreen({ kind: "profile", slug })}
            onDesk={() => goTab("agent")}
          />
        )}
        {screen.kind === "tab" && screen.tab === "you" && (
          <You
            history={
              live.agents.find((a) => a.slug === mine?.slug)?.curve ?? []
            }
            onLimits={() => openScreen({ kind: "limits" })}
            onStop={() => setStopped((v) => !v)}
            onDesk={() => goTab("agent")}
            onDeposit={() => openScreen({ kind: "deposit" })}
            stopped={stopped}
            perTrade={perTrade}
            perDay={perDay}
            mine={mine}
          />
        )}
        {screen.kind === "token" && token && (
          <Token
            key={token.id}
            token={token}
            theses={live.theses}
            agents={live.agents}
            onBack={() => goTab(tab)}
            onProfile={(slug) => openScreen({ kind: "profile", slug })}
          />
        )}
        {screen.kind === "profile" && agent && (
          <Profile
            key={agent.slug}
            agent={agent}
            theses={live.theses}
            tokens={live.tokens}
            onBack={() => goTab(tab)}
            onToken={(id) => openScreen({ kind: "token", id })}
          />
        )}
        {screen.kind === "withdraw" && (
          <Deposit
            mode="withdraw"
            mine={mine}
            onBack={() => setMoneyMode(null)}
          />
        )}
        {screen.kind === "deposit" && (
          <Deposit mine={mine} onBack={() => setMoneyMode(null)} />
        )}
        {screen.kind === "search" && (
          <Search
            tokens={live.tokens}
            agents={live.agents}
            onBack={() => goTab(tab)}
            onToken={(id) => openScreen({ kind: "token", id })}
            onProfile={(slug) => openScreen({ kind: "profile", slug })}
          />
        )}
        {screen.kind === "limits" && (
          <Limits
            perTrade={perTrade}
            perDay={perDay}
            onSave={(trade, day) => {
              setPerTrade(trade);
              setPerDay(day);
              goTab(tab);
            }}
            onBack={() => goTab(tab)}
          />
        )}
      </div>
      {desktop && moneyMode ? (
        <aside
          className="desktop-money-panel"
          aria-label={moneyMode === "withdraw" ? "Withdraw funds" : "Add funds"}
        >
          <Deposit
            key={moneyMode}
            mode={moneyMode}
            mine={mine}
            compact
            onBack={() => setMoneyMode(null)}
          />
        </aside>
      ) : (
        <DesktopPortfolio
          selectedToken={token}
          mine={mine}
          tokens={live.tokens}
          stopped={stopped}
          perTrade={perTrade}
          perDay={perDay}
          onScreen={openScreen}
          onTab={goTab}
        />
      )}
      {screen.kind !== "deposit" &&
        screen.kind !== "withdraw" &&
        screen.kind !== "limits" && (
          <nav className="tabbar">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={activeTab === t.id ? "tab on" : "tab"}
                aria-label={t.label}
                onClick={() => goTab(t.id)}
              >
                <TabIcon id={t.id} />
              </button>
            ))}
          </nav>
        )}
    </div>
  );
}
