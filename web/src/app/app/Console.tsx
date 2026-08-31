"use client";

/**
 * The Sherwood Console — the sleek all-in-one /app, wired to real data.
 *
 * One surface: the agent home (equity + drawn sparkline + cash/vault/positions),
 * the wall (the on-chain caps as visible chips), the decision tape (landed AND
 * refused trades — the trust signature), positions, and a first-party chat.
 *
 * Data is live from /api/feed (ledger) + /api/grants (grant caps + on-chain
 * balances). The chat answers /status, /positions, /pnl and last-reasoning from
 * the fetched ledger for now; the LLM free-form path + wall-checked orders land
 * next (a real /api/chat).
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { statusLine, type AgentSnapshot } from "./status-line";
import Link from "next/link";
import type { FeedResponse, TradeRecord } from "@/app/api/feed/route";
import type { AgentStatus } from "@/app/api/grants/route";
import Onboarding, { type OnboardStep } from "./Onboarding";
import { LogoMark } from "@/components/Logo";
import { mascotMood } from "@/lib/mascot";

const usd = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

type ChatMsg = { role: "me" | "them"; html: string };

type Session = { hosted: boolean; address: string | null };

type DiscoveryRow = {
  token: string;
  name: string;
  venue: string;
  priceUsd: number | null;
  reserveUsd: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  buyers24h: number | null;
  ageDays: number | null;
  graduated: boolean;
  onCurve: boolean;
  /**
   * What the agent made of this coin, or null for "passed over" / "no model".
   *
   * A READING, never a permission. The wall admits only assets sealed into a
   * signature, so nothing said here can widen what the agent may trade.
   */
  verdict: { conviction: number; reason: string } | null;
};
type FreshRow = {
  token: string;
  curve: string;
  trades: number;
  traders: number;
  description: string;
  twitter: string;
  telegram: string;
  website: string;
  bare: boolean;
  symbol: string;
  name: string;
  logo: string;
  ageSec: number | null;
  progressBps: number | null;
};
type DiscoveriesPayload = {
  fetchedAt: number;
  scanned: number;
  rows: DiscoveryRow[];
  graduated: number;
  fresh: FreshRow[];
  /** Not one market feed answered. Different from an empty market — see the route. */
  indexUnreachable: boolean;
  /**
   * Which of the three chain reads came back.
   *
   * Per-PAGE, not per-coin, because that is how they fail: the RPC refuses the
   * burst and every card loses its symbol, logo and age at the same instant.
   * Saying it once above the grid is the truth; printing "couldn't read this
   * coin" on thirty cards would read as thirty broken coins.
   */
  chain: { launchpad: boolean; meta: boolean; facts: boolean; clock: boolean };
  /** Why nothing carries a verdict, when nothing does. null = it chose none. */
  verdictsWhy: "no-model" | "model-failed" | null;
};

export default function Console() {
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Sticky "the fund step is done" — set when the account first shows gas, or
  // when the owner explicitly skips it. Keeps the soft step from re-nagging on a
  // momentary balance blip. The hard steps (connect, create) never read this.
  const [onboarded, setOnboarded] = useState(false);

  useEffect(() => {
    try {
      setOnboarded(localStorage.getItem("mm_onboarded") === "1");
    } catch {
      /* private mode — the real-state gating still works without the flag */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const [f, s, se] = await Promise.all([
          fetch("/api/feed", { cache: "no-store" }).then((r) => r.json() as Promise<FeedResponse>),
          fetch("/api/grants", { cache: "no-store" }).then((r) => r.json() as Promise<AgentStatus>),
          fetch("/api/auth/session", { cache: "no-store" }).then((r) => r.json() as Promise<Session>),
        ]);
        if (!alive) return;
        setFeed(f);
        setStatus(s);
        setSession(se);
      } catch {
        /* transient — keep the last good numbers */
      } finally {
        if (alive) setLoaded(true);
      }
    };
    pull();
    const id = setInterval(pull, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const markOnboarded = () => {
    try {
      localStorage.setItem("mm_onboarded", "1");
    } catch {
      /* best effort */
    }
    setOnboarded(true);
  };

  // Once the account actually holds gas, remember it — so reaching camp is
  // one-way and a later read blip can't drag them back to the fund step.
  useEffect(() => {
    if (loaded && !onboarded && hasGas(status?.balances?.ethWei)) markOnboarded();
  }, [loaded, onboarded, status]);

  if (!loaded) {
    return (
      <div className="sc-root">
        <div className="loading">reading the ledger…</div>
      </div>
    );
  }

  const hosted = !!session?.hosted;
  const address = session?.address ?? null;
  const connected = !hosted || !!address; // self-hosted's perimeter is localhost
  const exists = !!status?.exists;
  const funded = hasGas(status?.balances?.ethWei);
  // NO GRANT YET MEANS ONBOARDING, and this fallback fired precisely then —
  // stamping "testnet 46630" into the footer and offering a testnet faucet to
  // someone who has not chosen a chain at all. The grant page now defaults to
  // mainnet, so the placeholder has to agree with it or the two screens
  // contradict each other before the user has done anything.
  const chainId = status?.grant?.chainId ?? 4663;

  // The guided first run — ONE step on screen, derived from real state. Connect
  // and create are hard gates; fund is soft (skippable and remembered). When
  // there's no incomplete step, the console loads.
  const step: OnboardStep | null = !connected
    ? "connect"
    : !exists
      ? "create"
      : !funded && !onboarded
        ? "fund"
        : null;

  if (step) {
    return (
      <Onboarding
        hosted={hosted}
        address={address}
        step={step}
        smartAccount={status?.grant?.smartAccount ?? null}
        testnet={chainId === 46630}
        onSkipFund={markOnboarded}
      />
    );
  }

  return <Loaded feed={feed} status={status!} />;
}

/** True when the agent's smart account holds any gas — the thing that actually
 *  gates trading. ethWei is a wei string; unreadable or zero reads as unfunded. */
function hasGas(wei?: string): boolean {
  if (!wei) return false;
  try {
    return BigInt(wei) > 0n;
  } catch {
    return Number(wei) > 0;
  }
}

function Loaded({ feed, status }: { feed: FeedResponse | null; status: AgentStatus }) {
  // One focus at a time. The rail used to be dead links over a wall of panels;
  // now it switches the main view — Home (the overview), Chat, or Positions — so
  // the console is calm and scannable instead of everything at once.
  const [view, setView] = useState<"home" | "chat" | "coins">("home");
  const [feedTab, setFeedTab] = useState<"fresh" | "trading">("fresh");
  // Fetched from /api/discoveries, which reads the index server-side rather
  // than the ledger — see that route for why a DB-backed panel would render
  // empty on the hosted deploy.
  const [disc, setDisc] = useState<DiscoveriesPayload | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/discoveries")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive) setDisc(d); })
        .catch(() => {});
    load();
    // Slower than the feed: the upstream API is keyless and rate-limited, and
    // a coin trending this minute is still trending in two.
    const t = setInterval(load, 120_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const grant = status.grant;
  const caps = grant?.caps;
  const chainId = grant?.chainId ?? null;
  const testnet = chainId === 46630;
  const mode = status.mode ?? "idle";

  // ── derive the numbers ──
  const equityPts = feed?.equity ?? [];
  const lastEq = equityPts.length ? equityPts[equityPts.length - 1] : null;
  // Prefer the ledger's last equity snapshot for the cash/vault split (it's the
  // valuation the agent acted on and needs no live RPC); fall back to the
  // on-chain balances read when there's no ledger yet.
  const balCash = lastEq ? lastEq.cash_usdg : status.balances ? Number(status.balances.cashUsdg) / 1e6 : 0;
  const balVault = lastEq ? lastEq.vault_usdg : status.balances ? Number(status.balances.vaultUsdg) / 1e6 : 0;
  const posSum = (feed?.positions ?? []).reduce((s, p) => s + (p.value_usdg || 0), 0);
  const eqNow = equityPts.length ? equityPts[equityPts.length - 1].equity_usdg : balCash + balVault + posSum;

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const firstToday = equityPts.find((p) => new Date(String(p.at).replace(" ", "T") + "Z") >= midnight);
  const todayDelta = firstToday ? eqNow - firstToday.equity_usdg : null;

  const contributed = feed?.netContributionsUsdg ?? null;
  const gas = feed?.gasUsdg ?? 0;
  const allTime = contributed !== null && contributed > 0 ? ((eqNow - contributed - gas) / contributed) * 100 : null;

  const split = { cash: balCash, vault: balVault, positions: posSum };
  const total = Math.max(1, split.cash + split.vault + split.positions);

  const daysLeft = grant ? Math.max(0, Math.floor((grant.expiresAt - Date.now() / 1000) / 86400)) : null;
  const landedToday = (feed?.trades ?? []).filter(
    (t) => t.status === "landed" && new Date(String(t.created_at).replace(" ", "T") + "Z") >= midnight,
  ).length;
  const refusedToday = (feed?.trades ?? []).filter(
    (t) => t.status === "rejected" && new Date(String(t.created_at).replace(" ", "T") + "Z") >= midnight,
  ).length;

  /**
   * The name, with a just-renamed override.
   *
   * The override is held HERE rather than inside the chip because the name is
   * on screen in more than one place — the topbar and the chat header — and an
   * optimistic update that only refreshed the control you clicked left the page
   * disagreeing with itself: "Little John" above, "Talk to Robin" below.
   *
   * It has to be optimistic at all because the worker reconciles the name into
   * the soul at its next arm, so /api/feed can report the old one for a tick or
   * two after a save that genuinely succeeded. It clears itself the moment the
   * server agrees, which is what keeps the server the source of truth.
   */
  const [renamed, setRenamed] = useState<string | null>(null);
  const serverName = feed?.agent?.name || "";
  useEffect(() => {
    if (renamed && serverName === renamed) setRenamed(null);
  }, [renamed, serverName]);
  const agentName = renamed || serverName || "your merryman";
  const strategy = feed?.agent?.strategy || grant?.grantFeatures?.[0] || "steady-basket";

  /**
   * The coins this agent could actually trade — the addresses baked into the
   * signature it is holding right now.
   *
   * This is the honest version of "the agent picks what to trade". Every card
   * carries it, because the alternative is a page of coins the agent is
   * structurally incapable of touching, presented as though it were choosing
   * between them. `grantTokens` is what the wall's approve permissions actually
   * name; a coin outside it cannot be bought or sold at any size, and adding it
   * needs the owner in settings and a re-signature.
   */
  const reach = new Set((grant?.grantTokens ?? []).map((a) => a.toLowerCase()));

  return (
    <div className="sc-root">
      <Embers />
      <div className="app">
        {/* rail */}
        <aside className="rail">
          <div className="brand">
            <span className="mark"><LogoMark size={18} /></span>
            <span>
              <b>merrymen</b>
              <br />
              <span className="dev">/app</span>
            </span>
          </div>
          {/* THREE places to be, not six. Positions folded into Home — it was
              already a tile there and a whole nav entry for one list is a
              button that does not earn its place. Wallet and Settings are the
              things you visit occasionally, so they read as utilities below the
              fold rather than peers of the three you actually live in. */}
          <nav className="nav">
            <button type="button" className={`navlink ${view === "home" ? "on" : ""}`} onClick={() => setView("home")}>
              <Ic d="home" /> Home
            </button>
            <button type="button" className={`navlink ${view === "coins" ? "on" : ""}`} onClick={() => setView("coins")}>
              <Ic d="spark" /> Coins {disc && <span className="tally">{disc.fresh.length + disc.rows.length}</span>}
            </button>
            <button type="button" className={`navlink ${view === "chat" ? "on" : ""}`} onClick={() => setView("chat")}>
              <Ic d="chat" /> Chat
            </button>
          </nav>
          <div className="rail-foot">
            <nav className="nav util">
              <Link className="navlink" href="/grant">
                <Ic d="wallet" /> Wallet
              </Link>
              <Link className="navlink" href="/settings">
                <Ic d="gear" /> Settings
              </Link>
            </nav>
            <div className="wallet">
              <span className="av" />
              <span className="who">
                <span className="addr">{short(grant?.owner)}</span>
                <br />
                <span className="net">owner key · on this device</span>
              </span>
              <span className="disc" title="connected" />
            </div>
          </div>
        </aside>

        {/* main */}
        <main className="main">
          <div className="topbar">
            <div className="agentchip">
              <span className="glyph"><LogoMark size={19} /></span>
              <span>
                <NameChip name={agentName} onRenamed={setRenamed} />
                <br />
                <span className="sub">
                  <b>{strategy}</b>
                  {daysLeft !== null && (
                    <>
                      {" "}
                      · session key expires in <b>{daysLeft}d</b>
                    </>
                  )}
                </span>
              </span>
            </div>
            <span className={`live ${mode !== "live" ? "paper" : ""}`} style={{ marginLeft: 18 }}>
              <span className="beat" /> {mode === "live" ? "LIVE" : mode === "paper" ? "PAPER" : "IDLE"}
            </span>
            <span className={`chainpill ${testnet ? "" : "mainnet"}`}>
              <span className="d" /> Robinhood · {testnet ? "testnet 46630" : `mainnet ${chainId ?? ""}`}
            </span>
          </div>

          {/* ── HOME: the overview — equity, the split, the wall, recent tape ── */}
          {view === "home" && (
            <>
              {/*
                THE ANSWER TO THE QUESTION EVERYONE ARRIVES WITH.

                A user with $318 in the account asked, in the group chat,
                "Will it now start trading" — looking at this very screen. It
                led with Total equity, then "building today · no deposit on
                record yet", then a cash/vault/positions split. All true, none
                of it an answer.

                So the status goes ABOVE the accounting. Both are worth having;
                this one comes first because it is what somebody who has just
                sent money is actually asking.
              */}
              <StatusBanner
                s={{
                  name: agentName,
                  mode,
                  testnet,
                  hasGas: hasGas(status.balances?.ethWei),
                  cashUsdg: balCash,
                  positionsUsdg: posSum,
                  positionCount: (feed?.positions ?? []).filter((x) => (x.value_usdg || 0) > 0).length,
                  // What the signature actually names, not what settings list —
                  // a coin outside `reach` cannot be bought at any size.
                  tradableCount: reach.size,
                  landedToday,
                  refusedToday,
                  daysLeft,
                  // The newest err the worker recorded. This is what makes a
                  // stuck agent say so instead of showing a calm dashboard of
                  // stale numbers — the failure mode that hid a fleet-wide
                  // outage for hours.
                  lastError: (feed?.events ?? []).find((e) => e.level === "err")?.message ?? null,
                }}
              />
              {/* Directly under the status line on purpose: the sentence says
                  what it is doing, and this is how you check that sentence is
                  true. Any further down and the person who doubts it never
                  scrolls that far. */}
              <SelftestButton />
              <section className="hero">
                <div className="equity">
                  <div className="kick">Total equity</div>
                  <div className="big">
                    <span className="num">{usd(eqNow)}</span>
                    <span className="unit">USDG</span>
                  </div>
                  <div className="row2">
                    {todayDelta !== null ? (
                      <span className={`delta ${todayDelta >= 0 ? "up" : "down"}`}>
                        {todayDelta >= 0 ? "▲ +" : "▼ "}
                        {usd(Math.abs(todayDelta))} today
                      </span>
                    ) : (
                      <span className="delta up" style={{ color: "var(--faint)" }}>
                        — building today
                      </span>
                    )}
                    <span className="sep">·</span>
                    <span className="putin">
                      {contributed !== null ? (
                        <>
                          you put in <b>{usd(contributed)}</b>
                          {allTime !== null && (
                            <>
                              {" · "}
                              <span className={`g ${allTime < 0 ? "down" : ""}`}>
                                {allTime >= 0 ? "+" : ""}
                                {allTime.toFixed(1)}%
                              </span>{" "}
                              all-time, net of gas
                            </>
                          )}
                        </>
                      ) : (
                        "no deposit on record yet"
                      )}
                    </span>
                  </div>
                </div>
                <div className="spark">
                  <Spark points={equityPts.map((p) => p.equity_usdg)} />
                </div>
              </section>

              {/* Where the money sits, and what it is allowed to do with it — the
                  chain's part and ours stated separately. Two LINES where there used
                  to be three cards and five more. Nothing was dropped: every figure
                  below appeared on a card of its own before, which is a lot of
                  furniture for numbers you read once and stop looking at. */}
              <section className="strip">
                <div className="bal">
                  <Slice label="Cash" v={split.cash} pct={(split.cash / total) * 100} color="var(--mint)" />
                  <Slice label="Vault" v={split.vault} pct={(split.vault / total) * 100} color="var(--gold)" />
                  <Slice label="Positions" v={split.positions} pct={(split.positions / total) * 100} color="var(--lime)" />
                </div>
                <p className="wallline">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path d="M12 2l8 4v6c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6z" />
                  </svg>
                  {/*
                    "The chain caps it at X a trade and Y a day, halts at Z%" put three
                    figures behind one subject, and the chain only enforces the first.
                    The daily total and the drawdown breaker are counters in this
                    software; so is trades-per-day, since 2026-08-30, when the policy
                    contract behind it turned out to have no code on this chain.

                    Split into two sentences rather than qualified in one, because a
                    parenthetical after a list of numbers gets skimmed past — and this
                    line is the whole security claim for anyone who never opens /grant.
                  */}
                  <span>
                    The chain caps it at <b>{caps ? usd(caps.perTradeUsdg) : "—"}</b> a trade and{" "}
                    <b>cannot move your money out</b>
                    {daysLeft !== null && <> · key dies in <b>{daysLeft}d</b></>}. merrymen itself
                    stops it at <b>{caps ? usd(caps.dailyUsdg) : "—"}</b> a day and{" "}
                    <b>{caps ? `${caps.maxDrawdownPct}%` : "—"}</b> drawdown — counters kept here,
                    not on-chain.
                  </span>
                </p>
              </section>

              <section className="floor">
                <div className="col">
                  <div className="panel">
                    <div className="panel-h">
                      <h3>The decision tape</h3>
                      <span className="kick">refused shown too</span>
                    </div>
                    <div className="tape">
                      {(feed?.trades ?? []).length === 0 ? (
                        <div className="empty-note">No trades yet — the band hasn&apos;t ridden.</div>
                      ) : (
                        (feed?.trades ?? []).slice(0, 7).map((t, i) => <TradeRow key={i} t={t} />)
                      )}
                    </div>
                    {refusedToday > 0 && (
                      <div className="tape-foot">
                        A trade the wall turns back is part of the record — <b>{refusedToday} refused today</b>, not hidden.
                      </div>
                    )}
                  </div>
                </div>
                <div className="col">
                  <div className="panel">
                    <div className="panel-h">
                      <h3>Positions</h3>
                      <span className="kick">{feed?.positions?.length ?? 0} open</span>
                    </div>
                    <div className="pos">
                      {(feed?.positions ?? []).length === 0 ? (
                        <div className="empty-note">All in cash and the vault.</div>
                      ) : (
                        (feed?.positions ?? []).map((p, i) => (
                          <div className="prow" key={i}>
                            <span className="s">
                              <span
                                className="tk"
                                style={{ background: p.price_source === "chainlink" ? "var(--mint)" : "var(--lime)" }}
                              />{" "}
                              {p.symbol}
                            </span>
                            <span className="px">
                              ${usd(p.price_usd)}
                              {p.price_source !== "chainlink" && <span className="tagpx">{p.price_source === "curve" ? "curve px" : p.price_source === "broker" ? "broker px" : "pool px"}</span>}
                            </span>
                            <span className="val">{usd(p.value_usdg)}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </section>
            </>
          )}

          {/* ── COINS: the launchpad and the market, as cards ── */}
          {view === "coins" && (
            <section className="coins">
              <div className="coins-head">
                <div className="seg">
                  <button
                    type="button"
                    className={feedTab === "fresh" ? "on" : ""}
                    onClick={() => setFeedTab("fresh")}
                  >
                    Just launched {disc && <i>{disc.fresh.length}</i>}
                  </button>
                  <button
                    type="button"
                    className={feedTab === "trading" ? "on" : ""}
                    onClick={() => setFeedTab("trading")}
                  >
                    Trading now {disc && <i>{disc.rows.length}</i>}
                  </button>
                </div>
                <span className="kick coins-when">
                  {/* Seconds, not a ledger timestamp: `timeAgo` re-appends a Z
                      to whatever it is given, which turns an ISO string into an
                      unparseable one and renders as a bare "read". */}
                  {disc ? `read ${agoFromEpoch(disc.fetchedAt)}` : "looking…"}
                </span>
              </div>

              {feedTab === "fresh" ? (
                <>
                  {!disc ? (
                    <div className="empty-note">Reading the launchpad…</div>
                  ) : disc.chain && !disc.chain.launchpad ? (
                    // NOT "nothing launched". Pons runs at ~940 launches an
                    // hour, so an empty list is never the likely explanation —
                    // and the read that produces these rows fails on its own
                    // terms (the node caps a log response at 10,000).
                    <div className="empty-note">
                      Couldn&rsquo;t read the launchpad just now — so this is what I don&rsquo;t know,
                      not a quiet hour. It retries on its own.
                    </div>
                  ) : disc.fresh.length === 0 ? (
                    <div className="empty-note">
                      Nothing launched in the last few minutes has anyone trading it. Pons runs at
                      roughly 940 launches an hour; the gate here is 25 trades from 3 different
                      addresses, which keeps about an eighth of them.
                    </div>
                  ) : (
                    <div className="cards">
                      {/* Said ONCE, above the grid — see DiscoveriesPayload.chain. */}
                      {chainGap(disc) && <div className="readfail">{chainGap(disc)}</div>}
                      {/* THE ANSWER TO “why has it not bought anything”.
                          Without this the page shows a wall of live coins and a busy
                          agent and lets the owner conclude the agent is broken. It is
                          not: there is nothing here it is able to buy. Say so. */}
                      {disc.fresh.every((f) => (f.progressBps ?? 0) < 10_000) && (
                        <div className="readfail">
                          Your agent can&rsquo;t buy any of these yet — every one is still on its
                          launch curve, and merrymen trades through Uniswap pools. There is
                          nothing to change in settings; they become buyable if one graduates.
                        </div>
                      )}
                      {disc.fresh.map((f) => (
                        <FreshCard key={f.token} f={f} reachable={reach.has(f.token.toLowerCase())} />
                      ))}
                    </div>
                  )}
                  <p className="coins-foot">
                    Every word and picture on these cards was written by whoever launched the coin.
                    The ticker, the name and the curve progress come from the chain; the rest is a
                    claim.
                  </p>
                </>
              ) : (
                <>
                  {!disc ? (
                    <div className="empty-note">Reading the tape…</div>
                  ) : disc.indexUnreachable ? (
                    // NOT "nothing is trading". The index is keyless and
                    // rate-limited, so a refusal is routine — and rendering it
                    // as an empty market states something false about the world
                    // while looking exactly like a normal, quiet page.
                    <div className="empty-note">
                      Couldn&rsquo;t reach the market index just now — so this is what I don&rsquo;t
                      know, not an empty market. It retries on its own.
                    </div>
                  ) : disc.rows.length === 0 ? (
                    <div className="empty-note">Nothing clearing the floor right now.</div>
                  ) : (
                    <div className="cards">
                      {disc.verdictsWhy && (
                        <div className="readfail">
                          {disc.verdictsWhy === "no-model"
                            ? "No model is wired up here, so nothing below has been looked at — these are the market’s numbers, not my opinion."
                            : "I tried to weigh these and the model turned me down, so no verdicts below. It retries on its own."}
                        </div>
                      )}
                      {disc.rows.every((r) => r.onCurve) && (
                        <div className="readfail">
                          Your agent can&rsquo;t buy any of these yet — every one is still on its
                          launch curve, so there is no pool to trade against. They become
                          buyable if one graduates.
                        </div>
                      )}
                      {disc.rows.map((r) => (
                        <MarketCard key={r.token} r={r} reachable={reach.has(r.token.toLowerCase())} />
                      ))}
                    </div>
                  )}
                  <p className="coins-foot">
                    A third party&rsquo;s reading of the market, not mine — {disc?.scanned ?? 0} pools
                    seen, nothing here checked against the chain.
                  </p>
                </>
              )}
            </section>
          )}

          {/* ── CHAT: the agent, full width ── */}
          {view === "chat" && (
            <section className="floor one chatview">
              <div className="col">
                <Chat
                  agentName={agentName}
                  strategy={strategy}
                  ledger={{ eqNow, todayDelta, allTime, positions: feed?.positions ?? [], refusedToday, events: feed?.events ?? [], daysLeft }}
                />
              </div>
            </section>
          )}
        </main>
      </div>

      <Mascot mode={mode} feed={feed} />

      {/* mobile tabs — the same three, plus settings. Five tabs on a 375px
          screen gave each one 71px and a label too small to read. */}
      <nav className="tabbar">
        <button type="button" className={`navlink ${view === "home" ? "on" : ""}`} onClick={() => setView("home")}>
          <Ic d="home" /> Home
        </button>
        <button type="button" className={`navlink ${view === "coins" ? "on" : ""}`} onClick={() => setView("coins")}>
          <Ic d="spark" /> Coins
        </button>
        <button type="button" className={`navlink ${view === "chat" ? "on" : ""}`} onClick={() => setView("chat")}>
          <Ic d="chat" /> Chat
        </button>
        <Link className="navlink" href="/settings">
          <Ic d="gear" /> Settings
        </Link>
      </nav>
    </div>
  );
}

/**
 * The status, in words, above the numbers.
 *
 * Deliberately plain: no chips, no monospace, no abbreviations. Everything
 * else on this screen is a readout for somebody who already knows what they
 * are looking at. This is the one line for somebody who does not.
 */
function StatusBanner({ s }: { s: AgentSnapshot }) {
  const line = statusLine(s);
  return (
    <section className={`statusline ${line.tone}`}>
      <span className="sl-dot" aria-hidden="true" />
      <div>
        <p className="sl-head">{line.headline}</p>
        <p className="sl-next">{line.next}</p>
      </div>
    </section>
  );
}

/**
 * PROVE IT CAN ACT — one real operation, for a fraction of a cent.
 *
 * The probe sends a policy-legal no-op through the whole pipeline: the bundler
 * handshake, the session-key signature, the account contract's call policy, the
 * EntryPoint prefund, account deployment, the receipt, the ledger row. It is
 * the difference between an agent that LOOKS armed and one that has actually
 * put a signed operation on-chain.
 *
 * Only reachable from a terminal until now (`merrymen selftest`), and hosted
 * users have no terminal — which is how ten agents sat unable to arm for hours
 * with nobody able to check.
 *
 * Three states, not two: queued and running look identical to somebody watching
 * a spinner, and mean different things when it stops changing. Queued-forever is
 * a worker that is not draining; running-forever is a probe that hung.
 */
function SelftestButton() {
  const [state, setState] = useState<"idle" | "queued" | "running" | "done">("idle");
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Poll only while something is in flight. A dashboard that polls forever for
  // a button nobody pressed is a cost with no reader.
  useEffect(() => {
    if (state !== "queued" && state !== "running") return;
    let alive = true;
    const tick = () =>
      fetch("/api/selftest", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!alive || !d) return;
          if (d.state === "done") {
            setResult(d.result ?? "finished, with nothing to say");
            setState("done");
          } else if (d.state === "running" || d.state === "queued") {
            setState(d.state);
          }
        })
        .catch(() => {});
    const t = setInterval(tick, 4_000);
    tick();
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [state]);

  async function run() {
    setErr(null);
    setResult(null);
    setState("queued");
    try {
      const r = await fetch("/api/selftest", { method: "POST" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setErr(d.error ?? "couldn’t queue it");
        setState("idle");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  }

  const busy = state === "queued" || state === "running";
  const passed = result?.startsWith("PASSED") ?? false;

  return (
    <div className="selftest">
      <button className="st-btn" onClick={() => void run()} disabled={busy}>
        {state === "queued"
          ? "queued — waiting for your agent to pick it up…"
          : state === "running"
            ? "running one real operation…"
            : "check it can actually trade"}
      </button>
      {state === "idle" && !err && !result && (
        <p className="st-note">
          Sends one tiny real operation — a fraction of a cent of gas — to prove the whole
          path works before you trust it with more.
        </p>
      )}
      {err && <p className="st-note st-bad">{err}</p>}
      {result && (
        <p className={`st-note ${passed ? "st-good" : "st-bad"}`}>
          {passed
            ? "It works. A signed operation reached the chain and the ledger recorded it. (This proves the approve step, not the swap itself.)"
            : result}
        </p>
      )}
    </div>
  );
}

function TradeRow({ t }: { t: TradeRecord }) {
  const rejected = t.status === "rejected" || t.status === "reverted";
  const isVault = t.kind.includes("vault");
  /*
    A SIMULATED FILL MUST NOT LOOK LIKE A REAL ONE.

    This fork was rejected / vault / everything-else, and `paper` fell into
    everything-else — so a pretend fill got the same green class, the same ↑
    and the same dollar figure as money that actually moved. On a screen whose
    job is to say what happened, that is the one mistake with no upside.

    It mattered more than it looks: hosted tenants could not reach paper mode
    at all, so nobody hit it — and the moment paper starts working (it does
    now), an unfunded or testnet agent begins filling this tape with numbers
    that read as profit.

    The other two tape surfaces already got this right — TradesPanel.tsx:80-84
    and BandSection.tsx:175 both render a 📜 chip. Same marker, same gold, so
    the product speaks with one voice about the same fact.
  */
  const paper = t.status === "paper";
  const cls = rejected ? "no" : isVault ? "vault" : paper ? "sim" : "ok";
  const ic = rejected ? "✕" : isVault ? "⛬" : paper ? "📜" : "↑";
  const kindLabel: Record<string, string> = {
    swap: "traded",
    "vault-deposit": "parked in the vault",
    "vault-withdraw": "pulled from the vault",
    transfer: "moved USDG",
    "equity-order": "traded",
  };
  const label = kindLabel[t.kind] ?? t.kind;
  return (
    <div className={`trade ${cls}`}>
      <span className="ic">{ic}</span>
      <span>
        <span className="sym">{t.buy_token ? symbolish(t) : t.kind.toUpperCase()}</span>{" "}
        <span className="desc">
          {rejected ? (
            <>
              refused — <span className="rule">{t.reject_rule || "wall"}</span>
            </>
          ) : (
            label
          )}
        </span>
      </span>
      <span className="amt">
        {/* The figure is real arithmetic on a pretend fill. Label it where the
            eye lands, not only in the icon. */}
        {rejected ? "—" : usd(t.amount_usdg)}
        {paper && <span className="sim-tag">sim</span>}
        <br />
        <span className="t">{timeAgo(t.created_at)}</span>
      </span>
    </div>
  );
}

// The ledger stores token addresses, not symbols, on trades; until the symbol
// join lands we label by the humanized kind. Kept as a seam.
function symbolish(t: TradeRecord): string {
  return t.kind === "vault-deposit" || t.kind === "vault-withdraw" ? "VAULT" : "TRADE";
}

/**
 * What this read could NOT see, in one sentence, or "" when it saw everything.
 *
 * The three chain reads fail together as a wave — the node refuses the burst —
 * so every card loses the same fields at the same moment. Naming the gap once
 * is honest; a blank ticker and an italic "Published nothing about itself" on
 * thirty cards is not, because that sentence is a claim about the COIN and the
 * coin never said it.
 */
function chainGap(d: DiscoveriesPayload): string {
  const c = d.chain;
  if (!c) return ""; // a payload from before this field existed
  const missing = [
    !c.facts && "tickers",
    !c.meta && "logos and links",
    !c.clock && "ages",
  ].filter(Boolean) as string[];
  if (!missing.length) return "";
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `The chain turned down this read, so ${list} are missing below. The trade counts are real. It retries on its own.`;
}

/** "just now" / "4m ago", from unix SECONDS. */
function agoFromEpoch(sec: number): string {
  const m = Math.max(0, Math.round((Date.now() / 1000 - sec) / 60));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function timeAgo(s: string): string {
  const then = new Date(String(s).replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(then)) return "";
  const m = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Name your merryman — in place, where you first meet him.
 *
 * "Robin" is `DEFAULT_NAME` in the worker's soul, and until now the only way to
 * change it was a Telegram command, so every hosted agent was called the same
 * thing. This is deliberately NOT a new onboarding step or a new button: it is
 * the name you were already looking at, made editable, with a nudge shown only
 * while it is still the default. Someone who does not care never sees a control
 * they have to dismiss.
 *
 * The same regex as the API and the soul, so the field rejects what the server
 * would reject rather than accepting it and quietly keeping the old name.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '.-]{0,23}$/;

function NameChip({ name, onRenamed }: { name: string; onRenamed: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  const [err, setErr] = useState(false);
  const shown = name;
  const unnamed = shown === "Robin" || shown === "your merryman";

  const save = async () => {
    const v = val.trim();
    if (!NAME_RE.test(v)) {
      setErr(true);
      return;
    }
    setEditing(false);
    setErr(false);
    // Optimistic, and lifted to the page: the worker reconciles the name into
    // the soul at its next arm, so the feed lags a tick behind a save that
    // worked. Every place the name appears has to move together.
    onRenamed(v);
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentName: v }),
      });
    } catch {
      /* the next feed poll is the source of truth */
    }
  };

  if (editing) {
    return (
      <span className="namechip">
        <input
          className={`nameinput ${err ? "bad" : ""}`}
          value={val}
          autoFocus
          maxLength={24}
          aria-label="Name your merryman"
          onChange={(e) => {
            setVal(e.target.value);
            setErr(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setEditing(false);
              setErr(false);
            }
          }}
          onBlur={save}
        />
        {err && <span className="namehint">letters or numbers to start, up to 24</span>}
      </span>
    );
  }

  return (
    <span className="namechip">
      <button
        type="button"
        className="nm"
        title="Rename"
        onClick={() => {
          setVal(unnamed ? "" : shown);
          setEditing(true);
        }}
      >
        {shown}
      </button>
      {unnamed && (
        <button type="button" className="nametag" onClick={() => { setVal(""); setEditing(true); }}>
          name him
        </button>
      )}
    </span>
  );
}

function Slice({ label, v, pct, color }: { label: string; v: number; pct: number; color: string }) {
  return (
    <div className="slice">
      <span className="lab">{label}</span>
      <span className="v num">{usd(v)}</span>
      <span className="bar">
        <i style={{ width: `${Math.min(100, Math.max(2, pct))}%`, background: color }} />
      </span>
    </div>
  );
}

/** "42s" / "7m" / "3h" — a launchpad card lives or dies on the seconds. */
function shortAge(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86_400)}d`;
}

/** $1.2M / $84k / $912 — never more precision than the number deserves. */
function compactUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

/**
 * A coin's picture.
 *
 * Two things are load-bearing. It goes through /api/coin-image, because every
 * IPFS gateway returns 403 to a browser User-Agent and a direct src is an empty
 * square on every device. And it falls back to the first letters of the ticker
 * rather than a broken-image glyph, because roughly 1 in 250 launches publishes
 * no logo at all and a card with a shattered icon reads as a broken page.
 */
function CoinArt({ logo, symbol }: { logo: string; symbol: string }) {
  const [failed, setFailed] = useState(false);
  const initials = (symbol || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  if (!logo || failed) return <span className="art fallback">{initials}</span>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- next/image would
    // need every launcher-chosen host in next.config; the proxy is the allowlist.
    <img
      className="art"
      src={`/api/coin-image?uri=${encodeURIComponent(logo)}`}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/** Whether the agent could act on this coin at all, as a badge. */
/**
 * CAN THE AGENT ACTUALLY BUY THIS COIN.
 *
 * There are TWO different noes here and they used to render as one. A coin
 * missing from the grant says "not added", and the fix is real: add it, re-sign,
 * done. A coin still on its bonding curve has NO POOL, and merrymen trades one
 * venue -- Uniswap v3 `exactInputSingle`. `curve-trade` exists as a type in
 * policy.ts and nothing in this repo has ever produced one, so there is no code
 * path that buys a curve token at any size, under any grant.
 *
 * Showing "not added" on a curve coin therefore promised a fix that does not
 * work: the owner adds the token, pays for a re-sign, and the agent still cannot
 * touch it. That is the exact shape of failure the rest of this codebase keeps
 * refusing -- a screen that looks like it is telling you what to do while being
 * wrong about what would happen. So the curve case is checked FIRST and says the
 * true thing, which is that waiting is the only option.
 */
function Reach({ ok, onCurve }: { ok: boolean; onCurve: boolean }) {
  if (onCurve) {
    return (
      <span
        className="badge out"
        title="This coin still trades on its launch curve, so there is no pool to trade against. merrymen buys through Uniswap only. Adding it to the grant will not help until it graduates."
      >
        no pool yet
      </span>
    );
  }
  return ok ? (
    <span className="badge in" title="This coin is named in the signature the agent holds — it can trade it.">
      in range
    </span>
  ) : (
    <span className="badge out" title="Not in the agent's grant. Add it in settings and re-sign, or it cannot be traded at any size.">
      not added
    </span>
  );
}

/** Just launched: age, curve progress, who is trading it, what it claims to be. */
function FreshCard({ f, reachable }: { f: FreshRow; reachable: boolean }) {
  const pct = f.progressBps === null ? null : f.progressBps / 100;
  return (
    <article className="card">
      <header>
        <CoinArt logo={f.logo} symbol={f.symbol} />
        <div className="idc">
          <div className="tick">
            {/* The ADDRESS when the ticker could not be read, never "unnamed" —
                that is a statement about the coin, and the coin has a name we
                simply failed to fetch. The address is true and still useful. */}
            <b>{f.symbol || short(f.token)}</b>
            {f.name && f.name !== f.symbol && <span className="nm">{f.name}</span>}
          </div>
          <div className="meta num">
            <span className="age">{shortAge(f.ageSec)} old</span>
            {/* Distinct ADDRESSES first: 291 trades from 25 addresses is a
                different thing from 223 from 176, and only one looks like people. */}
            <span>{f.traders} traders</span>
            <span>{f.trades} trades</span>
          </div>
        </div>
        <Reach ok={reachable} onCurve={(f.progressBps ?? 0) < 10_000} />
      </header>

      {pct !== null && (
        <div className="grad">
          <div className="gbar">
            <i style={{ width: `${Math.min(100, Math.max(1.5, pct))}%` }} />
          </div>
          <span className="glab num">{pct < 0.05 ? "<0.1" : pct.toFixed(1)}% to graduation</span>
        </div>
      )}

      {/* Three states, not two. "Published nothing about itself" is a CLAIM,
          and it may only be made when the metadata read actually succeeded —
          `bare` is now false when it did not, so an unread coin says nothing at
          all rather than being accused of silence. */}
      {f.description ? (
        <p className="say">{f.description}</p>
      ) : f.bare ? (
        <p className="say none">Published nothing about itself.</p>
      ) : null}

      <footer>
        {f.twitter && (
          <a className="soc" href={f.twitter} target="_blank" rel="noreferrer noopener nofollow">
            X
          </a>
        )}
        {f.telegram && (
          <a className="soc" href={f.telegram} target="_blank" rel="noreferrer noopener nofollow">
            Telegram
          </a>
        )}
        {f.website && (
          <a className="soc" href={f.website} target="_blank" rel="noreferrer noopener nofollow">
            Site
          </a>
        )}
        {f.bare && <span className="soc mute">no socials</span>}
      </footer>
    </article>
  );
}

/** Trading now: the index's numbers, with the curve caveat kept visible. */
function MarketCard({ r, reachable }: { r: DiscoveryRow; reachable: boolean }) {
  const up = (r.change24hPct ?? 0) >= 0;
  return (
    <article className="card">
      <header>
        <CoinArt logo="" symbol={r.name.split(/[\s/]/)[0] ?? ""} />
        <div className="idc">
          <div className="tick">
            <b>{r.name}</b>
            {r.graduated && <span className="pill lime">graduated</span>}
            {r.onCurve && <span className="pill">on its curve</span>}
          </div>
          <div className="meta num">
            <span>{r.ageDays === null ? "—" : shortAge(Math.round(r.ageDays * 86_400))} old</span>
            <span>{r.buyers24h === null ? "—" : `${r.buyers24h} buyers`}</span>
            <span>{compactUsd(r.volume24hUsd)} vol</span>
          </div>
        </div>
        <span className={`chg num ${up ? "up" : "down"}`}>
          {r.change24hPct === null ? "—" : `${up ? "+" : ""}${r.change24hPct.toFixed(1)}%`}
        </span>
      </header>

      <div className="figs num">
        <span>
          <i>Price</i>
          {r.priceUsd === null ? "—" : `$${r.priceUsd < 0.01 ? r.priceUsd.toPrecision(2) : r.priceUsd.toFixed(4)}`}
        </span>
        <span>
          <i>Market cap</i>
          {compactUsd(r.fdvUsd)}
        </span>
        <span>
          <i>Depth</i>
          {/* A coin still on its bonding curve reports a reserve that is mostly
              the VIRTUAL SEED — about $4,100 it does not hold — so it is never
              shown here as though it were money you could sell into. */}
          {r.onCurve ? "pre-graduation" : compactUsd(r.reserveUsd)}
        </span>
      </div>

      {/* THE AGENT'S OWN LINE, on the coin it is about.
          Conviction is an ORDERING — "look here first" — never a size and never
          a permission, so it renders as marks rather than a score out of five
          that would read like a rating. A coin with no verdict was passed over
          or never judged; saying nothing is the honest rendering of that. */}
      {r.verdict && (
        <div className="verdict">
          <span className="pips" aria-label={`conviction ${r.verdict.conviction} of 5`}>
            {"▮".repeat(Math.max(1, Math.min(5, r.verdict.conviction)))}
          </span>
          <span className="vsay">{r.verdict.reason}</span>
        </div>
      )}

      <footer>
        <span className="soc mute">{r.venue}</span>
        <Reach ok={reachable} onCurve={r.onCurve} />
      </footer>
    </article>
  );
}

// ── chat (real-data-aware; LLM free-form lands next) ──
type Ledger = {
  eqNow: number;
  todayDelta: number | null;
  allTime: number | null;
  positions: FeedResponse["positions"];
  refusedToday: number;
  events: FeedResponse["events"];
  daysLeft: number | null;
};

function Chat({ agentName, strategy, ledger }: { agentName: string; strategy: string; ledger: Ledger }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    {
      role: "them",
      html: `I'm ${escapeHtml(agentName)}. Ask me anything about your book — or for a quick <span class="mono">/status</span>, <span class="mono">/positions</span>, <span class="mono">/pnl</span>. Orders still go through the wall on the Wallet screen.`,
    },
  ]);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  // The tenant's own ledger, as a compact context the model narrates from. Built
  // client-side (the console has the feed) and sent to /api/chat, which supplies
  // only the LLM — so it works in hosted mode where the server can't read the
  // ledger. The model can never act on this; it returns text only.
  const buildState = () => {
    const posLine = ledger.positions.length
      ? ledger.positions
          .slice(0, 8)
          .map((p) => `${p.symbol} ${usd(p.value_usdg)} USDG @ $${usd(p.price_usd)}${p.price_source === "chainlink" ? "" : ` (${p.price_source} px)`}`)
          .join("; ")
      : "all in cash and the vault";
    const last = ledger.events.find((e) => e.level === "ok")?.message || ledger.events[0]?.message || "";
    return [
      `YOU ARE: ${agentName}, a merryman running the ${strategy} strategy on Robinhood Chain.`,
      `EQUITY: ${usd(ledger.eqNow)} USDG${ledger.todayDelta !== null ? `, ${ledger.todayDelta >= 0 ? "+" : ""}${usd(ledger.todayDelta)} today` : ""}${ledger.allTime !== null ? `, ${ledger.allTime >= 0 ? "+" : ""}${ledger.allTime.toFixed(1)}% all-time net of gas` : ""}.`,
      `POSITIONS: ${posLine}.`,
      `TODAY: ${ledger.refusedToday} trade(s) refused by the wall.${ledger.daysLeft !== null ? ` Session key expires in ${ledger.daysLeft} days.` : ""}`,
      last ? `RECENT FROM CAMP: ${last.slice(0, 240)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  /**
   * The answers that come straight from the ledger, or null when there is no
   * exact one.
   *
   * RETURNING NULL IS THE POINT. This used to return a shrug for anything it
   * did not recognise, which made "I answered exactly" and "I have nothing"
   * indistinguishable to the caller — so when the model was unavailable, a
   * `/status` with a precise answer sitting right there got an apology about a
   * failed model call instead. An exact figure from the tenant's own book beats
   * both a model and an excuse, and the caller can only prefer it if it can
   * tell the two apart.
   */
  const exactAnswer = (raw: string): string | null => {
    const q = raw.trim().toLowerCase();
    if (q.startsWith("/status") || q === "status") {
      const d =
        ledger.todayDelta !== null
          ? `${ledger.todayDelta >= 0 ? "▲ +" : "▼ "}${usd(Math.abs(ledger.todayDelta))} today`
          : "steady today";
      const at = ledger.allTime !== null ? `, ${ledger.allTime >= 0 ? "+" : ""}${ledger.allTime.toFixed(1)}% all-time` : "";
      return `Equity <span class="mono">${usd(ledger.eqNow)} USDG</span>, ${d}${at}. ${ledger.positions.length} open position${ledger.positions.length === 1 ? "" : "s"}, ${ledger.refusedToday} refused today${ledger.daysLeft !== null ? `, key dies in ${ledger.daysLeft} days` : ""}.`;
    }
    if (q.startsWith("/positions") || q.includes("position") || q.includes("holding")) {
      if (!ledger.positions.length) return "All in cash and the vault right now — no open positions.";
      return (
        "Open positions:\n" +
        ledger.positions
          .slice(0, 8)
          .map((p) => `• ${escapeHtml(p.symbol)} — <span class="mono">${usd(p.value_usdg)} USDG</span> @ $${usd(p.price_usd)}`)
          .join("\n")
      );
    }
    if (q.startsWith("/pnl") || q.includes("pnl") || q.includes("how much") || q.includes("making")) {
      return ledger.allTime !== null
        ? `Up <span class="mono">${ledger.allTime >= 0 ? "+" : ""}${ledger.allTime.toFixed(1)}%</span> all-time, net of gas — that's equity minus what you put in, not the bankroll dressed up as profit.`
        : "No deposit on record yet, so there's no honest P&L to state — I won't call your own capital a gain.";
    }
    if (q.includes("why") || q.includes("reason") || q.includes("thinking")) {
      const last = ledger.events.find((e) => e.level === "ok")?.message || ledger.events[0]?.message;
      return last
        ? `Last from camp: “${escapeHtml(last.slice(0, 220))}”. The full reasoning behind each trade — joined to the decision that made it — is what the chat gets next.`
        : "Nothing on the wire yet. Once I've taken a shot I'll tell you exactly why.";
    }
    if (q.includes("pause") || q.includes("stop") || q.includes("kill")) {
      return "Giving orders through chat — pause, kill, buy, sell — runs next, each checked against the wall before I move a thing. For now, pause and the kill switch live on the Wallet screen.";
    }
    return null;
  };

  /** The shrug, for when nothing else could answer. */
  const shrug = (): string =>
    `Heard you — but that one needs thinking, and I can't do it from the ledger alone. Ask me <span class="mono">/status</span>, <span class="mono">/positions</span> or <span class="mono">/pnl</span> for something exact.`;

  /**
   * What to say when the route could not think.
   *
   * The route ALREADY reports why — no-llm, llm-error, not signed in — and the
   * client used to discard it and print a line about free-form reasoning being
   * "the next thing I learn". That reads as an unbuilt feature. It is a missing
   * key: /api/chat calls a real model, but it resolves one only from the WEB
   * service's own environment, and the hosted deploy guide gives the house keys
   * to the orchestrator. A config gap that looks like a product gap is the
   * worst kind, because nobody can see there is something to fix.
   */
  const brainlessNote = (why: string, detail?: string): string => {
    if (why === "no-llm") {
      return "I can think, but I have no brain wired up right now — this deployment has no model key, so I can only answer the exact commands. Whoever runs it needs to set one on the web service.";
    }
    // The provider's OWN words when we have them: a decommissioned model and
    // a rejected key both used to read as "try again in a moment", which is
    // advice that never works for either.
    if (why === "llm-error") {
      return detail
        ? `I tried to think and the model turned me down — ${detail}`
        : "I tried to think and the model call failed. Try again in a moment.";
    }
    if (why === "not signed in") return "Sign in first and I can answer from your own book.";
    return `I couldn't answer that one (${why}).`;
  };

  const submit = async (text?: string) => {
    const v = (text ?? val).trim();
    if (!v || busy) return;
    setVal("");
    setBusy(true);
    const history = msgs.map((m) => ({ role: m.role === "me" ? "user" : "assistant", content: stripTags(m.html) }));
    setMsgs((m) => [
      ...m,
      { role: "me", html: escapeHtml(v) },
      { role: "them", html: '<span style="color:var(--faint);font-family:var(--mono)">…</span>' },
    ]);
    let modelHtml: string | null = null;
    let why: string | null = null;
    let detail: string | null = null;
    try {
      const r = (await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: v, state: buildState(), history }),
      }).then((res) => res.json())) as { reply?: string | null; why?: string; detail?: string };
      if (r && typeof r.reply === "string" && r.reply.trim()) modelHtml = escapeHtml(r.reply.trim());
      else if (r?.why) { why = r.why; detail = r.detail ?? null; }
    } catch {
      /* the ledger answer below still works with the route unreachable */
    }
    // Order of preference, and each step is a claim about what is TRUE rather
    // than about what is available:
    //   1. the model, which is the only thing that can actually reason;
    //   2. an exact figure from the tenant's own ledger — better than an
    //      apology, and better than a model paraphrasing a number it was handed;
    //   3. SAY WHY IT COULD NOT THINK. The route already reports this -- no-llm,
    //      llm-error, not signed in -- and the client used to throw it away and
    //      print a canned line about free-form reasoning being "the next thing I
    //      learn", which reads as a missing FEATURE. It is a missing KEY, and
    //      that difference is a config change nobody could see they had to make.
    const finalHtml = modelHtml ?? exactAnswer(v) ?? (why ? escapeHtml(brainlessNote(why, detail ?? undefined)) : shrug());
    // Replace the "…" placeholder with the real reply.
    setMsgs((m) => [...m.slice(0, -1), { role: "them", html: finalHtml }]);
    setBusy(false);
  };

  return (
    <div className="panel chat">
      <div className="panel-h">
        <h3>Talk to {escapeHtml(agentName).split(" ")[0]}</h3>
        <span className="live" style={{ marginLeft: "auto" }}>
          <span className="beat" /> here now
        </span>
      </div>
      <div className="chat-stream" ref={streamRef}>
        {msgs.map((m, i) => (
          <div className={`msg ${m.role}`} key={i}>
            <span className="who">{m.role === "me" ? "you" : agentName}</span>
            <div className="bubble" dangerouslySetInnerHTML={{ __html: m.html }} />
          </div>
        ))}
      </div>
      <div className="chips">
        {["/status", "/positions", "/pnl", "why?"].map((c) => (
          <span className="chip" key={c} onClick={() => submit(c)}>
            {c}
          </span>
        ))}
      </div>
      <div className="chat-in">
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={busy ? "Will is thinking…" : `Ask ${agentName.split(" ")[0]} anything…`}
          autoComplete="off"
        />
        <button className="send" onClick={() => submit()} aria-label="Send" disabled={!val.trim() || busy}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M22 2L11 13" />
            <path d="M22 2l-7 20-4-9-9-4z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * The little merryman in the corner. Every mood he has is a fact with a clock
 * behind it — see `mascotMood`, which is where the rule lives and is tested.
 * This component only renders what it is told.
 */
function Mascot({ mode, feed }: { mode: string; feed: FeedResponse | null }) {
  // Re-derives on every feed poll (10s) — no timer of its own, so he cannot
  // animate through a stretch where nothing actually happened.
  const { mood, say } = mascotMood({
    mode,
    lastEventAt: feed?.events?.[0]?.created_at,
    lastTradeAt: feed?.trades?.[0]?.created_at,
  });
  return (
    <div className={`mascot ${mood}`} aria-hidden="true">
      <div className="bub">{say}</div>
      <svg viewBox="0 0 64 72" fill="none">
        {/* hood */}
        <path className="cloak" d="M32 6c11 0 18 8 18 19 0 8-3 12-3 18l6 23H11l6-23c0-6-3-10-3-18C14 14 21 6 32 6z" />
        {/* face in shadow */}
        <path className="face" d="M32 15c6 0 10 5 10 11s-4 10-10 10-10-4-10-10 4-11 10-11z" />
        <circle className="eye" cx="27.5" cy="25" r="1.9" />
        <circle className="eye" cx="36.5" cy="25" r="1.9" />
        {/* feather in the cap */}
        <path className="feather" d="M44 12c5-4 9-4 12-2-2 5-6 8-11 8" />
        {/* the bow — drawn only when he looses */}
        <g className="bow">
          <path className="limb" d="M52 30c6 6 6 16 0 22" />
          <path className="string" d="M52 30l-6 11 6 11" />
          <path className="arrow" d="M44 41h16" />
        </g>
        {/* three dots while he thinks */}
        <g className="think">
          <circle cx="14" cy="16" r="2.2" />
          <circle cx="8" cy="11" r="1.6" />
          <circle cx="4" cy="7" r="1.1" />
        </g>
      </svg>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c);
}

/** Plain text of a rendered bubble, for sending prior turns back as chat history. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

// ── decorative canvas ──
function Spark({ points }: { points: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pts = points.length >= 2 ? points : [0, 0];
    let raf = 0;
    const draw = (prog: number) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth,
        h = cv.clientHeight;
      cv.width = w * dpr;
      cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const pad = 6,
        n = pts.length;
      const min = Math.min(...pts),
        max = Math.max(...pts);
      // A FLAT SERIES MUST DRAW A FLAT LINE. `range = max - min || 1` sent every
      // identical point to the TOP of the box, so an agent that has not traded —
      // the state every new account is in — rendered as a solid block of fill
      // reading like a chart that had gone vertical. Centre it instead.
      const flat = max - min < 1e-9;
      const range = flat ? 1 : max - min;
      const X = (i: number) => pad + (i / (n - 1)) * (w - 2 * pad);
      const Y = (v: number) =>
        flat
          ? pad + 0.5 * (h - 2 * pad - 12) + 4
          : pad + (1 - (v - min) / range) * (h - 2 * pad - 12) + 4;
      const last = Math.max(1, Math.floor(prog * (n - 1)));
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(58,216,132,0.20)");
      g.addColorStop(1, "rgba(58,216,132,0)");
      ctx.beginPath();
      ctx.moveTo(X(0), h - pad);
      for (let i = 0; i <= last; i++) ctx.lineTo(X(i), Y(pts[i]));
      ctx.lineTo(X(last), h - pad);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
      ctx.beginPath();
      for (let i = 0; i <= last; i++) {
        const x = X(i),
          y = Y(pts[i]);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = "#3ad884";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
      const ex = X(last),
        ey = Y(pts[last]);
      ctx.beginPath();
      ctx.arc(ex, ey, 3.2, 0, 7);
      ctx.fillStyle = "#b6e226";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex, ey, 7, 0, 7);
      ctx.strokeStyle = "rgba(182,226,38,0.35)";
      ctx.lineWidth = 1.4;
      ctx.stroke();
    };
    if (reduce) draw(1);
    else {
      const t0 = performance.now(),
        dur = 1100;
      const loop = (t: number) => {
        const k = Math.min(1, (t - t0) / dur);
        draw(k);
        if (k < 1) raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    const onR = () => draw(1);
    window.addEventListener("resize", onR);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onR);
    };
  }, [points]);
  return <canvas ref={ref} />;
}

function Embers() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let W = 0,
      H = 0,
      dpr = 1,
      raf = 0;
    const size = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = cv.width = innerWidth * dpr;
      H = cv.height = innerHeight * dpr;
      cv.style.width = innerWidth + "px";
      cv.style.height = innerHeight + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    window.addEventListener("resize", size);
    const N = Math.min(30, Math.floor(innerWidth / 44));
    const em = Array.from({ length: N }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      r: Math.random() * 1.4 + 0.4,
      s: Math.random() * 0.25 + 0.05,
      d: Math.random() * 0.4 - 0.2,
      a: Math.random() * 0.5 + 0.2,
      p: Math.random() * 6,
    }));
    const tick = (t: number) => {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const e of em) {
        e.y -= e.s;
        e.x += e.d + Math.sin(t / 2600 + e.p) * 0.12;
        if (e.y < -6) {
          e.y = innerHeight + 6;
          e.x = Math.random() * innerWidth;
        }
        const fl = e.a * (0.6 + 0.4 * Math.sin(t / 700 + e.p));
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r, 0, 7);
        ctx.fillStyle = `rgba(182,226,38,${fl * 0.5})`;
        ctx.shadowColor = "rgba(182,226,38,0.5)";
        ctx.shadowBlur = 6;
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
    };
  }, []);
  return <canvas id="sc-embers" ref={ref} aria-hidden="true" />;
}

function Ic({ d }: { d: string }) {
  const paths: Record<string, ReactElement> = {
    home: (
      <>
        <path d="M3 12l9-8 9 8" />
        <path d="M5 10v10h14V10" />
      </>
    ),
    spark: (
      <>
        <path d="M12 3v4" />
        <path d="M12 17v4" />
        <path d="M5 12H3" />
        <path d="M21 12h-2" />
        <path d="M7 7l3 3" />
        <path d="M14 14l3 3" />
      </>
    ),
    chat: <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
    chart: (
      <>
        <path d="M3 3v18h18" />
        <path d="M7 14l4-4 3 3 5-6" />
      </>
    ),
    wallet: (
      <>
        <rect x="3" y="6" width="18" height="13" rx="2" />
        <path d="M16 12h.01M3 10h18" />
      </>
    ),
    gear: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8 2 2 0 1 1-2.8 2.8 1.6 1.6 0 0 0-2.7 1.1 2 2 0 1 1-4 0 1.6 1.6 0 0 0-2.6-1.1 2 2 0 1 1-2.8-2.8A1.6 1.6 0 0 0 5 13.9a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7 2 2 0 1 1 2.8-2.8A1.6 1.6 0 0 0 11 4.9a2 2 0 1 1 4 0 1.6 1.6 0 0 0 2.7 1.1 2 2 0 1 1 2.8 2.8A1.6 1.6 0 0 0 22 12z" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      {paths[d]}
    </svg>
  );
}
