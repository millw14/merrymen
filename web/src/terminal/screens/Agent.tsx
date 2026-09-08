import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Proposals } from "../Proposals";
import { blockerAdvice } from "@/lib/live-blocker";
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

/**
 * How many recent moves the agent is shown.
 *
 * The whole tape used to go, which on its own overran the prompt's state
 * budget before the positions were even added — so the clamp downstream cut it
 * mid-object. Eight is what fits comfortably and is what a person means by
 * "recently".
 */
const TAPE_SHOWN = 8;

/**
 * The newest moves, reduced to what the model can actually use.
 *
 * `at` travels so the agent can tell last month's refusal from this morning's.
 * Without it, a tape of stale rejections reads as the present tense — which is
 * exactly how a tester's agent came to report a months-old `no-gas` as its
 * current state. `movesShown`/`movesTotal` go beside it so the agent can say
 * "the last 8 of 30" rather than implying it saw everything.
 */
const tapeFor = (moves: LiveMine["moves"]) =>
  moves.slice(-TAPE_SHOWN).map((m) => ({
    at: m.at,
    action: m.action,
    symbol: m.symbol,
    sizeUsdg: m.sizeUsdg,
    outcome: m.outcome,
    outcomeText: m.outcomeText,
  }));

const ASKS = [
  "How am I doing?",
  "What do you hold?",
  "Explain your last trade",
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
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<"positions" | "trades">("positions");
  const viewport = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const portfolio = useRef<HTMLDialogElement>(null);
  const follow = useRef(true);
  const [away, setAway] = useState(false);
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
        title="Your agent starts here."
        action={{ label: "Fund an agent", onClick: onDeposit }}
      />
    );
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
      const response = await fetch("/api/chat", {method:"POST",headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(45000),body:JSON.stringify({message:question.trim(),state:JSON.stringify({name:mine.name,equity:mine.equity,strategy:settings?.values?.strategy ?? settings?.defaults?.strategy ?? mine.glance.id,paperTradingEnabled:settings?.values?.paperTradingEnabled ?? settings?.defaults?.paperTradingEnabled ?? null,workerStatus:mine.statusLabel ?? "Unknown",positions:mine.glance,moves:tapeFor(mine.moves),movesShown:Math.min(mine.moves.length,TAPE_SHOWN),movesTotal:mine.moves.length,perTrade,perDay,stopped}),history:turns.flatMap(t=>[{role:"user",content:t.question},{role:"assistant",content:t.answer}]).slice(-8)})});
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
        const body = (await placed.json().catch(() => null)) as { error?: string } | null;
        if (!placed.ok) throw new Error(body?.error ?? `that was refused (${placed.status})`);
        onTurn({
          question: "✓ confirmed",
          answer:
            `Placed it — ${cmd.say(pending!.args)} It is with my key now; whether it goes through is ` +
            `up to the limits you signed. Watch your trades, it lands there either way.`,
        });
        setPending(null);
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
      <Proposals onResign={onResign} />
      <header className="desk-header">
        <Face name={mine.name} slug={mine.slug} />
        <div>
          <h1>{mine.name}</h1>
          <p>{strategyName(mine.glance.id)}</p>
        </div>
        <span className={`desk-status ${stopped ? "paused" : ""}`}>
          <i />
          {mine.statusLabel ?? "Waiting for worker"}
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
                  <p className="desk-muted">No positions reported yet.</p>
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
                  <p className="desk-muted">No trades yet.</p>
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
                  {latest.action === "buy" ? "Bought" : "Sold"} ·{" "}
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
              <button type="button" key={q} onClick={() => send(q)}>
                {q}
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
