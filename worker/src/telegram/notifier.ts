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
import { explorerFor } from "../../../packages/core/src/index";
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
  /** Current drawdown from the high-water mark, bps; null when unknown. */
  drawdownBps: number | null;
  /** The breaker limit, bps; null when not armed. */
  breakerBps: number | null;
  /** Native gas balance; null when unknown. */
  gasWei: bigint | null;
}

export interface NotifierDeps {
  getCfg: () => ResolvedConfig;
  note: (level: "ok" | "warn", message: string) => void;
  stateRef: StateRef;
  buildStatusContext: () => StatusContext;
  getAlertInputs: () => AlertInputs;
  /** The armed grant's chain id → block-explorer proof links. Null when unarmed. */
  getChainId: () => number | null;
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

function tradeLine(t: TradeRowLite, explorer: string | null): string {
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
  publishPrices(prices: Map<string, { price8: bigint; stale: boolean }>): void;
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
              "SELECT id, kind, amount_usdg, status, reject_rule, tx_hash FROM trades WHERE id > ? ORDER BY id ASC LIMIT 10",
            )
            .all(state.lastNotifiedTradeId) as unknown as TradeRowLite[];
          for (const t of rows) {
            await sendMessage({ token }, chatId, tradeLine(t, explorer));
            deps.stateRef.set({ ...deps.stateRef.get(), lastNotifiedTradeId: t.id });
          }
        } else {
          // Quiet mode: batch trade pings into ONE summary every periodMin minutes.
          const st = deps.stateRef.get();
          if (now() - st.lastTradeDigestAt >= periodMin * 60) {
            const agg = db
              .prepare("SELECT status, COUNT(*) AS c, COALESCE(SUM(amount_usdg), 0) AS s FROM trades WHERE id > ? GROUP BY status")
              .all(st.lastNotifiedTradeId) as unknown as TradeAgg[];
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
    if (inputs.drawdownBps !== null && inputs.breakerBps !== null && inputs.breakerBps > 0) {
      if (inputs.drawdownBps >= inputs.breakerBps / 2) {
        await fire(
          "drawdown",
          `📉 drawdown warning: ${(inputs.drawdownBps / 100).toFixed(1)}% off the high-water mark (breaker trips at ${(inputs.breakerBps / 100).toFixed(1)}%). /pause if you want the band to hold.`,
        );
      }
    }
    if (inputs.gasWei !== null && inputs.gasWei > 0n && inputs.gasWei < LOW_GAS_WEI) {
      await fire("low-gas", `⛽ gas is running low — top up the account from the faucet or the trades stop landing.`);
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
    if (st2.lastDigestDate !== today && d.getHours() >= cfg.telegramDigestHour && inputs.grantExpiresAt !== null) {
      const report = readReport(deps.buildStatusContext());
      await sendMessage({ token }, chatId, report);
      deps.stateRef.set({ ...deps.stateRef.get(), lastDigestDate: today });
      // The merryman keeps its own journal — its .md grows with every day on
      // the road. LLM voice when a key is set, honest stat lines otherwise.
      const plainReport = report.replace(/<[^>]+>/g, "");
      const evidence = `${plainReport}\n\nRELATIONSHIP: ${rel.stage}, day ${rel.daysTogether}, ${rel.messageCount} messages with my owner.`;
      const journalLlm = resolveLlm(cfg);
      const entry = journalLlm
        ? await narrateJournal(evidence, journalLlm)
        : `Day ${rel.daysTogether} with my owner (${rel.stage}).\n${plainReport}`;
      appendJournal(entry, now());
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
