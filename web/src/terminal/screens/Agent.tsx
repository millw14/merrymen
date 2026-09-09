import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Proposals } from "../Proposals";
import { blockerAdvice } from "@/lib/live-blocker";
import { badgeOf } from "@/lib/thesis-badge";
import { commandFor, commandPayload, type CommandArg } from "@/lib/chat-commands";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  X,
} from "lucide-react";
import {
  dailyChange,
  positionsOf,
  spentToday,
  type ChatTurn,
} from "../account";
import { ageOf, money, pctPts, type LiveMine, type LiveToken } from "../live";
import { strategyName } from "../strategy";
import { Coin, Empty, Face } from "../ui";
import { BalanceFigure } from "../studio";
import { TradeTokenCard } from "../TradeTokenCard";
import { isCircleStrategyId } from "../strategy";
import type { TierView } from "@/app/api/tier/route";
import { loadTier } from "../tier";

/**
 * How many recent moves the agent is shown.
 *
 * The whole tape used to go, which on its own overran the prompt's state
 * budget before the positions were even added — so the clamp downstream cut it
 * mid-object. Eight is what fits comfortably and is what a person means by
 * "recently".
 */
const TAPE_SHOWN = 8;

/** Sentence case for a badge label that is written lower-case by design. */
const capitalise = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1) : w);

/**
 * The newest moves, reduced to what the model can actually use.
 *
 * `at` travels so the agent can tell last month's refusal from this morning's.
 * Without it, a tape of stale rejections reads as the present tense — which is
 * exactly how a tester's agent came to report a months-old `no-gas` as its
 * current state. `movesShown`/`movesTotal` go beside it so the agent can say
 * "the last 8 of 30" rather than implying it saw everything.
 *
 * IT WAS HANDING OVER THE OLDEST EIGHT AND CALLING THEM THE LAST EIGHT.
 * `slice(-TAPE_SHOWN)` takes the TAIL, and the tape arrives newest-first —
 * /api/feed selects `ORDER BY created_at DESC` — so the model got the eight
 * stalest rows of the window while `movesShown` told it these were the recent
 * ones. That is the same present-tense-stale-refusal failure this comment was
 * written about, rebuilt one line below it; the 7-day window bounded how old
 * the lie could be and did not stop it being told.
 *
 * Sorted here rather than trusting the caller. The order is a fact about a SQL
 * clause two services away, and reading the tape backwards is silent — nothing
 * throws, nothing looks empty, the agent simply narrates the wrong week.
 */
const tapeFor = (moves: LiveMine["moves"]) =>
  [...moves]
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, TAPE_SHOWN)
    .map((m) => ({
      at: m.at,
      action: m.action,
      symbol: m.symbol,
      sizeUsdg: m.sizeUsdg,
      outcome: m.outcome,
      outcomeText: m.outcomeText,
    }));

const ASKS = [
  { label: "My strategy", question: "Explain your trading strategy." },
  { label: "My holdings", question: "What do you hold?" },
  { label: "Trading limits", question: "Explain my trading limits." },
];

export function Agent({
  mine,
  tokens,
  perTrade,
  perDay,
  stopped,
  turns,
  draft: ask,
  onDraft: setAsk,
  onTurn,
  onToken,
  onDeposit,
  onWithdraw,
  onLimits,
  onResign,
  liveBlocker,
}: {
  mine: LiveMine | null;
  tokens: LiveToken[];
  perTrade: string;
  perDay: string;
  stopped: boolean;
  turns: ChatTurn[];
  draft: string;
  onDraft: (value: string) => void;
  onTurn: (turn: ChatTurn) => void;
  onToken: (id: string) => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onLimits: () => void;
  /** Point at the ONE signing control — see Proposals.tsx. */
  onResign: () => void;
  /**
   * WHAT IS STOPPING THIS AGENT TRADING FOR REAL, as the child resolved it.
   *
   * Null is two answers and neither is a problem: trading for real, or never
   * beaten. See AgentStatus.liveBlocker.
   */
  liveBlocker?: string | null;
}) {
  const [sending,setSending]=useState(false);
  const [chatError,setChatError]=useState("");
  /**
   * THE ONE THING THE AGENT HAS ASKED PERMISSION TO DO.
   *
   * Deliberately NOT part of a ChatTurn. Turns are persisted to this browser,
   * and a confirmation card restored from storage would be an offer to act,
   * made by nobody, on a page the owner reopened days later. A proposal lives
   * as long as the conversation is on screen and no longer.
   */
  const [pending,setPending]=useState<{id:string;args:Record<string,CommandArg>}|null>(null);
  const [running,setRunning]=useState(false);
  /** Live while this screen is mounted, so a poll cannot outlive it. */
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<"positions" | "trades">("positions");
  const viewport = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const portfolio = useRef<HTMLDialogElement>(null);
  const follow = useRef(true);
  const [away, setAway] = useState(false);
  /**
   * This account standing against the Circle rule, read from the chain.
   *
   * Fetched here rather than derived from an event: an event ages out of the
   * feed window, and a permanent condition must not stop being reported because
   * the log moved on.
   */
  const [tier, setTier] = useState<TierView | null>(null);
  useEffect(() => {
    void loadTier().then(setTier);
  }, []);
  const scrollLatest = () => {
    const node = viewport.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    follow.current = true;
    setAway(false);
  };
  useLayoutEffect(() => {
    if (follow.current) scrollLatest();
  }, [turns.length]);
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(120, node.scrollHeight)}px`;
  }, [ask, !!mine]);
  useEffect(() => {
    const node = input.current;
    if (!node) return;
    let width = node.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = node.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      node.style.height = "auto";
      node.style.height = `${Math.min(120, node.scrollHeight)}px`;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [!!mine]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (follow.current) scrollLatest();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const dialog = portfolio.current;
    if (expanded && !dialog?.open) dialog?.showModal();
    if (!expanded && dialog?.open) dialog.close();
  }, [expanded]);
  if (!mine)
    return (
      <Empty
        kind="chat"
        title="Your agent starts here."
        action={{ label: "Fund an agent", onClick: onDeposit }}
      />
    );
  /**
   * Has this owner chosen a strategy their tier will not run?
   *
   * Both halves have to be known: an unread tier is not a locked one, so the
   * banner stays away until the chain has actually answered. `bonusStrategies`
   * is the tier's own field, so a future tier that unlocks these needs no
   * change here.
   */
  const circleLocked =
    isCircleStrategyId(mine.glance.id) && tier !== null && tier.why !== "sign-in" && !tier.bonusStrategies;
  const positions = positionsOf(mine);
  const trades = mine.moves
    .filter((t) => t.action === "buy" || t.action === "sell")
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const latest = trades[0];
  const latestToken = tokens.find(
    (t) => t.symbol.toUpperCase() === latest?.symbol?.toUpperCase(),
  );
  const change = dailyChange(mine);
  const send = async (question: string) => {
    if (!question.trim() || sending) return;
    setSending(true);setChatError("");
    follow.current = true;
    try {
      const settings = await fetch("/api/settings", {signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():null).catch(()=>null);
      // WHAT IT ACTUALLY HOLDS, under the key the system prompt names.
      //
      // `positions` used to be `mine.glance` — a STRATEGY descriptor whose
      // `legs` are percentage weights. So an owner asked their agent what NVDA
      // and QQQ had cost and when it would sell, and it answered that it held
      // nothing but cash, while the panel eighteen inches to its right listed
      // both. It was not hallucinating; it was reading the payload it was given.
      //
      // Cost and P&L travel with each holding, because "should I take this
      // profit" cannot be answered from a value alone. NULL, never 0, when the
      // ledger has no basis — the difference between not knowing what something
      // cost and believing it was free.
      const sizeOf = (settings?.values ?? {}) as Record<string, unknown>;
      const num = (k: string) => {
        const v = sizeOf[k] ?? (settings?.defaults as Record<string, unknown> | undefined)?.[k];
        return typeof v === "number" ? v : null;
      };
      const response = await fetch("/api/chat", {method:"POST",headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(45000),body:JSON.stringify({message:question.trim(),state:JSON.stringify({name:mine.name,equity:mine.equity,strategy:settings?.values?.strategy ?? settings?.defaults?.strategy ?? mine.glance.id,basketSymbols:(settings?.values?.basketSymbols ?? settings?.defaults?.basketSymbols ?? null) as string[]|null,paperTradingEnabled:settings?.values?.paperTradingEnabled ?? settings?.defaults?.paperTradingEnabled ?? null,workerStatus:mine.statusLabel ?? "Unknown",liveBlocker:liveBlocker ?? null,positions:(mine.positions ?? []).map(p=>({symbol:p.symbol,valueUsd:p.valueUsd,costUsd:p.costUsd,unrealisedPct:p.pnlPct===null?null:Math.round(p.pnlPct*10)/10,priceStale:p.stale,
        // THIS holding's own stop, graded when it was bought. Null means it
        // carries no grade and the book-wide `stopLossBps` below applies — the
        // distinction matters because "what would make you sell THIS" is the
        // question owners actually ask, and one number for a whole book was
        // never the honest answer to it.
        stopLossBps:p.floorBps,stopWhy:p.floorWhy})),cashUsd:mine.glance.cashUsd ?? null,vaultUsd:mine.glance.vaultUsd ?? null,
        // The two rules that answer "what would make you get out" — the levels
        // that sell WITHOUT asking the model. Null means none is armed, which
        // is a different answer from a level at zero.
        stopLossBps:num("strategistStopLossBps"),takeProfitBps:num("takeProfitBps"),
        moves:tapeFor(mine.moves),movesShown:Math.min(mine.moves.length,TAPE_SHOWN),movesTotal:mine.moves.length,perTrade,perDay,stopped}),history:turns.flatMap(t=>[{role:"user",content:t.question},{role:"assistant",content:t.answer}]).slice(-8)})});
      const data = await response.json();
      if(!response.ok || !data.reply) throw new Error(response.status===401 ? "Sign in again to chat with your agent." : data.why === "no-llm" ? "Chat is not configured yet. Open Settings to connect an AI provider." : "Your agent could not reply. Try sending again.");
      onTurn({question:question.trim(),answer:data.reply});
      // VALIDATED AGAIN HERE. The route checks the id against the registry, and
      // so does this — the client must not render a card for something it
      // cannot describe, and `say` is where the description comes from.
      setPending(data.command && commandFor(data.command.id) ? data.command : null);
      setAsk("");
    } catch(error) {setChatError(error instanceof Error ? error.message : "Could not send. Try again.");}
    finally {setSending(false);input.current?.focus();}
  };
  /**
   * WAIT FOR THE ANSWER, AND SAY IT IN THE AGENT'S OWN WORDS.
   *
   * An order is the only command here that finishes somewhere else. It is
   * queued, ferried, claimed, put to the wall and signed — seconds to a minute
   * later — and until this existed the owner was told "placed it" and then
   * nothing, ever. A refusal that never reaches the wall writes no trade row,
   * so the tape cannot carry it either: this poll is the ONLY way the reason
   * reaches the person who asked.
   *
   * The sentence comes from the WORKER, which read the ledger row. Nothing here
   * infers an outcome — a browser guessing at what a trade did is exactly the
   * claim this codebase refuses to make.
   *
   * Bounded and best-effort: it stops when the answer lands, when the order
   * outlives its own five-minute window, or when the screen goes away. A poll
   * that cannot end is a worse bug than a missing sentence.
   */
  const followOrder = async (id: string) => {
    const started = Date.now();
    while (Date.now() - started < 7 * 60_000) {
      await new Promise((r) => setTimeout(r, 5_000));
      if (!alive.current) return;
      let data: { state?: string; result?: string | null } | null = null;
      try {
        const r = await fetch(`/api/orders?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8_000) });
        data = r.ok ? await r.json() : null;
      } catch {
        continue; // a dropped poll is not an outcome
      }
      if (data?.state === "done" && data.result) {
        onTurn({ question: "", answer: data.result });
        return;
      }
    }
    // NOT SILENCE. Seven minutes without an answer means the worker never took
    // it — which is a real thing an owner needs told, and the state they were
    // left in before was an unexplained absence.
    if (alive.current) {
      onTurn({
        question: "",
        answer:
          "I never got to that order — my worker did not pick it up in time, so nothing was sent. " +
          "Ask again and I will try once more.",
      });
    }
  };

  /**
   * DO THE THING THE OWNER JUST CONFIRMED.
   *
   * The model proposed it; this runs only from a click, and it calls the SAME
   * authenticated route the buttons already call. Nothing here is a new way
   * into the app — it is the existing way, reached by asking.
   */
  const confirm = async () => {
    const cmd = pending && commandFor(pending.id);
    if (!cmd || running) return;
    setRunning(true);
    setChatError("");
    try {
      if (cmd.via === "navigate") {
        window.location.href = cmd.to!;
        return;
      }
      if (cmd.via === "snipe") {
        // A SNIPE ANSWERS IN FOUR WAYS AND ONLY ONE OF THEM IS A TRADE.
        //
        // The server resolves what was typed, so the reply that comes back is
        // already the sentence to show — one coin placed, several coins asking
        // which, not covered by the key yet, or nothing found. Rendering it
        // verbatim is deliberate: every one of those is a fact the browser does
        // not have and must not invent, and three of them are not errors.
        const res = await fetch("/api/snipe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(commandPayload(cmd, pending!.args)),
        });
        const out = (await res.json().catch(() => null)) as {
          outcome?: string;
          say?: string;
          error?: string;
          target?: { symbol?: string };
          usdgAmount?: number;
        } | null;
        if (!res.ok && !out?.say) throw new Error(out?.error ?? `that was refused (${res.status})`);
        // RESOLVED IS NOT PLACED. The route's job ends at "this query means this
        // one coin, and your key covers it"; the order goes through the SAME
        // channel the buy card uses, from here, so there is exactly one way an
        // order is ever created. The other three outcomes never reach an order
        // at all and are rendered as what they are.
        if (out?.outcome === "resolved" && out.target?.symbol) {
          const placed = await fetch("/api/orders", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ side: "buy", symbol: out.target.symbol, usdgAmount: out.usdgAmount }),
          });
          const body = (await placed.json().catch(() => null)) as
            | { error?: string; duplicate?: boolean }
            | null;
          if (!placed.ok) throw new Error(body?.error ?? `that was refused (${placed.status})`);
          onTurn({
            question: "✓ confirmed",
            answer: body?.duplicate
              ? `${out.say} I already had that one queued, so I have not placed it twice.`
              : `${out.say} Placed, not filled — my key's limits still decide, and however it ends it lands on your trades.`,
          });
          setPending(null);
          return;
        }
        onTurn({ question: "✓ confirmed", answer: out?.say ?? "I could not tell how that went." });
        setPending(null);
        return;
      }
      if (cmd.via === "order") {
        // AN ORDER IS QUEUED, NOT DONE, AND THE SENTENCE HAS TO SAY SO.
        //
        // A settings write is finished when the PUT returns. An order's 200
        // means one thing only: a row exists on the command channel. It has not
        // been ferried to the worker, not claimed, not put to the wall, not
        // signed. The whole outcome — filled, refused by the cap, practised on
        // paper, reverted — arrives a minute later and lands on the TAPE, which
        // is where every other trade this agent makes is stated.
        //
        // So this writes the one sentence the ledger cannot yet make, in the
        // past tense of the ASKING rather than of the trading: "I've placed it"
        // is true the moment the row exists; "bought TSLA" would be a claim
        // about somebody's money made by a browser, ahead of any evidence.
        const placed = await fetch("/api/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(commandPayload(cmd, pending!.args)),
        });
        const body = (await placed.json().catch(() => null)) as
          | { error?: string; id?: string; duplicate?: boolean }
          | null;
        if (!placed.ok) throw new Error(body?.error ?? `that was refused (${placed.status})`);
        // "IT LANDS ON YOUR TRADES EITHER WAY" WAS FALSE. Only a trade row
        // reaches the tape, and every refusal that returns before an intent is
        // built — paused, expired, over the ceiling, a symbol I do not watch,
        // no position, no grant — writes no row at all. So the tape would stay
        // empty forever while the turn promised it would not, and the turn is
        // PERSISTED to this browser, so the false promise outlives the order.
        //
        // What is true the moment the row exists is only that it was placed. So
        // that is what this says, and the outcome is fetched below and said in
        // its own turn — from the worker's own words, not from a guess here.
        onTurn({
          question: "✓ confirmed",
          answer: body?.duplicate
            ? `That exact order is already queued — I have not placed a second one.`
            : `Placed it — ${cmd.say(pending!.args)} It is with my key now; the limits you signed decide whether it goes through, and I will tell you which.`,
        });
        setPending(null);
        if (body?.id) void followOrder(body.id);
        return;
      }
      // READ-MODIFY-WRITE at click time, and ONLY the declared keys.
      // `commandPayload` drops everything the command did not declare, and
      // /api/settings strips every house-owned field again on the server — two
      // independent gates, neither relying on the other.
      const put = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(commandPayload(cmd, pending!.args)),
      });
      if (!put.ok) {
        const j = (await put.json().catch(() => null)) as { errors?: string[] } | null;
        throw new Error(j?.errors?.join(" ") ?? `that was refused (${put.status})`);
      }
      // SAID BACK IN THE CONVERSATION, not as a toast that vanishes. What an
      // agent did on your instruction belongs in the record of what you asked.
      onTurn({ question: "✓ confirmed", answer: `Done — ${cmd.say(pending!.args)}` });
      setPending(null);
    } catch (e) {
      setChatError(e instanceof Error ? e.message : "That did not go through.");
    } finally {
      setRunning(false);
    }
  };

  const blocked = blockerAdvice(liveBlocker);
  return (
    <div className="desk-page">
      {/* WHAT IS STOPPING THIS AGENT, ON THE SCREEN ITS OWNER OPENS.
          The sentence existed — status-line.ts has had a testnet branch for
          months — but it renders on /you, and an owner who thinks their agent
          is trading has no reason to go there. Measured on the fleet: ten
          agents on the practice chain and six with a dead policy, every one of
          them showing an ordinary-looking desk while being structurally unable
          to trade. Their owners are the ones reporting "it doesn't trade".
          Only they can fix it — a re-sign needs their signature — so the least
          this screen can do is say so and point at the control. */}
      {blocked && (
        <section className="desk-blocked" role="status">
          <p>{blocked.say}</p>
          {/* Money is not the fix for wrong-chain, dead-policy or not-armed —
              blockerAdvice says which — so only those get sent to the signer. */}
          {!blocked.funding && (
            <button type="button" onClick={onResign}>
              Fix it — re-sign my permission →
            </button>
          )}
        </section>
      )}
      {/* THE WARNINGS NOBODY HAS EVER SEEN, finally somewhere somebody looks.
          /api/feed has selected the events table for a long time and the
          terminal dropped it: LiveMine had no field for it, and the only
          renderer in the repo is in app/(app)/you/YouClient.tsx, whose route
          returns null. So every gate that reports itself with addEvent() and
          nothing else was invisible by construction — the Circle-strategy
          block, the trencher rail, the discovery credential check. Each one
          turns a blocked agent into a quiet one, which is what an owner
          reports as "it doesn't trade".

          BELOW the blocker banner on purpose. `liveBlocker` is the resolved
          answer to "why can't it trade for real" and outranks a log line; this
          is for everything that has no blocker rule and would otherwise say
          nothing at all. */}
      {/* The notice and the proposals panel used to sit HERE, pinned above the
          conversation. They now scroll with it — see the top of
          `.desk-conversation` below. The blocker stays pinned: it is short, and
          it is the one thing on this screen that must not be scrolled past. */}
      <header className="desk-header">
        <Face name={mine.name} slug={mine.slug} />
        <div>
          <h1>{mine.name}</h1>
          <p>{strategyName(mine.glance.id)}</p>
        </div>
        <span className={`desk-status ${stopped ? "paused" : ""}`}>
          <i />
          {mine.statusLabel ?? "Offline"}
        </span>
      </header>
      <section className="desk-portfolio">
        <button
          type="button"
          className="portfolio-summary"
          aria-expanded={expanded}
          aria-controls="agent-portfolio"
          onClick={() => setExpanded((value) => !value)}
        >
          <div>
            <span className="account-label">Agent balance</span>
            <strong className="desk-equity">
              <BalanceFigure value={mine.equity} />
            </strong>
            <span className={mine.chg24 == null ? "meta" : mine.chg24 < 0 ? "down" : "up"}>
              {mine.chg24 == null
                ? "Daily change unavailable"
                : `${mine.chg24 >= 0 ? "+" : "−"}${money(Math.abs(mine.chg24))}${change == null ? "" : ` (${pctPts(change)})`} today`}
            </span>
          </div>
          <span className="portfolio-toggle">
            Portfolio{" "}
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
        </button>
        {
          <div className="agent-portfolio-meta">
            <span>
              {positions.length}{" "}
              {positions.length === 1 ? "position" : "positions"}
            </span>
            {mine.glance.cashUsd != null && (
              <span>{money(mine.glance.cashUsd)} cash</span>
            )}
          </div>
        }
        <dialog
          ref={portfolio}
          className="portfolio-dialog"
          id="agent-portfolio"
          aria-labelledby="portfolio-title"
          onClose={() => setExpanded(false)}
          onCancel={() => setExpanded(false)}
        >
          <header className="portfolio-dialog-header">
            <div>
              <h2 id="portfolio-title">Portfolio</h2>
              <p>
                {mine.name} · {money(mine.equity)}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close portfolio"
              onClick={() => setExpanded(false)}
            >
              <X size={20} />
            </button>
          </header>
          <div className="portfolio-actions">
            <button type="button" onClick={onDeposit}>
              Add funds
            </button>
            <button type="button" onClick={onWithdraw}>
              Withdraw
            </button>
          </div>
          <div className="portfolio-body">
            <div
              className="desk-segments"
              role="group"
              aria-label="Portfolio view"
            >
              <button
                type="button"
                aria-pressed={view === "positions"}
                onClick={() => setView("positions")}
              >
                Positions · {positions.length}
              </button>
              <button
                type="button"
                aria-pressed={view === "trades"}
                onClick={() => setView("trades")}
              >
                Trades · {trades.length}
              </button>
            </div>
            {view === "positions" ? (
              <>
                {positions.length === 0 && (
                  <Empty compact kind="positions" title="No positions reported yet."/>
                )}
                {positions.map((p) => {
                  const token = tokens.find(
                    (t) => t.symbol.toUpperCase() === p.symbol.toUpperCase(),
                  );
                  return (
                    <button
                      type="button"
                      className="desk-position"
                      key={p.symbol}
                      disabled={!token}
                      onClick={() => token && onToken(token.id)}
                    >
                      <Coin symbol={p.symbol} logo={token?.logo ?? ""} />
                      <span>
                        <strong>{p.symbol}</strong>
                        <small>{token?.name ?? p.detail}</small>
                      </span>
                      <span
                        className={
                          p.pnl == null ? "" : p.pnl < 0 ? "down" : "up"
                        }
                      >
                        {p.pnl == null ? p.detail : pctPts(p.pnl)}
                      </span>
                    </button>
                  );
                })}
                <div className="desk-cash">
                  <span>Available cash</span>
                  <strong>{money(mine.glance.cashUsd ?? null)}</strong>
                </div>
                {mine.glance.vaultUsd != null && (
                  <div className="desk-cash">
                    <span>In vaults</span>
                    <strong>{money(mine.glance.vaultUsd)}</strong>
                  </div>
                )}
              </>
            ) : (
              <div className="desk-trades">
                {trades.length === 0 && (
                  <Empty compact title="No trades yet."/>
                )}
                {trades.map((t, i) => (
                  <article className="desk-trade" key={`${t.at}-${i}`}>
                    <div>
                      <strong>
                        {t.action === "buy" ? "Buy" : "Sell"} {t.symbol}
                      </strong>
                      <strong>{money(t.sizeUsdg)}</strong>
                    </div>
                    <p>{t.reason ?? "No explanation available."}</p>
                    <small>
                      {ageOf(t)} ago · {t.outcome ?? "Recorded"}
                      {t.paper ? " · Paper trade" : ""}
                    </small>
                  </article>
                ))}
              </div>
            )}
            <button
              type="button"
              className="desk-text-button"
              onClick={onLimits}
            >
              Trading limits{" "}
              <span>
                {money(Number(perTrade))} / trade{" "}
                <ArrowUpRight size={14} aria-hidden="true" />
              </span>
            </button>
          </div>
        </dialog>
      </section>
      <section
        ref={viewport}
        className="desk-conversation"
        aria-label="Agent conversation"
        tabIndex={0}
        onScroll={() => {
          const node = viewport.current;
          if (!node) return;
          const isAway =
            node.scrollHeight - node.scrollTop - node.clientHeight > 48;
          follow.current = !isAway;
          setAway(isAway);
        }}
      >
        {/* ANNOUNCEMENTS SCROLL WITH THE CHAT, rather than standing on top of it.
            Pinned above the conversation, these came straight out of the only
            flexible row on a fixed-height screen: measured at 375px, the
            conversation had 394px with nothing above it and 220px with the
            proposals panel — and with the panel expanded it collapsed to 83px.
            A screen opened to talk to an agent gave most of the phone to a
            banner the owner had already read, which is what "it just blocks the
            way" means.

            Inside the scroller they cannot take the conversation's height at
            all: they occupy the top of it and scroll away as soon as there is
            anything to read. Nothing is hidden, nothing can overflow, and the
            count no longer matters — a third banner costs nothing. */}
        {/* THE HARD STOP, STATED AS ONE.
            A Circle-strategy block is not a quiet note: the agent arms, reads
            the market, proposes nothing, and will go on doing that for ever
            until its owner holds the token. It announced itself with a single
            warn event — so the one tester who worked it out did so by opening
            /api/circle, which he called "not good for normies".

            Rendered from the reader's OWN standing rather than from a log line,
            so it is true on the first paint and does not depend on an event
            still being inside the feed's forty-row window hours later. */}
        {circleLocked && (
          <section className="desk-circle-locked" role="status">
            <strong>
              {strategyName(mine.glance.id)} is a Merry Circle strategy — it isn&apos;t running.
            </strong>
            <p>
              {tier?.why === "unreadable"
                ? "We couldn't read your $MERRYMEN balance just now, so this may clear on its own. That's our read failing, not your wallet."
                : `Your agent is armed and watching, but this strategy only runs while you hold ${(
                    tier?.needTokens ?? 100_000
                  ).toLocaleString("en-US")} $MERRYMEN — you hold ${(
                    tier?.tokens ?? 0
                  ).toLocaleString("en-US")}. Adding funds won't change it. Switch to Steady basket or Strategist, which run for everyone, or hold the token.`}
            </p>
          </section>
        )}
        {!blocked && !circleLocked && mine.notice && (
          <section className="desk-notice" role="status">
            <p>{mine.notice.message}</p>
          </section>
        )}
        <Proposals onResign={onResign} />
        <div className="chat-divider">
          <span>Conversation</span>
        </div>
        <div className="desk-reply">
          <Face name={mine.name} slug={mine.slug} small />
          <div>
            <strong>{mine.name}</strong>
            <p>
              {stopped
                ? "I’m not trading right now. You can review my portfolio and trading limits here."
                : latest
                  ? "Here’s my latest recorded trade."
                  : "I haven’t recorded a trade yet. Ask me about my strategy or your trading limits."}
            </p>
            {latest && (
              <article className="conversation-trade">
                <div className="chat-trade-caption">
                  {/*
                   * `badgeOf`, NOT `action` — this line said "Bought" for a
                   * trade the wall refused. It is the tester's own complaint
                   * ("the feed says I've bought things but nothing shows in my
                   * portfolio") on the screen he actually reads, and it
                   * outlived the feed fix because the desk kept its own copy
                   * of the conditional. The history list eight hundred lines
                   * below already names the outcome; only this caption
                   * asserted the fill.
                   */}
                  {capitalise(badgeOf(latest).label)} ·{" "}
                  {ageOf(latest) ? `${ageOf(latest)} ago` : "Recorded"}
                  {latest.paper ? " · Paper" : ""}
                </div>
                <TradeTokenCard
                  trade={latest}
                  token={latestToken}
                  onToken={onToken}
                />
                <p>
                  {latest.reason ??
                    "No explanation was recorded for this trade."}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setExpanded(true);
                    setView("trades");
                  }}
                >
                  View trade history{" "}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </button>
              </article>
            )}
            {!latest && mine.thesis && (
              <blockquote>
                <span className="strategy-caption">My approach</span>
                {mine.thesis}
              </blockquote>
            )}
          </div>
        </div>
        <div
          role="log"
          aria-label="Messages"
          aria-live="polite"
          aria-relevant="additions"
        >
          {turns.map((turn, i) => (
            <div className="desk-turn" key={i}>
              <div className="desk-question">{turn.question}</div>
              <div className="desk-reply">
                <Face name={mine.name} slug={mine.slug} small />
                <div>
                  <strong>{mine.name}</strong>
                  {turn.trade && (
                    <TradeTokenCard
                      trade={turn.trade}
                      token={tokens.find(
                        (t) =>
                          t.symbol.toUpperCase() ===
                          turn.trade?.symbol?.toUpperCase(),
                      )}
                      onToken={onToken}
                    />
                  )}
                  <p>{turn.answer}</p>
                  <CopyReply text={turn.answer} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
      <div className="desk-chat-bottom">
        {/* THE CLICK IS THE SECURITY BOUNDARY, NOT A COURTESY.
            The chat prompt is fed this owner's own ledger, and a position's
            `reason` is model-written text from ANOTHER agent — so the context
            is genuinely attacker-influenced. Chat can drive the app only
            because the model PROPOSES and a person CONFIRMS: an injected
            "sell everything" becomes a card somebody declines.
            The sentence below is OURS, from the registry — if the model wrote
            it, it could describe one action and request another, and this
            would be confirming the description rather than the act. */}
        {pending && commandFor(pending.id) && (
          <section
            className={`desk-confirm${commandFor(pending.id)!.weighty ? " is-weighty" : ""}`}
            role="group"
            aria-label="Confirm this action"
          >
            <p className="desk-confirm-say">{commandFor(pending.id)!.say(pending.args)}</p>
            <div className="desk-confirm-row">
              <button type="button" onClick={confirm} disabled={running}>
                {running ? "Doing it…" : commandFor(pending.id)!.via === "navigate" ? "Take me there" : "Yes, do it"}
              </button>
              <button
                type="button"
                className="desk-confirm-no"
                onClick={() => setPending(null)}
                disabled={running}
              >
                Not now
              </button>
            </div>
          </section>
        )}
        {sending && <p role="status">{mine.name} is thinking…</p>}
        {chatError && <p role="alert" className="flow-error">{chatError} {chatError.includes("Settings") && <a href="/settings">Open Settings</a>}</p>}
        {away && (
          <button type="button" className="chat-jump" onClick={scrollLatest}>
            <ArrowDown size={14} aria-hidden="true" /> Latest message
          </button>
        )}
        {turns.length === 0 && (
          <div className="desk-prompts">
            {ASKS.map((q) => (
              <button type="button" key={q.label} disabled={sending} onClick={() => send(q.question)}>
                {q.label}
              </button>
            ))}
          </div>
        )}
        <form
          className="desk-composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(ask);
          }}
        >
          <textarea
            ref={input}
            rows={1}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault();
                send(ask);
              }
            }}
            aria-label={`Message ${mine.name}`}
            value={ask}
            maxLength={2000}
            onChange={(e) => setAsk(e.target.value)}
            placeholder={`Message ${mine.name}…`}
          />
          <button
            type="submit"
            disabled={!ask.trim() || sending}
            aria-label="Send message"
          >
            <ArrowUp size={19} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </form>
      </div>
    </div>
  );
}

function CopyReply({ text }: { text: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  return (
    <div className="chat-message-actions">
      <button
        type="button"
        aria-label="Copy reply"
        title="Copy reply"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setStatus("copied");
          } catch {
            setStatus("error");
          }
        }}
      >
        {status === "copied" ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Copy size={14} aria-hidden="true" />
        )}
      </button>
      <span role="status">
        {status === "copied"
          ? "Copied"
          : status === "error"
            ? "Couldn’t copy. Select the text to copy it."
            : ""}
      </span>
    </div>
  );
}
