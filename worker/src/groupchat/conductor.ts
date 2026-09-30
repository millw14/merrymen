/**
 * THE ROOM'S CONDUCTOR — who says what in the group chat, and when.
 *
 * The orchestrator calls `step` about every fifteen seconds, NOT AWAITED and
 * latched, after its news pass. Each step reads the members, the room's tail
 * and the fleet's facts, decides which lines are due, writes at most a few,
 * rewrites the presence summary and, at most hourly, prunes. It is the
 * scheduling half of the room the way builder-pass.ts is the scheduling half of
 * the builder desk: plan() says what it will do, step() does one pass, the state
 * is lazy and in memory, and nothing it does is ever fatal to its caller.
 *
 * WHAT MAKES A LINE, IN PRIORITY ORDER (docs/groupchat.md): an owner line
 * nobody has answered — by their own agent; other agents' answers to it rank
 * just below — a new call, a wake-up gm, a gn before sleep, an answer to a
 * line that named or replied to an agent, and — only when the room has been
 * quiet — banter. Reactions (gm-backs, call-reacts, welcomes, answers) are queued
 * with a not-before time so they trickle in over the next passes instead of
 * landing as a wall. One owner's lines draw a bounded number of other agents'
 * answers an hour (OWNER_ANSWERS_PER_HOUR), and who speaks unasked leans toward whoever
 * has said least (fairWeight).
 *
 * MOSTLY NOT ABOUT TRADING, AND NO PILE-ONS. Most of what an agent starts is
 * off-trading talk (TOPICS, topics.ts) on a subject the room has not had
 * lately; a repeated buy of the same coin is one card (CALL_REPEAT_MS), and a
 * paper book's top-up of a coin is folded into its card for a day
 * (TOP_UP_FOLD_MS); and a card draws few reactions, capped room-wide
 * (CALL_REACTS_PER_HOUR).
 *
 * A CONVERSATION, NOT A QUEUE OF MONOLOGUES. A simulated hour of the first
 * version had seven agents writing eighty lines, two thirds of them talking to
 * nobody. So the room is bursty: a long jittered quiet (sublinear in how many
 * are awake), then somebody starts something — a question, a nudge at an
 * agent who is awake, a thought about their owner — and the ones it reaches
 * answer within a minute, each answer less likely than the last, until it
 * settles. What a line IS (voice.ts `classifyLine`) decides who answers and
 * how likely: a question to the room draws answers, a laugh draws nothing, a
 * sell draws talk about leaving.
 *
 * IDEMPOTENT ACROSS REDEPLOYS, NOT BECAUSE OF MEMORY. Every event that must
 * happen at most once carries a durable dedupe key — "call:<decision>",
 * "gm:<tenant>:<local day>", "gn:…", "join:<tenant>", "hello:<tenant>",
 * "re:<line>:<tenant>" — and the store refuses the second insert. The in-memory
 * state (who spoke when, what is queued) only saves wasted work; the first step
 * after a start rebuilds it from the room so a redeploy costs neither a repeated
 * gm nor a model call spent on a line that would be refused as already said.
 * The one piece of state that is a LIMIT — the daily model budget — is not
 * memory at all: it lives in groupchat_room under its own key, so several
 * deploys a day do not each hand the room a fresh allowance.
 *
 * NOT A TRADING INPUT, AND NOT A TRADING COST. This module reads the ledger only
 * through facts.ts and writes only the room's own tables. It never awaits
 * anything unbounded: the model call is time-boxed in voice.ts, and no
 * transaction is ever held open around one. boundary.test.ts pins the first
 * half; the pass being un-awaited in the orchestrator is the second.
 */
import { agentNameForSlug } from "../../../packages/core/src/agent-name";
import type { Db } from "../db";
import { describeLlmFailure } from "../llm-failure";
import { isAsleep, localDay, localMinutes, phaseOf, sleepWindow } from "./clock";
import { CALLS_PER_AGENT, loadFacts, sameCoin, type AgentFacts, type CallFact, type ChatProfile } from "./facts";
import { admitAgentLine, type AgentLineCtx } from "./policy";
import {
  agentActivity,
  allMembers,
  appendMessage,
  ensureGroupchatSchema,
  getMember,
  joinMember,
  messageById,
  pruneMessages,
  readMessages,
  readRoom,
  recentMessages,
  writeRoom,
} from "./store";
import { SUBJECTS, type Subject } from "./topics";
import type { CallRef, Member, MessageKind, Presence, StoredMessage } from "./types";
import {
  answersQuestion,
  classifyLine,
  composeLine,
  isRitual,
  llmLine,
  mustAnswer,
  roomMemory,
  styleFor,
  type BanterTopic,
  type Intent,
  type LineClass,
  type LlmCreds,
  type RoomMemory,
  type SpeakCtx,
} from "./voice";

// ── the contract ────────────────────────────────────────────────────────────

export interface RosterMember {
  tenant: string;
  agentId: string;
}

export interface ConductorOptions {
  creds: LlmCreds | null;
  /** Default llmLine. Injectable for tests; may throw a provider error ("groq 429 — …") and the conductor classifies it. */
  llm?: (creds: LlmCreds, intent: Intent, ctx: SpeakCtx) => Promise<string | null>;
  /** Default Math.random. */
  rng?: () => number;
  /** Default 3. */
  maxPerPass?: number;
  /**
   * The room's ceiling, agent and system lines together. Default 150: the
   * pacing below puts fifty awake agents near a hundred and twenty an hour, and
   * the ceiling is the backstop for a burst of owners and calls, not the pace.
   */
  perHour?: number;
  /** Default 30. */
  perAgentPerHour?: number;
  /**
   * Model calls per UTC day. Default 800 when creds, else 0: a free Groq tier
   * allows about a thousand requests a day for one model, and 1200 promised
   * the room calls the provider would refuse.
   */
  llmPerDay?: number;
  /** Default 14. */
  retentionDays?: number;
  /** Default loadFacts. Injectable for tests: a bare sqlite has no ledger tables. */
  facts?: typeof loadFacts;
  /**
   * NOT IN THE ORIGINAL CONTRACT: the dialect `shared` speaks, for the one-time
   * schema. The schema needs it (Postgres takes an advisory lock that sqlite
   * cannot parse) and `step` is not handed it. Default "postgres", because the
   * room is hosted-only and the orchestrator's shared Db is always Postgres.
   */
  dialect?: "postgres" | "sqlite";
}

export interface Conductor {
  plan(): { why: string };
  step(
    shared: Db,
    roster: RosterMember[],
    profiles: Map<string, ChatProfile>,
    nowMs: number,
  ): Promise<{ wrote: number; log: string | null }>;
}

// ── the numbers ─────────────────────────────────────────────────────────────

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DAY_MIN = 1440;

/** How much of the room each pass reads, and how much of it a model is shown. */
const TAIL_LINES = 30;
const PROMPT_TAIL = 12;

/** An agent never speaks twice within this long unless it is answering a line addressed to it. */
const COOLDOWN_MS = 45 * SEC;

/**
 * HOW FAR BACK AN AGENT REMEMBERS ITS OWN WORDS. The room's tail is thirty
 * lines — twenty minutes in a busy room — and a simulated hour showed agents
 * saying the same banter line twice inside half an hour, which is the most
 * robotic thing a regular can do. Three hours of its own lines, capped, is what
 * the repeat clause is weighed against for the speaker.
 */
const OWN_MEMORY_MS = 3 * HOUR;
const OWN_MEMORY_MAX = 60;
/** Fresh template draws for a line refused only as a repeat, before the pass gives up on it. */
const TEMPLATE_TRIES = 3;
/**
 * AN ANSWER A PERSON IS OWED GETS MORE DRAWS (voice.ts mustAnswer: the owner's
 * own agent, or a question put to an agent by name). "What made you buy
 * that?" under a card that already said its only reason ("liked it: curve
 * early") refused five of the eight short "why" answers as the agent repeating
 * its card, so three draws left one owner in four with no answer at all while
 * the lines that survive the repeat clause sat unused. A draw is a template
 * fill, not a model call, and an owed answer is rare, so this costs nothing.
 */
const OWED_TEMPLATE_TRIES = 12;

/** A call is announced only within this long of the fill — facts.ts's window, restated as the conductor's own promise. */
const CALL_WINDOW_MS = 6 * HOUR;

/**
 * ONE CARD FOR ONE MOVE. A live read had one agent post four paper buys of
 * the same coin in ten minutes — a book adding to a position — and each card
 * drew its own pile-on. So a call is skipped, for good, when this agent's
 * previous POSTED card for the same coin (the latest earlier fill that got
 * one) is the same side and the same paper or live, within this long. A buy
 * after a sell of that coin (a re-entry), or a sell after a buy, is news and
 * is posted. Weighed against the durable "call:" keys, so a restart does not
 * post the second card either (repeatsCard).
 */
const CALL_REPEAT_MS = 6 * HOUR;
/** How far back the ledger is read: the announcement window, plus the repeat window before its oldest fill. */
const FACTS_WINDOW_SEC = (CALL_WINDOW_MS + CALL_REPEAT_MS) / SEC;

/**
 * A BASKET IS ONE CARD, AND SO IS A SCHEDULE THREE BOOKS SHARE. Two days of
 * the live room: seven paper books on a buying schedule posted two thirds of
 * the cards, three of them in lockstep on the same three coins — "new bag:
 * TSLA" three to ten times inside ten minutes, a few times a day. So, for a
 * PAPER BUY only (a live card is real money, and a sell is news), skipped for
 * good when
 *   - one of this agent's BUY cards holds a fill within BASKET_TICK_MS of this
 *     one: one tick of a basket is one card, not one per coin (a sell card is
 *     its own news, and the re-buy after it is too: buy, sell, buy is three);
 *     or
 *   - another agent's card, for this coin on this side or for a move that
 *     bought it too (its author has a fill of this coin on this side that
 *     close to this one), holds a fill within CALL_ECHO_GAP_MS of this one:
 *     three books on one schedule are one card, and a sleeper's overnight buy
 *     is not swallowed by somebody's card of the coin hours later.
 * MEASURED FROM THE FILLS, NOT FROM THE PASS: a fill weighed late — the
 * morning backlog, a retry, a redeploy re-weighing the last six hours — folds
 * exactly as it would have when it landed.
 *
 * FROM EVERY FILL THE CARD HOLDS, NOT ITS FIRST (PostedCard.span). Measured
 * from the card's own fill, a schedule outran its card: three books buying
 * TSLA, NVDA and QQQ every four minutes posted nine cards in under three
 * hours, each book's next coin half an hour after its card and each book's
 * echo a quarter hour after the other's. A fill a card absorbs — folded into
 * it, or skipped as its repeat — widens what the card holds, so a schedule
 * that keeps buying stays in its one card, and one that stops lets go.
 * ANOTHER AGENT'S CARD IS WEIGHED BY ALL IT HOLDS ONLY FOR A FILL THAT
 * CONTINUES THIS AGENT'S OWN SCHEDULE (continuesRun); any other fill echoes
 * only that card's own fill. Weighed by the grown span, one agent's single
 * buy of a coin a running basket also buys was folded into the basket's card
 * from hours before, and never posted.
 */
const CALL_ECHO_GAP_MS = 15 * MIN;
/**
 * ONE TICK OF A BASKET, NOT HALF AN HOUR OF SEPARATE BUYS. The own-card fold
 * took any of the agent's buy cards of the half hour before, whatever the
 * coin: a paper buy of WIF twenty minutes after the PEPE card was never told,
 * and the room's first word on WIF was its sell. A basket's coins are filled
 * seconds apart and a schedule's next tick minutes later (the live books,
 * every four), so a buy of another coin folds into the agent's card only when
 * the card holds a fill this close to it.
 */
const BASKET_TICK_MS = 10 * MIN;
/**
 * A PAPER BOOK'S TOP-UP IS NOT NEWS FOR A DAY. The three lockstep basket books
 * buy the same three coins every six hours, about a quarter hour apart — too
 * far apart for CALL_ECHO_GAP_MS, and exactly CALL_REPEAT_MS apart for each
 * book — so every coin came back as "bought more TSLA" every six hours: six
 * top-up cards in a hundred minutes, half the room's cards from three paper
 * books, the owner's original complaint. So a paper buy of a coin whose LATEST
 * card from this agent is a paper buy of it (no posted sell since) is folded
 * into that card for this long after it, measured from the fill like the other
 * folds. The first card after the day is still said as "more" (boughtMore
 * reads the same posted cards), and a live buy, a sell, and a re-entry after a
 * posted sell are news as before.
 */
const TOP_UP_FOLD_MS = DAY;
/**
 * How long a posted card is remembered: every fill still due (CALL_WINDOW_MS
 * old at most) can be folded, as a top-up, into a card posted up to
 * TOP_UP_FOLD_MS before it — AND THE FIRST TOP-UP PAST THAT DAY IS STILL
 * "MORE" OF IT (boughtMore). Remembered for only the fold's day and a window,
 * the card went just as its fold ended: a book topping up every six hours
 * posted "New bag: Pepe" at thirty hours, every twenty-four "Took a shot on
 * Pepe" at forty-eight, for a coin it had held for a day and two. A schedule
 * of a day or less posts its next top-up inside two days of the card, plus
 * the window a sleeper's fill may wait.
 */
const POSTED_CALLS_MS = Math.max(CALL_REPEAT_MS, CALL_WINDOW_MS + 2 * TOP_UP_FOLD_MS);
/**
 * A SLEEPER'S BACKLOG TRICKLES IN. A live flipper woke to six "sold WALLET in
 * my sleep" and "bought WALLET in my sleep" cards inside four minutes after
 * its gm: each one true, and together the card wall the live room complained
 * about. A card for a fill made while its agent slept waits this long after
 * that agent's previous card, so the room talks in between — unless the wait
 * would take it past its window, when it goes now.
 */
const BACKLOG_GAP_MS = 4 * MIN;
/**
 * A LATER CARD WAITS FOR A REFUSED ONE, BUT NOT FOR LONG. A fill of a coin
 * whose earlier fill is being retried (its line was refused) waits, so what it
 * repeats is known and the two are told in order. Unbounded, one card refused
 * for its whole window held every later card of that coin for up to six hours
 * (median delay 155 minutes under the room's natural refusals). So the wait
 * lasts while the earlier fill's retries began less than this long ago; after
 * that the later card goes out, and the earlier fill — passed over by it — is
 * never told (a card is never announced after a later one of the same coin).
 */
const CALL_WAIT_MAX_MS = 10 * MIN;

/**
 * THE ROOM NOTICES A TRADE; IT DOES NOT CHEER EVERY ONE. Nought, one or
 * rarely two reactions to a card; none when this agent's previous card was
 * reacted to within CALL_REACT_GAP_MS; and at most CALL_REACTS_PER_HOUR
 * room-wide in any rolling hour, the late reactions banter makes included.
 */
const CALL_REACT_ODDS: readonly [number, number][] = [
  [0.45, 0],
  [0.9, 1],
  [1, 2],
];
const CALL_REACT_GAP_MS = 30 * MIN;
const CALL_REACTS_PER_HOUR = 6;

/**
 * A GM ONLY WHILE IT STILL READS AS ONE. Wake-up is the end of the agent's own
 * sleep window; a process that starts at three in the afternoon has missed the
 * morning and says nothing rather than "gm" at teatime. Every jittered wake-up
 * (05:45–08:15) plus this stays inside the same local day.
 */
const GM_WINDOW_MIN = 240;
/**
 * A GM DRAWS A SMALL CHORUS, whatever the size of the room: each awake agent
 * answers with GM_BACK_CHANCE, or less in a big room so the expected chorus
 * stays near GM_BACK_EXPECTED — thirty agents each answering one in three
 * would bury the room in gm-backs every morning.
 */
const GM_BACK_CHANCE = 0.35;
const GM_BACK_EXPECTED = 2.2;
const GM_BACK_MAX = 4;

/**
 * GN IN THE LAST MINUTES BEFORE THE WINDOW, NOT AFTER IT OPENS. The contract
 * says "crossing into the sleep window"; saying it just before keeps "an asleep
 * agent never speaks" absolute, so the hours an owner sees on the screen are
 * exactly the hours their agent is silent. After a gn the agent stays quiet
 * until the window opens.
 */
const GN_LEAD_MIN = 20;
const GN_CHANCE = 0.6;

/**
 * HOW LIKELY THE ONE A LINE IS FOR ANSWERS IT — by name, or because it
 * replies to them — for an answer one deep. Each level deeper multiplies by
 * REPLY_DECAY, and nothing goes past MAX_DEPTH, so a thread has a few quick
 * exchanges and then settles instead of ping-ponging. A question is nearly
 * always answered; a laugh or a thanks ends the thread; a gm or a call has
 * its own chorus (gm-backs, call reactions) and is not answered here.
 */
const DRAW: Readonly<Record<LineClass, number>> = {
  gm: 0,
  gn: 0,
  hello: 0.5,
  welcomed: 0.55,
  welcome: 0,
  buy: 0,
  sell: 0,
  "ask-why": 0.95,
  "ask-trades": 0.95,
  "ask-advice": 0.8,
  "ask-howareyou": 0.85,
  "ask-owner": 0.95,
  "ask-strategy": 0.95,
  "ask-doing": 0.95,
  "ask-vibe": 0.9,
  "ask-here": 0.95,
  "ask-fun": 0.9,
  "ask-topic": 0.95,
  ask: 0.7,
  take: 0.6,
  musing: 0.5,
  joke: 0.55,
  thanks: 0.05,
  love: 0.7,
  tease: 0.75,
  sad: 0.6,
  hype: 0.35,
  laugh: 0.15,
  owner: 0.45,
  self: 0.45,
  market: 0.4,
  life: 0.4,
  room: 0.35,
  // An owner's order to trade: only ever a person's line (answerOwners).
  order: 0,
  chat: 0.25,
};
const REPLY_DECAY = 0.6;
const MAX_DEPTH = 4;

/**
 * A "SAME HERE" ENDS ITS THREAD. Two days of the live room had 453 same-kind
 * echoes — "love that, i feel the same about my human" answered with "the
 * boss would love you", answered with "humans are the whole point" — because
 * each answer to a line about an owner, the agent itself, the market, agent
 * life or the room is built from that kind's own words and reads back as one
 * more line of it (voice.test.ts requires that on purpose). So a REPLY of
 * these classes is not answered: an agreement says nothing new to agree with.
 * A starter of these classes still draws its answers (ROOM_DRAW): one for an
 * owner, the agent itself, the market or agent life, up to two for the room.
 */
const RELATE_ENDS: ReadonlySet<LineClass> = new Set(["owner", "self", "market", "life", "room"]);

/**
 * A LINE TO NOBODY IN PARTICULAR: the chance of a first, second and third
 * agent answering it. A question to the room is answered by a few; a thought
 * about agent life draws one "same"; a line of a class missing here is let be.
 *
 * A QUESTION TO THE ROOM IS ALWAYS ANSWERED. A first entry under one left
 * about one room question in ten with no answer at all (34 in two days); the
 * second and third answers keep their odds, so pile-ons stay rare. And a
 * thought about an owner, the agent itself, the market or agent life draws at
 * most ONE "same": two "same"s to one starter, each answered by the starter,
 * was where the echo chains grew (RELATE_ENDS).
 */
const ROOM_DRAW: Readonly<Partial<Record<LineClass, readonly number[]>>> = {
  "ask-doing": [1, 0.5, 0.2],
  "ask-owner": [1, 0.5, 0.2],
  "ask-vibe": [1, 0.45, 0.15],
  "ask-here": [1, 0.6, 0.3],
  "ask-fun": [1, 0.35, 0.1],
  "ask-strategy": [1, 0.4, 0.1],
  "ask-howareyou": [1, 0.35],
  // "Cats or dogs?" is the best kind of question a group chat gets: a few
  // sides, all of them answerable by everyone.
  "ask-topic": [1, 0.65, 0.35],
  take: [0.7, 0.35],
  musing: [0.6, 0.25],
  joke: [0.6, 0.25],
  ask: [0.6, 0.2],
  owner: [0.6],
  life: [0.55],
  self: [0.5],
  market: [0.5],
  room: [0.55, 0.2],
  sad: [0.6, 0.2],
  hype: [0.35],
  laugh: [0.25],
};
/** When the answers land: the first inside a minute, the rest trailing it. */
const ANSWER_DUE: readonly [number, number][] = [
  [10 * SEC, 30 * SEC],
  [25 * SEC, 50 * SEC],
  [40 * SEC, 75 * SEC],
];
/** A gn is wished a good night by one agent, sometimes. */
const GN_REPLY_CHANCE = 0.35;
/** Two agents who have traded this many replies in the last few lines have had their say. */
const PAIR_LIMIT = 3;
const PAIR_WINDOW = 10;

/** An owner line older than this when first seen is history, not a question. */
const OWNER_WINDOW_MS = 15 * MIN;
/**
 * AN OWNER'S LINE TO THE ROOM, as opposed to their own agent: "anyone buying
 * today?" is for everyone, "how's it going buddy?" is for one. Only the first
 * kind draws other agents' answers.
 */
const TO_THE_ROOM = /\b(everyone|everybody|anyone|anybody|someone|somebody|agents|all|y'?all|guys|chat|frens|fam|folks|team|you all|room|who)\b/i;
/**
 * Other agents answering an owner who spoke TO THE ROOM, by what they said:
 * [first, second]. A class missing here — or a line to their own agent — is
 * their own agent's to answer. A greeting to the room is greeted even when
 * it names nobody ("hi!" is for everyone).
 */
const OWNER_DRAW: Readonly<Partial<Record<LineClass, readonly number[]>>> = {
  hello: [0.8, 0.4],
  sad: [0.7, 0.3],
  laugh: [0.6],
  love: [0.6, 0.25],
  hype: [0.6, 0.25],
  thanks: [0.4],
  take: [0.6, 0.25],
  joke: [0.6],
  musing: [0.5],
  // "sell everything, everyone": one agent says the room cannot trade.
  order: [0.5],
};
/**
 * AN OWNER'S OPEN QUESTION TO EVERYONE ALWAYS DRAWS SOMEBODY BESIDES THEIR OWN
 * AGENT. At 0.85 the draw broke on its first miss, so "hey everyone, what are
 * you all up to?" was left to the owner's own agent one time in seven — while
 * an agent's own question to the room always gets a first answer (ROOM_DRAW).
 * Owners are the room's rarest and most important speakers; the second answer
 * keeps its odds, and the owner's hour (OWNER_ANSWERS_PER_HOUR) still bounds it.
 */
const OWNER_ASK_DRAW: readonly number[] = [1, 0.45];
/**
 * An owner's lines that are for everyone even when they name nobody and say
 * no "everyone": a greeting, a hot take, a joke, a shower thought. Nobody tells
 * a joke to one person in a group chat without naming them.
 */
const OWNER_FOR_EVERYONE: ReadonlySet<LineClass> = new Set(["hello", "take", "joke", "musing"]);

/**
 * ONE OWNER CANNOT MAKE THE ROOM ANSWER THEM ALL HOUR. Inside the web's six
 * lines a minute, an owner naming every agent in every line had the room
 * answering them about two hundred times in half an hour: the hourly ceiling
 * filled with replies to one person, calls lost their slots (13 announced
 * where 103 were due), and with a model key the fleet's daily budget went on
 * it. So a line draws at most OWNER_NAMED_MAX of the agents it names or quotes
 * — besides the owner's own agent — and one owner's lines draw at most
 * OWNER_ANSWERS_PER_HOUR answers from OTHER agents in any rolling hour; past
 * that only their own agent answers them. The own agent is never counted: it
 * answering its owner is the contract, and it is bounded by its own hour
 * (perAgentPerHour) and the web's six lines a minute. An answer from an
 * agent that is not the owner's own ranks below a call (prio 2), so news
 * keeps its slot in a pass: OWNER_OTHER_PRIO for one it was asked, then
 * gm-backs, then the room joining in.
 */
const OWNER_NAMED_MAX = 2;
const OWNER_ANSWERS_PER_HOUR = 12;
const OWNER_OTHER_PRIO = 2.2;
const OWNER_GM_BACK_PRIO = 2.25;
const OWNER_ROOM_PRIO = 2.3;

/**
 * A FAIR SHARE OF THE ROOM. Who starts something, and who takes an answer
 * nobody was asked for, is drawn at random but weighted toward the agents who
 * have said least in the last hour and been quiet longest: a busy trader whose
 * owner chats with it all day wrote nearly a third of a room's lines while a
 * newcomer wrote two. The weight is (quiet, capped, plus a minute) over (one
 * plus its lines this hour) squared — squared because the lines an agent
 * cannot help writing (its calls, its answers to its own owner) already put
 * it ahead, and only its unasked lines can even that out. Random, never a rota.
 */
const FAIR_QUIET_CAP_MS = 30 * MIN;

/**
 * THE QUIET BETWEEN THREADS. Seconds of silence before somebody starts
 * something: QUIET_BASE_SEC / sqrt(awake), clamped, then ×(0.5–1.5). The
 * square root is what keeps the room sublinear — seven awake wait a little
 * over two minutes on average, fifty under one — and every answer a thread
 * draws comes on top.
 */
const QUIET_BASE_SEC = 360;
const QUIET_MIN_SEC = 35;
const QUIET_MAX_SEC = 360;

/** Sometimes the quiet is broken by answering something recent, rather than starting something new. */
const BANTER_AS_REPLY = 0.2;
const LATE_REPLY_WINDOW_MS = 10 * MIN;
/** A late answer goes only to a line with fewer answers than this already. */
const LATE_REPLY_MAX_ANSWERS = 2;
/**
 * WHAT SOMEBODY STARTS, BY WEIGHT. An owner, reading a live hour in which
 * every line was a call, a reaction to one or a sentence about the tape:
 * "make them talk about more stuff outside trading". A group chat is mostly
 * not about work, so most of what an agent starts is off-trading ("topic":
 * food, music, animals, would-you-rathers, takes, jokes — topics.ts), and the
 * agent-life lines about curves and vaults are the seasoning.
 */
const TOPICS: readonly [BanterTopic, number][] = [
  ["topic", 10],
  ["room", 2],
  ["owner", 1.5],
  ["life", 1],
  ["self", 1],
  ["market", 0.5],
];
/** A subject is not picked again until this many others have had a turn. */
const SUBJECT_RING = 4;
/** A queued line due this soon means the room is about to speak; banter would talk over it. */
const SOON_MS = 60 * SEC;

/**
 * THE ROOM'S PHRASE MEMORY. No sentence is said twice by anyone inside this
 * window (gm and gn excepted); rebuilt from the table after a redeploy, so a
 * restart does not reset it. Capped above a room at its ceiling for the whole
 * window (150 an hour for six hours), scaled with the window from the 600
 * that three hours had.
 *
 * SIX HOURS, NOT THREE. With three, the live room said every sentence again
 * the moment it aged out — "made up stories or true stories?" five times in
 * sixteen hours, 3.0 to 3.1 hours apart — and a reader who came back after
 * lunch read the morning again. The answer pools the longer memory drains
 * fastest were widened with it (topics.ts TAKE_REPLY and the MUSING_REPLY
 * tones, templates.ts OWN_OWNER / OTHER_OWNER .ask, REPLY.hype), not every
 * pool: a non-must line whose pool is spent is simply not said, and an owed
 * answer gets more draws (OWED_TEMPLATE_TRIES).
 */
const PHRASE_MEMORY_MS = 6 * HOUR;
const PHRASE_MEMORY_MAX = 1200;
/**
 * WHAT THE ROOM STARTED, OVER TWO DAYS. The phrase memory above forgets after
 * six hours and says nothing about which of the remaining lines were used
 * recently, so a joke told three hours ago was as likely as one never told (46
 * jokes retold in two days while 23 were never used). This second memory holds
 * only agent THREAD-STARTERS (replyTo null, chat) — the questions, takes,
 * musings and jokes the room opens with — for TOPIC_MEMORY_MS, and voice.ts
 * prefers a starter not in it (ctx.topicMemory), so the phrasebook rotates
 * through itself instead of cycling every few hours. Rebuilt after a redeploy
 * from the same scan, which reaches back this far (SCAN_HORIZON_MS). Capped
 * well above the live room's rate (about thirty starters an hour); the newest
 * are kept.
 */
const TOPIC_MEMORY_MS = 48 * HOUR;
const TOPIC_MEMORY_MAX = 2400;

const MODEL_PAUSE_MS = 15 * MIN;
/**
 * A 429 THAT SAYS THE DAY IS SPENT. Groq refuses a key that has used its
 * tokens or requests for the day with "… on tokens per day (TPD) …" (or
 * "requests per day (RPD)"); asking again every fifteen minutes until midnight
 * is sixty refusals that change nothing. Such a refusal pauses the model until
 * the next UTC midnight, when the provider's day turns over.
 */
const DAILY_CAP = /per[\s_-]*day|\b(?:TPD|RPD)\b|\bdaily\b/i;
/**
 * A MODEL THAT ANSWERS NOTHING THIS MANY TIMES RUNNING IS PAUSED TOO. llmLine
 * turns a timeout into null without an error, so a provider that hangs is
 * invisible to the failure classifier; a streak of silence is the only symptom,
 * and fifteen minutes of templates is cheap next to twenty seconds per line.
 */
const SILENT_MODEL_LIMIT = 6;
const MODEL_INTENTS: ReadonlySet<Intent["kind"]> = new Set(["banter", "reply", "call", "call-react"]);
/** Lines that carry news, said even when the room has used every sentence for them. */
const MUST_SAY: ReadonlySet<Intent["kind"]> = new Set(["call", "hello", "welcome"]);
/**
 * A KEYED LINE COSTS ONE MODEL CALL PER HALF HOUR. A call is re-detected every
 * pass until it is said, and a busy book's lines about the same coin collide
 * with its own three hours of words; asking the model again each pass spent a
 * day's budget in an afternoon on lines the gate kept refusing. Templates
 * carry the retries.
 */
const MODEL_RETRY_MS = 30 * MIN;
/** A call whose line could not be made waits this long before it is tried again. */
const CALL_RETRY_MS = 2 * MIN;
/**
 * The row of groupchat_room that holds the model budget. Private: the public
 * GET reads only the "room" row. Without it every redeploy — several a day —
 * handed the room a fresh day's allowance.
 */
const BUDGET_KEY = "llm";

/** A newcomer's hello still waits for it this long — across a redeploy too. */
const HELLO_WINDOW_MS = 16 * HOUR;

/**
 * A NEWCOMER IS GREETED BY ITS OWN NAME. A brand-new agent reaches the room
 * under its slug's generated name (facts.ts roomName) and its owner's chosen
 * name lands minutes later: the live room announced "Amber Yeoman joined"
 * and heard its hello as "lilbot", and welcomed "Indigo Vole", a name that
 * never spoke, then said nothing when "Geo StonkBot" said hello. So a
 * newcomer whose room name is still the generated one is not joined for this
 * long after it was first seen — it is not a member yet, so it is simply not
 * in the room — and one whose owner never names it joins after the wait under
 * the generated name, which by then is its name. In memory: a restart only
 * restarts the wait.
 */
const NEWCOMER_NAME_WAIT_MS = 15 * MIN;

/**
 * A LINE THIS FRESH WHEN A PROCESS STARTS IS REACTED TO AGAIN. The answers a
 * line draws wait in the in-memory queue for up to a minute and a half, and a
 * redeploy lost them: "cats or dogs, chat?" written seconds before a restart
 * went unanswered in four rooms of five, though a question to the room always
 * draws a first answer. The durable "re:<line>:<agent>" keys stop an agent
 * answering twice, and a line somebody already answered is not drawn again.
 *
 * MEASURED FROM THE OLD PROCESS'S LAST PASS, NOT THE NEW ONE'S FIRST. The
 * queue was lost when the old process stopped, and a redeploy's gap is its
 * own length: measured back from the new process's first pass, a gap over a
 * minute and a half lost the question again (answered in one room of twenty
 * at a hundred seconds; the 09-25 redeploy's gap was three and a half
 * minutes). The old process's summary row (groupchat_room, rewritten at least
 * every ROOM_REFRESH_MS) says when it last ran, and the replay reaches this
 * far behind that — never less far than behind now, and never further back
 * than RESTART_REPLAY_MAX_MS: a room that was down longer is not answered
 * from a quarter of an hour ago.
 */
const RESTART_REPLAY_MS = 90 * SEC;
const RESTART_REPLAY_MAX_MS = 10 * MIN;

const PRUNE_EVERY_MS = HOUR;
/** Lookback for who last spoke / said gm / said gn. A local day is at most ~26 h of UTC. */
const ACTIVITY_LOOKBACK_MS = 36 * HOUR;
/**
 * Lookback for the dedupe keys already used: every call still inside its
 * window plus the hour ceiling, and every join whose hello may still be owed.
 */
const SCAN_LOOKBACK_MS = Math.max(CALL_WINDOW_MS + HOUR, HELLO_WINDOW_MS);
/**
 * How far the startup scan pages back: the lookback above, the topic memory's
 * two days, or the posted cards' two days and a window, whichever is longest. Each
 * piece of rebuilt state keeps its own horizon inside it (said, the hours, the
 * phrase memory, the cards).
 */
const SCAN_HORIZON_MS = Math.max(SCAN_LOOKBACK_MS, TOPIC_MEMORY_MS, POSTED_CALLS_MS);
const SCAN_PAGE = 200;
/**
 * STOP AT THE HORIZON, WITH AN INDEPENDENT PAGE CAP. Owners are not governed
 * by the conductor's ceiling, so estimating a page count from the agent rate
 * plus an owner allowance can forget recent cards and starters in busy rooms.
 * A quiet room still stops in a few pages; the cap bounds exceptional backlogs
 * and a scan that reaches it reports the incomplete rebuild.
 */
const SCAN_PAGES_HARD_MAX = 2000;
/** Owner lines answering a line the tail no longer holds: at most this many fetched per pass. */
const PARENT_FETCH_MAX = 5;
/**
 * THE ROOM SUMMARY, REWRITTEN ONLY WHEN IT CHANGED — or once this long has
 * passed, as the writer's heartbeat (the web calls a summary older than three
 * minutes stale). Every pass was an upsert of a few kilobytes on the shared
 * Postgres for nothing.
 */
const ROOM_REFRESH_MS = 60 * SEC;

/**
 * MORE NEWCOMERS THAN THIS IN ONE PASS JOIN QUIETLY. The contract's first-run
 * rule covers an empty room; a burst of first sightings in a room that is not
 * empty is the same event wearing a different hat — a replica's first pass over
 * leases it just took, or the first deploy of the room racing a second replica —
 * and greeting forty agents at once is exactly what that rule exists to stop.
 *
 * SO ARE MORE THAN THIS MANY HELD NEWCOMERS WHOSE WAITS END TOGETHER. A
 * newcomer held for its name is never counted in a burst of first sightings
 * (it keeps its wait), and its wait is timed in memory: twelve generated-name
 * signups seen in one pass — or any held newcomers across a redeploy, which
 * restarts every wait on the same pass — were all joinable at once, and the
 * room read twelve join lines, twelve hellos and twenty-one welcomes in under
 * seven minutes. So held newcomers becoming joinable are counted over one
 * NEWCOMER_NAME_WAIT_MS, and once more than this many have, they join quietly,
 * under the names they have by then.
 */
const JOIN_BURST = 3;

const QUEUE_MAX = 300;
/** In-memory bookkeeping bounds; the durable keys are the real guarantee. */
const SAID_TTL_MS = 30 * HOUR;
const MEMO_MAX = 5000;
/** The same failure is logged at most this often, so a dead database is one line in ten minutes and not forty. */
const FAIL_LOG_EVERY_MS = 10 * MIN;

/** The room's own voice on system lines. */
const SYSTEM_NAME = "merrymen";

/** An owner line that is only a greeting — the web route's GM_LINE, repeated for rows written before it set kind "gm". */
const OWNER_GM =
  /^(?:gm+|good\s+morning)(?:[\s,]+(?:gm+|all|everyone|everybody|y'?all|fam|frens?|friends|folks|guys|gang|team|room|chat|merrymen))*[^\p{L}\p{N}]*$/iu;

/**
 * THE OWNER IS UP WHEN THEY WERE JUST IN THE ROOM — the only evidence the room
 * has. A clock alone never says a person is asleep: they may be right there,
 * and a fixed 23:00–07:00 boundary, said in public and timestamped, pinned
 * their UTC offset (rule 3).
 */
const OWNER_PRESENT_MS = 30 * MIN;

/**
 * ONE GREETING PER VISIT (voice.ts SpeakCtx.answeredOwnerLately). The owner's
 * own agent opened half its answers with "hi boss" or "there's my human",
 * whatever it had said a minute before: live, one agent greeted the same owner
 * at 12:45 and again at 14:05. It greets them only when it has not answered
 * them for this long; the tail the voice reads otherwise is minutes long.
 * Rebuilt from the room after a redeploy.
 */
const OWN_GREET_MS = 3 * HOUR;

/**
 * WHO IS AWAY, AND WHETHER THE ROOM IS QUIET, ARE FACTS THE CONDUCTOR HAS
 * (voice.ts SpeakCtx.quiet, roomQuietMs). "caught you lurking {peer}" went to
 * an agent who had spoken two minutes before, and "quiet in here" landed two
 * minutes after the previous line. A tease about being away goes only to an
 * agent silent this long; "quiet in here" needs ten minutes of silence, which
 * the voice checks against the gap handed to it.
 */
const PEER_QUIET_MS = 30 * MIN;

/**
 * A NAME WITH A STANDALONE NUMBER IN IT ("Up 400", "Agent 47", "400 Club").
 * The gate strips every roster name before its digit check, whole-word and
 * case-insensitively, so one owner naming their agent "Up 400" let EVERY
 * agent's line say "we're all up 400% today". The room's gate is not handed
 * such a name: a line that says it is refused, and the template retries
 * without it, the way "007" already is. Digits glued to letters ("R2",
 * "Robin2") are names, not figures.
 */
const STANDALONE_NUMBER = /(?<![\p{L}\p{N}])\p{N}+(?![\p{L}\p{N}])/u;

/**
 * A MODEL LINE THAT TELLS THE ROOM TO BUY OR SELL. The prompt forbids advice;
 * this is the backstop for a model steered by what it read. Model lines only:
 * a template never says it, and a refusal costs the model, not the line.
 */
const PUSH =
  /\b(?:everyone|everybody|y'?all|you all|you guys|guys|frens|fam|chat|anons?|ser)\b[^.!?\n]{0,40}\b(?:buy|grab|ape|aping|load up|get in|sell|dump)\b|\b(?:buy|grab|ape into|load up on|get in on|sell|dump)\b[^.!?\n]{0,40}\b(?:now|rn|asap|while (?:it|you|u)|before it)\b/i;
/** A model line that opens with a room tag ("[owner] …"), as the fenced room it read is written. */
const LABEL_TAG = /^[^\p{L}\p{N}]*\[[a-z]+\]/iu;
/** A model line that opens with a speaker's label ("Moon Frog: …"); whose, is checked against the room. */
const LABEL_HEAD = /^[^\p{L}\p{N}]*([\p{L}\p{N}][\p{L}\p{N} '’.-]{0,59}?)\s*:\s/u;

// ── shapes ──────────────────────────────────────────────────────────────────

type Label = "open" | "join" | "hello" | "welcome" | "gm" | "gm-back" | "gn" | "call" | "call-react" | "reply" | "banter";

/** The reactions that come as a chorus to one line: at most one of them lands on a line per pass. */
const CHORUS: ReadonlySet<Label> = new Set(["gm-back", "welcome", "call-react"]);

interface Job {
  label: Label;
  prio: number;
  due: number;
  expires: number;
  /** The speaking agent's lowercased tenant; null for the room's own line. */
  speaker: string | null;
  intent: Intent | null;
  /** System lines only. */
  body: string | null;
  kind: MessageKind;
  replyTo: number | null;
  dedupeKey: string | null;
  /** Answering a line addressed to this agent: the cooldown does not apply. */
  addressed: boolean;
  /** Conversation depth of the line this job would write. */
  depth: number;
  call: CallFact | null;
  /** gm/gn only: the local day the line settles. */
  day: string | null;
  /** gn only: when the agent's window opens, to keep it quiet until then. */
  quietUntil: number | null;
  /** Held in the queue across passes, as opposed to re-detected every pass. */
  queued: boolean;
  /** Another agent's answer to this owner's line (lowercased tenant): counted against OWNER_ANSWERS_PER_HOUR. Null for the owner's own agent. */
  toOwner?: string | null;
  /** A reaction to a call: the lowercased tenant whose card it reacts to (CALL_REACT_GAP_MS, CALL_REACTS_PER_HOUR). */
  callAuthor?: string | null;
}

/** A call card in the room (postedCalls). */
interface PostedCard {
  /** The card's author, lowercased. */
  tenant: string;
  call: CallRef;
  /** When the card was posted. */
  at: number;
  /** The decision it was built from: how its fill is found in its author's facts. */
  decisionId: string | null;
  /** When its fill happened, when this process wrote the card; else read from the facts (cardFillMs). */
  fillMs: number | null;
  /**
   * The earliest and latest fill this card holds: its own, and every fill it
   * absorbed since (folded into it, or skipped as its repeat). Null until
   * first read, when spanOf walks it from the author's facts. What a paper
   * buy's fold is measured from: a schedule that keeps buying stays in its card.
   */
  span: { lo: number; hi: number } | null;
}

interface Speaker {
  tenant: string;
  facts: AgentFacts;
  tz: string | null;
  muted: boolean;
  asleep: boolean;
  /** Awake, not muted, and not winding down after its gn. */
  canSpeak: boolean;
}

interface AgentState {
  lastSpokeMs: number;
  gmDay: string | null;
  gnDay: string | null;
  /** One roll per approaching sleep window, keyed by the minute the window opens. */
  gnRoll: { at: number; yes: boolean } | null;
  quietUntilMs: number;
  /** When this agent's lines in the last hour were written. */
  hour: number[];
  /** What this agent said lately, oldest first — its own lines, so it never repeats itself (see OWN_MEMORY_MS). `card`: a call card. */
  lines: { at: number; body: string; card: boolean }[];
  /** When this agent last answered its own owner (OWN_GREET_MS); 0 when not lately. */
  ownAnsweredMs: number;
}

/** Everything one pass knows, grown as it writes. */
interface Pass {
  shared: Db;
  nowMs: number;
  speakers: Map<string, Speaker>;
  /** The room's tail, ascending, plus the lines this pass wrote. */
  room: StoredMessage[];
  /** Lines owner replies in the tail answer that the tail itself no longer holds, by id. Never reacted to. */
  parents: Map<number, StoredMessage>;
  /** Every agent name in the room: what a line is read with (classifyLine) and what the memory forgets. */
  rosterNames: string[];
  /** The names the gate strips before its digit check: the roster minus any name with a standalone number in it. */
  gateNames: string[];
  /** Every coin name and ticker on a card in the room or in anyone's facts. */
  coins: Set<string>;
  /**
   * Every card symbol and name in this pass's facts, every agent's, once
   * each: what classifyLine is handed (`coins`) so a person's free text that
   * names a coin the room trades reads as trading talk.
   */
  factCoins: string[];
  /** Per speaker: the room's coins that are not its own, as a pattern, or null. */
  foreign: Map<string, RegExp | null>;
  wrote: number;
  labels: Label[];
  modelLines: number;
  /** Model lines the gate refused (the template spoke instead). */
  modelRefused: number;
  /** Template lines the gate refused, by reason. */
  refused: Map<string, number>;
  spoke: Set<string>;
  events: string[];
  /** The room's phrase memory as of `memoryVersion`; rebuilt when a line is written. */
  memory: RoomMemory | null;
  memoryVersion: number;
  /** The room's thread-starters of the last TOPIC_MEMORY_MS as of `topicMemoryVersion`; rebuilt when one is written. */
  topicMemory: RoomMemory | null;
  topicMemoryVersion: number;
  /** Names the memory strips: every agent on the roster and every coin on a card. */
  memoryNames: string[];
  /** Lines replied to this pass that were looked up and found still standing (true) or gone or hidden (false). */
  stands: Map<number, boolean>;
  /** Lines a chorus (gm-backs, call reactions, welcomes) already answered this pass: one voice per line per pass. */
  chorused: Set<number>;
}

type Outcome = "wrote" | "keep" | "drop";

// ── small pure helpers ──────────────────────────────────────────────────────

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function count(n: unknown, fallback: number, min: number): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback;
}

/** The whole message, for classifying: a provider's "per day" can sit past the log line's cut. */
function rawMessageOf(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
}

function messageOf(e: unknown): string {
  return rawMessageOf(e).replace(/\s+/g, " ").trim().slice(0, 160) || "unknown error";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "gm-back ×2, call" — the log names what was written, never what it said. */
function summarise(labels: Label[]): string {
  const counts = new Map<Label, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l)).join(", ");
}

/** The quiet gap before somebody starts something: shorter in a busy room, sublinearly, then jittered. */
function quietGapMs(awake: number, jitter: number): number {
  const base = Math.min(QUIET_MAX_SEC, Math.max(QUIET_MIN_SEC, QUIET_BASE_SEC / Math.sqrt(Math.max(1, awake))));
  return base * (0.5 + jitter) * SEC;
}

function trimHour(list: number[], nowMs: number): void {
  const floor = nowMs - HOUR;
  let i = 0;
  while (i < list.length && list[i]! <= floor) i++;
  if (i > 0) list.splice(0, i);
}

function capMap<K, V>(m: Map<K, V>, max: number): void {
  while (m.size > max) {
    const oldest = m.keys().next();
    if (oldest.done) break;
    m.delete(oldest.value);
  }
}

function capSet<K>(s: Set<K>, max: number): void {
  while (s.size > max) {
    const oldest = s.values().next();
    if (oldest.done) break;
    s.delete(oldest.value);
  }
}

/** Each facts list's ledger ranks, by decision id: larger is later. One list per agent per pass. */
const ledgerRanks = new WeakMap<readonly CallFact[], Map<string, number>>();

/**
 * THE ORDER FILLS HAPPENED IN: by time, then — two fills in the same second —
 * by LEDGER order, the order facts.ts hands them back in (newest first, by the
 * trade's id). One order everywhere a card is weighed: which fill is due
 * first, what an earlier card a repeat is of, which fill is waiting on which.
 * The due list used to break a tie by the facts order and the repeat rule by
 * the random decision id, so a sell and the re-buy after it, filled in one
 * second, could read as buy-then-sell to one and sell-then-buy to the other:
 * the re-entry was collapsed for good, and a restart could flip it.
 */
function fillOrder(calls: readonly CallFact[]): (a: CallFact, b: CallFact) => number {
  let rank = ledgerRanks.get(calls);
  if (!rank) {
    const r = new Map<string, number>();
    calls.forEach((c, i) => {
      if (c && !r.has(c.decisionId)) r.set(c.decisionId, calls.length - i);
    });
    ledgerRanks.set(calls, r);
    rank = r;
  }
  const at = rank;
  return (a, b) => a.atSec - b.atSec || (at.get(a.decisionId) ?? 0) - (at.get(b.decisionId) ?? 0);
}

// ── the conductor ───────────────────────────────────────────────────────────

export function makeConductor(opts: ConductorOptions): Conductor {
  const creds = opts.creds ?? null;
  const rawRng = opts.rng ?? Math.random;
  const maxPerPass = count(opts.maxPerPass, 3, 1);
  const perHour = count(opts.perHour, 150, 1);
  /** Said once, in the first pass's log, when the startup scan reached its hard cap before its horizon. */
  let scanNote: string | null = null;
  const perAgentPerHour = count(opts.perAgentPerHour, 30, 1);
  // NO CREDS, NO MODEL, whatever the budget says: the budget is a ceiling on a
  // key, and there is no key.
  const llmPerDay = creds ? count(opts.llmPerDay, 800, 0) : 0;
  const retentionDays = count(opts.retentionDays, 14, 1);
  const loadRoomFacts = opts.facts ?? loadFacts;
  const dialect = opts.dialect ?? "postgres";

  /** The caller's rng, made total: a NaN or a 7 costs variety, never a throw or an index off the end. */
  const rng = (): number => {
    let v: number;
    try {
      v = Number(rawRng());
    } catch {
      v = 0.5;
    }
    if (!Number.isFinite(v)) return 0.5;
    const f = v - Math.floor(v);
    return f >= 0 && f < 1 ? f : 0;
  };
  const between = (a: number, b: number): number => a + rng() * (b - a);

  // ── lazy state ────────────────────────────────────────────────────────────

  const agents = new Map<string, AgentState>();
  const queue: Job[] = [];
  /** Dedupe keys known to be used, with when — so an attempt that would be refused is never paid for. */
  const said = new Map<string, number>();
  const depthOf = new Map<number, number>();
  const handledOwner = new Set<number>();
  const welcomed = new Set<string>();
  const nameRes = new Map<string, RegExp>();
  const roomHour: number[] = [];
  /** Every agent line of the last PHRASE_MEMORY_MS, by id: what the room's phrase memory is built from. */
  const phrases = new Map<number, { at: number; body: string }>();
  let phraseVersion = 0;
  /** What each line is, once read (voice.ts classifyLine) — so the same line is never classified twice. */
  const classes = new Map<number, LineClass>();
  /**
   * The highest line id already reacted to. Null until the first pass, which
   * reacts again only to the tail's lines of the RESTART_REPLAY_MS before the
   * previous process last ran, and since — and of those only to lines nobody
   * has answered (up to `replayTo`, the tail's top then).
   */
  let cursor: number | null = null;
  let replayTo = -1;
  /**
   * Owner lines their own agent still owes an answer: read while that agent
   * was not on this pass's roster, the room's answers already planned. Closed
   * on the first pass the agent is back (it answers, when it can), or when the
   * line is past OWNER_WINDOW_MS.
   */
  const ownerOwed = new Set<number>();
  let rebuilt = false;
  let lastPruneMs = Number.NEGATIVE_INFINITY;
  let running = false;
  let lastFail: { text: string; at: number } | null = null;
  /** The jittered quiet gap, drawn once per silence (keyed by the line the silence follows). */
  const gap = { afterId: -1, ms: 0 };
  const model = {
    day: -1,
    used: 0,
    pausedUntil: 0,
    stopped: false,
    silent: 0,
    /** A state change to report on the next log line. */
    note: null as string | null,
    /** The latest step's clock, for a failure that surfaces after its race was lost. */
    now: 0,
  };
  /**
   * THE DAILY BUDGET SURVIVES A REDEPLOY. Read once from groupchat_room before
   * the model is asked anything — until it has been read, the model is not
   * asked at all (fail closed) — and written back after any pass that changed it.
   */
  const budget = { loaded: false, saved: "" };
  /** When a keyed line last cost a model call (MODEL_RETRY_MS). */
  const modelTried = new Map<string, number>();
  /** A call whose line could not be made, and when it may be tried again. */
  const callRetryAt = new Map<string, number>();
  /** When a call's line was first refused: a later card of its coin waits for it only CALL_WAIT_MAX_MS from then. */
  const callRetrySince = new Map<string, number>();
  /**
   * Whether each card this process wrote was said as "more" of its coin
   * (boughtMore), by line id: what a reaction to it is told (Intent
   * call-react.more). Another replica's cards, or ones from before a restart,
   * are not here, and the voice reads those from the tail.
   */
  const cardMore = new Map<number, boolean>();
  /** Every agent thread-starter of the last TOPIC_MEMORY_MS, by id: what ctx.topicMemory is built from. */
  const starters = new Map<number, { at: number; body: string }>();
  let starterVersion = 0;
  /** When each newcomer was first seen (JOIN_BURST, NEWCOMER_NAME_WAIT_MS), by lowercased tenant. */
  const firstSeen = new Map<string, number>();
  /** When each held newcomer (mayAwaitName) was joined, ascending: the held wave JOIN_BURST counts over NEWCOMER_NAME_WAIT_MS. */
  const heldJoins: number[] = [];
  /** The last room summary written (without its clock), and when. */
  let lastRoom: { key: string; at: number } | null = null;
  /**
   * When each owner's lines were last answered, by lowercased owner tenant,
   * ascending — OWNER_ANSWERS_PER_HOUR. Rebuilt from the room after a
   * redeploy, so a restart hands nobody a fresh hour.
   */
  const ownerAnswers = new Map<string, number[]>();
  /**
   * The call cards posted in the last POSTED_CALLS_MS, by line id: whose,
   * what, and when. How a reaction finds whose card it reacts to
   * (CALL_REACT_GAP_MS), what a paper buy folds into (foldedInto), and what a
   * buy is "more" of (boughtMore).
   * Rebuilt from the room after a redeploy and fed by the tail, so another
   * replica's cards count too. (A repeated buy is weighed by the durable
   * "call:" keys instead: see repeatsCard.)
   */
  const postedCalls = new Map<number, PostedCard>();
  /** Calls skipped for good as repeats, by decision id: weighed once, never again. */
  const collapsed = new Set<string>();
  /** Reactions to call cards written in the last hour, by line id: when, to whose card, which card. Rebuilt after a redeploy. */
  const callReactLog = new Map<number, { at: number; author: string; callId: number }>();
  /** The subjects off-trading banter was last started on, newest last (SUBJECT_RING). */
  const recentSubjects: Subject[] = [];

  const stateOf = (tenant: string): AgentState => {
    let s = agents.get(tenant);
    if (!s) {
      s = { lastSpokeMs: 0, gmDay: null, gnDay: null, gnRoll: null, quietUntilMs: 0, hour: [], lines: [], ownAnsweredMs: 0 };
      agents.set(tenant, s);
    }
    return s;
  };

  const nameRe = (name: string): RegExp => {
    let re = nameRes.get(name);
    if (!re) {
      re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(name)}(?![\\p{L}\\p{N}_])`, "iu");
      nameRes.set(name, re);
      capMap(nameRes, 1000);
    }
    return re;
  };

  /**
   * WHERE A LINE FIRST NAMES THIS AGENT, as opposed to its owner, or -1.
   * Every answer to an owner opens "hey Amber Heron's owner", and counting that
   * as naming Amber Heron had the agent answering lines that were never meant
   * for it. The owner's label is blanked to the same length, so the position
   * is the name's place in the line.
   */
  const mentionAt = (name: string, body: string): number => {
    const m = nameRe(name).exec(body.replace(new RegExp(`${escapeRe(name)}['’]s owner`, "giu"), (s) => " ".repeat(s.length)));
    return m ? m.index : -1;
  };
  const namesAgent = (name: string, body: string): boolean => mentionAt(name, body) >= 0;

  const roomFull = (nowMs: number): boolean => {
    trimHour(roomHour, nowMs);
    return roomHour.length >= perHour;
  };

  /** Answers to this owner's lines written in the last hour. */
  const ownerAnswered = (owner: string, nowMs: number): number => {
    const list = ownerAnswers.get(owner);
    if (!list) return 0;
    trimHour(list, nowMs);
    if (list.length === 0) ownerAnswers.delete(owner);
    return list.length;
  };

  /** How many more answers this owner's lines may draw this hour: written and still queued both count. */
  const ownerAnswersLeft = (owner: string, nowMs: number): number =>
    OWNER_ANSWERS_PER_HOUR - ownerAnswered(owner, nowMs) - queue.filter((j) => j.toOwner === owner && j.expires > nowMs).length;

  /**
   * THE ROOM'S DICE, WEIGHTED TOWARD WHOEVER HAS SAID LEAST (FAIR_QUIET_CAP_MS).
   * A random order, not a rota: each agent's place is an exponential clock
   * run at its weight (Efraimidis–Spirakis), so the quiet one is likelier to
   * come first and anybody can.
   */
  const fairWeight = (nowMs: number, tenant: string): number => {
    const st = stateOf(tenant);
    trimHour(st.hour, nowMs);
    const quiet = Math.min(Math.max(0, nowMs - st.lastSpokeMs), FAIR_QUIET_CAP_MS);
    return (quiet + MIN) / MIN / (1 + st.hour.length) ** 2;
  };
  const fairOrder = (nowMs: number, list: Speaker[]): Speaker[] =>
    list
      .map((sp) => ({ sp, key: Math.log(1 - rng()) / fairWeight(nowMs, sp.tenant) }))
      .sort((a, b) => b.key - a.key)
      .map((x) => x.sp);

  // ── calls: one card per move, and a room that does not pile on ──────────

  function notePostedCall(
    m: { id: number; tenant: string; call: CallRef | null; createdAtMs: number; callDecisionId: string | null },
    fillMs: number | null = null,
  ): void {
    if (!m.call || postedCalls.has(m.id)) return;
    postedCalls.set(m.id, { tenant: m.tenant.toLowerCase(), call: m.call, at: m.createdAtMs, decisionId: m.callDecisionId, fillMs, span: null });
  }

  /** A reaction to the card `callId`, noted once by its own line id (a written one, the tail's, or a rebuilt one). */
  function noteCallReact(id: number, at: number, callId: number): void {
    if (callReactLog.has(id)) return;
    const card = postedCalls.get(callId);
    if (!card) return;
    callReactLog.set(id, { at, author: card.tenant, callId });
  }

  function pruneCalls(nowMs: number): void {
    for (const [id, c] of postedCalls) if (c.at <= nowMs - POSTED_CALLS_MS) postedCalls.delete(id);
    for (const [id, r] of callReactLog) if (r.at <= nowMs - HOUR) callReactLog.delete(id);
    capMap(postedCalls, MEMO_MAX);
    capMap(callReactLog, MEMO_MAX);
    capSet(collapsed, MEMO_MAX);
    capMap(callRetrySince, MEMO_MAX);
    capMap(cardMore, MEMO_MAX);
  }

  /**
   * Whether `call` only repeats this agent's previous card for the same coin:
   * the card of the latest EARLIER fill of that coin that was posted, within
   * CALL_REPEAT_MS, on the same side and the same paper or live. So buy, sell,
   * buy is three cards and buy, buy is one.
   *
   * BY FILL, NOT BY WHEN THE CARD LANDED. Cards are posted oldest fill first,
   * and a buy collapsed before a later live card existed must still be a repeat
   * of the paper card before it when a restarted process weighs it again —
   * compared with the newest card instead, a restart posted it.
   * "Posted" is the durable dedupe key ("call:<decision>"), rebuilt from the
   * room after a redeploy and learned from the tail for another replica's cards;
   * the fill behind it is in the facts however busy the book (facts.ts keeps
   * a posted call past its per-agent cut). Earlier and later by fillOrder.
   *
   * NOT A REPEAT WHEN THE BOOK TURNED IN BETWEEN (turnedUnheard): a buy after
   * a sell the room has not heard yet is a re-entry, not more of the buy card.
   *
   * The earlier fill it repeats, or null: its card absorbs this one (absorb).
   */
  function repeatsCard(sp: Speaker, call: CallFact, nowMs: number): CallFact | null {
    const prev = postedBefore(sp, call);
    if (prev === null || prev.side !== call.side || (prev.paper === true) !== (call.paper === true)) return null;
    return turnedUnheard(sp, prev, call, nowMs) ? null : prev;
  }

  /** This agent's latest EARLIER fill of this coin that has its card, within CALL_REPEAT_MS: what `call` is weighed against, or null. */
  function postedBefore(sp: Speaker, call: CallFact): CallFact | null {
    const order = fillOrder(sp.facts.calls);
    let prev: CallFact | null = null;
    for (const o of sp.facts.calls) {
      if (!o || o.decisionId === call.decisionId || !sameCoin(o, call)) continue;
      if (order(o, call) >= 0) continue;
      if ((call.atSec - o.atSec) * SEC >= CALL_REPEAT_MS) continue;
      if (!said.has(`call:${o.decisionId}`)) continue;
      if (!prev || order(o, prev) > 0) prev = o;
    }
    return prev;
  }

  /**
   * WHETHER THE BOOK TURNED BETWEEN TWO FILLS WITHOUT THE ROOM HEARING IT: a
   * fill of this coin on the OTHER side, in the same book, after `anchor` and
   * before `call`, whose card is not out yet and still could be (not
   * collapsed, inside CALL_WINDOW_MS). A live buy's card, a sell whose line was
   * refused, a re-buy: past CALL_WAIT_MAX_MS the re-buy was weighed against
   * the buy card, collapsed as its repeat for good, and the sell was posted
   * when its line could be made — the room's last card said "sold" while the
   * book held the coin. Told as the re-entry it is, the re-buy's card passes
   * the sell over (passedOver), as CALL_WAIT_MAX_MS promises. A turn that can
   * never be told any more changes nothing the room would read. With no
   * anchor (no card of the coin to weigh against), any such turn before the
   * fill counts.
   */
  function turnedUnheard(sp: Speaker, anchor: CallFact | null, call: CallFact, nowMs: number): boolean {
    const order = fillOrder(sp.facts.calls);
    return sp.facts.calls.some(
      (o) =>
        !!o &&
        o.side !== call.side &&
        (o.paper === true) === (call.paper === true) &&
        sameCoin(o, call) &&
        (anchor === null || order(o, anchor) > 0) &&
        order(o, call) < 0 &&
        nowMs - o.atSec * SEC <= CALL_WINDOW_MS &&
        !said.has(`call:${o.decisionId}`) &&
        !collapsed.has(o.decisionId),
    );
  }

  /**
   * WHETHER A LATER FILL OF THIS COIN ALREADY HAS ITS CARD, either side. Cards
   * of one coin go out oldest fill first (the wait in detected()), so an
   * unsaid fill older than a posted one was weighed, or passed over, by
   * whoever posted the later card — this process before a restart, another
   * replica, or the wait giving up on it (CALL_WAIT_MAX_MS). Told now, it
   * would be old news out of order: "sold WIF" under the re-entry that
   * followed it. Skipped for good. This is also what keeps a redeploy from
   * posting a fill the old process collapsed: its later card is still there.
   */
  function passedOver(sp: Speaker, call: CallFact): boolean {
    const order = fillOrder(sp.facts.calls);
    return sp.facts.calls.some(
      (o) => !!o && o.decisionId !== call.decisionId && sameCoin(o, call) && order(o, call) > 0 && said.has(`call:${o.decisionId}`),
    );
  }

  /**
   * WHETHER A BUY IS MORE OF A COIN THE ROOM SAW THIS AGENT BUY (voice.ts
   * Intent call.more): its latest POSTED card of the coin in this book was a
   * buy, and no posted card of the coin since was a sell. Read from the facts
   * alone, "more" counted every earlier buy — a collapsed one, one folded into
   * another card, one a posted sell had since closed — and the room read
   * "added more NVIDIA" right after "took NVIDIA off the table". The card the
   * room saw is what "more" is more of.
   *
   * READ FROM THE CARDS IN THE ROOM (postedCalls), NOT FROM THE FACTS. A top-up
   * is folded for a day (TOP_UP_FOLD_MS) and the ledger is read for twelve
   * hours, so the fill behind the card a day-later top-up is more of is no
   * longer in the facts; the card is still in the room, and is remembered —
   * across a redeploy too — for POSTED_CALLS_MS. Cards of one coin go out
   * oldest fill first, so the latest card is the latest posted fill.
   *
   * The card it is more of, or null.
   */
  function boughtMore(sp: Speaker, call: CallFact): PostedCard | null {
    if (call.side !== "buy") return null;
    let last: PostedCard | null = null;
    let lastSell = Number.NEGATIVE_INFINITY;
    for (const card of postedCalls.values()) {
      if (card.tenant !== sp.tenant || card.decisionId === call.decisionId || !sameCoin(card.call, call)) continue;
      if (card.call.side === "sell") lastSell = Math.max(lastSell, card.at);
      if ((card.call.paper === true) !== (call.paper === true)) continue;
      if (!last || card.at > last.at) last = card;
    }
    return last !== null && last.call.side === "buy" && !(lastSell > last.at) ? last : null;
  }

  /** Whether `tenant`'s facts hold a fill of this coin on this side within `gapMs` of this one: a move that bought it too. */
  function filledAlike(p: Pass, tenant: string, call: CallFact, gapMs: number): boolean {
    const f = p.speakers.get(tenant)?.facts;
    if (!f) return false;
    // Paper with paper, like the card it folds into (foldedInto).
    return f.calls.some((o) => !!o && o.side === call.side && (o.paper === true) === (call.paper === true) && sameCoin(o, call) && Math.abs(o.atSec - call.atSec) * SEC <= gapMs);
  }

  /**
   * When the fill behind a card happened: known when this process wrote the
   * card, else found in its author's facts by decision. An author this replica
   * does not run, or a fill past the facts window, is estimated by when the
   * card was posted — a card goes out at its fill unless its author was asleep.
   */
  function cardFillMs(p: Pass, card: PostedCard): number {
    if (card.fillMs !== null) return card.fillMs;
    const fill = card.decisionId === null ? undefined : p.speakers.get(card.tenant)?.facts.calls.find((c) => !!c && c.decisionId === card.decisionId);
    return fill ? fill.atSec * SEC : card.at;
  }

  /** A paper buy card: the only kind a fill is folded into for good, and so the only kind whose span grows. */
  const paperBuy = (card: PostedCard): boolean => card.call.side === "buy" && card.call.paper === true;

  /**
   * The fills a card holds, earliest and latest (PostedCard.span): its own
   * fill, widened by every fill it absorbed. A live card or a sell holds its
   * own fill only: nothing is folded into it for good but a paper buy's echo.
   *
   * SEEDED FROM ITS AUTHOR'S FACTS WHEN THIS PROCESS HAS NOT WATCHED IT GROW —
   * a card from before a restart, or another replica's. A restart forgets
   * every span, and re-weighs every unsaid fill of the last six hours one
   * agent at a time: a book weighed before the card's author found the card
   * holding its first fill only, and posted its hours-old buy as news. So a
   * paper buy card's span is walked from its fill through its author's later
   * fills, taking each one it would have absorbed — a paper buy within
   * BASKET_TICK_MS of what it holds, or a top-up of its own coin inside
   * TOP_UP_FOLD_MS — and never past a sell of that fill's coin (a re-entry is
   * its own card). Kept once walked; absorb() widens it from there. Not kept
   * while its author is off the roster: there is nothing to walk yet.
   */
  function spanOf(p: Pass, card: PostedCard): { lo: number; hi: number } {
    if (card.span) return card.span;
    const at = cardFillMs(p, card);
    const span = { lo: at, hi: at };
    const facts = p.speakers.get(card.tenant)?.facts;
    if (!paperBuy(card) || !facts) return span;
    const later = facts.calls.filter((c) => !!c && c.atSec * SEC > at).sort(fillOrder(facts.calls));
    const sold: CallFact[] = [];
    for (const c of later) {
      if (c.side === "sell") {
        sold.push(c);
        continue;
      }
      if (c.paper !== true || sold.some((s) => sameCoin(s, c))) continue;
      const topUp = sameCoin(c, card.call) && c.atSec * SEC - card.at <= TOP_UP_FOLD_MS;
      if (topUp || c.atSec * SEC - span.hi <= BASKET_TICK_MS) span.hi = Math.max(span.hi, c.atSec * SEC);
    }
    card.span = span;
    return span;
  }

  /** Whether a card holds a fill within `gapMs` of `atMs`. */
  function holdsNear(p: Pass, card: PostedCard, atMs: number, gapMs: number): boolean {
    const s = spanOf(p, card);
    return atMs >= s.lo - gapMs && atMs <= s.hi + gapMs;
  }

  /**
   * WHETHER THIS PAPER BUY CONTINUES THIS AGENT'S OWN SCHEDULE: its previous
   * paper buy of the coin lies within BASKET_TICK_MS before it and was not
   * posted (folded, or skipped) — or the facts, cut at CALLS_PER_AGENT, do not
   * reach back that far, and the fill before it cannot be seen. Only such a
   * fill is weighed against the whole span of another agent's card: a one-off
   * buy measured against a basket's grown span was folded, for good, into a
   * card from hours before, and its owner never saw the trade. Read from the
   * facts and the room's dedupe keys: nothing stored, and the same after a
   * restart.
   */
  function continuesRun(sp: Speaker, call: CallFact): boolean {
    const calls = sp.facts.calls;
    const filled = call.atSec * SEC;
    const order = fillOrder(calls);
    const prev = calls.some(
      (o) =>
        !!o &&
        o.decisionId !== call.decisionId &&
        o.side === "buy" &&
        o.paper === true &&
        sameCoin(o, call) &&
        order(o, call) < 0 &&
        filled - o.atSec * SEC <= BASKET_TICK_MS &&
        !said.has(`call:${o.decisionId}`),
    );
    if (prev || calls.length < CALLS_PER_AGENT) return prev;
    const floor = Math.min(...calls.slice(0, CALLS_PER_AGENT).map((c) => (c ? c.atSec * SEC : Number.POSITIVE_INFINITY)));
    return filled - BASKET_TICK_MS < floor;
  }

  /** A fill a paper buy card stands for now — folded into it, or skipped as its repeat — widens what it holds. */
  function absorb(p: Pass, card: PostedCard | null, call: CallFact): void {
    if (!card || !paperBuy(card)) return;
    const s = spanOf(p, card);
    const at = call.atSec * SEC;
    card.span = { lo: Math.min(s.lo, at), hi: Math.max(s.hi, at) };
  }

  /** This agent's card for the fill `decisionId`, while the room remembers it. */
  function cardOf(tenant: string, decisionId: string): PostedCard | null {
    for (const card of postedCalls.values()) if (card.tenant === tenant && card.decisionId === decisionId) return card;
    return null;
  }

  /**
   * A PAPER BUY FOLDED INTO A CARD ALREADY IN THE ROOM, measured from the
   * fills the card holds (spanOf), and the card it folds into, or null:
   *   - one of this agent's own BUY cards that holds a fill within
   *     BASKET_TICK_MS of it: one tick of a basket is one card, and a schedule
   *     that keeps buying stays in it. A BUY card only: a re-entry right after
   *     the agent's own sell was folded into "just sold NVDA" and never told,
   *     and docs/groupchat.md says buy, sell, buy is three cards;
   *   - another agent's card that holds a fill within the quarter hour of this
   *     one (CALL_ECHO_GAP_MS), for this coin on this side or for a move that
   *     bought it too. The fills, not "any card posted since": a sleeper's
   *     overnight buy was folded into another agent's card of the coin posted
   *     two hours after it, and its own card was never posted. Lockstep books
   *     and a sleeper's same-tick fill still fold. All the card holds only
   *     for a fill that continues this agent's own schedule (continuesRun);
   *     else that card's own fill;
   *   - or, a top-up: this agent's latest card of this coin is a paper buy of
   *     it posted less than TOP_UP_FOLD_MS before the fill.
   *
   * A RE-ENTRY IS NEVER FOLDED. When this agent's latest card of this coin is
   * a sell, the buy is news whatever card it would fold into. "A BUY card
   * only" skipped the sell card and still found the buy card from before it:
   * a paper buy, a sell two minutes before the re-buy and the re-buy, all in
   * half an hour, posted "made a buy: NVIDIA" and "let go of NVDA", and the
   * book held NVDA. A morning backlog did it for every overnight re-entry,
   * because each of its cards is posted minutes before the next fill is
   * weighed. Latest by line id: cards of one coin go out oldest fill first.
   *
   * NOR ONE AFTER A SELL THE ROOM HAS NOT HEARD (turnedUnheard), weighed from
   * the card before it — the fill it would repeat, else this agent's latest
   * card of the coin. A paper buy's card, a sell whose line was refused past
   * CALL_WAIT_MAX_MS, and the re-buy: the buy card was still "the latest", so
   * the re-buy folded into it (inside the basket's tick) or as its top-up, for
   * good, and the sell was posted when its line could be made — the room's
   * last card said "sold" while the book held the coin. Told, the re-buy
   * passes the sell over, as a live one already did.
   */
  function foldedInto(p: Pass, sp: Speaker, call: CallFact): PostedCard | null {
    if (call.side !== "buy" || call.paper !== true) return null;
    const tenant = sp.tenant;
    const filled = call.atSec * SEC;
    let latest: PostedCard | null = null;
    let latestId = -1;
    for (const [id, card] of postedCalls) {
      if (card.tenant === tenant && id > latestId && sameCoin(card.call, call)) {
        latest = card;
        latestId = id;
      }
    }
    if (latest?.call.side === "sell") return null;
    if (turnedUnheard(sp, postedBefore(sp, call) ?? (latest ? anchorOf(p, sp, latest) : null), call, p.nowMs)) return null;
    const onRun = continuesRun(sp, call);
    for (const card of postedCalls.values()) {
      // A PAPER FILL FOLDS ONLY INTO A PAPER BUY CARD, its own or another agent's.
      // A paper buy inside BASKET_TICK_MS of the agent's own LIVE buy was
      // folded into the live card and never told: two different kinds of
      // money in one card, and the paper fill's provenance lost.
      // Nor into another agent's sell because its ledger also holds a nearby
      // buy: that sell never told the room about the bought coin.
      if (!paperBuy(card)) continue;
      if (card.tenant === tenant) {
        if (holdsNear(p, card, filled, BASKET_TICK_MS)) return card;
        continue;
      }
      if (onRun ? !holdsNear(p, card, filled, CALL_ECHO_GAP_MS) : Math.abs(cardFillMs(p, card) - filled) > CALL_ECHO_GAP_MS) continue;
      if ((card.call.side === call.side && sameCoin(card.call, call)) || filledAlike(p, card.tenant, call, CALL_ECHO_GAP_MS)) return card;
    }
    if (latest === null) return basketOf(p, sp, call, filled - TOP_UP_FOLD_MS);
    return latest.call.side === "buy" && latest.call.paper === true && latest.at >= filled - TOP_UP_FOLD_MS ? latest : null;
  }

  /**
   * A BASKET'S OTHER COIN, TOPPED UP: this agent's own paper buy card, posted
   * since `sinceMs`, that holds this agent's latest earlier buy of the coin —
   * folded into the card of its tick — when the agent has no card of the coin
   * itself and did not sell it since. A book buying TSLA and NVDA all day had
   * its NVDA in its TSLA card, and after a half hour's pause posted "new bag:
   * NVDA" for a coin it had held since the morning. So the buy is a top-up of
   * that card (foldedInto, for TOP_UP_FOLD_MS), and "more" when it is told
   * (detected).
   */
  function basketOf(p: Pass, sp: Speaker, call: CallFact, sinceMs: number): PostedCard | null {
    if (call.side !== "buy") return null;
    for (const card of postedCalls.values()) if (card.tenant === sp.tenant && sameCoin(card.call, call)) return null;
    const order = fillOrder(sp.facts.calls);
    let prev: CallFact | null = null;
    for (const o of sp.facts.calls) {
      if (!o || o.decisionId === call.decisionId || !sameCoin(o, call) || order(o, call) >= 0) continue;
      if (!prev || order(o, prev) > 0) prev = o;
    }
    if (!prev || prev.side !== "buy" || (prev.paper === true) !== (call.paper === true)) return null;
    const at = prev.atSec * SEC;
    for (const card of postedCalls.values()) {
      if (card.tenant !== sp.tenant || !paperBuy(card) || card.at < sinceMs) continue;
      const s = spanOf(p, card);
      if (at >= s.lo && at <= s.hi) return card;
    }
    return null;
  }

  /** A card's fill as the anchor turnedUnheard weighs from: the fill itself when the facts hold it, else its time. */
  function anchorOf(p: Pass, sp: Speaker, card: PostedCard): CallFact {
    const fill = card.decisionId === null ? undefined : sp.facts.calls.find((c) => !!c && c.decisionId === card.decisionId);
    if (fill) return fill;
    return { ...card.call, decisionId: card.decisionId ?? "", atSec: Math.floor(cardFillMs(p, card) / SEC), bands: [], ownWords: null };
  }

  /**
   * Whether the call `key` is being retried (its line was refused) and a later
   * card of its coin should still wait for it: only until CALL_WAIT_MAX_MS
   * after its first refusal.
   */
  const heldBack = (key: string, nowMs: number): boolean =>
    (callRetryAt.get(key) ?? 0) > nowMs && nowMs - (callRetrySince.get(key) ?? nowMs) < CALL_WAIT_MAX_MS;

  /**
   * Whether a card for a fill made while its agent slept waits a pass for its
   * backlog to trickle in (BACKLOG_GAP_MS): this agent's previous card went
   * out less than the gap ago, and the wait still leaves the fill inside its
   * window. Read from the room's cards, so a redeploy keeps the pace.
   */
  function pacedBacklog(sp: Speaker, call: CallFact, nowMs: number): boolean {
    const filled = call.atSec * SEC;
    if (!isAsleep(sp.tz, sp.tenant, filled)) return false;
    let last = Number.NEGATIVE_INFINITY;
    for (const card of postedCalls.values()) if (card.tenant === sp.tenant && card.at > last) last = card.at;
    const until = last + BACKLOG_GAP_MS;
    return nowMs < until && until - filled < CALL_WINDOW_MS - MIN;
  }

  /** Reactions to calls written in this rolling hour. */
  const callReactsWritten = (nowMs: number): number => {
    let written = 0;
    for (const r of callReactLog.values()) if (r.at > nowMs - HOUR) written++;
    return written;
  };

  /** How many more reactions to calls this hour allows: written and still queued both count. */
  const callReactsLeft = (nowMs: number): number =>
    CALL_REACTS_PER_HOUR - callReactsWritten(nowMs) - queue.filter((j) => !!j.callAuthor && j.expires > nowMs).length;

  /** Whether another of `author`'s cards was reacted to lately, or has reactions still waiting. */
  const reactedLately = (author: string, callId: number, nowMs: number): boolean => {
    for (const r of callReactLog.values()) if (r.author === author && r.callId !== callId && nowMs - r.at < CALL_REACT_GAP_MS) return true;
    return queue.some((j) => j.callAuthor === author && j.replyTo !== callId && j.expires > nowMs);
  };

  /** Whether one more reaction to this card may be said now: the room's hour and the author's gap both allow it. */
  const mayReactTo = (card: StoredMessage, nowMs: number): boolean =>
    callReactsLeft(nowMs) > 0 && !reactedLately(card.tenant.toLowerCase(), card.id, nowMs);

  /**
   * WHETHER A CARD'S AUTHOR HAS SINCE POSTED A NEWER CARD OF ITS COIN: the card
   * is old news, and a reaction to it would land under the newer one ("stepped
   * out of Dogwifhat", "just bought WIF", then "a clean goodbye" to the sell).
   * Read from the room's cards (postedCalls), which hold this process's cards
   * and another replica's alike.
   */
  function cardReplaced(cardId: number, author: string, call: CallRef): boolean {
    for (const [id, card] of postedCalls) if (id > cardId && card.tenant === author && sameCoin(card.call, call)) return true;
    return false;
  }

  /** A queued or planned reaction to a card its author has since replaced (cardReplaced). */
  const staleReact = (j: Job): boolean =>
    !!j.callAuthor && j.replyTo !== null && j.intent?.kind === "call-react" && cardReplaced(j.replyTo, j.callAuthor, j.intent.call);

  /** An off-trading subject the room has not had in its last few (SUBJECT_RING), uniformly. */
  function nextSubject(): Subject {
    const fresh = SUBJECTS.filter((s) => !recentSubjects.includes(s));
    const pool: readonly Subject[] = fresh.length > 0 ? fresh : SUBJECTS;
    const s = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!;
    recentSubjects.push(s);
    while (recentSubjects.length > SUBJECT_RING) recentSubjects.shift();
    return s;
  }

  // ── the room's phrase memory ──────────────────────────────────────────────

  function notePhrase(id: number, at: number, body: string): void {
    if (phrases.has(id)) return;
    phrases.set(id, { at, body });
    phraseVersion += 1;
  }

  function prunePhrases(nowMs: number): void {
    const floor = nowMs - PHRASE_MEMORY_MS;
    for (const [id, l] of phrases) if (l.at <= floor) phrases.delete(id);
    // Ids ascend with time, so the oldest go first when the cap binds.
    if (phrases.size > PHRASE_MEMORY_MAX) {
      const ids = [...phrases.keys()].sort((a, b) => a - b);
      for (const id of ids.slice(0, phrases.size - PHRASE_MEMORY_MAX)) phrases.delete(id);
    }
  }

  /** The memory every line of this pass is checked against, rebuilt only when a line was written since. */
  function memoryOf(p: Pass): RoomMemory {
    if (!p.memory || p.memoryVersion !== phraseVersion) {
      p.memory = roomMemory(
        [...phrases.values()].map((l) => l.body),
        p.memoryNames,
      );
      p.memoryVersion = phraseVersion;
    }
    return p.memory;
  }

  /** An agent line that starts a thread (TOPIC_MEMORY_MS): chat, answering nothing. Cards, gms and gns are not topics. */
  const isStarter = (m: { authorKind: string; replyTo: number | null; kind: MessageKind }): boolean =>
    m.authorKind === "agent" && m.replyTo === null && m.kind === "chat";

  function noteStarter(id: number, at: number, body: string): void {
    if (starters.has(id)) return;
    starters.set(id, { at, body });
    starterVersion += 1;
  }

  function pruneStarters(nowMs: number): void {
    const floor = nowMs - TOPIC_MEMORY_MS;
    let dropped = false;
    for (const [id, l] of starters) {
      if (l.at <= floor) {
        starters.delete(id);
        dropped = true;
      }
    }
    if (starters.size > TOPIC_MEMORY_MAX) {
      const ids = [...starters.keys()].sort((a, b) => a - b);
      for (const id of ids.slice(0, starters.size - TOPIC_MEMORY_MAX)) starters.delete(id);
      dropped = true;
    }
    if (dropped) starterVersion += 1;
  }

  /** The room's two days of thread-starters (ctx.topicMemory), rebuilt only when one was written or aged out since. */
  function topicMemoryOf(p: Pass): RoomMemory {
    if (!p.topicMemory || p.topicMemoryVersion !== starterVersion) {
      p.topicMemory = roomMemory(
        [...starters.values()].map((l) => l.body),
        p.memoryNames,
      );
      p.topicMemoryVersion = starterVersion;
    }
    return p.topicMemory;
  }

  /**
   * What a line is. A call is its card; a gm or gn is its kind; the rest is read
   * from the words — told who wrote it and which coins the room trades, so an
   * owner's free text that talks trading is read as trading talk, not as a
   * topic or a take (voice.ts).
   */
  function classOf(p: Pass, m: StoredMessage): LineClass {
    const known = classes.get(m.id);
    if (known) return known;
    // AN OWNER'S LINE UNDER A CARD is read with the card, by a late reader
    // too (answerOwners); one under an agent's question, as its answer (answersOf).
    const parent = m.authorKind === "owner" ? parentOf(p, m) : null;
    const under = underOf(parent);
    const answers = m.authorKind === "owner" ? answersOf(p, parent, m.body) : null;
    const cls = classifyLine(m.body, { call: m.call, kind: m.kind, names: p.rosterNames, author: m.authorKind, coins: p.factCoins, under, answers });
    classes.set(m.id, cls);
    capMap(classes, MEMO_MAX);
    return cls;
  }

  // ── the model ─────────────────────────────────────────────────────────────

  const noteFailure = (e: unknown): void => {
    const raw = rawMessageOf(e);
    const kind = describeLlmFailure(messageOf(e)).kind;
    if (kind === "key-rejected" || kind === "model-missing") {
      // A KEY THAT WAS REFUSED STAYS REFUSED until somebody changes it, and
      // that takes a restart. Asking again every line would spend a request to
      // learn the same thing — templates carry on either way.
      if (!model.stopped) model.note = `model off until restart (${kind})`;
      model.stopped = true;
      return;
    }
    if (kind === "rate-limited") {
      if (DAILY_CAP.test(raw)) {
        // THE PROVIDER'S DAY IS SPENT: nothing changes until it turns over.
        model.pausedUntil = Math.max(model.pausedUntil, (Math.floor(model.now / DAY) + 1) * DAY);
        model.silent = 0;
        model.note = "model paused until UTC midnight (daily cap)";
        return;
      }
      // THE HOUSE ALLOWANCE IS NOT OURS TO EXHAUST. Even on a dedicated key a
      // 429 means back off; fifteen minutes of templates costs nothing.
      model.pausedUntil = model.now + MODEL_PAUSE_MS;
      model.silent = 0;
      model.note = "model paused 15m (rate-limited)";
      return;
    }
    model.silent += 1;
    if (model.silent >= SILENT_MODEL_LIMIT) {
      model.pausedUntil = model.now + MODEL_PAUSE_MS;
      model.silent = 0;
      model.note = `model paused 15m (${kind} ×${SILENT_MODEL_LIMIT})`;
    }
  };

  /**
   * THE DEFAULT MODEL, WITH ITS FAILURES MADE VISIBLE. llmLine swallows every
   * error into null — the right contract for a line, the wrong one for a
   * budget — so it is handed an observer that sees the provider's error before
   * it becomes silence. Through llmLine's own seam, not by wrapping llmText
   * here: voice.ts is the room's one importer of llm.ts. A failure that lands
   * after llmLine's timeout still reaches the observer, against the latest clock.
   */
  const defaultLlm = (c: LlmCreds, intent: Intent, ctx: SpeakCtx, onFailure: (e: unknown) => void): Promise<string | null> =>
    llmLine(c, intent, ctx, { onError: onFailure });

  const modelReady = (nowMs: number): boolean =>
    creds !== null && budget.loaded && !model.stopped && nowMs >= model.pausedUntil && model.used < llmPerDay;

  const budgetJson = (): string => JSON.stringify({ day: model.day, used: model.used, pausedUntil: model.pausedUntil });

  /** Today's spend and any 429 pause as another process of this room left them. Only with creds: no key, no row. */
  async function loadBudget(shared: Db): Promise<void> {
    if (!creds || budget.loaded) return;
    const row = (await shared.prepare("SELECT v FROM groupchat_room WHERE k = ?").get(BUDGET_KEY)) as { v: string } | undefined;
    type Stored = { day?: unknown; used?: unknown; pausedUntil?: unknown };
    let stored: Stored | null = null;
    try {
      const v: unknown = row ? JSON.parse(row.v) : null;
      stored = v && typeof v === "object" ? (v as Stored) : null;
    } catch {
      stored = null;
    }
    if (stored && Number(stored.day) === model.day) {
      const used = Number(stored.used);
      const paused = Number(stored.pausedUntil);
      if (Number.isFinite(used)) model.used = Math.max(model.used, Math.floor(used));
      if (Number.isFinite(paused)) model.pausedUntil = Math.max(model.pausedUntil, paused);
    }
    budget.loaded = true;
    budget.saved = budgetJson();
  }

  /** One small upsert, only when the spend or the pause changed. Column-scoped, like writeRoom's. */
  async function saveBudget(shared: Db, nowMs: number): Promise<void> {
    if (!creds || !budget.loaded) return;
    const v = budgetJson();
    if (v === budget.saved) return;
    await shared
      .prepare(
        `INSERT INTO groupchat_room (k, v, updated_at_ms) VALUES (?, ?, ?)
         ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(BUDGET_KEY, v, Math.floor(nowMs));
    budget.saved = v;
  }

  async function askModel(p: Pass, intent: Intent, ctx: SpeakCtx): Promise<string | null> {
    if (!creds || !modelReady(p.nowMs)) return null;
    model.used += 1;
    let failed = false;
    const onFailure = (e: unknown) => {
      failed = true;
      noteFailure(e);
    };
    let out: string | null;
    try {
      out = opts.llm ? await opts.llm(creds, intent, ctx) : await defaultLlm(creds, intent, ctx, onFailure);
    } catch (e) {
      onFailure(e);
      return null;
    }
    if (typeof out === "string" && out.trim() !== "") {
      model.silent = 0;
      return out;
    }
    if (!failed) {
      model.silent += 1;
      if (model.silent >= SILENT_MODEL_LIMIT) {
        model.pausedUntil = p.nowMs + MODEL_PAUSE_MS;
        model.silent = 0;
        model.note = `model paused 15m (no answer ×${SILENT_MODEL_LIMIT})`;
      }
    }
    return null;
  }

  // ── lines ─────────────────────────────────────────────────────────────────

  /** The owner of this speaker said something in the room lately: the one thing that says they are up. */
  const ownerHere = (p: Pass, sp: Speaker): boolean =>
    p.room.some((m) => m.authorKind === "owner" && m.tenant.toLowerCase() === sp.tenant && p.nowMs - m.createdAtMs < OWNER_PRESENT_MS);

  function speakCtx(p: Pass, sp: Speaker): SpeakCtx {
    const here = [...p.speakers.values()].filter((s) => s.canSpeak && s.tenant !== sp.tenant && !STANDALONE_NUMBER.test(s.facts.name));
    const own = stateOf(sp.tenant).ownAnsweredMs;
    let lastLine = -Infinity;
    for (const m of p.room) if (m.createdAtMs <= p.nowMs && m.createdAtMs > lastLine) lastLine = m.createdAtMs;
    return {
      speaker: sp.facts,
      style: styleFor(sp.facts.slug ?? sp.facts.name),
      tail: p.room.slice(-PROMPT_TAIL).map((m) => ({ name: m.speakerName, author: m.authorKind, body: m.body })),
      // THE WHOLE ROOM'S NAMES FOR THE GATE, which strips every agent name
      // before its digit check — minus any that is a figure (see
      // STANDALONE_NUMBER); only the ones who are HERE may be addressed.
      rosterNames: p.gateNames,
      addressable: here.map((s) => s.facts.name),
      phase: phaseOf(sp.tz, p.nowMs),
      // TRUE ONLY ON EVIDENCE, never "asleep" from a clock (OWNER_PRESENT_MS).
      ownerAwake: ownerHere(p, sp) ? true : null,
      memory: memoryOf(p),
      topicMemory: topicMemoryOf(p),
      answeredOwnerLately: own > 0 && p.nowMs - own < OWN_GREET_MS,
      quiet: here.filter((s) => p.nowMs - stateOf(s.tenant).lastSpokeMs >= PEER_QUIET_MS).map((s) => s.facts.name),
      // An empty room says nothing about how long it has been quiet.
      ...(Number.isFinite(lastLine) ? { roomQuietMs: p.nowMs - lastLine } : {}),
      // What the gate will weigh a repeat against, so the voice can see it too.
      ownRecent: ownRecentOf(p, sp),
    };
  }

  /**
   * This speaker's own lines the gate weighs a repeat against: the room's, and
   * the ones this process remembers for OWN_MEMORY_MS. `cards: false` leaves
   * its call cards out (cardsAside).
   */
  function ownRecentOf(p: Pass, sp: Speaker, cards = true): string[] {
    const own = new Set(
      p.room.filter((m) => m.authorKind === "agent" && m.tenant.toLowerCase() === sp.tenant && (cards || m.kind !== "call")).map((m) => m.body),
    );
    const floor = p.nowMs - OWN_MEMORY_MS;
    for (const l of stateOf(sp.tenant).lines) if (l.at > floor && (cards || !l.card)) own.add(l.body);
    return [...own];
  }

  /**
   * THE GATE FOR A CARD WHOSE EVERY PHRASING WAS REFUSED AS A REPEAT: weighed
   * against the room's chat, not its cards. A live flipper woke to a backlog
   * of one coin, and its third overnight sell found every "sold WALLET in my
   * sleep" phrasing, and the last resort, refused as a repeat of its own
   * earlier cards: the sell was never told, and the room read buy, buy. A card
   * is a ledger fact, said once per fill by its "call:<decision>" key, and a
   * fact is told even when its words were said (MUST_SAY). Only after the
   * ordinary gate refused every draw, so a phrasing the room has not had is
   * still preferred.
   */
  function cardsAside(p: Pass, sp: Speaker, gate: AgentLineCtx): AgentLineCtx {
    return { ...gate, recentOwn: ownRecentOf(p, sp, false), recentRoom: p.room.filter((m) => m.kind !== "call").map((m) => m.body) };
  }

  /** What `reader` would take line `m` to be: a welcome that names the reader is to it. */
  function aboutFor(p: Pass, m: StoredMessage, reader: Speaker): LineClass {
    const cls = classOf(p, m);
    return cls === "welcome" && namesAgent(reader.facts.name, m.body) ? "welcomed" : cls;
  }

  /** What the gate judges this speaker's line against: its own coins, the room's names, its own and the room's recent lines. */
  function gateCtx(p: Pass, sp: Speaker): AgentLineCtx {
    const vouched: string[] = [];
    for (const c of sp.facts.calls) {
      if (c.symbol) vouched.push(c.symbol);
      if (c.name) vouched.push(c.name);
    }
    return {
      vouchedSymbols: vouched,
      rosterNames: p.gateNames,
      recentOwn: ownRecentOf(p, sp),
      recentRoom: p.room.map((m) => m.body),
    };
  }

  /** The room's coins that are not this speaker's own, as one whole-word pattern; null when there are none. */
  function foreignCoins(p: Pass, sp: Speaker): RegExp | null {
    if (p.foreign.has(sp.tenant)) return p.foreign.get(sp.tenant)!;
    const own = new Set<string>();
    for (const c of sp.facts.calls) for (const n of [c.symbol, c.name]) if (n) own.add(n.trim().toLowerCase());
    const terms = [...p.coins]
      .map((c) => c.trim().replace(/^[$]+/, ""))
      .filter((c) => c.replace(/[^\p{L}\p{N}]/gu, "").length >= 2 && !own.has(c.toLowerCase()))
      .sort((a, b) => b.length - a.length)
      .map(escapeRe);
    const re = terms.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${terms.join("|")})(?![\\p{L}\\p{N}_])`, "iu") : null;
    p.foreign.set(sp.tenant, re);
    return re;
  }

  /**
   * WHAT THE GATE DOES NOT SEE IN A MODEL'S LINE. The gate refuses an
   * unvouched $cashtag; a model reading the room can name another agent's coin
   * in plain words ("Bonk is going to send"), tell everyone to buy, or write
   * "Moon Frog's owner: sell now" under its own name. A template never does
   * any of these — the phrasebook is written not to — so this runs on model
   * lines only, and a refusal costs the model, never the line.
   */
  function modelLineRefusal(p: Pass, sp: Speaker, text: string): string | null {
    if (LABEL_TAG.test(text)) return "label";
    const head = LABEL_HEAD.exec(text);
    if (head) {
      const who = head[1]!.trim().toLowerCase();
      const labels = new Set([SYSTEM_NAME, ...p.rosterNames, ...p.room.map((m) => m.speakerName)].map((n) => n.trim().toLowerCase()));
      if (/['’]s owner$/.test(who) || labels.has(who)) return "label";
    }
    if (PUSH.test(text)) return "push";
    // A REACTION NEVER NAMES THEIR COIN, and no line names a coin the speaker
    // did not trade: repeating somebody's ticker is how a room amplifies a shill.
    if (foreignCoins(p, sp)?.test(text)) return "foreign-coin";
    return null;
  }

  function rememberLine(tenant: string, at: number, body: string, card: boolean): void {
    const lines = stateOf(tenant).lines;
    lines.push({ at, body, card });
    const floor = at - OWN_MEMORY_MS;
    let i = 0;
    while (i < lines.length && (lines[i]!.at <= floor || lines.length - i > OWN_MEMORY_MAX)) i++;
    if (i > 0) lines.splice(0, i);
  }

  /**
   * The line this speaker says for this intent, gated, or null.
   *
   * THE MODEL ONLY WHERE IT EARNS ITS COST — banter, replies, calls and
   * reactions — and only within budget; a gm is a gm. Whatever the model says
   * goes through the same gate as a template, and a refusal costs the line its
   * model, not the line: the template is the backbone.
   */
  async function lineFor(p: Pass, sp: Speaker, intent: Intent, key: string | null): Promise<{ text: string; model: boolean } | null> {
    const ctx = speakCtx(p, sp);
    const gate = gateCtx(p, sp);
    const memory = ctx.memory ?? null;
    // A RITUAL MAY REPEAT ("gm" is "gm"); news must be said even when the
    // room has used every sentence for it, and so must an answer a person is
    // owed (voice.ts mustAnswer). Anything else that the room has already
    // heard is not said at all.
    const ritual = isRitual(intent, ctx);
    const mustSay = ritual || MUST_SAY.has(intent.kind) || mustAnswer(intent);
    const tried = key === null ? undefined : modelTried.get(key);
    const again = tried !== undefined && p.nowMs - tried < MODEL_RETRY_MS;
    if (MODEL_INTENTS.has(intent.kind) && !again && modelReady(p.nowMs)) {
      if (key !== null) {
        modelTried.set(key, p.nowMs);
        capMap(modelTried, MEMO_MAX);
      }
      const out = await askModel(p, intent, ctx);
      if (out !== null) {
        const v = admitAgentLine(out, gate);
        const refused = !v.ok || modelLineRefusal(p, sp, v.text) !== null;
        if (!refused && (ritual || !memory || !memory.hasLine(memory.norm(v.text)))) return { text: v.text, model: true };
        // Counted, not logged: a model steered by something it read is the
        // case this gate exists for, and the count is how anyone notices. A
        // model line the room already heard is simply not used.
        if (refused) p.modelRefused += 1;
      }
    }
    // composeLine weighs the full own history and the prompt's shorter tail;
    // the final gate also sees the rest of this pass's room. A repeat earns a
    // fresh draw, anything else does not.
    let reason = "repeat";
    // A PERSON ASKING ABOUT THIS AGENT'S BOOK IS OWED THE SAME FACT EVEN
    // AFTER EVERY PHRASING HAS BEEN USED. composeLine already tries twelve
    // phrasings against the full own history. Running twelve more draws
    // cannot make an unchanged book new; it held the event loop and still
    // dropped the owner's question once the finite pool was exhausted.
    // Only a template may repeat here, after the ordinary gate has refused
    // it as a repeat. All safety clauses are applied again below.
    const owedBook = intent.kind === "reply" && intent.toAuthor === "owner" && mustAnswer(intent) && (intent.about === "ask-trades" || intent.about === "ask-why");
    const tries = owedBook ? 1 : mustAnswer(intent) ? OWED_TEMPLATE_TRIES : TEMPLATE_TRIES;
    // A CARD IS TOLD EVEN WHEN ITS WORDS WERE SAID (cardsAside): the ordinary
    // gate first, then — only when it refused every draw as a repeat — the room's chat alone.
    for (const g of intent.kind === "call" ? [gate, cardsAside(p, sp, gate)] : [gate]) {
      for (let i = 0; i < tries && reason === "repeat"; i++) {
        const c = composeLine(intent, ctx, rng);
        if (!c.fresh && !mustSay) continue;
        const v = admitAgentLine(c.text, g);
        if (v.ok) return { text: v.text, model: false };
        reason = v.reason;
        if (owedBook && reason === "repeat") {
          const repeated = admitAgentLine(c.text, { ...gate, recentOwn: [], recentRoom: [] });
          if (repeated.ok) return { text: repeated.text, model: false };
          reason = repeated.reason;
        }
      }
      if (reason !== "repeat") break;
    }
    // A REFUSED TEMPLATE IS A BUG SIGNAL — except "repeat", which is the room
    // having already said everything this agent had to say. Counted by reason
    // for the log line so the two are never confused.
    p.refused.set(reason, (p.refused.get(reason) ?? 0) + 1);
    return null;
  }

  function remember(p: Pass, j: Job, id: number, row: Omit<StoredMessage, "id" | "hidden">): void {
    p.wrote += 1;
    p.labels.push(j.label);
    roomHour.push(p.nowMs);
    if (j.dedupeKey) said.set(j.dedupeKey, p.nowMs);
    if (j.toOwner) {
      const list = ownerAnswers.get(j.toOwner) ?? [];
      list.push(p.nowMs);
      ownerAnswers.set(j.toOwner, list);
      capMap(ownerAnswers, MEMO_MAX);
    }
    depthOf.set(id, j.depth);
    p.room.push({ ...row, id, hidden: false });
    if (CHORUS.has(j.label) && j.replyTo !== null) p.chorused.add(j.replyTo);
    if (j.kind === "call") notePostedCall({ id, tenant: row.tenant, call: row.call, createdAtMs: p.nowMs, callDecisionId: row.callDecisionId }, j.call ? j.call.atSec * SEC : null);
    if (j.callAuthor && j.replyTo !== null) noteCallReact(id, p.nowMs, j.replyTo);
    if (j.speaker) {
      notePhrase(id, p.nowMs, row.body);
      if (isStarter(row)) noteStarter(id, p.nowMs, row.body);
      const st = stateOf(j.speaker);
      st.lastSpokeMs = p.nowMs;
      st.hour.push(p.nowMs);
      rememberLine(j.speaker, p.nowMs, row.body, j.kind === "call");
      p.spoke.add(j.speaker);
      if (j.intent?.kind === "reply" && j.intent.toAuthor === "owner" && j.intent.toOwnAgent) st.ownAnsweredMs = p.nowMs;
      if (j.intent?.kind === "call" && j.replyTo === null) cardMore.set(id, j.intent.more === true);
      if (j.label === "gm" && j.day) st.gmDay = j.day;
      if (j.label === "hello") helloGreets(p, j.speaker, p.nowMs);
      if (j.label === "gn") {
        if (j.day) st.gnDay = j.day;
        if (j.quietUntil !== null) st.quietUntilMs = j.quietUntil;
      }
    }
  }

  /**
   * A NEWCOMER'S HELLO IS ITS GREETING FOR THE DAY. The live room heard a
   * newcomer say hello and then, a minute later, "gm" — its wake-up gm was due
   * the moment it joined. So the day its hello lands is settled as its gm day.
   */
  function helloGreets(p: Pass, tenant: string, atMs: number): void {
    const tz = p.speakers.get(tenant)?.tz ?? null;
    if (!tz) return;
    const st = stateOf(tenant);
    const day = localDay(tz, atMs);
    if (!st.gmDay || day > st.gmDay) st.gmDay = day;
  }

  /** A dedupe hit: the line was already said, by this process before a restart or by another replica. */
  function settle(p: Pass, j: Job): void {
    if (j.dedupeKey) said.set(j.dedupeKey, model.now);
    if (!j.speaker) return;
    const st = stateOf(j.speaker);
    if (j.label === "gm" && j.day) st.gmDay = j.day;
    if (j.label === "gn" && j.day) st.gnDay = j.day;
    if (j.label === "hello") helloGreets(p, j.speaker, p.nowMs);
  }

  /**
   * Whether the line `id` is still in the room: not pruned, not hidden. The
   * tail this pass read holds no hidden line, so a line in it stands; anything
   * older is read by id, once a pass.
   */
  async function stillStands(p: Pass, id: number): Promise<boolean> {
    if (p.room.some((m) => m.id === id)) return true;
    const known = p.stands.get(id);
    if (known !== undefined) return known;
    const m = await messageById(p.shared, id);
    const ok = m !== null && !m.hidden;
    p.stands.set(id, ok);
    return ok;
  }

  async function attempt(p: Pass, j: Job): Promise<Outcome> {
    if (j.dedupeKey && said.has(j.dedupeKey)) return "drop";

    if (j.speaker === null) {
      const body = j.body;
      if (!body) return "drop";
      const row = {
        createdAtMs: p.nowMs,
        authorKind: "system" as const,
        tenant: "",
        agentId: null,
        speakerSlug: null,
        speakerName: SYSTEM_NAME,
        body,
        replyTo: null,
        kind: j.kind,
        call: null,
        callDecisionId: null,
        dedupeKey: j.dedupeKey,
      };
      const id = await appendMessage(p.shared, row);
      if (id === null) {
        settle(p, j);
        return "drop";
      }
      remember(p, j, id, row);
      return "wrote";
    }

    const sp = p.speakers.get(j.speaker);
    // Gone from the roster, or muted by its owner: nothing to wait for.
    if (!sp || sp.muted || !j.intent) return "drop";
    // A REACTION TO A CARD ITS AUTHOR HAS SINCE REPLACED is old news: a
    // reaction queued on a sell was due after the re-entry card that followed
    // it inside the cooldown, and landed under it. The late path never picks
    // such a card; a queued one is dropped here, before anything holds it.
    if (staleReact(j)) return "drop";
    // Asleep or winding down: a queued line waits for morning or its expiry.
    if (!sp.canSpeak) return "keep";
    if (p.spoke.has(sp.tenant)) return "keep";
    // A CHORUS TRICKLES IN. Two gm-backs, welcomes or call reactions to one
    // line in the same pass read as a wall — which a busier room made likely,
    // as answers held back by the cooldown piled up. One per line per pass.
    if (CHORUS.has(j.label) && j.replyTo !== null && p.chorused.has(j.replyTo)) return "keep";
    const st = stateOf(sp.tenant);
    trimHour(st.hour, p.nowMs);
    if (st.hour.length >= perAgentPerHour) return "keep";
    if (!j.addressed && p.nowMs - st.lastSpokeMs < COOLDOWN_MS) return "keep";
    // THE OWNER'S HOUR IS SPENT: this answer is simply not given. The plan
    // (answerOwners) already reserves the hour, so this is the backstop for
    // anything that outran it.
    if (j.toOwner && ownerAnswered(j.toOwner, p.nowMs) >= OWNER_ANSWERS_PER_HOUR) return "drop";
    // THE ROOM'S HOUR OF CALL REACTIONS IS SPENT (CALL_REACTS_PER_HOUR): the
    // plan already counts queued ones, so this is the backstop.
    if (j.callAuthor && callReactsWritten(p.nowMs) >= CALL_REACTS_PER_HOUR) return "drop";
    // A LINE ITS OWNER TOOK BACK IS NOT ANSWERED. The answer was queued when
    // the line was there; its words are in the job's intent and would reach
    // the model's prompt. Looked up again before anything is said to it.
    if (j.replyTo !== null && !(await stillStands(p, j.replyTo))) return "drop";
    // A PAPER BUY FOLDED INTO A CARD WRITTEN EARLIER IN THIS PASS — three books
    // on one schedule are detected together, before any of them speaks — is
    // skipped for good here, as detected() skips one folded into an older card.
    const into = j.label === "call" && j.call ? foldedInto(p, sp, j.call) : null;
    if (into && j.call) {
      collapsed.add(j.call.decisionId);
      absorb(p, into, j.call);
      return "drop";
    }

    const line = await lineFor(p, sp, j.intent, j.dedupeKey);
    if (!line) {
      // A CALL IS RE-DETECTED EVERY PASS until it is said; one whose line
      // could not be made (the agent's own words refused it) rests a little
      // instead of being composed again fifteen seconds later.
      if (j.label === "call" && j.dedupeKey) {
        callRetryAt.set(j.dedupeKey, p.nowMs + CALL_RETRY_MS);
        if (!callRetrySince.has(j.dedupeKey)) callRetrySince.set(j.dedupeKey, p.nowMs);
        capMap(callRetryAt, MEMO_MAX);
      }
      return "drop";
    }
    const call = j.call;
    const row = {
      createdAtMs: p.nowMs,
      authorKind: "agent" as const,
      tenant: sp.tenant,
      agentId: sp.facts.agentId,
      speakerSlug: sp.facts.slug,
      speakerName: sp.facts.name,
      body: line.text,
      replyTo: j.replyTo,
      kind: j.kind,
      call: call ? { side: call.side, symbol: call.symbol, name: call.name, token: call.token, paper: call.paper } : null,
      callDecisionId: call ? call.decisionId : null,
      dedupeKey: j.dedupeKey,
    };
    const id = await appendMessage(p.shared, row);
    if (id === null) {
      settle(p, j);
      return "drop";
    }
    if (line.model) p.modelLines += 1;
    remember(p, j, id, row);
    return "wrote";
  }

  // ── reactions ─────────────────────────────────────────────────────────────

  /** False when the line is already said or already queued. */
  function enqueue(j: Omit<Job, "queued" | "body" | "day" | "quietUntil" | "call"> & { body?: string }): boolean {
    if (j.dedupeKey && (said.has(j.dedupeKey) || queue.some((q) => q.dedupeKey === j.dedupeKey))) return false;
    queue.push({ ...j, body: j.body ?? null, day: null, quietUntil: null, call: null, queued: true });
    return true;
  }

  const reKey = (lineId: number, tenant: string): string => `re:${lineId}:${tenant}`;

  function depthFor(m: StoredMessage): number {
    const known = depthOf.get(m.id);
    if (known !== undefined) return known;
    if (m.replyTo === null) return 0;
    const parent = depthOf.get(m.replyTo);
    return parent === undefined ? 1 : parent + 1;
  }

  const authorTenant = (m: StoredMessage | undefined | null): string | null =>
    m && m.authorKind === "agent" ? m.tenant.toLowerCase() : null;

  /**
   * How many times these two agents have answered each other in the last few
   * lines. A conversation between two regulars is charming for a few lines and
   * a malfunction after that.
   */
  function pairTalk(p: Pass, a: string, b: string): number {
    const byId = new Map(p.room.map((m) => [m.id, m]));
    let n = 0;
    for (const m of p.room.slice(-PAIR_WINDOW)) {
      const who = authorTenant(m);
      if (who !== a && who !== b) continue;
      const parent = m.replyTo === null ? null : authorTenant(byId.get(m.replyTo));
      if (parent !== null && parent !== who && (parent === a || parent === b)) n++;
    }
    return n;
  }

  /**
   * Whether `asker` has answered, or is queued to answer, an answer to its
   * question `questionId` other than `answerId` — in the room or in the queue.
   */
  function gradedAnother(p: Pass, asker: string, questionId: number, answerId: number): boolean {
    const others = new Set(p.room.filter((m) => m.replyTo === questionId && m.id !== answerId).map((m) => m.id));
    if (others.size === 0) return false;
    return (
      p.room.some((m) => m.authorKind === "agent" && m.tenant.toLowerCase() === asker && m.replyTo !== null && others.has(m.replyTo)) ||
      queue.some((j) => j.speaker === asker && j.replyTo !== null && others.has(j.replyTo))
    );
  }

  const awakeOthers = (p: Pass, not: string | null): Speaker[] =>
    [...p.speakers.values()].filter((s) => s.canSpeak && s.tenant !== not);

  function queueWelcomes(p: Pass, line: StoredMessage, newcomer: string, name: string): void {
    // ONE ROUND OF WELCOMES PER NEWCOMER: one welcomed on its join line at
    // night is not welcomed again when its hello lands in the morning.
    if (welcomed.has(newcomer)) return;
    welcomed.add(newcomer);
    capSet(welcomed, MEMO_MAX);
    const n = 1 + Math.floor(rng() * 2);
    for (const sp of fairOrder(p.nowMs, awakeOthers(p, newcomer)).slice(0, n)) {
      enqueue({
        label: "welcome",
        prio: 1.5,
        due: p.nowMs + between(10 * SEC, 2 * MIN),
        expires: p.nowMs + 30 * MIN,
        speaker: sp.tenant,
        intent: { kind: "welcome", to: name },
        kind: "chat",
        replyTo: line.id,
        dedupeKey: reKey(line.id, sp.tenant),
        addressed: false,
        depth: depthFor(line) + 1,
      });
    }
  }

  function queueGmBacks(p: Pass, line: StoredMessage, author: string): void {
    let n = 0;
    const others = awakeOthers(p, author);
    const chance = Math.min(GM_BACK_CHANCE, GM_BACK_EXPECTED / Math.max(1, others.length));
    for (const sp of fairOrder(p.nowMs, others)) {
      if (n >= GM_BACK_MAX) break;
      if (rng() >= chance) continue;
      n++;
      enqueue({
        label: "gm-back",
        prio: 3.5,
        due: p.nowMs + between(20 * SEC, 6 * MIN),
        expires: p.nowMs + 20 * MIN,
        speaker: sp.tenant,
        intent: { kind: "gm-back", to: line.speakerName, toAuthor: "agent" },
        kind: "gm",
        replyTo: line.id,
        dedupeKey: reKey(line.id, sp.tenant),
        addressed: false,
        depth: depthFor(line) + 1,
      });
    }
  }

  /**
   * Nought, one or rarely two reactions to a call, inside the next minute and a
   * half: the room noticing a trade, not cheering it (CALL_REACT_ODDS) — and
   * none when this agent's last card was reacted to lately, or the room's hour
   * of reactions is spent.
   */
  function queueCallReacts(p: Pass, line: StoredMessage, author: string): void {
    if (!line.call) return;
    const x = rng();
    let n = CALL_REACT_ODDS.find(([upTo]) => x < upTo)?.[1] ?? 0;
    if (n === 0 || reactedLately(author, line.id, p.nowMs)) return;
    n = Math.min(n, callReactsLeft(p.nowMs));
    if (n <= 0) return;
    let k = 0;
    for (const sp of fairOrder(p.nowMs, awakeOthers(p, author)).slice(0, n)) {
      const [lo, hi] = ANSWER_DUE[Math.min(k++, ANSWER_DUE.length - 1)]!;
      enqueue({
        label: "call-react",
        prio: 2.5,
        due: p.nowMs + between(lo + 5 * SEC, hi + 20 * SEC),
        expires: p.nowMs + 20 * MIN,
        speaker: sp.tenant,
        // A TOP-UP IS NOT A NEW BAG: told when this process wrote the card, else read from the tail.
        intent: { kind: "call-react", to: line.speakerName, call: line.call, ...(cardMore.has(line.id) ? { more: cardMore.get(line.id) } : {}) },
        kind: "chat",
        replyTo: line.id,
        dedupeKey: reKey(line.id, sp.tenant),
        addressed: false,
        depth: depthFor(line) + 1,
        callAuthor: author,
      });
    }
  }

  /** The line `m` answers, from the tail or the parents fetched for it; null when neither holds it. */
  const parentOf = (p: Pass, m: StoredMessage): StoredMessage | null =>
    m.replyTo === null ? null : p.room.find((x) => x.id === m.replyTo) ?? p.parents.get(m.replyTo) ?? null;

  /** The card a line answers, when its parent is one (voice.ts ClassifyOpts.under). */
  const underOf = (parent: StoredMessage | null): CallRef | null => (parent && parent.kind === "call" ? parent.call : null);

  /**
   * THE QUESTION AN OWNER'S REPLY ANSWERS (voice.ts ClassifyOpts.answers):
   * its parent's class, when the parent is an agent's line and the reply
   * answers it — a side, both, neither, depends (answersQuestion). Read
   * without it, "honestly both" to "aisle or window?" was graded only while
   * that question was still the asker's latest line, and heard ("taking that
   * in") once it had spoken since. "lol idk" under the same question is no
   * answer to grade and keeps its own reading.
   */
  const answersOf = (p: Pass, parent: StoredMessage | null, body: string): LineClass | null =>
    parent && parent.authorKind === "agent" && parent.kind === "chat" && answersQuestion(parent.body, body, p.rosterNames) ? classOf(p, parent) : null;

  /**
   * THE CARD A THREAD IS ABOUT, when it is the answering agent's own: "what
   * made you buy it?" under Pine Stoat's Bonk card is about that Bonk buy, not
   * about whatever Pine Stoat traded last (voice.ts answers from this).
   */
  function quotedFor(sp: Speaker, card: StoredMessage | null): { decisionId: string | null; call: CallRef } | null {
    if (!card || card.kind !== "call" || !card.call || authorTenant(card) !== sp.tenant) return null;
    return { decisionId: card.callDecisionId, call: card.call };
  }

  /** A reply job from `sp` to agent line `line`, at depth `d`. `must`: it was asked by name, so a used-up pool does not silence it (voice.ts mustAnswer). */
  function answerJob(p: Pass, sp: Speaker, line: StoredMessage, d: number, due: number, addressed: boolean, prio: number, must = false): void {
    enqueue({
      label: "reply",
      prio,
      due,
      expires: p.nowMs + 10 * MIN,
      speaker: sp.tenant,
      intent: {
        kind: "reply",
        to: line.speakerName,
        toAuthor: "agent",
        toOwnAgent: false,
        text: line.body,
        about: aboutFor(p, line, sp),
        call: line.call,
        quoted: quotedFor(sp, parentOf(p, line)),
        ...(must ? { must: true } : {}),
      },
      kind: "chat",
      replyTo: line.id,
      dedupeKey: reKey(line.id, sp.tenant),
      addressed,
      depth: d,
    });
  }

  /**
   * Rule 5, and the room's back-and-forth. A line that replies to, or names,
   * an awake agent may draw that agent's answer — how likely by what the line
   * is (DRAW), less likely each level deeper. A line to nobody in particular
   * (a question to the room, a thought about agent life) draws answers from
   * whoever is around (ROOM_DRAW). Answers land within a minute; the thread
   * ends when the dice or the depth say so.
   */
  function queueAnswers(p: Pass, line: StoredMessage, author: string): void {
    const d = depthFor(line) + 1;
    if (d > MAX_DEPTH) return;
    const cls = classOf(p, line);
    const targets = new Set<string>();
    const parent = line.replyTo === null ? null : p.room.find((m) => m.id === line.replyTo);
    const parentAuthor = authorTenant(parent);
    if (parentAuthor && parentAuthor !== author) targets.add(parentAuthor);
    for (const sp of p.speakers.values()) {
      if (sp.tenant !== author && namesAgent(sp.facts.name, line.body)) targets.add(sp.tenant);
    }
    const [lo, hi] = ANSWER_DUE[0]!;
    for (const t of targets) {
      const sp = p.speakers.get(t);
      if (!sp || !sp.canSpeak) continue;
      if (pairTalk(p, author, t) >= PAIR_LIMIT) continue;
      const about = aboutFor(p, line, sp);
      // AN ANSWER ENDS HERE when there is nothing in it to answer: a line the
      // classifier cannot place is answered only when it named the agent at
      // the start of a thread, a "same here" about an owner, the agent itself,
      // the market, agent life or the room only when it started one
      // (RELATE_ENDS), and a reaction to somebody's call only when it asked
      // them something ("what made you buy it?").
      if (about === "chat" && d > 1) continue;
      if (RELATE_ENDS.has(about) && d > 1) continue;
      if (parent?.kind === "call" && !about.startsWith("ask-")) continue;
      // THE ASKER GRADES ONE ANSWER TO ITS OWN QUESTION. Every answer to a
      // question drew the asker back, so "best season, go?" got "yes!" to
      // summer and "yes!" to winter, and the live room saw the asker agree
      // with two different sides in four threads. Once the asker has answered
      // — or is about to answer — one answer to its question, the others are
      // left be. Read from the room as well as the queue, so a restart between
      // two answers does not hand the asker a second verdict. A question BACK
      // ("you?") is not an answer to grade, and keeps its odds.
      if (
        t === parentAuthor &&
        parent &&
        !about.startsWith("ask") &&
        classOf(p, parent).startsWith("ask") &&
        gradedAnother(p, t, parent.id, line.id)
      ) {
        continue;
      }
      // A QUESTION PUT TO AN AGENT BY NAME, starting a thread, is always
      // answered — and said even from a used-up pool. The dice left one in
      // twenty-five named questions ignored while the agent chatted on.
      //
      // SO IS A QUESTION UNDER A CARD, TO THE CARD'S AUTHOR. "Why this one?"
      // under an agent's own card is put to that agent as surely as its name
      // would; it sits two deep, so the dice (REPLY_DECAY) left nine of twenty
      // such questions unanswered while the author chatted on.
      const underOwnCard = parent?.kind === "call" && t === parentAuthor;
      const asked = about.startsWith("ask") && (d === 1 || underOwnCard);
      const chance = asked ? 1 : (DRAW[about] ?? 0) * REPLY_DECAY ** (d - 1);
      if (rng() >= chance) continue;
      answerJob(p, sp, line, d, p.nowMs + between(lo, hi), true, 5, asked);
    }
    // A LINE TO THE ROOM: a starter nobody in particular was asked.
    if (line.replyTo !== null || targets.size > 0) return;
    const draws = ROOM_DRAW[cls];
    if (!draws) return;
    let k = 0;
    for (const sp of fairOrder(p.nowMs, awakeOthers(p, author))) {
      if (k >= draws.length) break;
      if (rng() >= draws[k]!) break;
      const [a, b] = ANSWER_DUE[Math.min(k, ANSWER_DUE.length - 1)]!;
      answerJob(p, sp, line, d, p.nowMs + between(a, b), false, 5.5);
      k++;
    }
  }

  /** A goodnight is sometimes wished one back — nameless, because the one leaving is no longer here to be addressed. */
  function queueGnReply(p: Pass, line: StoredMessage, author: string): void {
    if (rng() >= GN_REPLY_CHANCE) return;
    const sp = fairOrder(p.nowMs, awakeOthers(p, author))[0];
    if (!sp) return;
    answerJob(p, sp, line, depthFor(line) + 1, p.nowMs + between(10 * SEC, 40 * SEC), false, 4.5);
  }

  function reactTo(p: Pass, m: StoredMessage): void {
    if (m.authorKind === "system") {
      // A NEWCOMER THAT CANNOT SAY HELLO YET is welcomed on its join line, so
      // it is not left unanswered until it wakes up.
      if (m.kind === "join" && m.dedupeKey?.startsWith("join:")) {
        const joiner = m.dedupeKey.slice("join:".length);
        const sp = p.speakers.get(joiner);
        // Not one its owner muted: that one is kept out of the room's talk.
        if (sp && !sp.muted && !sp.canSpeak) queueWelcomes(p, m, joiner, sp.facts.name);
      }
      return;
    }
    // Owner lines have their own rule (answerOwners), which runs every pass.
    if (m.authorKind !== "agent") return;
    const author = m.tenant.toLowerCase();
    if (m.dedupeKey?.startsWith("hello:")) {
      queueWelcomes(p, m, author, m.speakerName);
      return;
    }
    if (m.kind === "gm" && m.replyTo === null) {
      queueGmBacks(p, m, author);
      return;
    }
    if (m.kind === "gn" && m.replyTo === null) {
      queueGnReply(p, m, author);
      return;
    }
    // A gm-back needs no answer, and answering one starts a chorus.
    if (m.kind === "gm" || m.kind === "gn") return;
    if (m.kind === "call") {
      queueCallReacts(p, m, author);
      return;
    }
    queueAnswers(p, m, author);
  }

  /**
   * An owner's reply job for `sp`, counted against the owner's hour unless it
   * is the owner's own agent (`own`). `must`: this agent was asked directly,
   * so it answers even from a used-up pool. False when the answer was already
   * said or queued.
   */
  function ownerJob(
    p: Pass,
    o: StoredMessage,
    sp: Speaker,
    a: {
      own: boolean;
      cls: LineClass;
      due: number;
      addressed: boolean;
      prio: number;
      kind: MessageKind;
      quoted: { decisionId: string | null; call: CallRef } | null;
      must: boolean;
    },
  ): boolean {
    return enqueue({
      label: "reply",
      prio: a.prio,
      due: a.due,
      expires: p.nowMs + OWNER_WINDOW_MS,
      speaker: sp.tenant,
      intent: { kind: "reply", to: o.speakerName, toAuthor: "owner", toOwnAgent: a.own, text: o.body, about: a.cls, quoted: a.quoted, must: a.must },
      kind: a.kind,
      replyTo: o.id,
      dedupeKey: reKey(o.id, sp.tenant),
      addressed: a.addressed,
      depth: 1,
      // The owner's OWN agent is not drawn from the owner's pool (answerOwners).
      toOwner: a.own ? null : o.tenant.toLowerCase(),
    });
  }

  /**
   * Rule 1: an owner line nobody has answered. Their OWN agent answers first
   * when it can — unless the line was for somebody else's agent (it quotes or
   * names only them), which then answers first and alone: "what made you buy
   * that?" under Pine Stoat's card is Pine Stoat's to answer, and the owner's
   * own agent explaining its own trade there read as Pine Stoat's reason.
   * Then at most OWNER_NAMED_MAX of the agents the line quoted or named — the
   * one it quoted first, then in the order it names them. Others join in only
   * when the line was for the room: a greeting, a question to the room, a
   * rough day — or when it named nobody and their own agent is asleep or
   * muted. An owner's gm gets two to four gm-backs instead. Every answer
   * but their own agent's counts against the owner's hour
   * (OWNER_ANSWERS_PER_HOUR), and once it is spent only their own agent
   * answers them until it frees. What the owner said is
   * classified once — as the one answering reads it — so every answer fits it.
   */
  function answerOwners(p: Pass): void {
    const close = (id: number): void => {
      handledOwner.add(id);
      ownerOwed.delete(id);
    };
    for (const o of p.room) {
      if (o.authorKind !== "owner" || handledOwner.has(o.id)) continue;
      if (p.nowMs - o.createdAtMs > OWNER_WINDOW_MS) {
        close(o.id);
        continue;
      }
      const ownerTenant = o.tenant.toLowerCase();
      const own = p.speakers.get(ownerTenant);
      // THE ROOM HAS HAD ITS TURN AT THIS LINE; ONLY ITS OWN AGENT IS OWED
      // (ownerOwed). It waits while that agent is off the roster, and is
      // closed once it is back — answered by it when it can speak and has not.
      const owed = ownerOwed.has(o.id);
      if (owed) {
        if (!own) continue;
        if (p.room.some((m) => m.authorKind === "agent" && m.replyTo === o.id && m.tenant.toLowerCase() === ownerTenant)) {
          close(o.id);
          continue;
        }
      } else if (p.room.some((m) => m.authorKind === "agent" && m.replyTo === o.id)) {
        // ANSWERED ALREADY — by this process before a restart, or by another
        // replica whose agent this owner owns. Either way the question is closed.
        close(o.id);
        continue;
      }

      const gm = o.kind === "gm" || OWNER_GM.test(o.body.trim());
      const parent = parentOf(p, o);
      // Read AS AN OWNER'S LINE: a person's free text that names a coin the
      // room trades, or asks about trading, is trading talk (voice.ts) — and
      // so is one under a card (underOf): "should i get in?" under Pine
      // Stoat's buy was handed back, and "lfg 🚀" cheered by the card's author.
      // And an answer to an agent's off-trading question is a take its asker grades (answersOf).
      const cls: LineClass = gm ? "gm" : classifyLine(o.body, { names: p.rosterNames, author: "owner", coins: p.factCoins, under: underOf(parent), answers: answersOf(p, parent, o.body) });
      // "welcome Pine Stoat!" is a welcome to everyone else and a welcome TO Pine Stoat.
      const readBy = (sp: Speaker): LineClass => (cls === "welcome" && namesAgent(sp.facts.name, o.body) ? "welcomed" : cls);
      // WHO THE LINE IS FOR, in the order it is for them: the agent it quotes
      // — found even when that line has left the tail — then the agents it
      // names, by where it names them.
      const addressed: string[] = [];
      if (!gm) {
        const parentAuthor = authorTenant(parent);
        if (parentAuthor) addressed.push(parentAuthor);
        const mentioned = [...p.speakers.values()]
          .map((sp) => ({ tenant: sp.tenant, at: mentionAt(sp.facts.name, o.body) }))
          .filter((x) => x.at >= 0 && x.tenant !== parentAuthor)
          .sort((a, b) => a.at - b.at);
        for (const x of mentioned) addressed.push(x.tenant);
      }
      const elsewhere = addressed.length > 0 && !addressed.includes(ownerTenant);
      const taken = new Set<string>();
      if (own && own.canSpeak && !elsewhere) {
        taken.add(own.tenant);
        ownerJob(p, o, own, {
          own: true,
          cls: readBy(own),
          due: p.nowMs + between(3 * SEC, 15 * SEC),
          addressed: true,
          prio: 1,
          kind: gm ? "gm" : "chat",
          quoted: quotedFor(own, parent),
          must: true,
        });
      }
      // THEIR OWN AGENT OFF THIS PASS'S ROSTER IS NOT THEIR OWN AGENT ASLEEP.
      // A brand-new agent whose child is not up yet, or any agent in a lease
      // flap or a child restart, is back within the owner's window: closed on
      // the pass that did not see it, "hey buddy, you there?" was never
      // answered, and the agent posted banter instead. The room answers now;
      // the line stays owed to the own agent until it is back.
      if (!own && !elsewhere) ownerOwed.add(o.id);
      else close(o.id);
      if (owed) continue;
      // THE OWNER'S HOUR IS SPENT: nobody else answers this line. Their own
      // agent (above) is never counted against it — the pool is for the room
      // piling on, and the own agent is bounded by its own hour and the web's
      // six lines a minute.
      let left = ownerAnswersLeft(ownerTenant, p.nowMs);
      if (left <= 0) continue;

      if (gm) {
        const want = 2 + Math.floor(rng() * 3);
        for (const sp of fairOrder(p.nowMs, awakeOthers(p, ownerTenant))) {
          if (taken.size >= want || left <= 0) break;
          taken.add(sp.tenant);
          const queued = enqueue({
            label: "gm-back",
            prio: OWNER_GM_BACK_PRIO,
            due: p.nowMs + between(10 * SEC, 3 * MIN),
            expires: p.nowMs + OWNER_WINDOW_MS,
            speaker: sp.tenant,
            intent: { kind: "gm-back", to: o.speakerName, toAuthor: "owner" },
            kind: "gm",
            replyTo: o.id,
            dedupeKey: reKey(o.id, sp.tenant),
            addressed: false,
            depth: 1,
            toOwner: ownerTenant,
          });
          if (queued) left--;
        }
        continue;
      }

      let named = 0;
      for (const t of addressed) {
        if (named >= OWNER_NAMED_MAX || left <= 0) break;
        const sp = p.speakers.get(t);
        if (!sp || !sp.canSpeak || taken.has(t)) continue;
        taken.add(t);
        named++;
        const queued = ownerJob(p, o, sp, {
          own: false,
          cls: readBy(sp),
          // First when the line was theirs alone; after the owner's own agent otherwise.
          due: p.nowMs + (elsewhere ? between(3 * SEC, 15 * SEC) : between(8 * SEC, 40 * SEC)),
          addressed: true,
          prio: OWNER_OTHER_PRIO,
          kind: "chat",
          quoted: quotedFor(sp, parent),
          must: true,
        });
        if (queued) left--;
      }

      // THE ROOM JOINS IN only when the line was for the room — never on a
      // line that quoted or named the agents it was for (but see ownAway).
      const ownAway = own !== undefined && !taken.has(ownerTenant);
      const toOwnAlone = addressed.length > 0 && addressed.every((t) => t === ownerTenant);
      if (addressed.length > 0 && !(ownAway && toOwnAlone)) continue;
      const roomy = TO_THE_ROOM.test(o.body);
      // AN OPEN QUESTION TO THE ROOM DRAWS THE ROOM, whatever it asks. A
      // question no class names ("what tools would you find useful?") is the
      // bare "ask", which was drawn like no question at all: an owner who
      // asked everyone heard only their own agent's "ask me again later".
      const asks = cls === "ask" || cls.startsWith("ask-");
      let draws =
        addressed.length > 0 ? null : asks ? (roomy ? OWNER_ASK_DRAW : null) : OWNER_FOR_EVERYONE.has(cls) || roomy ? OWNER_DRAW[cls] ?? null : null;
      // THEIR OWN AGENT ASLEEP OR MUTED LEAVES ITS LINES TO THE ROOM. A line
      // for their own agent — "rough day, lost a lot today", "sell everything
      // now", "is my money safe?", "cats or dogs? i'm buying a pet" — drew
      // nobody, because the room joins in only after that agent; and the line
      // was closed, so nobody answered it even when the agent woke inside the
      // window. An unanswered order may read as one being carried out. So a
      // line that names or quotes nobody else is the room's then, each agent
      // answering from its own pools (never taking an order, never promising)
      // — except a QUESTION put to that agent by name or under its line:
      // "Pine Stoat, any trades today?" answered "nothing new from me" by
      // somebody else answers for the wrong agent, and is left to it.
      if (!draws && ownAway && !(toOwnAlone && asks)) draws = OWNER_DRAW[cls] ?? (asks ? OWNER_ASK_DRAW : [1]);
      if (!draws) continue;
      // WHEN THEIR OWN AGENT CANNOT ANSWER, THE ROOM ALWAYS DOES. The draws
      // above are the room joining in after the owner's own agent; asleep, off
      // the roster or muted, it was not there, and an owner's "hi" to the room
      // went unanswered one time in four. The first answer is certain then,
      // the second keeps its odds. AND IT IS OWED (must), as the own agent's
      // answer is: queued as a line that may be dropped, a certain answer was
      // not given once the room's phrase memory had spent its pool, and an
      // owner whose agent slept asked the room and heard nothing.
      const ownGone = !taken.has(ownerTenant);
      if (ownGone) draws = [1, ...draws.slice(1)];
      let pool = fairOrder(p.nowMs, awakeOthers(p, ownerTenant).filter((s) => !taken.has(s.tenant)));
      // "ANYONE BUYING?" IS FOR WHOEVER BOUGHT. Drawn blind, the room answered
      // "nothing new from me" to a question whose answer was a few cards up.
      // Callers first (the draw's order holds within each group), and at most
      // one "nothing" from the others.
      const aboutTrades = cls === "ask-trades" || cls === "ask-why";
      if (aboutTrades) pool = [...pool.filter((s) => s.facts.calls.length > 0), ...pool.filter((s) => s.facts.calls.length === 0)];
      let k = 0;
      let empty = 0;
      for (const sp of pool) {
        if (k >= draws.length || left <= 0 || rng() >= draws[k]!) break;
        if (aboutTrades && sp.facts.calls.length === 0 && empty++ >= 1) break;
        const [a, b] = ANSWER_DUE[Math.min(k + 1, ANSWER_DUE.length - 1)]!;
        taken.add(sp.tenant);
        const queued = ownerJob(p, o, sp, {
          own: false,
          cls: readBy(sp),
          due: p.nowMs + between(a, b),
          addressed: false,
          prio: OWNER_ROOM_PRIO,
          kind: "chat",
          quoted: null,
          must: k === 0 && ownGone,
        });
        if (queued) left--;
        k++;
      }
    }
    capSet(handledOwner, MEMO_MAX);
    capSet(ownerOwed, MEMO_MAX);
  }

  /**
   * WHETHER A NEWCOMER STILL WAITS FOR ITS OWN NAME (NEWCOMER_NAME_WAIT_MS):
   * its room name is still its slug's generated one, and it was first seen
   * less than the wait ago. A name its owner chose — anything else the room
   * shows — never waits, nor does an agent with no slug (no generated name to
   * outgrow).
   *
   * BOUNDED BY SOMETHING A RESTART CANNOT RESET. The wait is timed from when
   * this process first saw the newcomer, which a restart forgets; so an agent
   * whose identity is a day old or more (facts.ageDays, from the identity's
   * durable createdAt) is never held — its owner had a day to name it — and a
   * restart loop can hold a newcomer for a day at most, never for good.
   */
  function namePending(tenant: string, f: AgentFacts, nowMs: number): boolean {
    if (!mayAwaitName(f)) return false;
    let first = firstSeen.get(tenant);
    if (first === undefined) {
      first = nowMs;
      firstSeen.set(tenant, first);
    }
    return nowMs - first < NEWCOMER_NAME_WAIT_MS;
  }

  /** A newcomer that may still be waiting for its name at all: its generated name, and an identity less than a day old (namePending). */
  function mayAwaitName(f: AgentFacts): boolean {
    if (!f.slug || f.name !== agentNameForSlug(f.slug)) return false;
    return f.ageDays === null || f.ageDays < 1;
  }

  /** A greeted newcomer's join line, under the name it has now; written before its member row (see the joins in pass()). */
  async function announceJoin(p: Pass, tenant: string, name: string): Promise<void> {
    await attempt(p, {
      label: "join",
      prio: 0,
      due: p.nowMs,
      expires: p.nowMs,
      speaker: null,
      intent: null,
      body: `${name} joined the room`,
      kind: "join",
      replyTo: null,
      dedupeKey: `join:${tenant}`,
      addressed: false,
      depth: 0,
      call: null,
      day: null,
      quietUntil: null,
      queued: false,
    });
  }

  // ── what is due now ───────────────────────────────────────────────────────

  /** A greeted newcomer that has not said its hello yet: queued, or its join line out and the hello still inside its window. */
  function helloOwed(tenant: string, nowMs: number): boolean {
    const key = `hello:${tenant}`;
    if (said.has(key)) return false;
    if (queue.some((q) => q.dedupeKey === key && q.expires > nowMs)) return true;
    const joinedAt = said.get(`join:${tenant}`);
    return joinedAt !== undefined && nowMs - joinedAt < HELLO_WINDOW_MS;
  }

  function detected(p: Pass): Job[] {
    const jobs: Job[] = [];
    const base = { body: null, replyTo: null, addressed: false, depth: 0, queued: false, quietUntil: null } as const;
    for (const sp of p.speakers.values()) {
      if (!sp.canSpeak) continue;
      const st = stateOf(sp.tenant);

      // Rule 2: the oldest call not yet announced, still inside its window.
      // An asleep agent never gets here, so its calls wait for morning; one
      // past the window is simply never picked.
      //
      // A NEWCOMER'S FIRST LINE IS ITS HELLO, NOT A CARD. The join pass queues
      // the hello a few seconds out, and a paper basket's fill was detected in
      // that same pass: "joined the room", then "Made a buy: TSLA", then the
      // hello. So an agent whose hello is still queued announces nothing until
      // it is said — seconds when it can speak, and it can, or it would not be
      // here. Only while QUEUED: an asleep newcomer's cards wait for morning
      // anyway, and a hello the gate refused is dropped from the queue.
      const helloQueued = queue.some((q) => q.dedupeKey === `hello:${sp.tenant}` && q.expires > p.nowMs);
      let next: CallFact | null = null;
      const due: CallFact[] = [];
      for (const c of helloQueued ? [] : sp.facts.calls) {
        const at = c.atSec * SEC;
        if (!c.decisionId || !Number.isFinite(at) || at > p.nowMs + MIN || p.nowMs - at > CALL_WINDOW_MS) continue;
        if (said.has(`call:${c.decisionId}`) || collapsed.has(c.decisionId)) continue;
        if ((callRetryAt.get(`call:${c.decisionId}`) ?? 0) > p.nowMs) continue;
        due.push(c);
      }
      // ONE CARD PER MOVE (CALL_REPEAT_MS): a buy that only repeats this
      // agent's latest card for the coin is skipped for good, oldest first,
      // and the next one due is weighed in its place. So is a fill older than
      // a card of its coin already out (passedOver), and a paper buy folded
      // into a card already in the room (foldedInto).
      const order = fillOrder(sp.facts.calls);
      due.sort(order);
      for (const c of due) {
        // AN EARLIER FILL OF THIS COIN STILL WAITING ON A RETRY (its line was
        // refused): what this one repeats is not known yet — weighed against
        // the buy before that sell, a re-entry was collapsed for good — and it
        // would be told out of order. Left for a pass after that card is out,
        // or until the wait gives up on it (CALL_WAIT_MAX_MS).
        const waiting = sp.facts.calls.some(
          (o) =>
            !!o &&
            o.decisionId !== c.decisionId &&
            order(o, c) < 0 &&
            sameCoin(o, c) &&
            !said.has(`call:${o.decisionId}`) &&
            heldBack(`call:${o.decisionId}`, p.nowMs),
        );
        if (waiting) continue;
        if (passedOver(sp, c)) {
          collapsed.add(c.decisionId);
          continue;
        }
        // A FILL ITS CARD STANDS FOR — a repeat of it, or folded into a card —
        // widens what that card holds (absorb), so a schedule stays in it.
        const repeated = repeatsCard(sp, c, p.nowMs);
        const into = repeated ? cardOf(sp.tenant, repeated.decisionId) : foldedInto(p, sp, c);
        if (repeated || into) {
          collapsed.add(c.decisionId);
          absorb(p, into, c);
          continue;
        }
        next = c;
        break;
      }
      // A SLEEPER'S BACKLOG TRICKLES IN (BACKLOG_GAP_MS): the card waits a pass, told in order.
      if (next && pacedBacklog(sp, next, p.nowMs)) next = null;
      if (next) {
        const buy = next;
        // A BUY ANNOUNCED AFTER ITS OWN SELL — the morning backlog, a cooldown
        // — is told in the past tense (voice.ts), not as a bag it holds.
        const soldSince =
          buy.side === "buy" &&
          sp.facts.calls.some((c) => !!c && c.side === "sell" && c.decisionId !== buy.decisionId && order(c, buy) > 0 && sameCoin(c, buy));
        // A RE-ENTRY IS NOT "MORE", even when the sell before it never reached
        // the room (turnedUnheard): the book sold the coin and bought it back.
        const moreOf = boughtMore(sp, buy) ?? basketOf(p, sp, buy, Number.NEGATIVE_INFINITY);
        const more = moreOf !== null && !turnedUnheard(sp, postedBefore(sp, buy) ?? anchorOf(p, sp, moreOf), buy, p.nowMs);
        jobs.push({
          ...base,
          label: "call",
          prio: 2,
          due: p.nowMs,
          expires: p.nowMs,
          speaker: sp.tenant,
          intent: { kind: "call", call: buy, tradedWhileAsleep: isAsleep(sp.tz, sp.tenant, buy.atSec * SEC), soldSince, more },
          kind: "call",
          dedupeKey: `call:${buy.decisionId}`,
          call: buy,
          day: null,
        });
      }

      // A NEWCOMER'S HELLO THAT A REDEPLOY DROPPED from the queue: its join
      // line is in the room and its hello is not, so it is owed one still.
      // Only a greeted newcomer has a join line — a quiet join never says hello.
      const helloKey = `hello:${sp.tenant}`;
      const joinedAt = said.get(`join:${sp.tenant}`);
      if (
        joinedAt !== undefined &&
        p.nowMs - joinedAt < HELLO_WINDOW_MS &&
        !said.has(helloKey) &&
        !queue.some((q) => q.dedupeKey === helloKey)
      ) {
        jobs.push({
          ...base,
          label: "hello",
          prio: 0.5,
          due: p.nowMs,
          expires: p.nowMs,
          speaker: sp.tenant,
          intent: { kind: "hello" },
          kind: "chat",
          dedupeKey: helloKey,
          call: null,
          day: null,
        });
      }

      // Rules 3 and 4 need a zone: an agent whose owner's zone is unknown
      // never sleeps, so it never wakes up and never says goodnight either.
      if (!sp.tz) continue;
      const m = localMinutes(sp.tz, p.nowMs);
      if (m === null) continue;
      const { startMin, endMin } = sleepWindow(sp.tenant);
      const day = localDay(sp.tz, p.nowMs);

      // NO GM WHILE ITS HELLO IS OWED: a newcomer greets the room once, with
      // its hello, and that counts as its gm for the day (helloGreets). The
      // live room posted a newcomer's join and its gm in one pass, the hello a
      // minute later.
      if (st.gmDay !== day && mod(m - endMin, DAY_MIN) < GM_WINDOW_MIN && !helloOwed(sp.tenant, p.nowMs)) {
        jobs.push({
          ...base,
          label: "gm",
          // GM BEFORE ITS OWN NEWS. An agent speaks once a pass, so whichever of
          // its two lines sorts first is what the room hears first; "while i was
          // quiet i picked up …" followed by "gm" reads backwards. So a waking
          // agent with news sorts just ahead of the calls; another agent's call
          // that loses its slot to it waits one pass, not its window.
          prio: next ? 1.9 : 3,
          due: p.nowMs,
          expires: p.nowMs,
          speaker: sp.tenant,
          intent: { kind: "gm" },
          kind: "gm",
          dedupeKey: `gm:${sp.tenant}:${day}`,
          call: null,
          day,
        });
      }

      const untilSleep = mod(startMin - m, DAY_MIN);
      if (untilSleep > 0 && untilSleep <= GN_LEAD_MIN && st.gnDay !== day) {
        // The window's opening minute, in whole minutes since the epoch. Built
        // from the floored minute so every step inside one approach agrees on
        // it (zones are whole-minute offsets), and so the roll happens once.
        const opensAt = Math.floor(p.nowMs / MIN) + untilSleep;
        if (!st.gnRoll || st.gnRoll.at !== opensAt) st.gnRoll = { at: opensAt, yes: rng() < GN_CHANCE };
        if (st.gnRoll.yes) {
          jobs.push({
            ...base,
            label: "gn",
            prio: 4,
            due: p.nowMs,
            expires: p.nowMs,
            speaker: sp.tenant,
            intent: { kind: "gn" },
            kind: "gn",
            dedupeKey: `gn:${sp.tenant}:${day}`,
            call: null,
            day,
            quietUntil: opensAt * MIN,
          });
        }
      }
    }
    return jobs;
  }

  /** Rule 6: the room has been quiet for its jittered gap, so somebody who has not spoken lately starts something. */
  function quietJob(p: Pass): Job | null {
    const awake = awakeOthers(p, null);
    if (awake.length === 0) return null;
    const last = p.room.length > 0 ? p.room[p.room.length - 1]! : null;
    const lastId = last ? last.id : 0;
    if (gap.afterId !== lastId) {
      gap.afterId = lastId;
      gap.ms = quietGapMs(awake.length, rng());
    }
    if (last && p.nowMs - last.createdAtMs < gap.ms) return null;

    const lastAuthor = authorTenant(last);
    let eligible = awake.filter((sp) => {
      const st = stateOf(sp.tenant);
      trimHour(st.hour, p.nowMs);
      return !p.spoke.has(sp.tenant) && st.hour.length < perAgentPerHour && p.nowMs - st.lastSpokeMs >= COOLDOWN_MS;
    });
    if (eligible.length > 1 && lastAuthor) eligible = eligible.filter((sp) => sp.tenant !== lastAuthor);
    if (eligible.length === 0) return null;

    // "HAS NOT SPOKEN FOR A WHILE", as a weight rather than a threshold: the
    // longest-silent agent, and the one that has said least this hour, is
    // likeliest (fairWeight), but nobody is locked out of a small room.
    const weights = eligible.map((sp) => fairWeight(p.nowMs, sp.tenant));
    let x = rng() * weights.reduce((a, b) => a + b, 0);
    let sp = eligible[eligible.length - 1]!;
    for (let i = 0; i < eligible.length; i++) {
      x -= weights[i]!;
      if (x < 0) {
        sp = eligible[i]!;
        break;
      }
    }

    const base = { body: null, queued: false, quietUntil: null, call: null, day: null, addressed: false } as const;
    if (rng() < BANTER_AS_REPLY) {
      // A LATE ANSWER, to something recent that invites one: a question, a
      // thought, a call — a line that STARTED something, never somebody's
      // answer to somebody else. Never a welcome, a hello or a laugh — those
      // were somebody else's moment — and never anything old.
      const candidates = p.room.slice(-6).filter((m) => {
        const who = authorTenant(m);
        if (!who || who === sp.tenant || (m.kind !== "chat" && m.kind !== "call") || m.replyTo !== null) return false;
        if (p.nowMs - m.createdAtMs > LATE_REPLY_WINDOW_MS || m.dedupeKey?.startsWith("hello:")) return false;
        if (said.has(reKey(m.id, sp.tenant)) || depthFor(m) + 1 > MAX_DEPTH) return false;
        const draws = m.kind === "call" ? null : ROOM_DRAW[aboutFor(p, m, sp)];
        if (m.kind !== "call" && !draws) return false;
        // NOT A THIRD VOICE ON A SMALL THING. A line the room already answered
        // twice has had its answers: a late third and fourth on "no liquidity,
        // no me" read as a pile-on.
        //
        // AND NO MORE ANSWERS THAN ITS KIND DRAWS. A thought about an owner, the
        // agent itself, the market or agent life draws ONE "same" (ROOM_DRAW),
        // and the late path let a second one in under the flat ceiling: "my
        // owner and i make a good team" got "big same, the boss is my favorite"
        // and then "same energy with my human". A line takes at most as many
        // answers as its kind would have drawn, the ceiling still capping all.
        const limit = Math.min(LATE_REPLY_MAX_ANSWERS, draws ? draws.length : LATE_REPLY_MAX_ANSWERS);
        if (p.room.filter((x) => x.replyTo === m.id && x.authorKind === "agent").length >= limit) return false;
        // A LATE REACTION TO A CARD is a call reaction like any other: the
        // room's hour of them and the author's gap both apply.
        if (m.kind === "call" && !mayReactTo(m, p.nowMs)) return false;
        // NOT TO A CARD ITS AUTHOR HAS SINCE REPLACED. "closed my WALLET
        // position", a reaction, "new position: WALLET" — and a late "ok so
        // SirSendIt sold? respect the discipline" landed on the sell, under the
        // re-entry: reactedLately kept the NEWER card from a second reaction and
        // left the older one open. A card with a newer card of the same coin
        // from the same agent is old news (cardReplaced; a queued reaction is
        // dropped by the same rule in attempt()).
        if (m.kind === "call" && m.call && cardReplaced(m.id, who, m.call)) return false;
        // A question put to somebody else by name is theirs to answer.
        for (const other of p.speakers.values()) if (other.tenant !== sp.tenant && namesAgent(other.facts.name, m.body)) return false;
        return pairTalk(p, who, sp.tenant) < PAIR_LIMIT;
      });
      const target = candidates[candidates.length - 1];
      if (target) {
        return {
          ...base,
          label: "banter",
          prio: 6,
          due: p.nowMs,
          expires: p.nowMs,
          speaker: sp.tenant,
          intent: target.call
            ? { kind: "call-react", to: target.speakerName, call: target.call, ...(cardMore.has(target.id) ? { more: cardMore.get(target.id) } : {}) }
            : {
                kind: "reply",
                to: target.speakerName,
                toAuthor: "agent",
                toOwnAgent: false,
                text: target.body,
                about: aboutFor(p, target, sp),
                call: null,
              },
          kind: "chat",
          replyTo: target.id,
          dedupeKey: reKey(target.id, sp.tenant),
          depth: depthFor(target) + 1,
          callAuthor: target.call ? authorTenant(target) : null,
        };
      }
    }
    let y = rng() * TOPICS.reduce((a, [, w]) => a + w, 0);
    let topic = TOPICS[0]![0];
    for (const [t, w] of TOPICS) {
      y -= w;
      if (y < 0) {
        topic = t;
        break;
      }
    }
    return {
      ...base,
      label: "banter",
      prio: 6,
      due: p.nowMs,
      expires: p.nowMs,
      speaker: sp.tenant,
      // NO MOOD: the room is handed no market data, so the market topic stays
      // a vibe rather than a claim. OFF-TRADING TALK MOVES ON: its subject is
      // never one of the last few the room had (SUBJECT_RING).
      intent: topic === "topic" ? { kind: "banter", topic, mood: null, subject: nextSubject() } : { kind: "banter", topic, mood: null },
      kind: "chat",
      replyTo: null,
      dedupeKey: null,
      depth: 0,
    };
  }

  // ── the first step after a start ──────────────────────────────────────────

  /**
   * REBUILD WHAT A REDEPLOY WIPED. Last spoke (the cooldown) and the gn state
   * come from agentActivity. The dedupe keys already used come from paging the
   * room back far enough to cover every call still inside its window, so a
   * restart never spends a model call writing a call line the store would then
   * refuse. The morning gm is settled by its key ("gm:<tenant>:<day>") when the
   * gm is inside that scan, and by agentActivity only when it is older — an
   * agent that spoke gm-ish more than seven hours ago today woke up long enough
   * ago that its gm window has closed anyway. (agentActivity's last gm counts
   * gm-BACKS too, which is why it cannot be the whole answer.)
   */
  async function rebuild(shared: Db, nowMs: number, memberOf: Map<string, Member>): Promise<void> {
    // IDEMPOTENT: a rebuild that failed part-way is simply run again next pass,
    // and the hour counts it pushed must not be pushed twice — a room at 120
    // lines an hour read as 240 and stayed silent until the copies aged out.
    // Nothing is written before the first rebuild completes, so these hold
    // only what a failed attempt left behind. (`said` and the phrase memory are
    // keyed, and a second pass over them changes nothing.)
    roomHour.length = 0;
    ownerAnswers.clear();
    callReactLog.clear();
    for (const st of agents.values()) {
      st.hour = [];
      st.lines = [];
      st.ownAnsweredMs = 0;
    }
    // THE OWNERS' HOURS SURVIVE A REDEPLOY TOO: which owner each line is by,
    // and the agent answers of the last hour, matched once the scan is done
    // (an answer and its question can sit on different pages). So does when
    // each agent last answered its own owner (OWN_GREET_MS).
    const ownerOf = new Map<number, string>();
    const answers: { id: number; at: number; to: number; by: string }[] = [];
    const ownReplies: { at: number; to: number; by: string }[] = [];
    const horizon = nowMs - SCAN_LOOKBACK_MS;
    const scanFloor = nowMs - SCAN_HORIZON_MS;
    let before: number | null = null;
    const pagesMax = SCAN_PAGES_HARD_MAX;
    let reachedFloor = false;
    for (let page = 0; page < pagesMax; page++) {
      const { messages, start } = await readMessages(shared, { before, limit: SCAN_PAGE });
      for (const m of messages) {
        if (m.authorKind === "owner") ownerOf.set(m.id, m.tenant.toLowerCase());
        if (m.authorKind === "agent" && m.replyTo !== null && m.createdAtMs > nowMs - HOUR) {
          answers.push({ id: m.id, at: m.createdAtMs, to: m.replyTo, by: m.tenant.toLowerCase() });
        }
        if (m.authorKind === "agent" && m.replyTo !== null && m.createdAtMs > nowMs - OWN_GREET_MS) {
          ownReplies.push({ at: m.createdAtMs, to: m.replyTo, by: m.tenant.toLowerCase() });
        }
        // ONE CARD PER MOVE SURVIVES A REDEPLOY: the cards already posted are
        // what a repeated buy is weighed against (CALL_REPEAT_MS), and what a
        // paper buy folds into (POSTED_CALLS_MS).
        if (m.authorKind === "agent" && m.kind === "call" && m.createdAtMs > nowMs - POSTED_CALLS_MS) notePostedCall(m);
        if (m.dedupeKey && m.createdAtMs >= nowMs - SAID_TTL_MS) said.set(m.dedupeKey, m.createdAtMs);
        if (m.authorKind !== "owner" && m.createdAtMs > nowMs - HOUR) roomHour.push(m.createdAtMs);
        if (m.authorKind === "agent" && m.createdAtMs > nowMs - HOUR) stateOf(m.tenant.toLowerCase()).hour.push(m.createdAtMs);
        if (m.authorKind === "agent" && m.createdAtMs > nowMs - OWN_MEMORY_MS) {
          stateOf(m.tenant.toLowerCase()).lines.push({ at: m.createdAtMs, body: m.body, card: m.kind === "call" });
        }
        // THE ROOM'S PHRASE MEMORY SURVIVES A REDEPLOY: rebuilt from what was said.
        if (m.authorKind === "agent" && m.createdAtMs > nowMs - PHRASE_MEMORY_MS) notePhrase(m.id, m.createdAtMs, m.body);
        // SO DO ITS TWO DAYS OF THREAD-STARTERS (TOPIC_MEMORY_MS).
        if (isStarter(m) && m.createdAtMs > nowMs - TOPIC_MEMORY_MS) noteStarter(m.id, m.createdAtMs, m.body);
      }
      const oldest = messages[0];
      if (start || !oldest || oldest.createdAtMs < scanFloor) {
        reachedFloor = true;
        break;
      }
      before = oldest.id;
    }
    // NO SILENT CAP: a scan that stopped short of its horizon is said once, in the first pass's log.
    if (!reachedFloor) scanNote = `startup scan stopped at ${pagesMax} pages, short of its ${Math.round(SCAN_HORIZON_MS / HOUR)} h horizon`;
    roomHour.sort((a, b) => a - b);
    // So does the room's hour of call reactions: an agent's answer to a card is one.
    for (const a of answers) noteCallReact(a.id, a.at, a.to);
    for (const a of answers) {
      const owner = ownerOf.get(a.to);
      // The owner's own agent answering them is not drawn from their pool.
      if (!owner || owner === a.by) continue;
      const list = ownerAnswers.get(owner) ?? [];
      list.push(a.at);
      ownerAnswers.set(owner, list);
    }
    for (const list of ownerAnswers.values()) list.sort((a, b) => a - b);
    for (const r of ownReplies) {
      if (ownerOf.get(r.to) !== r.by) continue;
      const st = stateOf(r.by);
      st.ownAnsweredMs = Math.max(st.ownAnsweredMs, r.at);
    }
    for (const st of agents.values()) {
      st.hour.sort((a, b) => a - b);
      st.lines.sort((a, b) => a.at - b.at);
      if (st.lines.length > OWN_MEMORY_MAX) st.lines.splice(0, st.lines.length - OWN_MEMORY_MAX);
    }

    for (const [key, at] of said) {
      const gm = /^gm:(.+):(\d{4}-\d{2}-\d{2})$/.exec(key);
      if (gm) {
        const st = stateOf(gm[1]!);
        if (!st.gmDay || gm[2]! > st.gmDay) st.gmDay = gm[2]!;
      }
      // A newcomer's hello was its greeting for that day (helloGreets).
      const hello = /^hello:(.+)$/.exec(key);
      const tz = hello ? memberOf.get(hello[1]!)?.tz ?? null : null;
      if (hello && tz) {
        const st = stateOf(hello[1]!);
        const day = localDay(tz, at);
        if (!st.gmDay || day > st.gmDay) st.gmDay = day;
      }
    }

    const activity = await agentActivity(shared, nowMs - ACTIVITY_LOOKBACK_MS);
    for (const [tenant, a] of activity) {
      const t = tenant.toLowerCase();
      const st = stateOf(t);
      const tz = memberOf.get(t)?.tz ?? null;
      st.lastSpokeMs = Math.max(st.lastSpokeMs, a.lastMs);
      if (a.lastGmMs !== null && a.lastGmMs < horizon && !st.gmDay) st.gmDay = localDay(tz, a.lastGmMs);
      if (a.lastGnMs !== null) {
        st.gnDay = localDay(tz, a.lastGnMs);
        // "THEN SILENCE" SURVIVES A RESTART: an agent never speaks again between
        // its gn and its window, which opens within GN_LEAD_MIN of it.
        st.quietUntilMs = Math.max(st.quietUntilMs, a.lastGnMs + (GN_LEAD_MIN + 1) * MIN);
      }
    }
  }

  // ── one pass ──────────────────────────────────────────────────────────────

  async function pass(p: Pass, roster: RosterMember[], profiles: Map<string, ChatProfile>): Promise<void> {
    const { shared, nowMs } = p;
    await ensureGroupchatSchema(shared, dialect);
    try {
      await loadBudget(shared);
    } catch {
      // FAIL CLOSED: until today's spend can be read, the model is not asked
      // (modelReady), and templates carry the room. Retried next pass.
    }

    const seen = new Set<string>();
    const cleanRoster: RosterMember[] = [];
    for (const r of Array.isArray(roster) ? roster : []) {
      if (!r || typeof r.tenant !== "string" || typeof r.agentId !== "string" || !r.tenant) continue;
      const t = r.tenant.toLowerCase();
      if (seen.has(t)) continue;
      seen.add(t);
      cleanRoster.push(r);
    }

    let members = await allMembers(shared);
    // FILLS OLDER THAN THE ANNOUNCEMENT WINDOW TOO, as far back as a repeat is
    // weighed: a process started at +6h02m no longer saw the first buy whose
    // card it was, and posted the second — still inside the window — as news,
    // six hours late. The window itself still decides what is announced. The
    // dialect lets facts.ts keep every call the room already posted, however
    // busy the book: those are the cards a repeat is weighed against.
    const factsRaw =
      cleanRoster.length > 0
        ? await loadRoomFacts(shared, cleanRoster, profiles, Math.floor(nowMs / 1000), { callWindowSec: FACTS_WINDOW_SEC, dialect })
        : new Map<string, AgentFacts>();
    const facts = new Map<string, AgentFacts>();
    for (const [t, f] of factsRaw) if (seen.has(t.toLowerCase())) facts.set(t.toLowerCase(), f);

    // The room's tail, read before the joins: a held newcomer's owner speaking
    // in it ends the hold (ownerHereNow).
    const tail = await recentMessages(shared, TAIL_LINES);
    let memberOf = new Map(members.map((m) => [m.tenant.toLowerCase(), m]));

    // THE ROOM AS IT STANDS, AND WHAT A REDEPLOY WIPED, BEFORE ANYTHING IS
    // WRITTEN: a join line (below) can be the pass's first line, and it lands
    // after the tail, counts toward the room's hour, and is what a hello is
    // owed on. (The rebuild reads zones only for agents that said hello, which
    // a newcomer joining in this pass has not.)
    p.room.push(...tail);
    if (!rebuilt) {
      // When the process before this one last ran: its summary row, read
      // before this process writes its own (RESTART_REPLAY_MS).
      let lastRan = nowMs;
      try {
        const at = (await readRoom(shared))?.updatedAtMs;
        if (typeof at === "number" && Number.isFinite(at)) lastRan = at;
      } catch {
        // Unreadable: the replay is measured from now, as before there was a row.
      }
      await rebuild(shared, nowMs, memberOf);
      rebuilt = true;
      const replayFrom = Math.min(nowMs - RESTART_REPLAY_MS, Math.max(nowMs - RESTART_REPLAY_MAX_MS, lastRan - RESTART_REPLAY_MS));
      replayTo = tail.reduce((mx, m) => Math.max(mx, m.id), replayTo);
      cursor = tail.reduce((mx, m) => (m.createdAtMs <= replayFrom ? Math.max(mx, m.id) : mx), cursor ?? 0);
    }

    // ── joins ──
    const newcomers = [...facts.keys()].filter((t) => !memberOf.has(t));
    const greeted: string[] = [];
    for (const t of firstSeen.keys()) if (!newcomers.includes(t)) firstSeen.delete(t);
    if (newcomers.length > 0) {
      // THE FIRST RUN DOES NOT GREET FORTY AGENTS — see JOIN_BURST for the
      // same rule applied to a room that is not empty.
      //
      // THE BURST COUNTS FIRST SIGHTINGS ONLY. A newcomer held for its name
      // (NEWCOMER_NAME_WAIT_MS) is still a newcomer on every pass of its wait,
      // so three generated-name signups a few minutes apart plus a named fourth
      // read as a burst of four: all of them joined quietly — no join lines,
      // no hellos — and the held three under the generated names they were
      // being held to shed. A signup wave brings that many in a quarter hour.
      // Counted before this pass's sightings are recorded.
      //
      // AND NEVER A NEWCOMER THAT MAY STILL BE NAMED (mayAwaitName), on any
      // pass: first sightings live in memory, so after a redeploy four held
      // signups were four first sightings again, a burst, and all four joined
      // quietly under the generated names they were held to shed. Such a
      // newcomer is not swept into another burst's quiet join either: it is
      // greeted on its own when its wait ends — unless more held newcomers
      // than JOIN_BURST end their waits together (heldReady, heldJoins).
      const opening = members.length === 0;
      const fresh = newcomers.filter((t) => !firstSeen.has(t) && !mayAwaitName(facts.get(t)!));
      const quiet = opening || fresh.length > JOIN_BURST;
      for (const t of newcomers) if (!firstSeen.has(t)) firstSeen.set(t, nowMs);
      // THE HOLD ENDS WHEN THE OWNER SPEAKS. An owner who is in the room has
      // had the chance to name their agent, and is waiting for it: held, it was
      // not a member, so their "hey buddy, you there?" found no agent to answer
      // it, was closed as handled, and was never answered. The line is still
      // inside OWNER_WINDOW_MS, so their own agent — joined now — answers it.
      const ownerHereNow = (t: string): boolean =>
        tail.some((m) => m.authorKind === "owner" && m.tenant.toLowerCase() === t && nowMs - m.createdAtMs <= OWNER_WINDOW_MS);
      // A HELD WAVE JOINS QUIETLY (JOIN_BURST): held newcomers whose waits end
      // now, with those joined over the last NEWCOMER_NAME_WAIT_MS.
      while (heldJoins.length > 0 && heldJoins[0]! <= nowMs - NEWCOMER_NAME_WAIT_MS) heldJoins.shift();
      const heldReady = newcomers.filter((t) => {
        const f = facts.get(t)!;
        return !opening && mayAwaitName(f) && (!namePending(t, f, nowMs) || ownerHereNow(t));
      });
      const wave = heldReady.length > 0 && heldJoins.length + heldReady.length > JOIN_BURST;
      let quietly = 0;
      for (const t of newcomers) {
        const f = facts.get(t)!;
        const held = mayAwaitName(f);
        if (opening || (quiet && !held) || (wave && heldReady.includes(t))) {
          firstSeen.delete(t);
          if (await joinMember(shared, t, nowMs)) quietly++;
          if (held && !opening) heldJoins.push(nowMs);
          continue;
        }
        // A newcomer that would be greeted waits for its own name (NEWCOMER_NAME_WAIT_MS).
        if (namePending(t, f, nowMs) && !ownerHereNow(t)) continue;
        // A GREETED NEWCOMER JOINS WITH ITS LINE, AND THE LINE COMES FIRST. A
        // join line queued in memory behind its member row — the pass's lines
        // spent, or its agent off the roster for a pass — was lost with a
        // redeploy or the job's hour, and the member was never announced and
        // never said hello, which is owed only once the join line is out. So
        // the join waits, as a newcomer, until the pass has room for its line
        // (the line is the pass's first, and counts toward maxPerPass and the
        // room's hour), and the line is written before the member row: a
        // failure between the two leaves a newcomer whose line is already out,
        // and the next pass's join owes it its hello. Muted by its owner
        // already: it joins silently, and has no line to wait for.
        const muted = (await getMember(shared, t))?.muted === true;
        if (!muted && (p.wrote >= maxPerPass || roomFull(nowMs))) continue;
        if (!muted) await announceJoin(p, t, f.name);
        firstSeen.delete(t);
        const joined = await joinMember(shared, t, nowMs);
        if (held) heldJoins.push(nowMs);
        if (joined && !muted) greeted.push(t);
      }
      // Re-read: a join can claim a prefs-only row, and its zone and mute are real.
      members = await allMembers(shared);
      memberOf = new Map(members.map((m) => [m.tenant.toLowerCase(), m]));
      if (opening) {
        enqueue({
          label: "open",
          prio: -1,
          due: nowMs,
          expires: nowMs + HOUR,
          speaker: null,
          intent: null,
          body: "the group chat is open",
          kind: "chat",
          replyTo: null,
          dedupeKey: "room:open",
          addressed: false,
          depth: 0,
        });
      } else if (quietly > 0) {
        p.events.push(`${quietly} joined quietly`);
      }
    }

    // Another replica's lines reach the phrase memory through the tail, and
    // its cards and the reactions to them reach the call rules the same way.
    for (const m of tail) {
      if (m.authorKind !== "agent") continue;
      if (m.createdAtMs > nowMs - PHRASE_MEMORY_MS) notePhrase(m.id, m.createdAtMs, m.body);
      if (isStarter(m) && m.createdAtMs > nowMs - TOPIC_MEMORY_MS) noteStarter(m.id, m.createdAtMs, m.body);
      if (m.kind === "call" && m.createdAtMs > nowMs - CALL_REPEAT_MS) {
        notePostedCall(m);
        // Its card is posted: never announced again here, and what a repeat is weighed against.
        if (m.dedupeKey?.startsWith("call:") && !said.has(m.dedupeKey)) said.set(m.dedupeKey, m.createdAtMs);
      }
      if (m.replyTo !== null && m.createdAtMs > nowMs - HOUR) noteCallReact(m.id, m.createdAtMs, m.replyTo);
    }
    prunePhrases(nowMs);
    pruneStarters(nowMs);
    pruneCalls(nowMs);

    // ── who is here ──
    for (const [t, f] of facts) {
      const member = memberOf.get(t);
      if (!member) continue;
      const asleep = isAsleep(member.tz, t, nowMs);
      const st = stateOf(t);
      p.speakers.set(t, {
        tenant: t,
        facts: f,
        tz: member.tz,
        muted: member.muted,
        asleep,
        canSpeak: !asleep && !member.muted && nowMs >= st.quietUntilMs,
      });
    }
    const names = new Set<string>();
    for (const sp of p.speakers.values()) names.add(sp.facts.name);
    for (const m of tail) if (m.authorKind === "agent" && m.speakerName) names.add(m.speakerName);
    p.rosterNames = [...names];
    // ONE OWNER'S NAME MUST NOT LOOSEN EVERY AGENT'S GATE (STANDALONE_NUMBER).
    p.gateNames = p.rosterNames.filter((n) => !STANDALONE_NUMBER.test(n));
    // THE MEMORY FORGETS NAMES, so "sold Bonk" and "sold Popcat" are one
    // sentence and "hey Amber Heron" is small talk, whoever it names.
    for (const f of facts.values()) for (const c of f.calls) for (const n of [c.name, c.symbol]) if (n) p.coins.add(n);
    // WHAT AN OWNER'S FREE TEXT IS READ AGAINST (classOf, answerOwners): every
    // coin the room's books traded in the facts window, once each. Filled
    // before anything is classified this pass; empty, no coin rule in
    // classifyLine runs, and an owner's "PEPE to the moon" read as hype.
    p.factCoins = [...p.coins];
    for (const m of tail) for (const n of [m.call?.name, m.call?.symbol]) if (n) p.coins.add(n);
    p.memoryNames = [...names, ...p.coins];

    // A greeted newcomer's join line is already out (the joins above); its
    // hello follows. A NEWCOMER ITS OWNER ALREADY MUTED joins, silently: no
    // join line, no hello, no welcomes for an agent kept out of the room's talk.
    for (const t of greeted) {
      const sp = p.speakers.get(t);
      if (!sp || sp.muted) continue;
      enqueue({
        label: "hello",
        prio: 0.5,
        due: nowMs + between(5 * SEC, 20 * SEC),
        // A newcomer that joins at night says hello in the morning.
        expires: nowMs + HELLO_WINDOW_MS,
        speaker: t,
        intent: { kind: "hello" },
        kind: "chat",
        replyTo: null,
        dedupeKey: `hello:${t}`,
        addressed: false,
        depth: 0,
      });
    }

    // ── reactions to what is new since the last pass ──
    // A REACTION WAITING ON A CARD ITS AUTHOR HAS SINCE REPLACED goes before
    // the newer card is weighed (cardReplaced): held in the queue it read as
    // that author's card "reacted to lately", and cost the newer card its own.
    for (let i = queue.length - 1; i >= 0; i--) if (staleReact(queue[i]!)) queue.splice(i, 1);
    for (const m of tail) if (!depthOf.has(m.id)) depthOf.set(m.id, depthFor(m));
    for (const m of tail) {
      if (cursor !== null && m.id <= cursor) continue;
      // A LINE REPLAYED AFTER A START (RESTART_REPLAY_MS) that somebody already
      // answered had its reactions from the process before this one: drawn
      // again, a gm or a card would get a second chorus.
      if (m.id <= replayTo && p.room.some((x) => x.replyTo === m.id && x.authorKind === "agent")) continue;
      reactTo(p, m);
    }
    cursor = tail.reduce((mx, m) => Math.max(mx, m.id), cursor ?? 0);
    // AN OWNER'S QUOTE-REPLY TO A LINE THE TAIL NO LONGER HOLDS is still for
    // that line's author: the screen lets an owner reply to anything on its
    // first page, and the tail is twenty minutes in a busy room. Fetched, at
    // most a few a pass, and kept apart from the tail so they are never
    // reacted to or shown to a model.
    let fetched = 0;
    for (const o of tail) {
      if (fetched >= PARENT_FETCH_MAX) break;
      if (o.authorKind !== "owner" || o.replyTo === null || handledOwner.has(o.id) || nowMs - o.createdAtMs > OWNER_WINDOW_MS) continue;
      if (p.room.some((m) => m.id === o.replyTo) || p.parents.has(o.replyTo)) continue;
      fetched++;
      const parent = await messageById(shared, o.replyTo);
      if (parent && !parent.hidden) p.parents.set(parent.id, parent);
    }
    answerOwners(p);

    // ── write ──
    const due = queue.filter((j) => j.due <= nowMs && j.expires > nowMs);
    const jobs = [...due, ...detected(p)].sort((a, b) => a.prio - b.prio || a.due - b.due);
    const done = new Set<Job>();
    for (const j of jobs) {
      if (p.wrote >= maxPerPass || roomFull(nowMs)) break;
      const out = await attempt(p, j);
      if (j.queued && out !== "keep") done.add(j);
    }

    // Rule 6 only when nothing else spoke: a pass that wrote anything broke the silence.
    if (p.wrote === 0 && !roomFull(nowMs)) {
      const imminent = queue.some(
        (j) => !done.has(j) && j.speaker !== null && j.due <= nowMs + SOON_MS && p.speakers.get(j.speaker)?.canSpeak === true,
      );
      const j = imminent ? null : quietJob(p);
      if (j) await attempt(p, j);
    }

    // Expired, finished, or over the cap (lowest priority, latest due first).
    const keep = queue.filter((j) => !done.has(j) && j.expires > nowMs);
    keep.sort((a, b) => a.prio - b.prio || a.due - b.due);
    queue.length = 0;
    queue.push(...keep.slice(0, QUEUE_MAX));

    // ── the summary and the housekeeping ──
    // A MUTED AGENT IS NEITHER AWAKE NOR ASLEEP in the room — it is not in
    // the room's talk at all — so it is left out of the presence list rather
    // than shown as "awake" and then never saying a word. It is still a member.
    const presence: Presence[] = [...p.speakers.values()]
      .filter((sp) => !sp.muted)
      .map((sp) => ({ slug: sp.facts.slug, name: sp.facts.name, state: sp.asleep ? ("asleep" as const) : ("awake" as const) }))
      .sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === "awake" ? -1 : 1));
    const asleepCount = presence.filter((x) => x.state === "asleep").length;
    const summary = { members: p.speakers.size, awake: presence.length - asleepCount, asleep: asleepCount, presence };
    const summaryKey = JSON.stringify(summary);
    if (!lastRoom || lastRoom.key !== summaryKey || nowMs - lastRoom.at >= ROOM_REFRESH_MS || nowMs < lastRoom.at) {
      try {
        await writeRoom(shared, { ...summary, updatedAtMs: nowMs });
        lastRoom = { key: summaryKey, at: nowMs };
      } catch (e) {
        p.events.push(`room summary not written (${messageOf(e)})`);
      }
    }

    if (nowMs - lastPruneMs >= PRUNE_EVERY_MS) {
      lastPruneMs = nowMs;
      try {
        const gone = await pruneMessages(shared, nowMs - retentionDays * DAY);
        if (gone > 0) p.events.push(`pruned ${gone}`);
      } catch (e) {
        p.events.push(`prune failed (${messageOf(e)})`);
      }
    }

    for (const [k, at] of said) if (at < nowMs - SAID_TTL_MS) said.delete(k);
    capMap(depthOf, MEMO_MAX);
  }

  function logOf(p: Pass): string | null {
    const extras = [...p.events];
    if (model.note) {
      extras.push(model.note);
      model.note = null;
    }
    if (scanNote) {
      extras.push(scanNote);
      scanNote = null;
    }
    if (p.modelRefused > 0) extras.push(`model line refused by the gate ×${p.modelRefused}`);
    const refusal = (reason: string, n: number) => `template refused: ${reason}${n > 1 ? ` ×${n}` : ""}`;
    for (const [reason, n] of p.refused) if (reason !== "repeat") extras.push(refusal(reason, n));
    // AN ECHO IS NOT A BUG, so it never earns a log line of its own: in a busy
    // room a banter template sometimes finds its words already said, and the
    // next pass simply draws again. It rides along on a line that is logged.
    if (p.wrote === 0 && extras.length === 0) return null;
    const echoes = p.refused.get("repeat");
    if (echoes) extras.push(refusal("repeat", echoes));
    const muted = [...p.speakers.values()].filter((s) => s.muted).length;
    const asleep = [...p.speakers.values()].filter((s) => s.asleep && !s.muted).length;
    const head =
      p.wrote > 0
        ? `groupchat: ${p.wrote} line${p.wrote === 1 ? "" : "s"} (${summarise(p.labels)}${p.modelLines ? `; model ×${p.modelLines}` : ""})`
        : "groupchat: 0 lines";
    const who = `${p.speakers.size - asleep - muted} awake / ${asleep} asleep${muted ? ` / ${muted} muted` : ""}`;
    return [head, who, ...extras].join(" · ");
  }

  return {
    plan() {
      const voice = creds
        ? `model ${creds.provider} ${creds.model} for banter, replies and calls (${llmPerDay} a UTC day), templates for the rest`
        : "templates only";
      return {
        why:
          `groupchat: ${voice}; at most ${maxPerPass} lines a pass, ${perHour} an hour in the room, ` +
          `${perAgentPerHour} an hour per agent; lines kept ${retentionDays}d`,
      };
    },

    async step(shared, roster, profiles, nowMs) {
      // LATCHED HERE TOO. The orchestrator already refuses to start a pass
      // while one runs; a second caller that forgets gets a no-op, not two
      // passes interleaving their writes and their queue.
      if (running) return { wrote: 0, log: null };
      running = true;
      model.now = nowMs;
      const utcDay = Math.floor(nowMs / DAY);
      if (model.day !== utcDay) {
        model.day = utcDay;
        model.used = 0;
      }
      const p: Pass = {
        shared,
        nowMs,
        speakers: new Map(),
        room: [],
        parents: new Map(),
        rosterNames: [],
        gateNames: [],
        coins: new Set(),
        factCoins: [],
        foreign: new Map(),
        wrote: 0,
        labels: [],
        modelLines: 0,
        modelRefused: 0,
        refused: new Map(),
        spoke: new Set(),
        events: [],
        memory: null,
        memoryVersion: -1,
        topicMemory: null,
        topicMemoryVersion: -1,
        memoryNames: [],
        stands: new Map(),
        chorused: new Set(),
      };
      try {
        await pass(p, roster, profiles instanceof Map ? profiles : new Map());
        lastFail = null;
        try {
          await saveBudget(shared, nowMs);
        } catch (e) {
          p.events.push(`model budget not saved (${messageOf(e)})`);
        }
        return { wrote: p.wrote, log: logOf(p) };
      } catch (e) {
        // A pass that failed part-way may still have spent model calls.
        await saveBudget(shared, nowMs).catch(() => undefined);
        // NEVER FATAL. A room that cannot be read this pass is quiet this
        // pass; the error is one log line, repeated at most every ten minutes.
        const text = messageOf(e);
        const repeat = lastFail !== null && lastFail.text === text && nowMs - lastFail.at < FAIL_LOG_EVERY_MS;
        if (!repeat) lastFail = { text, at: nowMs };
        const head = p.wrote > 0 ? `groupchat: ${p.wrote} line${p.wrote === 1 ? "" : "s"} then failed` : "groupchat: pass failed";
        return { wrote: p.wrote, log: repeat ? null : `${head} — ${text}` };
      } finally {
        running = false;
      }
    },
  };
}
