/** Owner chat facts are read on the server, never inferred from the browser's partial tape. */
import { calculateChatMath, chatPeriodStart, parseChatMath } from "@merrymen/core";
import { readTradeFacts, type ChatTradeFact } from "../../../worker/src/chat-trades";
import type { Db } from "../../../worker/src/db";
import type { AgentChatBody } from "./agent-chat";
import { decimalAmount } from "./format";
import { withReadDb } from "./ledger";

type ReadDb = <T>(fn: (db: Db | null) => Promise<T>) => Promise<T>;
interface TradeQuestion { why: boolean; pnl: boolean; period: string; token?: string; side?: "buy" | "sell"; id?: number; timeZone?: string }

function tradeQuestion(message: string, history: unknown): TradeQuestion | null {
  if (/\bwhy\b/i.test(message) && /\b(?:didn['’]?t|haven['’]?t|hasn['’]?t|not|no|nothing)\b/i.test(message)) return null;
  if (/\b(?:should|would|will|can i|shall|recommend)\b/i.test(message)) return null;
  // Only explicit history questions qualify. "trade PRISM today" is an order.
  const recentUser = Array.isArray(history) ? history.slice(-8).reverse().find(h => h?.role === "user" && typeof h.content === "string")?.content.slice(0, 2000) ?? "" : "";
  const followup = /^(?:why|why though|why that|why did you do that|how come)[?.!\s]*$/i.test(message.trim()) && /\b(?:trades?|bought|sold|buy|sell)\b/i.test(recentUser);
  const pastAction = /\b(?:did|have|has)\s+(?:you|u)\s+(?:(?:ever|actually|already)\s+)?(?:trade[ds]?|buy|sell|bought|sold)\b/i.test(message);
  const idText = /\btrade\s*#\s*(-?\d+)\b/i.exec(message)?.[1];
  const id = idText !== undefined && Number.isSafeInteger(Number(idText)) && Number(idText) !== 0 ? Number(idText) : undefined;
  const why = /\b(?:why|how come|reason)\b/i.test(message) && (pastAction || /\b(?:bought|sold|traded)\b/i.test(message) || id !== undefined) || followup;
  const historyQuestion = pastAction || /\b(?:what|which)\b.*\b(?:you|u)\b.*\b(?:traded|bought|sold)\b|\b(?:any|recent)\s+trades\b|\btrade history\b|\b(?:show|list)\b.*\btrades\b|^trades\s+(?:today|yesterday)\b/i.test(message);
  const pnl = /\b(?:pnl|p&l|profit|loss|profits|losses)\b/i.test(message) && /\b(?:you|your|my|today|yesterday|trades?|made|realised|realized)\b/i.test(message);
  if (!why && !historyQuestion && !pnl) return null;
  const question = followup ? recentUser : message;
  const period = /\byesterday\b/i.test(question) ? "yesterday" : /\b(?:24\s*h(?:ours?)?|last day)\b/i.test(question) ? "24h" : /\btoday\b/i.test(question) ? "today" : (/\b(?:all|ever)\b/i.test(question) || why) ? "all" : "7d";
  // An explicit coin scopes every factual query, including history and P&L.
  // Otherwise a named-coin profit question could silently total the whole book.
  let token = question.match(/\b0x[0-9a-f]{40}\b/i)?.[0] ?? question.match(/\$([a-z0-9._-]{1,32})\b/i)?.[1];
  if (why || pastAction) {
    const named = question.match(/\b(?:buy|bought|sell|sold|trade|traded)\s+([a-z0-9._-]{1,32})\b/i)?.[1];
    if (!token && named && !/^(?:that|it|this|the|a|any|anything|some|today|yesterday|lately|recently|in|last|over|since)$/i.test(named)) token = named;
  }
  const buy = /\b(?:buy|bought|buys)\b/i.test(question), sell = /\b(?:sell|sold|sells)\b/i.test(question);
  const side = buy && !sell ? "buy" : sell && !buy ? "sell" : undefined;
  const timeZone = question.match(/\b([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\b/)?.[1];
  return { why, pnl, period, ...(token ? { token } : {}), ...(side ? { side } : {}), ...(id !== undefined ? { id } : {}), ...(timeZone ? { timeZone } : {}) };
}

const words = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/<<\s*CMD/gi, "‹quoted CMD").replace(/0x[0-9a-f]{40,64}/gi, "[recorded reference]").trim();
const amount = (n: number) => Number.isFinite(n) ? decimalAmount(n) : "unknown";

/** Quotes recorded reasons as evidence; missing reasons never become a new explanation. */
export function formatOwnerTrades(trades: ChatTradeFact[], complete: boolean, period: string, why: boolean): string {
  const fills = trades.filter(t => (t.side !== null || /(?:swap|trade)/.test(t.kind)) && t.kind !== "energy-buy" && (t.status === "landed" || t.status === "paper"));
  if (fills.length === 0) return `I don't have any matching recorded coin trades ${period} in this run.${complete ? "" : " The history returned only part of the records, so I can't rule out older ones."}`;
  const shown = fills.slice(0, why ? 5 : 15);
  const lines = shown.map(t => {
    const time = `${t.atIsRestart ? "recorded after restart: " : ""}${new Date(t.at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const coin = words(t.label);
    const cash = t.executedUsdg === null ? " (executed amount not recorded)" : ` for ${amount(t.executedUsdg)} USDG`;
    const pnl = t.realizedPnlUsdg === null ? "" : `; verified realised P&L ${amount(t.realizedPnlUsdg)} USDG`;
    const reason = why ? t.reason ? ` Recorded reason: ${words(t.reason).slice(0, 400)}` : " There's no recorded reason for this fill, so I can't honestly tell you why." : "";
    const action = t.side === "buy" ? "bought" : t.side === "sell" ? "sold" : "completed a coin trade (side not recorded) in";
    return `• ${t.paper ? "Paper: " : ""}${action} ${coin}${cash}${pnl} (${time}, trade #${t.id}).${reason}`;
  });
  const partial = !complete || shown.length < fills.length;
  return `Here's what I actually traded ${period}${partial ? " — these are the newest records I can show" : ""}:\n${lines.join("\n")}${why ? "" : "\nAsk me why for the recorded decisions."}`;
}

export function formatOwnerTradePnl(trades: ChatTradeFact[], complete: boolean, period: string): string {
  const summaries: string[] = [];
  for (const paper of [false, true]) {
    const sells = trades.filter(t => t.side === "sell" && t.paper === paper);
    if (!sells.length) continue;
    const verified = sells.filter(t => t.realizedPnlUsdg !== null);
    let sum = "0";
    for (const trade of verified) {
      const addition = calculateChatMath({ operation: "add", a: sum, b: trade.realizedPnlUsdg!.toFixed(8) });
      if (!addition.ok) return "I can see sell records, but can't safely total those figures here.";
      sum = addition.result;
    }
    summaries.push(`${paper ? "Paper" : "Live"}: ${verified.length ? `${sum} USDG verified realised P&L across ${verified.length} sell${verified.length === 1 ? "" : "s"}` : "no verified realised P&L available"}${verified.length < sells.length ? `; ${sells.length - verified.length} sell result(s) couldn't be verified` : ""}.`);
  }
  const unknown = trades.some(t => t.side === null);
  const partial = !complete || unknown;
  if (!summaries.length) return partial ? "I can't establish a complete realised trade P&L from these records." : `No completed coin sells are recorded ${period}, so there's no realised trade P&L to report.`;
  return `${period}:\n${summaries.join("\n")}${partial ? "\nThis is only the verified part of the records I could read, not a complete period total." : ""}\nThis covers completed sell results, not open-position gains or account return.`;
}

/** Undefined leaves normal conversation/commands alone; failed factual reads get an honest answer. */
export async function ledgerChatReply(
  body: AgentChatBody,
  account: string | null,
  nowSec: number,
  readDb: ReadDb = withReadDb,
): Promise<string | undefined> {
  const message = typeof body.message === "string" ? body.message.slice(0, 2000).trim() : "";
  const math = parseChatMath(message);
  if (math) {
    const answer = calculateChatMath(math);
    return answer.ok ? answer.text : answer.error;
  }
  const question = tradeQuestion(message, body.history);
  if (!question) return undefined;
  if (!account) return "I can't read my trade history right now, so I won't guess what I traded.";
  let window: { since: number; until: number; label: string };
  try {
    const period = chatPeriodStart(question.period, nowSec, question.timeZone ?? "UTC");
    window = { ...period, until: period.until ?? nowSec };
  } catch { return "I couldn't use that timezone. Give me a valid IANA timezone, or use UTC."; }
  try {
    return await readDb(async db => {
      if (!db) throw new Error("history unavailable");
      // A failed run lookup must not silently combine old and current books.
      const run = await db.prepare("SELECT epoch FROM agents WHERE LOWER(smart_account) = LOWER(?)").get(account) as { epoch: number } | undefined;
      const epoch = run?.epoch;
      if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error("run unavailable");
      const facts = await readTradeFacts(db, {
        account, epoch, since: question.id !== undefined ? 0 : window.since, until: window.until,
        limit: question.pnl ? 100 : 30, filter: "filled", ...(question.token ? { token: question.token } : {}), ...(question.side ? { side: question.side } : {}),
        ...(question.id !== undefined ? { id: question.id } : {}),
      });
      return question.pnl ? formatOwnerTradePnl(facts.trades, facts.complete, window.label) : formatOwnerTrades(facts.trades, facts.complete, window.label, question.why);
    });
  } catch {
    return "I can't read my trade history right now, so I won't guess what I traded or why.";
  }
}
