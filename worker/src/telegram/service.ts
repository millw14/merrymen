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
import { answerCallbackQuery, editMessageText, esc, getFileUrl, getMe, getUpdates, sendMessage, setMyCommands, publicBotCommands, type TgCallback, type TgInlineKeyboard, type TgMessage } from "./api";
import { runAgentTask } from "./agent";
import { executeCommand, type CommandDeps, type PendingAction } from "./executor";
import { resolveLlm } from "../llm";
import { CONTROL_KINDS, PC_KINDS, interpretWithLlm, narrateChat, narrateWhy, parseSlash, stripThinkingBlock, type Command } from "./interpreter";
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
  readWallet,
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
  narratorIdentityBlock,
  recallForPrompt,
} from "../soul";
import { appendChatTurn, clearChatTurns, lastChatTurnAt, recentChatTurns } from "../store";
import { describeGap } from "../memory/retrieve";
import { describeLlmFailure, isLlmProviderFailure } from "../llm-failure";

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
  /** Liquidity depth for a ticker, read from the chain. Lives in index.ts because
   * this file deliberately owns no chain client. */
  readDepth: (symbol: string) => Promise<string>;
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

/** Escape a name so it can sit inside a RegExp. */
function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`);
}

/**
 * The opener this deployment's agent used to recite, matched by ITS name.
 *
 * Rebuilt per call rather than cached: `getName()` follows the owner's
 * settings, so a rename must not leave the scrub hunting the old identity.
 */
function soulHeaderRe(): RegExp {
  return new RegExp(`^\\s*${escapeRe(getName())}\\s+here\\s*[\u2014-]\\s*born\\b[^.!?\\n]*[.!?\\n]\\s*`, "i");
}

/** Start the poll loop. Returns a stop() handle. */
export function startTelegram(deps: TelegramServiceDeps): { stop: () => void } {
  let stopped = false;
  /** Fingerprint (token + allowlist) whose "/" command menus are live — avoids
   * re-setting every poll and re-pushes when /link grows the allowlist. */
  let commandsRegisteredKey = "";
  /** One warn per config fingerprint until a clean menu push (no per-poll spam). */
  let menuWarned = false;
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
  /**
   * THERE IS NO BARE-AMOUNT TRADE CONTEXT HERE, AND THAT IS DELIBERATE.
   *
   * The change this file came from carried one: a chat-keyed map that let a
   * message consisting of nothing but "5" become a live buy. It was primed by
   * REGEX-MATCHING THE BOT'S OWN OUTBOUND PROSE, took its ticker from the first
   * one-to-six-letter word of an earlier message, resolved the side with
   * `/sell/.test() ? "sell" : "buy"` — so "should I sell before I buy more?"
   * primes a sell — and then called `deps.trade` with no confirmation step at
   * all, while the sibling `transfer` case parks and waits for `/confirm`.
   * It had no expiry and was keyed by chat rather than by sender.
   *
   * The problem it was solving is real and is solved below without any of that:
   * a bare number must not reach the classifier, because a reasoning model
   * spends its whole budget dumping chain-of-thought at it. A deterministic
   * nudge costs no tokens and states no trade.
   *
   * If a ticker+amount follow-up is wanted, it belongs in its own change: park
   * it through `deps.setPending` with `CONFIRM_TTL_SEC`, key it by
   * `msg.fromId`, re-display side, symbol and amount on the confirm, and carry
   * them from the `Command` the classifier actually emitted — never re-derive
   * a ticker or a direction from prose.
   */
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
      {
        ...state,
        ownerId: state.ownerId ?? peer.fromId,
        linkedAt: state.linkedAt ?? now(),
        // AND IN THE ONE FILE NOBODY OVERWRITES. patchSettingsFile above
        // wrote the chat into the child's settings.json, which the hosted
        // orchestrator replaces wholesale from the tenant store every 15
        // seconds — so the link above, on its own, is undone before the
        // owner can send a second command, and the code that bought it has
        // already been consumed by this very rotation. This file is
        // child-owned; the parent reads it and unions these ids back into
        // the stored allowlist, which is what makes the link durable.
        linkedChats: state.linkedChats.includes(peer.chatId)
          ? state.linkedChats
          : [...state.linkedChats, peer.chatId],
      },
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
        depth: (symbol: string) => deps.readDepth(symbol),
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
            // Refused outright when the "install" capability is off — the
            // confirm-time re-vet stays as the backstop for revocations
            // parked earlier.
            if (!cfg.telegramCapabilities.includes("install")) return null;
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
            if (!cfg.telegramCapabilities.includes("install")) return null;
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
        // NOPASSWD hint below (such rules must name the real binary path).
        // The hint names the one user account this process runs as — never
        // %wheel (a passwordless package manager is effectively passwordless
        // root, so the rule must cover exactly merrymen's account) — and it
        // is prose, not a copy-pasteable tee command.
        const pmPath: Record<string, string> = { pacman: "/usr/bin/pacman", "apt-get": "/usr/bin/apt-get", dnf: "/usr/bin/dnf", apk: "/sbin/apk" };
        const detectedPm = pcp.detectPm();
        const pmBin = detectedPm ? pmPath[detectedPm] ?? "/usr/bin/" + detectedPm : "/usr/bin/<your-pm>";
        const me = pcp.runAsUser();
        const nopasswdHint =
          doc.platform === "linux" && missing && !pcp.canSudoNonInteractive()
            ? `some tools are missing (${missing}) — install them yourself (e.g. \`sudo ${detectedPm ?? "<your-pm>"} install ${missing}\`), or give the user I run as (${me}) passwordless sudo for just the package-manager binary (a file under /etc/sudoers.d/ with \`${me} ALL=(ALL) NOPASSWD: ${pmBin}\`) and I can install them on /confirm.`
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
  const historyFor = async (chatId: number): Promise<{ role: "user" | "assistant"; content: string }[]> => {
    let h = history.get(chatId);
    if (!h) {
      h = (await recentChatTurns(chatId, HISTORY_TURNS * 2)).map((t) => {
        let c = t.role === "assistant" ? stripThinkingBlock(t.content) : t.content;
        // SCRUB THE OLD SOUL HEADER OUT OF STORED HISTORY.
        //
        // Before identity moved into the system prompt, every reply opened by
        // reciting it — "<name> here — born 2026-…". Those turns are on disk,
        // and a few-shot prompt built from them teaches the new model to recite
        // it again, so the fix would undo itself one conversation at a time.
        //
        // BUILT FROM THE AGENT'S OWN NAME, not a literal. It was hardcoded to
        // one tenant's, so on every other deployment it scrubbed nothing while
        // claiming to.
        if (t.role === "assistant") c = c.replace(soulHeaderRe(), "").trim();
        // NO `|| t.content` TAIL. A turn that was ENTIRELY the old header
        // scrubs to nothing, and restoring it whole is the one case the scrub
        // exists for. Empty turns are dropped just below.
        return { role: t.role, content: c };
      }).filter((t) => t.content.length > 0);
      history.set(chatId, h);
      // Restore the last turn's recalled ids too, so a pronoun sent right after
      // a restart still lands on whatever the merryman was just talking about.
      const lastWithIds = [...(await recentChatTurns(chatId, 4))].reverse().find((t) => t.memoryIds?.length);
      if (lastWithIds?.memoryIds?.length) stickyIds.set(chatId, new Set(lastWithIds.memoryIds));
    }
    return h;
  };

  const pushHistory = async (
    chatId: number,
    role: "user" | "assistant",
    content: string,
    memoryIds?: string[],
  ): Promise<void> => {
    const trimmed = content.slice(0, 600);
    const h = await historyFor(chatId);
    h.push({ role, content: trimmed });
    while (h.length > HISTORY_TURNS * 2) h.shift();
    history.set(chatId, h);
    await appendChatTurn(chatId, { role, content: trimmed, memoryIds }); // write-through
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
          if (!cfg.telegramCapabilities.includes("install")) return null;
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

    const statusCtx = () => deps.buildStatusContext();
    const cmdDeps: CommandDeps = {
      controlEnabled: cfg.telegramControlEnabled,
      maxActionUsdg: cfg.telegramMaxActionUsdg,
      grantPerTradeUsdg: deps.grantPerTradeUsdg(),
      transferEnabled: cfg.telegramTransferEnabled,
      grantHasTransfer: deps.grantHasTransfer(),
      reads: {
        status: () => readStatus(statusCtx()),
        positions: () => readPositions(statusCtx().agentId),
        depth: (symbol: string) => deps.readDepth(symbol),
        pnl: () => readPnl(statusCtx().agentId),
        trades: () => readTrades(statusCtx().agentId),
        report: () => readReport(statusCtx()),
        brag: () => readBrag(statusCtx()),
        // NEVER WIRED, SO NEVER CALLED. `readWallet` has existed and been
        // correct the whole time; executor.ts:147 reads
        // `deps.reads.wallet ? … : WALLET_TEXT`, and with this key absent every
        // one of /wallet, /fund, /grant, /recover, /restore and /reconnect fell
        // through to the static signpost — which tells the reader to open
        // http://localhost:3100 "on the machine running merrymen". On the
        // hosted fleet there is no such machine, so the instruction cannot be
        // followed at all, and "fund your agent" is the commonest thing anyone
        // is ever told to do.
        wallet: () => readWallet(statusCtx().agentId),
        why: async () => {
          const ev = readWhyEvidence(statusCtx().agentId);
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
      link: (code) => linkDep(cfg, { chatId: msg.chatId, fromId: msg.fromId }, code),
      trade: deps.submitTrade,
      transfer: async (to, usdg) => {
        deps.note("warn", `Telegram: transfer ${usdg} USDG → ${to} confirmed by chat ${msg.chatId}`);
        return deps.submitTransfer(to, usdg);
      },
      getPending: () => pending.get(`${msg.chatId}:${msg.fromId}`) ?? null,
      setPending: (p) => pending.set(`${msg.chatId}:${msg.fromId}`, p),
      clearPending: () => pending.delete(`${msg.chatId}:${msg.fromId}`),
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
        void clearChatTurns(msg.chatId); // fire-and-forget; the in-memory wipe below is immediate
        history.delete(msg.chatId);
        stickyIds.delete(msg.chatId);
      },
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
          requestInstall: (tool) => {
            // Same peer-bound park as the buildCmdDeps path above, keyed on
            // this message's chat+user so one member can't confirm another's
            // install in a group. Same "install"-capability gate.
            if (!cfg.telegramCapabilities.includes("install")) return null;
            const plan = pcp.installPlanFor(tool);
            if (!plan) return null;
            pending.set(`${msg.chatId}:${msg.fromId}`, { kind: "install", tool, package: plan.package, argv: plan.argv, expiresAt: now() + 90 });
            deps.note("ok", `Telegram: offered to install ${plan.package}`);
            return plan.package;
          },
          requestServiceStart: (tool, argv) => {
            if (!cfg.telegramCapabilities.includes("install")) return null;
            pending.set(`${msg.chatId}:${msg.fromId}`, { kind: "service", tool, argv, expiresAt: now() + 90 });
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
      // A BARE NUMBER NEVER REACHES THE CLASSIFIER — and never becomes a trade.
      //
      // "5" carries no ticker, no side and no verb, so there is nothing for a
      // classifier to classify; what a reasoning model does with it is spend
      // the whole completion budget on chain-of-thought and return empty
      // content. So it is answered here, deterministically, for no tokens.
      //
      // The answer is a nudge and nothing else. See the note on the absent
      // ask-amount context above for what this deliberately does not do.
      const bareMatch = msg.text.trim().match(/^\s*(\d+(?:\.\d+)?)\s*(usdg|usd)?\s*$/i);
      if (bareMatch) {
        const n = Number(bareMatch[1]);
        if (Number.isFinite(n) && n > 0) {
          cmd = { kind: "chat", reply: `to trade, tell me a ticker and a USDG amount, e.g. 'buy 10 of QQQ' — you sent just "${msg.text.trim()}"` };
        }
      }
    }
    if (!cmd) {
      const llm = resolveLlm(cfg);
      if (llm) {
        const st = stateRef.get();
        // The classifier gets IDENTITY ONLY — it picks a value from a closed enum
        // and has no use for recalled detail. Keeping memory out of this call also
        // means a remembered line can never nudge routing toward a trade.
        const identity = identityBlock(st.linkedAt, st.messageCount, now());
        const liveState = readLlmState(statusCtx());
        const routeCtx = { state: `SOUL:\n${identity}\n\n${liveState}`, history: await historyFor(msg.chatId) };
        const r = await interpretWithLlm(msg.text, routeCtx, llm);
        cmd = r.cmd;
        // Strip any thinking dump that slipped through llmText (defense in depth)
        if (cmd.kind === "chat" && typeof cmd.reply === "string") {
          const stripped = stripThinkingBlock(cmd.reply);
          if (stripped !== cmd.reply) cmd = { kind: "chat", reply: stripped || cmd.reply };
        }
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
          const gap = describeGap(await lastChatTurnAt(msg.chatId), now());
          // Hermes-style tiering: stable identity (name+stage+tone, no numbers) in system,
          // volatile (gap+recalled+liveState) in user STATE — so model follows role, doesn't narrate it.
          const narratorIdentity = narratorIdentityBlock(st.linkedAt, st.messageCount, now());
          const chatCtx = {
            state: [
              gap ? `TIME SINCE THEIR LAST MESSAGE: ${gap}` : "",
              recalled.block,
              "",
              liveState,
            ]
              .filter(Boolean)
              .join("\n"),
            history: await historyFor(msg.chatId),
            narratorIdentity,
          } as unknown as { state: string; history: { role: "user" | "assistant"; content: string }[] };
          const fluent = await narrateChat(msg.text, chatCtx as never, llm);
          let strippedFluent = fluent ? stripThinkingBlock(fluent) : "";
          if (strippedFluent) cmd = { kind: "chat", reply: strippedFluent };
          else if (fluent && !strippedFluent) {
            // Whole reply was thinking — fall back to classifier's (already stripped) reply
          }
          // Carry what was surfaced into the next turn so a pronoun follow-up
          // ("is it done?") keeps the thread instead of losing it to zero word
          // overlap. Persisted on the turn below, so it survives a restart too.
          stickyIds.set(msg.chatId, new Set(recalled.ids));
          turnMemoryIds = recalled.ids;
        }
      } else {
        cmd = { kind: "chat", reply: "pick an AI provider and paste its key in the dashboard (Settings → AI provider) to chat in plain English — Groq, Google and Cerebras are free, or run Ollama locally. For now, try /help." };
      }
      // UNCONDITIONAL. This was guarded by a "same as the last user message?"
      // check, to avoid a double-push from a bare-amount branch that also wrote
      // history. That branch is gone, and the guard it needed silently dropped
      // a legitimately repeated message — an owner who says "ok" twice loses the
      // second one from the thread, which is exactly the kind of quiet edit to
      // somebody's own words this file should not make.
      await pushHistory(msg.chatId, "user", msg.text);
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
      await pushHistory(msg.chatId, "assistant", "starting an agent task");
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
      // A command that failed INSIDE a model call (/why narration, say) would
      // otherwise echo "groq 401 — invalid_api_key: Invalid API Key" at the
      // owner. Same rule as the interpreter: say which kind of no it was, and
      // what they can do. Anything that is not a provider line keeps its words.
      reply = isLlmProviderFailure(m)
        ? `🚫 that ${cmd.kind} failed — ${esc(describeLlmFailure(m).text)}`
        : `🚫 that ${cmd.kind} failed: ${esc(m.slice(0, 200))}`;
    }
    if (!slash) await pushHistory(msg.chatId, "assistant", stripThinkingBlock(reply.replace(/<[^>]+>/g, "")), turnMemoryIds);
    // THE LAST-RESORT STRIP FAILS CLOSED.
    //
    // It was `strippedReply || reply` — so a reply that was ENTIRELY
    // chain-of-thought stripped to "" and the raw thinking was sent instead,
    // which is the one case the strip exists for. A model that answered only in
    // its reasoning channel has not answered; say that.
    const strippedReply = stripThinkingBlock(reply);
    await sendMessage(
      { token },
      msg.chatId,
      strippedReply ||
        "that came back as reasoning with no answer in it — say it again, or use a slash command like /status.",
    );
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

    // Push the "/" command menus whenever the token or allowlist changed
    // (enable-after-start, /link growing the allowlist). Two scopes: a trimmed
    // safe menu for every private chat — strangers get signposts, not an
    // advertisement of the remote-control surface — and the FULL menu for each
    // allowlisted chat, so owners keep discoverability (/run, /type, /agent…).
    // The fingerprint is stored only after a clean pass, so one transient
    // network failure at startup retries on the next poll instead of silently
    // dropping the menu until a restart. Best-effort — never breaks the poll.
    if (cfg.telegramBotToken) {
      const key = `${cfg.telegramBotToken}:${[...cfg.telegramAllowlist].sort((a, b) => a - b).join(",")}`;
      if (key !== commandsRegisteredKey) {
        const token = cfg.telegramBotToken;
        let firstFail: string | null = null;
        const pub = await setMyCommands({ token }, publicBotCommands, { type: "all_private_chats" });
        if (!pub.ok) firstFail = firstFail ?? pub.reason ?? "public menu failed";
        for (const chatId of cfg.telegramAllowlist) {
          const r = await setMyCommands({ token }, undefined, { type: "chat", chat_id: chatId });
          if (!r.ok) firstFail = firstFail ?? `chat ${chatId} — ${r.reason ?? "full menu failed"}`;
        }
        if (!firstFail) {
          commandsRegisteredKey = key;
          menuWarned = false;
        } else if (!menuWarned) {
          menuWarned = true; // retried on every poll until it lands — but logged once
          deps.note("warn", `Telegram: command menu — ${firstFail}`);
        }
      }
    }

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
