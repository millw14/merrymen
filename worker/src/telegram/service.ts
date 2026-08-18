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
import { loadGrantFile } from "../grant";
import { esc, answerCallbackQuery, editMessageText, getFileUrl, getMe, getUpdates, sendMessage, type TgCallback, type TgInlineKeyboard, type TgMessage } from "./api";
import { runAgentTask } from "./agent";
import { describePending, executeCommand, type CommandDeps, type PendingAction } from "./executor";
import { resolveLlm } from "../llm";
import { CONTROL_KINDS, PC_KINDS, interpretWithLlm, narrateChat, narrateWhy, parseSlash, type Command } from "./interpreter";
import { makePcActions, resolveInRoot } from "./pc";
import * as pcp from "../pc/platform";
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
  ageDays,
  ensureSoul,
  forgetOwner,
  getBornDate,
  getName,
  ownerFacts,
  relationship,
  rememberNote,
  rememberOwnerFact,
  setName as setSoulName,
  soulPromptBlock,
  identityBlock,
  recallForPrompt,
} from "../soul";
import { appendChatTurn, clearChatTurns, lastChatTurnAt, recentChatTurns } from "../store";
import { describeGap } from "../memory/retrieve";

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

/** Inline Confirm/Cancel row attached to every parked-action reply, so the
 * user taps instead of typing /confirm. Only the same chat+fromId that parked
 * the action is ever allowed to resolve it (see handleCallback). */
const CONFIRM_MARKUP: TgInlineKeyboard = {
  inline_keyboard: [
    [
      { text: "✅ Confirm", callback_data: "confirm" },
      { text: "✖ Cancel", callback_data: "cancel" },
    ],
  ],
};

/** Start the poll loop. Returns a stop() handle. */
export function startTelegram(deps: TelegramServiceDeps): { stop: () => void } {
  let stopped = false;
  const stateRef = deps.stateRef;
  let warnedUnreachable = false;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  ensureSoul(now()); // the merryman is born (IDENTITY/OWNER/JOURNAL.md) on first run

  // Per-chat runtime (in-memory only — cleared on restart, which is safe):
  // Keyed by `${chatId}:${fromId}` — a parked action is bound to the USER who
  // parked it, so in a group one member can't /confirm another's transfer/shell.
  const pending = new Map<string, PendingAction>(); // awaiting /confirm
  const linkFails = new Map<number, { fails: number; until: number }>();
  const history = new Map<number, { role: "user" | "assistant"; content: string }[]>();
  // Memory ids surfaced on the previous turn, per chat. A follow-up like "is it
  // done?" shares no words with anything on disk, so without carrying the last
  // turn's ids forward the thread is lost the moment the topic isn't restated.
  const stickyIds = new Map<number, Set<string>>();
  // One detached /agent task per chat; /agent stop flips the flag mid-run.
  const agentRuns = new Map<number, { stopped: boolean }>();

  /**
   * Who a message/callback is FROM. The pending-confirm store and the deps are
   * keyed on this so an inline-button tap can resolve the exact action the
   * SAME user parked — a group member can't tap another member's confirm.
   */
  type Peer = { chatId: number; fromId: number; fromUsername?: string };

  /**
   * Shared /link implementation, parameterized over the peer (chat/from). Used
   * from executeCommand's "link" branch for messages; callbacks never link.
   */
  const linkDep = (cfg: ResolvedConfig, peer: Peer, code: string): { ok: boolean; reason?: string } => {
    const token = cfg.telegramBotToken!;
    const lock = linkFails.get(peer.chatId);
    if (lock && lock.fails >= LINK_MAX_FAILS && now() < lock.until) {
      return { ok: false, reason: "too many attempts — try again in a few minutes" };
    }
    let state = ensureLinkCode(stateRef.get(), token);
    if (!code || code.toUpperCase() !== state.linkCode.toUpperCase()) {
      const prev = lock && now() < lock.until ? lock.fails : 0;
      linkFails.set(peer.chatId, { fails: prev + 1, until: now() + LINK_LOCKOUT_SEC });
      return { ok: false, reason: "bad or expired code" };
    }
    linkFails.delete(peer.chatId);
    // First-come owner + allowlist the chat; the code is consumed (rotates).
    // linkedAt marks day zero of the relationship — the bond grows from here.
    const next = new Set(cfg.telegramAllowlist);
    next.add(peer.chatId);
    patchSettingsFile({ telegramAllowlist: [...next] });
    state = rotateLinkCode(
      { ...state, ownerId: state.ownerId ?? peer.fromId, linkedAt: state.linkedAt ?? now() },
      token,
    );
    stateRef.set(state);
    if (peer.fromUsername) rememberOwnerFact(`Their Telegram handle is @${peer.fromUsername}.`, now());
    deps.note("ok", `Telegram: linked chat ${peer.chatId}${peer.fromUsername ? ` (@${peer.fromUsername})` : ""}`);
    return { ok: true };
  };

  /**
   * The executor's dependencies for a given peer. Shared by message handling
   * and inline-button resolution, so /confirm-from-a-button and
   * /confirm-typed land on the exact same code path (same re-vetting, same
   * gates) — there is no second, weaker confirmation route.
   */
  const buildCmdDeps = (cfg: ResolvedConfig, peer: Peer): CommandDeps => {
    const key = `${peer.chatId}:${peer.fromId}`;
    const statusCtx = () => deps.buildStatusContext();
    return {
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
        deps.note("warn", `Telegram: ${paused ? "paused" : "resumed"} by chat ${peer.chatId}`);
      },
      kill: () => {
        const r = deps.kill();
        if (r.ok) deps.note("warn", `Telegram: KILL by chat ${peer.chatId}`);
        return r;
      },
      link: (code) => linkDep(cfg, peer, code),
      trade: deps.submitTrade,
      transfer: async (to, usdg) => {
        deps.note("warn", `Telegram: transfer ${usdg} USDG → ${to} confirmed by chat ${peer.chatId}`);
        return deps.submitTransfer(to, usdg);
      },
      getPending: () => pending.get(key) ?? null,
      setPending: (p) => pending.set(key, p),
      clearPending: () => pending.delete(key),
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
          `• ${ageDays(now())} days old · born ${getBornDate()} · ${rel.stage}`,
          `• ${rel.daysTogether} day(s) riding with you · ${rel.messageCount} messages shared`,
          facts.length
            ? `• what I know about you:\n${facts.slice(-8).map((f) => `  ${esc(f.replace(/^- /, "· "))}`).join("\n")}`
            : `• I don't know much about you yet — tell me things, or /remember them for me`,
          ``,
          `my soul lives in ~/.merrymen/soul/ — read it, edit it, it's yours. /name renames me · /forget wipes what I know.`,
        ].join("\n");
      },
      // /forget must now clear the CONVERSATION too, not just OWNER.md —
      // turns persist to disk since chat_turns, so wiping only the facts while
      // the transcript survived would make the reply ("I've let go of what I
      // knew about you") untrue.
      forgetOwner: () => {
        forgetOwner();
        clearChatTurns(peer.chatId);
        history.delete(peer.chatId);
        stickyIds.delete(peer.chatId);
      },
      // ── PC control ─────────────────────────────────────────────────────
      pcControlEnabled: cfg.telegramPcControlEnabled,
      capabilities: new Set(cfg.telegramCapabilities),
      filesRoot: cfg.telegramFilesRoot,
      shellAllowlist: cfg.telegramShellAllowlist,
      pc: makePcActions(
        { token: cfg.telegramBotToken! },
        peer.chatId,
        {
          filesRoot: cfg.telegramFilesRoot,
          shellAllowlist: cfg.telegramShellAllowlist,
          appAllowlist: cfg.telegramAppAllowlist,
          anthropicApiKey: cfg.anthropicApiKey,
          llmModel: cfg.llmModel,
          requestInstall: (tool) => {
            // Park an install offer bound to this peer; returns the package
            // name so pc.ts can format the offer text. The service's parked
            // detection then attaches the Confirm/Cancel buttons, and the tap
            // resolves through the same executor path as a typed /confirm.
            const plan = pcp.installPlanFor(tool);
            if (!plan) return null;
            pending.set(key, { kind: "install", tool, package: plan.package, argv: plan.argv, expiresAt: now() + 90 });
            deps.note("ok", `Telegram: offered to install ${plan.package}`);
            return plan.package;
          },
          requestServiceStart: (tool, argv) => {
            // Park a daemon-start offer bound to this peer; returns the service
            // name so pc.ts can format the offer text. Same buttoned/confirmed
            // path as an install.
            pending.set(key, { kind: "service", tool, argv, expiresAt: now() + 90 });
            deps.note("ok", `Telegram: offered to start the ${tool} daemon`);
            return tool;
          },
        },
        deps.note,
      ),
      pcStatus: () => {
        const on = cfg.telegramPcControlEnabled;
        const caps = new Set(cfg.telegramCapabilities);
        const rows = PC_CAPABILITIES.map((c) => `${caps.has(c) ? "✅" : "▫️"} ${c}`).join("  ");
        const doc = pcp.pcDoctor();
        const have = doc.tools.filter((t) => t.present).map((t) => t.name).join(", ");
        const missing = doc.tools.filter((t) => !t.present).map((t) => t.name).join(", ");
        const doctorLine =
          doc.platform === "linux"
            ? `session: ${doc.session} · have: ${have || "—"} · missing: ${missing || "—"}`
            : `platform: ${doc.platform} — tools are built in, nothing to probe`;
        // Typical install path for the detected package manager, for the
        // NOPASSWD hint below (scoped rules must name the real binary path).
        const pmPath: Record<string, string> = { pacman: "/usr/bin/pacman", "apt-get": "/usr/bin/apt-get", dnf: "/usr/bin/dnf", apk: "/sbin/apk" };
        const detectedPm = pcp.detectPm();
        const nopasswdHint =
          doc.platform === "linux" && missing && !pcp.canSudoNonInteractive()
            ? `some tools are missing — set up scoped NOPASSWD (e.g. \`echo '%wheel ALL=(ALL) NOPASSWD: ${detectedPm ? pmPath[detectedPm] ?? "/usr/bin/" + detectedPm : "/usr/bin/<your-pm>"}' | sudo tee /etc/sudoers.d/merrymen-pm\`) and I can install them on /confirm.`
            : "";
        return [
          `🖥️ <b>remote control</b> — master ${on ? "ON" : "OFF"}`,
          rows,
          on
            ? `enabled: ${[...caps].join(", ") || "(none — turn some on in the dashboard)"}`
            : `turn it on in the dashboard → settings → remote control.`,
          doctorLine,
          ...(nopasswdHint ? [nopasswdHint] : []),
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
  };

  /**
   * The in-memory map is now a CACHE over the sqlite log, not the source of
   * truth. First touch of a chat after a restart pulls the conversation back
   * from disk — before this, every restart silently wiped the thread and the
   * merryman greeted a mid-conversation owner like a stranger.
   */
  const historyFor = (chatId: number): { role: "user" | "assistant"; content: string }[] => {
    let h = history.get(chatId);
    if (!h) {
      h = recentChatTurns(chatId, HISTORY_TURNS * 2).map((t) => ({ role: t.role, content: t.content }));
      history.set(chatId, h);
      // Restore the last turn's recalled ids too, so a pronoun sent right after
      // a restart still lands on whatever the merryman was just talking about.
      const lastWithIds = [...recentChatTurns(chatId, 4)].reverse().find((t) => t.memoryIds?.length);
      if (lastWithIds?.memoryIds?.length) stickyIds.set(chatId, new Set(lastWithIds.memoryIds));
    }
    return h;
  };

  const pushHistory = (
    chatId: number,
    role: "user" | "assistant",
    content: string,
    memoryIds?: string[],
  ): void => {
    const trimmed = content.slice(0, 600);
    const h = historyFor(chatId);
    h.push({ role, content: trimmed });
    while (h.length > HISTORY_TURNS * 2) h.shift();
    history.set(chatId, h);
    appendChatTurn(chatId, { role, content: trimmed, memoryIds }); // write-through
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

    // Launch a detached agent task (from /agent OR natural language). Streams its
    // own progress; returns immediately so the poll (and /agent stop) keep flowing.
    // Every gate is checked here, so both entry points are equally locked down.
    const startAgent = async (task: string): Promise<void> => {
      if (!task.trim()) {
        await sendMessage({ token }, msg.chatId, "what would you like me to do? Describe the task, e.g. “clone github.com/x/y, install, build, and tell me what breaks”.");
        return;
      }
      if (!cfg.telegramPcControlEnabled || !cfg.telegramAgentEnabled) {
        await sendMessage({ token }, msg.chatId, "🤖 that's a multi-step task — turn on “remote control” + “agent mode” in the dashboard (settings) and I'll do it hands-on. For now I can answer questions and run single commands.");
        return;
      }
      const llm = resolveLlm(cfg);
      if (!llm) {
        await sendMessage({ token }, msg.chatId, "🤖 agent mode needs an AI provider — pick one in the dashboard (Settings → AI provider).");
        return;
      }
      if (agentRuns.has(msg.chatId)) {
        await sendMessage({ token }, msg.chatId, "⏳ I'm already on a task here — say “stop” (or /agent stop) first, or wait for it to finish.");
        return;
      }
      const st = stateRef.get();
      const soulBlock = soulPromptBlock(st.linkedAt, st.messageCount, now());
      // Live secret VALUES to strip from every tool output and block from
      // send_file — however the agent reads them, they never reach chat.
      const grant = loadGrantFile();
      const secrets = [
        cfg.telegramBotToken,
        cfg.anthropicApiKey,
        cfg.groqApiKey,
        cfg.llmApiKey,
        cfg.bundlerApiKey,
        cfg.rialtoApiKey,
        cfg.telegramTranscribeKey,
        cfg.virtualsApiKey,
        // The signed wallet grant custodies funds. Its 0x owner/session keys already
        // match the shape-redactor, but the base64 `serialized` session-account blob
        // does NOT — list all three explicitly so no tool output can exfiltrate them.
        grant?.serialized,
        grant?.demoOwnerPrivateKey,
        grant?.demoSessionPrivateKey,
      ].filter((s): s is string => typeof s === "string" && s.length >= 8);
      const stopFlag = { stopped: false };
      agentRuns.set(msg.chatId, stopFlag);
      await sendMessage({ token }, msg.chatId, "🏹 on it — I'll message progress here. Say “stop” to halt me.");
      void runAgentTask(task, {
        creds: llm,
        cfg: {
          capabilities: new Set(cfg.telegramCapabilities),
          filesRoot: cfg.telegramFilesRoot,
          shellAllowlist: cfg.telegramShellAllowlist,
          appAllowlist: cfg.telegramAppAllowlist,
          autoShell: cfg.telegramAgentAutoShell,
          maxSteps: cfg.telegramAgentMaxSteps,
          anthropicApiKey: cfg.anthropicApiKey,
          llmModel: cfg.llmModel,
          secrets,
        },
        opts: { token },
        chatId: msg.chatId,
        // Model text is HTML-escaped here — it must never inject parse-mode markup.
        send: async (text) => {
          await sendMessage({ token }, msg.chatId, esc(text));
        },
        note: deps.note,
        remember: (n) => rememberNote(n, now()),
        offerInstall: (tool) => {
          const plan = pcp.installPlanFor(tool);
          if (!plan) return null;
          const key = `${msg.chatId}:${msg.fromId}`;
          pending.set(key, { kind: "install", tool, package: plan.package, argv: plan.argv, expiresAt: now() + 90 });
          const caveat = pcp.installCaveat(tool);
          void sendMessage({ token }, msg.chatId, `📦 I can install <b>${esc(plan.package)}</b> for you. Tap ✅ to install (or /confirm) — or /cancel.${caveat ? `\n<code>${esc(caveat)}</code>` : ""}`, CONFIRM_MARKUP);
          deps.note("ok", `Telegram agent: offered to install ${plan.package}`);
          return plan.package;
        },
        soulBlock,
        stopFlag,
      }).finally(() => agentRuns.delete(msg.chatId));
    };

    // ── /agent — explicit slash entry (also handles /agent stop) ─────────────
    // Handled before the interpreter: the loop streams its own messages and must
    // not block the poll (or a stop could never land). Natural-language agent
    // tasks route through the SAME startAgent below, after interpretation.
    const agentMatch = msg.text?.match(/^\/agent(?:@\w+)?(?:\s+([\s\S]+))?$/i);
    if (agentMatch) {
      // Same sender-level rule as other state-changing commands: in a group,
      // only individually-allowlisted users may drive the PC.
      if (msg.chatId !== msg.fromId && !cfg.telegramAllowlist.includes(msg.fromId)) {
        await sendMessage({ token }, msg.chatId, "🚫 in a group, only individually-allowlisted users can run /agent.");
        return;
      }
      const arg = (agentMatch[1] ?? "").trim();
      if (/^stop$/i.test(arg)) {
        const running = agentRuns.get(msg.chatId);
        if (running) {
          running.stopped = true;
          await sendMessage({ token }, msg.chatId, "🛑 stopping after the current step…");
        } else {
          await sendMessage({ token }, msg.chatId, "nothing running.");
        }
        return;
      }
      if (!arg) {
        await sendMessage({ token }, msg.chatId, "what's the task? e.g. <code>/agent clone github.com/x/y, install deps, build, and tell me what breaks</code> — or just say it in plain English. <code>/agent stop</code> halts.");
        return;
      }
      await startAgent(arg);
      return;
    }

    // "stop" / "halt" while a task is running → stop it (natural-language stop).
    if (agentRuns.has(msg.chatId) && /^\s*(stop|halt|cancel|abort)\b/i.test(msg.text ?? "")) {
      if (msg.chatId === msg.fromId || cfg.telegramAllowlist.includes(msg.fromId)) {
        agentRuns.get(msg.chatId)!.stopped = true;
        await sendMessage({ token }, msg.chatId, "🛑 stopping after the current step…");
        return;
      }
    }

    const peer: Peer = { chatId: msg.chatId, fromId: msg.fromId, fromUsername: msg.fromUsername };
    const cmdDeps = buildCmdDeps(cfg, peer);
    const statusCtx = () => deps.buildStatusContext();

    // Only the OWNER shapes the soul — both relationship growth AND persistent
    // memory. In a GROUP, `allowed` is true for every member, so without this gate
    // an ordinary member could deepen the bond or (below) write/evict the owner's
    // remembered facts. Private chats have chatId === fromId, so this is a no-op there.
    const isOwnerMsg = msg.fromId === stateRef.get().ownerId || msg.chatId === stateRef.get().ownerId;
    if (isOwnerMsg) {
      stateRef.set({ ...stateRef.get(), messageCount: stateRef.get().messageCount + 1 });
    }

    // Slash command wins; else natural language (LLM) if a key is set; else nudge.
    let cmd = slash;
    // What the narrator recalled this turn — stored on the assistant's reply so
    // the thread survives a restart, not just a process lifetime.
    let turnMemoryIds: string[] | undefined;
    if (!cmd) {
      const llm = resolveLlm(cfg);
      if (llm) {
        const st = stateRef.get();
        // The classifier gets IDENTITY ONLY — it picks a value from a closed enum
        // and has no use for recalled detail. Keeping memory out of this call also
        // means a remembered line can never nudge routing toward a trade.
        const identity = identityBlock(st.linkedAt, st.messageCount, now());
        const liveState = readLlmState(statusCtx());
        // Tell the model about a parked confirm, if one is waiting for THIS user —
        // otherwise "yes do it" (typed instead of tapping the buttons) is answered
        // blind. The hint only steers the owner to the buttons / /confirm; natural
        // language still can never resolve the action itself (confirm/cancel are
        // not in the LLM enum).
        const pendingHere = pending.get(`${msg.chatId}:${msg.fromId}`);
        const pendingHint = pendingHere
          ? `PENDING CONFIRM: ${describePending(pendingHere)} is waiting for the owner's approval. If they now say yes/confirm/go ahead, tell them to tap ✅ Confirm (or send /confirm). If they say no/cancel, tell them to tap ✖ Cancel (or send /cancel). You cannot confirm it yourself — only the owner can.`
          : "";
        const routeCtx = {
          state: [`SOUL:\n${identity}\n\n${liveState}`, pendingHint].filter(Boolean).join("\n\n"),
          history: historyFor(msg.chatId),
        };
        const r = await interpretWithLlm(msg.text, routeCtx, llm);
        cmd = r.cmd;
        // The get-to-know-you side-channel: the model proposes a fact, the
        // sanitizer disposes (drops addresses/keys/markup, dedupes, caps). Only the
        // OWNER may write it — else a group member could poison/evict owner memory.
        if (r.remember && isOwnerMsg) rememberOwnerFact(r.remember, now());
        // A conversational turn gets a warm, free-form voice — the classifier's
        // terse `reply` is for routing, not for talking. Text out triggers nothing.
        //
        // ONLY the narrator gets recalled memory, retrieved against what they
        // actually just said, so a fact from months back is reachable when it's
        // the one being asked about. Written AFTER the remember side-channel, so
        // something learned this turn can be recalled in the very same reply.
        if (cmd.kind === "chat") {
          const recalled = recallForPrompt(msg.text, now(), stickyIds.get(msg.chatId));
          // Read BEFORE this turn is written, so it's the gap since they last
          // spoke rather than zero.
          const gap = describeGap(lastChatTurnAt(msg.chatId), now());
          const chatCtx = {
            state: [
              `SOUL:\n${identity}`,
              gap ? `TIME SINCE THEIR LAST MESSAGE: ${gap}` : "",
              recalled.block,
              pendingHint,
              "",
              liveState,
            ]
              .filter(Boolean)
              .join("\n"),
            history: historyFor(msg.chatId),
          };
          const fluent = await narrateChat(msg.text, chatCtx, llm);
          if (fluent) cmd = { kind: "chat", reply: fluent };
          // Carry what was surfaced into the next turn so a pronoun follow-up
          // ("is it done?") keeps the thread instead of losing it to zero word
          // overlap. Persisted on the turn below, so it survives a restart too.
          stickyIds.set(msg.chatId, new Set(recalled.ids));
          turnMemoryIds = recalled.ids;
        }
      } else {
        cmd = { kind: "chat", reply: "pick an AI provider and paste its key in the dashboard (Settings → AI provider) to chat in plain English — Groq, Google and Cerebras are free, or run Ollama locally. For now, try /help." };
      }
      pushHistory(msg.chatId, "user", msg.text);
    }

    // Sender-level authz for state-changing commands. In a GROUP the chatId is a
    // negative group id (≠ the sender's id), so allowlisting the group would grant
    // EVERY member trade/transfer/PC/kill power. Require the SENDER's own id to be
    // allowlisted for anything state-changing; reads stay chat-level. Private chats
    // (chatId === fromId) are unaffected. `confirm`/`cancel` only arrive via
    // parseSlash now (the LLM can't emit them), and are gated here too.
    const stateChanging =
      CONTROL_KINDS.has(cmd.kind) ||
      PC_KINDS.has(cmd.kind) ||
      cmd.kind === "transfer" ||
      cmd.kind === "confirm" ||
      cmd.kind === "agent";
    if (stateChanging && msg.chatId !== msg.fromId && !cfg.telegramAllowlist.includes(msg.fromId)) {
      await sendMessage(
        { token },
        msg.chatId,
        "🚫 in a group, only individually-allowlisted users can run that. The owner can add your Telegram user id in the dashboard.",
      );
      return;
    }

    // Natural-language multi-step task → the agent loop (same gates as /agent).
    if (cmd.kind === "agent") {
      pushHistory(msg.chatId, "assistant", "starting an agent task");
      await startAgent(cmd.task);
      return;
    }

    // A failed command must still answer — silence reads as a dead bot.
    let reply: string;
    const pendingKey = `${msg.chatId}:${msg.fromId}`;
    // Snapshot what was parked before this command. A fresh park can come from
    // a plain command (/type) OR from resolving one (a /confirm that runs typeText
    // and parks an install offer) — in both cases the user must see buttons, so
    // "parked" means "the pending slot now holds a DIFFERENT action than before",
    // not merely "something appeared".
    const beforePending = pending.get(pendingKey);
    try {
      reply = await executeCommand(cmd, cmdDeps);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      deps.note("warn", `Telegram: ${cmd.kind} failed — ${m}`);
      reply = `🚫 that ${cmd.kind} failed: ${esc(m.slice(0, 200))}`;
    }
    const afterPending = pending.get(pendingKey);
    const parked = !!afterPending && afterPending !== beforePending;
    if (!slash) pushHistory(msg.chatId, "assistant", reply.replace(/<[^>]+>/g, ""), turnMemoryIds);
    await sendMessage({ token }, msg.chatId, reply, parked ? CONFIRM_MARKUP : undefined);
  };

  /**
   * Resolve an inline-button tap (Confirm/Cancel) into the parked action it
   * belongs to. The pending slot is keyed chat:from, so only the SAME user who
   * parked the action can confirm or cancel it — a group member can't tap
   * another member's confirm button. Runs through the exact same executor
   * confirm/cancel branch as typing /confirm (same re-vetting, same gates).
   * The parked message is edited in place to the outcome (buttons removed) and
   * the tap is acknowledged with a toast.
   */
  const handleCallback = async (cb: TgCallback, cfg: ResolvedConfig): Promise<void> => {
    const token = cfg.telegramBotToken!;
    const { chatId, fromId } = cb;
    const key = `${chatId}:${fromId}`;
    const action: Command | null =
      cb.data === "confirm" ? { kind: "confirm" }
      : cb.data === "cancel" ? { kind: "cancel" }
      : null;

    // No parked action (or a different user's — same chat but the slot is bound
    // to the parker, so a stranger tapping finds nothing): drop the buttons and
    // say so, but still acknowledge the tap so the button stops spinning.
    if (!action || !pending.has(key)) {
      await answerCallbackQuery({ token }, cb.queryId, {});
      await editMessageText({ token }, chatId, cb.messageId, "nothing pending to confirm — the ask has expired or already resolved.");
      return;
    }

    let reply: string;
    const beforePending = pending.get(key);
    try {
      reply = await executeCommand(action, buildCmdDeps(cfg, { chatId, fromId }));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      deps.note("warn", `Telegram: ${cb.data} callback failed — ${m}`);
      reply = `🚫 that ${cb.data} failed: ${esc(m.slice(0, 200))}`;
    }
    await answerCallbackQuery({ token }, cb.queryId, {
      text: cb.data === "confirm" ? "Confirmed ✓" : "Cancelled",
    });
    // Resolving a confirm can itself park a NEW action (a confirm that runs
    // typeText and lands on an install offer). When it does, re-attach the
    // Confirm/Cancel buttons to the edited message so the fresh ask stays
    // tappable — otherwise the offer appears buttonless and forces a typed
    // /confirm. Resolution that clears the slot gets plain text (default).
    const afterPending = pending.get(key);
    const parkedFresh = !!afterPending && afterPending !== beforePending;
    const edited = await editMessageText({ token }, chatId, cb.messageId, reply, parkedFresh ? CONFIRM_MARKUP : undefined);
    if (!edited.ok) await sendMessage({ token }, chatId, reply, parkedFresh ? CONFIRM_MARKUP : undefined);
  };

  const pollOnce = async (): Promise<void> => {
    const cfg = deps.getCfg();
    if (!cfg.telegramEnabled || !cfg.telegramBotToken) return; // idle until enabled
    stateRef.set(ensureLinkCode(stateRef.get(), cfg.telegramBotToken));

    const { messages, callbacks, nextOffset, reason } = await getUpdates({ token: cfg.telegramBotToken }, stateRef.get().offset);
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
    for (const cb of callbacks) {
      try {
        await handleCallback(cb, cfg);
      } catch (e) {
        deps.note("warn", `Telegram: error handling callback — ${e instanceof Error ? e.message : String(e)}`);
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
