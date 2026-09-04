import { useEffect, useState } from "react";
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

export function App() {
  const [live, setLive] = useState<LiveState>(seedLive);
  const [screen, setScreen] = useState<Screen>({ kind: "tab", tab: "home" });
  const [tab, setTab] = useState<Tab>("home");
  const [tokenTab, setTokenTab] = useState<TokenTab>("buys");
  const [run, setRun] = useState<StrategyId>("steady-basket");
  const [perTrade, setPerTrade] = useState("25");
  const [perDay, setPerDay] = useState("200");
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadLive()
      .then((d) => {
        if (alive) setLive(d);
      })
      .catch((err) => {
        console.error("loadLive", err);
      });
    return () => {
      alive = false;
    };
  }, []);

  const goTab = (next: Tab) => {
    setTab(next);
    setScreen({ kind: "tab", tab: next });
  };
  const activeTab = tab;
  const token = screen.kind === "token" ? tokenById(live.tokens, screen.id) : undefined;
  const agent = screen.kind === "profile" ? live.agents.find((a) => a.slug === screen.slug) : undefined;
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
    <div className="app">
      <div className={screen.kind === "token" ? "body token-body" : "body"}>
        {screen.kind === "tab" && screen.tab === "home" && (
          <Home
            tokens={live.tokens}
            mine={mine}
            tokenTab={tokenTab}
            onTokenTab={setTokenTab}
            onToken={(id) => setScreen({ kind: "token", id })}
            onDeposit={() => setScreen({ kind: "deposit" })}
            onSearch={() => setScreen({ kind: "search" })}
            onDesk={() => goTab("agent")}
          />
        )}
        {screen.kind === "tab" && screen.tab === "feed" && (
          <Feed
            theses={live.theses}
            tokens={live.tokens}
            agents={live.agents}
            onToken={(id) => setScreen({ kind: "token", id })}
            onProfile={(slug) => setScreen({ kind: "profile", slug })}
          />
        )}
        {screen.kind === "tab" && screen.tab === "agent" && (
          <Agent
            mine={mine}
            tokens={live.tokens}
            onToken={(id) => setScreen({ kind: "token", id })}
            onDeposit={() => setScreen({ kind: "deposit" })}
          />
        )}
        {screen.kind === "tab" && screen.tab === "board" && (
          <Board
            agents={live.agents}
            onProfile={(slug) => setScreen({ kind: "profile", slug })}
          />
        )}
        {screen.kind === "tab" && screen.tab === "you" && (
          <You
            onLimits={() => setScreen({ kind: "limits" })}
            onStop={() => setStopped((v) => !v)}
            onDesk={() => goTab("agent")}
            stopped={stopped}
            perTrade={perTrade}
            perDay={perDay}
            mine={mine}
            run={run}
            onRun={setRun}
          />
        )}
        {screen.kind === "token" && token && (
          <Token
            token={token}
            theses={live.theses}
            agents={live.agents}
            onBack={() => goTab(tab)}
            onProfile={(slug) => setScreen({ kind: "profile", slug })}
          />
        )}
        {screen.kind === "profile" && agent && (
          <Profile
            agent={agent}
            theses={live.theses}
            tokens={live.tokens}
            onBack={() => goTab(tab)}
            onToken={(id) => setScreen({ kind: "token", id })}
          />
        )}
        {screen.kind === "deposit" && <Deposit onBack={() => goTab("home")} />}
        {screen.kind === "search" && (
          <Search
            tokens={live.tokens}
            agents={live.agents}
            onBack={() => goTab(tab)}
            onToken={(id) => setScreen({ kind: "token", id })}
            onProfile={(slug) => setScreen({ kind: "profile", slug })}
          />
        )}
        {screen.kind === "limits" && (
          <Limits
            perTrade={perTrade}
            perDay={perDay}
            onSave={(trade, day) => {
              setPerTrade(trade);
              setPerDay(day);
              goTab("you");
            }}
            onBack={() => goTab("you")}
          />
        )}
      </div>
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
    </div>
  );
}
