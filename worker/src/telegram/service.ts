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
 * signed grant. Transfers additionally require the dashboard toggle, a grant
 * that carries the transfer permission, and an explicit /confirm after the full
 * recipient address is echoed back. The link code rotates after every
 * successful /link and guesses are rate-limited. Nothing here can exceed the
 * grant.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
// RELATIVE import only — the "@merrymen/core" alias exists solely in dev
// tsconfigs; inside the installed package tsx can't resolve it and the worker
// dies at startup (which silently kills Telegram). Never alias-import in worker/.
import { PC_CAPABILITIES } from "../../../packages/core/src/index";
import { patchSettingsFile, type ResolvedConfig } from "../settings";
import { ensureHome, homePaths } from "../home";
import { esc, getFileUrl, getMe, getUpdates, sendMessage, type TgMessage } from "./api";
import { executeCommand, type CommandDeps, type PendingAction } from "./executor";
import { resolveLlm } from "../llm";
import { interpretWithLlm, narrateWhy, parseSlash } from "./interpreter";
import { makePcActions, resolveInRoot } from "./pc";
import { transcribeVoice } from "./voice";
import { fmtReminders, fmtWatchers, parseWatchSpec, parseWhenSec } from "./watchers";
import {
  HELP_TEXT,
  readBrag,
  readLlmState,
  readPnl,
  readPositions,
  readReport,
  readStatus,
  readTrades,
  readWhyEvidence,
  type StatusContext,
} from "./reads";
import { ensureLinkCode, rotateLinkCode, type StateRef } from "./state";
import {
  ensureSoul,
  forgetOwner,
  getBornDate,
  getName,
  ownerFacts,
  relationship,
  rememberOwnerFact,
  setName as setSoulName,
  soulPromptBlock,
} from "../soul";

export interface TelegramServiceDeps {
  /** Live config (reassigned each tick by refreshConfig — pass a getter). */
  getCfg: () => ResolvedConfig;
  /** Shared persisted state (offset, link code, owner, alerts …). */
  stateRef: StateRef;
  /** Event-feed sink (strategyNote). */
  note: (level: "ok" | "warn", message: string) => void;
  /** Live status context for /status. */
  buildStatusContext: () => StatusContext;
  /** Validate + apply a strategy switch (name must resolve). */
  setStrategy: (name: string) => { ok: boolean; reason?: string };
  /** On-chain per-trade ceiling for clamping /cap; undefined when no grant. */
  grantPerTradeUsdg: () => number | undefined;
  /** Does the armed grant carry the on-chain transfer permission? */
  grantHasTransfer: () => boolean;
  /** Build a bounded TradeIntent and route it through processIntent. */
  submitTrade: (side: "buy" | "sell", symbol: string, usdg: number) => Promise<string>;
  /** Build a bounded transfer intent and route it through processIntent. */
  submitTransfer: (to: `0x${string}`, usdg: number) => Promise<string>;
  /** Delete the grant (kill switch). */
  kill: () => { ok: boolean; reason?: string };
  /** Mirror a /name change into the agents table (dashboard display). */
  onNameChange?: (name: string) => void;
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

const LINK_MAX_FAILS = 5;
const LINK_LOCKOUT_SEC = 600;
const HISTORY_TURNS = 6; // user+assistant pairs kept per chat for follow-ups

/** Start the poll loop. Returns a stop() handle. */
export function startTelegram(deps: TelegramServiceDeps): { stop: () => void } {
  let stopped = false;
  const stateRef = deps.stateRef;
  let warnedUnreachable = false;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  ensureSoul(now()); // the merryman is born (IDENTITY/OWNER/JOURNAL.md) on first run

  // Per-chat runtime (in-memory only — cleared on restart, which is safe):
  const pending = new Map<number, PendingAction>(); // awaiting /confirm
  const linkFails = new Map<number, { fails: number; until: number }>();
  const history = new Map<number, { role: "user" | "assistant"; content: string }[]>();

  const pushHistory = (chatId: number, role: "user" | "assistant", content: string): void => {
    const h = history.get(chatId) ?? [];
    h.push({ role, content: content.slice(0, 600) });
    while (h.length > HISTORY_TURNS * 2) h.shift();
    history.set(chatId, h);
  };

  const handle = async (msg: TgMessage, cfg: ResolvedConfig): Promise<void> => {
    const token = cfg.telegramBotToken!;
    const allowed = cfg.telegramAllowlist.includes(msg.chatId) || cfg.telegramAllowlist.includes(msg.fromId);

    // Voice note → text: only for allowlisted chats with the "voice" capability.
    // Transcribed text then flows through the SAME path as a typed message.
    if (msg.voiceFileId && !msg.text) {
      if (!allowed) {
        await sendMessage({ token }, msg.chatId, "🚫 not authorized.");
        return;
      }
      if (!cfg.telegramPcControlEnabled || !cfg.telegramCapabilities.includes("voice")) {
        await sendMessage({ token }, msg.chatId, "🎙️ voice is off — enable “remote control” + the voice capability in the dashboard.");
        return;
      }
      if (!cfg.telegramTranscribeKey) {
        await sendMessage({ token }, msg.chatId, "🎙️ add a transcription key (OpenAI-compatible) in the dashboard to talk to me by voice.");
        return;
      }
      const { url } = await getFileUrl({ token }, msg.voiceFileId);
      const t = url
        ? await transcribeVoice(url, { key: cfg.telegramTranscribeKey, base: cfg.telegramTranscribeBase })
        : { text: null as string | null, reason: "couldn't fetch the voice file" };
      if (!t.text) {
        await sendMessage({ token }, msg.chatId, `🎙️ couldn't transcribe that: ${esc(t.reason ?? "unknown")}`);
        return;
      }
      msg = { ...msg, text: t.text };
      await sendMessage({ token }, msg.chatId, `🎙️ <i>heard:</i> ${esc(t.text)}`);
    }

    const slash = parseSlash(msg.text);

    // /link is the only command an unlisted chat may use — and it's rate-limited.
    if (!allowed && !(slash?.kind === "link")) {
      await sendMessage({ token }, msg.chatId, "🚫 not authorized. Ask the owner to add you, or /link &lt;code&gt; if you have the code from the dashboard.");
      return;
    }

    const linkDep = (code: string): { ok: boolean; reason?: string } => {
      const lock = linkFails.get(msg.chatId);
      if (lock && lock.fails >= LINK_MAX_FAILS && now() < lock.until) {
        return { ok: false, reason: "too many attempts — try again in a few minutes" };
      }
      let state = ensureLinkCode(stateRef.get(), token);
      if (!code || code.toUpperCase() !== state.linkCode.toUpperCase()) {
        const prev = lock && now() < lock.until ? lock.fails : 0;
        linkFails.set(msg.chatId, { fails: prev + 1, until: now() + LINK_LOCKOUT_SEC });
        return { ok: false, reason: "bad or expired code" };
      }
      linkFails.delete(msg.chatId);
      // First-come owner + allowlist the chat; the code is consumed (rotates).
      // linkedAt marks day zero of the relationship — the bond grows from here.
      const next = new Set(cfg.telegramAllowlist);
      next.add(msg.chatId);
      patchSettingsFile({ telegramAllowlist: [...next] });
      state = rotateLinkCode(
        { ...state, ownerId: state.ownerId ?? msg.fromId, linkedAt: state.linkedAt ?? now() },
        token,
      );
      stateRef.set(state);
      if (msg.fromUsername) rememberOwnerFact(`Their Telegram handle is @${msg.fromUsername}.`, now());
      deps.note("ok", `Telegram: linked chat ${msg.chatId}${msg.fromUsername ? ` (@${msg.fromUsername})` : ""}`);
      return { ok: true };
    };

    const statusCtx = () => deps.buildStatusContext();
    const cmdDeps: CommandDeps = {
      controlEnabled: cfg.telegramControlEnabled,
      maxActionUsdg: cfg.telegramMaxActionUsdg,
      grantPerTradeUsdg: deps.grantPerTradeUsdg(),
      transferEnabled: cfg.telegramTransferEnabled,
      grantHasTransfer: deps.grantHasTransfer(),
      reads: {
        status: () => readStatus(statusCtx()),
        positions: () => readPositions(),
        pnl: () => readPnl(),
        trades: () => readTrades(),
        report: () => readReport(statusCtx()),
        brag: () => readBrag(statusCtx()),
        why: async () => {
          const ev = readWhyEvidence();
          const llm = resolveLlm(cfg);
          if (!ev.hasTrade || !llm) return ev.text;
          return narrateWhy(ev.text.replace(/<[^>]+>/g, ""), llm);
        },
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
      transfer: async (to, usdg) => {
        deps.note("warn", `Telegram: transfer ${usdg} USDG → ${to} confirmed by chat ${msg.chatId}`);
        return deps.submitTransfer(to, usdg);
      },
      getPending: () => pending.get(msg.chatId) ?? null,
      setPending: (p) => pending.set(msg.chatId, p),
      clearPending: () => pending.delete(msg.chatId),
      addAlert: (symbol, op, price) => {
        const st = stateRef.get();
        if (st.priceAlerts.length >= 20) return "you're at the 20-alert limit — /unalert one first.";
        const id = st.priceAlerts.reduce((m, a) => Math.max(m, a.id), 0) + 1;
        stateRef.set({ ...st, priceAlerts: [...st.priceAlerts, { id, symbol: symbol.toUpperCase(), op, price }] });
        return `🔔 alert #${id} set — I'll ping you when ${esc(symbol.toUpperCase())} goes ${op === ">" ? "above" : "below"} ${price}. (fires once; needs the worker running)`;
      },
      listAlerts: () => {
        const st = stateRef.get();
        if (!st.priceAlerts.length) return "no price alerts set. Try: /alert QQQ &gt; 600";
        return ["🔔 <b>price alerts</b>", ...st.priceAlerts.map((a) => `#${a.id} — ${esc(a.symbol)} ${a.op === ">" ? "&gt;" : "&lt;"} ${a.price}`)].join("\n");
      },
      removeAlert: (id) => {
        const st = stateRef.get();
        const next = st.priceAlerts.filter((a) => a.id !== id);
        if (next.length === st.priceAlerts.length) return `no alert #${id}. /alerts lists them.`;
        stateRef.set({ ...st, priceAlerts: next });
        return `🔕 alert #${id} removed.`;
      },
      setName: (name) => {
        const r = setSoulName(name);
        if (r.ok) {
          deps.onNameChange?.(r.name);
          deps.note("ok", `Telegram: the merryman is now called ${r.name}`);
        }
        return r;
      },
      remember: (fact) => rememberOwnerFact(fact, now()),
      soulInfo: () => {
        const st = stateRef.get();
        const rel = relationship(st.linkedAt, st.messageCount, now());
        const facts = ownerFacts();
        return [
          `🌳 <b>${esc(getName())}</b> of the merrymen`,
          `• born ${getBornDate()} · ${rel.stage}`,
          `• ${rel.daysTogether} day(s) riding with you · ${rel.messageCount} messages shared`,
          facts.length
            ? `• what I know about you:\n${facts.slice(-8).map((f) => `  ${esc(f.replace(/^- /, "· "))}`).join("\n")}`
            : `• I don't know much about you yet — tell me things, or /remember them for me`,
          ``,
          `my soul lives in ~/.merrymen/soul/ — read it, edit it, it's yours. /name renames me · /forget wipes what I know.`,
        ].join("\n");
      },
      forgetOwner: () => forgetOwner(),
      // ── PC control ─────────────────────────────────────────────────────
      pcControlEnabled: cfg.telegramPcControlEnabled,
      capabilities: new Set(cfg.telegramCapabilities),
      filesRoot: cfg.telegramFilesRoot,
      shellAllowlist: cfg.telegramShellAllowlist,
      pc: makePcActions(
        { token },
        msg.chatId,
        {
          filesRoot: cfg.telegramFilesRoot,
          shellAllowlist: cfg.telegramShellAllowlist,
          appAllowlist: cfg.telegramAppAllowlist,
          anthropicApiKey: cfg.anthropicApiKey,
          llmModel: cfg.llmModel,
        },
        deps.note,
      ),
      pcStatus: () => {
        const on = cfg.telegramPcControlEnabled;
        const caps = new Set(cfg.telegramCapabilities);
        const rows = PC_CAPABILITIES.map((c) => `${caps.has(c) ? "✅" : "▫️"} ${c}`).join("  ");
        return [
          `🖥️ <b>remote control</b> — master ${on ? "ON" : "OFF"}`,
          rows,
          on
            ? `enabled: ${[...caps].join(", ") || "(none — turn some on in the dashboard)"}`
            : `turn it on in the dashboard → settings → remote control.`,
          `shell + type + files + power always ask for /confirm first.`,
        ].join("\n");
      },
      addReminder: (when, text) => {
        const sec = parseWhenSec(when);
        if (sec === null) return "when? e.g. /remind 20m stretch (s/m/h/d).";
        const st = stateRef.get();
        if (st.reminders.length >= 20) return "you're at the 20-reminder limit — /unremind one first.";
        const id = st.nextId;
        stateRef.set({
          ...st,
          nextId: id + 1,
          reminders: [...st.reminders, { id, fireAt: now() + sec, text: text.slice(0, 300) }],
        });
        return `⏰ reminder #${id} set — I'll ping you in ${when}. (needs the worker running)`;
      },
      listReminders: () => fmtReminders(stateRef.get().reminders, now()),
      removeReminder: (id) => {
        const st = stateRef.get();
        const next = st.reminders.filter((r) => r.id !== id);
        if (next.length === st.reminders.length) return `no reminder #${id}. /reminders lists them.`;
        stateRef.set({ ...st, reminders: next });
        return `🗑️ reminder #${id} removed.`;
      },
      addWatcher: (spec) => {
        const parsed = parseWatchSpec(spec);
        if (!parsed) return "watch what? e.g. cpu>80, file &lt;path&gt;, proc &lt;name&gt;";
        if (parsed.kind === "file") {
          const res = resolveInRoot(cfg.telegramFilesRoot, parsed.arg);
          if (!res.ok) return `🔒 ${esc(res.reason)}`;
        }
        const st = stateRef.get();
        if (st.watchers.length >= 20) return "you're at the 20-watcher limit — /unwatch one first.";
        const id = st.nextId;
        stateRef.set({
          ...st,
          nextId: id + 1,
          watchers: [...st.watchers, { id, kind: parsed.kind, arg: parsed.kind === "cpu" ? "" : parsed.arg, threshold: parsed.kind === "cpu" ? parsed.threshold : undefined }],
        });
        return `👀 watcher #${id} set. (needs the worker running)`;
      },
      listWatchers: () => fmtWatchers(stateRef.get().watchers),
      removeWatcher: (id) => {
        const st = stateRef.get();
        const next = st.watchers.filter((w) => w.id !== id);
        if (next.length === st.watchers.length) return `no watcher #${id}. /watchers lists them.`;
        stateRef.set({ ...st, watchers: next });
        return `🗑️ watcher #${id} removed.`;
      },
      help: () => HELP_TEXT,
      now,
    };

    // The relationship deepens one message at a time (owner chats only).
    if (msg.fromId === stateRef.get().ownerId || msg.chatId === stateRef.get().ownerId) {
      stateRef.set({ ...stateRef.get(), messageCount: stateRef.get().messageCount + 1 });
    }

    // Slash command wins; else natural language (LLM) if a key is set; else nudge.
    let cmd = slash;
    if (!cmd) {
      const llm = resolveLlm(cfg);
      if (llm) {
        const st = stateRef.get();
        const soulBlock = soulPromptBlock(st.linkedAt, st.messageCount, now());
        const r = await interpretWithLlm(
          msg.text,
          { state: `SOUL:\n${soulBlock}\n\n${readLlmState(statusCtx())}`, history: history.get(msg.chatId) },
          llm,
        );
        cmd = r.cmd;
        // The get-to-know-you side-channel: the model proposes a fact, the
        // sanitizer disposes (drops addresses/keys/markup, dedupes, caps).
        if (r.remember) rememberOwnerFact(r.remember, now());
      } else {
        cmd = { kind: "chat", reply: "add a free Groq key (or an Anthropic key to upgrade) in the dashboard to chat in plain English. For now, try /help." };
      }
      pushHistory(msg.chatId, "user", msg.text);
    }

    // A failed command must still answer — silence reads as a dead bot.
    let reply: string;
    try {
      reply = await executeCommand(cmd, cmdDeps);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      deps.note("warn", `Telegram: ${cmd.kind} failed — ${m}`);
      reply = `🚫 that ${cmd.kind} failed: ${esc(m.slice(0, 200))}`;
    }
    if (!slash) pushHistory(msg.chatId, "assistant", reply.replace(/<[^>]+>/g, ""));
    await sendMessage({ token }, msg.chatId, reply);
  };

  const pollOnce = async (): Promise<void> => {
    const cfg = deps.getCfg();
    if (!cfg.telegramEnabled || !cfg.telegramBotToken) return; // idle until enabled
    stateRef.set(ensureLinkCode(stateRef.get(), cfg.telegramBotToken));

    const { messages, nextOffset, reason } = await getUpdates({ token: cfg.telegramBotToken }, stateRef.get().offset);
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
    if (nextOffset !== stateRef.get().offset) {
      stateRef.set({ ...stateRef.get(), offset: nextOffset });
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
