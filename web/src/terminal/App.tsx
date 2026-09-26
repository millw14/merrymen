"use client";
import { usePathname, useRouter } from "next/navigation";
import { AccountEntry, FundingPanel, LimitsPanel, requestJson, type AccountState } from "./HostedControls";
import { SignOut } from "./SignOut";
import {
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
import { autonomyOf } from "@merrymen/core";
import { chatKeyFor } from "./chat-store";
import { useChatController } from "./chat-controller";
import { chatTape } from "./chat-thread";
import "./chat.css";
import {
  fetchRead,
  liveOf,
  seedSources,
  tokenById,
  type LiveSources,
  type Screen,
  type Tab,
  type TokenTab,
} from "./live";
import { useShellClocks } from "./live-clocks";

import { Agent } from "./screens/Agent";
import { Alpha } from "./screens/Alpha";
import { pathForScreen, screenForPath, TABS } from "./nav";

import { Feed } from "./screens/Feed";
import { GroupChat } from "./screens/GroupChat";
import { Home } from "./screens/Home";
import { CreateAgent } from "./screens/CreateAgent";
import Settings from "./screens/Settings";
import Wallet from "./screens/Wallet";

import { Profile } from "./screens/Profile";
import { glanceOfHow, thesisOfHow, type ProfileAgent } from "./profile-view";
import "./profile.css";
import { Search } from "./screens/Search";
import { Token } from "./screens/Token";
import { You } from "./screens/You";
import { TabIcon } from "./ui";
import { FirstVisit } from "./FirstVisit";
import { ResignPrompt } from "./ResignPrompt";
import "./first-visit.css";
import { WiredProvider } from "@/components/WiredProvider";
import { useDesktopDetail } from "./desktop-detail";
import { ChatDock } from "./ChatDock";
import {
  capsOf,
  profileShown,
  realCashOf,
} from "./account-read";
import { LoadFailure } from "./LoadFailure";
import { SkeletonRows } from "./Skeleton";
import "./skeleton.css";
import { useLiveNews, useSoundPref } from "./live-news";
import { SoundToggle } from "./SoundToggle";
import { ticksOf } from "./ticker";
import { TickerStrip } from "@/components/shell/Ticker";
import "./live-motion.css";


const desktopSnapshot = () => window.matchMedia("(min-width: 1100px)").matches;
function subscribeDesktop(onChange: () => void) {
  const media = window.matchMedia("(min-width: 1100px)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function App() {
  const bodyRef = useRef<HTMLDivElement>(null);
  /**
   * THE LATEST ANSWER OF EVERY READ, and the screens drawn from them.
   *
   * Each read runs on its own clock and applies its answer the moment it
   * arrives (live-clocks.ts); `live` is derived from all of them, so the feed
   * no longer waits for the launchpad sweep to be drawn, and no read's answer
   * overwrites another's.
   */
  const [sources, setSources] = useState<LiveSources>(seedSources);
  const live = useMemo(() => liveOf(sources), [sources]);
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const requestedScreen = useMemo(()=>screenForPath(pathname),[pathname]);
  const setScreen = (next: Screen) => router.push(pathForScreen(next));
  const [account, setAccount] = useState<AccountState|null>(null);
  /**
   * DID THE LAST ACCOUNT READ FAIL? `account` alone cannot say: it is null both
   * before the first read answers and after it failed, and the screens rendered
   * "Loading your account…" for both — for ever, after a failure.
   */
  const [accountFailed, setAccountFailed] = useState(false);
  /** Bumped by sign-out, which starts every clock again from nothing — see resetLive. */
  const [epoch, setEpoch] = useState(0);
  /**
   * EVERYTHING, FROM NOTHING — for a sign-out. The reads in flight belong to
   * the owner leaving, so restarting the clocks (useShellClocks, below, is
   * keyed on `epoch`) drops their answers rather than letting one land after
   * the reset.
   */
  const resetLive = () => {
    setSources(seedSources());
    setEpoch((e) => e + 1);
  };
  const [sidebarSection, setSidebarSection] =
    useState<SidebarSection>("markets");
  /**
   * Is the floating chat open? DESKTOP ONLY, and it is deliberately not a screen.
   *
   * On a phone the chat IS the screen, which is right — a phone shows one
   * thing. On desktop, replacing the whole centre to talk to your agent throws
   * away the chart you were reading, and getting back to it means leaving the
   * conversation behind. Reported as "i dont find it intuitive to get to the
   * page where im talking to the agent. i have to click around a bunch".
   *
   * Not a route, because it is an overlay over whatever you were looking at and
   * that page did not go anywhere — the same reasoning the money panel already
   * follows here.
   */
  const [chatDocked, setChatDocked] = useState(false);
  const desktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot, () => false);
  const desktopDetail = useDesktopDetail(desktop, requestedScreen, live.tokens[0]?.id, live.agents[0]?.slug);
  // Deposit and withdraw were component state, which
  // meant the browser's Back button could not dismiss them and the tab bar
  // disappeared while they were open — the most trapped a person could be in
  // this shell, on the two screens where money moves. They are routes now, so
  // Back works, a refresh keeps you there, and the link is shareable.
  const money =
    requestedScreen.kind === "deposit" || requestedScreen.kind === "withdraw"
      ? requestedScreen.kind
      : null;
  // On a phone the money panel IS the screen. On desktop it is a side panel
  // over whatever you were looking at, so the body keeps rendering that — the
  // one place the URL and the body legitimately differ, because the panel is an
  // overlay and the page under it did not go anywhere.
  const [tab, setTab] = useState<Tab>("feed");
  const screen: Screen = desktop && (
    money || (requestedScreen.kind === "tab" && (requestedScreen.tab === "feed" || requestedScreen.tab === "home"))
  ) ? desktopDetail : requestedScreen;
  const [tokenTab, setTokenTab] = useState<TokenTab>("buys");
  // Null until read — `String(caps ?? "")` rendered an unread key as "$0.00 per trade".
  const { perTrade, perDay } = capsOf(account);
  const stopped = account?.status.mode !== "live" && account?.status.mode !== "paper";
  /**
   * WHERE THIS READER'S CHAT IS KEPT — see chat-store.ts.
   *
   * Null while the session is still loading, and null for a hosted visitor who
   * is signed out. The controller remembers whose it was, because sign-out
   * clears the account first and the key of the owner LEAVING is the one that
   * has to be deleted.
   */
  const chatKey = chatKeyFor(account?.session ?? null);
  /**
   * THE CHAT, MOUNTED ONCE, HERE — see chat-controller.ts.
   *
   * It lived in the Agent screen, which exists only while the chat is on
   * screen, so a reply in flight or an order being followed died when the dock
   * closed or the tab changed. Both Agent mounts below draw this one.
   * `open` is whether it is on screen, for the unread dot. `moves` is the
   * owner's tape only when it was READ, so the agent's own fills can join the
   * thread — never an empty stand-in for a read that failed. An answered order
   * reads the account and the market again at once, rather than on the next
   * minute's pass.
   */
  const chat = useChatController({
    chatKey,
    open: (screen.kind === "tab" && screen.tab === "agent") || (desktop && chatDocked),
    moves: chatTape({ agentExists: account?.status.exists, read: live.reads.mine, moves: live.mine?.moves }),
    // The account and the owner's book, read again now: the same two reads
    // sign-in and a new agent ask for (refreshAccount, below).
    onOutcome: () => refreshAccount(),
  });
  // The two names the refresh loop and sign-out already clear the chat with.
  const setChatDraft = chat.setDraft;
  const setTurns = (_cleared: []) => chat.clearThread();

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [screen]);

  /**
   * EVERY READ ON ITS OWN CLOCK — see live-clocks.ts and refresh-loop.ts.
   *
   * This was one pass a minute over quotes, six reads in a Promise.all and the
   * account, and nothing rendered until the slowest — the launchpad sweep, at
   * 10-12s cold — had come back. Now the feed reads every ten seconds while
   * the tab is visible (a minute while hidden, so the title can count what
   * arrived), the market and its quotes every thirty, the board every minute,
   * the sweep every two, and the account and the owner's book every minute as
   * before; each applies its answer as it lands.
   *
   * THE WAVE 1 HONESTY IS KEPT, per read. Every clock books its next pass
   * whatever happened (backing off 5s, 15s, then its own cadence), the first
   * success takes its failure off the line, whatever was on screen stays there,
   * and the one outage line (bannerOf) names the half that failed, dates the
   * oldest figure it is apologising for, and says "Can't reach merrymen" only
   * when nothing answered anywhere. A read that half landed is still a failure:
   * each public read's clock fails on its own unreadable answer.
   *
   * A TAB COMING BACK INTO VIEW runs what went stale while it was hidden, and
   * nothing that ran seconds ago (wake), rather than every read at once.
   *
   * THE CLOCKS ARE A HOOK (live-clocks.ts useShellClocks), so a test mounts
   * what the shell mounts. The shell hands it the reads and its own setters,
   * and draws from what it returns: the outage line, whether the account is
   * being read, the retries, and the token page's three states. Set only when
   * one of these changes, not on every clock's start and end, which re-rendered
   * the whole tree some twenty-three times a minute for nothing.
   */
  const clockShell = useShellClocks(epoch, (alive) => {
    let firstAccount = true;
    return {
      fetchRead,
      loadQuotes: loadTokenQuotes,
      loadChanges: loadSessionChanges,
      update: setSources,
      readAccount: async () => {
        const first = firstAccount;
        firstAccount = false;
        try {
          const [session,status]=await Promise.all([requestJson<AccountState["session"]>("/api/auth/session"),requestJson<AccountState["status"]>("/api/grants")]);
          if(!alive()) return;
          setAccount({session,status});
          setAccountFailed(false);
          // Not on the first pass: there is no conversation of this session's to
          // clear yet, and a draft typed while the page loaded is the owner's.
          if(!first && session.hosted && !session.address){setTurns([]);setChatDraft("");}
        } catch (error) {
          // The reader gets one plain sentence (LoadFailure); the cause goes here.
          console.warn("[merrymen] account read failed:", error);
          if (alive()) setAccountFailed(true);
          throw error;
        }
      },
      hidden: () => document.hidden,
    };
  });
  /** The one outage line over all of them; null while every read on it is healthy. */
  const banner = clockShell.shell.banner;
  /** The account or the owner's book is being read right now — a retry asked for, or the timer's. */
  const accountBusy = clockShell.shell.accountBusy;
  /** The account and the owner's book, again, now — see ShellClocksHandle.refreshAccount. */
  const refreshAccount = clockShell.refreshAccount;

  /**
   * A REAL-MONEY TRADE LANDING, SAID — see live-news.ts.
   *
   * A short tone if the reader turned sound on (off by default), and "(3)
   * merrymen" in the tab title while the tab is hidden, both from the feed
   * reads above and nothing else: no request of their own, never on the first
   * read, and never for a hold, a paper fill or a refusal.
   */
  const [soundOn, toggleSound] = useSoundPref();
  useLiveNews({ theses: live.theses, read: live.reads.theses, soundOn });

  const openScreen = (next: Screen) => {
    // There is nothing to fund before an agent exists, and the deposit panel
    // reads `account.status.grant` — so the guard stays, and it sends people to
    // the screen that can actually create one.
    if ((next.kind === "deposit" || next.kind === "withdraw") && !account?.status.exists) {
      router.push("/you");
      return;
    }
    setScreen(next);
  };
  const goTab = (next: Tab) => {
    /**
     * THE SAME BUTTON, A DIFFERENT PLACE TO PUT IT.
     *
     * Every existing caller of goTab("agent") — the sidebar's "Open chat", the
     * portfolio panel's "Chat with X", the tab bar — now opens the dock on
     * desktop rather than navigating. One entry point, so there is no second
     * one to keep in step, and the phone is untouched.
     */
    if (desktop && next === "agent") {
      setChatDocked(true);
      return;
    }
    if (desktop && next === "feed") {
      setSidebarSection("feed");
      return;
    }
    setTab(next);
    setScreen({ kind: "tab", tab: next });
  };
  // FROM THE URL, not from the click history. `tab` is only ever written by
  // goTab, so a cold load of /alpha left the bar highlighting Home until the
  // user clicked something.
  const activeTab = screen.kind === "tab" ? screen.tab : requestedScreen.kind === "tab" ? requestedScreen.tab : tab;
  const token =
    screen.kind === "token" ? tokenById(live.tokens, screen.id) : undefined;
  const listedAgent =
    screen.kind === "profile"
      ? live.agents.find((a) => a.slug === screen.slug)
      : undefined;
  const [profile,setProfile]=useState<ProfileAgent|null>(null);
  /** The open profile's own re-read, for the owner's book switch — see Profile's onBookChanged. */
  const profileRefresh=useRef<(() => void) | null>(null);
  const [profileTheses,setProfileTheses]=useState<import("./live").Thesis[]>([]);
  const [profileActivityError,setProfileActivityError]=useState("");
  const [profileError,setProfileError]=useState("");
  const profileSlug=screen.kind==="profile" ? screen.slug : null;
  useEffect(()=>{
    setProfile(null);setProfileTheses([]);setProfileActivityError("");setProfileError("");
    if(!profileSlug)return;
    let alive=true;
    const refresh = () => requestJson<import("@/lib/read-agent").AgentProfile & { theses: import("./live").Thesis[]; thesesRead: boolean }>(`/api/agents/${encodeURIComponent(profileSlug)}`).then(p=>{
      if(!alive)return;
      setProfileError("");
      setProfileTheses(p.theses ?? []);
      setProfileActivityError(p.thesesRead === false ? "Recent decisions could not be loaded." : "");
      // HOW IT DECIDES, FROM ITS OWN DECISIONS. This was hard-coded thesis ""
      // and glance "custom", so every profile read "Its own rules" — a claim
      // about a Trencher or a steady basket that it wrote its own. read-agent
      // already sends `how`; profile-view.ts turns it into words, and an agent
      // that published none stays unpublished rather than guessed.
      // The rest past `glance` is the profile's own: the chart's timestamps and
      // whether they reach the whole period, TOP TRADES, and the stats line.
      setProfile({mode:p.mode,recentTrades:p.recentTrades,activityRead:p.activityRead,slug:p.slug,name:p.name,handle:p.handle,owner:p.handle,pnlBps:p.pnlBps,paperPnlBps:p.paperPnlBps,unrankedWhy:p.unrankedWhy,gas:p.gas,holdingsRead:p.holdingsRead,curve:p.growth.map(v=>v.g),curveKind:"growth" as const,contributionsEvidenced:p.contributionsEvidenced,landed:p.landed,filledPaper:p.filledPaper,last:null,publicBook:p.publicBook,holdingsUsd:p.publicBook && p.holdingsRead ? p.holdings.reduce((sum,h)=>sum+h.valueUsdg,0) : null,thesis:thesisOfHow(p.how),glance:{...glanceOfHow(p.how),legs:p.publicBook ? p.holdings.map(h=>({symbol:h.symbol,weight:(h.shareBps??0)/100})) : undefined},
        growthPoints:p.growth,growthComplete:p.growthComplete,topTrades:p.topTrades,topTradesRead:p.topTradesRead,tradeCount:p.tradeCount,tradeCountFloor:p.tradeCountFloor,avgHoldSec:p.avgHoldSec,joinedAt:p.joinedAt,gasless:p.gasless});
    }).catch(e=>{if(alive)setProfileError(e.message);});
    void refresh();
    profileRefresh.current = () => { void refresh(); };
    const timer = setInterval(refresh, 30_000);
    return()=>{alive=false;clearInterval(timer);profileRefresh.current=null;};
  },[profileSlug]);
  useEffect(()=>{if(pathname==="/agent" || pathname==="/chat")setSidebarSection("agents");},[pathname]);
  useEffect(() => {
    if (desktop && (pathname === "/" || pathname === "/feed")) setSidebarSection("feed");
  }, [desktop, pathname]);
  // Never the leaderboard row while the profile read is in flight — see profileShown.
  const agent=profileShown(profile, profileError, listedAgent);
  /**
   * WHAT THIS AGENT ACTUALLY IS, decided once and handed to every surface.
   *
   * This line used to be a ternary over `mode` alone, producing "Paper trading"
   * / "Running" / "Idle" / "Offline". Two things were wrong with it, and a
   * tester found both.
   *
   * It never mentioned the BLOCKER, so nine owners whose keys predate a wall fix
   * sat under the word "Paper trading" while the one thing that would end it —
   * a free re-signature — was named only in a worker log they never see.
   *
   * And it left the BALANCE alone. An account holding 0.000000 USDG rendered
   * "Available cash $964", because with no real money the agent drops to paper
   * and the paper book's balance is what the account line then reports. Nothing
   * lied; the screen simply printed practice money in the shape of deposited
   * money, and the reader supplied the only meaning available to them.
   *
   * `autonomyOf` lives in core so the chat and the feed read the same words.
   * Real cash comes from `balances.cashUsdg`, which is a chain multicall in
   * /api/grants — NOT `glance.cashUsd`, which is the book and is exactly the
   * figure that must not be trusted to say whether money exists.
   */
  const autonomy = autonomyOf({
    mode: account?.status.mode ?? null,
    liveBlocker: account?.status.liveBlocker ?? null,
    expired:
      account?.status.grant?.expiresAt !== undefined
        ? account.status.grant.expiresAt * 1000 < Date.now()
        : false,
    // NULL WHEN THE ROUTE COULD NOT READ IT. `Number(null)` is 0, and zero is
    // the one value `autonomyOf` answers with "Add funds" — to a funded owner,
    // whenever the node was slow. See realCashOf.
    realCashUsd: realCashOf(account),
    /**
     * IS THE BLOCKER OLDER THAN THE SIGNATURE?
     *
     * Both halves come from this one response: `grantedAt` from the grant store
     * the POST wrote synchronously, `workerAliveAt` from the mirrored `agents`
     * row that also carries `liveBlocker` — so the comparison is between two
     * facts that arrived together, not a race between sources.
     *
     * Both must be present. A missing timestamp is not a fresh signature, and
     * defaulting either way would turn "we don't know" into a claim.
     */
    blockerPredatesGrant:
      account?.status.grant?.grantedAt !== undefined && account?.status.workerAliveAt
        ? account.status.grant.grantedAt > account.status.workerAliveAt
        : false,
  });
  const mine = account?.status.exists && live.mine ? {...live.mine, statusLabel: autonomy.label, autonomy} : null;
  /**
   * Where the re-sign button goes — and, for wrong-chain, on WHICH network.
   *
   * These handlers are a full page load, so React state and props both die on
   * the way and a URL is the only carrier that survives. `action.chain` is set
   * only where the remedy is a signature on a DIFFERENT network; everywhere
   * else the grant screen's own selector is already correct and must be left
   * alone, because pinning it to the loaded grant is what stops a mainnet owner
   * silently re-signing onto the sandbox.
   */
  const resignHref = autonomy.action?.chain
    ? `/grant?chain=${autonomy.action.chain}#resign`
    : "/grant#resign";
  // THE SHELL FOR A VISITOR WITH NO AGENT — and every figure on it is unknown,
  // not zero. `equity:0, cashUsd:0` rendered "$0.00" in the header and the
  // sidebar for somebody who has no account at all, which is a balance we have
  // never read for a book that does not exist.
  // A VISITOR WITH NO AGENT gets the idle arm, not a blocked or paper one:
  // there is no agent to be blocked and no book to simulate. `autonomyOf` with
  // a null mode returns exactly that, so the shell carries a real answer rather
  // than a placeholder every surface then has to special-case.
  const emptyMine = {name:"Your agent",slug:null,handle:null,owner:null,equity:null,chg24:null,mode:null,thesis:null,moves:[],glance:{id:"custom" as const,label:"",cashUsd:undefined},autonomy:autonomyOf({mode:null,liveBlocker:null})};
  const displayMine = mine ?? emptyMine;
  // THE BOOK'S OWN READ, as it stands. It is on its own clock now, so "unread"
  // means its first answer has not come back and nothing else — see live-clocks.ts.
  const portfolioRead = live.reads.mine;
  /** The tape's rows, from the market read above — desktop only; see ticker.ts. */
  const ticks = desktop ? ticksOf(live.tokens, Date.now() / 1000) : [];

  return (
    <WiredProvider tenant={account?.session.hosted ? account.session.address : null}><div className="terminal-host"><div
      className={ticks.length > 0 ? "app has-tape" : "app"}
      data-screen={screen.kind === "tab" ? screen.tab : screen.kind}
    >
      {/* GATED IN JSX, NOT JUST IN CSS. These three were rendered on every
          device and hidden by a media query, so a phone MOUNTED the desktop
          header and the desktop rail — and with them a second `AccountEntry`,
          which polls and fetches like the visible one. Display:none hides a
          component; it does not stop it running. */}
      {desktop && <DesktopHeader hasAgent={!!mine} mine={displayMine} onScreen={openScreen} onTab={goTab} />}
      {desktop && (
        <DesktopSidebar
          reads={live.reads}
          retired={live.retired}
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
        {banner && <LoadFailure nextAt={banner.nextAt} lastOkAt={banner.lastOkAt} inFlight={banner.inFlight} failed={banner.failed} unreachable={banner.unreachable} onRetry={clockShell.retryFailing}/>}
        {/* THE ONE PROMPT THAT FIRES BEFORE THE FIRST REFUSAL, rather than
            after it. Every other re-sign surface answers a question the
            WORKER asked — expired, uncovered, dead policy — and none of them
            can see a wall that is merely OLD. Mounted in the shell because
            it is true on every screen, and handed `exists` straight from the
            server so it cannot flash for an owner whose account is still
            loading. It navigates to the one signing control; it never signs. */}
        <ResignPrompt
          exists={account ? account.status.exists : null}
          grantedAt={account?.status.grant?.grantedAt ?? null}
          tenant={account?.session.hosted ? account.session.address : null}
          href={resignHref}
        />
        <FirstVisit layoutKey={desktop ? "desktop" : "mobile"} tenant={account?.session.hosted ? account.session.address : null} onScreen={next => {
          if (desktop && next.kind === "tab" && ["home", "agent", "feed"].includes(next.tab)) {
            // Desktop tabs live in the rail/dock, not the phone's routes.
            // Navigating home would select Feed again and spotlight Markets
            // while showing the wrong panel behind it.
            if (next.tab === "home") setSidebarSection("markets");
            if (next.tab === "agent") setSidebarSection("agents");
            if (next.tab === "feed") setSidebarSection("feed");
            setChatDocked(next.tab === "agent");
            openScreen(next);
          } else openScreen(next);
        }} onExplore={section => { if (desktop) setSidebarSection(section); }} onQuestion={()=>{setChatDraft(current => current || "Explain my strategy and trading limits. Am I using paper or live trading?");goTab("agent");}}/>
        {!mine && !desktop && screen.kind !== "create" && screen.kind !== "groupchat" && <AccountEntry account={account} accountFailed={accountFailed} portfolio={portfolioRead} retrying={accountBusy} onRefresh={refreshAccount}/>}
        {screen.kind === "create" && <CreateAgent account={account} accountFailed={accountFailed} retrying={accountBusy} onRefresh={refreshAccount} onBack={()=>goTab("home")} onDone={()=>{refreshAccount();goTab("agent");}} onFund={grant=>{setAccount(current=>current?{...current,status:{...current.status,exists:true,grant}}:current);openScreen({kind:"deposit"});}}/>}
        {screen.kind === "settings" && <Settings onFund={()=>openScreen({kind:"deposit"})} slug={mine?.slug ?? null} onSaved={chat.refreshSettings}/>}
        {screen.kind === "grant" && <Wallet/>}
        {screen.kind === "tab" && screen.tab === "home" && (
          <Home
            tokens={live.tokens}
            agents={live.agents}
            theses={live.theses}
            read={live.reads.board}
            retired={live.retired}
            mine={mine}
            tokenTab={tokenTab}
            onTokenTab={setTokenTab}
            onToken={(id) => openScreen({ kind: "token", id })}
            onAgent={(slug) => openScreen({ kind: "profile", slug })}
            onDeposit={() => openScreen({ kind: "deposit" })}
            onSearch={() => openScreen({ kind: "search" })}
            onDesk={() => goTab("agent")}
            onGroupChat={() => openScreen({ kind: "groupchat" })}
            hasAgent={account?.status.exists === true}
            mode={account?.status.mode ?? null}
          />
        )}
        {screen.kind === "tab" && screen.tab === "feed" && (
          <Feed
            read={live.reads.theses}
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
            chat={chat}
            perTrade={perTrade}
            perDay={perDay}
            onToken={(id) => openScreen({ kind: "token", id })}
            onDeposit={() => openScreen({ kind: "deposit" })}
            onWithdraw={() => openScreen({ kind: "withdraw" })}
            onLimits={() => openScreen({ kind: "limits" })}
            onResign={() => {window.location.href=resignHref;}}
            onSettings={() => openScreen({ kind: "settings" })}
            liveBlocker={account?.status.liveBlocker}
            staleBlocker={autonomy.state === "checking"}
          />
        )}
        {screen.kind === "tab" && screen.tab === "alpha" && (
          <Alpha onToken={(id) => openScreen({ kind: "token", id })} />
        )}
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
        {/* The trade chime's switch on every device; desktop also has it on
            the tape. Its own row, not one of the session actions below: those
            are drawn in the sign-out's red, and a preference is not a way out. */}
        {screen.kind === "tab" && screen.tab === "you" && (
          <div className="profile-sound">
            <SoundToggle on={soundOn} onToggle={toggleSound} />
          </div>
        )}
        {/* WHO YOU ARE SIGNED IN AS, next to the way out.
            "I don't know my tenant/login wallet address offhand" — and nothing
            in the product showed it. It is a public address and the one thing
            that identifies which account you are operating, so it belongs
            beside the sign-out rather than only in an API response. */}
        {screen.kind === "tab" && screen.tab === "you" && (
          <div className="profile-session-actions">
            {!account?.status.exists && <a href="/create">Create agent</a>}
            {account?.session.hosted && account.session.address && (
              <>
                <span className="profile-session-who" title={account.session.address}>
                  signed in as <code>{account.session.address}</code>
                </span>
                <SignOut
                  after={() => {
                    resetLive();
                    setAccount(null);
                    setTurns([]);
                    setChatDraft("");
                  }}
                />
              </>
            )}
          </div>
        )}
        {/* THREE STATES, NOT ONE — see the hook's tokenMissing. Waiting is not
            failing, and a market list that came back without this address is a
            fact about the address rather than a fact about the request. */}
        {screen.kind === "token" && !token && (() => {
          // WHICH READ WOULD HAVE HAD IT. Every listed equity comes from the
          // registry seed and /api/market; every coin comes from the launchpad
          // sweep. So an unreachable index means the coins are simply absent
          // from the list, and "check the address" would be publishing OUR
          // outage as a fact about the instrument. The three arms are ordered
          // unreadable-before-absent, which is the ordering the whole product
          // uses.
          //
          // A load that finished without reading the market is unreadable too,
          // not merely unread — see tokenPageUnreadable.
          // AND ONLY THE READS THAT LIST TOKENS decide it — the same two the
          // button below retries, so pressing it can always clear what this
          // says (tokenMissingOf).
          const missing = clockShell.tokenMissing(live.reads);
          if (missing.loading) {
            return <section className="hosted-entry"><p role="status">Loading token…</p></section>;
          }
          const unreadable = missing.unreadable;
          return (
            <section className="hosted-entry">
              <h1>{unreadable ? "Token unavailable" : "Token not listed"}</h1>
              <p role="status">
                {unreadable
                  ? "Could not load this token. Try again."
                  : "Token not found. Check the address."}
              </p>
              {/* The two reads that list tokens — not the account, which is
                  what this button used to refresh while the page said the
                  token could not be loaded. */}
              {unreadable && <button onClick={missing.retry}>Try again</button>}
              <button onClick={()=>goTab("home")}>Back to markets</button>
            </section>
          );
        })()}
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
        {screen.kind === "profile" && !agent && (profileError
          ? <section className="hosted-entry"><p role="status">{profileError}</p><button onClick={()=>goTab("agent")}>Back to agents</button></section>
          : <section className="hosted-entry"><SkeletonRows rows={4} label="Loading agent"/></section>)}
        {/* THE FAILURE IS SAID EVEN WHEN THERE IS SOMETHING TO SHOW.
            `agent` falls back to `listedAgent` once the profile read fails, so a
            failed profile fetch is invisible whenever the agent also happens to
            be on the leaderboard —
            the page renders, from a different and much thinner read, with no
            indication that the thing it was asked for did not arrive. The
            leaderboard row is worth showing; passing it off as the profile is
            not. And when a profile that DID load fails its next refresh, what
            is on screen is that profile, older — so it says that instead. */}
        {screen.kind === "profile" && agent && profileError && (
          <p role="status" className="hosted-note">
            {profile
              ? "Couldn’t refresh this profile — showing what we last read."
              : "Some profile details are unavailable. Showing the agent’s leaderboard summary."}
          </p>
        )}
        {screen.kind === "profile" && agent && (
          <Profile
            key={agent.slug}
            agent={agent}
            theses={profile ? profileTheses : live.theses}
            activityError={profileActivityError}
            tokens={live.tokens}
            onBack={() => goTab(tab)}
            onToken={(id) => openScreen({ kind: "token", id })}
            isMine={mine?.slug === agent.slug}
            onBookChanged={() => profileRefresh.current?.()}
          />
        )}
        {/* `account!` USED TO BE SAFE BY ACCIDENT. The only way in was
            openScreen, which refused before the account existed — so the
            assertion held because nothing could reach it. Making these routes
            means anybody can type the URL, and the assertion becomes a crash
            into the error boundary that says "Couldn't load this page" about a
            page that loaded fine. The guard moves to the render, where it
            belongs, and the AccountEntry above says which kind of nothing this
            is: loading, signed out, or no agent yet. */}
        {!desktop && money && account && (
          <FundingPanel key={money} mode={money} account={account} onClose={()=>goTab(tab)}/>
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
        {screen.kind === "groupchat" && <GroupChat mySlug={mine?.slug ?? null} onProfile={(slug) => openScreen({ kind: "profile", slug })} onToken={(id) => openScreen({ kind: "token", id })} />}
      </div>
      {desktop && money ? (
        <aside
          className="desktop-money-panel"
          aria-label={money === "withdraw" ? "Withdraw funds" : "Add funds"}
        >
          {account && <FundingPanel key={money} mode={money} account={account} onClose={()=>goTab(tab)}/>}
        </aside>
      ) : desktop && mine ? (
        <DesktopPortfolio
          selectedToken={token}
          mine={mine}
          tokens={live.tokens}
          stopped={stopped}
          perTrade={perTrade}
          perDay={perDay}
          mode={account?.status.mode ?? null}
          onScreen={openScreen}
          onTab={goTab}
        />
      ) : desktop ? <aside className="desktop-portfolio">{screen.kind === "create" ? <section className="hosted-entry"><h2>Make it yours.</h2><p>Pick a strategy, set its limits, and save your wallet’s recovery key.</p><p>You can start in paper mode and follow your agent before adding real funds.</p></section> : <AccountEntry account={account} accountFailed={accountFailed} portfolio={portfolioRead} retrying={accountBusy} onRefresh={refreshAccount}/>}</aside> : null}
      {(
          <nav className="tabbar" aria-label="Main navigation">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={activeTab === t.id ? "tab on" : "tab"}
                /* The guided first visit spotlights these by name. An
                   aria-label would have worked and would have tied a visual
                   affordance to an accessibility string, so that renaming a
                   label for screen readers silently unaimed the tour. */
                data-tour={`tab-${t.id}`}
                aria-label={t.label}
                aria-current={activeTab === t.id ? "page" : undefined}
                onClick={() => goTab(t.id)}
              >
                <TabIcon id={t.id} />
                {t.id === "agent" && chat.unread && <i className="tab-unread" aria-label="New in chat" />}
              </button>
            ))}
          </nav>
        )}
      {/* THE SAME AGENT SCREEN, FLOATING. Not a second chat: identical props
          and the one controller, so there is one conversation and one draft
          however it was opened — and closing it ends nothing in flight. A second
          implementation would be a second place for the agent's words to drift
          from what it actually did. */}
      {/* THE UNREAD DOT, ON DESKTOP. The tab bar that carries it is hidden at
          this width, so an answer that landed while the dock was closed would
          otherwise be told to nobody. One tap opens the dock on it. */}
      {desktop && !chatDocked && mine && chat.unread && (
        <button type="button" className="chat-unread-pill" onClick={() => setChatDocked(true)}>
          <i className="tab-unread" aria-hidden="true" />
          New from {mine.name}
        </button>
      )}
      {desktop && chatDocked && mine && (
        <ChatDock title={mine.name} onClose={() => setChatDocked(false)}>
          <Agent
            mine={mine}
            tokens={live.tokens}
            stopped={stopped}
            chat={chat}
            perTrade={perTrade}
            perDay={perDay}
            onToken={(id) => openScreen({ kind: "token", id })}
            onDeposit={() => openScreen({ kind: "deposit" })}
            onWithdraw={() => openScreen({ kind: "withdraw" })}
            onLimits={() => openScreen({ kind: "limits" })}
            onResign={() => {
              window.location.href = resignHref;
            }}
            onSettings={() => openScreen({ kind: "settings" })}
            liveBlocker={account?.status.liveBlocker}
            staleBlocker={autonomy.state === "checking"}
          />
        </ChatDock>
      )}
      {/* THE TAPE, which was built and mounted by nothing. Desktop only, and
          gated here rather than hidden in CSS, for the reason the header and
          rail are. Fed from the market read the shell already makes, so it
          costs no request and moves when the market read does. */}
      {ticks.length > 0 && (
        <TickerStrip
          className="terminal-tape"
          items={ticks.map((t) => ({
            key: t.id,
            href: pathForScreen({ kind: "token", id: t.id }),
            symbol: t.symbol,
            priceUsd: t.priceUsd,
            volume24hUsd: t.volume24hUsd,
            halted: t.halted,
            stale: t.stale,
          }))}
        >
          <SoundToggle on={soundOn} onToggle={toggleSound} />
        </TickerStrip>
      )}
    </div></div></WiredProvider>
  );
}
