/**
 * Deterministic answers from narrowly typed public facts. This is not a new
 * model prompt: raw chat, private ledger rows and private owner money never
 * become an answer here. Variable labels/reasons pass the ordinary line gate;
 * numbers are formatted only from public feed snapshots or literal arithmetic.
 */
import { calculateChatMath, parseChatMath } from "../../../../packages/core/src/index";
import { admitTgLine, TG_LINE_MAX } from "./gate";
import type { CoinLook, TgCoinMemo, TgPublicFact, TgPublicTradeFact } from "./types";

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

/**
 * "WHAT CAN YOU DO?", "HELP", "COMMANDS": the whole line, nothing else in it
 * (anchored), so "can you help me with pons" or "what can you do with fomo?"
 * (the research's own list) is never taken for it.
 */
const CAPABILITIES =
  /^(?:help|help\s+me|halp|commands|menu|what\s+(?:can|do)\s+(?:you|u)\s+do(?:\s+(?:here|in\s+here|in\s+(?:this|the)\s+(?:group|chat)|for\s+(?:me|us)))?|what\s+(?:are|r)\s+(?:you|u)\s+(?:able\s+to\s+do|good\s+for|for)|what\s+can\s+i\s+ask(?:\s+(?:you|u))?(?:\s+(?:here|for))?|how\s+do\s+i\s+use\s+(?:you|u|this\s+bot|this|the\s+bot)|what\s+(?:are\s+)?(?:your|ur)\s+(?:commands|features|capabilities|skills))[\s?!.]*$/iu;

/**
 * "how do i get my own agent / one of you / a bot like you": onboarding, not
 * a chat. Never "one of these" or "one of them": under a board that is a coin
 * ("should i get one of these coins?").
 */
const OWN_AGENT =
  /\b(?:get|make|build|set\s*up|have|run)\s+(?:my\s+own\s+(?:agent|bot|merryman|one)|one\s+of\s+(?:you|u)\b|an?\s+(?:agent|bot|merryman)\s+like\s+(?:you|u|this|yours|this\s+one)|(?:an?\s+)?(?:agent|bot)\s+of\s+my\s+own)\b/iu;

/**
 * "WHY CAN'T YOU ANSWER THAT HERE?", "why not in the group?", "why only in
 * DMs?": what stays in a direct message and what a room may hear. Never a
 * past-tense complaint ("why didn't you answer", a missed question the
 * re-ask handles), and never the bot or Telegram troubleshooting ("why
 * doesn't the bot reply in my group" is the groups answer).
 */
const DM_WHY = /\b(?:why|how\s+come)\b/iu;
const DM_POLICY: readonly RegExp[] = [
  // "why can't you answer that here": the bot is the one who can't.
  /\b(?:(?:can'?t|cannot|won'?t|wont)\s+(?:you|u)|(?:you|u)\s+(?:can'?t|cannot|won'?t|wont|(?:are\s+)?unable\s+to))\b.{0,30}\b(?:answer|say|tell|share|post|show|talk\s+about)\w*\b.{0,30}\b(?:here|in\s+(?:the\s+|this\s+|a\s+)?(?:group|chat|gc|room))\b/iu,
  // "why not here?", "how come only in dms?", "why a dm?", "why privately?": the whole line,
  // so "why do scammers always slide into the dms?" or "why is the dev not here" stay chat.
  /^(?:why|how\s+come)\s+(?:not\s+(?:here|in\s+(?:the\s+|this\s+)?(?:group|chat|gc|room))|(?:only\s+)?(?:(?:in\s+)?(?:a\s+|the\s+)?(?:dms?|pms?)|(?:in\s+)?(?:private|direct\s+messages?)|privately))[\s?!.]*$/iu,
  // "why do i have to dm you".
  /\b(?:have\s+to|must|need\s+to|gotta|should)\s+dm\s+(?:you|u)\b/iu,
];
const DM_POLICY_NOT = /\b(?:bot|telegram|botfather|privacy\s*mode|wallet|balance|portfolio|withdraw\w*|deposit\w*|didn'?t|did\s+not)\b/iu;

export function publicFactRequest(text: string, names: readonly string[] = []): PublicFactRequest | null {
  const raw = withoutSelf(text, names);
  const math = parseChatMath(raw);
  if (math) {
    return { kind: "calculation", fact: { kind: "calculation", input: math } };
  }
  const s = raw.normalize("NFKC").toLowerCase().replace(/[’]/g, "'");
  if (CAPABILITIES.test(s.trim())) return { kind: "site", topic: "capabilities" };
  if (/^(?:why|how come)\s+(?:(?:can'?t|cannot|won'?t)\s+(?:you|u)\s+trade|(?:are\s+)?(?:you|u)\s+not\s+trading)[\s?!.]*$/iu.test(s)) return { kind: "site", topic: "readiness" };
  const ownTrade = /\b(?:what|which|show|tell|list|anything|have|did)\b.*\b(?:you|your|u|ur)\b.*\b(?:trade[ds]?|buy|bought|sell|sold|trading)\b|\b(?:what|which)\b.*\b(?:trade[ds]?|coins?|tokens?)\b.*\b(?:you|u)\b.*\b(?:today|buy|bought|sell|sold)\b/iu;
  const ownWhy = /\bwhy\b/iu.test(s) && /\b(?:you|u)\b.*\b(?:buy|bought|sell|sold|trade[ds]?)\b/iu.test(s);
  if ((ownTrade.test(s) || ownWhy) && /\b(?:didn'?t|did not|haven'?t|have not|not|never|couldn'?t|could not|can'?t|cannot|won'?t)\b/iu.test(s)) return { kind: "site", topic: "attempts" };
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
  // Public help can explain the route without reading a person's account.
  // Specific remedies precede generic site/history questions and market asks;
  // they never assert that a reported blocker is present or has been fixed.
  if (/\b(?:v4\s*(?:adapter|permission)|v4selfswap)\b/iu.test(s)
    || /\buniswap\s*v4\b/iu.test(s) && /\b(?:grant\w*|permission|adapter|wallet|settings?|renew\w*|re[ -]?sign|trad\w*|use|enable|connect\w*)\b/iu.test(s)) return { kind: "site", topic: "v4" };
  if (/\b(?:drawdown\s*(?:breaker|limit)|breaker\s*(?:tripped|trips|triggered|limit)|high[ -]water\s*mark)\b/iu.test(s)) return { kind: "site", topic: "drawdown" };
  if (/\b(?:sign[ -]?up|register|create\s+(?:(?:my|an?|the|new)\s+)?(?:agent|merryman)|get\s+started|start\s+using\s+merrymen|join\s+merrymen)\b/iu.test(s)
    || OWN_AGENT.test(s)) return { kind: "site", topic: "onboarding" };
  if (/\b(?:paper|practice|simulated)\b/iu.test(s) && /\b(?:withdraw\w*|cash\s*out)\b/iu.test(s)) return { kind: "site", topic: "modes" };
  if (/\b(?:withdraw\w*|cash\s*out|recover(?:y)?\s+(?:key|wallet|funds)|(?:lost|restore)\s+(?:(?:my|the)\s+)?(?:wallet|recovery\s*key))\b/iu.test(s)) return { kind: "site", topic: "withdrawals" };
  if (/\b(?:add\s+(?:funds|money|usdg)|deposit(?:ed)?\s*(?:funds|money|usdg|address)?|top[ -]?up|fund\s+(?:(?:my|the|an?|your)\s+)?(?:agent|merryman|account|wallet))\b/iu.test(s)) return { kind: "site", topic: "funding" };
  if (/\b(?:paper\s*(?:trading|trades?|mode|money)|practice\s*(?:trading|mode|money)|simulated\s*(?:money|funds|trades?)|real\s*(?:money|funds)|paper\s*(?:and|or|vs\.?|versus)\s*live|live\s*(?:and|or|vs\.?|versus)\s*paper|(?:switch|turn|enable)\b.{0,25}\blive\s*trading)\b/iu.test(s)) return { kind: "site", topic: "modes" };
  if (DM_WHY.test(s) && DM_POLICY.some((re) => re.test(s.trim())) && !DM_POLICY_NOT.test(s)) return { kind: "site", topic: "dm-policy" };
  if (/\b(?:public\s*(?:group|chat)|in\s+(?:the\s+)?group|private\s*(?:chat|details|portfolio|account|wallet)|dm|direct\s*message)\b/iu.test(s)
    && /\b(?:private|privacy|portfolio|balance|holdings|sizes?|wallet|difference|details|share|see|show|ask|tell)\b/iu.test(s)) return { kind: "site", topic: "privacy" };
  if (/\b(?:botfather|privacy\s*mode)\b/iu.test(s)
    || /\btelegram\b/iu.test(s) && /\b(?:bot|link|linked|connect\w*|connection|settings|status|silent|down|not\s*(?:replying|responding|working)|doesn'?t\s*(?:reply|respond|work)|replies?|messages?|approval|approved|mentions?|tags?|read|hear|listen)\b/iu.test(s)
    || /\b(?:group|bot)\b/iu.test(s) && /\b(?:silent|not\s*(?:replying|responding|working)|doesn'?t\s*(?:reply|respond|work)|approve|approved|approval|link|reply|replies|respond|mentions?|tags?|read|hear|listen)\b/iu.test(s)) return { kind: "site", topic: "groups" };
  if (/\b(?:re[ -]?sign|resign|renew\w*|expir\w*|signing\s*(?:failed|stuck|error)|permission\s*(?:renewal|not\s*granted|missing)|trading\s*permission|wallet\s*(?:inactive|isn'?t\s*active))\b/iu.test(s)
    && (site || /\b(?:wallet|grant|key|permission|sign|signing|trading)\b/iu.test(s))) return { kind: "site", topic: "wallet" };
  if (/\b(?:agent|merryman|you|your|u|ur)\b/iu.test(s)
    && /\b(?:idle|blocked|not\s*(?:buying|trading|active)|(?:can'?t|cannot|won'?t|doesn'?t)\s*trade|stopped\s*buying|live\s*(?:off|disabled)|no\s*(?:cash|gas))\b/iu.test(s)) return { kind: "site", topic: "readiness" };
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

/** The quick screen's verdict on a coin kind, in its own words; undefined for a kind with none. */
export function quickTake(kind: CoinLook["kind"]): string | undefined {
  return QUICK_TAKE[kind];
}

/** A stored outcome is evidence; acceptance into a queue is never a Brain verdict. */
export function publicCoinStatus(memo: TgCoinMemo | undefined, nowMs: number): string | undefined {
  if (!memo) return undefined;
  const reason = publicCoinReason(memo.notes);
  if (memo.verdict === "bought") return `i bought it${memo.paper ? " on paper" : ""}${reason ? ` because ${reason}` : " after its recorded review"}`;
  if (memo.verdict === "passed") return `i passed${reason ? ` because ${reason}` : " after its recorded review"}`;
  if (memo.verdict === "skipped") return `no filled buy was recorded${reason ? `: ${reason}` : "; passing the quick screen wasn't trade approval"}`;
  if (memo.verdict === "expired") return `the nomination expired without a confirmed buy${reason ? `: ${reason}` : ""}`;
  if (memo.verdict === "not-ready") return `automated entries weren't ready${reason ? `: ${reason}` : "; this chart read is research"}`;
  if (memo.verdict === "candidate" && nowMs - memo.atMs > 15 * 60_000) return "no completed trade outcome is recorded; this chart read doesn't confirm a buy";
  if (memo.verdict === "candidate") return "it clears the quick screen; safe entry checks and a trade review are still required";
  const take = quickTake(memo.verdict as CoinLook["kind"]);
  return take ? `quick screen: ${take}` : undefined;
}

/**
 * WHAT A ROOM CAN ASK IT, said by code (WP11): only what is wired here, so
 * it never undersells or invents a feature, and always that a group never
 * orders a trade (docs/tg-groups.md rule 1).
 */
function capabilitiesLine(wired: { fomo: boolean; desk: boolean; coins: boolean } | undefined): string {
  const w = wired ?? { fomo: false, desk: false, coins: false };
  const asks: string[] = [];
  if (w.desk) asks.push("a read on a coin or the Robinhood Chain market");
  if (w.fomo) asks.push("what's trending on Fomo", "who's top on Fomo today", "what traders say about a coin", "one Fomo trader's public moves by handle");
  if (w.coins) asks.push("a look at a Robinhood Chain CA you drop");
  const list = asks.length <= 1 ? asks.join("") : `${asks.slice(0, -1).join(", ")} or ${asks[asks.length - 1]}`;
  return asks.length
    ? `in here you can ask me for ${list}. i never take trade orders from a group.`
    : "in here i mostly just chat. i never take trade orders from a group.";
}

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
      if (fact.topic === "capabilities") {
        line = capabilitiesLine(fact.wired);
        break;
      }
      const answers = {
        overview: "Merrymen runs your trading agent. the web shows its trades, decisions and controls; Telegram is another view of the same agent.",
        onboarding: "open Merrymen on the web, sign in, then choose Create agent. pick a strategy and trading mode, review the limits and sign the permission. finish the wallet's backup or login steps, then check your agent's status. you can start with paper trading.",
        funding: "open Add funds on the web and copy the agent account shown there. send only the supported funds on that account's displayed network. check the recorded balance and agent status afterward; a deposit alone doesn't enable live trading or renew permission.",
        withdrawals: "open Withdraw from Profile on the web and use the owner recovery/signing flow shown for your wallet. stopping an agent doesn't withdraw funds or confirm revocation. never paste a recovery key into chat; account recovery requires your owner access.",
        modes: "paper trading uses simulated money that can't be withdrawn. Settings → Trading mode controls real orders; funding alone isn't proof of live execution. live trading needs signed permission and readiness checks. switching to paper doesn't sell real positions.",
        v4: "for Uniswap v4, save a deployed V4SelfSwap adapter for the correct network in Settings, then review and renew permission in Wallet. the adapter must pass deployment checks. saving its address alone doesn't grant access; check Trading permissions afterward.",
        readiness: "open your agent's status on the web or ask /status in your linked DM. idle or blocked can mean missing cash, gas, live consent, permission or another check. use the reported reason; a group chart read doesn't establish that your account can trade.",
        drawdown: "the drawdown breaker pauses new buys at the signed limit; this rule still permits sell attempts. renewing the same limit doesn't clear it. check your recorded peak and equity in private; if they look wrong, ask for an accounting check rather than bypassing it.",
        privacy: "group replies use public market evidence and public trade summaries. balances, trade sizes, wallet controls and detailed account reasons belong in your linked DM or signed-in web account. a group message can't authorize a wallet change or trade.",
        pnl: "on the web: Trades → P&L image → Download PNG or Print. cards are available for verified completed live sells with recorded cost basis.",
        trades: "open your agent's Trades on the web for confirmed fills and decision reasons. pending or refused attempts aren't completed trades.",
        attempts: "for why a trade didn't happen, ask me in DM or check Decisions on the web. a pending, refused or failed attempt isn't a completed trade.",
        wallet: "open Wallet & permissions on the web and follow the current review/renew step. revocation needs network fees; an interrupted renewal must be resumed before trading. after signing, check agent status. never share a recovery key or bot token.",
        groups: "check Settings → Telegram and test the bot; /status in your linked DM checks the connection. groups also need owner approval. privacy mode can hide posts: disable it in BotFather and re-add the bot, or make it admin. mentions and direct replies can help.",
        limits: "buys still need a Brain decision and must fit the owner's signed permissions and trading limits. group messages can't raise those limits or authorize a wallet change.",
        "dm-policy": "who i watch or follow, my owner's own research and anyone's account details stay in DMs. boards, coin research and one trader's public Fomo data are fine in here.",
      } as const;
      line = answers[fact.topic as Exclude<typeof fact.topic, "capabilities">] ?? null;
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
