/**
 * THE OWNER'S BOT WHILE TRADING IS HELD.
 *
 * A paper tenant whose practice book cannot be restored after a redeploy is
 * not started: its cash would silently begin again from nothing. That rule is
 * right and stays. But the trading child was the only process that polled the
 * owner's bot, so "not started" also meant a bot that answered nothing, for
 * days. The owner in the incident this came from kept sending /link into the
 * silence, lost the link to a second login, and was locked out of re-linking
 * when a child finally read the backlog. Nobody told them anything.
 *
 * So the orchestrator runs this instead of the child (orchestrator.ts
 * spawnHolder), in the same home, with the same env, under the same lease. It
 * answers and does nothing else:
 *
 * - A chat not on the allowlist is treated exactly as the child treats it:
 *   /link <code> and /start <code> go through link.ts with the same lockout,
 *   a bare /start or /help is told how to link, anything else is refused.
 *   Linking works here, so an owner is never left unable to link.
 * - An allowlisted chat can /kill, through the same confirm and the same
 *   hosted kill path as the child (kill-request.ts hostedKillFromChat), so
 *   the owner can always revoke. Everything else, /status and /help and
 *   button presses included, gets holdText: that trading is held, and why in
 *   a short class. Never the restore's own numbers.
 * - A backlog is handled by the child's rules (service.ts pollOnce): a late
 *   code is never compared or counted, a stranger gets one refusal, and only
 *   /kill runs. The same poll timings, backoff and bot binding, from
 *   poll-rules.ts and state.ts, so telegram.json is left exactly as the child
 *   expects to find it when trading resumes.
 *
 * WHAT IT MUST NOT TOUCH. No store, no database, no ledger, no model, no paper
 * book (restore-hold.test.ts pins the imports). The orchestrator is retrying
 * the restore against this home's merrymen.db while this runs, and a held
 * tenant must never look like a running one to anything that trades or
 * mirrors. It has no DATABASE_URL anyway (childEnv).
 */

import { answerCallbackQuery, esc, getMe, getUpdates, sendMessage, type TgCallback, type TgMessage } from "./api";
import { bindToken, ensureLinkCode, retireLegacyCode, type StateRef } from "./state";
import { linkReply, tryLink, type LinkFails } from "./link";
import { CONFIRM_TTL_SEC, killDoneText, killPromptText, type KillResult } from "./kill-confirm";
import {
  BACKOFF_MAX_SEC,
  CONFLICT_RETELL_SEC,
  EARLY_LINK_TEXT,
  IDLE_GAP_MS,
  POLL_GAP_MS,
  REARM_AFTER_SEC,
  STALE_LINK_TEXT,
  WAKE_SLICE_MS,
  onboardingText,
  pollFailure,
  refusalText,
  slashHead,
  span,
} from "./poll-rules";
import { patchSettingsFile, type ResolvedConfig } from "../settings";
import { homePaths, merrymenHome } from "../home";
import { loadGrantFile } from "../grant";
import { hostedKillFromChat } from "../kill-request";
import { UNCLASSIFIED_BLOCK, holdText, readRestoreBlocked, type RestoreBlock } from "../restore-block";

/** What the hold loop reads of the config. The real one is settings.ts resolveConfig. */
export type HoldConfig = Pick<
  ResolvedConfig,
  "telegramEnabled" | "telegramBotToken" | "telegramAllowlist" | "telegramControlEnabled"
>;

export interface HoldDeps {
  /** Fresh on every read, as in the child: a /link or a dashboard change applies to the next message. */
  getCfg: () => HoldConfig;
  /** telegram.json, shared with the child that will take over. */
  stateRef: StateRef;
  /** Why trading is held. Read per reply; restore-blocked.json in this home by default. */
  blocker?: () => RestoreBlock | null;
  /** The hosted kill. hostedKillFromChat over this home by default. */
  kill?: () => KillResult;
  /** Log sink. The child writes these to its event feed; this process has none, so stdout. */
  note?: (level: "ok" | "warn", message: string) => void;
  /** Unix seconds. Injectable for tests. */
  now?: () => number;
}


/** Only the last four digits of a chat id go to the fleet's log. */
const redact = (chatId: number): string => `…${String(Math.abs(chatId)).slice(-4)}`;

export function startHoldTelegram(deps: HoldDeps): { stop: () => void } {
  let stopped = false;
  const stateRef = deps.stateRef;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const note = deps.note ?? ((level, message) => console.log(`[telegram${level === "warn" ? " warn" : ""}] ${message}`));
  const blocker = deps.blocker ?? (() => readRestoreBlocked(merrymenHome()));
  const kill = deps.kill ?? (() => hostedKillFromChat(merrymenHome(), homePaths.grant(), loadGrantFile(), now()));
  // The hold's own record unreadable: the class that names no cause, and no
  // practice reset offered, since nothing then says it would be honoured.
  const holdReply = (): string => {
    const block = blocker();
    return esc(holdText(block?.class ?? UNCLASSIFIED_BLOCK, block?.resettable === true));
  };

  // The same loop state as the child's (service.ts startTelegram says what
  // each is for): the outage and its backoff, the bot this loop last bound,
  // and the backlog boundary.
  let outage: { since: number; streak: number; told: Set<string> } | null = null;
  let conflictToldAt: number | null = null;
  let crashStreak = 0;
  let boundToken: string | null = null;
  let armedAt: number | null = null;
  let deafSince: number | null = null;
  let offReads = 0;
  const earlyTold = new Set<string>();
  const linkFails: LinkFails = new Map();
  /** A /kill waiting for /confirm, keyed `${chatId}:${fromId}` like the child's, and until when. */
  const parkedKills = new Map<string, number>();

  const allowedIn = (cfg: HoldConfig, chatId: number, fromId: number): boolean =>
    cfg.telegramAllowlist.includes(chatId) || cfg.telegramAllowlist.includes(fromId);

  /** A code from a chat not on the allowlist: link.ts decides, exactly as in the child. */
  const link = (msg: TgMessage, code: string, cfg: HoldConfig): string => {
    const r = linkReply(
      tryLink(
        {
          stateRef,
          fails: linkFails,
          now,
          // The child's own settings.json, as the child's link writes it; the
          // orchestrator promotes linkedChats into the stored allowlist on its
          // mirror clock, for held tenants too.
          allow: (chatId) => {
            const next = new Set(cfg.telegramAllowlist);
            next.add(chatId);
            patchSettingsFile({ telegramAllowlist: [...next] });
          },
          onLinked: (who) => note("ok", `Telegram: linked chat ${redact(who.chatId)} while trading is held`),
        },
        msg,
        code,
      ),
      now(),
    );
    // Linked, and told at once why nothing trades: /status would only say it again.
    return r.ok
      ? `🏹 you're linked — you now command this merryman.\n\n${holdReply()}`
      : `couldn't link: ${r.reason ?? "bad or expired code"}`;
  };

  /**
   * /kill, /confirm and /cancel from an allowlisted chat, gated the way the
   * child gates them (service.ts handle, executor.ts): the sender's own id in
   * a group, the control switch when asked and again when confirmed, and a
   * CONFIRM_TTL_SEC window. Null when this is not one of them, or there is
   * nothing parked for /confirm or /cancel to answer.
   */
  const killFlow = (msg: TgMessage, cmd: string, cfg: HoldConfig): string | null => {
    const key = `${msg.chatId}:${msg.fromId}`;
    const confirm = cmd === "confirm" || cmd === "yes";
    const cancel = cmd === "cancel" || cmd === "no";
    if (cmd !== "kill" && !confirm && !cancel) return null;
    const parked = parkedKills.get(key);
    if ((confirm || cancel) && parked === undefined) return null;
    if (cancel) {
      parkedKills.delete(key);
      return "🚫 cancelled — nothing done.";
    }
    // In a group the chat id is the group's, so allowlisting the group would
    // hand every member the kill switch. As in the child, the sender's own id
    // must be on the list.
    if (msg.chatId !== msg.fromId && !cfg.telegramAllowlist.includes(msg.fromId)) {
      return "🚫 in a group, only individually-allowlisted users can run that. The owner can add your Telegram user id in the dashboard.";
    }
    if (cmd === "kill") {
      if (!cfg.telegramControlEnabled) {
        return "🔒 control commands are turned off. Turn on “control” for Telegram in the dashboard to pause, switch strategy, trade, or kill.";
      }
      parkedKills.set(key, now() + CONFIRM_TTL_SEC);
      return killPromptText(true, CONFIRM_TTL_SEC);
    }
    parkedKills.delete(key);
    if (now() > parked!) return "⌛ that confirmation expired — ask again.";
    if (!cfg.telegramControlEnabled) return "🔒 control was turned off before you confirmed — the grant is untouched.";
    let r: KillResult;
    try {
      r = kill();
    } catch (e) {
      r = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    note("warn", r.ok ? "Telegram: kill switch confirmed while trading is held" : `Telegram: kill switch refused — ${r.reason ?? "no grant"}`);
    return killDoneText(r);
  };

  /** A live message. */
  const handle = async (msg: TgMessage, cfg: HoldConfig): Promise<void> => {
    const token = cfg.telegramBotToken!;
    const head = slashHead(msg.text);
    if (!allowedIn(cfg, msg.chatId, msg.fromId)) {
      // A deep link (t.me/<bot>?start=<code>) is /start <code>: the same code
      // as /link, so the same path, compared and counted.
      const code = head?.cmd === "link" ? head.arg : head?.cmd === "start" && head.arg ? head.arg : null;
      if (code !== null) {
        await sendMessage({ token }, msg.chatId, link(msg, code, cfg));
        return;
      }
      const onboarding = head?.cmd === "help" || (head?.cmd === "start" && !head.arg);
      await sendMessage({ token }, msg.chatId, onboarding ? onboardingText(msg.chatId) : refusalText(msg.chatId));
      return;
    }
    const answer = head ? killFlow(msg, head.cmd, cfg) : null;
    await sendMessage({ token }, msg.chatId, answer ?? holdReply());
  };

  /**
   * A button press. Nothing a button asked about can happen here: whatever
   * was parked behind it died with the child. Answered, so it stops spinning,
   * and an owner is told why.
   */
  const handlePress = async (cb: TgCallback, cfg: HoldConfig): Promise<void> => {
    const token = cfg.telegramBotToken!;
    if (!allowedIn(cfg, cb.chatId, cb.fromId)) {
      await answerCallbackQuery({ token }, cb.id, "Not authorized.");
      return;
    }
    await answerCallbackQuery({ token }, cb.id, "I'm not trading right now — nothing was done.");
    await sendMessage({ token }, cb.chatId, holdReply());
  };

  /**
   * A message that waited out a silence: the child's backlog rule (service.ts
   * holdStale). A code is never compared or counted, a stranger is refused
   * once, and an owner is told once, per batch. Only /kill runs, since it can
   * only reduce risk, and it still only asks for a /confirm sent live.
   */
  const holdStale = async (msg: TgMessage, cfg: HoldConfig, told: Set<string>): Promise<void> => {
    const head = slashHead(msg.text);
    const allowed = allowedIn(cfg, msg.chatId, msg.fromId);
    const lateCode = head?.cmd === "link" || (head?.cmd === "start" && head.arg !== "");
    const action = lateCode ? "late-code" : !allowed ? "refuse" : head?.cmd === "kill" ? "run" : "hold";
    if (action === "run") {
      await handle(msg, cfg);
      return;
    }
    const key = `${msg.chatId}:${action}`;
    if (told.has(key)) return;
    told.add(key);
    const reply = action === "late-code" ? STALE_LINK_TEXT : action === "refuse" ? refusalText(msg.chatId) : holdReply();
    await sendMessage({ token: cfg.telegramBotToken! }, msg.chatId, reply);
  };

  /**
   * A message sent to this bot before this agent was switched onto it: the
   * child's rule (service.ts holdEarly). Nothing runs, not even /kill, and
   * each chat gets one answer of each kind per change of bot.
   */
  const holdEarly = async (msg: TgMessage, cfg: HoldConfig): Promise<void> => {
    const head = slashHead(msg.text);
    const lateCode = head?.cmd === "link" || (head?.cmd === "start" && head.arg !== "");
    const kind = lateCode ? "link" : allowedIn(cfg, msg.chatId, msg.fromId) ? "held" : "refused";
    const key = `${msg.chatId}:${kind}`;
    if (earlyTold.has(key)) return;
    earlyTold.add(key);
    const reply = kind === "link" ? EARLY_LINK_TEXT : kind === "held" ? holdReply() : refusalText(msg.chatId);
    await sendMessage({ token: cfg.telegramBotToken! }, msg.chatId, reply);
  };

  /** The child's bindBot: the state change is state.ts bindToken, shared. */
  const bindBot = async (token: string): Promise<void> => {
    const firstUse = boundToken !== token;
    if (boundToken !== null && firstUse && outage) outage.streak = 0;
    boundToken = token;
    if (firstUse) {
      const held = stateRef.get();
      const retired = retireLegacyCode(held, token);
      if (retired !== held) {
        stateRef.set(retired);
        linkFails.clear();
        note("ok", "Telegram: the link code was one derived from the bot token, so it was re-minted");
      }
    }
    const bound = bindToken(stateRef.get(), token, now());
    if (bound.change === "invalid" || bound.change === "same") return;
    stateRef.set(bound.state);
    if (bound.change === "adopted") return;
    linkFails.clear();
    if (bound.change === "switched") {
      earlyTold.clear();
      parkedKills.clear();
      armedAt = null;
      const me = await getMe({ token });
      note("ok", me.bot ? `Telegram: bot changed to @${me.bot.username}` : "Telegram: bot changed");
      return;
    }
    if (bound.told) note("ok", "Telegram: bot token renewed, so the link code was re-minted");
  };

  const pollFailed = (r: { reason?: string; errorCode?: number; retryAfter?: number }): number => {
    const t = now();
    outage = outage ?? { since: t, streak: 0, told: new Set() };
    outage.streak += 1;
    deafSince ??= t;
    const { kind, waitMs, line } = pollFailure(r, outage.streak);
    const conflictToldRecently = kind === "conflict" && conflictToldAt !== null && t - conflictToldAt < CONFLICT_RETELL_SEC;
    if (!outage.told.has(kind) && !conflictToldRecently) {
      outage.told.add(kind);
      if (kind === "conflict") conflictToldAt = t;
      note("warn", line);
    }
    return waitMs;
  };

  const pollWorked = (): void => {
    if (outage && outage.told.size > 0) note("ok", `Telegram: receiving updates again after ${span(now() - outage.since)}`);
    outage = null;
  };

  const freshCfg = (): HoldConfig | undefined => {
    try {
      return deps.getCfg();
    } catch {
      return undefined;
    }
  };

  /**
   * One poll, by the child's rules (service.ts pollOnce says why each is what
   * it is): the backlog boundary armed at the first good poll and re-armed
   * after a silence, each update saved as seen before it runs, the config
   * read per update and the batch pinned to its token.
   */
  const pollOnce = async (): Promise<number> => {
    const cfg = deps.getCfg();
    if (!cfg.telegramEnabled || !cfg.telegramBotToken) {
      offReads += 1;
      if (offReads >= 2) {
        outage = null;
        armedAt = null;
      }
      return IDLE_GAP_MS;
    }
    offReads = 0;
    const token = cfg.telegramBotToken;
    await bindBot(token);
    const coded = ensureLinkCode(stateRef.get());
    if (coded !== stateRef.get()) stateRef.set(coded);

    const askedAt = now();
    const polled = await getUpdates({ token }, stateRef.get().offset);
    if (polled.reason) return pollFailed(polled);
    pollWorked();
    if (deafSince !== null && askedAt - deafSince >= REARM_AFTER_SEC) armedAt = null;
    deafSince = null;
    if (armedAt === null) armedAt = askedAt;
    const armed = armedAt;
    const boundAt = stateRef.get().boundAt;
    const early = (date: number) => boundAt !== null && date > 0 && date < boundAt;
    const stale = (date: number) => !early(date) && date > 0 && date < armed;
    const told = new Set<string>();
    const updates = [
      ...polled.messages.map((m) => ({
        at: m.updateId,
        run: (c: HoldConfig) => (early(m.date) ? holdEarly(m, c) : stale(m.date) ? holdStale(m, c, told) : handle(m, c)),
      })),
      ...polled.callbacks.map((cb) => ({
        at: cb.updateId,
        run: (c: HoldConfig) =>
          early(cb.date) || stale(cb.date)
            ? answerCallbackQuery({ token }, cb.id, "That button has expired.").then(() => {})
            : handlePress(cb, c),
      })),
    ].sort((a, b) => a.at - b.at);
    let whole = true;
    for (const u of updates) {
      const live = freshCfg();
      if (!live?.telegramEnabled || live.telegramBotToken !== token) {
        whole = false;
        break;
      }
      // At most once, as in the child: saved before it runs.
      if (u.at + 1 > stateRef.get().offset) stateRef.set({ ...stateRef.get(), offset: u.at + 1 });
      try {
        await u.run(live);
      } catch (e) {
        note("warn", `Telegram: error handling message — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (whole && polled.nextOffset > stateRef.get().offset) {
      stateRef.set({ ...stateRef.get(), offset: polled.nextOffset });
    }
    return POLL_GAP_MS;
  };

  const currentToken = (): string | undefined => freshCfg()?.telegramBotToken;

  const waitThenPoll = (ms: number, token: string | undefined): void => {
    const slice = Math.min(ms, WAKE_SLICE_MS);
    setTimeout(() => {
      if (stopped) return;
      const left = ms - slice;
      if (left > 0 && currentToken() === token) waitThenPoll(left, token);
      else loop();
    }, slice);
  };

  const loop = (): void => {
    if (stopped) return;
    const token = currentToken();
    pollOnce()
      .then((ms) => {
        crashStreak = 0;
        return ms;
      })
      .catch((e) => {
        note("warn", `Telegram: poll loop — ${e instanceof Error ? e.message : String(e)}`);
        crashStreak += 1;
        deafSince ??= now();
        return Math.min(BACKOFF_MAX_SEC, 2 ** crashStreak) * 1000;
      })
      .then((ms) => waitThenPoll(ms, token));
  };

  const cfg0 = freshCfg();
  if (cfg0?.telegramEnabled && cfg0.telegramBotToken) {
    void getMe({ token: cfg0.telegramBotToken }).then((r) => {
      if (r.bot) note("ok", `Telegram: answering as @${r.bot.username} while trading is held`);
      else note("warn", `Telegram: token check failed — ${r.reason}`);
    });
  }
  loop();
  return {
    stop: () => {
      stopped = true;
    },
  };
}
