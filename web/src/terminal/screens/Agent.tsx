import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Proposals } from "../Proposals";
import { TrencherAnnouncement } from "../TrencherAnnouncement";
import { blockerAdvice } from "@/lib/live-blocker";
import { badgeOf } from "@/lib/thesis-badge";
import { commandFor, commandPayload, type CommandArg } from "@/lib/chat-commands";
import { fetchOpenOrder, followWindowMs, routeAnswer, serverPlacedAt, SNIPE_LOOKUP_MS } from "../order-follow";
import type { ChatContext, ChatController, ConfirmScope } from "../chat-controller";
import { chatChips, fillParts, receiptParts, refocusAfterSend } from "../chat-thread";
import type { OrderReceipt } from "@/lib/order-state";
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
  positionFigures,
  positionsOf,
  spentToday,
  type ChatMessage,
} from "../account";
import { ageOf, money, pctPts, type LiveMine, type LiveToken } from "../live";
import { strategyName } from "../strategy";
import { Coin, Empty, Face } from "../ui";
import { NameChip } from "../NameChip";
import { BalanceFigure } from "../studio";
import { TradeTokenCard } from "../TradeTokenCard";
import { SwapsTable } from "../SwapsTable";
import { DESK_TAPE_ROWS, isTrade, swapRowsOfDesk } from "../swaps";
import { isCircleStrategyId } from "../strategy";
import type { TierView } from "@/app/api/tier/route";
import { loadTier } from "../tier";
import { count } from "@/lib/format";

/** Sentence case for a badge label that is written lower-case by design. */
const capitalise = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1) : w);

/** A request that acts, naming the owner it acts for, so the route can refuse anyone else's session (ConfirmScope.owner). */
const ownedBy = (on: ConfirmScope, payload: Record<string, unknown>) => (on.owner ? { ...payload, owner: on.owner } : payload);

export function Agent({
  mine,
  tokens,
  perTrade,
  perDay,
  stopped,
  chat,
  onToken,
  onDeposit,
  onWithdraw,
  onLimits,
  onResign,
  onSettings,
  liveBlocker,
  staleBlocker,
}: {
  mine: LiveMine | null;
  tokens: LiveToken[];
  perTrade: number | null;
  perDay: number | null;
  stopped: boolean;
  /**
   * THE CONVERSATION, owned by App (chat-controller.ts) and only drawn here —
   * so closing this screen no longer ends a reply in flight or an order being
   * followed. The phone tab and the desktop dock draw the same one.
   */
  chat: ChatController;
  onToken: (id: string) => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onLimits: () => void;
  /** Point at the ONE signing control — see Proposals.tsx. */
  onResign: () => void;
  /**
   * Open Settings, where the Live trading switch lives.
   *
   * Separate from `onResign` because they are opposite errands: one repairs a
   * permission, the other changes a decision. Routing "start live trading" at
   * the signer was the original confusion in miniature.
   */
  onSettings: () => void;
  /**
   * WHAT IS STOPPING THIS AGENT TRADING FOR REAL, as the child resolved it.
   *
   * Null is two answers and neither is a problem: trading for real, or never
   * beaten. See AgentStatus.liveBlocker.
   */
  liveBlocker?: string | null;
  /**
   * True when that verdict was reached about a key the owner has since
   * replaced — `grant.grantedAt > workerAliveAt`.
   *
   * A corrected grant takes up to ~5.5 minutes to reach this screen (the
   * orchestrator's ferry, the child's tick, the mirror, the browser's poll), and
   * for all of it the panel below told an owner who had just re-signed to
   * re-sign. One of them did, repeatedly, and reported the product as broken.
   */
  staleBlocker?: boolean;
}) {
  const ask = chat.draft;
  const setAsk = chat.setDraft;
  /**
   * THE ONE THING THE AGENT HAS ASKED PERMISSION TO DO.
   *
   * Deliberately NOT part of a message. The thread is persisted to this
   * browser, and a confirmation card restored from storage would be an offer to
   * act, made by nobody, on a page the owner reopened days later. The
   * controller holds it in memory only, and the next message clears it.
   */
  const pending: { id: string; args: Record<string, CommandArg> } | null = chat.proposal;
  const setPending = chat.setProposal;
  /** The card is being carried out — the controller's, so every screen drawing it agrees. */
  const running = chat.confirming;
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
  }, [chat.messages.length, chat.streaming, chat.sending]);
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
  // NO RELEASE NOTICE HERE.
  //
  // `TrencherAnnouncement` used to render in this branch — an announcement
  // about a trading mode, stacked directly on top of the empty state whose
  // whole job is to get this reader to create an agent in the first place.
  // It also fired a one-shot desktop notification and marked it spent, so a
  // visitor who never had an agent consumed the notification meant for the
  // owner they might become. The component now refuses that case itself;
  // not mounting it here is the other half.
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
  // WHAT IT ACTUALLY HOLDS, and everything else it is told — built in
  // chat-payload.ts by the controller, from this screen's own view of it.
  const context: ChatContext = { mine, liveBlocker, perTrade, perDay, stopped };
  /**
   * ASK, AND SHOW IT AT ONCE.
   *
   * The owner's line and a typing bubble appear the moment they press send,
   * and the composer clears — the reply streams into the bubble as it is
   * written (chat-controller.ts). It used to wait for a settings GET and then
   * the whole reply before anything moved, and cleared the draft only on
   * success.
   *
   * THE CURSOR GOES BACK ONLY WITH A MOUSE. Refocusing the textarea on a phone
   * reopens the keyboard, and the answer arrived underneath it.
   */
  const send = async (question: string) => {
    if (!question.trim() || chat.sending) return;
    follow.current = true;
    await chat.send(question, context);
    if (refocusAfterSend(window)) input.current?.focus();
  };
  /**
   * WAIT FOR THE ANSWER, AND SAY IT IN THE AGENT'S OWN WORDS.
   *
   * An order is the only command here that finishes somewhere else. It is
   * queued, ferried, claimed, put to the wall and signed — seconds to a minute
   * later — and until this existed the owner was told "placed it" and then
   * nothing, ever. A refusal that never reaches the wall writes no trade row,
   * so the tape cannot carry it either: this follow is the ONLY way the reason
   * reaches the person who asked.
   *
   * The sentence comes from the WORKER, which read the ledger row, and the
   * receipt beside it from the same row. Nothing here infers an outcome — a
   * browser guessing at what a trade did is exactly the claim this codebase
   * refuses to make.
   *
   * FOLLOWED BY THE APP, NOT BY THIS SCREEN. It used to die with this screen,
   * so closing the dock mid-order lost the answer. The controller keeps the
   * order and its deadline and follows it whatever the screens do — see
   * order-follow.ts for the deadline and chat-controller.ts for the resume.
   *
   * AND FOR THE OWNER WHO TAPPED. Everything below changes the conversation
   * through `on`, the controller's scope for this one confirm: if the owner
   * changes on this browser while the order is being placed, what it would
   * have said, followed or cleared goes nowhere, rather than into the next
   * owner's thread (chat-controller.ts `confirm`).
   */

  /**
   * AN ORDER WHOSE PLACING NEVER ANSWERED IS NOT A REFUSAL.
   *
   * The connection can drop after the server wrote the row, so nothing here
   * is known — and the card goes, because tapping it again may be a second
   * order at a second price. The key is asked, once, what is open on it: an
   * open order is followed to its answer like any other; otherwise the owner
   * is told plainly that it is unknown, and where to look.
   */
  const orderLost = async (on: ConfirmScope) => {
    on.setProposal(null);
    on.say({ role: "owner", text: "✓ Confirmed" });
    // Asked under the session the browser holds NOW: once the owner has
    // changed, what is open is somebody else's, and it is not looked for —
    // and naming the owner who tapped, so a session another tab changed
    // unseen is refused rather than read as theirs.
    const open = on.alive() ? await fetchOpenOrder(on.owner) : null;
    if (open) {
      on.say({
        role: "agent",
        text: "I lost the line while placing that, but there is an order open on my key now — I'll tell you how it ends.",
        order: { id: open },
      });
      on.followOrder(open, null);
      return;
    }
    on.say({
      role: "agent",
      text: "I couldn't confirm that order reached my key — the connection dropped before I heard back. Check your trades before asking again.",
    });
  };

  /**
   * Place one order through the ONE channel orders take, and say what is true
   * the moment it exists — placed, not filled — then follow it to its answer.
   *
   * FOR THE OWNER WHO TAPPED, OR NOT AT ALL. The POST carries whatever session
   * this browser holds when it leaves, and a snipe reaches here only after its
   * lookup answered — time enough for another owner to sign in. So nothing is
   * sent once the owner has changed (on.alive), and what is sent names the
   * owner it is for, so the route refuses a session that is not theirs.
   */
  const placeOrder = async (on: ConfirmScope, payload: Record<string, unknown>, words: (duplicate: boolean) => string) => {
    if (!on.alive()) {
      // Said only where the owner who tapped can read it (on.say): back on
      // this browser, never in the thread of whoever signed in meanwhile.
      on.say({
        role: "agent",
        text: "I didn't place that — the wallet signed in here changed after you confirmed, so nothing was sent. Ask again if you still want it.",
      });
      return;
    }
    const placed = await routeAnswer<{ error?: string; id?: string; duplicate?: boolean; expiresAt?: number; expiresInMs?: number }>("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ownedBy(on, payload)),
    });
    // A 200 is a row that exists, but one whose id could not be read cannot be
    // followed — so it is looked for, exactly like an answer that was lost.
    if (!placed || (placed.ok && typeof placed.body?.id !== "string")) return orderLost(on);
    if (!placed.ok) throw new Error(placed.body?.error ?? `that was refused (${placed.status})`);
    const body = placed.body!;
    // THE SERVER'S OWN TIME FOR THE PLACEMENT goes on the line that says it,
    // said the moment the reply is in hand: the thread reads the order's life
    // from the two, on the ledger's clock, so a browser minutes off cannot make
    // its fill a second line (chat-thread.ts lifeOf).
    const serverAt = serverPlacedAt(body);
    on.say({ role: "owner", text: "✓ Confirmed" });
    on.say({ role: "agent", text: words(!!body.duplicate), order: { id: body.id!, ...(serverAt !== null ? { serverPlacedAt: serverAt } : {}) } });
    on.setProposal(null);
    on.followOrder(body.id!, followWindowMs(body));
  };

  /**
   * DO THE THING THE OWNER JUST CONFIRMED.
   *
   * The model proposed it; this runs only from a click, and it calls the SAME
   * authenticated route the buttons already call. Nothing here is a new way
   * into the app — it is the existing way, reached by asking.
   */
  const confirm = () => chat.confirm(async (proposal, on) => {
    const cmd = commandFor(proposal.id);
    if (!cmd) return;
    try {
      if (cmd.via === "navigate") {
        window.location.href = cmd.to!;
        return;
      }
      if (cmd.via === "show") {
        // DISPLAY, not action: resolve the owner's latest closed trade and
        // show its card inline. Read-only end to end — no write, no order,
        // no navigation. The picture comes from GET /api/pnl (the same
        // renderer Telegram sends); this branch only finds WHICH trade.
        on.say({ role: "owner", text: "✓ Confirmed" });
        const latest = (await fetch("/api/pnl/latest", {
          headers: { "content-type": "application/json" },
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)) as {
          none?: boolean;
          tradeId?: number;
          symbol?: string;
          status?: string | null;
          realizedPnlUsdg?: number;
        } | null;
        if (!latest || latest.none || typeof latest.tradeId !== "number") {
          on.say({
            role: "agent",
            text: "No closed trades with a card to draw yet — closes land here with their picture once they happen.",
          });
          return;
        }
        const paper = latest.status === "paper";
        const pnl = typeof latest.realizedPnlUsdg === "number" ? latest.realizedPnlUsdg : 0;
        // money() owns signs and symbols (see format.test.ts) — no hand-placed "$" anywhere.
        const signed = pnl < 0 ? money(pnl) : `+${money(pnl)}`;
        on.say({
          role: "agent",
          text: `${latest.symbol ?? "Position"} closed${paper ? " (📜 paper — simulated, nothing signed)" : ""}: ${signed}. Tap the picture to save it.`,
          image: {
            src: `/api/pnl?trade=${latest.tradeId}`,
            alt: `P&L card for closed ${latest.symbol ?? "position"}${paper ? " (paper)" : ""}`,
          },
        });
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
        const found = await routeAnswer<{
          outcome?: string;
          say?: string;
          error?: string;
          target?: { symbol?: string };
          usdgAmount?: number;
        }>(
          "/api/snipe",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(ownedBy(on, commandPayload(cmd, proposal.args))),
          },
          // BOUNDED: the order it resolves to goes out only after it answers,
          // so an open-ended lookup was an open-ended gap between the tap and
          // the order (SNIPE_LOOKUP_MS).
          SNIPE_LOOKUP_MS,
        );
        // A lookup places nothing, so a lost answer costs only the asking —
        // and the card stays for exactly that.
        if (!found) {
          on.say({ role: "agent", text: "I couldn't look that coin up — no answer came back, and nothing was placed. Try again." });
          return;
        }
        const out = found.body;
        if (!found.ok && !out?.say) throw new Error(out?.error ?? `that was refused (${found.status})`);
        // RESOLVED IS NOT PLACED. The route's job ends at "this query means this
        // one coin, and your key covers it"; the order goes through the SAME
        // channel the buy card uses, from here, so there is exactly one way an
        // order is ever created. The other three outcomes never reach an order
        // at all and are rendered as what they are.
        if (out?.outcome === "resolved" && out.target?.symbol) {
          // FOLLOWED LIKE ANY ORDER. This placed an order and then said
          // "however it ends it lands on your trades" — false for every refusal
          // that returns before an intent is built, which writes no trade row —
          // and never asked how it ended. It is the same order as a typed buy,
          // so it gets the same follow, the same receipt, and the same care
          // when its answer is lost.
          const said = out.say;
          await placeOrder(on, { side: "buy", symbol: out.target.symbol, usdgAmount: out.usdgAmount }, (duplicate) =>
            duplicate
              ? `${said} I already had that one queued, so I have not placed it twice.`
              : `${said} Placed, not filled — my key's limits still decide, and I will tell you which.`,
          );
          return;
        }
        on.say({ role: "owner", text: "✓ Confirmed" });
        on.say({ role: "agent", text: out?.say ?? "I could not tell how that went." });
        on.setProposal(null);
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
        //
        // "IT LANDS ON YOUR TRADES EITHER WAY" WAS FALSE. Only a trade row
        // reaches the tape, and every refusal that returns before an intent is
        // built — paused, expired, over the ceiling, a symbol I do not watch,
        // no position, no grant — writes no row at all. So the tape would stay
        // empty forever while the turn promised it would not, and the turn is
        // PERSISTED to this browser, so the false promise outlives the order.
        //
        // What is true the moment the row exists is only that it was placed. So
        // that is what this says, and the outcome is followed and said in its
        // own turn — from the worker's own words, not from a guess here.
        await placeOrder(on, commandPayload(cmd, proposal.args), (duplicate) =>
          duplicate
            ? `That exact order is already queued — I have not placed a second one.`
            : `Placed it — ${cmd.say(proposal.args)} It is with my key now; the limits you signed decide whether it goes through, and I will tell you which.`,
        );
        return;
      }
      // READ-MODIFY-WRITE at click time, and ONLY the declared keys.
      // `commandPayload` drops everything the command did not declare, and
      // /api/settings strips every house-owned field again on the server — two
      // independent gates, neither relying on the other. And naming the owner
      // who tapped, like an order: another tab can sign a different wallet in
      // without this one knowing, and the route refuses that session.
      const put = await routeAnswer<{ errors?: string[] }>("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ownedBy(on, commandPayload(cmd, proposal.args))),
      });
      // THE WRITE MAY HAVE LANDED. Said as unknown, and the settings are read
      // again so what the model is told catches up whichever it was. A setting
      // is one value, so asking again is safe, and the card stays for that.
      if (!put) {
        on.say({
          role: "agent",
          text: "I couldn't tell whether that change was saved — the connection dropped before I heard back. Asking again is safe: it only sets the same value.",
        });
        on.refreshSettings();
        return;
      }
      if (!put.ok) throw new Error(put.body?.errors?.join(" ") ?? `that was refused (${put.status})`);
      // SAID BACK IN THE CONVERSATION, not as a toast that vanishes. What an
      // agent did on your instruction belongs in the record of what you asked.
      on.say({ role: "owner", text: "✓ Confirmed" });
      on.say({ role: "agent", text: `Done — ${cmd.say(proposal.args)}` });
      on.setProposal(null);
      // What the model is told about the settings has just changed.
      on.refreshSettings();
    } catch (e) {
      // NEVER A SILENT REFUSAL, and said in the thread where the owner is
      // looking, with the route's own reason — only a body the route wrote
      // reaches here (routeAnswer). The card stays, so asking again is one
      // tap — and never automatic, because this may be an order.
      on.say({ role: "agent", text: `That didn't go through: ${e instanceof Error ? e.message : "I could not tell why."}` });
    }
  });

  const blocked = blockerAdvice(liveBlocker);
  /**
   * DO NOT REPEAT A VERDICT ABOUT A KEY THE OWNER HAS ALREADY REPLACED.
   *
   * The desktop banner gets this from `autonomyOf`, which this screen never
   * touches — it reads the raw rule string — so the same fact has to be applied
   * here or the phone keeps showing the stale panel that started all of this.
   * Deliberately wrapping the RENDER rather than folding it into `blocked`
   * above, which `live-blocker.test.ts` pins literally as the child's verdict
   * arriving unmodified.
   */
  const blockerIsStale = staleBlocker === true;
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
      {blocked && !blockerIsStale && (
        /* AN ALARM ONLY WHEN SOMETHING IS WRONG. This panel is red, and it was
           rendered for every blocker there is — including the one that means
           "your agent is practising, exactly as you asked". An owner who had
           deliberately chosen Paper mode read a red warning telling him his
           agent was blocked, and reasonably concluded the product was broken. */
        <section className={blocked.fault ? "desk-blocked" : "desk-note"} role="status">
          <p>{blocked.say}</p>
          {/* ASK THE ADVICE, DO NOT INFER FROM `funding`. This used to render on
              `!blocked.funding`, which is not the same question and got two rules
              wrong: `no-executor` is ours to fix and was offering the owner a
              signature anyway, and `live-not-enabled` is not broken at all. */}
          {blocked.resign && (
            <button type="button" onClick={onResign}>
              Fix it — re-sign my permission →
            </button>
          )}
          {/* THE ONE CONTROL THAT ACTUALLY CHANGES THIS STATE. Without it the
              screen names a switch and offers no way to reach it, which is the
              shape of the original complaint. */}
          {liveBlocker === "live-not-enabled" && (
            <button type="button" onClick={onSettings}>
              Start live trading →
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
          {/* An unnamed agent is one of many "Robin"s; this is where its owner
              finds out, and names it in one tap. Renders nothing otherwise. */}
          <NameChip name={mine.name} nameSource={mine.nameSource ?? null} slug={mine.slug} onSettings={onSettings} />
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
                {/* FILLS AND ORDERS ON THEIR WAY, not refusals — those fold into
                    one line in the list below, and counting them here called
                    thirty ops-cap refusals "Trades · 30". "+" when the tape
                    came back full: there may be more past its end. */}
                Trades · {swapRowsOfDesk(mine.moves).filter(isTrade).length}{mine.moves.length >= DESK_TAPE_ROWS ? "+" : ""}
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
                  // The value AND the %, never one standing in for the other:
                  // the small line prints the coin's name when it is listed, so
                  // this is the only place on the row the money figure can be.
                  const f = positionFigures(p);
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
                        {/* The coin's name when it is listed. Not the detail: that is
                            printed on the right now, and would read twice. */}
                        {token?.name ? <small>{token.name}</small> : null}
                      </span>
                      <span>
                        {f.value}
                        {f.pct !== null && <> · <span className={f.tone}>{f.pct}</span></>}
                      </span>
                    </button>
                  );
                })}
                <div className={mine.autonomy.simulated ? "desk-cash is-simulated" : "desk-cash"}>
                  <span>{mine.autonomy.moneyLabel}</span>
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
                {/* THE SWAPS TABLE THE PUBLIC PROFILE USES (rules in swaps.ts),
                    with the owner's own dollars. Every refusal is still here
                    and still says why — folded into one line per reason, so
                    thirty ops-cap refusals no longer push the fills away. */}
                <SwapsTable
                  rows={swapRowsOfDesk(mine.moves)}
                  tokens={tokens}
                  showMoney
                  tapeFull={mine.moves.length >= DESK_TAPE_ROWS}
                  emptyTitle="No trades yet."
                  onToken={onToken}
                />
              </div>
            )}
            <button
              type="button"
              className="desk-text-button"
              onClick={onLimits}
            >
              Trading limits{" "}
              <span>
                {money(perTrade)} / trade{" "}
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
        <TrencherAnnouncement hasAgent={!!mine} />
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
                : `Your agent is armed and watching, but this strategy only runs while you hold ${count(
                    tier?.needTokens ?? 100_000,
                  )} $MERRYMEN — you hold ${count(
                    tier?.tokens ?? 0,
                  )}. Adding funds won't change it. Switch to Steady basket or Strategist, which run for everyone, or hold the token.`}
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
          {chat.messages.map((m) => (
            <ChatLine
              key={m.id}
              m={m}
              name={mine.name}
              slug={mine.slug}
              tokens={tokens}
              onToken={onToken}
              onRetry={chat.sending ? undefined : () => void chat.retry(m.id, context)}
            />
          ))}
          {/* THE TYPING BUBBLE, IN THE THREAD, the moment the owner sends — and
              the reply grows inside it as it streams. It used to be a
              "thinking…" line under the composer, and nothing in the thread
              moved until the whole reply was back. Only what chat-stream.ts
              lets through is ever in `streaming`: nothing of a marker. */}
          {chat.sending && (
            <div className="chat-msg chat-msg-agent">
              <div className="desk-reply chat-typing">
                <Face name={mine.name} slug={mine.slug} small />
                <div>
                  <strong>{mine.name}</strong>
                  {chat.streaming ? (
                    <p>{chat.streaming}</p>
                  ) : (
                    <p className="chat-typing-dots" role="status" aria-label={`${mine.name} is typing`}>
                      <i /><i /><i />
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
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
                {running
                  ? "Doing it…"
                  : commandFor(pending.id)!.via === "navigate"
                    ? "Take me there"
                    : commandFor(pending.id)!.via === "show"
                      ? "Show it"
                      : "Yes, do it"}
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
        {away && (
          <button type="button" className="chat-jump" onClick={scrollLatest}>
            <ArrowDown size={14} aria-hidden="true" /> Latest message
          </button>
        )}
        {/* WHAT TO ASK NEXT, about THIS agent — not the same three on an empty
            chat only. Sizes appear when the agent has just asked "how much?",
            each inside the smaller of the sealed per-trade cap and the chat
            ceiling. A chip only sends a message; a trade still needs the card. */}
        {!chat.sending && !pending && (
          <div className="desk-prompts">
            {chatChips({
              liveBlocker,
              stopped,
              latestSymbol: latest?.symbol ?? null,
              holding: positions.map((p) => p.symbol),
              lastAgent: [...chat.messages].reverse().find((m) => m.role === "agent" && !m.failed)?.text ?? null,
              perTrade,
              ceiling: chat.ceiling,
            }).map((q) => (
              <button type="button" key={q.label} onClick={() => send(q.message)}>
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
            data-tour="chat-input"
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
            disabled={!ask.trim() || chat.sending}
            aria-label="Send message"
          >
            <ArrowUp size={19} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </form>
      </div>
    </div>
  );
}

/** A receipt's pill and line — templated from the worker's ledger facts, never written. */
function ReceiptRow({ side, line }: { side: "Buy" | "Sell" | null; line: string }) {
  return (
    <p className="chat-receipt">
      {side && <span className={`chat-pill ${side === "Buy" ? "is-buy" : "is-sell"}`}>{side}</span>}
      <span>{line}</span>
    </p>
  );
}

/** One line of the thread, by who said it. */
function ChatLine({
  m,
  name,
  slug,
  tokens,
  onToken,
  onRetry,
}: {
  m: ChatMessage;
  name: string;
  slug: string | null;
  tokens: LiveToken[];
  onToken: (id: string) => void;
  onRetry?: () => void;
}) {
  const receipt: OrderReceipt | null | undefined = m.order?.receipt;
  // ONE LINE, ONE FIGURE. A receipt joined to its fill shows the worker's
  // figure on the card too: for a sell the tape's size is the order's, and the
  // receipt's is what the fill returned.
  const trade = m.trade && receipt && receipt.usdgActual !== null ? { ...m.trade, sizeUsdg: receipt.usdgActual } : m.trade;
  const card = trade ? (
    <TradeTokenCard
      trade={trade}
      token={tokens.find((t) => t.symbol.toUpperCase() === trade.symbol?.toUpperCase())}
      onToken={onToken}
    />
  ) : null;
  if (m.role === "owner") {
    return (
      <div className="chat-msg chat-msg-owner">
        <div className="desk-question">{m.text}</div>
      </div>
    );
  }
  if (m.role === "event") {
    // Something that HAPPENED — one of the agent's own fills, off the tape.
    // Templated from its row, so the same words the receipt would use.
    const parts = m.trade ? fillParts(m.trade) : null;
    const side = parts ? parts.side : (m.side ?? null);
    return (
      <div className="chat-msg chat-msg-event">
        <div className="chat-event">
          <ReceiptRow side={side === "buy" ? "Buy" : side === "sell" ? "Sell" : null} line={parts?.line ?? m.text} />
          {card}
        </div>
      </div>
    );
  }
  return (
    <div className="chat-msg chat-msg-agent">
      <div className="desk-reply">
        <Face name={name} slug={slug} small />
        <div>
          <strong>{name}</strong>
          {receipt && <ReceiptRow {...receiptParts(receipt)} />}
          {card}
          <p>{m.text}</p>
          {m.image && (
            <a href={m.image.src} download>
              <img
                src={m.image.src}
                alt={m.image.alt}
                className="desk-turn-image"
                loading="lazy"
                // The lookup gates cardability and /api/pnl re-validates
                // before drawing — but if the image still fails, hide it
                // rather than showing a torn icon; the caption stands alone.
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            </a>
          )}
          {m.failed ? (
            <div className="chat-failed-actions">
              {m.retry && onRetry && (
                <button type="button" className="chat-retry" onClick={onRetry}>
                  Retry
                </button>
              )}
              {m.failed === "no-llm" && <a href="/settings">Open Settings</a>}
            </div>
          ) : (
            <CopyReply text={m.text} />
          )}
        </div>
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
