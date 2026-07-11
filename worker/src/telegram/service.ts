/**
 * Telegram poll service — the merryman's always-on ear.
 *
 * An independent, self-scheduling long-poll loop (setTimeout + .finally, NEVER
 * setInterval, NEVER inside the trading tick) started once from the worker's
 * main(). It reads the live config each iteration (so token/allowlist/enable
 * changes from the dashboard apply with no restart), gates every message on the
 * allowlist (except /link), routes obeyed messages through the interpreter →
 * executor, and replies. Every action is logged to the event feed so the
 * dashboard shows "Telegram: …".
 *
 * Safety: a chat message can only produce one enumerated Command; trades still
 * pass the policy wall via the injected submitTrade; /cap and caps clamp to the
 * signed grant. Nothing here can exceed the grant.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { patchSettingsFile, type ResolvedConfig } from "../settings";
import { ensureHome, homePaths } from "../home";
import { getMe, getUpdates, sendMessage, type TgMessage } from "./api";
import { executeCommand, type CommandDeps } from "./executor";
import { interpretWithLlm, parseSlash } from "./interpreter";
import { HELP_TEXT, readPnl, readPositions, readStatus, readTrades, type StatusContext } from "./reads";
import { ensureLinkCode, loadTelegramState, saveTelegramState, type TelegramState } from "./state";

export interface TelegramServiceDeps {
  /** Live config (reassigned each tick by refreshConfig — pass a getter). */
  getCfg: () => ResolvedConfig;
  /** Event-feed sink (strategyNote). */
  note: (level: "ok" | "warn", message: string) => void;
  /** Live status context for /status. */
  buildStatusContext: () => StatusContext;
  /** Validate + apply a strategy switch (name must resolve). */
  setStrategy: (name: string) => { ok: boolean; reason?: string };
  /** On-chain per-trade ceiling for clamping /cap; undefined when no grant. */
  grantPerTradeUsdg: () => number | undefined;
  /** Build a bounded TradeIntent and route it through processIntent. */
  submitTrade: (side: "buy" | "sell", symbol: string, usdg: number) => Promise<string>;
  /** Delete the grant (kill switch). */
  kill: () => { ok: boolean; reason?: string };
  /** Injectable for tests. */
  now?: () => number;
}

/** Toggle the pause marker the tick loop honors. */
export function setPaused(paused: boolean): void {
  try {
    ensureHome();
    if (paused) writeFileSync(homePaths.paused(), "paused", "utf8");
    else rmSync(homePaths.paused(), { force: true });
  } catch {
    // best-effort
  }
}

export function isPaused(): boolean {
  return existsSync(homePaths.paused());
}

/** Returns the current one-time link code (for the dashboard to display). */
export function currentLinkCode(seed: string): string {
  const st = ensureLinkCode(loadTelegramState(), seed);
  saveTelegramState(st);
  return st.linkCode;
}

/** Start the poll loop. Returns a stop() handle. */
export function startTelegram(deps: TelegramServiceDeps): { stop: () => void } {
  let stopped = false;
  let state: TelegramState = loadTelegramState();
  let warnedUnreachable = false;

  const handle = async (msg: TgMessage, cfg: ResolvedConfig): Promise<void> => {
    const token = cfg.telegramBotToken!;
    const allowed = cfg.telegramAllowlist.includes(msg.chatId) || cfg.telegramAllowlist.includes(msg.fromId);
    const slash = parseSlash(msg.text);

    // /link is the only command an unlisted chat may use.
    if (!allowed && !(slash?.kind === "link")) {
      await sendMessage({ token }, msg.chatId, "🚫 not authorized. Ask the owner to add you, or /link <code> if you have the code from the dashboard.");
      return;
    }

    const linkDep = (code: string): { ok: boolean; reason?: string } => {
      state = ensureLinkCode(state, token);
      if (!code || code.toUpperCase() !== state.linkCode.toUpperCase()) return { ok: false, reason: "bad or expired code" };
      // First-come owner + allowlist the chat.
      const next = new Set(cfg.telegramAllowlist);
      next.add(msg.chatId);
      patchSettingsFile({ telegramAllowlist: [...next] });
      state = { ...state, ownerId: state.ownerId ?? msg.fromId };
      saveTelegramState(state);
      deps.note("ok", `Telegram: linked chat ${msg.chatId}${msg.fromUsername ? ` (@${msg.fromUsername})` : ""}`);
      return { ok: true };
    };

    const cmdDeps: CommandDeps = {
      controlEnabled: cfg.telegramControlEnabled,
      maxActionUsdg: cfg.telegramMaxActionUsdg,
      grantPerTradeUsdg: deps.grantPerTradeUsdg(),
      reads: {
        status: () => readStatus(deps.buildStatusContext()),
        positions: () => readPositions(),
        pnl: () => readPnl(),
        trades: () => readTrades(),
      },
      setStrategy: (name) => {
        const r = deps.setStrategy(name);
        if (r.ok) {
          patchSettingsFile({ strategy: name });
          deps.note("ok", `Telegram: strategy → ${name}`);
        }
        return r;
      },
      setCap: (usdg) => {
        patchSettingsFile({ telegramMaxActionUsdg: usdg });
        deps.note("ok", `Telegram: chat cap → ${usdg} USDG`);
      },
      setPaused: (paused) => {
        setPaused(paused);
        deps.note("warn", `Telegram: ${paused ? "paused" : "resumed"} by chat ${msg.chatId}`);
      },
      kill: () => {
        const r = deps.kill();
        if (r.ok) deps.note("warn", `Telegram: KILL by chat ${msg.chatId}`);
        return r;
      },
      link: linkDep,
      trade: deps.submitTrade,
      help: () => HELP_TEXT,
    };

    // Slash command wins; else natural language (LLM) if a key is set; else nudge.
    let cmd = slash;
    if (!cmd) {
      if (cfg.anthropicApiKey) {
        cmd = await interpretWithLlm(
          msg.text,
          { state: readStatus(deps.buildStatusContext()) },
          { apiKey: cfg.anthropicApiKey, model: cfg.llmModel },
        );
      } else {
        cmd = { kind: "chat", reply: "add an Anthropic key in the dashboard to chat in plain English. For now, try /help." };
      }
    }

    const reply = await executeCommand(cmd, cmdDeps);
    await sendMessage({ token }, msg.chatId, reply);
  };

  const pollOnce = async (): Promise<void> => {
    const cfg = deps.getCfg();
    if (!cfg.telegramEnabled || !cfg.telegramBotToken) return; // idle until enabled
    state = ensureLinkCode(state, cfg.telegramBotToken);

    const { messages, nextOffset, reason } = await getUpdates({ token: cfg.telegramBotToken }, state.offset);
    if (reason) {
      if (!warnedUnreachable) {
        deps.note("warn", `Telegram: getUpdates — ${reason}`);
        warnedUnreachable = true;
      }
      return;
    }
    warnedUnreachable = false;
    for (const msg of messages) {
      try {
        await handle(msg, cfg);
      } catch (e) {
        deps.note("warn", `Telegram: error handling message — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (nextOffset !== state.offset) {
      state = { ...state, offset: nextOffset };
      saveTelegramState(state);
    }
  };

  const loop = () => {
    if (stopped) return;
    const cfg = deps.getCfg();
    // Enabled: getUpdates long-polls ~25s, so loop tight. Disabled: re-check slowly.
    const gap = cfg.telegramEnabled && cfg.telegramBotToken ? 500 : 8000;
    pollOnce()
      .catch((e) => deps.note("warn", `Telegram: poll loop — ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setTimeout(loop, gap));
  };

  // Announce the bot identity once at startup (best-effort).
  const cfg0 = deps.getCfg();
  if (cfg0.telegramEnabled && cfg0.telegramBotToken) {
    void getMe({ token: cfg0.telegramBotToken }).then((r) => {
      if (r.bot) deps.note("ok", `Telegram: connected as @${r.bot.username}`);
      else deps.note("warn", `Telegram: token check failed — ${r.reason}`);
    });
  }
  loop();
  return { stop: () => { stopped = true; } };
}
