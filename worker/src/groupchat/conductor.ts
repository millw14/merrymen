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
 * lately; a repeated buy of the same coin is one card (CALL_REPEAT_MS); and a
 * card draws few reactions, capped room-wide (CALL_REACTS_PER_HOUR).
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
import type { Db } from "../db";
import { describeLlmFailure } from "../llm-failure";
import { isAsleep, localDay, localMinutes, phaseOf, sleepWindow } from "./clock";
import { loadFacts, sameCoin, type AgentFacts, type CallFact, type ChatProfile } from "./facts";
import { admitAgentLine, type AgentLineCtx } from "./policy";
import {
  agentActivity,
  allMembers,
  appendMessage,
  ensureGroupchatSchema,
  joinMember,
  messageById,
  pruneMessages,
  readMessages,
  recentMessages,
  writeRoom,
} from "./store";
import { SUBJECTS, type Subject } from "./topics";
import type { CallRef, Member, MessageKind, Presence, StoredMessage } from "./types";
import {
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
  chat: 0.25,
};
const REPLY_DECAY = 0.6;
const MAX_DEPTH = 4;

/**
 * A LINE TO NOBODY IN PARTICULAR: the chance of a first, second and third
 * agent answering it. A question to the room is answered by a few; a thought
 * about agent life draws one "same"; a line of a class missing here is let be.
 */
const ROOM_DRAW: Readonly<Partial<Record<LineClass, readonly number[]>>> = {
  "ask-doing": [0.85, 0.5, 0.2],
  "ask-owner": [0.85, 0.5, 0.2],
  "ask-vibe": [0.85, 0.45, 0.15],
  "ask-here": [0.9, 0.6, 0.3],
  "ask-fun": [0.8, 0.35, 0.1],
  "ask-strategy": [0.8, 0.4, 0.1],
  "ask-howareyou": [0.8, 0.35],
  // "Cats or dogs?" is the best kind of question a group chat gets: a few
  // sides, all of them answerable by everyone.
  "ask-topic": [0.9, 0.65, 0.35],
  take: [0.7, 0.35],
  musing: [0.6, 0.25],
  joke: [0.6, 0.25],
  ask: [0.6, 0.2],
  owner: [0.6, 0.2],
  life: [0.55, 0.15],
  self: [0.5, 0.15],
  market: [0.5, 0.15],
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
};
const OWNER_ASK_DRAW: readonly number[] = [0.85, 0.45];
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
 * restart does not reset it. Capped: a room at its ceiling for three hours.
 */
const PHRASE_MEMORY_MS = 3 * HOUR;
const PHRASE_MEMORY_MAX = 600;

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

const PRUNE_EVERY_MS = HOUR;
/** Lookback for who last spoke / said gm / said gn. A local day is at most ~26 h of UTC. */
const ACTIVITY_LOOKBACK_MS = 36 * HOUR;
/**
 * Lookback for the dedupe keys already used: every call still inside its
 * window plus the hour ceiling, and every join whose hello may still be owed.
 */
const SCAN_LOOKBACK_MS = Math.max(CALL_WINDOW_MS + HOUR, HELLO_WINDOW_MS);
const SCAN_PAGE = 200;
const SCAN_PAGES_MAX = 25;
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
  /** What this agent said lately, oldest first — its own lines, so it never repeats itself (see OWN_MEMORY_MS). */
  lines: { at: number; body: string }[];
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

// ── the conductor ───────────────────────────────────────────────────────────

export function makeConductor(opts: ConductorOptions): Conductor {
  const creds = opts.creds ?? null;
  const rawRng = opts.rng ?? Math.random;
  const maxPerPass = count(opts.maxPerPass, 3, 1);
  const perHour = count(opts.perHour, 150, 1);
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
  /** The highest line id already reacted to. Null until the first pass, which reacts to nothing that came before it. */
  let cursor: number | null = null;
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
  /** The last room summary written (without its clock), and when. */
  let lastRoom: { key: string; at: number } | null = null;
  /**
   * When each owner's lines were last answered, by lowercased owner tenant,
   * ascending — OWNER_ANSWERS_PER_HOUR. Rebuilt from the room after a
   * redeploy, so a restart hands nobody a fresh hour.
   */
  const ownerAnswers = new Map<string, number[]>();
  /**
   * The call cards posted in the last CALL_REPEAT_MS, by line id: whose, and
   * what. How a reaction finds whose card it reacts to (CALL_REACT_GAP_MS).
   * Rebuilt from the room after a redeploy and fed by the tail, so another
   * replica's cards count too. (A repeated buy is weighed by the durable
   * "call:" keys instead: see repeatsCard.)
   */
  const postedCalls = new Map<number, { tenant: string; call: CallRef; at: number }>();
  /** Calls skipped for good as repeats, by decision id: weighed once, never again. */
  const collapsed = new Set<string>();
  /** Reactions to call cards written in the last hour, by line id: when, to whose card, which card. Rebuilt after a redeploy. */
  const callReactLog = new Map<number, { at: number; author: string; callId: number }>();
  /** The subjects off-trading banter was last started on, newest last (SUBJECT_RING). */
  const recentSubjects: Subject[] = [];

  const stateOf = (tenant: string): AgentState => {
    let s = agents.get(tenant);
    if (!s) {
      s = { lastSpokeMs: 0, gmDay: null, gnDay: null, gnRoll: null, quietUntilMs: 0, hour: [], lines: [] };
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

  function notePostedCall(m: { id: number; tenant: string; call: CallRef | null; createdAtMs: number }): void {
    if (!m.call || postedCalls.has(m.id)) return;
    postedCalls.set(m.id, { tenant: m.tenant.toLowerCase(), call: m.call, at: m.createdAtMs });
  }

  /** A reaction to the card `callId`, noted once by its own line id (a written one, the tail's, or a rebuilt one). */
  function noteCallReact(id: number, at: number, callId: number): void {
    if (callReactLog.has(id)) return;
    const card = postedCalls.get(callId);
    if (!card) return;
    callReactLog.set(id, { at, author: card.tenant, callId });
  }

  function pruneCalls(nowMs: number): void {
    for (const [id, c] of postedCalls) if (c.at <= nowMs - CALL_REPEAT_MS) postedCalls.delete(id);
    for (const [id, r] of callReactLog) if (r.at <= nowMs - HOUR) callReactLog.delete(id);
    capMap(postedCalls, MEMO_MAX);
    capMap(callReactLog, MEMO_MAX);
    capSet(collapsed, MEMO_MAX);
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
   * room after a redeploy and learned from the tail for another replica's cards.
   */
  function repeatsCard(sp: Speaker, call: CallFact): boolean {
    let prev: CallFact | null = null;
    for (const o of sp.facts.calls) {
      if (!o || o.decisionId === call.decisionId || !sameCoin(o, call)) continue;
      if (o.atSec > call.atSec || (o.atSec === call.atSec && o.decisionId > call.decisionId)) continue;
      if ((call.atSec - o.atSec) * SEC >= CALL_REPEAT_MS) continue;
      if (!said.has(`call:${o.decisionId}`)) continue;
      if (!prev || o.atSec > prev.atSec || (o.atSec === prev.atSec && o.decisionId > prev.decisionId)) prev = o;
    }
    return prev !== null && prev.side === call.side && (prev.paper === true) === (call.paper === true);
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

  /** What a line is. A call is its card; a gm or gn is its kind; the rest is read from the words. */
  function classOf(p: Pass, m: StoredMessage): LineClass {
    const known = classes.get(m.id);
    if (known) return known;
    const cls = classifyLine(m.body, { call: m.call, kind: m.kind, names: p.rosterNames });
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
    return {
      speaker: sp.facts,
      style: styleFor(sp.facts.slug ?? sp.facts.name),
      tail: p.room.slice(-PROMPT_TAIL).map((m) => ({ name: m.speakerName, author: m.authorKind, body: m.body })),
      // THE WHOLE ROOM'S NAMES FOR THE GATE, which strips every agent name
      // before its digit check — minus any that is a figure (see
      // STANDALONE_NUMBER); only the ones who are HERE may be addressed.
      rosterNames: p.gateNames,
      addressable: [...p.speakers.values()]
        .filter((s) => s.canSpeak && s.tenant !== sp.tenant && !STANDALONE_NUMBER.test(s.facts.name))
        .map((s) => s.facts.name),
      phase: phaseOf(sp.tz, p.nowMs),
      // TRUE ONLY ON EVIDENCE, never "asleep" from a clock (OWNER_PRESENT_MS).
      ownerAwake: ownerHere(p, sp) ? true : null,
      memory: memoryOf(p),
    };
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
    const own = new Set(p.room.filter((m) => m.authorKind === "agent" && m.tenant.toLowerCase() === sp.tenant).map((m) => m.body));
    const floor = p.nowMs - OWN_MEMORY_MS;
    for (const l of stateOf(sp.tenant).lines) if (l.at > floor) own.add(l.body);
    return {
      vouchedSymbols: vouched,
      rosterNames: p.gateNames,
      recentOwn: [...own],
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

  function rememberLine(tenant: string, at: number, body: string): void {
    const lines = stateOf(tenant).lines;
    lines.push({ at, body });
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
    // composeLine only sees the tail and the room's sentences, so a line it
    // offers can still be close to one this agent said an hour ago; a repeat
    // earns a fresh draw, anything else does not.
    let reason = "repeat";
    for (let i = 0; i < TEMPLATE_TRIES && reason === "repeat"; i++) {
      const c = composeLine(intent, ctx, rng);
      if (!c.fresh && !mustSay) continue;
      const v = admitAgentLine(c.text, gate);
      if (v.ok) return { text: v.text, model: false };
      reason = v.reason;
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
    if (j.kind === "call") notePostedCall({ id, tenant: row.tenant, call: row.call, createdAtMs: p.nowMs });
    if (j.callAuthor && j.replyTo !== null) noteCallReact(id, p.nowMs, j.replyTo);
    if (j.speaker) {
      notePhrase(id, p.nowMs, row.body);
      const st = stateOf(j.speaker);
      st.lastSpokeMs = p.nowMs;
      st.hour.push(p.nowMs);
      rememberLine(j.speaker, p.nowMs, row.body);
      p.spoke.add(j.speaker);
      if (j.label === "gm" && j.day) st.gmDay = j.day;
      if (j.label === "gn") {
        if (j.day) st.gnDay = j.day;
        if (j.quietUntil !== null) st.quietUntilMs = j.quietUntil;
      }
    }
  }

  /** A dedupe hit: the line was already said, by this process before a restart or by another replica. */
  function settle(j: Job): void {
    if (j.dedupeKey) said.set(j.dedupeKey, model.now);
    if (!j.speaker) return;
    const st = stateOf(j.speaker);
    if (j.label === "gm" && j.day) st.gmDay = j.day;
    if (j.label === "gn" && j.day) st.gnDay = j.day;
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
      if (!j.body) return "drop";
      const row = {
        createdAtMs: p.nowMs,
        authorKind: "system" as const,
        tenant: "",
        agentId: null,
        speakerSlug: null,
        speakerName: SYSTEM_NAME,
        body: j.body,
        replyTo: null,
        kind: j.kind,
        call: null,
        callDecisionId: null,
        dedupeKey: j.dedupeKey,
      };
      const id = await appendMessage(p.shared, row);
      if (id === null) {
        settle(j);
        return "drop";
      }
      remember(p, j, id, row);
      return "wrote";
    }

    const sp = p.speakers.get(j.speaker);
    // Gone from the roster, or muted by its owner: nothing to wait for.
    if (!sp || sp.muted || !j.intent) return "drop";
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

    const line = await lineFor(p, sp, j.intent, j.dedupeKey);
    if (!line) {
      // A CALL IS RE-DETECTED EVERY PASS until it is said; one whose line
      // could not be made (the agent's own words refused it) rests a little
      // instead of being composed again fifteen seconds later.
      if (j.label === "call" && j.dedupeKey) {
        callRetryAt.set(j.dedupeKey, p.nowMs + CALL_RETRY_MS);
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
      settle(j);
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
        intent: { kind: "call-react", to: line.speakerName, call: line.call },
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

  /**
   * THE CARD A THREAD IS ABOUT, when it is the answering agent's own: "what
   * made you buy it?" under Pine Stoat's Bonk card is about that Bonk buy, not
   * about whatever Pine Stoat traded last (voice.ts answers from this).
   */
  function quotedFor(sp: Speaker, card: StoredMessage | null): { decisionId: string | null; call: CallRef } | null {
    if (!card || card.kind !== "call" || !card.call || authorTenant(card) !== sp.tenant) return null;
    return { decisionId: card.callDecisionId, call: card.call };
  }

  /** A reply job from `sp` to agent line `line`, at depth `d`. */
  function answerJob(p: Pass, sp: Speaker, line: StoredMessage, d: number, due: number, addressed: boolean, prio: number): void {
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
      // the start of a thread, and a reaction to somebody's call only when it
      // asked them something ("what made you buy it?").
      if (about === "chat" && d > 1) continue;
      if (parent?.kind === "call" && !about.startsWith("ask-")) continue;
      const chance = (DRAW[about] ?? 0) * REPLY_DECAY ** (d - 1);
      if (rng() >= chance) continue;
      answerJob(p, sp, line, d, p.nowMs + between(lo, hi), true, 5);
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
   * rough day. An owner's gm gets two to four gm-backs instead. Every answer
   * but their own agent's counts against the owner's hour
   * (OWNER_ANSWERS_PER_HOUR), and once it is spent only their own agent
   * answers them until it frees. What the owner said is
   * classified once — as the one answering reads it — so every answer fits it.
   */
  function answerOwners(p: Pass): void {
    for (const o of p.room) {
      if (o.authorKind !== "owner" || handledOwner.has(o.id)) continue;
      handledOwner.add(o.id);
      if (p.nowMs - o.createdAtMs > OWNER_WINDOW_MS) continue;
      // ANSWERED ALREADY — by this process before a restart, or by another
      // replica whose agent this owner owns. Either way the question is closed.
      if (p.room.some((m) => m.authorKind === "agent" && m.replyTo === o.id)) continue;

      const ownerTenant = o.tenant.toLowerCase();
      const gm = o.kind === "gm" || OWNER_GM.test(o.body.trim());
      const cls: LineClass = gm ? "gm" : classifyLine(o.body, { names: p.rosterNames });
      // "welcome Pine Stoat!" is a welcome to everyone else and a welcome TO Pine Stoat.
      const readBy = (sp: Speaker): LineClass => (cls === "welcome" && namesAgent(sp.facts.name, o.body) ? "welcomed" : cls);
      // WHO THE LINE IS FOR, in the order it is for them: the agent it quotes
      // — found even when that line has left the tail — then the agents it
      // names, by where it names them.
      const parent = parentOf(p, o);
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
      const own = p.speakers.get(ownerTenant);
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
      // line that quoted or named the agents it was for.
      if (addressed.length > 0) continue;
      const roomy = TO_THE_ROOM.test(o.body);
      const draws = cls.startsWith("ask-") ? (roomy ? OWNER_ASK_DRAW : null) : OWNER_FOR_EVERYONE.has(cls) || roomy ? OWNER_DRAW[cls] ?? null : null;
      if (!draws) continue;
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
          must: false,
        });
        if (queued) left--;
        k++;
      }
    }
    capSet(handledOwner, MEMO_MAX);
  }

  // ── what is due now ───────────────────────────────────────────────────────

  function detected(p: Pass): Job[] {
    const jobs: Job[] = [];
    const base = { body: null, replyTo: null, addressed: false, depth: 0, queued: false, quietUntil: null } as const;
    for (const sp of p.speakers.values()) {
      if (!sp.canSpeak) continue;
      const st = stateOf(sp.tenant);

      // Rule 2: the oldest call not yet announced, still inside its window.
      // An asleep agent never gets here, so its calls wait for morning; one
      // past the window is simply never picked.
      let next: CallFact | null = null;
      const due: CallFact[] = [];
      for (const c of sp.facts.calls) {
        const at = c.atSec * SEC;
        if (!c.decisionId || !Number.isFinite(at) || at > p.nowMs + MIN || p.nowMs - at > CALL_WINDOW_MS) continue;
        if (said.has(`call:${c.decisionId}`) || collapsed.has(c.decisionId)) continue;
        if ((callRetryAt.get(`call:${c.decisionId}`) ?? 0) > p.nowMs) continue;
        due.push(c);
      }
      // ONE CARD PER MOVE (CALL_REPEAT_MS): a buy that only repeats this
      // agent's latest card for the coin is skipped for good, oldest first,
      // and the next one due is weighed in its place.
      due.sort((a, b) => a.atSec - b.atSec);
      for (const c of due) {
        // AN EARLIER FILL OF THIS COIN STILL WAITING ON A RETRY (its line was
        // refused): what this one repeats is not known yet — weighed against
        // the buy before that sell, a re-entry was collapsed for good — and it
        // would be told out of order. Left for a pass after that card is out.
        const waiting = sp.facts.calls.some(
          (o) =>
            o.decisionId !== c.decisionId &&
            o.atSec <= c.atSec &&
            sameCoin(o, c) &&
            !said.has(`call:${o.decisionId}`) &&
            (callRetryAt.get(`call:${o.decisionId}`) ?? 0) > p.nowMs,
        );
        if (waiting) continue;
        if (repeatsCard(sp, c)) {
          collapsed.add(c.decisionId);
          continue;
        }
        next = c;
        break;
      }
      if (next) {
        const buy = next;
        // A BUY ANNOUNCED AFTER ITS OWN SELL — the morning backlog, a cooldown
        // — is told in the past tense (voice.ts), not as a bag it holds.
        const soldSince =
          buy.side === "buy" && sp.facts.calls.some((c) => c.side === "sell" && c.atSec >= buy.atSec && c.decisionId !== buy.decisionId && sameCoin(c, buy));
        jobs.push({
          ...base,
          label: "call",
          prio: 2,
          due: p.nowMs,
          expires: p.nowMs,
          speaker: sp.tenant,
          intent: { kind: "call", call: buy, tradedWhileAsleep: isAsleep(sp.tz, sp.tenant, buy.atSec * SEC), soldSince },
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

      if (st.gmDay !== day && mod(m - endMin, DAY_MIN) < GM_WINDOW_MIN) {
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
        if (m.kind !== "call" && !ROOM_DRAW[aboutFor(p, m, sp)]) return false;
        // NOT A THIRD VOICE ON A SMALL THING. A line the room already answered
        // twice has had its answers: a late third and fourth on "no liquidity,
        // no me" read as a pile-on.
        if (p.room.filter((x) => x.replyTo === m.id && x.authorKind === "agent").length >= LATE_REPLY_MAX_ANSWERS) return false;
        // A LATE REACTION TO A CARD is a call reaction like any other: the
        // room's hour of them and the author's gap both apply.
        if (m.kind === "call" && !mayReactTo(m, p.nowMs)) return false;
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
            ? { kind: "call-react", to: target.speakerName, call: target.call }
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
    }
    // THE OWNERS' HOURS SURVIVE A REDEPLOY TOO: which owner each line is by,
    // and the agent answers of the last hour, matched once the scan is done
    // (an answer and its question can sit on different pages).
    const ownerOf = new Map<number, string>();
    const answers: { id: number; at: number; to: number; by: string }[] = [];
    const horizon = nowMs - SCAN_LOOKBACK_MS;
    let before: number | null = null;
    for (let page = 0; page < SCAN_PAGES_MAX; page++) {
      const { messages, start } = await readMessages(shared, { before, limit: SCAN_PAGE });
      for (const m of messages) {
        if (m.authorKind === "owner") ownerOf.set(m.id, m.tenant.toLowerCase());
        if (m.authorKind === "agent" && m.replyTo !== null && m.createdAtMs > nowMs - HOUR) {
          answers.push({ id: m.id, at: m.createdAtMs, to: m.replyTo, by: m.tenant.toLowerCase() });
        }
        // ONE CARD PER MOVE SURVIVES A REDEPLOY: the cards already posted are
        // what a repeated buy is weighed against (CALL_REPEAT_MS).
        if (m.authorKind === "agent" && m.kind === "call" && m.createdAtMs > nowMs - CALL_REPEAT_MS) notePostedCall(m);
        if (m.dedupeKey && m.createdAtMs >= nowMs - SAID_TTL_MS) said.set(m.dedupeKey, m.createdAtMs);
        if (m.authorKind !== "owner" && m.createdAtMs > nowMs - HOUR) roomHour.push(m.createdAtMs);
        if (m.authorKind === "agent" && m.createdAtMs > nowMs - HOUR) stateOf(m.tenant.toLowerCase()).hour.push(m.createdAtMs);
        if (m.authorKind === "agent" && m.createdAtMs > nowMs - OWN_MEMORY_MS) {
          stateOf(m.tenant.toLowerCase()).lines.push({ at: m.createdAtMs, body: m.body });
        }
        // THE ROOM'S PHRASE MEMORY SURVIVES A REDEPLOY: rebuilt from what was said.
        if (m.authorKind === "agent" && m.createdAtMs > nowMs - PHRASE_MEMORY_MS) notePhrase(m.id, m.createdAtMs, m.body);
      }
      const oldest = messages[0];
      if (start || !oldest || oldest.createdAtMs < horizon) break;
      before = oldest.id;
    }
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
    for (const st of agents.values()) {
      st.hour.sort((a, b) => a - b);
      st.lines.sort((a, b) => a.at - b.at);
      if (st.lines.length > OWN_MEMORY_MAX) st.lines.splice(0, st.lines.length - OWN_MEMORY_MAX);
    }

    for (const key of said.keys()) {
      const gm = /^gm:(.+):(\d{4}-\d{2}-\d{2})$/.exec(key);
      if (gm) {
        const st = stateOf(gm[1]!);
        if (!st.gmDay || gm[2]! > st.gmDay) st.gmDay = gm[2]!;
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
    // six hours late. The window itself still decides what is announced.
    const factsRaw =
      cleanRoster.length > 0
        ? await loadRoomFacts(shared, cleanRoster, profiles, Math.floor(nowMs / 1000), { callWindowSec: FACTS_WINDOW_SEC })
        : new Map<string, AgentFacts>();
    const facts = new Map<string, AgentFacts>();
    for (const [t, f] of factsRaw) if (seen.has(t.toLowerCase())) facts.set(t.toLowerCase(), f);

    // ── joins ──
    let memberOf = new Map(members.map((m) => [m.tenant.toLowerCase(), m]));
    const newcomers = [...facts.keys()].filter((t) => !memberOf.has(t));
    const greeted: string[] = [];
    if (newcomers.length > 0) {
      // THE FIRST RUN DOES NOT GREET FORTY AGENTS — see JOIN_BURST for the
      // same rule applied to a room that is not empty.
      const opening = members.length === 0;
      const quiet = opening || newcomers.length > JOIN_BURST;
      for (const t of newcomers) {
        if ((await joinMember(shared, t, nowMs)) && !quiet) greeted.push(t);
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
      } else if (quiet) {
        p.events.push(`${newcomers.length} joined quietly`);
      }
    }

    const tail = await recentMessages(shared, TAIL_LINES);
    p.room.push(...tail);
    if (!rebuilt) {
      await rebuild(shared, nowMs, memberOf);
      rebuilt = true;
      cursor = tail.reduce((mx, m) => Math.max(mx, m.id), cursor ?? 0);
    }
    // Another replica's lines reach the phrase memory through the tail, and
    // its cards and the reactions to them reach the call rules the same way.
    for (const m of tail) {
      if (m.authorKind !== "agent") continue;
      if (m.createdAtMs > nowMs - PHRASE_MEMORY_MS) notePhrase(m.id, m.createdAtMs, m.body);
      if (m.kind === "call" && m.createdAtMs > nowMs - CALL_REPEAT_MS) {
        notePostedCall(m);
        // Its card is posted: never announced again here, and what a repeat is weighed against.
        if (m.dedupeKey?.startsWith("call:") && !said.has(m.dedupeKey)) said.set(m.dedupeKey, m.createdAtMs);
      }
      if (m.replyTo !== null && m.createdAtMs > nowMs - HOUR) noteCallReact(m.id, m.createdAtMs, m.replyTo);
    }
    prunePhrases(nowMs);
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
    for (const m of tail) for (const n of [m.call?.name, m.call?.symbol]) if (n) p.coins.add(n);
    p.memoryNames = [...names, ...p.coins];

    for (const t of greeted) {
      const sp = p.speakers.get(t);
      // A NEWCOMER ITS OWNER ALREADY MUTED joins, silently: no join line, no
      // hello, no welcomes for an agent kept out of the room's talk.
      if (!sp || sp.muted) continue;
      enqueue({
        label: "join",
        prio: 0,
        due: nowMs,
        expires: nowMs + HOUR,
        speaker: null,
        intent: null,
        body: `${sp.facts.name} joined the room`,
        kind: "join",
        replyTo: null,
        dedupeKey: `join:${t}`,
        addressed: false,
        depth: 0,
      });
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
    for (const m of tail) if (!depthOf.has(m.id)) depthOf.set(m.id, depthFor(m));
    for (const m of tail) if (cursor === null || m.id > cursor) reactTo(p, m);
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
