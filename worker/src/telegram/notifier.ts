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

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homePaths } from "../home";
import type { ResolvedConfig } from "../settings";
import { esc, sendMessage } from "./api";
import { readReport, type StatusContext } from "./reads";
import type { StateRef } from "./state";

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

function tradeLine(t: TradeRowLite): string {
  if (t.status === "landed") {
    return `🏹 loosed an arrow — ${esc(t.kind)} ${t.amount_usdg.toFixed(2)} USDG landed${t.tx_hash ? `\n<code>${esc(t.tx_hash)}</code>` : ""}`;
  }
  if (t.status === "rejected") {
    return `🛡 the wall turned back a ${esc(t.kind)} (${esc(t.reject_rule ?? "policy")}) — ${t.amount_usdg.toFixed(2)} USDG stayed home`;
  }
  return `⚠️ a ${esc(t.kind)} of ${t.amount_usdg.toFixed(2)} USDG reverted on-chain — nothing moved`;
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
    const db = openRO();
    if (db) {
      try {
        if (state.lastNotifiedTradeId < 0) {
          // First run: start at the current high-water so history isn't replayed.
          const max = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM trades").get() as { m: number } | undefined;
          deps.stateRef.set({ ...deps.stateRef.get(), lastNotifiedTradeId: max?.m ?? 0 });
        } else {
          const rows = db
            .prepare(
              "SELECT id, kind, amount_usdg, status, reject_rule, tx_hash FROM trades WHERE id > ? ORDER BY id ASC LIMIT 10",
            )
            .all(state.lastNotifiedTradeId) as unknown as TradeRowLite[];
          for (const t of rows) {
            await sendMessage({ token }, chatId, tradeLine(t));
            deps.stateRef.set({ ...deps.stateRef.get(), lastNotifiedTradeId: t.id });
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

    // ── daily campfire report ───────────────────────────────────────────────
    const d = new Date(now() * 1000);
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const st2 = deps.stateRef.get();
    if (st2.lastDigestDate !== today && d.getHours() >= cfg.telegramDigestHour && inputs.grantExpiresAt !== null) {
      await sendMessage({ token }, chatId, readReport(deps.buildStatusContext()));
      deps.stateRef.set({ ...deps.stateRef.get(), lastDigestDate: today });
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
