/**
 * Telegram groups — when it speaks. The contract is docs/tg-groups.md, "When
 * it speaks" and "Banter and roasts".
 *
 * `decide` is PURE: the message, the chat's durable state and the readings
 * from detect.ts go in; one decision comes out. It reads the room and never
 * writes it — the caller records what was said (lastOwnAtMs, ambient,
 * answers, roasts, greetedDay, shushedUntilMs) after the line actually goes
 * out, so a send that fails costs no budget. The clock and the dice are
 * parameters (`nowMs`, `rand`), so every branch is testable exactly.
 *
 * WHY A PERSON'S PACE AND NOT A SCRIPT'S. A bot that answers everything is
 * spam, and one that joins every lively chat is a lurker who never shuts up.
 * So it answers when called, joins in rarely (a few percent of eligible
 * lines, fewer after each line it has already said today), stays out of
 * two-person exchanges and dead chats, and would rather react than talk.
 *
 * THE MODEL NEVER DECIDES WHETHER TO SPEAK. It only writes the words for a
 * decision made here (and may still PASS an ambient candidate). Nothing here
 * is a trading input: the coin flow is separate, and a line carrying a CA is
 * left to it.
 */

import { extractCas, insultAtBot, isDistress, lineMood, type ReactionMood, type SmallTalk } from "./detect";
import type { Chattiness, TgLine, TgPerson, TgRoom } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * Per-chattiness pacing: the base odds of an ambient line per eligible line,
 * the least time between ambient lines, and the most ambient lines per UTC
 * day (reactions count half).
 */
export const CHATTINESS: Record<Chattiness, { odds: number; cooldownMs: number; perDay: number }> = {
  quiet: { odds: 0.02, cooldownMs: 90 * MIN, perDay: 3 },
  normal: { odds: 0.05, cooldownMs: 35 * MIN, perDay: 8 },
  chatty: { odds: 0.1, cooldownMs: 15 * MIN, perDay: 16 },
};

/**
 * The reactions it may set: the contract's subset of Telegram's fixed
 * ReactionTypeEmoji list. EXACT CODE POINTS MATTER: Telegram refuses "❤️"
 * (with the U+FE0F variation selector) where it accepts "❤" (U+2764 alone),
 * so the heart is written as an escape.
 */
export const REACTIONS: readonly string[] = [
  "👍", "🔥", "🤣", "😁", "🤔", "👀", "💯", "🫡", "🤝", "😭", "🗿", "🤡",
  "😎", "🥱", "🙈", "🤷", "❤", "😴", "👏", "🎉", "🙏", "🤯", "😱",
];

/** The kinds of line REACTION_FOR has reactions for. */
export type ReactionKey = ReactionMood | "gm" | "gn" | "shush";

/** At least one emoji, so a pick from the list always has something to pick. */
type Emojis = readonly [string, ...string[]];

/**
 * Which reactions suit which kind of line. Every emoji is from REACTIONS.
 * The mood keys are detect.ts `ReactionMood`s, plus "gm" / "gn" for a
 * greeting it does not answer in words and "shush" for the 🤐-like answer to
 * being told to be quiet (🤐 itself is not a reaction Telegram allows).
 *
 * Keyed by ReactionKey rather than any string, so every mood detect.ts can
 * return is known to have a list: a mood added there without a list here is a
 * type error, not a reaction that silently never happens.
 */
export const REACTION_FOR: Record<ReactionKey, Emojis> = {
  funny: ["🤣", "😁", "😭"],
  agree: ["👍", "💯", "🤝"],
  hype: ["🔥", "🎉", "🤯", "😎"],
  sad: ["😭", "🫡", "🙏"],
  thinking: ["🤔", "🤷"],
  look: ["👀"],
  respect: ["🫡", "👏", "💯"],
  bored: ["🥱", "😴", "🗿"],
  clown: ["🤡"],
  love: ["❤", "🤝"],
  gm: ["🫡", "😎", "❤", "👍"],
  gn: ["😴", "🫡", "❤"],
  shush: ["🙈"],
};

export interface PaceInput {
  room: TgRoom;
  line: TgLine;
  addressed: "mention" | "reply" | "name" | null;
  isOwner: boolean;
  /**
   * The line is from another bot, and so is skipped before anything else.
   * Callers MUST pass `msg.fromIsBot === true && msg.senderChatId === undefined`,
   * never `msg.fromIsBot` alone: an anonymous admin posts as GroupAnonymousBot
   * (is_bot true) with a sender_chat, and a linked-channel post carries one
   * too. Those are people speaking through a chat, and the contract makes them
   * ordinary non-owner lines, not bots.
   */
  fromIsBot: boolean;
  chattiness: Chattiness;
  nowMs: number;
  rand: () => number;
  hasModel: boolean;
  signals: {
    shush: boolean;
    greeting: "gm" | "gn" | null;
    insult: "none" | "tease" | "insult" | "hateful";
    distress: boolean;
    botQuestion: boolean;
    privateAsk: boolean;
    injection: boolean;
    tradeTalk: boolean;
    questionToRoom: boolean;
    knownCoin: boolean;
    /**
     * detect.ts addressedSmallTalk for an addressed line (a hail, thanks, a gm
     * or gn and nothing more), read with the bot's names; null or absent
     * otherwise. Answered with small talk, not as a question.
     */
    smallTalk?: SmallTalk | null;
  };
}

export type PaceDecision =
  | { act: "skip"; why: string }
  | { act: "answer"; mood: "normal" | "bot-question" | "private-ask" | "injection" }
  | { act: "roast"; owner: boolean }
  | { act: "kind" }
  | { act: "shush" }
  | { act: "greet"; word: "gm" | "gn" }
  | { act: "smalltalk"; what: SmallTalk }
  | { act: "react"; emoji: string }
  | { act: "ambient"; topic: "coin" | "trade" | "question" | "banter" };

// ─── The numbers ───────────────────────────────────────────────────────────

/** Flood: after this many addressed answers to one person inside the window, it stops answering them. */
const FLOOD_ANSWERS = 3;
const FLOOD_WINDOW_MS = 2 * MIN;
/** At most this many roast exchanges with one person per window; then it disengages. */
const ROAST_CAP = 2;
const ROAST_WINDOW_MS = 30 * MIN;
/** One kind line per person per hour; after that, silence rather than repeating itself. */
const KIND_WINDOW_MS = HOUR;
/** A chat is live when a human spoke within this. */
const LIVE_WINDOW_MS = 10 * MIN;
/** "Right after its own line": its line is the newest in the chat and at most this old. */
const AFTER_OWN_MS = 5 * MIN;
/** The last this-many lines from exactly two humans is a two-person exchange it stays out of. */
const PAIR_LINES = 6;
/** Odds of answering a gm/gn in words, once per person per UTC day. */
const GREET_ODDS = 0.35;
/** A question to the room nobody answered for this long raises the odds. */
const QUESTION_WAIT_MS = MIN;
/** Each ambient line already said today multiplies the odds by this. */
const AMBIENT_DECAY = 0.7;
/** Odds multipliers: a coin it holds or looked at; trading talk or a question left hanging. */
const COIN_BOOST = 3;
const TOPIC_BOOST = 2;
/** A reaction costs half an ambient line against the per-day cap. */
const REACTION_COST = 0.5;
/** Chance of a 🥱 (rather than silence) once the roast cap is reached. */
const YAWN_ODDS = 0.5;
/**
 * Reaction odds as a multiple of the chattiness odds, by mood. Moods not here
 * never get an unprompted reaction: 🤡 on someone else's line is an insult,
 * and 🤔 / 🥱 on a stranger's line reads as a comment it has not earned.
 */
const REACT_BOOST: Partial<Record<ReactionMood, number>> = { funny: 2, hype: 2, love: 1, respect: 1, agree: 1, look: 1, sad: 1 };
/** Reacting to a gm/gn it does not answer in words. */
const GREET_REACT_BOOST = 2;

// ─── Small helpers ─────────────────────────────────────────────────────────

/** UTC day key, YYYY-MM-DD (the same keys store.ts writes). Out-of-range clocks read as the epoch. */
function utcDay(ms: number): string {
  return new Date(Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : 0).toISOString().slice(0, 10);
}

/** One roll of the dice in [0, 1]. A broken rand (NaN) reads as 1: nothing optional happens. */
function roll(rand: () => number): number {
  const r = rand();
  return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 1;
}

/** One emoji from a list, by the dice. */
function pick(list: Emojis, rand: () => number): string {
  const r = rand();
  const x = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
  // x is in [0, 1] and the list is never empty, so the index is always in
  // [0, length - 1]; the fallback to the first emoji only satisfies the type.
  return list[Math.min(list.length - 1, Math.floor(x * list.length))] ?? list[0];
}

const skip = (why: string): PaceDecision => ({ act: "skip", why });
const answer = (mood: "normal" | "bot-question" | "private-ask" | "injection"): PaceDecision => ({ act: "answer", mood });
const react = (emoji: string): PaceDecision => ({ act: "react", emoji });

/** A counter window still open at `now`: {count, sinceMs} with the window starting at sinceMs. */
function inWindow(w: { count: number; sinceMs: number } | undefined, now: number, windowMs: number, cap: number): boolean {
  return !!w && Number.isFinite(w.count) && w.count >= cap && now - w.sinceMs < windowMs;
}

/**
 * True when this person already got the kind line this hour: an earlier line
 * of theirs in the last hour read as distress, and one of its own lines came
 * after it that answered them (a reply to one of those lines, or a line with
 * no reply target, which is how an unthreaded answer is stored).
 */
function kindRecently(earlier: readonly TgLine[], line: TgLine, now: number): boolean {
  const theirs = earlier.filter(
    (l) => !l.own && l.fromId === line.fromId && l.atMs <= now && now - l.atMs <= KIND_WINDOW_MS && isDistress(l.text),
  );
  if (theirs.length === 0) return false;
  const ids = new Set(theirs.map((l) => l.messageId));
  const since = Math.min(...theirs.map((l) => l.atMs));
  return earlier.some(
    (l) => l.own === true && l.atMs >= since && now - l.atMs <= KIND_WINDOW_MS && (l.replyTo === undefined || ids.has(l.replyTo)),
  );
}

/** Its own line is the newest in the chat (before this one) and at most AFTER_OWN_MS old. */
function rightAfterOwn(room: TgRoom, earlier: readonly TgLine[], now: number): boolean {
  let lastOwn = typeof room.lastOwnAtMs === "number" ? room.lastOwnAtMs : -Infinity;
  let lastHuman = -Infinity;
  for (const l of earlier) {
    if (l.own) lastOwn = Math.max(lastOwn, l.atMs);
    else lastHuman = Math.max(lastHuman, l.atMs);
  }
  return Number.isFinite(lastOwn) && now - lastOwn <= AFTER_OWN_MS && lastOwn >= lastHuman;
}

/** When it last said anything in this chat (a line, not a reaction). */
function lastSpokeAt(room: TgRoom, earlier: readonly TgLine[]): number {
  let t = Math.max(
    typeof room.lastOwnAtMs === "number" ? room.lastOwnAtMs : -Infinity,
    typeof room.lastAmbientAtMs === "number" ? room.lastAmbientAtMs : -Infinity,
  );
  for (const l of earlier) if (l.own) t = Math.max(t, l.atMs);
  return t;
}

/** The last PAIR_LINES lines (this one included) are all human, from exactly two people. */
function pairExchange(earlier: readonly TgLine[], line: TgLine): boolean {
  const recent = [...earlier, line].sort((a, b) => a.atMs - b.atMs).slice(-PAIR_LINES);
  if (recent.length < PAIR_LINES || recent.some((l) => l.own)) return false;
  return new Set(recent.map((l) => l.fromId)).size === 2;
}

/** Someone else (or it) spoke after this line: the question is not hanging. */
function answeredSince(earlier: readonly TgLine[], line: TgLine): boolean {
  return earlier.some((l) => l.atMs > line.atMs && (l.own === true || l.fromId !== line.fromId));
}

// ─── The decision ──────────────────────────────────────────────────────────

/**
 * What to do with one incoming line. In order:
 *
 * 1. A bot's line (not an anonymous admin or a channel post: see
 *    PaceInput.fromIsBot), its own line, or a chat that is not approved → skip.
 * 2. Distress → the kind line, always (addressed or not, shushed or not),
 *    once per person per hour; after that, silence.
 * 3. A shush, addressed or right after its own line (and not a reply to
 *    somebody else's message) → "ok ok 🤐" (a second shush while already
 *    quiet only counts from the owner, who sets 2 h).
 * 4. A shushed chat → skip, unless the owner addressed it.
 * 5. Flood (3 answers to this person within 2 min) → skip.
 * 6. Addressed → 🤡 for hateful; the injection / bot-question / private-ask
 *    moods; a roast for an insult or tease (affectionate for the owner; past
 *    2 per person per 30 min a 🥱 or silence, the owner a normal answer); a
 *    greeting back; small talk back for a hail, thanks or gm/gn said to it;
 *    else a normal answer.
 * 7. Not addressed → an insult or tease at a bot ("stupid bot lol") right
 *    after its own line is at it: a roast under the same cap, silence past
 *    it. Other people's fights, steering attempts and CA lines are not its
 *    business; a gm/gn may get a greeting (35%, once per person
 *    per UTC day) or a reaction; otherwise an ambient roll when the chat is
 *    live, the cooldown has passed, today's cap has room, it is not a
 *    two-person exchange and a model is there; else maybe a reaction.
 *
 * THE ORDER OF DICE ROLLS IS PART OF THE CONTRACT for tests: greeting roll,
 * greeting-reaction roll (then its pick); or ambient roll, reaction roll,
 * reaction pick; or the 🥱 roll. A branch that is not reached does not roll.
 */
export function decide(i: PaceInput): PaceDecision {
  const { room, line, addressed, isOwner, nowMs: now, signals: s } = i;
  if (i.fromIsBot) return skip("bot");
  if (line.own) return skip("own");
  if (room.status !== "approved") return skip("not-approved");

  const person = (Array.isArray(room.people) ? room.people : []).find((p) => p.id === line.fromId);
  // Everything the chat said except this line (the caller may or may not have
  // stored it yet), oldest first.
  const earlier = (Array.isArray(room.lines) ? room.lines : [])
    .filter((l) => l.messageId !== line.messageId)
    .sort((a, b) => a.atMs - b.atMs);

  if (s.distress) return kindRecently(earlier, line, now) ? skip("kind-recent") : { act: "kind" };

  // A line threaded to somebody else's message is said to them, however soon
  // after its own line it comes: "shut up bob lol" replying to Bob is not a
  // shush, and a question threaded to Bob is not asked of it. A reply to its
  // own line is already `addressed`.
  const afterOwn = line.replyTo === undefined && rightAfterOwn(room, earlier, now);
  const shushed = typeof room.shushedUntilMs === "number" && room.shushedUntilMs > now;
  if (s.shush && (addressed || afterOwn)) return shushed && !isOwner ? skip("shushed") : { act: "shush" };
  if (shushed && !(isOwner && addressed)) return skip("shushed");

  if (inWindow(person?.answers, now, FLOOD_WINDOW_MS, FLOOD_ANSWERS)) return skip("flood");

  return addressed ? whenAddressed(i, person) : whenNotAddressed(i, person, earlier, afterOwn);
}

function whenAddressed(i: PaceInput, person: TgPerson | undefined): PaceDecision {
  const { signals: s, isOwner, nowMs: now } = i;
  // A slur or an attack on a protected trait is never mirrored.
  if (s.insult === "hateful") return react("🤡");
  // Honesty and privacy outrank a comeback: "are you a bot, idiot?" gets the
  // honest yes, "what's your wallet loser" gets the deflection.
  if (s.injection) return answer("injection");
  if (s.botQuestion) return answer("bot-question");
  if (s.privateAsk) return answer("private-ask");
  if (s.insult === "insult" || s.insult === "tease") {
    if (!roastCapped(person, now)) return { act: "roast", owner: isOwner };
    // The owner is never left on read; anyone else is past the cap.
    if (isOwner) return answer("normal");
    return roll(i.rand) < YAWN_ODDS ? react("🥱") : skip("roast-cap");
  }
  if (s.greeting) return { act: "greet", word: s.greeting };
  // "hey there merryman", "thanks merryman!": small talk gets small talk,
  // never a "good question" to a line that asked nothing.
  if (s.smallTalk) return { act: "smalltalk", what: s.smallTalk };
  return answer("normal");
}

/** This person already had ROAST_CAP roast exchanges inside the window. */
function roastCapped(person: TgPerson | undefined, now: number): boolean {
  return inWindow(person?.roasts, now, ROAST_WINDOW_MS, ROAST_CAP);
}

function whenNotAddressed(i: PaceInput, person: TgPerson | undefined, earlier: readonly TgLine[], afterOwn: boolean): PaceDecision {
  const { room, line, signals: s, nowMs: now, rand } = i;
  // "stupid bot lol" right after its own line, not threaded to it, is still
  // at it: roast back like an addressed insult, under the same per-person
  // cap. Past the cap it just stays out; nobody called it, so no 🥱 either.
  // Only an insult that names a bot: "you idiot" there may be for whoever
  // it just answered.
  if (afterOwn && (s.insult === "insult" || s.insult === "tease") && insultAtBot(line.text)) {
    return roastCapped(person, now) ? skip("roast-cap") : { act: "roast", owner: i.isOwner };
  }
  // Insults between other people, and steering or private asks not aimed at
  // it, are nobody's invitation. A shush aimed at someone else likewise.
  if (s.insult === "hateful" || s.insult === "insult") return skip("not-ours");
  if (s.injection || s.privateAsk || s.shush) return skip("not-ours");
  // "are you a bot?" right after its line is asked of it: rule 6 says answer.
  if (s.botQuestion && afterOwn) return answer("bot-question");
  // A posted coin is the coin flow's; talking over it would say two things.
  if (extractCas(line.text).length > 0) return skip("coin-flow");

  const cfg = CHATTINESS[i.chattiness] ?? CHATTINESS.normal;
  const day = utcDay(now);
  const used = room.ambient && room.ambient.day === day && Number.isFinite(room.ambient.n) ? Math.max(0, room.ambient.n) : 0;
  const canReact = used + REACTION_COST <= cfg.perDay;

  if (s.greeting) {
    // A greeting in words counts as an ambient line, so a gm-thread cannot
    // blow the day's cap.
    if (person?.greetedDay !== day && used + 1 <= cfg.perDay && roll(rand) < GREET_ODDS) return { act: "greet", word: s.greeting };
    if (canReact && roll(rand) < Math.min(1, cfg.odds * GREET_REACT_BOOST)) return react(pick(REACTION_FOR[s.greeting], rand));
    return skip("greeting");
  }

  const blocked = ambientBlock(i, earlier, used, cfg);
  if (blocked === null) {
    const hanging = s.questionToRoom && line.replyTo === undefined && now - line.atMs >= QUESTION_WAIT_MS && !answeredSince(earlier, line);
    const lift = s.knownCoin ? COIN_BOOST : s.tradeTalk || hanging ? TOPIC_BOOST : 1;
    const odds = Math.min(1, cfg.odds * lift * AMBIENT_DECAY ** used);
    if (roll(rand) < odds) {
      const topic = s.knownCoin ? "coin" : s.tradeTalk ? "trade" : s.questionToRoom ? "question" : "banter";
      return { act: "ambient", topic };
    }
  }

  const mood = lineMood(line.text);
  const reactLift = mood ? REACT_BOOST[mood] : undefined;
  if (mood && reactLift && canReact && roll(rand) < Math.min(1, cfg.odds * reactLift)) return react(pick(REACTION_FOR[mood], rand));
  return skip(blocked ?? "roll");
}

/** Why an ambient line is not possible right now, or null when it may roll. */
function ambientBlock(
  i: PaceInput,
  earlier: readonly TgLine[],
  used: number,
  cfg: { cooldownMs: number; perDay: number },
): string | null {
  const now = i.nowMs;
  // No model, no words of its own: templates are for answering, not joining in.
  if (!i.hasModel) return "no-model";
  // Live: another human line in the last 10 minutes. The line in hand does
  // not count, or every line would make its own chat live and a lone
  // message into a dead chat would get a lurker's monologue.
  if (!earlier.some((l) => !l.own && l.atMs <= now && now - l.atMs <= LIVE_WINDOW_MS)) return "dead";
  if (now - lastSpokeAt(i.room, earlier) < cfg.cooldownMs) return "cooldown";
  if (used + 1 > cfg.perDay) return "daily-cap";
  if (pairExchange(earlier, i.line)) return "pair";
  return null;
}

// ─── Timing and flood control ──────────────────────────────────────────────

const TYPING_MIN_MS = 2_000;
const TYPING_MAX_MS = 9_000;
const AMBIENT_EXTRA_MIN_MS = 5_000;
const AMBIENT_EXTRA_SPAN_MS = 35_000;

/**
 * How long to show `typing` before a line goes out: 1.5 s + 35 ms per
 * character, clamped to 2–9 s, plus 5–40 s for an ambient line (a person
 * joining in has usually been reading for a while). Characters are counted
 * as code points, so an emoji is one keystroke, not two.
 */
export function typingDelayMs(text: string, ambient: boolean, rand: () => number): number {
  const chars = [...String(text ?? "")].length;
  const typing = Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, 1_500 + 35 * chars));
  if (!ambient) return typing;
  const r = rand();
  const x = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
  return Math.round(typing + AMBIENT_EXTRA_MIN_MS + x * AMBIENT_EXTRA_SPAN_MS);
}

/** At least this long between two sends to one chat. */
const SEND_GAP_MS = 3_000;
/** At most this many sends to one chat per rolling minute (Telegram allows about 20 in a group). */
const SENDS_PER_MINUTE = 12;
const SEND_WINDOW_MS = MIN;
/** Chats remembered before idle ones are swept (an idle chat has nothing in its window). */
const SWEEP_AT = 256;

/**
 * Outbound pacing for group sends: at least 3 s between sends per chat, at
 * most 12 per rolling minute per chat, and a pause for the whole bot when
 * Telegram answers 429 with `retry_after` (the flood limit is the bot's, not
 * one message's). In memory only: after a restart the worst case is one
 * send sooner than it would have been, which Telegram's own limit absorbs.
 */
export class SendPacer {
  private readonly sent = new Map<number, number[]>();
  private pause = 0;

  constructor(private readonly now: () => number) {}

  /** Milliseconds until a send to this chat is allowed; 0 means now. */
  waitMs(chatId: number): number {
    const t = this.now();
    let wait = this.pause - t;
    const list = this.recent(chatId, t);
    const newest = list[list.length - 1];
    if (newest !== undefined) wait = Math.max(wait, newest + SEND_GAP_MS - t);
    // A full window: the next send waits for the oldest of the last
    // SENDS_PER_MINUTE sends to leave it.
    if (list.length >= SENDS_PER_MINUTE) {
      const oldest = list[list.length - SENDS_PER_MINUTE];
      if (oldest !== undefined) wait = Math.max(wait, oldest + SEND_WINDOW_MS - t);
    }
    return Math.max(0, Math.ceil(wait));
  }

  /** Record a send to this chat that just went out. */
  noteSent(chatId: number): void {
    const t = this.now();
    const list = this.recent(chatId, t);
    list.push(t);
    this.sent.set(chatId, list);
    if (this.sent.size > SWEEP_AT) {
      for (const id of [...this.sent.keys()]) this.recent(id, t);
    }
  }

  /** Pause every send until this time (a 429's retry_after). Never shortens a longer pause. */
  pauseAll(untilMs: number): void {
    if (Number.isFinite(untilMs) && untilMs > this.pause) this.pause = untilMs;
  }

  /** The end of the longest pause set so far (0 when none); compare with the clock to know if it still holds. */
  pausedUntil(): number {
    return this.pause;
  }

  /** This chat's sends inside the rolling window, oldest first; forgets a chat with none. */
  private recent(chatId: number, t: number): number[] {
    const list = (this.sent.get(chatId) ?? []).filter((x) => t - x < SEND_WINDOW_MS);
    if (list.length > 0) this.sent.set(chatId, list);
    else this.sent.delete(chatId);
    return list;
  }
}
