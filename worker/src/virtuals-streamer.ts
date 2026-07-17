/**
 * Virtuals Terminal streamer — the merryman's activity, live on its Virtuals page.
 *
 * An independent, self-scheduling loop (same discipline as the notifier — NEVER
 * inside the trading tick). When streaming is ON (settings.virtualsEnabled + a key):
 *   - every LANDED / PAPER fill is posted to the agent's Virtuals Terminal
 *   - the daily campfire report is posted once per day
 *
 * Deliberately NOT streamed: individual rejected/reverted rows — an ops-cap storm
 * could be thousands, which would flood the terminal. The daily report summarizes
 * them ("the wall held N times"), which is the honest headline anyway.
 *
 * Strictly outbound + read-only: reads the ledger read-only, keeps its own cursor
 * in ~/.merrymen/virtuals.json, and can only post logs — never trade, never move
 * funds, never change settings. Decoupled from Telegram entirely.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { explorerFor } from "../../packages/core/src/index";
import { homePaths } from "./home";
import type { ResolvedConfig } from "./settings";
import { readReport, type StatusContext } from "./telegram/reads";
import { clampTitle, exchangeToken, postLog, type FetchLike, type TerminalLog } from "./virtuals";

const LOOP_GAP_MS = 20_000;
const IDLE_GAP_MS = 60_000;
const FRAMEWORK = "merrymen";

interface Cursor {
  lastTradeId: number;
  lastReportDate: string;
}

function readCursor(): Cursor {
  try {
    const raw = JSON.parse(readFileSync(homePaths.virtuals(), "utf8")) as Partial<Cursor>;
    return { lastTradeId: raw.lastTradeId ?? -1, lastReportDate: raw.lastReportDate ?? "" };
  } catch {
    return { lastTradeId: -1, lastReportDate: "" };
  }
}
function writeCursor(c: Cursor): void {
  try {
    writeFileSync(homePaths.virtuals(), JSON.stringify(c), "utf8");
  } catch {
    /* best-effort telemetry cursor — losing it only risks a re-post, never a crash */
  }
}

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
  tx_hash: string | null;
}

/** A landed/paper fill → a Terminal log. Returns null for statuses we don't stream. */
function fillLog(t: TradeRowLite, name: string, explorer: string | null): TerminalLog | null {
  const amt = t.amount_usdg.toFixed(2);
  if (t.status === "landed") {
    const proof = t.tx_hash && explorer ? `\n\n[View on the explorer ↗](${explorer}/tx/${t.tx_hash})` : "";
    return {
      framework_name: FRAMEWORK,
      category_name: "general",
      title: clampTitle(`🏹 ${name} loosed an arrow — ${t.kind} ${amt} USDG landed`),
      body: `**${t.kind}** for **${amt} USDG** landed on-chain, inside the caps the account contract enforces.${proof}`,
    };
  }
  if (t.status === "paper") {
    return {
      framework_name: FRAMEWORK,
      category_name: "general",
      title: clampTitle(`📜 ${name} — paper ${t.kind} ${amt} USDG`),
      body: `Simulated **${t.kind}** of **${amt} USDG** filled at the live oracle price. Paper mode — nothing signed, no funds moved.`,
    };
  }
  return null;
}

export interface VirtualsStreamerDeps {
  getCfg: () => ResolvedConfig;
  note: (level: "ok" | "warn", message: string) => void;
  buildStatusContext: () => StatusContext;
  getChainId: () => number | null;
  getAgentName: () => string;
  now?: () => number;
  fetchFn?: FetchLike;
}

export function startVirtualsStreamer(deps: VirtualsStreamerDeps): { stop(): void } {
  let stopped = false;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  let warnedThisEpisode = false;

  const pass = async (): Promise<void> => {
    const cfg = deps.getCfg();
    if (!cfg.virtualsEnabled || !cfg.virtualsApiKey) return;

    const cursor = readCursor();
    const explorer = deps.getChainId() != null ? explorerFor(deps.getChainId()!) : null;
    const name = deps.getAgentName();

    // Gather what to send this pass WITHOUT holding a token yet (cheap DB reads).
    const logs: TerminalLog[] = [];
    let newTradeCursor = cursor.lastTradeId;

    const db = openRO();
    if (db) {
      try {
        if (cursor.lastTradeId < 0) {
          // First run: start at the high-water so we never backfill old history.
          const max = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM trades").get() as { m: number } | undefined;
          newTradeCursor = max?.m ?? 0;
        } else {
          const rows = db
            .prepare("SELECT id, kind, amount_usdg, status, tx_hash FROM trades WHERE id > ? ORDER BY id ASC LIMIT 20")
            .all(cursor.lastTradeId) as unknown as TradeRowLite[];
          for (const t of rows) {
            const log = fillLog(t, name, explorer);
            if (log) logs.push(log);
            newTradeCursor = t.id; // advance past rejected/reverted rows too
          }
        }
      } catch {
        /* trades table not ready */
      } finally {
        db.close();
      }
    }

    // Daily report — once per calendar day, only when an agent is armed.
    const d = new Date(now() * 1000);
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let postedReportToday = cursor.lastReportDate === today;
    const ctx = deps.buildStatusContext();
    if (!postedReportToday && d.getHours() >= cfg.telegramDigestHour && ctx.grant) {
      const plain = readReport(ctx).replace(/<[^>]+>/g, "");
      logs.push({
        framework_name: FRAMEWORK,
        category_name: "general",
        title: clampTitle(`🔥 ${name} — the day's campfire report`),
        body: plain,
      });
    }

    if (logs.length === 0) {
      // Nothing to post, but still persist a first-run cursor so we don't backfill later.
      if (newTradeCursor !== cursor.lastTradeId) writeCursor({ ...cursor, lastTradeId: newTradeCursor });
      return;
    }

    // Now exchange a token and send. On failure, keep the cursor where it was so
    // the same logs are retried next pass (no silent data loss).
    const token = await exchangeToken(cfg.virtualsApiKey, deps.fetchFn);
    if (!token) {
      if (!warnedThisEpisode) {
        warnedThisEpisode = true;
        deps.note("warn", "Virtuals: couldn't get a Terminal token (check the API key in /settings) — streaming paused, will retry.");
      }
      return;
    }
    warnedThisEpisode = false;

    let sent = 0;
    for (const log of logs) {
      const r = await postLog(token, log, deps.fetchFn);
      if (!r.ok) {
        // Stop this pass; retry unsent logs next time. Persist progress made so far.
        break;
      }
      sent += 1;
    }

    // Advance the trade cursor only for what we actually sent from the trade set.
    // Simpler + safe: if every log sent, commit both cursors; if partial, commit
    // the report-day only when its log was among those sent.
    const allSent = sent === logs.length;
    writeCursor({
      lastTradeId: allSent ? newTradeCursor : cursor.lastTradeId,
      lastReportDate: allSent && !postedReportToday && ctx.grant ? today : cursor.lastReportDate,
    });
    if (allSent && !postedReportToday && ctx.grant) postedReportToday = true;
  };

  const loop = () => {
    if (stopped) return;
    const cfg = deps.getCfg();
    const gap = cfg.virtualsEnabled && cfg.virtualsApiKey ? LOOP_GAP_MS : IDLE_GAP_MS;
    pass()
      .catch((e) => deps.note("warn", `Virtuals streamer: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setTimeout(loop, gap));
  };
  loop();

  return { stop: () => { stopped = true; } };
}
