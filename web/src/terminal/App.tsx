"use client";
import { usePathname, useRouter } from "next/navigation";
import { AccountEntry, FundingPanel, LimitsPanel, requestJson, type AccountState } from "./HostedControls";
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
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChatTurn } from "./account";
import {
  loadLive,
  seedLive,
  tokenById,
  type LiveState,
  type Screen,
  type Tab,
  type TokenTab,
} from "./live";

import { Agent } from "./screens/Agent";
import { Board } from "./screens/Board";

import { Feed } from "./screens/Feed";
import { Home } from "./screens/Home";
import { CreateAgent } from "./screens/CreateAgent";
import Settings from "./screens/Settings";
import Wallet from "./screens/Wallet";

import { Profile } from "./screens/Profile";
import { Search } from "./screens/Search";
import { Token } from "./screens/Token";
import { You } from "./screens/You";
import { TabIcon } from "./ui";
import { FirstVisit } from "./FirstVisit";

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
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const requestedScreen = useMemo(()=>screenForPath(pathname),[pathname]);
  const setScreen = (next: Screen) => router.push(pathForScreen(next));
  const [account, setAccount] = useState<AccountState|null>(null);
  const [loadError,setLoadError]=useState("");
  const [refreshKey,setRefreshKey]=useState(0);
  const refreshAccount=()=>setRefreshKey(k=>k+1);
  const [sidebarSection, setSidebarSection] =
    useState<SidebarSection>("markets");
  const desktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot, () => false);
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
  const perTrade = String(account?.status.grant?.caps.perTradeUsdg ?? "");
  const perDay = String(account?.status.grant?.caps.dailyUsdg ?? "");
  const stopped = account?.status.mode !== "live" && account?.status.mode !== "paper";
  const [chatDraft, setChatDraft] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [screen]);

  useEffect(() => {
    let alive = true;
    let refreshing = false;
    setLoadError("");
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
    void Promise.all([requestJson<AccountState["session"]>("/api/auth/session"), requestJson<AccountState["status"]>("/api/grants")]).then(([session,status])=>{ if(alive) setAccount({session,status}); }).catch(error=>{if(alive)setLoadError(error.message);});
    void loadLive(mine=>{if(alive)setLive(previous=>({...previous,mine}));})
      .then((data) => {
        if (!alive) return;
        loaded = data;
        setLive(data);
        void refreshChanges(data.tokens);
      })
      .catch((error) => {if(alive)setLoadError(error.message);});
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
        const next = await loadLive();
        const [session,status]=await Promise.all([requestJson<AccountState["session"]>("/api/auth/session"),requestJson<AccountState["status"]>("/api/grants")]);
        if(alive) {
          setAccount({session,status});
          if(session.hosted && !session.address){setTurns([]);setChatDraft("");setMoneyMode(null);}
          setLive(previous=>({...next,tokens:next.tokens.map(t=>{const old=previous.tokens.find(p=>p.id===t.id);return {...t,priceUsd:t.priceUsd ?? old?.priceUsd ?? null,change24hPct:t.change24hPct ?? old?.change24hPct ?? null};})}));
        }
        await refreshChanges(next.tokens);
      } catch(error) {
        if(alive)setLoadError(error instanceof Error ? error.message : "Could not refresh data.");
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
  }, [refreshKey]);

  const openScreen = (next: Screen) => {
    if (next.kind === "deposit" || next.kind === "withdraw") {
      if(!account?.status.exists) { router.push("/you"); return; }
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
  const activeTab = screen.kind === "tab" ? screen.tab : tab;
  const token =
    screen.kind === "token" ? tokenById(live.tokens, screen.id) : undefined;
  const listedAgent =
    screen.kind === "profile"
      ? live.agents.find((a) => a.slug === screen.slug)
      : undefined;
  const [profile,setProfile]=useState<import("./live").LiveAgent|null>(null);
  const [profileError,setProfileError]=useState("");
  const profileSlug=screen.kind==="profile" ? screen.slug : null;
  useEffect(()=>{
    setProfile(null);setProfileError("");
    if(!profileSlug)return;
    let alive=true;
    requestJson<import("@/lib/read-agent").AgentProfile>(`/api/agents/${encodeURIComponent(profileSlug)}`).then(p=>{
      if(!alive)return;
      setProfile({slug:p.slug,name:p.name,handle:p.handle,owner:p.handle,pnlBps:p.pnlBps,curve:p.growth.map(v=>v.g),landed:p.landed,last:null,publicBook:p.publicBook,holdingsUsd:p.publicBook && p.holdingsRead ? p.holdings.reduce((sum,h)=>sum+h.valueUsdg,0) : null,thesis:"",glance:{id:"custom",label:"Strategy",legs:p.publicBook ? p.holdings.map(h=>({symbol:h.symbol,weight:(h.shareBps??0)/100})) : undefined}});
    }).catch(e=>{if(alive)setProfileError(e.message);});
    return()=>{alive=false;};
  },[profileSlug]);
  useEffect(()=>{if(pathname==="/feed")setSidebarSection("feed");else if(pathname==="/leaderboard")setSidebarSection("board");else if(pathname==="/agent")setSidebarSection("agents");},[pathname]);
  const agent=profile ?? listedAgent;
  const mine = account?.status.exists && live.mine ? {...live.mine, statusLabel: account.status.mode === "paper" ? "Paper trading" : account.status.mode === "live" ? "Running" : account.status.mode === "idle" ? "Idle" : "Waiting for worker"} : null;
  const emptyMine = {name:"Your agent",slug:null,handle:null,owner:null,equity:0,chg24:null,mode:null,thesis:null,moves:[],glance:{id:"custom" as const,label:"",cashUsd:0}};
  const displayMine = mine ?? emptyMine;

  return (
    <div className="terminal-host"><div
      className="app"
      data-screen={screen.kind === "tab" ? screen.tab : screen.kind}
    >
      <DesktopHeader hasAgent={!!mine} mine={displayMine} onScreen={openScreen} onTab={goTab} />
      {desktop && (
        <DesktopSidebar
          mine={displayMine}
          hasAgent={!!mine}
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
        {loadError && <p className="flow-error" role="alert">{loadError} <button onClick={refreshAccount}>Try again</button></p>}
        <FirstVisit account={account} screen={requestedScreen} replies={turns.length} onScreen={openScreen} onQuestion={()=>{setChatDraft("Explain my strategy and trading limits. Am I using paper or live trading?");goTab("agent");}}/>
        {!mine && !desktop && screen.kind !== "create" && <AccountEntry account={account} onRefresh={refreshAccount}/>}
        {screen.kind === "create" && <CreateAgent account={account} onRefresh={refreshAccount} onBack={()=>goTab("home")} onDone={()=>{refreshAccount();goTab("agent");}} onFund={grant=>{setAccount(current=>current?{...current,status:{...current.status,exists:true,grant}}:current);goTab("agent");setMoneyMode("deposit");}}/>}
        {screen.kind === "settings" && <Settings onFund={()=>openScreen({kind:"deposit"})}/>}
        {screen.kind === "grant" && <Wallet/>}
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
        {screen.kind === "tab" && screen.tab === "you" && <div className="hosted-account-links"><a href="/settings">Settings</a><a href="/grant">Manage wallet & permissions</a>{account?.session.hosted && account.session.address && <button onClick={()=>{void requestJson("/api/auth/logout",{method:"POST"}).then(()=>{setLive(seedLive());setAccount(null);setTurns([]);setMoneyMode(null);setChatDraft("");refreshAccount();}).catch(e=>setLoadError(e.message));}}>Sign out</button>}</div>}
        {screen.kind === "tab" && screen.tab === "you" && (
          <You
            history={
              mine?.history ?? []
            }
            onLimits={() => openScreen({ kind: "limits" })}
            onStop={() => {window.location.href="/grant";}}
            onDesk={() => goTab("agent")}
            onDeposit={() => openScreen({ kind: "deposit" })}
            onWithdraw={() => openScreen({ kind: "withdraw" })}
            stopped={stopped}
            perTrade={perTrade}
            perDay={perDay}
            mine={mine}
          />
        )}
        {screen.kind === "token" && !token && <section className="hosted-entry"><h1>Token unavailable</h1><p role="status">We could not load this token.</p><button onClick={refreshAccount}>Try again</button><button onClick={()=>goTab("home")}>Back to markets</button></section>}
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
        {screen.kind === "profile" && !agent && <section className="hosted-entry"><p role="status">{profileError || "Loading agent…"}</p>{profileError && <button onClick={()=>goTab("agent")}>Back to agents</button>}</section>}
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
        {screen.kind === "withdraw" && account && <FundingPanel mode="withdraw" account={account} onClose={()=>setMoneyMode(null)}/>}
        {screen.kind === "deposit" && (
          <FundingPanel mode="deposit" account={account!} onClose={()=>setMoneyMode(null)}/>
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
          <LimitsPanel account={account} onClose={()=>goTab(tab)}/>
        )}
      </div>
      {desktop && moneyMode ? (
        <aside
          className="desktop-money-panel"
          aria-label={moneyMode === "withdraw" ? "Withdraw funds" : "Add funds"}
        >
          {account && <FundingPanel key={moneyMode} mode={moneyMode} account={account} onClose={()=>setMoneyMode(null)}/>}
        </aside>
      ) : mine ? (
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
      ) : <aside className="desktop-portfolio">{screen.kind === "create" ? <section className="hosted-entry"><h2>Make it yours.</h2><p>Pick a strategy, set its limits, and save your wallet’s recovery key.</p><p>You can start in paper mode and follow your agent before adding real funds.</p></section> : <AccountEntry account={account} onRefresh={refreshAccount}/>}</aside>}
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
    </div></div>
  );
}
function screenForPath(path: string): Screen {
  if(path.startsWith("/t/")) return {kind:"token",id:decodeURIComponent(path.slice(3))};
  if(path.startsWith("/a/")) return {kind:"profile",slug:decodeURIComponent(path.slice(3))};
  if(path==="/search") return {kind:"search"};
  if(path==="/create") return {kind:"create"};
  if(path==="/settings") return {kind:"settings"};
  if(path==="/grant") return {kind:"grant"};
  if(path==="/limits") return {kind:"limits"};
  return {kind:"tab",tab:path==="/agent"?"agent":path==="/you"?"you":path==="/feed"?"feed":path==="/leaderboard"?"board":"home"};
}
function pathForScreen(screen: Screen): string {
  if(screen.kind==="token") return `/t/${encodeURIComponent(screen.id)}`;
  if(screen.kind==="profile") return `/a/${encodeURIComponent(screen.slug)}`;
  if(screen.kind==="tab") return ({home:"/",agent:"/agent",you:"/you",feed:"/feed",board:"/leaderboard"})[screen.tab];
  return `/${screen.kind}`;
}
