import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
}) {
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
  }, [ask]);
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
  const send = (question: string) => {
    if (!question.trim()) return;
    follow.current = true;
    onTurn({
      question: question.trim(),
      answer: reply(mine, question, perTrade, perDay, stopped),
      trade:
        /trade|why|last/i.test(question) &&
        !/\b(buy|sell|stop|pause|resume|change|set)\b/i.test(question)
          ? latest
          : undefined,
    });
    setAsk("");
    input.current?.focus();
  };
  return (
    <div className="desk-page">
      <header className="desk-header">
        <Face name={mine.name} slug={mine.slug} />
        <div>
          <h1>{mine.name}</h1>
          <p>{strategyName(mine.glance.id)}</p>
        </div>
        <span className={`desk-status ${stopped ? "paused" : ""}`}>
          <i />
          {stopped ? "Paused" : "Running"}
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
            <span className={(mine.chg24 ?? 0) < 0 ? "down" : "up"}>
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
                ? "Trading is paused. Here’s where I left off."
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
            disabled={!ask.trim()}
            aria-label="Send message"
          >
            <ArrowUp size={19} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </form>
      </div>
    </div>
  );
}

function reply(
  mine: LiveMine,
  question: string,
  perTrade: string,
  perDay: string,
  stopped: boolean,
): string {
  const q = question.toLowerCase();
  if (/\b(buy|sell|stop|pause|resume|change|set)\b/.test(q))
    return "Use your profile to pause trading or update limits. Trading commands aren’t available in chat.";
  if (/balance|doing|performance|money|up|down/.test(q))
    return `Your agent balance is ${money(mine.equity)}. ${mine.chg24 == null ? "Today’s change isn’t available." : `It’s ${mine.chg24 < 0 ? "down" : "up"} ${money(Math.abs(mine.chg24))} today${dailyChange(mine) == null ? "" : ` (${pctPts(dailyChange(mine))})`}.`}`;
  if (/hold|position|own/.test(q)) {
    const p = positionsOf(mine);
    return p.length
      ? `My reported positions are ${p.map((p) => `${p.symbol} (${p.detail})`).join(", ")}. Available cash: ${money(mine.glance.cashUsd ?? null)}.`
      : "No open positions are reported in this snapshot.";
  }
  if (/limit|spend|left|cash/.test(q))
    return `The limits are ${money(Number(perTrade))} per trade and ${money(Number(perDay))} per day. Recorded trade volume today is ${money(spentToday(mine, Date.now()))}; ${money(Math.max(0, Number(perDay) - spentToday(mine, Date.now())))} remains under the daily limit. Available cash is ${money(mine.glance.cashUsd ?? null)}.`;
  if (/trade|why|last/.test(q)) {
    const t = [...mine.moves]
      .filter((t) => t.action === "buy" || t.action === "sell")
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
    return t
      ? `The latest recorded trade is a ${t.action} of ${money(t.sizeUsdg)} in ${t.symbol}. ${t.reason ?? "No explanation was recorded."}`
      : "There are no recorded trades yet.";
  }
  if (/strategy|doing|status/.test(q))
    return `${stopped ? "Trading is paused." : "Trading is running."} My strategy is ${strategyName(mine.glance.id)}. ${mine.thesis ?? ""}`;
  return "Ask me about your balance, positions, latest trade, or limits.";
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
