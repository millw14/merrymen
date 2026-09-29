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
 *   button presses included (bar the owner's Telegram-group Stay, Leave and
 *   Forget, below), gets holdText: that trading is held, and why in a short
 *   class. Never the restore's own numbers.
 * - A backlog is handled by the child's rules (service.ts pollOnce): a late
 *   code is never compared or counted, a stranger gets one refusal, and only
 *   /kill runs. The same poll timings, backoff and bot binding, from
 *   poll-rules.ts and state.ts, so telegram.json is left exactly as the child
 *   expects to find it when trading resumes.
 * - Telegram groups (docs/tg-groups.md) are not answered at all: no line, no
 *   refusal, no link, no /kill, and no word that trading is held, which is
 *   the owner's business and not the room's. Three things are done, none of
 *   them said in the room. A live link code a room has seen is replaced, and
 *   the owner told in their DM, as the child does. A /forgetme, or the
 *   owner's /forget, is written to the forget file (tg-groups/forget-file.ts),
 *   which the orchestrator carries to the stored memory and the child applies
 *   when it opens it: every /forgetme wipes, held or not. And the bot's own
 *   membership, migrations, its removal and the owner's Stay, Leave and
 *   Forget presses are kept for the child to apply when trading resumes
 *   (held-groups.ts), since nothing here can.
 *
 * WHAT IT MUST NOT TOUCH. No store, no database, no ledger, no model, no paper
 * book and no group memory (restore-hold.test.ts pins the imports): the two
 * group files it writes are notes for whoever holds that memory, not the
 * memory. The orchestrator is retrying the restore against this home's
 * merrymen.db while this runs, and a held tenant must never look like a
 * running one to anything that trades or mirrors. It has no DATABASE_URL
 * anyway (childEnv).
 */

import {
  answerCallbackQuery,
  esc,
  getMe,
  getUpdates,
  sendMessage as sendTelegramMessage,
  type TgCallback,
  type TgMemberUpdate,
  type TgMessage,
  type TgServiceMessage,
} from "./api";
import { GROUP_PRESS_RE, keepHeldGroupUpdate, type HeldGroupEntry } from "./held-groups";
import { appendForget, cleanForget } from "./tg-groups/forget-file";
import { bindToken, botIdOf, ensureLinkCode, recordPoll, retireLegacyCode, rotateLinkCode, type StateRef } from "./state";
import { linkReply, tallyFailedLink, tryLink, type LinkFails } from "./link";
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
  groupLineShowsCode,
  isGroupMessage,
  makeChatTally,
  onboardingText,
  pollFailure,
  redactChat,
  refusalText,
  slashHead,
  span,
  telegramLog,
} from "./poll-rules";
import { patchSettingsFile, type ResolvedConfig } from "../settings";
import { homePaths, merrymenHome } from "../home";
import { loadGrantFile } from "../grant";
import { hostedKillFromChat } from "../kill-request";
import { UNCLASSIFIED_BLOCK, holdText, readRestoreBlocked, type RestoreBlock } from "../restore-block";

/**
 * To the owner, in their DM, when a room has seen their live link code and it
 * was replaced (inGroup). The child's group handler says the same
 * (tg-groups/handler.ts codeLeaked); this process has no group store to name
 * the room from.
 */
const CODE_SHOWN_TEXT =
  "your link code got posted in a group, so i swapped it for a new one. link codes only work here in DMs — the new one is in Settings → Telegram.";

/**
 * The toast for the owner's Stay, Leave or Forget pressed while trading is
 * held (groupPress): kept for when trading resumes, or, when it could not be
 * kept, what to do instead. Never "expired": the question still stands.
 */
const PRESS_KEPT_TEXT = "Got it — I'll do that as soon as trading resumes.";
const PRESS_NOT_KEPT_TEXT = "I can't do that while trading is held — press it again once I'm back.";

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

export function startHoldTelegram(deps: HoldDeps): { stop: () => void } {
  let stopped = false;
  const stateRef = deps.stateRef;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const note = deps.note ?? telegramLog;
  const blocker = deps.blocker ?? (() => readRestoreBlocked(merrymenHome()));
  const kill = deps.kill ?? (() => hostedKillFromChat(merrymenHome(), homePaths.grant(), loadGrantFile(), now()));
  // Counted and logged as the child does (poll-rules.ts makeChatTally), and
  // every reply through the same check for one Telegram would not take. On
  // `note`, which here is the fleet's log and nothing else, as the child's
  // tally is.
  const tally = makeChatTally(note, now);
  const sendMessage: typeof sendTelegramMessage = async (opts, chatId, text, extra) => {
    const r = await sendTelegramMessage(opts, chatId, text, extra);
    if (!r.ok) tally.sendFailed(chatId, r.reason);
    return r;
  };
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
  /** This bot's username, from getMe, for "/forgetme@name" (forgetAsked). */
  let self: { token: string; username: string } | null = null;
  /** A failure to keep a group update for the child is logged once, until one is kept again. */
  let keepWarned = false;
  /** A /kill waiting for /confirm, keyed `${chatId}:${fromId}` like the child's, and until when. */
  const parkedKills = new Map<string, number>();

  const allowedIn = (cfg: HoldConfig, chatId: number, fromId: number): boolean =>
    cfg.telegramAllowlist.includes(chatId) || cfg.telegramAllowlist.includes(fromId);

  /** A code from a chat not on the allowlist: link.ts decides, exactly as in the child. */
  const link = (msg: TgMessage, code: string, cfg: HoldConfig): string => {
    const outcome = tryLink(
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
        onLinked: (who) => note("ok", `Telegram: linked chat ${redactChat(who.chatId)} while trading is held`),
      },
      msg,
      code,
    );
    tallyFailedLink(tally, linkFails, msg.chatId, outcome);
    const r = linkReply(outcome, now());
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
      tally.refused(msg.chatId);
      await sendMessage({ token }, msg.chatId, onboarding ? onboardingText(msg.chatId) : refusalText(msg.chatId));
      return;
    }
    const answer = head ? killFlow(msg, head.cmd, cfg) : null;
    await sendMessage({ token }, msg.chatId, answer ?? holdReply());
  };

  /**
   * A LINE IN A TELEGRAM GROUP. Nothing is said in the room and nothing runs:
   * no refusal, no link (a group is never allowlisted by a code, and one typed
   * there is never compared or counted), no /kill, and no hold text, which
   * would tell the room why the owner's agent is not trading. Late or live
   * alike.
   *
   * THE LIVE CODE IS STILL REPLACED when the line shows it, as the child does
   * (service.ts routeGroup): everyone in the room has seen a bearer
   * credential, and while trading is held a /link is exactly what this
   * process answers. The owner is told in their DM why the code on their
   * Settings page changed.
   *
   * AND A /forgetme IS WRITTEN DOWN (forgetAsked), late or live, since it
   * only ever takes something away.
   */
  const inGroup = async (msg: TgMessage, cfg: HoldConfig): Promise<void> => {
    const state = stateRef.get();
    if (state.linkCode && groupLineShowsCode(msg.text, state.linkCode)) {
      stateRef.set(rotateLinkCode(state));
      note("warn", `Telegram: a link code was typed in group ${redactChat(msg.chatId)} while trading is held; it was replaced`);
      const owner = state.ownerId;
      if (owner !== null) await sendMessage({ token: cfg.telegramBotToken! }, owner, CODE_SHOWN_TEXT);
    }
    await forgetAsked(msg, cfg);
  };

  /** This bot's username: asked of getMe once per token, and unknown while it does not answer. */
  const selfName = async (token: string): Promise<string | null> => {
    if (self?.token === token) return self.username;
    const r = await getMe({ token });
    if (!r.bot) return null;
    self = { token, username: r.bot.username };
    return self.username;
  };

  /** A forget request, into this home's forget file. Logged, without ids, only when it could not be. */
  const recordForget = (chatId: number, userId: number | "*"): boolean => {
    const op = cleanForget({ chatId, userId, atMs: now() * 1000 });
    if (!op) return false;
    try {
      appendForget(merrymenHome(), op);
      return true;
    } catch (e) {
      note("warn", `Telegram: a group forget request could not be saved while trading is held (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      return false;
    }
  };

  /**
   * A /forgetme, or the owner's /forget, typed in a group while trading is
   * held. EVERY /forgetme WIPES (docs/tg-groups.md Memory), and a hold can
   * last days, so the request is written down for whoever holds the memory
   * (tg-groups/forget-file.ts): the orchestrator applies it to the stored copy
   * on its mirror clock, and the child that ends the hold to the memory it
   * opens. Nothing is said in the room, as nothing is while held.
   *
   * By the child's rules (service.ts handleGroupCommand): ours ("/forgetme" or
   * "/forgetme@thisbot", never another bot's), from a person (not another bot,
   * and not someone speaking through a chat, who could be anyone), and
   * /forget only from the owner.
   */
  const forgetAsked = async (msg: TgMessage, cfg: HoldConfig): Promise<void> => {
    const head = slashHead(msg.text);
    if (head?.cmd !== "forgetme" && head?.cmd !== "forget") return;
    if (msg.senderChatId !== undefined || msg.fromIsBot === true) return;
    const addressedTo = /@(\w+)$/.exec(msg.text.trim().slice(1).split(/\s+/)[0] ?? "")?.[1];
    if (addressedTo !== undefined) {
      const me = await selfName(cfg.telegramBotToken!);
      if (me === null || me.toLowerCase() !== addressedTo.toLowerCase()) return;
    }
    const owner = stateRef.get().ownerId;
    const userId = head.cmd === "forgetme" ? msg.fromId : owner !== null && msg.fromId === owner ? "*" : null;
    if (userId !== null) recordForget(msg.chatId, userId);
  };

  /** Kept for the child that ends the hold (held-groups.ts). */
  const keep = (entry: HeldGroupEntry): boolean => {
    const ok = keepHeldGroupUpdate(merrymenHome(), entry);
    if (ok) keepWarned = false;
    else if (!keepWarned) {
      keepWarned = true;
      note("warn", "Telegram: a group update could not be kept for when trading resumes");
    }
    return ok;
  };

  /**
   * The bot's own membership in a group, a migration, or the bot's own
   * removal. Nothing here can record them, so they are kept for the child,
   * which records them as late updates when trading resumes: a stranger's add
   * is then asked about with its own 24 hours, a removal starts the 30-day
   * pruning, and a migrated group keeps its memory. Joins are not kept: a
   * late join gets no welcome.
   */
  const keepMember = (u: TgMemberUpdate, token: string): void => {
    const bot = botIdOf(token);
    if (bot === null || (u.chatType !== "group" && u.chatType !== "supergroup")) return;
    keep({ bot, kind: "member", member: u });
  };
  const keepService = (s: TgServiceMessage, token: string): void => {
    const bot = botIdOf(token);
    if (bot === null || (s.chatType !== "group" && s.chatType !== "supergroup")) return;
    const removed = s.leftChatMember !== undefined && String(s.leftChatMember.id) === bot;
    if (!removed && s.migrateToChatId === undefined && s.migrateFromChatId === undefined) return;
    keep({ bot, kind: "service", service: { ...s, newChatMembers: [], leftChatMember: removed ? s.leftChatMember : undefined } });
  };

  /**
   * The owner's Stay, Leave or Forget (tg-groups/handler.ts), pressed in their
   * DM while trading is held. Its question lives in the group store, not in
   * the process that asked it, so it still stands: the child counts such a
   * press whenever it arrives. Nothing here can carry it out, so it is kept
   * for the child that ends the hold, which does it then, before anything
   * newer and before its first sweep could leave the group. A Forget is also
   * written down at once, so the stored memory is wiped within a mirror pass.
   *
   * NEVER "EXPIRED". That was a lie about a button that still works, and an
   * owner who took it at its word did not press Stay again: a stranger's
   * group ran out its 24 hours while held and was left, and blocked, the
   * moment trading resumed. The toast says what will happen, or, when it
   * could not be kept, to press it again once trading resumes.
   */
  const groupPress = async (cb: TgCallback, cfg: HoldConfig): Promise<void> => {
    const token = cfg.telegramBotToken!;
    const owner = stateRef.get().ownerId;
    // The child's rule (handler.ts onCallback): the owner, in their own DM.
    if (owner === null || cb.fromId !== owner || cb.chatId !== owner) {
      await answerCallbackQuery({ token }, cb.id, "Only my owner can do that.");
      return;
    }
    const m = GROUP_PRESS_RE.exec(cb.data);
    const bot = botIdOf(token);
    if (!m || bot === null) {
      await answerCallbackQuery({ token }, cb.id, "That button has expired.");
      return;
    }
    const forgot = m[1] === "forget" && recordForget(Number(m[2]), "*");
    const kept = keep({ bot, kind: "press", press: { chatId: cb.chatId, fromId: cb.fromId, messageId: cb.messageId, data: cb.data, date: cb.date } });
    await answerCallbackQuery({ token }, cb.id, kept || forgot ? PRESS_KEPT_TEXT : PRESS_NOT_KEPT_TEXT);
  };

  /**
   * A button press. Nothing a button asked about can happen here: whatever
   * was parked behind it died with the child. Answered, so it stops spinning,
   * and an owner is told why.
   */
  const handlePress = async (cb: TgCallback, cfg: HoldConfig): Promise<void> => {
    const token = cfg.telegramBotToken!;
    if (!allowedIn(cfg, cb.chatId, cb.fromId)) {
      tally.refused(cb.chatId);
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
    if (action === "refuse") tally.refused(msg.chatId);
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
    if (kind === "refused") tally.refused(msg.chatId);
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
      if (me.bot) self = { token, username: me.bot.username };
      note("ok", me.bot ? `Telegram: bot changed to @${me.bot.username}` : "Telegram: bot changed");
      return;
    }
    if (bound.told) note("ok", "Telegram: bot token renewed, so the link code was re-minted");
  };

  const pollFailed = (r: { reason?: string; errorCode?: number; retryAfter?: number }, token: string): number => {
    const t = now();
    outage = outage ?? { since: t, streak: 0, told: new Set() };
    outage.streak += 1;
    deafSince ??= t;
    const { kind, waitMs, line, err } = pollFailure(r, outage.streak);
    notePoll(token, err);
    const conflictToldRecently = kind === "conflict" && conflictToldAt !== null && t - conflictToldAt < CONFLICT_RETELL_SEC;
    if (!outage.told.has(kind) && !conflictToldRecently) {
      outage.told.add(kind);
      if (kind === "conflict") conflictToldAt = t;
      note("warn", line);
    }
    return waitMs;
  };

  const pollWorked = (token: string): void => {
    notePoll(token, null);
    if (outage && outage.told.size > 0) note("ok", `Telegram: receiving updates again after ${span(now() - outage.since)}`);
    outage = null;
  };

  /**
   * How the poll went, into telegram.json, as the child records it (state.ts
   * recordPoll). The orchestrator publishes it for held tenants too, so the
   * dashboard can tell a held bot that answers from one nobody hears.
   */
  const notePoll = (token: string, err: string | null): void => {
    const held = stateRef.get();
    const next = recordPoll(held, botIdOf(token), now(), err);
    if (next !== held) stateRef.set(next);
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
    if (polled.reason) return pollFailed(polled, token);
    pollWorked(token);
    if (deafSince !== null && askedAt - deafSince >= REARM_AFTER_SEC) armedAt = null;
    deafSince = null;
    if (armedAt === null) armedAt = askedAt;
    const armed = armedAt;
    const boundAt = stateRef.get().boundAt;
    const early = (date: number) => boundAt !== null && date > 0 && date < boundAt;
    const stale = (date: number) => !early(date) && date > 0 && date < armed;
    const told = new Set<string>();
    const expire = (cb: TgCallback): Promise<void> => answerCallbackQuery({ token }, cb.id, "That button has expired.").then(() => {});
    // Groups first, whatever the date: nothing in a group goes down a DM's
    // path (inGroup). my_chat_member updates and service messages are kept
    // for the child, whatever their date too, as the child records a late
    // one (keepMember).
    const updates = [
      ...polled.messages.map((m) => ({
        at: m.updateId,
        run: (c: HoldConfig) =>
          isGroupMessage(m) ? inGroup(m, c) : early(m.date) ? holdEarly(m, c) : stale(m.date) ? holdStale(m, c, told) : handle(m, c),
      })),
      ...polled.callbacks.map((cb) => ({
        at: cb.updateId,
        // A press in a group gets the plain expiry too: the hold text in a
        // toast would tell whoever pressed why the agent is not trading. So
        // does one on a question from before this bot was switched to this
        // agent, as in the child. The owner's Stay, Leave or Forget counts
        // whenever it arrives (groupPress); any other press from before this
        // process listened answers a question that died with the child.
        run: (c: HoldConfig) =>
          isGroupMessage({ chatId: cb.chatId }) || early(cb.date)
            ? expire(cb)
            : cb.data.startsWith("tgg:")
              ? groupPress(cb, c)
              : stale(cb.date)
                ? expire(cb)
                : handlePress(cb, c),
      })),
      ...polled.members.map((u) => ({ at: u.updateId, run: async () => keepMember(u, token) })),
      ...polled.service.map((s) => ({ at: s.updateId, run: async () => keepService(s, token) })),
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
    const token0 = cfg0.telegramBotToken;
    void getMe({ token: token0 }).then((r) => {
      if (r.bot) {
        self ??= { token: token0, username: r.bot.username };
        note("ok", `Telegram: answering as @${r.bot.username} while trading is held`);
      } else note("warn", `Telegram: token check failed — ${r.reason}`);
    });
  }
  loop();
  return {
    stop: () => {
      stopped = true;
    },
  };
}
