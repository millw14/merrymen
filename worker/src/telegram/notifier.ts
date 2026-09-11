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
import { homePaths } from "../home";
import type { ResolvedConfig } from "../settings";
import { appendJournal, getName, relationship } from "../soul";
import { cpuPercent, procRunning } from "../pc/platform";
import { esc, sendMessage } from "./api";
import { resolveLlm } from "../llm";
import { narrateJournal } from "./interpreter";
import { readReport, type StatusContext } from "./reads";
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

interface TradeRowLite {
  id: number;
  kind: string;
  amount_usdg: number;
  status: string;
  reject_rule: string | null;
  tx_hash: string | null;
}

/** Exported for the same reason tradeDigestLine is: it is a pure string rule
 *  that decides what a failure is BLAMED on, and that deserves a test. */
export function tradeLine(t: TradeRowLite, explorer: string | null): string {
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
    return `🛡 the wall turned back a ${esc(t.kind)} (${esc(t.reject_rule ?? "policy")}) — ${t.amount_usdg.toFixed(2)} USDG stayed home`;
  }
  // "reverted" status covers both an on-chain revert AND a pre-submission failure
  // (bundler/gas/RPC). reject_rule carries the specific reason — show it rather than
  // always claiming an on-chain revert.
  const why = t.reject_rule ? ` — ${esc(t.reject_rule)}` : "";
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
              "SELECT id, kind, amount_usdg, status, reject_rule, tx_hash FROM trades WHERE id > ? AND agent_id = ? ORDER BY id ASC LIMIT 10",
            )
            .all(state.lastNotifiedTradeId, agentId) as unknown as TradeRowLite[];
          for (const t of rows) {
            await sendMessage({ token }, chatId, tradeLine(t, explorer));
            deps.stateRef.set({ ...deps.stateRef.get(), lastNotifiedTradeId: t.id });
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
            if (total > 0) await sendMessage({ token }, chatId, tradeDigestLine(agg, periodMin));
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
    if (inputs.drawdownBps !== null && inputs.breakerBps !== null && inputs.breakerBps > 0) {
      if (inputs.drawdownBps >= inputs.breakerBps / 2) {
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
      await sendMessage({ token }, chatId, report);
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
