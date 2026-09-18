/**
 * Proactive notifier — the merryman speaks first.
 *
 * An independent, self-scheduling loop (setTimeout + .finally, same discipline
 * as the poll service — NEVER inside the trading tick) that pushes to the
 * OWNER's chat (the /link claimant):
 *   - trade pings the moment a row lands in the trades table
 *   - condition alerts: grant expiring, drawdown nearing the breaker, low gas —
 *     deduped per episode so one bad hour doesn't spam
 *   - user price alerts (one-shot, crossing-edge triggered; prices are pushed
 *     in from the tick via publishPrices — the notifier never reads the chain)
 *   - the daily campfire report at the configured hour
 *
 * Strictly read-only + outbound: it reads the ledger read-only, mutates only
 * telegram.json bookkeeping through the shared StateRef, and can neither trade
 * nor change settings. Gated by telegramNotifyEnabled.
 */

import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { explorerFor, type PriceQuote } from "../../../packages/core/src/index";
import { rejectRuleLabel, rejectRuleRemedy } from "../thesis-policy";
import { homePaths, merrymenHome } from "../home";
import type { ResolvedConfig } from "../settings";
import { appendJournal, getName, relationship } from "../soul";
import { cpuPercent, procRunning } from "../pc/platform";
import { esc, sendMessage } from "./api";
import { pnlCardFromFill } from "../pnl-card";
import { sendPnlPhoto } from "./pnl-photo";
import { resolveLlm } from "../llm";
import { narrateJournal, narrateTrade } from "./interpreter";
import { readReport, type StatusContext } from "./reads";
import { readResearch } from "../research-files";
import type { StateRef, Watcher } from "./state";

export interface AlertInputs {
  /** Grant expiry (unix) or null when not armed. */
  grantExpiresAt: number | null;
  /**
   * The most this agent may put into one action, USDG — `min(llmMaxActionUsdg,
   * the per-trade cap sealed into the grant)`. Null when not armed.
   *
   * WHY AN ALERT NEEDS IT. An agent whose ceiling is a rounding error against
   * its own book is not broken and has nothing to report: every window it
   * correctly concludes there is nothing worth doing at that size, proposes
   * nothing, and looks from outside exactly like an agent that has stopped
   * working. One owner watched that for days and reported the bot as dead.
   *
   * The strategist works the reason out every single window — "the max action
   * size ($1) is barely bigger than the position itself" — and until now that
   * went only into prose nobody acts on. This is the same defect as the
   * renewal banner: the system knows precisely why it is idle and does not say
   * so where the owner is looking.
   */
  maxActionUsdg: number | null;
  /** Deployable capital, USDG — what the ceiling is judged against. */
  cashUsdg: number | null;
  /** Current drawdown from the high-water mark, bps; null when unknown. */
  drawdownBps: number | null;
  /** The breaker limit, bps; null when not armed. */
  breakerBps: number | null;
  /** Native gas balance; null when unknown. */
  gasWei: bigint | null;
  /**
   * Is a sponsor paying this agent's TRADING gas?
   *
   * Changes what a zero balance MEANS. Unsponsored it stops everything;
   * sponsored it stops only the way out, because the recovery path pays its own
   * fee from the balance it is sweeping and is never sponsored.
   */
  gasSponsored?: boolean;
  /**
   * Is the agent trading on paper?
   *
   * LOAD-BEARING, not decoration. The paper branch of the tick HARDCODES
   * `ethWei: 0n` rather than reading the chain, so `gasWei` is a fabricated
   * zero there and says nothing about the real balance. The unsponsored copy
   * below has always handled that with its closing caveat; the sponsored arm
   * cannot, because 'you cannot withdraw' would be an actionable claim about a
   * balance nobody looked at.
   */
  paper?: boolean;
}

export interface NotifierDeps {
  getCfg: () => ResolvedConfig;
  note: (level: "ok" | "warn", message: string) => void;
  stateRef: StateRef;
  buildStatusContext: () => StatusContext;
  getAlertInputs: () => AlertInputs;
  /** The armed grant's chain id → block-explorer proof links. Null when unarmed. */
  getChainId: () => number | null;
  /** This tenant's own agent id — scopes the trade cursor. Null when unarmed. */
  getAgentId: () => string | null;
  now?: () => number;
}

const LOOP_GAP_MS = 15_000;
const IDLE_GAP_MS = 30_000;
const CONDITION_COOLDOWN_SEC = 6 * 3600;
const LOW_GAS_WEI = 500_000_000_000_000n; // 0.0005 native — a few trades left

function openRO(): DatabaseSync | null {
  const file = homePaths.db();
  if (!existsSync(file)) return null;
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

/**
 * The decision a trade came from, or null.
 *
 * Read-only and failure-tolerant on purpose: this exists to decorate a message
 * that is already correct without it, so a missing row, a schema older than
 * `decision_id`, or a locked database must cost the owner nothing but the extra
 * sentence.
 */
function decisionFor(db: DatabaseSync, decisionId: string | null | undefined): DecisionLite | null {
  if (!decisionId) return null;
  try {
    const row = db
      .prepare("SELECT symbol, action, reason FROM decisions WHERE id = ?")
      .get(decisionId) as unknown as DecisionLite | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** What the news desk held when this pass ran. Empty on any read failure. */
function newsNow(): NewsLite[] {
  try {
    return readResearch(merrymenHome()).news.items.map((n) => ({
      headline: n.headline,
      source: n.source,
      symbols: n.symbols,
    }));
  } catch {
    return [];
  }
}

interface TradeRowLite {
  id: number;
  kind: string;
  amount_usdg: number;
  status: string;
  reject_rule: string | null;
  tx_hash: string | null;
  /** The decision this trade came from, when one was linked. */
  decision_id?: string | null;
  /** The token, for the P&L card's headline. */
  target?: string | null;
  /** The three fields a closed round trip is drawn from. See pnl-card.ts. */
  fill_side?: string | null;
  fill_cash_usdg?: number | null;
  realized_pnl_usdg?: number | null;
}

/**
 * The columns a trade ping reads. Kept in one place because the immediate and
 * the quiet path must select the SAME shape — the card was added to one of them
 * first, and a digest that silently lacked the P&L columns is exactly the kind
 * of drift that makes a feature look broken for half the fleet.
 */
const TRADE_PING_COLUMNS =
  "id, kind, amount_usdg, status, reject_rule, tx_hash, decision_id, " +
  "target, fill_side, fill_cash_usdg, realized_pnl_usdg";

/**
 * The P&L card for a row that closed something, or nothing at all.
 *
 * SWALLOWS EVERYTHING. `pnlCardFromFill` returns null for a buy, a refusal or
 * an unbacked sell, and `sendPnlPhoto` already reports rather than throws — but
 * this is called from inside the ping loop, and an image is never a reason for
 * an owner to stop being told what their agent did.
 */
async function sendCardFor(
  row: TradeRowLite,
  token: string,
  chatId: number,
  /**
   * Immediate mode puts a full receipt directly above the card, so the picture
   * is captioned by what it follows. A digest does NOT — it sends counts — so
   * there the card must carry its own line or it arrives as an image of some
   * numbers with nothing saying which position closed.
   */
  withCaption: boolean,
): Promise<void> {
  try {
    const card = pnlCardFromFill(row);
    if (!card) return;
    await sendPnlPhoto({ token }, chatId, card, withCaption ? undefined : "");
  } catch {
    /* the receipt is the record; the picture is decoration */
  }
}

/** Just enough of a decision row to explain the trade it produced. */
export interface DecisionLite {
  symbol: string | null;
  action: string | null;
  reason: string | null;
}

/** Just enough of a news story. `url` is deliberately absent — see renderNews. */
export interface NewsLite {
  headline: string;
  source: string;
  symbols: readonly string[];
}

/**
 * THE EVIDENCE A TRADE'S EXPLANATION MAY BE BUILT FROM, and nothing else.
 *
 * Pure, exported and tested, because this is the boundary that decides what a
 * model is allowed to know about the owner's money. Two rules live here:
 *
 * NO FIGURES CROSS IT. The amount, the price and the hash are on the receipt
 * line already, printed by code. Putting them in the prompt too is how a model
 * comes to restate one — and a wrong number beside a right one is worse than no
 * sentence at all. Only the symbol, the side, the stated reason and headlines
 * are passed.
 *
 * NO INVENTION BEHIND IT. When there is no reason recorded and no news matched,
 * this returns null and the caller sends the receipt alone. An agent that
 * cannot say why it traded must not be handed a model and asked to improvise
 * one; "it followed the rules" is the honest answer and the narrator is told to
 * give it, but only when there genuinely was a rule and nothing more.
 */
export function tradeWhyEvidence(
  row: Pick<TradeRowLite, "kind" | "status">,
  decision: DecisionLite | null,
  news: readonly NewsLite[],
): string | null {
  const reason = (decision?.reason ?? "").trim();
  const symbol = (decision?.symbol ?? "").trim().toUpperCase();
  const matched = symbol
    ? news.filter((n) => n.symbols.some((s) => s.toUpperCase() === symbol)).slice(0, 3)
    : [];
  // Nothing to explain FROM. Silence beats a fabricated rationale.
  if (!reason && matched.length === 0) return null;

  const lines = [
    `WHAT HAPPENED: a ${row.kind} ${row.status === "paper" ? "filled on the paper book" : "went through"}${symbol ? ` in ${symbol}` : ""}.`,
    decision?.action ? `SIDE: ${decision.action}.` : "",
    reason ? `THE DECISION'S OWN STATED REASON: ${reason}` : "NO REASON WAS RECORDED for this one.",
  ].filter(Boolean);

  if (matched.length) {
    lines.push(`NEWS THE DESK HELD FOR ${symbol} AT THE TIME:`);
    // Headline and publisher only. `url` is never rendered into a prompt — the
    // same rule renderNews states, for the same reason: a link is an
    // instruction-shaped thing to hand a model.
    for (const n of matched) lines.push(`- ${n.headline} (${n.source})`);
  } else if (symbol) {
    lines.push(`NEWS: the desk held no stories for ${symbol}. Do not imply there were any.`);
  }
  return lines.join("\n");
}

/**
 * Exported for the same reason tradeDigestLine is: it is a pure string rule
 * that decides what a failure is BLAMED on, and that deserves a test.
 *
 * `withRemedy` is the caller's decision, not this function's, because it
 * depends on what was pushed LAST — see `TelegramState.lastRemedyRule`. Keeping
 * it a parameter is what lets the dedupe live in the poll loop while this stays
 * a pure function of a row.
 */
export function tradeLine(t: TradeRowLite, explorer: string | null, withRemedy = false): string {
  if (t.status === "landed") {
    const proof = t.tx_hash
      ? explorer
        ? `\n🔗 <a href="${explorer}/tx/${esc(t.tx_hash)}">proof — view on the explorer ↗</a>`
        : `\n<code>${esc(t.tx_hash)}</code>`
      : "";
    return `🏹 loosed an arrow — ${esc(t.kind)} ${t.amount_usdg.toFixed(2)} USDG landed${proof}`;
  }
  if (t.status === "paper") {
    return `📜 paper arrow — ${esc(t.kind)} ${t.amount_usdg.toFixed(2)} USDG filled at the live price (simulated, nothing signed)`;
  }
  if (t.status === "rejected") {
    // A SPONSOR FAILURE IS NOT A WALL REFUSAL. The wall is the owner's own
    // sealed policy, and saying it turned a trade back blames them for the
    // house failing to pay a fee — the one reading of this line that sends
    // somebody looking through their own settings for a fault that is ours.
    if (t.reject_rule?.startsWith("sponsor-")) {
      return `⛽ a ${esc(t.kind)} didn't go out — the gas sponsor declined it (${esc(t.reject_rule)}), which is ours to fix. ${t.amount_usdg.toFixed(2)} USDG stayed home`;
    }
    /**
     * THE SLUG IS NOT AN EXPLANATION, AND THIS IS THE CHANNEL IT REACHED HIM ON.
     *
     * A beta owner pasted `refused: no-exit` back to us and asked what it meant
     * "if my agent tries to buy some custom token i added". The chat arm in
     * index.ts was converted to the vocabulary and this one was not — and the
     * chat arm only fires when the owner TYPES an order. His question was about
     * the autonomous tick, which writes a rejected row that this poller turns
     * into a push. So the one surface that was fixed is the one surface his
     * question does not reach, and the bare word kept going out.
     *
     * Same vocabulary as the public feed and the chat, so the three cannot
     * drift. This is the owner's own bot, so it carries the remedy with /grant —
     * held to once per rule, because the refusal repeats every tick and the
     * instruction does not need to.
     */
    const label = rejectRuleLabel(t.reject_rule);
    const fix = withRemedy ? rejectRuleRemedy(t.reject_rule) : null;
    const slug = t.reject_rule ?? "policy";
    if (!label) {
      return `🛡 the wall turned back a ${esc(t.kind)} (${esc(slug)}) — ${t.amount_usdg.toFixed(2)} USDG stayed home`;
    }
    return (
      `🛡 the wall turned back a ${esc(t.kind)} — ${esc(label)}.` +
      `${fix ? ` ${esc(fix)}` : ""}` +
      ` ${t.amount_usdg.toFixed(2)} USDG stayed home (${esc(slug)})`
    );
  }
  // "reverted" status covers both an on-chain revert AND a pre-submission failure
  // (bundler/gas/RPC). reject_rule carries the specific reason — show it rather than
  // always claiming an on-chain revert.
  // Through the vocabulary for the same reason as above; the slug survives as a
  // parenthetical because support triages on it and an unknown rule must stay
  // traceable.
  const revertLabel = rejectRuleLabel(t.reject_rule);
  const why = t.reject_rule
    ? revertLabel
      ? ` — ${esc(revertLabel)} (${esc(t.reject_rule)})`
      : ` — ${esc(t.reject_rule)}`
    : "";
  return `⚠️ a ${esc(t.kind)} of ${t.amount_usdg.toFixed(2)} USDG didn't go through${why} (nothing moved)`;
}

interface TradeAgg {
  status: string;
  c: number;
  s: number;
}

/** Pretty a period like 5/15/60/1440 minutes → "5m" / "1h" / "24h". */
function periodLabel(min: number): string {
  if (min % 1440 === 0) return `${min / 1440}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}

/**
 * Quiet mode: one line summarising the trades since the last flush, instead of a
 * ping per fill. Pure + exported for tests. Only non-empty status buckets show.
 */
export function tradeDigestLine(rows: TradeAgg[], periodMin: number): string {
  const by: Record<string, TradeAgg> = {};
  for (const r of rows) by[r.status] = r;
  const parts: string[] = [];
  if (by.landed) parts.push(`🏹 ${by.landed.c}× landed (${by.landed.s.toFixed(2)} USDG)`);
  if (by.paper) parts.push(`📜 ${by.paper.c}× paper (${by.paper.s.toFixed(2)} USDG)`);
  if (by.rejected) parts.push(`🛡 ${by.rejected.c}× turned back`);
  if (by.reverted) parts.push(`⚠️ ${by.reverted.c}× didn't go through`);
  const label = periodLabel(periodMin);
  return `📊 <b>last ${label}</b> — ${parts.join(" · ") || "quiet"}\n<i>you're on a ${label} summary; /status or /trades for detail.</i>`;
}

export interface NotifierHandle {
  stop(): void;
  /** Called from the tick with fresh feed prices (symbol → {price8, stale}). */
  publishPrices(prices: Map<string, PriceQuote>): void;
}

export function startNotifier(deps: NotifierDeps): NotifierHandle {
  let stopped = false;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  let latestPrices: Map<string, number> = new Map();

  const pass = async (): Promise<void> => {
    const cfg = deps.getCfg();
    const state = deps.stateRef.get();
    if (!cfg.telegramEnabled || !cfg.telegramBotToken || !cfg.telegramNotifyEnabled) return;
    if (state.ownerId === null) return; // nobody has /link-ed yet — no recipient
    const token = cfg.telegramBotToken;
    const chatId = state.ownerId;

    // ── trade pings ─────────────────────────────────────────────────────────
    const chainId = deps.getChainId();
    const explorer = chainId != null ? explorerFor(chainId) : null;
    // This tenant's own agent. A null id binds as SQL NULL below, and `agent_id
    // = NULL` matches nothing — so an unarmed notifier reports nobody's trades
    // rather than, on a shared ledger, some other tenant's.
    const agentId = deps.getAgentId();
    const periodMin = cfg.telegramNotifyEveryMin;
    const db = openRO();
    if (db) {
      try {
        if (state.lastNotifiedTradeId < 0) {
          // First run: start at the current high-water so history isn't replayed.
          const max = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM trades").get() as { m: number } | undefined;
          deps.stateRef.set({ ...deps.stateRef.get(), lastNotifiedTradeId: max?.m ?? 0, lastTradeDigestAt: now() });
        } else if (periodMin <= 0) {
          // Immediate: one message per trade row.
          const rows = db
            .prepare(
              `SELECT ${TRADE_PING_COLUMNS} FROM trades WHERE id > ? AND agent_id = ? ORDER BY id ASC LIMIT 10`,
            )
            .all(state.lastNotifiedTradeId, agentId) as unknown as TradeRowLite[];
          for (const t of rows) {
            // THE REMEDY ON CHANGE, THE REFUSAL EVERY TIME. A strategist that
            // keeps proposing the same uncovered leg produces one rejected row
            // per tick; the owner needs to see that it is still happening, and
            // needs to be told how to fix it once.
            const prev = deps.stateRef.get();
            const rule = t.status === "rejected" ? t.reject_rule : null;
            const withRemedy = rule !== null && rule !== prev.lastRemedyRule;
            const receipt = tradeLine(t, explorer, withRemedy);
            /**
             * AND THEN, FOR A TRADE THAT ACTUALLY HAPPENED, WHY.
             *
             * Only on a fill — landed or paper. A refusal repeats every tick
             * while the same leg keeps being proposed, and narrating each one
             * would spend a model call per tick to say the same thing; the
             * refusal's own remedy already carries the fix, once per rule.
             * A fill is rate-limited by the thing itself: it happens when the
             * agent actually trades.
             *
             * The receipt goes out whatever happens here. `said` is additive,
             * built from evidence that contains no figures, and an empty string
             * on any failure — so the worst case is the message the owner got
             * yesterday.
             */
            let said = "";
            if (t.status === "landed" || t.status === "paper") {
              const llm = resolveLlm(cfg);
              if (llm) {
                const evidence = tradeWhyEvidence(t, decisionFor(db, t.decision_id), newsNow());
                if (evidence) said = await narrateTrade(evidence, llm);
              }
            }
            await sendMessage({ token }, chatId, said ? `${receipt}\n\n${esc(said)}` : receipt);
            // AND THE PICTURE, when this row closed something at a knowable
            // P&L. After the receipt on purpose: the text is the record and
            // goes out whatever happens to the image.
            await sendCardFor(t, token, chatId, false);
            console.log(`[notify] trade ping sent — id=${t.id} rule=${t.reject_rule ?? t.status}`);
            deps.stateRef.set({
              ...deps.stateRef.get(),
              lastNotifiedTradeId: t.id,
              ...(withRemedy ? { lastRemedyRule: rule } : {}),
            });
          }
        } else {
          // Quiet mode: batch trade pings into ONE summary every periodMin minutes.
          const st = deps.stateRef.get();
          if (now() - st.lastTradeDigestAt >= periodMin * 60) {
            const agg = db
              .prepare("SELECT status, COUNT(*) AS c, COALESCE(SUM(amount_usdg), 0) AS s FROM trades WHERE id > ? AND agent_id = ? GROUP BY status")
              .all(st.lastNotifiedTradeId, agentId) as unknown as TradeAgg[];
            const maxRow = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM trades").get() as { m: number } | undefined;
            const total = agg.reduce((n, r) => n + r.c, 0);
            if (total > 0) {
              await sendMessage({ token }, chatId, tradeDigestLine(agg, periodMin));
              console.log(`[notify] digest sent — ${total} trades over ${periodMin}m`);
            }
            // A CLOSE STILL GETS ITS CARD ON A DIGEST. Quiet mode exists to
            // stop a strategist that re-proposes the same refused leg from
            // pinging every tick; a realised sale is rate-limited by the thing
            // itself — you can only close what you opened — and it is the one
            // event the digest's counts cannot convey. Sending the summary and
            // silently dropping the P&L would give half the fleet a feature
            // that never fires.
            const closes = db
              .prepare(
                `SELECT ${TRADE_PING_COLUMNS} FROM trades ` +
                  "WHERE id > ? AND agent_id = ? AND fill_side = 'sell' AND realized_pnl_usdg IS NOT NULL " +
                  "ORDER BY id ASC LIMIT 10",
              )
              .all(st.lastNotifiedTradeId, agentId) as unknown as TradeRowLite[];
            for (const t of closes) await sendCardFor(t, token, chatId, true);
            deps.stateRef.set({
              ...deps.stateRef.get(),
              lastNotifiedTradeId: Math.max(st.lastNotifiedTradeId, maxRow?.m ?? st.lastNotifiedTradeId),
              lastTradeDigestAt: now(),
            });
          }
        }
      } catch {
        /* trades table not ready */
      } finally {
        db.close();
      }
    }

    // ── condition alerts (deduped per episode) ─────────────────────────────
    const inputs = deps.getAlertInputs();
    const fire = async (key: string, message: string): Promise<void> => {
      const st = deps.stateRef.get();
      const last = st.firedAlerts[key] ?? 0;
      if (now() - last < CONDITION_COOLDOWN_SEC) return;
      await sendMessage({ token }, chatId, message);
      // THE KEY ONLY, NEVER THE MESSAGE. An alert that fires invisibly cannot
      // be verified by anyone: asked whether an owner had actually been told,
      // there was nothing to look at but the absence of a complaint. The key
      // is enough to answer that and carries no chat content into the log.
      console.log(`[notify] condition alert sent — ${key}`);
      deps.stateRef.set({ ...st, firedAlerts: { ...st.firedAlerts, [key]: now() } });
    };

    if (inputs.grantExpiresAt !== null) {
      const left = inputs.grantExpiresAt - now();
      if (left > 0 && left < 86_400) {
        // Key includes the expiry so a re-signed grant alerts afresh.
        await fire(
          `grant-expiry:${inputs.grantExpiresAt}`,
          `⏳ your permission grant dies in ${Math.max(1, Math.floor(left / 3600))}h — re-sign at the dashboard /grant to keep the band riding.`,
        );
      }
    }
    // ── A CEILING SO LOW THE AGENT HAS NOTHING WORTH DOING ─────────────────
    //
    // Not a fault, which is exactly why it needs saying: the agent is funded,
    // unblocked and correct, and will go on proposing nothing for as long as
    // the ceiling stands. Every other alert here reports something broken; this
    // one reports a setting quietly making a working agent look dead.
    //
    // TWENTIETHS, not a fixed floor. A $1 ceiling is fine on a $20 book and
    // absurd on a $50 one, so the test is whether a single action could move
    // the book at all. Twenty is deliberately generous — an owner who chose a
    // small cap on purpose is not nagged, and the alert fires only where the
    // arithmetic is genuinely self-defeating.
    //
    // Keyed on the ceiling itself, so raising it and hitting the same wall
    // again alerts afresh rather than being swallowed by a cooldown.
    if (
      !inputs.paper &&
      inputs.maxActionUsdg !== null &&
      inputs.maxActionUsdg > 0 &&
      inputs.cashUsdg !== null &&
      inputs.cashUsdg >= 20 * inputs.maxActionUsdg
    ) {
      await fire(
        `action-ceiling:${inputs.maxActionUsdg}`,
        `🪙 your per-trade limit is <b>$${inputs.maxActionUsdg.toFixed(2)}</b> against $${inputs.cashUsdg.toFixed(2)} of cash, ` +
          `so I keep deciding there is nothing worth buying at that size — a trade that small cannot move your book. ` +
          `Nothing is broken: I am funded and live and the limit is doing exactly what it says. ` +
          `Raise it at the dashboard <b>/grant</b> (free, same wallet, same funds, nothing moves), ` +
          `and check <b>LLM max per action</b> in /settings — whichever is lower is the one that binds.`,
      );
    }
    // ── APPROACHING THE BREAKER, AND HAVING ALREADY HIT IT ─────────────────
    //
    // These were one message and they are not one event. Below the line the
    // agent is still trading and the owner is being warned; at or above it the
    // agent has STOPPED BUYING and its OWNER was never told. checkPolicy's
    // `drawdown-breaker` refusal writes a rejected row and logs
    // `[policy] REJECTED ...` for an operator — but it raises no event and
    // sends no message. An operator log is not a notification: from the
    // owner's side an agent refusing every entry looks exactly like one that
    // has found nothing to do.
    //
    // That cost hours on a live canary: it proposed a qualifying trade every
    // tick for an afternoon, each one refused at 17.6% against a 5% cap, and
    // the only thing its owner ever saw was the same "drawdown warning" they
    // had already read at 2.5%.
    //
    // The halt message must also say what CLEARS it, because the answer is not
    // obvious: the high-water mark is a one-way ratchet on equity, so waiting
    // does nothing on its own — either equity recovers past the mark, or the
    // cap is re-signed higher. Exits are exempt throughout, which is why this
    // says "buying" and not "trading".
    if (inputs.drawdownBps !== null && inputs.breakerBps !== null && inputs.breakerBps > 0) {
      if (inputs.drawdownBps >= inputs.breakerBps) {
        await fire(
          // Keyed on the cap, so re-signing a higher one and still being halted
          // alerts afresh rather than being swallowed by the old cooldown.
          `drawdown-halted:${inputs.breakerBps}`,
          `🛑 I have <b>stopped buying</b>. You are ${(inputs.drawdownBps / 100).toFixed(1)}% below your high-water mark ` +
            `and your breaker trips at ${(inputs.breakerBps / 100).toFixed(1)}% — so every entry I propose is being turned back, ` +
            `and will be until this clears. Nothing is broken; this is the drawdown limit doing its job. ` +
            `I can still SELL, so exits are unaffected. Two things clear it: equity recovering back above the ` +
            `high-water mark, or re-signing a wider drawdown limit at the dashboard <b>/grant</b>. ` +
            `Waiting alone will not — the high-water mark only ever ratchets up.`,
        );
      } else if (inputs.drawdownBps >= inputs.breakerBps / 2) {
        await fire(
          "drawdown",
          `📉 drawdown warning: ${(inputs.drawdownBps / 100).toFixed(1)}% off the high-water mark (breaker trips at ${(inputs.breakerBps / 100).toFixed(1)}%). /pause if you want the band to hold.`,
        );
      }
    }
    // ZERO used to be excluded by that `> 0n`, so the one balance at which
    // every operation is guaranteed to fail was the one balance that produced
    // no warning at all. It gets its own, blunter message: "low" understates a
    // condition that is not low but stopped.
    const sponsored = inputs.gasSponsored === true;
    const noGas = inputs.gasWei === 0n;
    const lowGas = inputs.gasWei !== null && inputs.gasWei > 0n && inputs.gasWei < LOW_GAS_WEI;
    if (sponsored) {
      // SPONSORED: zero and low mean the same thing, so they share one alert.
      // Trading is unaffected either way; what thins out is the way OUT.
      //
      // Skipped on paper entirely: the paper tick fabricates `ethWei: 0n`, so
      // firing here would tell an owner they cannot withdraw from an account
      // whose balance nothing read. Its own key, so the corrected message is not
      // held behind a cooldown started by the message it replaces.
      if (!inputs.paper && (noGas || lowGas)) {
        await fire(
          "withdrawal-gas",
          `⛽ the account is low on <b>ETH</b>. The network fee on every trade is sponsored, so this does ` +
            `not stop it trading. Moving money back <b>out</b> to your own wallet is the one thing that ` +
            `still pays its own way, and it needs a little ETH sitting in the account — a dollar or two ` +
            `is plenty.`,
        );
      }
    } else if (noGas) {
      await fire(
        "no-gas",
        `⛽ the account has <b>no ETH</b> — live trades cannot land at all. The account pays its own gas, ` +
          `so send a little <b>ETH</b> to it; USDG is capital and cannot pay for anything. ` +
          `(Paper mode signs nothing, so this only bites once you're live.)`,
      );
    } else if (lowGas) {
      // Chain- and mode-agnostic on purpose: there's no faucet on mainnet, and in
      // paper mode nothing signs, so gas can't be what's stopping a trade. Also
      // names gas-vs-capital — "top up the account" is what sends people to USDG.
      await fire(
        "low-gas",
        `⛽ native gas is low. If you're signing live trades, send a little <b>ETH</b> to the smart account or they stop landing — ETH is gas, USDG is capital. (In paper mode nothing signs, so gas doesn't matter; on testnet gas is the only thing worth sending.)`,
      );
    }

    // ── relationship milestones (fire once, ever) ───────────────────────────
    const fireOnce = async (key: string, message: string): Promise<void> => {
      const st = deps.stateRef.get();
      if (st.firedAlerts[key] !== undefined) return;
      await sendMessage({ token }, chatId, message);
      deps.stateRef.set({ ...st, firedAlerts: { ...st.firedAlerts, [key]: now() } });
    };
    const rel = relationship(deps.stateRef.get().linkedAt, deps.stateRef.get().messageCount, now());
    const MILESTONES: Record<number, string> = {
      7: `🌱 a week on the road together. I'm ${esc(getName())}, and I'm starting to learn your ways — here's to the rides ahead.`,
      30: `🌳 a month riding together! Whatever the market did, we did it side by side. I know you better now — ask /soul and see.`,
      100: `🏹 a hundred days. Most bands don't last a fortnight. You and me — we're the real merrymen now.`,
      365: `👑 one year. Through every gap, drawdown and rally — still riding with you. Sworn brother-in-arms, always.`,
    };
    for (const [days, message] of Object.entries(MILESTONES)) {
      if (rel.daysTogether >= Number(days)) await fireOnce(`milestone:${days}`, message);
    }

    // ── user price alerts (one-shot, crossing-edge) ─────────────────────────
    if (latestPrices.size > 0) {
      const st = deps.stateRef.get();
      if (st.priceAlerts.length > 0) {
        const keep: typeof st.priceAlerts = [];
        let changed = false;
        for (const a of st.priceAlerts) {
          const px = latestPrices.get(a.symbol);
          if (px === undefined) {
            keep.push(a);
            continue;
          }
          const satisfied = a.op === ">" ? px > a.price : px < a.price;
          const prevSatisfied =
            a.lastPrice !== undefined ? (a.op === ">" ? a.lastPrice > a.price : a.lastPrice < a.price) : false;
          if (satisfied && !prevSatisfied) {
            await sendMessage(
              { token },
              chatId,
              `🔔 <b>${esc(a.symbol)}</b> is ${a.op === ">" ? "above" : "below"} ${a.price} — now $${px.toFixed(2)}. (alert done — set another with /alert)`,
            );
            changed = true; // one-shot: drop it
          } else {
            keep.push({ ...a, lastPrice: px });
            changed = changed || a.lastPrice !== px;
          }
        }
        if (changed) deps.stateRef.set({ ...deps.stateRef.get(), priceAlerts: keep });
      }
    }

    // ── reminders (due → fire once → remove) ────────────────────────────────
    {
      const st = deps.stateRef.get();
      const due = st.reminders.filter((r) => r.fireAt <= now());
      if (due.length) {
        for (const r of due) await sendMessage({ token }, chatId, `⏰ <b>reminder</b> — ${esc(r.text)}`);
        deps.stateRef.set({ ...deps.stateRef.get(), reminders: deps.stateRef.get().reminders.filter((r) => r.fireAt > now()) });
      }
    }

    // ── watchers (edge/change-triggered) — only when the capability is on ────
    if (cfg.telegramPcControlEnabled && cfg.telegramCapabilities.includes("watchers")) {
      const st = deps.stateRef.get();
      if (st.watchers.length) {
        const updated: Watcher[] = [];
        for (const w of st.watchers) {
          let next = w;
          try {
            if (w.kind === "cpu" && w.threshold) {
              const pct = await cpuPercent();
              if (pct !== null) {
                const above = pct >= w.threshold;
                if (above && w.lastState === false) {
                  await sendMessage({ token }, chatId, `🔥 CPU is at ${pct}% (watch #${w.id}: > ${w.threshold}%).`);
                }
                next = { ...w, lastState: above };
              }
            } else if (w.kind === "file") {
              let mtime: number | null = null;
              try {
                mtime = existsSync(w.arg) ? statSync(w.arg).mtimeMs : null;
              } catch {
                mtime = null;
              }
              if (mtime !== null) {
                if (w.lastValue !== undefined && mtime > w.lastValue) {
                  await sendMessage({ token }, chatId, `📄 <code>${esc(w.arg)}</code> changed (watch #${w.id}).`);
                }
                next = { ...w, lastValue: mtime };
              }
            } else if (w.kind === "proc") {
              const running = await procRunning(w.arg);
              if (running !== null) {
                if (w.lastState !== undefined && running !== w.lastState) {
                  await sendMessage({ token }, chatId, `⚙️ <b>${esc(w.arg)}</b> ${running ? "started" : "stopped"} (watch #${w.id}).`);
                }
                next = { ...w, lastState: running };
              }
            }
          } catch {
            /* a flaky probe must not kill the pass */
          }
          updated.push(next);
        }
        // Persist the observed states (edge detection needs them next pass).
        deps.stateRef.set({ ...deps.stateRef.get(), watchers: updated });
      }
    }

    // ── daily campfire report + tonight's journal entry ────────────────────
    const d = new Date(now() * 1000);
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const st2 = deps.stateRef.get();
    const dueToday = st2.lastDigestDate !== today && d.getHours() >= cfg.telegramDigestHour;

    // The DIGEST keeps its grant gate — a trading report about a wallet you
    // don't have is noise.
    if (dueToday && inputs.grantExpiresAt !== null) {
      const report = readReport(deps.buildStatusContext());
      /**
       * THE DAY IN WORDS, ABOVE THE DAY IN NUMBERS.
       *
       * The narrated version of exactly this evidence already existed two
       * branches below and was written to a file the owner never opens. The
       * report they DO get was the raw template. So the agent has been keeping
       * an eloquent private diary and sending its owner a spreadsheet.
       *
       * One model call per tenant per DAY, which is why this is the cheapest
       * fluency in the codebase and why the 2026-08-31 token-budget incident —
       * a research loop running per window — does not apply.
       *
       * The numeric report is unchanged and still sent, underneath. Prose on
       * top, receipt below: the same order, and the same reason, as a trade.
       */
      const reportLlm = resolveLlm(cfg);
      let opener = "";
      if (reportLlm) {
        const evidence = [
          report.replace(/<[^>]+>/g, ""),
          ``,
          `RELATIONSHIP: ${rel.stage}, day ${rel.daysTogether}, ${rel.messageCount} messages with my owner.`,
        ].join("\n");
        const said = await narrateJournal(evidence, reportLlm);
        // narrateJournal falls back to the EVIDENCE ITSELF on failure — correct
        // where it writes a private file, wrong here, where it would print the
        // report a second time above the report. Only genuine prose goes on top.
        opener = said && said.trim() !== evidence.trim() && !said.includes("RELATIONSHIP:") ? said.trim() : "";
      }
      await sendMessage({ token }, chatId, opener ? `${esc(opener)}\n\n${report}` : report);
      deps.stateRef.set({ ...deps.stateRef.get(), lastDigestDate: today });
    }

    // The JOURNAL does not. It used to sit inside the same branch, so a user
    // with no grant never accumulated one at all — even though the journal is
    // about the day WITH ITS OWNER, not about trading, and it writes a file
    // rather than sending a message. Tracked on its own date so the two can
    // never starve each other.
    if (st2.lastJournalDate !== today && d.getHours() >= cfg.telegramDigestHour) {
      const hasGrant = inputs.grantExpiresAt !== null;
      const plainReport = hasGrant ? readReport(deps.buildStatusContext()).replace(/<[^>]+>/g, "") : "";
      const evidence = [
        hasGrant ? plainReport : "No wallet armed today — a quiet day off the road.",
        ``,
        `RELATIONSHIP: ${rel.stage}, day ${rel.daysTogether}, ${rel.messageCount} messages with my owner.`,
      ].join("\n");
      const journalLlm = resolveLlm(cfg);
      const entry = journalLlm
        ? await narrateJournal(evidence, journalLlm)
        : `Day ${rel.daysTogether} with my owner (${rel.stage}).\n${hasGrant ? plainReport : "No wallet armed today."}`;
      appendJournal(entry, now());
      deps.stateRef.set({ ...deps.stateRef.get(), lastJournalDate: today });
    }
  };

  const loop = () => {
    if (stopped) return;
    const cfg = deps.getCfg();
    const gap = cfg.telegramEnabled && cfg.telegramBotToken && cfg.telegramNotifyEnabled ? LOOP_GAP_MS : IDLE_GAP_MS;
    pass()
      .catch((e) => deps.note("warn", `Telegram notifier: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setTimeout(loop, gap));
  };
  loop();

  return {
    stop: () => {
      stopped = true;
    },
    publishPrices: (prices) => {
      const next = new Map<string, number>();
      for (const [sym, p] of prices) next.set(sym, Number(p.price8) / 1e8);
      latestPrices = next;
    },
  };
}
