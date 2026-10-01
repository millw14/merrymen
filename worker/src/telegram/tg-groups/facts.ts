/**
 * Deterministic answers from narrowly typed public facts. This is not a new
 * model prompt: raw chat, private ledger rows and private owner money never
 * become an answer here. Variable labels/reasons pass the ordinary line gate;
 * numbers are formatted only from public feed snapshots or literal arithmetic.
 */
import { calculateChatMath, parseChatMath } from "../../../../packages/core/src/index";
import { admitTgLine, TG_LINE_MAX } from "./gate";
import type { CoinLook, TgPublicFact, TgPublicTradeFact } from "./types";

export type PublicFactRequest =
  | { kind: "trades"; why: boolean; symbol?: string; side?: "buy" | "sell" }
  | { kind: "site"; topic: Extract<TgPublicFact, { kind: "site" }>["topic"] }
  | { kind: "calculation"; fact: TgPublicFact };

/** Address/name removal changes routing only; none of these words reaches a model. */
function withoutSelf(text: string, names: readonly string[]): string {
  let s = text.trim().replace(/^@[\w]+\s*[,!:]?\s*/u, "");
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped) s = s.replace(new RegExp(`^${escaped}\\s*[,!:]?\\s+`, "iu"), "");
  }
  return s.trim();
}

export function publicFactRequest(text: string, names: readonly string[] = []): PublicFactRequest | null {
  const raw = withoutSelf(text, names);
  const math = parseChatMath(raw);
  if (math) {
    return { kind: "calculation", fact: { kind: "calculation", input: math } };
  }
  const s = raw.toLowerCase().replace(/[’]/g, "'");
  const ownTrade = /\b(?:what|which|show|tell|list|anything|have|did)\b.*\b(?:you|your|u|ur)\b.*\b(?:trade[ds]?|buy|bought|sell|sold|trading)\b|\b(?:what|which)\b.*\b(?:trade[ds]?|coins?|tokens?)\b.*\b(?:you|u)\b.*\b(?:today|buy|bought|sell|sold)\b/iu;
  const ownWhy = /\bwhy\b/iu.test(s) && /\b(?:you|u)\b.*\b(?:buy|bought|sell|sold|trade[ds]?)\b/iu.test(s);
  if ((ownTrade.test(s) || ownWhy) && /\b(?:didn'?t|did not|haven'?t|have not|not|never|couldn'?t|could not)\b/iu.test(s)) return { kind: "site", topic: "attempts" };
  const symbol = /\b(?:buy|bought|sell|sold|trade[ds]?)\s+\$?([a-z][a-z0-9]{1,15})\b/iu.exec(raw)?.[1];
  const named = symbol && !/^(?:today|yesterday|it|that|this|anything|any|some|the|a|in|on|for)$/i.test(symbol) ? symbol : undefined;
  const side = /\b(?:buy|bought)\b/iu.test(s) && !/\b(?:sell|sold)\b/iu.test(s) ? "buy" as const
    : /\b(?:sell|sold)\b/iu.test(s) && !/\b(?:buy|bought)\b/iu.test(s) ? "sell" as const : undefined;
  if (ownTrade.test(s) && /\b(?:yesterday|week|month|earlier|last|ago)\b/iu.test(s)) return { kind: "site", topic: "trades" };
  if (ownTrade.test(s) && !/\bwhy\b/iu.test(s) && !/\b(?:amount|size|balance|pnl|p&l|profit|loss|how much|portfolio|wallet)\b/iu.test(s)) {
    return { kind: "trades", why: false, ...(named ? { symbol: named } : {}), ...(side ? { side } : {}) };
  }
  if (ownWhy) {
    return { kind: "trades", why: true, ...(named ? { symbol: named } : {}), ...(side ? { side } : {}) };
  }
  // Site questions describe features, never the owner's settings or grant.
  const site = /\b(?:site|website|web|merrymen|app|dashboard)\b/iu.test(s);
  if ((site || /\b(?:print|download|pnl image|p&l image|pnl card|p&l card)\b/iu.test(s)) && /\b(?:pnl|p&l|profit|loss|trade image)\b/iu.test(s)) return { kind: "site", topic: "pnl" };
  if (site && /\b(?:history|trades?|reason|why)\b/iu.test(s)) return { kind: "site", topic: "trades" };
  if (site && /\b(?:wallet|connect|stuck|renew|permission)\b/iu.test(s)) return { kind: "site", topic: "wallet" };
  if (site && /\b(?:limits?|caps?|budget)\b/iu.test(s) && !/\b(?:your|ur|my)\b/iu.test(s)) return { kind: "site", topic: "limits" };
  if (/\b(?:how|can|why)\b.*\b(?:see|read|hear|listen)\b.*\b(?:group|chat|coins?|tag|mention)\b/iu.test(s)) return { kind: "site", topic: "groups" };
  if (site && /\b(?:what|how|where|help|explain|info)\b/iu.test(s)) return { kind: "site", topic: "overview" };
  return null;
}

/** Untrusted names and reasoning keep all the ordinary privacy/security clauses. */
function safeFragment(raw: unknown, max = 80): string | null {
  if (typeof raw !== "string" || raw.length > max || /[\r\n]/u.test(raw)) return null;
  const verdict = admitTgLine(raw, { agentName: "", kind: "fixed", recentOwn: [] });
  return verdict.ok && verdict.text ? verdict.text : null;
}

function safeReason(raw: unknown): string | null {
  if (typeof raw !== "string" || /[\p{N}\p{Sc}%@]/u.test(raw)) return null;
  const provenance: Record<string, string> = { brain: "a recorded Brain decision", strategy: "a recorded strategy decision", manual: "an owner request" };
  return provenance[raw] ?? safeFragment(raw, 100);
}

/** Safe clauses from a group nomination outcome, never a private ledger reason. */
export function publicCoinReason(notes: unknown): string | undefined {
  if (!Array.isArray(notes)) return undefined;
  for (const note of notes.slice(0, 12)) {
    const reason = safeReason(note);
    if (reason) return reason;
  }
  return undefined;
}

function finite(v: unknown, signed = false): v is number {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e18 && (signed || v >= 0);
}

function compact(v: number): string {
  const abs = Math.abs(v);
  const scale = abs >= 1e12 ? 1e12 : abs >= 1e9 ? 1e9 : abs >= 1e6 ? 1e6 : abs >= 1e3 ? 1e3 : 1;
  const suffix = scale === 1e12 ? "t" : scale === 1e9 ? "b" : scale === 1e6 ? "m" : scale === 1e3 ? "k" : "";
  return `${Number((v / scale).toFixed(2))}${suffix}`;
}

const QUICK_TAKE: Partial<Record<CoinLook["kind"], string>> = {
  "too-new": "it's very new, so i'm cautious",
  "too-thin": "the listed liquidity is thin, so i'd pass for now",
  "too-quiet": "there isn't enough recent activity for me",
  "no-pool": "i couldn't find a supported pool",
  "v4-only": "i only found a pool i can't trade through",
  curve: "it's on a bonding curve; index liquidity isn't executable depth",
  held: "i already hold this one",
  candidate: "it clears the quick screen; that's not a buy decision",
  unknown: "i couldn't verify enough to give it a take",
  stock: "that's a stock token rather than a memecoin",
  cash: "that's a cash token rather than a memecoin",
  energy: "that's the energy reserve token",
  wallet: "i didn't find a token deployed there on Robinhood Chain",
  "not-token": "it didn't resolve as a token on Robinhood Chain",
  own: "that isn't a coin for me to research here",
};

/** A numeric exception is assembled by code, never granted to model-written text. */
export function publicFactLine(fact: TgPublicFact): string | null {
  if (!fact || typeof fact !== "object") return null;
  let line: string | null = null;
  switch (fact.kind) {
    case "coin": {
      const look = fact.look;
      if (!look || !QUICK_TAKE[look.kind]) return null;
      const name = safeFragment(look.name, 40) ?? "this one";
      const research = look.research;
      const metrics: string[] = [];
      let snapshot = "";
      if (research && finite(research.observedAtMs) && research.observedAtMs <= 8.64e15 && finite(fact.nowMs) && research.observedAtMs <= fact.nowMs + 5_000 && (research.source === "geckoterminal" || research.source === "dexscreener")) {
        const when = new Date(research.observedAtMs).toISOString().slice(11, 16);
        const source = research.source === "geckoterminal" ? "GeckoTerminal" : "DexScreener";
        snapshot = `${source} snapshot ${when} UTC`;
        if (fact.nowMs - research.observedAtMs >= 60_000) snapshot += " (cached)";
        if (finite(research.liquidityUsd)) metrics.push(`liquidity $${compact(research.liquidityUsd)}`);
        if (finite(research.volume24hUsd)) metrics.push(`24h volume $${compact(research.volume24hUsd)}`);
        if (finite(research.priceChange24hPct, true)) metrics.push(`24h change ${research.priceChange24hPct > 0 ? "+" : ""}${Number(research.priceChange24hPct.toFixed(2))}%`);
      }
      const reviewed = fact.reviewed;
      const notes = Array.isArray(reviewed?.notes) ? reviewed.notes.map(safeReason).filter((n): n is string => !!n) : [];
      const why = notes[0];
      const take = reviewed?.verdict === "bought" ? `i bought it${reviewed.paper ? " on paper" : ""}${why ? ` because ${why}` : " after review"}`
        : reviewed?.verdict === "passed" ? `i passed${why ? ` because ${why}` : " after review"}`
        : reviewed?.verdict === "skipped" ? "the review didn't produce a filled buy"
        : QUICK_TAKE[look.kind]!;
      line = snapshot ? `${name} — ${snapshot}${metrics.length ? `: ${metrics.join(", ")}` : "; the index didn't report usable metrics"}. ${take}.`
        : `${name} — ${take}. i don't have a usable market snapshot here.`;
      // Reasoning remains whole: shorten the metric list rather than slicing a sentence.
      while (line.length > TG_LINE_MAX && metrics.length) {
        metrics.pop();
        line = `${name} — ${snapshot}${metrics.length ? `: ${metrics.join(", ")}` : ""}. ${take}.`;
      }
      break;
    }
    case "trades": {
      const data = fact.data;
      if (!data || !/^\d{4}-\d{2}-\d{2}$/u.test(data.day) || !Array.isArray(data.trades)) return null;
      const trades = data.trades.filter((t): t is TgPublicTradeFact => !!t && (t.side === "buy" || t.side === "sell") && typeof t.paper === "boolean");
      const wanted = fact.symbol?.toLowerCase();
      const rows = trades.flatMap((t) => {
        const symbol = safeFragment(t.symbol, 40);
        if (!symbol || (wanted && symbol.toLowerCase() !== wanted) || (fact.side && t.side !== fact.side)) return [];
        const reason = fact.why ? safeReason(t.why) : null;
        return [`${t.side === "buy" ? "bought" : "sold"} ${symbol}${t.paper ? " (paper)" : ""}${fact.why ? ` — ${reason ?? "the detailed rationale is private; ask me in DM"}` : ""}`];
      });
      if (!rows.length) {
        line = wanted || fact.side ? `i can't find a confirmed ${wanted ? `${safeFragment(fact.symbol, 40) ?? "matching coin"} ` : ""}${fact.side ?? "buy or sell"} in today's records (UTC).${data.complete ? "" : " the history may be incomplete."}`
          : trades.length ? "i can see fills, but i can't safely name those coins here. ask me in DM for the details."
          : data.complete ? "no confirmed buys or sells in my records today (UTC)." : "i couldn't get a complete trade history right now; ask me again in a bit.";
        break;
      }
      let selected = rows.slice(0, fact.why ? 2 : 6);
      const suffix = (): string => rows.length > selected.length || !data.complete ? "; more fills are on the web" : "";
      line = `today (UTC): ${selected.join("; ")}${suffix()}.`;
      while (line.length > TG_LINE_MAX && selected.length > 1) {
        selected = selected.slice(0, -1);
        line = `today (UTC): ${selected.join("; ")}${suffix()}.`;
      }
      break;
    }
    case "calculation": {
      // Recompute from validated decimal operands. Even a faulty caller cannot
      // supply answer text or a result, and fees/% units stay with the math.
      if (!fact.input || typeof fact.input !== "object") return null;
      const calculation = calculateChatMath(fact.input);
      // Keep every canonical operand/result and the exact calculated return;
      // shorten only the calculator's fixed disclosure for Telegram's cap.
      // Even maximal accepted decimals with fees fit without slicing figures.
      line = calculation.ok ? calculation.text.replace(
        "Based only on the supplied figures; not a verified trade result. Percentages rounded to at most 8 decimal places.",
        "Supplied figures only; not a verified trade result. Rounded to 8 decimals.",
      ) : calculation.error;
      break;
    }
    case "site": {
      const answers = {
        overview: "Merrymen runs your trading agent. the web shows its trades, decisions and controls; Telegram is another view of the same agent.",
        pnl: "on the web: Trades → P&L image → Download PNG or Print. cards are available for verified completed live sells with recorded cost basis.",
        trades: "open your agent's Trades on the web for confirmed fills and decision reasons. pending or refused attempts aren't completed trades.",
        attempts: "for why a trade didn't happen, ask me in DM or check Decisions on the web. a pending, refused or failed attempt isn't a completed trade.",
        wallet: "open Wallet on the web and follow the current signing step. after renewal, return to your agent; share a screenshot if it still looks stuck. never share a recovery key.",
        groups: "i can follow an approved group's coin posts without a tag when Telegram lets me read all messages. privacy mode can hide posts; disable it in BotFather and re-add me, or make me an admin.",
        limits: "buys still need a Brain decision and must fit the owner's signed permissions and trading limits. group messages can't raise those limits or authorize a wallet change.",
      } as const;
      line = answers[fact.topic] ?? null;
      break;
    }
    case "unavailable":
      line = fact.topic === "coin" ? "i can't verify that coin's market data right now. drop its Robinhood Chain CA or reply to its coin post and i'll check it."
        : fact.topic === "trades" ? "i can't read my trade records right now, so i won't guess. try again in a bit or check Trades on the web."
        : "i can't calculate that as written. send a clear expression with two numbers; division by zero has no result.";
      break;
    default:
      return null;
  }
  return typeof line === "string" && line.length <= TG_LINE_MAX && !/[\u0000-\u001f]/u.test(line) ? line : null;
}
