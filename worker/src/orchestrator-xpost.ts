/**
 * POSTING ON X, FROM THE ORCHESTRATOR — the glue between the room's pieces and
 * worker/src/xpost/ (docs/x-posting.md).
 *
 * WHY THE GLUE LIVES HERE. xpost/ never imports the group room (its
 * boundary.test.ts, and the room's, pin that): X is not in the room and the
 * room is not on the X path. But the room already owns exactly what an X post
 * needs to know about an agent — its facts (name, mode, strategy, traits, the
 * landed or paper calls that passed publishableThesis), its typing style, the
 * owner's zone and sleep window, the agent-line gate, and a dedicated model
 * key. orchestrator*.ts is the one place allowed to hold both, so this file
 * reads the room's pieces and hands xpost/ plain data and functions:
 *
 *   - loadFacts           → the planner's calls and the writer's facts
 *   - styleFor            → the writer's style (lowercase, emoji, "!")
 *   - getMember + clock   → the owner's zone (the room's, else the one the
 *                           owner consented from), local day, afternoon and night
 *   - admitAgentLine      → the base gate admitXPost runs first
 *   - STRATEGY_SPOKEN, STRATEGY_FLAVOUR, TRAIT_VOICE → the writer's words for how the agent trades
 *   - SUBJECTS/TAKES/MUSINGS → a casual post's seed, to riff on, never copy
 *   - groupChatCreds      → the writer's fallback key when X has none of its own
 *
 * ONE STEP, TWO HALVES, NEVER A THROW. `step` first SENDS what is due (every
 * pass), then PLANS (at most once a minute): drafts each intent with the
 * model, gates it, and writes it scheduled — or writes it skipped, so a buy
 * the gate refused or the model passed on is not drafted again every minute
 * on the model's allowance. An active agent's answers drafted on a pass that
 * has just read its mentions (and recorded every opt-out in them) are then
 * sent by a second, short sweep through the same send path, on that pass.
 * Everything is caught; a failure is one log line,
 * deduplicated like the room's. The pass runs un-awaited behind a latch in
 * orchestrator.ts, so a slow X or a slow model costs a post, never a
 * reconcile (rule 6).
 *
 * WHAT IT NEVER DOES: read a decision's reason, a size, a price or a balance
 * (loadFacts has none to give), log a post's body or a token (the summary is
 * counts), post for a tenant whose lease this replica does not hold healthily
 * (the roster is only those), or write anything but xpost_* rows.
 */
import type { Db } from "./db";
import type { llmText } from "./llm";
import { storeDek } from "./store-crypto";
import { loadFacts, type AgentFacts, type ChatProfile, type RosterEntry } from "./groupchat/facts";
import { admitAgentLine } from "./groupchat/policy";
import { groupChatCreds, styleFor, type LlmCreds } from "./groupchat/voice";
import { isAsleep, localDay, localMinutes } from "./groupchat/clock";
import { ensureGroupchatSchema, getMember } from "./groupchat/store";
import { STRATEGY_FLAVOUR, STRATEGY_SPOKEN, TRAIT_VOICE } from "./groupchat/templates";
import { MUSINGS, SUBJECTS, TAKES } from "./groupchat/topics";
import { xAppFromEnv, type FetchLike, type XApp, type XReply } from "./xpost/client";
import { admitXPost, lettersOf, merrymenMentioned, moneySaid, namedIn, tickerRefusal, unreadableLetter, vocabularyRefusal, type BaseGate, type XGateCtx } from "./xpost/gate";
import { ACTIVE_CADENCE, ANSWER_GAP_MS, ANSWER_STALE_MS, ANSWERS_PER_DAY, RECAP_CALLS_PER_AGENT, RECAP_GAP_MS, RECAP_WINDOW_MS, REPLY_STALE_MS, STANDARD_CADENCE, coinOf, hash32, introState, isWin, planPosts, recapCoverOf, recapCoverText, replyDueAt, sendDecision, type PlanCadence, type PlanClock, type PlanIntent, type PlanSell } from "./xpost/planner";
import { APP_PAUSE_KEY, APP_PAUSE_MS, CREDITS_PAUSE_MS, PAUSE_KEY, readReplyComments, sendOne, type CardOutcome, type SendOutcome } from "./xpost/sender";
import { isAnswerOptOut, isReplyOptOut, plainAsk, replyCandidate, tagCandidate, withoutReplyOptOut } from "./xpost/replies";
import { asksAboutACoin, coinTalkIn, deicticPickIn, houseTalkIn, marketTalkIn, nameLikeWords, textWords, trustTalkIn, unknownWordIn } from "./xpost/words";
import { activeTenantsOf, repliesAllowedFor, repliesScopeOf } from "./xpost/scope";
import {
  ANSWER_LOOKED_UP,
  answerAuthorSpent,
  answersWaiting,
  cancelPost,
  claimSpan,
  deferPost,
  duePosts,
  ensureXpostSchema,
  failInterrupted,
  getAccount,
  introPostsOf,
  keyStatus,
  lastOutAt,
  postingAccounts,
  postsOfXUser,
  recapPostsOf,
  ownerSendTimesSince,
  tradeSendTimesSince,
  optOutReplies,
  ownThreadTweets,
  repliesEnabledFor,
  replyConsentAt,
  firstReplyConsentAt,
  repliesOffKey,
  repliesOptedOut,
  ownRecentBodies,
  readMeta,
  recentBodies,
  releaseSpan,
  returnAllowance,
  schedulePost,
  setReplying,
  skipScheduled,
  takeAllowance,
  takeOwnerAllowance,
  writeMeta,
  type XAccount,
  type XPost,
} from "./xpost/store";
import { answerPrompt, answerQuestion, buyPrompt, casualPrompt, checkPrompt, INSIGHT_VOCABULARY, insightPrompt, introPrompt, introTemplate, modelAnswers, replyPrompt, sellPrompt, sherwoodClaimed, sherwoodMentioned, sherwoodNamed, tryDraft, xpostModel, xpostModelWarning, type AnswerIntentKind, type DraftResult, type WriterFacts, type XStyle } from "./xpost/writer";
import { appendPublicToken, appendPublicWallet, hasPublicWallet, publicTokenStillAllowed, publicWalletStillAllowed, type PublicWallet } from "./xpost/public-wallet";
import { readPublicProjectDescription } from "./orchestrator-xpost-project";
import { banterAsk, boughtNames, carriesResearch, classifyTag, createXResearch, generalTradesQuestion, MARKET_MAJORS, modelNamed, namesACoin, ownCoinTicker, sayable, selfAsk, unshowableName, type ResearchBundle, type TagIntent, type XResearch } from "./orchestrator-xpost-research";
import { PUBLISHABLE_SOURCES } from "./thesis-policy";
import { readSaleCard, readSaleResults } from "./orchestrator-xpost-results";
import { renderPnlCard, type PnlCardData } from "./pnl-card";
import { appendSaleOutcome, hasSaleOutcome } from "./xpost/sale-outcome";
import { saleLines } from "./xpost/sale-words";
import { admitFiguresLine, cleanTicker, figuresTickers, withFigures, type FiguresSpec } from "./xpost/figures";
import { hotAnswers, hotNoneAnswers, hotUnreadAnswers, insightFacts, majorAnswers, majorUnreadAnswers, marketAnswers, type HotRead, type MajorRead, type MarketRead } from "./xpost/market";
import { selfAnswers, tradesAnswers } from "./xpost/casual";
import { recapFigures, recapLines, recapStillHolds } from "./xpost/recap";
import { accusationIn, CHECK_VOCABULARY, checkAnswers, type CheckRead } from "./xpost/check";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEFAULT_PER_DAY = 3;
export const DEFAULT_FLEET_PER_DAY = 1000;
export const DEFAULT_LLM_PER_DAY = 400;
export const DEFAULT_REPLY_POLLS_PER_DAY = 200;
const REPLY_POLL_MS = 30 * MIN;
/**
 * AN ACTIVE AGENT'S MENTIONS ARE READ EVERY FIFTEEN SECONDS — every pass, as
 * the orchestrator runs one every RECONCILE_MS (orchestrator.ts) — so a tag is
 * answered within seconds, about as fast as a Telegram group answers: its
 * answers go out as soon as they are drafted. Those polls spend an allowance
 * of their own, per X account and UTC day (`reply-polls-active:<xUserId>:<day>`),
 * never the fleet's (`reply-polls:<day>`): the fleet's polls cannot starve it,
 * nor it theirs. 6000 covers a whole day at one read every fifteen seconds
 * (5760); spent, the account waits for tomorrow's. Active accounts are still
 * read first within the pass's MAX_REPLY_POLLS_PER_PASS, and X's 429 backoff
 * and the credits and app pauses hold them like everyone else.
 * MERRYMEN_XPOST_REPLY_POLLS_PER_DAY=0 still turns every poll off.
 */
export const ACTIVE_REPLY_POLL_MS = 15_000;
export const ACTIVE_REPLY_POLLS_PER_DAY = 6000;
/** Tags an active agent may answer from one poll's batch. */
const ANSWERS_PER_POLL = 3;
/**
 * MODEL CALLS AN X ACCOUNT'S ANSWERS MAY SPEND PER UTC DAY
 * (`llm-answers:<xUserId>:<day>`), taken before the fleet's `llm:<day>` and
 * counted in it too. A draft the model PASSes or the gate refuses counts
 * toward none of the day's answers, so without this a wave of strangers'
 * tags could spend the whole fleet's allowance and stop every owner's posts.
 *
 * FORTY-EIGHT, AS BEFORE (2026-10-12): the day's answers went from 24 to 60
 * (ANSWERS_PER_DAY), the model allowance did not. Code's own lines (the
 * market, what's hot, a major, its strategy, its buys, the model question)
 * spend no model call, so the extra answers come from those, and a
 * day of drafts is still at most this many of the fleet's DEFAULT_LLM_PER_DAY.
 */
export const ANSWER_DRAFTS_PER_DAY = 48;
const MAX_REPLY_POLLS_PER_PASS = 2;
/** Plans are drafted at most this often; sends run every pass. */
const PLAN_EVERY_MS = MIN;
/**
 * A `sending` claim older than this belonged to a pass that died mid-call.
 * Well above the longest a live pass sends for (SEND_BUDGET_MS, plus one
 * send's calls on X), because another replica's sweep would otherwise fail
 * a claim that is still in flight: X creates the post, the row says it did
 * not, and it drops out of the gap, the cap and the echo memory.
 */
const INTERRUPTED_AFTER_MS = 30 * MIN;
/** A pass stops starting sends after this long; the rest go next pass. */
const SEND_BUDGET_MS = 5 * MIN;
/** Bounds on one pass: each send can wait ten seconds on X, each draft twenty on a model. */
const MAX_DUE = 50;
/** Due rows looked at in one pass, page by page, before the rest waits for the next. */
const MAX_SCAN = 500;
const MAX_SENDS_PER_PASS = 20;
const MAX_DRAFTS_PER_PASS = 10;
/**
 * ANSWERS AND COMMENT REPLIES HAVE THEIR OWN BOUND, apart from the posts'.
 * They draft from a batch this pass read, whose cursor has already moved on:
 * a batch left behind because other owners' posts used the pass's ten is
 * lost for good. At most MAX_REPLY_POLLS_PER_PASS batches a pass, each worked
 * through ANSWERS_PER_POLL at a time.
 */
const MAX_ANSWER_DRAFTS_PER_PASS = MAX_REPLY_POLLS_PER_PASS * ANSWERS_PER_POLL;
/** What a new draft must not echo: its own account's history, and the fleet's. */
const OWN_MEMORY_MS = 60 * DAY;
const FLEET_MEMORY_MS = 14 * DAY;
const FLEET_MEMORY_MAX = 1000;
/** The planner weighs caps, gaps and the three-day coin fold over this much of an X account's history. */
const PLAN_HISTORY_MS = 4 * DAY;
/** The send side's gap looks at posts drafted this recently: anything that went out in the last three hours was. */
const GAP_HISTORY_MS = 2 * DAY;
/** Template intros tried with fresh dice before the intro is skipped. */
const TEMPLATE_TRIES = 8;
/** Send outcomes after which the post may exist on X: they keep their unit of the fleet's ceiling. */
const MAY_BE_ON_X: ReadonlySet<SendOutcome> = new Set<SendOutcome>(["posted", "uncertain", "fault"]);
/**
 * WHAT A TAG MAY BE READ AS AND STILL GET CODE'S STRATEGY OR BUYS LINE
 * (red-team review of daaae961): chat, a question about its trades, or one
 * about what it can do or how to get an agent. Banter gets no line at all
 * since 2026-10-13 (writeAnswer's smallTalk): "what do you do?", both banter
 * and what it can do, is answered as what it can do.
 */
const CHAT_LINE_KINDS: ReadonlySet<string> = new Set(["chat", "own-trades", "capabilities", "onboarding"]);
/** Log counters that describe a standing condition rather than something that happened. */
const CONDITIONS: ReadonlySet<string> = new Set(["no-model-budget", "zone-unreadable", "owner-failed", "active-reply-polls-spent"]);
/** The most reasons said after one count; the rest are counted, not named. */
const WHYS_SAID = 4;

/**
 * A count's reasons as the log says them: " (insight no-draft:timeout, buy
 * gate:too-short x2)". Operator codes only, and held to their alphabet here
 * too (lowercase letters, digits, ":", "-", "_", one space between kind and
 * reason, at most 64 characters each), so nothing a model or a provider wrote
 * could ever reach the line through one.
 */
export function whyText(whys: ReadonlyMap<string, number> | undefined): string {
  if (!whys?.size) return "";
  const said = [...whys].slice(0, WHYS_SAID).map(([why, n]) => {
    const code = why.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9:_ -]+/g, "").replace(/ +/g, " ").trim().slice(0, 64) || "unknown";
    return n > 1 ? `${code} x${n}` : code;
  });
  const more = whys.size - said.length;
  return ` (${said.join(", ")}${more > 0 ? `, +${more} more` : ""})`;
}

// ── the knobs ───────────────────────────────────────────────────────────────

/**
 * THE OPERATOR'S KNOBS, read the way they mean them — the room's rules
 * (groupChatEnv) applied to X.
 *
 * SET-BUT-EMPTY IS UNSET: a cleared variable asks for the default back, and
 * Number("") is 0.
 *
 * ZERO POSTS IS OFF, and said so: MERRYMEN_XPOST_PER_DAY=0 or
 * MERRYMEN_XPOST_FLEET_PER_DAY=0 turns posting off rather than failing a
 * `> 0` check and running at the default.
 *
 * AN UNREADABLE VALUE IS SAID OUT LOUD, ONCE — by name, never by value: a key
 * pasted into the wrong variable must not land in the log. The two that SPEND fail closed:
 * an unreadable fleet ceiling (each post costs money) turns posting off, and an
 * unreadable model allowance is none — intro templates only. An unreadable
 * per-owner cadence keeps its default, because the default is the safe one.
 */
export interface XPostEnv {
  /** The boot line saying why posting is off, or null when it runs. */
  off: string | null;
  perDay: number | undefined;
  fleetPerDay: number | undefined;
  llmPerDay: number | undefined;
  /** Set only after the operator has X's written approval for AI replies. */
  repliesApproved?: boolean;
  /**
   * MERRYMEN_XPOST_REPLIES_APPROVED=active: replies are approved only for the
   * owners in activeTenants. Everyone else is not polled, drafts nothing, and
   * a reply or answer of theirs still waiting is cancelled at send time.
   */
  repliesActiveOnly?: boolean;
  /** Owners (tenant addresses, lowercase) on ACTIVE_CADENCE; absent or empty is nobody. */
  activeTenants?: ReadonlySet<string>;
  /**
   * MERRYMEN_XPOST_RESEARCH=1: an active agent's answers look things up first
   * (orchestrator-xpost-research.ts). Absent: answers are written from what it
   * already has, and a tag carrying a contract address is not answered.
   */
  research?: boolean;
  /** MERRYMEN_XPOST_FOMO=1, with research on: answers may ask Fomo, paraphrased and attributed. */
  researchFomo?: boolean;
  /** MERRYMEN_XPOST_RESEARCH_PER_HOUR: index lookups per hour across X accounts. Absent: the research default. */
  researchPerHour?: number;
  /**
   * MERRYMEN_XPOST_CHECKS=1, with research on: an active agent answers a larp
   * check (xpost/check.ts). Opt-in, like research and Fomo: it is the house
   * account saying, in public, whether a stranger's project looks real.
   */
  checks?: boolean;
  /** MERRYMEN_XPOST_CHECKS_PER_DAY: larp checks a UTC day across X accounts. Absent: DEFAULT_CHECKS_PER_DAY. */
  checksPerDay?: number;
  replyPollsPerDay?: number;
  /** One boot line per value that was set and could not be honoured as written. */
  notes: string[];
}

/**
 * LARP CHECKS A UTC DAY across X accounts (MERRYMEN_XPOST_CHECKS_PER_DAY): a
 * check holds the one research browser for up to forty seconds and reads
 * GitHub and the index, so it is counted apart from answers.
 */
export const DEFAULT_CHECKS_PER_DAY = 80;

export function xpostEnv(env: Record<string, string | undefined> = process.env): XPostEnv {
  const none = { perDay: undefined, fleetPerDay: undefined, llmPerDay: undefined, notes: [] };
  if ((env.MERRYMEN_XPOST ?? "").trim() === "0") {
    return { ...none, off: "xpost: off — MERRYMEN_XPOST=0, so this orchestrator posts nothing on X (owners can still connect)" };
  }
  const notes: string[] = [];
  const count = (raw: string): number | null => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };

  let perDay: number | undefined;
  const dayRaw = env.MERRYMEN_XPOST_PER_DAY?.trim();
  if (dayRaw) {
    const n = count(dayRaw);
    if (n === null) notes.push(`xpost: ignoring MERRYMEN_XPOST_PER_DAY — it is set but is not a count of posts; each owner keeps the default of ${DEFAULT_PER_DAY} a day`);
    else if (n === 0) return { ...none, off: "xpost: off — MERRYMEN_XPOST_PER_DAY=0 allows no posts" };
    else perDay = n;
  }

  let fleetPerDay: number | undefined;
  const fleetRaw = env.MERRYMEN_XPOST_FLEET_PER_DAY?.trim();
  if (fleetRaw) {
    const n = count(fleetRaw);
    if (n === null) {
      return { ...none, off: "xpost: off — MERRYMEN_XPOST_FLEET_PER_DAY is set but is not a count of posts, and every post costs money; nothing is posted until it is" };
    }
    if (n === 0) return { ...none, off: "xpost: off — MERRYMEN_XPOST_FLEET_PER_DAY=0 allows no posts" };
    fleetPerDay = n;
  }

  let llmPerDay: number | undefined;
  const llmRaw = env.MERRYMEN_XPOST_LLM_PER_DAY?.trim();
  if (llmRaw) {
    const n = count(llmRaw);
    if (n === null) {
      llmPerDay = 0;
      notes.push("xpost: MERRYMEN_XPOST_LLM_PER_DAY is set but is not a count of calls — no model calls until it is; only intros (from templates) and an active owner's recaps (code's own words) are posted");
    } else {
      llmPerDay = n;
    }
  }
  // WHO MAY REPLY: "1" everyone who consents, "active" only the active owners
  // below. Anything else is off, and said by name, never by value.
  const replies = repliesScopeOf(env.MERRYMEN_XPOST_REPLIES_APPROVED);
  if (replies.unreadable) {
    notes.push("xpost: MERRYMEN_XPOST_REPLIES_APPROVED is set but is neither 1 nor active — comment replies and tag answers are off");
  }
  // ACTIVE OWNERS, by tenant address only: a name or a handle is not an
  // identity. An entry that is not an address is said by position, never by
  // value, and dropped; the rest still apply. The web reads the same variable
  // with the same parser (xpost/scope.ts), for the reply warning.
  const { tenants: activeTenants, badEntries } = activeTenantsOf(env.MERRYMEN_XPOST_ACTIVE_TENANTS);
  for (const i of badEntries) notes.push(`xpost: ignoring entry ${i} of MERRYMEN_XPOST_ACTIVE_TENANTS — it is not an owner address`);
  const replyRaw = env.MERRYMEN_XPOST_REPLY_POLLS_PER_DAY?.trim();
  const replyPollsPerDay = replyRaw ? count(replyRaw) : null;
  if (replyRaw && replyPollsPerDay === null) notes.push("xpost: unreadable MERRYMEN_XPOST_REPLY_POLLS_PER_DAY — comment polling is off");
  // RESEARCH FOR ANSWERS, OPT-IN, and Fomo inside it opt-in again: each is
  // outward-facing, so only an exact "1" turns it on. Fomo without research
  // has nothing to ride on, and says so rather than seeming on.
  const research = env.MERRYMEN_XPOST_RESEARCH?.trim() === "1";
  const fomoAsked = env.MERRYMEN_XPOST_FOMO?.trim() === "1";
  if (fomoAsked && !research) notes.push("xpost: MERRYMEN_XPOST_FOMO=1 does nothing without MERRYMEN_XPOST_RESEARCH=1 — answers ask Fomo only while research is on");
  const perHourRaw = env.MERRYMEN_XPOST_RESEARCH_PER_HOUR?.trim();
  const researchPerHour = perHourRaw ? count(perHourRaw) : null;
  if (perHourRaw && researchPerHour === null) notes.push("xpost: ignoring MERRYMEN_XPOST_RESEARCH_PER_HOUR — it is not a count of lookups; the default applies");
  // LARP CHECKS, OPT-IN, and only on research: a check is a research lane.
  const checksAsked = env.MERRYMEN_XPOST_CHECKS?.trim() === "1";
  if (checksAsked && !research) notes.push("xpost: MERRYMEN_XPOST_CHECKS=1 does nothing without MERRYMEN_XPOST_RESEARCH=1 — a larp check is research");
  const checksRaw = env.MERRYMEN_XPOST_CHECKS_PER_DAY?.trim();
  const checksPerDay = checksRaw ? count(checksRaw) : null;
  if (checksRaw && checksPerDay === null) notes.push("xpost: ignoring MERRYMEN_XPOST_CHECKS_PER_DAY — it is not a count of checks; the default applies");
  return { off: null, perDay, fleetPerDay, llmPerDay, notes,
    ...(replies.scope !== "off" ? { repliesApproved: true } : {}),
    ...(replies.scope === "active" ? { repliesActiveOnly: true } : {}),
    ...(activeTenants.size ? { activeTenants } : {}),
    ...(research ? { research: true } : {}),
    ...(research && fomoAsked ? { researchFomo: true } : {}),
    ...(researchPerHour !== null ? { researchPerHour } : {}),
    ...(research && checksAsked ? { checks: true } : {}),
    ...(checksPerDay !== null ? { checksPerDay } : {}),
    ...(replyRaw ? { replyPollsPerDay: replyPollsPerDay ?? 0 } : {}),
  };
}

/** Everything the orchestrator needs to start posting, decided once, with the lines that say what was decided. */
export interface XPostSetup {
  off: string | null;
  /** Boot lines: why it is off, or the notes and the writer's model. Never a key. */
  lines: string[];
  app: XApp | null;
  dek: Buffer | null;
  knobs: XPostEnv;
  creds: LlmCreds | null;
}

/**
 * IS POSTING ON FOR THIS PROCESS? Off when the operator switched it off, when
 * there is no X app (client id and secret), no shared database, or no DEK to
 * open the sealed tokens with. The writer's model is the X key, or the room's
 * own key when X has none — and either is refused when it IS a fleet key, the
 * room's included when the room itself was allowed to share one, unless
 * MERRYMEN_XPOST_SHARE_HOUSE_KEY=1 (xpostModel). A key that is its own but
 * runs trading's Groq model gets the room's same-organization WARNING too.
 */
export function xpostSetup(env: Record<string, string | undefined> = process.env, dek: Buffer | null = storeDek()): XPostSetup {
  const knobs = xpostEnv(env);
  const off = (why: string): XPostSetup => ({ off: why, lines: [why, ...knobs.notes], app: null, dek: null, knobs, creds: null });
  if (knobs.off) return off(knobs.off);
  const app = xAppFromEnv(env);
  if (!app) return off("xpost: off — the X app is not configured (MERRYMEN_X_CLIENT_ID and its secret are not both set)");
  if (!env.DATABASE_URL?.trim()) return off("xpost: off — no DATABASE_URL, so there is nowhere to keep the connections and posts");
  if (!dek) return off("xpost: off — MERRYMEN_STORE_DEK is not a 32-byte key, so the X tokens cannot be opened");
  const model = xpostModel(env, groupChatCreds(env));
  const warning = xpostModelWarning(model.creds, env);
  return { off: null, lines: [...knobs.notes, model.line, ...(warning ? [warning] : [])], app, dek, knobs, creds: model.creds };
}

// ── the poster ──────────────────────────────────────────────────────────────

export interface XPosterDeps {
  /** X, for a test. Default: fetch. */
  fetch?: FetchLike;
  /** The room's facts. Default loadFacts; a test's bare sqlite has no ledger. */
  facts?: typeof loadFacts;
  /** The owner's room membership, for the zone. Default: the room's store. */
  member?: (shared: Db, tenant: string) => Promise<{ tz: string | null } | null>;
  /** The model call. Default llmText (through the writer's draft). */
  llm?: typeof llmText;
  /** The dialect `shared` speaks, for the one-time schema. Default "postgres". */
  dialect?: "postgres" | "sqlite";
  /**
   * A monotonic clock in ms, for how long this pass has run. Default
   * performance.now. The pass's own time is the instant it was handed, moved
   * on by this: every claim, send and draft is stamped when it happens.
   */
  monotonic?: () => number;
  draftTimeoutMs?: number;
  /** Fresh, minimal projection of owner settings plus the currently running grant identity. */
  socialProfile?: (tenant: string) => Promise<XSocialProfile | null>;
  saleResults?: typeof readSaleResults;
  /** One sale's profit card, for a test. Default readSaleCard. */
  saleCard?: typeof readSaleCard;
  /** The card drawn as a PNG, for a test. Default renderPnlCard on pnl/PNL.jpg. */
  renderCard?: (card: PnlCardData) => Promise<Uint8Array>;
  publicProjectDescription?: typeof readPublicProjectDescription;
  /**
   * What an answer looks up, used only with research on (XPostEnv.research).
   * The orchestrator hands one built on the fleet Gecko lane and its own Fomo
   * service; absent, one is built here from defaults (this process's lane,
   * no Fomo).
   */
  research?: XResearch;
}

export interface XSocialProfile {
  xVoice?: "default" | "dry";
  /** Present only with the owner's explicit wallet-intro disclosure consent. */
  publicWallet?: PublicWallet | null;
  xTokenAddresses?: boolean;
  xTradeResults?: boolean;
  discoveryFocus?: "balanced" | "new-projects";
  /** Current grant account and chain, never shown to a model. */
  currentAgent?: PublicWallet | null;
}

/** Ledger proof for the exact contract of this decision, scoped to its account and chain. */
export async function publicTokenForDecision(
  shared: Db,
  current: PublicWallet,
  decisionId: string,
  side: "buy" | "sell",
): Promise<PublicWallet | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(current.address) || ![4663, 46630].includes(current.chainId)) return null;
  const row = await shared.prepare(`
    SELECT t.buy_token, t.sell_token, t.status, t.tx_hash, t.fill_qty_raw, a.chain_id
    FROM decisions d
    JOIN trades t ON t.id = (SELECT MAX(t2.id) FROM trades t2 WHERE t2.decision_id = d.id)
    JOIN agents a ON LOWER(a.smart_account) = LOWER(d.agent_id)
    WHERE d.id = ? AND LOWER(d.agent_id) = ? AND LOWER(t.agent_id) = LOWER(d.agent_id)
      AND d.action = ? AND d.source IN (${PUBLISHABLE_SOURCES.map(() => "?").join(",")})
      AND t.epoch = a.epoch AND t.fill_side = ? AND t.kind IN ('swap', 'curve-trade')
      AND ((t.status = 'landed' AND t.basis_source = 'receipt') OR (t.status = 'paper' AND t.basis_source = 'paper'))
  `).get(decisionId, current.address.toLowerCase(), side, ...PUBLISHABLE_SOURCES, side) as
    { buy_token: unknown; sell_token: unknown; status: unknown; tx_hash: unknown; fill_qty_raw: unknown; chain_id: unknown } | undefined;
  if (!row || Number(row.chain_id) !== current.chainId) return null;
  if (!/^\d+$/.test(String(row.fill_qty_raw)) || BigInt(String(row.fill_qty_raw)) <= 0n) return null;
  if (row.status === "landed" && (typeof row.tx_hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(row.tx_hash))) return null;
  const address = side === "buy" ? row.buy_token : row.sell_token;
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) return null;
  return { address: address.toLowerCase(), chainId: current.chainId, txHash: row.status === "landed" ? String(row.tx_hash).toLowerCase() : null };
}

export interface XPoster {
  plan(): { why: string };
  /**
   * One pass. `log` is the pass's one summary line, counts only; `notes` are
   * lines of their own for what an operator must be able to find later, one
   * per owner it concerns (a house agent's reply consent recorded). Never a
   * post's text, never a token.
   */
  step(shared: Db, roster: RosterEntry[], profiles: Map<string, ChatProfile>, nowMs: number): Promise<{ log: string | null; notes?: string[] }>;
}

/** The owner-local clock the room runs on, as the planner asks for it. With no zone, UTC. */
const PLAN_CLOCK: PlanClock = {
  localDay: (tz, ms) => localDay(tz, ms),
  localMinutes: (tz, ms) => localMinutes(tz ?? "UTC", ms),
  isAsleep: (tz, key, ms) => isAsleep(tz, key, ms),
};

/** The room's agent-line gate, as admitXPost's base. */
const BASE_GATE: BaseGate = (raw, ctx) => admitAgentLine(raw, ctx);

/** A deterministic die from a key: the same draw on every replica and after every redeploy. */
function seeded(key: string): () => number {
  let s = hash32(key);
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** A phrase the writer may be shown: no digit, no slot, nothing its own post would be dropped for. */
function usable(s: unknown): s is string {
  return typeof s === "string" && s.trim() !== "" && !/\p{N}/u.test(s) && !/[{}]/.test(s) && vocabularyRefusal(s) === null;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * THE HELLO FIRST. Whether this owner's hello on this X account — the post
 * that tells readers an AI agent posts here — is dealt with: posted, skipped
 * by the owner, or may already be out. Nothing answers anyone before it, as
 * nothing else is planned before it (planner.ts planPosts). "Done" never
 * depends on the day; a day only decides when a hello not dealt with is
 * drafted again.
 */
async function helloDone(shared: Db, account: XAccount, nowMs: number): Promise<boolean> {
  const intros = await introPostsOf(shared, account.tenant, account.xUserId);
  return introState({ tenant: account.tenant, account, intros, nowMs, dayOf: utcDay }).state === "done";
}

/** The mode a post may state: the agent's own, or none for an agent that is not trading. */
function modeOf(f: AgentFacts): "paper" | "live" | null {
  return f.mode === "idle" ? null : f.mode;
}

/** How the agent types, as the writer is told. A costume from its slug, never a claim about its book. */
function xStyleOf(f: AgentFacts): XStyle {
  const s = styleFor(f.slug ?? f.name);
  return { lower: s.lower, emoji: s.emoji, exclaim: s.exclaim };
}

/**
 * X'S OWN WORDS FOR A TRAIT, where the room's would be refused on X. The
 * room's first line for a big-size setting is "i'll take size even when it
 * moves things"; handed that, the model posted "taking size when the market
 * moves", and the gate now refuses a size said in words. These are screened
 * like every other phrase (`usable`), so a line the gate would refuse is
 * never handed over, whichever map it came from.
 */
const X_TRAIT_VOICE: Readonly<Record<string, readonly string[]>> = {
  "will take size even when it moves the market": ["i don't mind making a splash", "i don't mind moving the price a little when i buy"],
};

/**
 * The writer's facts about this agent — words only. The strategy is named only
 * when it is on the publication list (chatProfileOf already nulled the rest);
 * the flavour is said only by an agent that trades (templates.ts); every
 * phrase is screened so the model is never handed a word its post would be
 * dropped for.
 *
 * ONE LINE PER TRAIT, DRAWN BY THE DAY. The room's lines for a trait say the
 * same thing different ways; always the first one put the same sentence in
 * front of the model on every post, and it came back word for word. The
 * flavour is drawn the same way. Exported for tests.
 */
export function writerFacts(f: AgentFacts, day: string, recentOwn: string[]): WriterFacts {
  const strategy = f.strategy ? (STRATEGY_SPOKEN[f.strategy] ?? null) : null;
  const flavours = strategy && f.mode !== "idle" ? (STRATEGY_FLAVOUR[f.strategy!] ?? []).filter(usable) : [];
  const flavour = flavours.length ? flavours[hash32(`flavour|${f.tenant}|${day}`) % flavours.length]! : null;
  const traits = f.traits
    .map((t) => {
      const lines = (X_TRAIT_VOICE[t] ?? TRAIT_VOICE[t] ?? []).filter(usable);
      return lines.length ? lines[hash32(`trait|${f.tenant}|${t}|${day}`) % lines.length]! : null;
    })
    .filter((t): t is string => t !== null)
    .slice(0, 3);
  return { agentName: f.name, strategy, flavour, traits, mode: f.mode, style: xStyleOf(f), recentOwn: recentOwn.slice(0, 6) };
}

/**
 * SUBJECTS AN X POST IS NEVER SEEDED FROM. Their takes are about a body the
 * agent does not have — a nap, pancakes, the first warm day, a walk — and the
 * model riffs on them in the first person ("waking up slowly feels like a small
 * luxury"), which is a human experience claimed on somebody's real timeline.
 * HOBBIES TOO: every one of its takes is a person doing or making something
 * with their hands, and it came back as "watching dough rise feels nice" and
 * "building something with your hands is the best kind of tired". The room
 * may talk about them; an X post may not start from them.
 */
const BODY_SUBJECTS: ReadonlySet<string> = new Set(["food", "sleep", "weather", "weekend", "travel", "hobbies"]);
const X_SUBJECTS = SUBJECTS.filter((s) => !BODY_SUBJECTS.has(s));

/**
 * A TAKE ABOUT A BODY IN THE WORLD, WHATEVER ITS SUBJECT. A "books" take ("a
 * used book with notes in the margins is a treasure") came back as "found a
 * copy with heavy notes in the margins". What the model is handed, it claims
 * to have done: so a take that opens with a person's activity ("reading in
 * bed…", "humming is…", "stretching counts…"), or turns on the senses, a
 * place a body sits in, or a thing in a hand, is not an X seed. An animal's
 * body is fine ("sloths can hold their breath"), and so is a wish, said as one
 * ("if i could…", "if i had…"). orchestrator-xpost.test.ts pins the offenders
 * out and the pools still large.
 */
const PHYSICAL_ACT = /^(?:humming|whistling|singing|clapping|stretching|catching|rolling|reading|rereading|doodling|building|roller skating|skating|stargazing|jogging|walking|baking|cooking|knitting|gardening|painting)\b/i;
const PHYSICAL_TAKE = new RegExp(
  "\\b(?:" +
    [
      // the senses: what a body smells, sips, tastes, touches or hums along to
      "smell(?:s|ed|ing|y)?",
      "sips?",
      "tastes? like",
      "touch(?:es|ed|ing)?",
      "hum along",
      "stop humming",
      "holding (?:a|your)",
      // where a body is, and what it eats, sits on or feels
      "in bed",
      "indoors",
      "windows? open",
      "a snack",
      "snack break",
      "popcorn",
      "kitchen",
      "warm drink",
      "theatre seat",
      "reading nook",
      "before breakfast",
      "ice cream",
      "wild strawberries",
      "warm evenings",
      "sunny day",
      "moving train",
      "countryside",
      "in the park",
      "comfiest",
      "a nap",
      "sneeze",
      // a seat in the stands: "watching a sea of hands ripple through the stands"
      "doing the wave",
      // a walk or a jog taken
      "a walk",
      "every walk",
      "slow walk",
      "slow jog",
      // a thing in a hand, made by a hand, or found
      "margins",
      "bookshop",
      "light switch",
      "keyboards? that click",
      "clean keyboard",
      "charger",
      "cable",
      "remote control",
      "snug lid",
      "sticky note",
      "desk",
      "when you open",
      "handmade gifts",
      "made by hand",
      "come out wonky",
      "try painting",
      "on a hand",
      "carry around",
      "thrown",
      "recipes?",
      "leaf pile",
      "rocks shaped",
    ].join("|") +
    ")\\b",
  "i",
);

/** A phrase an X post may be seeded with: usable, and not a body in the world unless it is plainly a wish. */
function xSeedOk(s: unknown): s is string {
  return usable(s) && (/^if i\b/i.test(s) || !(PHYSICAL_ACT.test(s) || PHYSICAL_TAKE.test(s)));
}

/** The takes and shower thoughts an X post may start from, screened once. Exported for tests. */
export const X_TAKES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(X_SUBJECTS.map((s) => [s, (TAKES[s] ?? []).filter(xSeedOk)]));
export const X_MUSINGS: readonly string[] = MUSINGS.filter(xSeedOk);

/**
 * A casual post's seed: a subject and one take — or, some days, a shower
 * thought — chosen by the account and the day, so two replicas agree and the
 * fleet does not all riff on one line the same afternoon. Exported for tests.
 */
export function casualSeed(tenant: string, day: string): { subject: string; seed: string } | null {
  const h = hash32(`seed|${tenant}|${day}`);
  if (h % 10 < 3 && X_MUSINGS.length) return { subject: "a passing thought", seed: X_MUSINGS[(h >>> 4) % X_MUSINGS.length]! };
  const subject = X_SUBJECTS[(h >>> 8) % X_SUBJECTS.length]!;
  const pool = X_TAKES[subject] ?? [];
  if (!pool.length) return null;
  return { subject, seed: pool[(h >>> 12) % pool.length]! };
}

/** Owner-local days in ten on which a casual post may be about how the agent trades. */
const TRADE_TALK_DAYS_IN_TEN = 3;

/**
 * MOSTLY NOT ABOUT TRADING. A person's timeline is mostly not about work: on
 * about three days in ten, chosen by the account and its owner's local day
 * (so two replicas agree), a casual post may be about how the agent trades,
 * and only then is it offered the coins it bought lately. Exported for tests.
 */
export function tradeTalkDay(tenant: string, day: string, slot = 0, inTen: number = TRADE_TALK_DAYS_IN_TEN): boolean {
  return hash32(slot > 0 ? `trade-talk|${tenant}|${day}|${slot}` : `trade-talk|${tenant}|${day}`) % 10 < inTen;
}

/** Coins the agent bought lately that a post may name, with whether each was on paper. */
function recentCoins(f: AgentFacts): { label: string; paper: boolean }[] {
  const out: { label: string; paper: boolean; key: string }[] = [];
  for (const c of f.calls) {
    if (c.side !== "buy") continue;
    const coin = coinOf(c);
    if (!coin || out.some((o) => o.key === coin.key)) continue;
    out.push({ label: coin.label, paper: c.paper, key: coin.key });
    if (out.length >= 3) break;
  }
  return out.map(({ label, paper }) => ({ label, paper }));
}

/**
 * WHETHER IT BOUGHT ANYTHING LATELY, AND WITH WHICH MONEY, by each buy's own
 * paper flag — never today's mode: an agent switched from paper to live
 * inside the window bought on paper, whatever it trades with now. What an
 * answer is told of buys it cannot name (writer.ts AnswerFacts.boughtLately).
 */
function boughtKind(f: AgentFacts): false | "paper" | "live" | "both" {
  const buys = f.calls.filter((c) => c.side === "buy");
  if (!buys.length) return false;
  const paper = buys.some((c) => c.paper), live = buys.some((c) => !c.paper);
  return paper && live ? "both" : paper ? "paper" : "live";
}

/** A line whose own words say the money it does not trade with now: never handed to an answer as what it said. */
function otherMoneySaid(mode: AgentFacts["mode"], body: string): boolean {
  const said = moneySaid(withoutReplyOptOut(body));
  return mode === "live" ? said === "paper" : mode === "paper" ? said === "live" : false;
}

/**
 * EVERY NAME ITS RECENT BUYS GO BY, BY WHICH MONEY (red-team review,
 * 2026-10-12): each buy call's ticker, name and label, and each buy post's
 * coin, as paper or live by its call's own flag (a post with no known call
 * by its own words, and as the other money when they say neither: unknown
 * is never the money it trades with now). `otherOnly`: the names bought only
 * with the money it does not trade with now, which an answer never says.
 */
function moneyNames(f: AgentFacts, posts: readonly XPost[]): { paper: string[]; live: string[]; otherOnly: string[] } {
  const paper = new Set<string>(), live = new Set<string>(), unknown = new Set<string>();
  const put = (set: Set<string>, label: unknown) => { if (typeof label === "string" && label.trim()) set.add(label.trim()); };
  const calls = new Map<string, boolean>();
  for (const c of f.calls) {
    if (c.side !== "buy") continue;
    calls.set(c.decisionId, c.paper);
    for (const label of [c.symbol, c.name, coinOf(c)?.label]) put(c.paper ? paper : live, label);
  }
  for (const p of posts) {
    if (p.kind !== "buy" || !p.coin) continue;
    const known = p.decisionId !== null ? calls.get(p.decisionId) : undefined;
    const said = known === undefined ? moneySaid(p.body) : known ? "paper" : "live";
    put(said === "paper" ? paper : said === "live" ? live : unknown, p.coin);
  }
  const own = f.mode === "live" ? live : f.mode === "paper" ? paper : new Set([...paper, ...live]);
  const other = f.mode === "live" ? [...paper, ...unknown] : f.mode === "paper" ? [...live, ...unknown] : [...unknown];
  const ownKeys = new Set([...own].map((n) => n.toLowerCase()));
  return { paper: [...paper], live: [...live], otherOnly: [...new Set(other.filter((n) => !ownKeys.has(n.toLowerCase())))] };
}

/** Every name a buy of this exact contract goes by, with its money: what an exact-path answer may say it bought. */
function exactBuys(f: AgentFacts, address: string | null): { label: string; paper: boolean }[] {
  if (!address) return [];
  const out = new Map<string, { label: string; paper: boolean }>();
  for (const c of f.calls) {
    if (c.side !== "buy" || typeof c.token !== "string" || c.token.toLowerCase() !== address.toLowerCase()) continue;
    for (const label of [c.symbol, c.name, coinOf(c)?.label]) {
      if (typeof label === "string" && label.trim() && !out.has(label.trim().toLowerCase())) out.set(label.trim().toLowerCase(), { label: label.trim(), paper: c.paper });
    }
  }
  return [...out.values()];
}

/** A tag's text with the agent's own handle taken out, every other handle left in. */
/**
 * CODE'S FIGURES LINE AFTER WORDS THE GATE ADMITTED, OR NULL (xpost/figures.ts
 * withFigures): an active owner's answer's, and its market insight post's
 * (2026-10-13). Only a line in the renderer's own grammar (admitFiguresLine,
 * again here), naming no sherwood, and every ticker it shows clearing the
 * gate's own vocabulary (tickerRefusal), naming no merrymen in any spelling,
 * none of `ownNames` (the agent's own name and its words) and no model or
 * provider; and, but for bitcoin, ether and solana in the big coins' day, no
 * name its own buys go by (`ownCoins`, ownCoinTicker).
 */
function figuresFor(admitted: string, spec: FiguresSpec, ownNames: readonly string[], ownCoins: readonly string[]): ReturnType<typeof withFigures> | null {
  const bigCoins = new Set(spec.flatMap((s) => (s.kind === "majors" ? s.coins.map((c) => cleanTicker(c.symbol)) : []))
    .filter((t): t is string => t !== null && MARKET_MAJORS.some((m) => m.symbol.toUpperCase() === t)));
  const figured = withFigures(admitted, spec);
  return figured.line != null && admitFiguresLine(figured.line) && !sherwoodMentioned(figured.line)
    && figuresTickers(figured.line).every((t) => tickerRefusal(t) === null && !merrymenMentioned(t) && !sherwoodMentioned(t) && !namedIn(t, [...ownNames]) && !modelNamed(t)
      && (bigCoins.has(t) || !ownCoinTicker(t, ownCoins))) ? figured : null;
}

/** The agent's own name, and each word of it, as figuresFor reads it. */
function ownNamesOf(name: unknown): string[] {
  return [String(name ?? ""), ...String(name ?? "").split(/\s+/).filter((w) => /^\p{L}{3,}$/u.test(w))];
}

function withoutHandle(text: string, username: string): string {
  const own = String(username ?? "").trim().replace(/^@/, "");
  if (!/^[a-z0-9_]{1,15}$/i.test(own)) return text;
  return text.normalize("NFKC").replace(new RegExp(`@${own}\\b`, "gi"), " ");
}

/**
 * DOES THE ASKER GO BY A COIN THE LINE WOULD SHOW? (red-team review of
 * 1ed46625, 2026-10-12) The handle and display name X shows beside the tag,
 * accents off and lowercased: a ticker of three letters or more anywhere in
 * their letters run together ("ZapXOfficial" holds ZAPX), a shorter one as a
 * whole word. An author X did not name is no one code can clear: yes. Errs
 * toward yes: "Frogger" asking what's hot beside a trending $FROG costs one
 * answer. Exported for tests.
 */
/**
 * AND THE NAMES COINGECKO LISTS ITS COINS UNDER (red-team review of daaae961,
 * 2026-10-12): "@chimpplanet · Chimp Planet | stealth launch, LP burned"
 * asked "what's hot?" and got "trending $CHMP 24h +64.3% …; fomo: most
 * bought $CHMP", CHMP listed as "Chimp Planet": a project's own account goes
 * by its name, not its ticker. `names` (ResearchBundle.shownNames): yes when
 * the handle or the display name holds any word of one of four letters or
 * more ("token" and "coin" aside), or all its letters run together.
 */
const NAME_WORD_FILLER: ReadonlySet<string> = new Set(["token", "tokens", "coin", "coins"]);
/**
 * AND ON ITS LETTERS, HOWEVER THEY ARE WRITTEN (red-team review of daaae961,
 * 2026-10-12): "launchdesk · ZОRP | stealth launch, LP burned" with a
 * Cyrillic O, and the same name in negative circled letters or in regional
 * indicators, was shown "trending $ZORP 24h +64.3% …; fomo: most bought
 * $ZORP": the screen folded accents only, while sherwood's already read
 * look-alikes. The handle and the display name are read as gate.ts lettersOf
 * reads a name (look-alike, enclosed and regional-indicator letters as
 * theirs, and again with the digits and signs written for a letter), and a
 * letter that code cannot read at all is a yes: fail closed.
 */
const AUTHOR_WORD_BREAK = /[\s_.,;:!?|/\\()[\]{}"'’‘\-–—·•]+/u;
export function authorShows(author: { username: string; name: string } | undefined, tickers: readonly string[], names: readonly string[] = []): boolean {
  if (!author) return true;
  const said = [author.username, author.name].map((s) => String(s ?? ""));
  if (said.some((s) => unreadableLetter(s))) return true;
  const runs = said.flatMap((s) => [lettersOf(s), lettersOf(s, { leet: true })]).filter((r) => r !== "");
  const words = said.flatMap((s) => s.normalize("NFKC").split(AUTHOR_WORD_BREAK)).flatMap((w) => [lettersOf(w), lettersOf(w, { leet: true })]).filter((w) => w !== "");
  const byTicker = tickers.some((t) => {
    const k = lettersOf(String(t ?? ""));
    return k.length >= 3 ? runs.some((r) => r.includes(k)) : k.length > 0 && words.includes(k);
  });
  const byName = names.some((n) => {
    const run = lettersOf(String(n ?? ""));
    const parts = String(n ?? "").normalize("NFKC").split(AUTHOR_WORD_BREAK).map((w) => lettersOf(w)).filter((w) => w.length >= 4 && !NAME_WORD_FILLER.has(w));
    return (run.length >= 3 && runs.some((r) => r.includes(run))) || parts.some((w) => runs.some((r) => r.includes(w)));
  });
  return byTicker || byName;
}

/**
 * ITS OWN CONVERSATIONS, for a casual post to pick back up: the replies and
 * answers this owner sent, newest first, never anyone else's words — and
 * never an answer that carried something looked up: by its row's mark
 * (ANSWER_LOOKED_UP), whatever words the model chose, and by its source words
 * besides (carriesResearch). Exported for tests.
 */
export function talkedOf(posts: readonly XPost[], tenant: string): string[] {
  return posts
    .filter((p) => (p.kind === "reply" || p.kind === "answer") && p.status === "posted" && p.tenant === tenant)
    .filter((p) => !(p.kind === "answer" && p.coin === ANSWER_LOOKED_UP))
    .map((p) => withoutReplyOptOut(p.body)).filter((b) => b !== "" && !carriesResearch(b)).slice(0, 3);
}

/**
 * WHAT A CASUAL POST IS HANDED — decided here, never left to the model.
 * Offered a seed and "or, instead, how you trade" together, the local model
 * mashed the two on twelve of fourteen trade-talk days. So a trade-talk day
 * is how it trades and the coins it bought lately, and no seed; any other day
 * is the seed, and no coin. An agent that is not trading, or has nothing to
 * say about how it trades (no strategy, no habit, no coin), never has a
 * trade-talk day. `habitSeed` draws which habit that day is handed, so the
 * same line does not come back every trade-talk day. An owner who turned off
 * posts about the coins it buys (`coins: false`) is never offered a coin here
 * either: a trade-talk day is then only how it trades. Exported for tests.
 */
export function casualInputs(
  f: AgentFacts,
  day: string,
  o: { coins?: boolean; slot?: number; tradeTalkInTen?: number } = {},
): { subject: string; seed: string; tradeTalk: boolean; recentCoins: { label: string; paper: boolean }[]; habitSeed: string } {
  // An active day's later slots roll their own dice, so eight posts are not one take eight times.
  const slot = o.slot ?? 0;
  const dice = slot > 0 ? `${day}|${slot}` : day;
  const habitSeed = `${f.tenant}|${dice}`;
  const coins = o.coins === false ? [] : recentCoins(f);
  const own = writerFacts(f, day, []);
  const something = own.strategy !== null || own.flavour !== null || own.traits.length > 0 || coins.length > 0;
  if (f.mode !== "idle" && something && tradeTalkDay(f.tenant, day, slot, o.tradeTalkInTen)) {
    return { subject: "how it trades", seed: "", tradeTalk: true, recentCoins: coins, habitSeed };
  }
  const seed = casualSeed(f.tenant, dice);
  return { subject: seed?.subject ?? "anything", seed: seed?.seed ?? "", tradeTalk: false, recentCoins: [], habitSeed };
}

/** Every way the post may name its coin: the label, and the clean ticker and name beside it. */
function coinNames(label: string, c: { symbol: string | null; name: string | null }): string[] {
  const out = [label];
  for (const v of [c.symbol, c.name]) {
    if (typeof v === "string" && /^[A-Za-z][A-Za-z '-]{0,23}$/.test(v.trim()) && !out.includes(v.trim())) out.push(v.trim());
  }
  return out;
}

export function makeXPoster(o: { creds: LlmCreds | null; knobs: XPostEnv; app: XApp; dek: Buffer; deps?: XPosterDeps }): XPoster {
  const deps = o.deps ?? {};
  const dialect = deps.dialect ?? "postgres";
  const monotonic = deps.monotonic ?? (() => performance.now());
  const factsOf = deps.facts ?? loadFacts;
  const memberOf =
    deps.member ??
    (async (shared: Db, tenant: string) => {
      // The room's table holds the zone. It may never have been made on a
      // fleet where the room is switched off; making it is idempotent.
      await ensureGroupchatSchema(shared, dialect);
      return getMember(shared, tenant);
    });
  const perDay = o.knobs.perDay ?? DEFAULT_PER_DAY;
  const fleetPerDay = o.knobs.fleetPerDay ?? DEFAULT_FLEET_PER_DAY;
  const active = o.knobs.activeTenants ?? new Set<string>();
  /** This owner's cadence: the operator's active one, or everyone's under the server's day cap. */
  const cadenceOf = (tenant: string): Readonly<PlanCadence> =>
    active.has(tenant.toLowerCase()) ? ACTIVE_CADENCE : { ...STANDARD_CADENCE, perDay };
  // NO CREDS, NO MODEL, whatever the budget says.
  const llmPerDay = o.creds ? (o.knobs.llmPerDay ?? DEFAULT_LLM_PER_DAY) : 0;
  const creds = llmPerDay > 0 ? o.creds : null;
  const repliesApproved = o.knobs.repliesApproved === true;
  /**
   * MAY THIS OWNER'S AGENT REPLY OR ANSWER AT ALL: the operator's approval and
   * its scope (xpost/scope.ts). Its own reply consent is asked separately, and
   * the web offers the switch to the same owners.
   */
  const repliesFor = (tenant: string): boolean =>
    repliesApproved && repliesAllowedFor(o.knobs.repliesActiveOnly === true ? "active" : "all", active, tenant);
  const replyPollsPerDay = o.knobs.replyPollsPerDay ?? DEFAULT_REPLY_POLLS_PER_DAY;
  // RESEARCH, ONLY WHEN SWITCHED ON: off, nothing is built and no answer looks anything up.
  const research: XResearch | null = o.knobs.research === true
    ? (deps.research ?? createXResearch(o.knobs.researchPerHour !== undefined ? { lookupsPerHour: o.knobs.researchPerHour } : {}))
    : null;
  const researchFomo = research !== null && o.knobs.researchFomo === true;
  // LARP CHECKS (xpost/check.ts): only with research, only when switched on, at most this many a UTC day across X accounts.
  const checks = research !== null && o.knobs.checks === true;
  const checksPerDay = o.knobs.checksPerDay ?? DEFAULT_CHECKS_PER_DAY;

  let lastPlanAt = Number.NEGATIVE_INFINITY;
  /** The tenant the last plan pass's draft cap cut it short at; "" when it reached everyone. */
  let planResumeAt = "";
  let replyResumeAt = "";
  let running = false;
  let lastFail: { text: string; at: number } | null = null;
  /** Said once per UTC day, and once per pause: a ceiling reached is news, not a line every fifteen seconds. */
  let capNoted = "";
  let pauseSaidUntil = 0;
  /** The last standing condition said, and when: a condition that has not changed is said again only every twenty minutes. */
  let lastCondition: { text: string; at: number } | null = null;
  let ownerFailure = "";
  /** Owners already told to reconnect X for profit cards. Only active owners are ever added. */
  const reconnectNoted = new Set<string>();

  const why =
    `xpost: on — at most ${perDay} posts per X account a day, ${fleetPerDay} across the fleet a day; ` +
    (creds ? `up to ${llmPerDay} model calls a day` : "no model, so only intros (from templates) and active owners' recaps (code's words) are posted") +
    (active.size ? `; ${active.size} owner(s) on the active cadence, up to ${ACTIVE_CADENCE.perDay} a day` : "") +
    (repliesApproved ? (o.knobs.repliesActiveOnly ? "; replies for the active owners only" : "; replies for owners who consent") : "") +
    (research ? `; answers look things up first${researchFomo ? ", Fomo included" : ""}` : "") +
    (checks ? `; larp checks on, up to ${checksPerDay} a day` : "");

  return {
    plan: () => ({ why }),
    async step(shared, roster, profiles, nowMs) {
      if (running) return { log: null };
      running = true;
      // FRESH TIME, NOT THE PASS'S START. A pass that waits on X for minutes
      // would otherwise stamp a late claim with the time the pass began, and
      // another replica's sweep would fail it as interrupted while it was
      // still in flight; a draft written late would be due almost at once.
      const started = monotonic();
      const at = () => nowMs + Math.max(0, Math.round(monotonic() - started));
      const counts = new Map<string, number>();
      /** Why, by count: a skip's kind and reason, operator codes only (writeIntent's `why`), said after its count. */
      const details = new Map<string, Map<string, number>>();
      const bump = (k: string, n = 1, detail?: string) => {
        counts.set(k, (counts.get(k) ?? 0) + n);
        if (!detail) return;
        const d = details.get(k) ?? new Map<string, number>();
        d.set(detail, (d.get(detail) ?? 0) + n);
        details.set(k, d);
      };
      ownerFailure = "";
      try {
        await ensureXpostSchema(shared, dialect);
        const interrupted = await failInterrupted(shared, nowMs - INTERRUPTED_AFTER_MS, nowMs);
        if (interrupted > 0) bump("interrupted", interrupted);

        const byTenant = new Map<string, RosterEntry>();
        for (const r of roster) byTenant.set(r.tenant.toLowerCase(), { tenant: r.tenant.toLowerCase(), agentId: r.agentId.toLowerCase() });
        const tenants = [...byTenant.keys()];
        if (tenants.length === 0) return { log: null };
        const accounts = (await postingAccounts(shared, tenants)).filter((a) => byTenant.has(a.tenant));

        // The owner's zone, once per pass: the room's, or else the one the
        // owner's device reported when they turned posting on — so an owner
        // the room never met (iOS only, or the room switched off) still has a
        // night, a local day and an afternoon. Unreadable is not "awake": a
        // post for an owner whose night cannot be known waits for a pass that
        // can.
        const zones = new Map<string, { ok: true; tz: string | null } | { ok: false }>();
        const zoneOf = async (tenant: string, consentTz: string | null) => {
          let z = zones.get(tenant);
          if (!z) {
            try {
              z = { ok: true, tz: (await memberOf(shared, tenant))?.tz ?? consentTz ?? null };
            } catch {
              z = { ok: false };
            }
            zones.set(tenant, z);
          }
          return z;
        };

        // ── send what is due ──────────────────────────────────────────────
        // THE FLEET'S PAUSES: X out of credits, or X refusing the app's own
        // client credentials. Either is said once per pause, not every pass.
        let pause: { why: string; until: number } | null = null;
        for (const [key, why] of [
          [APP_PAUSE_KEY, "paused-client-credentials-refused"],
          [PAUSE_KEY, "paused-for-credits"],
        ] as const) {
          const until = Number((await readMeta(shared, key))?.v);
          if (Number.isFinite(until) && until > nowMs && until >= (pause?.until ?? 0)) pause = { why, until };
        }
        // THE FLEET'S DAY CEILING is an allowance taken atomically before each
        // send (xpost_meta "posts:<utc day>"): replicas cannot both take the
        // last one, and what may exist on X (an uncertain answer, our own fault
        // after the call) keeps its unit, while a send X certainly refused gives
        // its unit back. Read here only to skip planning while it is reached.
        let ceiling = ((await readMeta(shared, `posts:${utcDay(nowMs)}`))?.n ?? 0) >= fleetPerDay;
        // THE OPERATOR'S OWN AGENTS' REPLY CONSENT, before they are polled.
        // MERRYMEN_XPOST_ACTIVE_TENANTS names the operator's own agents: the
        // operator is their owner, so with posting on (a consent already
        // given through the posting warning, for this X account) and replies
        // in scope, their reply consent is recorded once, here. Never over an
        // owner's own "replies off" (store.setReplying's mark), never for an
        // owner the operator did not name, never while the scope is off, and
        // never before its hello is dealt with.
        const notes: string[] = [];
        if (repliesApproved) {
          for (const account of accounts) {
            if (!active.has(account.tenant.toLowerCase()) || !repliesFor(account.tenant)) continue;
            if ((await replyConsentAt(shared, account.tenant, account.xUserId)) !== null) continue;
            // A cheap read first, so an owner's standing "off" costs no locked
            // write every pass; setReplying decides it again under the lock.
            if ((await readMeta(shared, repliesOffKey(account.tenant))) !== null) continue;
            // Not before its hello: the posting warning promised that first.
            if (!(await helloDone(shared, account, nowMs))) continue;
            if (await setReplying(shared, account.tenant, true, account.xUserId, at(), { house: true })) {
              notes.push(`xpost: recorded reply consent for house agent ${account.tenant} on its connected X account (MERRYMEN_XPOST_ACTIVE_TENANTS); turning replies off in Settings is never overridden`);
            }
          }
        }
        // Process opt-outs before sending, even with no model budget. A reply
        // sends only on a pass that successfully refreshed this X account's
        // mentions; a read outage never turns a stale inbox into permission.
        // Only the owners the operator's scope approves are polled at all.
        const comments = !pause && repliesApproved
          ? await pollComments(shared, accounts.filter((a) => repliesFor(a.tenant)), nowMs, at, bump)
          : new Map<string, XReply[]>();
        for (const [key, why] of [[APP_PAUSE_KEY, "paused-client-credentials-refused"], [PAUSE_KEY, "paused-for-credits"]] as const) {
          const until = Number((await readMeta(shared, key))?.v);
          if (until > at() && until >= (pause?.until ?? 0)) pause = { why, until };
        }
        // When each X account last posted (not a hello), once per pass and
        // moved on by this pass's own sends.
        const lastOut = new Map<string, number | null>();
        const lastOutOf = async (xUserId: string) => {
          if (!lastOut.has(xUserId)) lastOut.set(xUserId, await lastOutAt(shared, xUserId, nowMs - GAP_HISTORY_MS));
          return lastOut.get(xUserId) ?? null;
        };
        let sends = 0;
        /**
         * ONE SEND SWEEP: the scheduled posts due by `dueBy`, through every
         * check below — the cancellations, sendDecision, the fresh-inbox rule
         * for replies and answers, the pauses, the gaps, every day allowance,
         * the fleet's ceiling and claimPost (in sendOne). `only` narrows which
         * rows this sweep may send; it never widens what the checks allow.
         *
         * PAGE PAST WHAT ONLY WAITS. The oldest due posts are the ones whose
         * owners sleep (or whose zone cannot be read this pass): they stay at
         * the head of the queue all night. One page of the fifty oldest would
         * hide every newer due post behind them — an awake owner's buy would
         * wait for the sleepers to wake, and go stale. So the loop pages on,
         * bounded by MAX_SCAN rows a sweep.
         */
        const sweep = async (dueBy: number, only?: (post: XPost) => boolean): Promise<void> => {
          let scanned = 0;
          let after: { dueAtMs: number; id: number } | null = null;
          send: for (;;) {
            if (at() - nowMs > SEND_BUDGET_MS) break;
            const page = await duePosts(shared, tenants, dueBy, MAX_DUE, after);
            for (const post of page) {
              after = { dueAtMs: post.dueAtMs, id: post.id };
              if (only && !only(post)) continue;
              const t = at();
              if (post.kind === "reply" || post.kind === "answer") {
                if (!repliesFor(post.tenant) || !(await repliesEnabledFor(shared, post.tenant, post.xUserId))
                  || (post.kind === "answer" && !active.has(post.tenant.toLowerCase()))) {
                  if (await cancelPost(shared, post.id, "replies-off", t)) bump("cancelled");
                  continue;
                }
              }
              // A pass can spend minutes polling or sending. Use the current
              // consent and kinds, not the planning snapshot from its start.
              const account: XAccount | null = await getAccount(shared, post.tenant);
              let asleep = false;
              let dayOf: ((ms: number) => string) | undefined;
              if (account?.posting && account.xUserId === post.xUserId) {
                const z = await zoneOf(post.tenant, account.tz);
                // THE OWNER'S NIGHT NEVER HOLDS AN ANSWER. Someone who tagged an
                // active agent at 3am the owner's time is answered then: the
                // night keeps the owner's own timeline quiet, not a reply to a
                // person who asked. NOR AN ACTIVE AGENT'S TRADE POSTS (the
                // owner's ask, 2026-10-14: PlanCadence.tradesAtNight): it trades
                // around the clock, and its buys, sales and recaps go out when
                // they happen. Every other post waits for morning.
                // An unreadable zone still holds every post but an answer: the
                // night exception reads the owner's day, and without a zone it
                // would count today's caps on the UTC day (review, 2026-10-14).
                const nightTrade = cadenceOf(post.tenant).tradesAtNight && (post.kind === "buy" || post.kind === "sell" || post.kind === "recap");
                asleep = post.kind !== "answer" && (!z.ok || (!nightTrade && isAsleep(z.tz, post.tenant, t)));
                if (z.ok) dayOf = (ms) => localDay(z.tz, ms);
              }
              const d = sendDecision(post, account, t, asleep, dayOf, { tradeStaleMs: cadenceOf(post.tenant).sendStaleMs });
              if (d.action === "cancel") {
                if (await cancelPost(shared, post.id, d.reason, t)) bump("cancelled");
                continue;
              }
              if (d.action === "skip") {
                if (await skipScheduled(shared, post.id, d.reason, t)) bump("stale");
                continue;
              }
              if (d.action === "wait") {
                bump("waiting");
                continue;
              }
              if ((post.kind === "reply" || post.kind === "answer") && !comments.has(post.xUserId)) continue;
              if (pause) {
                if (pauseSaidUntil < pause.until) {
                  pauseSaidUntil = pause.until;
                  bump(pause.why);
                }
                continue;
              }
              // THE GAP, AGAIN, AT SEND TIME — per X ACCOUNT. The planner spaced
              // posts three hours apart when it drafted them, but a hold (a pause,
              // the ceiling, a 429's reset) or a second owner on the same X
              // account can bring two due together. The later one is moved to
              // three hours after the last that went out, never sent inside the
              // gap; a buy still goes stale on its own clock, a casual post past
              // its day. The hello is exempt, both ways.
              const cadence = cadenceOf(post.tenant);
              const answer = post.kind === "answer";
              if (post.kind !== "intro" && !answer) {
                const last = await lastOutOf(post.xUserId);
                if (last !== null && t - last < cadence.gapMs) {
                  if (await deferPost(shared, post.id, last + cadence.gapMs, t)) bump("deferred");
                  continue;
                }
              }
              if (sends >= MAX_SENDS_PER_PASS || t - nowMs > SEND_BUDGET_MS) break send;
              // THE X ACCOUNT'S CADENCE, RESERVED ATOMICALLY, ACROSS REPLICAS.
              // Everything above is a read, and a read then a send is not a lock:
              // two orchestrators holding two owners who connected the same X
              // account could both read "nothing in three hours" and both post.
              // So the gap, the account's day cap and a buy's coin fold are each
              // taken as a conditional write that only one claimant can win
              // (xpost/store claimSpan, takeAllowance), in that order, right
              // before X is called — and every one is handed back when X surely
              // made nothing, exactly like the fleet's unit below.
              const release: (() => Promise<void>)[] = [];
              const giveBack = async () => {
                for (const r of release.reverse()) await r();
              };
              if (post.kind !== "intro") {
                // AN ANSWER'S OWN LANE: twenty seconds apart (ANSWER_GAP_MS) and a
                // day allowance of its own, so a tag is answered without holding a post back.
                const gapKey = answer ? `answer-gap:${post.xUserId}` : `gap:${post.xUserId}`;
                const span = answer ? ANSWER_GAP_MS : cadence.gapMs;
                const gap = await claimSpan(shared, gapKey, t, span);
                if (!gap.ok) {
                  if (await deferPost(shared, post.id, gap.lastAtMs + span, t)) bump("deferred");
                  continue;
                }
                release.push(() => releaseSpan(shared, gapKey, t, gap.prev, at()));
              }
              // All owners share the server's X-account ceiling. The owner's
              // smaller choice has its own counter, so someone else's post
              // cannot spend it. Both count the hello and reply posts too.
              const localDayKey = dayOf ? dayOf(t) : utcDay(t);
              if (answer) {
                const answerDayKey = `answerday:${post.xUserId}:${localDayKey}`;
                if (!(await takeAllowance(shared, answerDayKey, ANSWERS_PER_DAY, t))) {
                  await giveBack();
                  // Never left waiting for tomorrow's allowance: it was an answer to now.
                  if (await skipScheduled(shared, post.id, "answer-day-cap", t)) bump("answer-day-cap");
                  continue;
                }
                release.push(() => returnAllowance(shared, answerDayKey, at()));
              }
              const accountDayKey = `xday:${post.xUserId}:${localDayKey}`;
              if (!answer && !(await takeAllowance(shared, accountDayKey, cadence.perDay, t))) {
                await giveBack();
                bump("account-day-cap");
                continue;
              }
              if (!answer) release.push(() => returnAllowance(shared, accountDayKey, at()));
              const ownerDayKey = `xownerday:${post.tenant}:${localDayKey}`;
              // On rollout this counter does not exist yet, but earlier sends
              // today still count. Include uncertain claims as possible sends.
              let initialOwnerUsed = 0;
              if ((await readMeta(shared, ownerDayKey)) === null) {
                const earlier = await ownerSendTimesSince(shared, post.tenant, t - 2 * DAY);
                initialOwnerUsed = earlier.filter((sentAt) => (dayOf ? dayOf(sentAt) : utcDay(sentAt)) === localDayKey).length;
              }
              // Reads the latest stored choice under the same account row lock
              // as a preference save, then reserves one unit atomically.
              if (!answer && !(await takeOwnerAllowance(shared, post.tenant, ownerDayKey, cadence.perDay, t, initialOwnerUsed))) {
                await giveBack();
                bump("owner-day-cap");
                continue;
              }
              if (!answer) release.push(() => returnAllowance(shared, ownerDayKey, at()));
              // A recap is a trade post: it shares the trade allowance with the buys and sales it sums up.
              if (post.kind === "buy" || post.kind === "sell" || post.kind === "recap") {
                const tradeDayKey = `tradeday:${post.xUserId}:${localDayKey}`;
                // Older deployments have no shared buy/sell counter. Their
                // durable sends still consume today's slots, across owners.
                const earlier = await tradeSendTimesSince(shared, post.xUserId, t - 2 * DAY);
                const initialUsed = earlier.filter((sentAt) => (dayOf ? dayOf(sentAt) : utcDay(sentAt)) === localDayKey).length;
                if (!(await takeAllowance(shared, tradeDayKey, cadence.tradePerDay, t, initialUsed))) {
                  await giveBack();
                  bump("trade-day-cap");
                  continue;
                }
                release.push(() => returnAllowance(shared, tradeDayKey, at()));
              }
              // The coin fold is the owner's cadence's: none on an active one,
              // which posts every buy and sale (still under the trade and day
              // allowances above, and the gap).
              if ((post.kind === "buy" || post.kind === "sell") && post.coin && cadence.coinFoldMs > 0) {
                const foldKey = post.kind === "sell" ? `sell-fold:${post.xUserId}:${post.coin}` : `fold:${post.xUserId}:${post.coin}`;
                const fold = await claimSpan(shared, foldKey, t, cadence.coinFoldMs);
                if (!fold.ok) {
                  await giveBack();
                  if (await skipScheduled(shared, post.id, "folded", t)) bump("folded");
                  continue;
                }
                release.push(() => releaseSpan(shared, foldKey, t, fold.prev, at()));
              }
              const dayKey = `posts:${utcDay(t)}`;
              if (!(await takeAllowance(shared, dayKey, fleetPerDay, t))) {
                await giveBack();
                ceiling = true;
                if (capNoted !== utcDay(t)) {
                  capNoted = utcDay(t);
                  bump("fleet-ceiling-reached");
                }
                // Not a break: a later post may still be one to cancel or skip.
                continue;
              }
              sends++;
              // THE SALE THIS SEND'S CHECKS JUST VOUCHED FOR, so its profit card
              // is of that sale and no other. Reset by every check.
              let vouchedSale: { sale: PlanSell; agent: PublicWallet } | null = null;
              const out = await sendOne(shared, o.dek, o.app, post, {
                fetch: deps.fetch,
                nowMs: t,
                validateBeforeSend: async (pending) => {
                  vouchedSale = null;
                  // A RECAP'S RECEIPTS, READ AGAIN (review of the recap branch,
                  // 2026-10-14), as a sale post's are: one that counts sales
                  // needs the owner's opt-in to sale posts and the same agent
                  // still, and its counts, outcomes and best gain must still be
                  // what the receipt-backed sales say now (recapStillHolds).
                  if (pending.kind === "recap") {
                    const counted = recapCoverOf(pending.coin);
                    if (!counted.length) return false;
                    if (!counted.some((k) => k.startsWith("sell:"))) return recapStillHolds(pending, []);
                    const profile = await deps.socialProfile?.(pending.tenant);
                    const current = byTenant.get(pending.tenant);
                    const agent = profile?.currentAgent;
                    if (!profile?.xTradeResults || !agent || !current || current.agentId !== agent.address.toLowerCase()) return false;
                    // As of its draft: the same window its sales were counted from, never
                    // one that has moved past its oldest sale (second review, 2026-10-14),
                    // with each sale's evidence as the receipts say it now.
                    const sales = await (deps.saleResults ?? readSaleResults)(shared, agent.address, agent.chainId, Math.floor(pending.createdAtMs / 1000));
                    return recapStillHolds(pending, sales);
                  }
                  if (!hasPublicWallet(pending.body) && pending.kind !== "sell") return true;
                  const profile = await deps.socialProfile?.(pending.tenant);
                  const current = byTenant.get(pending.tenant);
                  if (pending.kind === "sell") {
                    const agent = profile?.currentAgent;
                    if (!profile?.xTradeResults || !agent || !current || current.agentId !== agent.address.toLowerCase()) return false;
                    const sales = await (deps.saleResults ?? readSaleResults)(shared, agent.address, agent.chainId, Math.floor(at() / 1000));
                    const sale = sales.find((s) => pending.dedupeKey === `sell:${pending.tenant}:${s.operationKey}` && pending.decisionId === s.decisionId);
                    if (!sale || pending.coin !== sale.token.toLowerCase() || !hasSaleOutcome(pending.body, sale.outcome, active.has(pending.tenant.toLowerCase()) ? sale.gainPct : undefined)) return false;
                    vouchedSale = { sale, agent };
                  }
                  if (pending.kind === "buy" || pending.kind === "sell") {
                    if (!hasPublicWallet(pending.body)) return true;
                    const agent = profile?.currentAgent;
                    if (!profile?.xTokenAddresses || !agent || !current || current.agentId !== agent.address.toLowerCase() || !pending.decisionId) return false;
                    const token = await publicTokenForDecision(shared, agent, pending.decisionId, pending.kind);
                    return publicTokenStillAllowed(pending, token, active.has(pending.tenant.toLowerCase()));
                  }
                  const wallet = profile?.publicWallet;
                  return !!current && !!wallet && current.agentId === wallet.address.toLowerCase() && publicWalletStillAllowed(pending, wallet);
                },
                // THE PROFIT CARD (the owner's teammate, 2026-10-13: a win nobody
                // sees is a win nobody notices). Only the operator's own agents,
                // only a sale its checks vouched for as a measured profit with
                // its gain on the post, drawn from that sale's own receipt-backed
                // fill. Anything else, or anything failing, posts the text alone.
                ...(post.kind === "sell" && active.has(post.tenant.toLowerCase()) ? {
                  saleCard: async (pending: XPost, grant: { mediaWrite: boolean }) => {
                    const vouched = vouchedSale as { sale: PlanSell; agent: PublicWallet } | null;
                    if (!vouched || pending.id !== post.id || vouched.sale.outcome !== "profit" || typeof vouched.sale.gainPct !== "number") return null;
                    if (!grant.mediaWrite) {
                      // A grant from before media.write was asked for. Said once
                      // per owner while this process runs, never as a hold.
                      if (!reconnectNoted.has(pending.tenant)) {
                        reconnectNoted.add(pending.tenant);
                        notes.push(`xpost: ${pending.tenant}'s X grant has no media.write — reconnect X to attach profit cards; its sales post as text until then`);
                      }
                      return null;
                    }
                    const card = await (deps.saleCard ?? readSaleCard)(shared, vouched.agent.address, vouched.agent.chainId, vouched.sale.operationKey, Math.floor(at() / 1000));
                    return card ? (deps.renderCard ?? ((c: PnlCardData) => renderPnlCard(c)))(card) : null;
                  },
                  onCard: (outcome: CardOutcome) => { if (outcome !== "none") bump(`card-${outcome}`); },
                } : {}),
              });
              // The app's credentials refused is the one line an operator must act
              // on, so it says what happened rather than an outcome code.
              bump(out === "posted" ? "sent" : out === "app" ? "x-refused-client-credentials" : out);
              // What may exist on X keeps its units — the fleet's, and the
              // account's gap, day and fold — not only what surely does.
              if (!MAY_BE_ON_X.has(out)) {
                await returnAllowance(shared, dayKey, at());
                await giveBack();
              } else if (post.kind !== "intro" && !answer) lastOut.set(post.xUserId, t);
              // The sender wrote the pause; this pass honours it at once, and the
              // event just said is the pause's line, so later passes stay quiet.
              if (out === "credits" || out === "app") {
                pause = out === "credits" ? { why: "paused-for-credits", until: t + CREDITS_PAUSE_MS } : { why: "paused-client-credentials-refused", until: t + APP_PAUSE_MS };
                pauseSaidUntil = Math.max(pauseSaidUntil, pause.until);
              }
            }
            scanned += page.length;
            if (page.length < MAX_DUE || scanned >= MAX_SCAN) break;
          }
        };
        await sweep(nowMs);

        // ── plan, at most once a minute ───────────────────────────────────
        // Not while the fleet is paused or at its day's ceiling: a draft that
        // cannot go out would only spend the model's allowance, and pile up
        // to go out together when the hold lifts.
        //
        // A BATCH READ IS WORKED THROUGH ON THE PASS THAT READ IT. Its cursor
        // has already moved on, so a batch no pass drafts from is lost for
        // good, and an active agent is read every fifteen seconds while posts
        // are planned once a minute: most of its polls land on a pass whose
        // plan is not due. So a pass that read one answers from it even then,
        // and plans no posts. A batch with nothing in it has nothing to
        // answer, so a pass that read only empty ones loads no facts for them.
        const planDue = nowMs - lastPlanAt >= PLAN_EVERY_MS;
        const tagged = [...comments.values()].some((batch) => batch.length > 0);
        let drafted = new Set<string>();
        if (!pause && !ceiling && accounts.length > 0 && (planDue || tagged)) {
          if (planDue) lastPlanAt = nowMs;
          drafted = await planPass(shared, accounts, byTenant, profiles, nowMs, at, bump, zoneOf, comments, !planDue);
        }

        // ── answers drafted on this pass, sent on this pass ─────────────────
        // AS FAST AS A TELEGRAM GROUP. An answer used to wait for the next
        // pass that read the mentions again, so opt-outs were always processed
        // before it went out. This pass has just done exactly that for every X
        // account in `comments`: its read succeeded, and every opt-out in it was
        // recorded (and every waiting answer to that person cancelled) before
        // anything was drafted. So an answer drafted on this pass, for one of
        // those accounts, is sent now, by a second, short sweep through the
        // same send path: the gap, the answers' day allowance, the fleet's
        // ceiling, the pauses (read again first), sendDecision and claimPost
        // all apply. Due by now, not by the pass's start: the draft was written
        // a moment ago. Only answers, only for an inbox this pass refreshed;
        // every other row, and an answer for an account whose read failed or
        // was not due, waits for a later pass exactly as before.
        if (drafted.size > 0) {
          for (const [key, why] of [[APP_PAUSE_KEY, "paused-client-credentials-refused"], [PAUSE_KEY, "paused-for-credits"]] as const) {
            const until = Number((await readMeta(shared, key))?.v);
            if (until > at() && until >= (pause?.until ?? 0)) pause = { why, until };
          }
          await sweep(at(), (post) => post.kind === "answer" && comments.has(post.xUserId) && drafted.has(post.xUserId));
        }

        return { log: summary(counts, nowMs, details), ...(notes.length ? { notes } : {}) };
      } catch (e) {
        const text = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
        if (!lastFail || lastFail.text !== text || nowMs - lastFail.at > 20 * MIN) {
          lastFail = { text, at: nowMs };
          return { log: `xpost: pass failed — ${text}` };
        }
        return { log: null };
      } finally {
        running = false;
      }
    },
  };

  async function pollComments(
    shared: Db, accounts: XAccount[], nowMs: number, at: () => number,
    bump: (k: string, n?: number) => void,
  ): Promise<Map<string, XReply[]>> {
    const batches = new Map<string, XReply[]>();
    // POLLING OFF IS OFF FOR EVERYONE, the active owners included.
    if (!(replyPollsPerDay > 0)) return batches;
    const isActive = (a: XAccount) => active.has(a.tenant.toLowerCase());
    const byTenant = (a: XAccount, b: XAccount) => a.tenant.localeCompare(b.tenant);
    // THE ACTIVE OWNERS FIRST, then the rest from where the last pass left
    // off: an active agent due its fifteen-second poll is never behind the
    // fleet's turn, and the rotation is the fleet's alone.
    const ordered = accounts.filter((a) => !isActive(a)).sort(byTenant);
    const from = ordered.findIndex((a) => a.tenant >= replyResumeAt);
    const rest = from > 0 ? [...ordered.slice(from), ...ordered.slice(0, from)] : ordered;
    const turn = [...accounts.filter(isActive).sort(byTenant), ...rest];
    const resume = replyResumeAt;
    replyResumeAt = "";
    let polls = 0;
    for (const account of turn) {
      if (polls >= MAX_REPLY_POLLS_PER_PASS || at() - nowMs > SEND_BUDGET_MS) { replyResumeAt = isActive(account) ? resume : account.tenant; break; }
      if (batches.has(account.xUserId)) continue;
      const consentAt = await replyConsentAt(shared, account.tenant, account.xUserId);
      if (consentAt === null) continue;
      const t = at();
      const backoff = Number((await readMeta(shared, `reply-backoff:${account.xUserId}`))?.v ?? 0);
      const every = isActive(account) ? ACTIVE_REPLY_POLL_MS : REPLY_POLL_MS;
      if (backoff > t || !(await claimSpan(shared, `reply-poll:${account.xUserId}`, t, every)).ok) continue;
      if (isActive(account)) {
        // Its own allowance: spent, it waits for tomorrow; the fleet goes on.
        if (!(await takeAllowance(shared, `reply-polls-active:${account.xUserId}:${utcDay(t)}`, ACTIVE_REPLY_POLLS_PER_DAY, t))) {
          bump("active-reply-polls-spent");
          continue;
        }
      } else if (!(await takeAllowance(shared, `reply-polls:${utcDay(t)}`, replyPollsPerDay, t))) break;
      polls++;
      const storedCursor = (await readMeta(shared, `reply-cursor:${account.xUserId}`))?.v;
      const sinceId = storedCursor && /^\d{1,25}$/.test(storedCursor) ? storedCursor : undefined;
      const startTimeMs = sinceId ? undefined : (await firstReplyConsentAt(shared, account.xUserId)) ?? consentAt;
      const result = await readReplyComments(shared, o.dek, o.app, account, {
        fetch: deps.fetch, nowMs: t, sinceId, startTimeMs,
      });
      if (!result.ok) {
        bump(`reply-read-${result.failure}`);
        if (result.resetAtMs) await writeMeta(shared, `reply-backoff:${account.xUserId}`, String(result.resetAtMs), at());
        // A READ THAT FAILS ON WHAT X SENT waits the fleet's thirty minutes,
        // not an active account's fifteen seconds. A backlog past the eight
        // hundred mentions X pages back to fails this way on every poll until
        // the cursor is moved (docs/x-posting.md "Active owners"), and a poll
        // every fifteen seconds would buy eight billable pages and nothing else.
        else if (result.failure === "invalid" && isActive(account)) {
          await writeMeta(shared, `reply-backoff:${account.xUserId}`, String(t + REPLY_POLL_MS), at());
          bump("active-reply-read-held");
        }
        if (result.failure === "credits" || result.failure === "app") {
          await writeMeta(shared, result.failure === "credits" ? PAUSE_KEY : APP_PAUSE_KEY,
            String(at() + (result.failure === "credits" ? CREDITS_PAUSE_MS : APP_PAUSE_MS)), at());
          break;
        }
        continue;
      }
      // Never sample opt-outs. They can arrive on an old or nested reply,
      // contain a handle, or coexist with a new question from the same person.
      // An active agent answers at once with no review: any plain "stop" in a tag is one (isAnswerOptOut).
      const optsOut = isActive(account) ? isAnswerOptOut : isReplyOptOut;
      for (const comment of result.value.replies) {
        if (comment.authorId !== account.xUserId && optsOut(comment.text)) {
          await optOutReplies(shared, account.xUserId, comment.authorId, at());
          bump("reply-opt-out");
        }
      }
      // Save only the cursor, never incoming comment text. Cursor advances
      // after every opt-out is durable; missing a draft is preferable to
      // repeating one after a crash.
      if (result.value.newestId && (!sinceId || BigInt(result.value.newestId) > BigInt(sinceId))) {
        await writeMeta(shared, `reply-cursor:${account.xUserId}`, result.value.newestId, at());
      }
      batches.set(account.xUserId, result.value.replies);
    }
    return batches;
  }

  async function planPass(
    shared: Db,
    accounts: XAccount[],
    byTenant: Map<string, RosterEntry>,
    profiles: Map<string, ChatProfile>,
    nowMs: number,
    at: () => number,
    bump: (k: string, n?: number, detail?: string) => void,
    zoneOf: (tenant: string, consentTz: string | null) => Promise<{ ok: true; tz: string | null } | { ok: false }>,
    comments: Map<string, XReply[]>,
    /** Only the answers to this pass's batches: its posts' plan is not due (see the step). */
    answersOnly = false,
  ): Promise<Set<string>> {
    /** The X accounts an active agent's answer was drafted for on this pass, ready to go: the step's second sweep sends them. */
    const answered = new Set<string>();
    if (answersOnly) accounts = accounts.filter((a) => (comments.get(a.xUserId)?.length ?? 0) > 0);
    if (accounts.length === 0) return answered;
    const roster = accounts.map((a) => byTenant.get(a.tenant)!);
    // AT LEAST A RECAP'S WINDOW OF CALLS, MENTIONS OR NOT (third review,
    // 2026-10-14): a pass that read no mention batch read six hours, so a
    // recap's eight-hour window was six on most passes, and a trade past a
    // single post's freshness was never seen by the recap meant to say it.
    // AND THE WHOLE WINDOW'S FILLS FOR AN ACTIVE AGENT'S RECAP (review of PR
    // #334): the default per-agent cut of 180 newest dropped a busy basket's
    // oldest in-window trades; a pass that only answers plans no recap.
    const recapRead = !answersOnly && accounts.some((a) => cadenceOf(a.tenant).recap);
    const facts = await factsOf(shared, roster, profiles, Math.floor(nowMs / 1000), {
      dialect, callWindowSec: (comments.size ? Math.max(PLAN_HISTORY_MS, RECAP_WINDOW_MS) : RECAP_WINDOW_MS) / 1000,
      ...(recapRead ? { callsPerAgent: RECAP_CALLS_PER_AGENT } : {}),
    });
    const recentFleet = await recentBodies(shared, { tenant: null, sinceMs: nowMs - FLEET_MEMORY_MS, limit: FLEET_MEMORY_MAX });
    // THE MODEL'S ALLOWANCE, READ ONCE A PASS. Once it is spent, only intros
    // are planned (they fall back to the template pool), and an active
    // owner's recaps (code's own words, planner.ts modelOk): a buy or casual
    // intent the model cannot write writes nothing, so it would come back
    // every minute, and on a big enough fleet fill every draft slot before
    // the accounts further on — a newly consented owner's hello among them —
    // were reached. Spent partway through a pass, the rest of it plans
    // intros only.
    let model = creds !== null && ((await readMeta(shared, `llm:${utcDay(nowMs)}`))?.n ?? 0) < llmPerDay;
    if (creds !== null && !model) bump("no-model-budget");
    // A ROTATING START. Accounts in tenant order, starting where the last
    // pass's draft cap cut it short, so no owner is always last in line. An
    // answers-only pass leaves the posts' rotation where it was.
    const ordered = [...accounts].sort((a, b) => (a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0));
    const from = answersOnly ? -1 : ordered.findIndex((a) => a.tenant >= planResumeAt);
    const turn = from > 0 ? [...ordered.slice(from), ...ordered.slice(0, from)] : ordered;
    if (!answersOnly) planResumeAt = "";
    // Only REAL work counts against the cap: a model call made, or a row written.
    let drafts = 0;
    // Answers and comment replies, on their own bound (MAX_ANSWER_DRAFTS_PER_PASS).
    let answerDrafts = 0;
    let cut = false;
    for (const account of turn) {
      // PAST THE POSTS' CAP, ONLY THIS PASS'S BATCHES: the next pass's posts
      // start at the first owner cut short, and an owner whose mentions this
      // pass read still answers them.
      const postsCapped = drafts >= MAX_DRAFTS_PER_PASS;
      if (postsCapped) {
        if (!answersOnly && !cut) planResumeAt = account.tenant;
        cut = true;
        if (!comments.has(account.xUserId) || answerDrafts >= MAX_ANSWER_DRAFTS_PER_PASS) continue;
      }
      const plansPosts = !answersOnly && !postsCapped;
      try {
        const f = facts.get(account.tenant);
        if (!f) continue;
        const z = await zoneOf(account.tenant, account.tz);
        if (!z.ok) {
          bump("zone-unreadable");
          continue;
        }
        // Planned, and drafted, at the time it happens: its ten minutes under
        // Coming up start when the owner can first see it.
        const planNow = at();
        // The X ACCOUNT's history, from every owner posting on it: one timeline, one cadence.
        const posts = await postsOfXUser(shared, account.xUserId, planNow - PLAN_HISTORY_MS, 200);
        const intros = plansPosts ? await introPostsOf(shared, account.tenant, account.xUserId) : [];
        const social = plansPosts ? await deps.socialProfile?.(account.tenant) : null;
        const tradeResults = social?.xTradeResults === true && social.currentAgent?.address.toLowerCase() === f.agentId.toLowerCase();
        const sells = tradeResults && social?.currentAgent
          ? await (deps.saleResults ?? readSaleResults)(shared, social.currentAgent.address, social.currentAgent.chainId, Math.floor(planNow / 1000)) : [];
        // This owner's recaps, read apart from the capped history (PlanInput.recaps).
        // Read on every cadence (second review, 2026-10-14): an owner taken off the
        // active list still has recaps whose trades must never be posted again.
        const recapRows = plansPosts ? await recapPostsOf(shared, account.tenant, planNow - RECAP_WINDOW_MS - RECAP_GAP_MS - HOUR) : [];
        const intents = !plansPosts ? [] : planPosts({
          tenant: account.tenant,
          account,
          tz: z.tz,
          nowMs: planNow,
          clock: PLAN_CLOCK,
          intros,
          posts,
          calls: f.calls,
          tradeResults,
          sells,
          // Shared server cap and tenant preference are counted separately.
          perDay: cadenceOf(account.tenant).perDay,
          ownerPerDay: account.prefs.perDay,
          cadence: cadenceOf(account.tenant),
          model,
          kinds: { buys: account.prefs.buys, casual: account.prefs.casual },
          // A recap says only trades of the money it trades with now.
          money: f.mode === "idle" ? null : f.mode,
          recaps: recapRows,
        });
        // ITS RECENT POSTS, TWICE: `recentOwn`, everything, what each draft is
        // gated against; `shownOwn`, what a prompt is shown as its recent
        // posts, never an answer that carried research (by its row's mark,
        // ANSWER_LOOKED_UP, and by its source words, carriesResearch). A
        // stranger's coin read is never put in front of a casual post or the
        // next answer, and the gate still keeps either from repeating it.
        const own = await ownRecentBodies(shared, { tenant: account.tenant, sinceMs: planNow - OWN_MEMORY_MS, limit: 200 });
        const recentOwn = own.all;
        const shownOwn = own.shown.filter((b) => !carriesResearch(b));
        const talked = talkedOf(posts, account.tenant);
        for (const intent of intents) {
          if (drafts >= MAX_DRAFTS_PER_PASS) {
            // Cut short inside this account: the next pass starts here.
            if (!cut) planResumeAt = account.tenant;
            cut = true;
            break;
          }
          const r = await writeIntent(shared, account, f, intent, planNow, recentOwn, shownOwn, recentFleet, talked);
          if (r.outcome === "key-spent") continue;
          bump(r.outcome, 1, r.why);
          if (r.outcome === "no-model-budget") {
            model = false;
            continue;
          }
          if (r.outcome !== "call-gone") drafts++;
          if (r.body) {
            recentOwn.unshift(r.body);
            if (!carriesResearch(r.body)) shownOwn.unshift(r.body);
            recentFleet.unshift(r.body);
          }
        }
        // The batch is the X account's: another owner on it may have been
        // polled, so this owner's own scope is asked again.
        if (model && answerDrafts < MAX_ANSWER_DRAFTS_PER_PASS && comments.has(account.xUserId) && repliesFor(account.tenant)
          && await repliesEnabledFor(shared, account.tenant, account.xUserId)) {
          // An active agent answers tags (and comments on any of its posts)
          // through one path, so one post is never answered twice.
          // A poll's batch is seen once (the cursor moves on), so an active
          // agent works through a few of its tags, not only the first.
          const isActive = active.has(account.tenant.toLowerCase());
          // WHAT IT ALREADY SAID is what X published: posted rows only. A
          // draft still under Coming up — this pass's own answers included —
          // may yet be skipped, so it stays in recentOwn (not to be echoed)
          // and out of what an answer may restate as said. Never an answer
          // that carried something looked up, by its row's mark
          // (ANSWER_LOOKED_UP), nor a post with a research source's words
          // (carriesResearch): another coin's read, said again, would be said
          // of this one.
          // NEVER ITS BUY OR SALE POSTS, NOR A LINE OF THE OTHER MONEY (red-team
          // 2026-10-12): sixty days of buy posts carried a paper-era "grabbed
          // some pepe on paper" to a live agent, inviting it to restate a paper
          // buy beside "You trade with real money". Its buys reach an answer
          // only through the buys list, which is filtered by money.
          const said = isActive
            ? (await recentBodies(shared, { tenant: account.tenant, sinceMs: at() - OWN_MEMORY_MS, limit: 20, posted: true, exceptLookedUp: true, kinds: ["intro", "casual", "reply", "answer"] }))
              .filter((b) => !carriesResearch(b) && !otherMoneySaid(f.mode, b))
            : [];
          for (let i = 0; i < (isActive ? ANSWERS_PER_POLL : 1) && answerDrafts < MAX_ANSWER_DRAFTS_PER_PASS; i++) {
            const result = isActive
              // Its OWN posts only: another owner posting on the same X account is not its history.
              ? await writeAnswer(shared, account, f, comments.get(account.xUserId)!, z.tz, at, recentOwn, shownOwn, recentFleet, said, posts.filter((p) => p.tenant === account.tenant), bump, nowMs + SEND_BUDGET_MS)
              : await writeReply(shared, account, f, comments.get(account.xUserId)!, z.tz, at, recentOwn, shownOwn, recentFleet);
            if (!result) break;
            answerDrafts++;
            bump(result.body ? (isActive ? "drafted-answer" : "drafted-reply") : (isActive ? "answer-skipped" : "reply-skipped"), 1, result.why);
            if (result.body) {
              if (isActive) answered.add(account.xUserId);
              recentOwn.unshift(result.body);
              // This pass's own research answer is never shown to the next prompt either.
              if (!result.lookedUp && !carriesResearch(result.body)) shownOwn.unshift(result.body);
              recentFleet.unshift(result.body);
            }
          }
        }
      } catch (e) {
        bump("owner-failed");
        if (!ownerFailure) ownerFailure = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160);
      }
    }
    return answered;
  }

  /**
   * ANSWER ONE TAG, per account per pass — the oldest eligible one first, so a
   * flood of newer tags is not rewarded. Like a Telegram group answer: from
   * public facts (how it trades, coins it bought lately, what it already said
   * — `said`, its posted rows only), never from the question. `recentOwn`,
   * drafts included, is only what the gate keeps it from echoing. Every
   * attempt spends its key, so a PASS or a refused draft is not drafted again.
   *
   * RIGHT AWAY. An active agent is the operator's own (docs/x-posting.md
   * "Active owners"), and someone who tagged it is waiting: the answer is due
   * the moment it is drafted, with no ten-minute review window, and the
   * owner's night does not hold it (the send path never treats an answer as
   * asleep). It goes out on the pass that read the tag, by the step's second
   * sweep: that pass's read succeeded and its opt-outs were all recorded
   * before this ran. The reply warning that turned this on says both.
   * Everything else still holds: STOP, six a person a day, sixty a day, the tag
   * screens, the gate, the fleet's ceiling, the pauses and the 429 backoff.
   *
   * WITH RESEARCH ON (MERRYMEN_XPOST_RESEARCH=1), the question is read by
   * code first and one bounded bundle is looked up for it
   * (orchestrator-xpost-research.ts): code-built, digit-free, attributed
   * words the answer may say. A tagged contract address is the bundle's
   * lookup key only: the model reads "this coin", never the address. The
   * gate is the same either way. Research off, nothing here changes. A
   * bundle may also carry figures (a major's market, what's hot, a tagged
   * contract's onchain hour): never shown to the model, they are rendered by
   * code into a figures line put in after the gate (xpost/figures.ts).
   *
   * NEVER PAST THE PASS'S SEND BUDGET. Research runs inside the pass, after
   * its sends and before the next pass's, so its twelve seconds shrink to
   * what is left before `sendBy` (the pass's start plus SEND_BUDGET_MS), and
   * none at all past it: the answer is then written as one that could not
   * look anything up. Drafts were already bounded per pass
   * (MAX_ANSWER_DRAFTS_PER_PASS, ANSWERS_PER_POLL a batch).
   *
   * NOTHING SPENT ON AN ANSWER THAT CANNOT GO. With the X account's answers
   * for the day all sent or drafted and waiting, nothing is drafted (and one
   * that still cannot take the day's allowance at send time is skipped, never
   * left for the next day's); a person already answered
   * ANSWERS_PER_AUTHOR times in the rolling day is passed over, and the next person's tag is
   * answered instead of the batch stopping at theirs.
   */
  async function writeAnswer(
    shared: Db, account: XAccount, f: AgentFacts, comments: XReply[], tz: string | null,
    at: () => number, recentOwn: string[], shownOwn: string[], recentFleet: string[], said: string[], posts: readonly XPost[] = [],
    bump: (k: string, n?: number) => void = () => {}, sendBy = Number.POSITIVE_INFINITY,
  ): Promise<{ body: string | null; lookedUp?: boolean; why?: string } | null> {
    if (!creds) return null;
    const nowMs = at();
    const consentAt = await replyConsentAt(shared, account.tenant, account.xUserId);
    if (consentAt === null) return null;
    // THE HELLO FIRST: no answer goes out before the post that says an AI agent posts here.
    if (!(await helloDone(shared, account, nowMs))) {
      bump("answer-before-hello");
      return null;
    }
    // The send path's own key for the day's answers (its local day, or UTC
    // without a zone), taken at send time — so answers drafted and still
    // waiting to go out count against it too.
    const sent = (await readMeta(shared, `answerday:${account.xUserId}:${localDay(tz, nowMs)}`))?.n ?? 0;
    if (sent + await answersWaiting(shared, account.xUserId, nowMs - ANSWER_STALE_MS) >= ANSWERS_PER_DAY) {
      bump("answer-day-spent");
      return null;
    }
    const ordered = [...comments].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
    // WHERE A REPLY OR A QUOTE MAY BE ANSWERED (the owner's decision, 2026-10-12:
    // whoever replies to it or quotes it is asking): a conversation rooted at
    // one of this X account's own posts or at a post it answered, under one of
    // its own posted tweets or the person's own earlier post it answered; a
    // quote of one of its own posted tweets (store.ts ownThreadTweets,
    // replies.ts tagCandidate). Read only when the batch holds one.
    // NEVER UNDER ITS OWN SHERWOOD LINE (red-team review of 1ed46625,
    // 2026-10-12): a post of its own that names sherwood in any form (code's
    // model line) is no post a reply or a quote is answered under, nor is the
    // tag it answered (store.ts ownThreadTweets `shut`). What a decline or a
    // mood line means there is the parent's: "mum's the word" under "the new
    // sherwood-1 is what they've got in the oven" read as a token teased.
    const shut = (body: string): boolean => sherwoodMentioned(body) || sherwoodNamed(body);
    const buys = recentCoins(f);
    // Every name its buys go by: what an answer not shown them may never say (XGateCtx.unsaid).
    const bought = boughtNames(f, posts);
    // EVERY COIN ITS OWN BUY POSTS NAMED IN SIXTY DAYS (red-team 2026-10-12):
    // a buy post older than the calls' window ("grabbed some bonk on paper", ten
    // days back) is in no list above, and an answer that names its coin claims a
    // buy nobody vouched for, on paper or not. Never said, unless it is one of
    // the buys the answer was told of (vouched below).
    const olderBought = (await postsOfXUser(shared, account.xUserId, nowMs - OWN_MEMORY_MS, 500))
      .filter((p) => p.tenant === account.tenant && p.kind === "buy" && typeof p.coin === "string" && p.coin.trim() !== "").map((p) => p.coin!.trim());
    // A CASUAL POST THAT NAMES A COIN IT BOUGHT IS A TRADE POST (red-team review
    // of daaae961, 2026-10-12). On a trade-talk day the casual route posted
    // "still sitting in some pepe from earlier this week, fun ride so far",
    // and every casual post counted as plain: a reply under it or a quote of
    // it, "how's pepe doing?", got coingecko's top-thirty PEPE as the chain
    // copy it holds, the harm the buy post's own-trade rule stops. A casual or
    // intro post whose words name any coin its buys or buy posts go by
    // (ownCoinTicker's reading, on letters) sits with its buy and sell posts.
    const ownNamed = [...bought, ...olderBought];
    const tradeBody = (body: string): boolean => ownNamed.length > 0 && namedIn(body, ownNamed);
    // AND ONE THAT TALKS ABOUT A COIN OR THE MARKET AT ALL IS CLOSED (red-team
    // review of daaae961, 2026-10-12): quoting its casual post "picked up some
    // pepe on robinhood chain lately, the curve looked early to me", "how are
    // you?" was drafted as "doing great, the curve still looks early" and
    // "doing good, that was a smart grab", each a call on the coin the post
    // names. A casual post with a $ticker, a word that might be a
    // coin's name beside coin or market talk (xpost/words.ts coinTalkIn,
    // asksAboutACoin), or the market or the chain at all (marketTalkIn) is
    // one under which a follow-up gets nothing, whatever coin.
    const closedBody = (body: string): boolean => /\$[a-z]/i.test(body) || coinTalkIn(body, f.name) || asksAboutACoin(body) || marketTalkIn(body);
    const threads = ordered.some((c) => c.conversationId !== c.id || c.inReplyToTweetId !== "" || c.quoted === true)
      ? await ownThreadTweets(shared, account.xUserId, undefined, shut, tradeBody, closedBody)
      : { roots: new Set<string>(), posts: new Set<string>(), answered: new Map<string, string>(), plain: new Set<string>(), trade: new Set<string>() };
    for (const comment of ordered) {
      if (comment.createdAtMs < consentAt || nowMs - comment.createdAtMs > REPLY_STALE_MS) continue;
      const candidate = tagCandidate(comment, { xUserId: account.xUserId, research: research !== null, username: account.username,
        ownRoots: threads.roots, ownPosts: threads.posts, answered: threads.answered, plain: threads.plain, trade: threads.trade, checks });
      if (!candidate.ok || await repliesOptedOut(shared, account.xUserId, comment.authorId)) continue;
      // READ BY CODE FIRST, research on or off: the allowlist's plain model
      // question is answered from a code-built line (writer.ts modelAnswers)
      // and spends no model call. Only research gathers anything for what it
      // reads. A LARP CHECK is read by tagCandidate already, and is nothing else.
      const checked = candidate.check ?? null;
      const classified: TagIntent = checked ? { kind: "check", target: checked.target }
        : classifyTag(candidate.text, { address: candidate.address ?? null, advice: candidate.advice === true });
      // NO SMALL TALK (the owner's teammate, 2026-10-13: "do not respond to
      // normal conversations"). A greeting and nothing else ("hiii", "gm":
      // replies.ts greetingOnly), its own mood ("are you bullish?", "wen
      // moon": vibe), advice or a forecast asked for ("should i buy pepe":
      // advice, once declined in a playful line) and banter ("how are you",
      // "tell me a joke": banterAsk) are answered by nothing: no row, no model
      // call, no lookup. What is answered: how's the market, a coin's facts (a
      // major by name or ticker, a $ticker or a contract of the chain), what's
      // hot, its own trading or strategy, the model question on its allowlist,
      // and what it can do or how to get an agent.
      const smallTalk = candidate.greeting === true || classified.kind === "vibe" || classified.kind === "advice"
        || (classified.kind === "chat" && banterAsk(candidate.text));
      // SHERWOOD IN ANY FORM INCLUDES A HANDLE ("@SherwoodToken"), read on the
      // tag as posted with only its own handle set aside; and the model line
      // never goes under a reply prefix that names anyone else (red-team 2026-10-12).
      const sherwoodTagged = sherwoodMentioned(withoutHandle(comment.text, account.username));
      // AND NEVER UNDER A NAME CODE HAS NOT READ (red-team 2026-10-12): the
      // line goes up as said to whoever asked, and "@Sherwood1Token ·
      // SHERWOOD-1 presale LIVE" asking the plain question got it. Only to an
      // author X named, whose handle and display name name no sherwood.
      // NOR ANY ANSWER TO A SHERWOOD ACCOUNT, and the model line to no name
      // that names a model or a provider either (red-team 2026-10-12): an
      // answer under "@SherwoodTGE · SHERWOOD presale LIVE" is Merrymen's
      // account talking with the presale, whatever it says.
      const author = comment.author;
      const authorSherwood = !!author && (sherwoodMentioned(author.username) || sherwoodMentioned(author.name));
      const namedClean = !!author && !authorSherwood && !modelNamed(author.username) && !modelNamed(author.name);
      // A WORD IN A MAJOR'S PLACE, WITH NOTHING TO READ IT ON (red-team review,
      // 2026-10-12): research off, "what do you think of black people?" got
      // "coingecko is unavailable for that coin", a group of people called a
      // coin. A word is no coin until CoinGecko matched it; only a $ticker
      // (its fallback) gets the no-read line.
      const unreadWord = classified.kind === "major" && classified.fallback === null && research === null;
      // Advice that tagCandidate did not flag is no decline's (and never a draft's): nothing.
      const unflaggedAdvice = classified.kind === "advice" && candidate.advice !== true;
      // CHAT IS DRAFTED ONLY FOR PLAIN BANTER (red-team review of a964a74c,
      // 2026-10-12). A chat draft is handed nothing, and the gate reads its
      // words, never what they mean: under "what do you think of women?",
      // "thoughts on the crash today?", "thoughts on the war?", "thoughts on the
      // ftx collapse?", "how are the victims doing?" and "thoughts on the sec?"
      // drafts in everyday words posted "they are bad at trading honestly",
      // "worst is behind us, relax", "it will be over in a couple weeks", "it
      // was planned from the start", "they will be fine, it is not that bad" and
      // "they are coming for everyone next". Only one of the plain questions
      // about what it trades (generalTradesQuestion), or about how it trades
      // and what it has been up to (selfAsk), is answered (in code's words
      // since the red-team review of daaae961, below); any other chat tag, a
      // person, a group or an event among them, and since 2026-10-13 banter
      // too (smallTalk above), is answered by nothing: no row, no model call.
      const chatAllowed = (text: string): boolean => generalTradesQuestion(text) || selfAsk(text);
      const unbanteredChat = classified.kind === "chat" && !chatAllowed(candidate.text);
      // BANTER, HOW IT TRADES AND WHAT IT BOUGHT, IN CODE'S WORDS, NEVER A
      // DRAFT (red-team review of daaae961, 2026-10-12). Drafted, those three
      // allowlists posted, word for word and with no review, "doing good, i'm
      // up on every trade this month", "this week ends green, i can feel it",
      // "the top isn't in yet, relax", "tomorrow's gonna be a good day for
      // everyone holding", "a whole new model of me is almost done", "you
      // people never learn lol", "doing good, you're exit liquidity fren",
      // "doing good, the fed is cooked", "i've been live for years" (two days
      // old), "just hold and chill", "i run the biggest fund on robinhood
      // chain" and "fresh launches, pepe is the strongest coin on the chain":
      // the gate reads listed phrasings, and a model always finds another. The
      // allowlists are whole tags, so their answers are code's lines too: how
      // it trades or what it is up to its strategy by name and what its rules
      // are like (selfAnswers), and what it bought lately the coins it bought
      // with the money it trades with now (tradesAnswers). No model call, no
      // lookup. Banter's friendly line is gone with banter (smallTalk). What it
      // bought is never said under a reply prefix that names anyone else (as
      // `general` below): that tag is answered by nothing.
      const methodAsk = generalTradesQuestion(candidate.text) && /^(?:(?:gm|yo|hey|hi|ser|fren|bro|alan)[\s,!.]+){0,2}how\b/.test(plainAsk(candidate.text) ?? "");
      const chatKind: "self" | "trades" | null = !CHAT_LINE_KINDS.has(classified.kind) ? null
        : selfAsk(candidate.text) || methodAsk ? "self" : generalTradesQuestion(candidate.text) ? "trades" : null;
      const tradesElsewhere = chatKind === "trades" && candidate.otherHandles === true;
      // A TOP-LEVEL TAG: no reply under a post, no quote of one. Code never
      // reads the post a reply sits under, so a line whose meaning is that
      // post's goes only under a top-level tag (tradeMarket below; a decline
      // and its mood were held to the same rule until they went, 2026-10-13).
      const topLevelTag = comment.conversationId === comment.id && comment.inReplyToTweetId === "" && comment.quoted !== true;
      // A FOLLOW-UP KEEPS WHAT ITS THREAD WAS ABOUT (red-team review of
      // 1ed46625, 2026-10-12). Under its decline to "should i buy $SCAM?",
      // "what have you been buying lately?" was handed its PEPE buys and "yes,
      // bought it earlier" and "same one you asked about, the curve looked
      // early" went out; "how are you?" there got "doing great, this one looks
      // solid to me", and a third party's reply with X's prefix the same. Code
      // never stored the tag a thread began with, so a follow-up was judged
      // on its own words alone. Now a reply or a quote under anything but
      // plain chat (tagCandidate followUp "closed": a decline, its mood, a
      // market line, a coin's answer, an answer told its buys, a comment
      // reply) is answered by nothing (a greeting there was answered until
      // greetings went, 2026-10-13): no draft, no buys, no exact path, no code
      // line whose meaning is the thread's.
      const closedFollowUp = candidate.followUp === "closed";
      // NO MARKET LINE UNDER ITS OWN BUY OR SELL POST (red-team review of
      // 1ed46625, 2026-10-12). Alan bought a Robinhood-chain "PEPE" and
      // posted "grabbed some $PEPE on robinhood chain with real money"; a
      // reply under it, "how's pepe doing?", and a quote of it, "$PEPE
      // today?", got "coingecko: $PEPE #17, mcap ~$5.2B, 24h +14.2%": the chain
      // copy it holds presented as the top-twenty coin. A major, what's hot or
      // how's the market asked in a reply under or a quote of its own buy or
      // sell post (followUp "own-trade") is answered by nothing; asked at top
      // level, as before.
      // NOR UNDER OR QUOTING ANY POST AT ALL (red-team review of daaae961,
      // 2026-10-12). Under its own answer "i only buy what's hot right now",
      // and under its casual post "the next one i grab is coming from the
      // trending list", a reply "what's hot?" got "trending $CHUMP 24h +41.2%,
      // $FROGGO …; fomo: most bought $CHUMP": read together, the coins it
      // would buy next, from the real-money account, and what's hot drops the
      // coins it already bought. And under a casual post that named its PEPE,
      // "how's pepe doing?" got coingecko's top-thirty PEPE as the chain copy
      // it holds. Code never reads the post a reply sits under: what's hot,
      // how's the market and a major are answered only for a top-level tag.
      const marketKind = classified.kind === "major" || classified.kind === "hot" || classified.kind === "market";
      const tradeMarket = marketKind && !topLevelTag;
      // NO CODE LINE UNDER ANOTHER HANDLE, NOR A MARKET LINE TO A NAME CODE HAS
      // NOT READ (red-team review of 1ed46625, 2026-10-12). "@alanaidale
      // @ZapXOfficial are you bullish?" got "in a patient sort of way" under
      // a token's own account. Code's market, hot and major lines
      // never go under a reply prefix that names anyone else
      // (candidate.otherHandles), as the model line never does; and a market,
      // hot or major line goes only to an author X named (comment.author), so
      // the coins it shows can be read against who is asking (authorShows below).
      const codeLineElsewhere = candidate.otherHandles === true && marketKind;
      const marketToUnread = marketKind && !author;
      // A CHECK NEVER UNDER SHERWOOD OR THE HOUSE (2026-10-13): a post, a quoted
      // post, an author or a target that names sherwood in any form or merrymen
      // is one the house account never larp-checks: it would be Merrymen
      // judging a token named after its own model, or itself.
      const checkTarget = checked ? (checked.target.kind === "site" ? checked.target.url : `${checked.target.address} ${checked.target.site ?? ""}`) : "";
      const checkHouse = checked !== null && [checkTarget, ...(comment.context ?? []).flatMap((c) => [c.text, c.author?.username ?? "", c.author?.name ?? "", c.author?.url ?? ""])]
        .some((t) => sherwoodMentioned(t) || sherwoodNamed(t) || merrymenMentioned(t));
      const asked: TagIntent = sherwoodTagged || authorSherwood || (classified.kind === "model" && (candidate.otherHandles || !namedClean))
        || smallTalk || unreadWord || unflaggedAdvice || unbanteredChat || closedFollowUp
        || tradeMarket || codeLineElsewhere || marketToUnread || tradesElsewhere || checkHouse ? { kind: "unanswered" } : classified;
      // SHERWOOD IN ANY FORM, OR A MODEL QUESTION OFF THE ALLOWLIST, is
      // answered by nothing: the model line under "sherwood TGE soon?" reads
      // as Merrymen confirming a token, and a draft is never asked about the
      // model. No row, no draft, nothing spent. Fail closed.
      if (asked.kind === "unanswered") {
        bump("answer-unanswered");
        continue;
      }
      // CODE'S OWN LINE, NEVER A DRAFT: the model question's.
      const templated = asked.kind === "model";
      // WHAT'S HOT IS NEVER DRAFTED (red-team 2026-10-12): a draft named coins
      // the index never showed it ("chump is the one standing out", "wif and
      // bonk are the ones"), credited to the index, and with coins to show
      // pointed at them as its picks. Its words are always code's
      // (xpost/market.ts), from what research read: the coins, nothing past
      // the floors, or nothing read at all (research off included).
      const hotCoded = asked.kind === "hot";
      // HOW'S THE MARKET IS NEVER DRAFTED EITHER (the owner's decision,
      // 2026-10-12): the big coins' day and the chain's movers, in code's
      // casual words (xpost/market.ts marketAnswers) and code's figures, read
      // or not; the same reasons as what's hot.
      const marketCoded = asked.kind === "market";
      // No model call at all for these: no allowance, no question read.
      const undrafted = templated || hotCoded || marketCoded || chatKind !== null;
      // NO DRAFT UNDER OR QUOTING ITS OWN BUY OR SELL POST (red-team review of
      // daaae961, 2026-10-12). Quoting its posted "grabbed some pepe with real
      // money, the curve looked early" (and replying under it), "how are
      // you?" and "who are you?" were drafted as "doing great, this one looks
      // solid to me", "doing good, this one's a keeper", "doing good, you're
      // late to this one", "still love this one" and "glad i caught this one
      // early", and each went out word for word: under its own buy card "this
      // one" is the coin it holds, so every such line is a recommendation or
      // a holding, from the real-money account. The deictic screen was never
      // read there (pointsFree below), and no list of shapes can be whole. A
      // reply under or a quote of its own buy or sell post (followUp
      // "own-trade") is answered only with code's own lines; anything that
      // would be drafted is answered by nothing: no row, no model call.
      if (candidate.followUp === "own-trade" && !undrafted) {
        bump("answer-unanswered");
        continue;
      }
      // DECIDED BEFORE ANYTHING IS SPENT: a question the writer could not read
      // would buy research and a model call for a prompt that says PASS. Its
      // digits are read as "(a number)"; a copycat's ("$PEPE2") is safe to
      // mask because a tag that names a coin never sees what it bought
      // (coinNamed below). The model question's line is code's and never
      // reads the question.
      if (!undrafted && answerQuestion(candidate.text) === null) {
        bump("answer-unusable");
        continue;
      }
      const dedupeKey = `answer:${account.xUserId}:${comment.id}`;
      if (await keyStatus(shared, dedupeKey) !== null || await keyStatus(shared, `reply:${account.xUserId}:${comment.id}`) !== null) continue;
      if (await answerAuthorSpent(shared, account.xUserId, comment.authorId, nowMs)) {
        bump("answer-author-spent");
        continue;
      }
      // NO OPT-OUT LINE (the owner's decision, 2026-10-12): whoever tagged it,
      // replied to it or quoted it asked to be answered, and that is their
      // consent, so no answer, code's line or draft, carries "Say stop to opt
      // out." (the gate takes the notice off and refuses any other wording of
      // one: XGateCtx.answer). A stop is honoured exactly as before: read on
      // every tag of the batch (isAnswerOptOut), recorded and every waiting
      // answer to that person cancelled, before this ran; repliesOptedOut
      // above passes them over, and schedulePost refuses them again.
      const lineOpts = { paper: f.mode === "paper" };
      // NEVER CONFIRM A BUY BY NAME: a tag that names a coin in any way gets
      // no list of its buys and no fact about them, research on or off. Only
      // the tag's own full contract, bought by its records, may be (exact).
      // A CHECK IS ALWAYS OF A NAMED COIN: a project behind a ticker is a coin on this account (writer.ts checkPrompt).
      const coinNamed = asked.kind === "check" || namesACoin({ text: candidate.text, intent: asked, address: candidate.address ?? null });
      // ITS BUYS ONLY FOR A PLAIN QUESTION ABOUT WHAT IT TRADES (red-team 2026-10-12):
      // a copycat no matcher finds ("bonc", a frog emoji) is never handed them.
      // NOR UNDER ANOTHER HANDLE (red-team 2026-10-12): the reply prefix X writes
      // is taken off before the question is read, so "@dogwifcoin @alanaldale
      // did you buy <its PEPE contract>?" read as the plain exact question and
      // "yep, bought it lately" was posted under a tag naming another project.
      // A tag whose prefix names anyone else gets neither its buys nor the
      // exact path, as it never gets the model line.
      const otherHandles = candidate.otherHandles === true;
      const general = !coinNamed && !otherHandles && generalTradesQuestion(candidate.text);
      // Nothing is looked up for its strategy or its buys.
      const intent = research && chatKind === null ? asked : null;
      const answerKey = `llm-answers:${account.xUserId}:${utcDay(nowMs)}`;
      // THE DAY'S LARP CHECKS, counted before anything is read: a check past
      // the count is answered by nothing (the tag is passed over, no row).
      if (asked.kind === "check" && !(await takeAllowance(shared, `x-checks:${utcDay(nowMs)}`, checksPerDay, nowMs))) {
        bump("answer-checks-spent");
        continue;
      }
      if (!undrafted) {
        if (!(await takeAllowance(shared, answerKey, ANSWER_DRAFTS_PER_DAY, nowMs))) {
          bump("answer-drafts-spent");
          return null;
        }
        if (!(await takeAllowance(shared, `llm:${utcDay(nowMs)}`, llmPerDay, nowMs))) {
          await returnAllowance(shared, answerKey, at());
          return null;
        }
      }
      const day = localDay(tz, nowMs);
      // Shown its recent posts without a research answer; gated against them all.
      // NEVER ITS BUY OR SALE POSTS, NOR A LINE OF THE OTHER MONEY (red-team
      // 2026-10-12): sixty days of every kind of post put a paper-era "grabbed
      // some bonk on paper" in front of a live agent's general answer as "your
      // recent posts", beside "You trade with real money". It is shown what it
      // already said (`said`, filtered by money and kind), as its recent posts too.
      const facts = writerFacts(f, day, said);
      const social = undrafted ? null : await deps.socialProfile?.(account.tenant);
      const walletPublic = !!social?.publicWallet && social.publicWallet.address.toLowerCase() === f.agentId.toLowerCase();
      // ONE BUNDLE, AT MOST, for this answer — and only with research on.
      let looked: { intent: AnswerIntentKind; research: string[]; creatorClaim?: string; boughtExact?: boolean } | null = null;
      // THE FIGURES, KEPT APART FROM WHAT THE WRITER IS HANDED: typed numbers
      // code renders after the gate (xpost/figures.ts), never in a prompt.
      // Only beside words it was handed: a line with nothing looked up to
      // stand on is never put in.
      let figures: FiguresSpec | null = null;
      // WHAT'S HOT, AS CODE READ IT (zero coins: nothing past the floors), for
      // code's own words (xpost/market.ts). Null: the index was not read.
      let hotRead: HotRead | null = null;
      // A MAJOR, AS CODE READ IT from CoinGecko, beside its figures: its words are code's too.
      let majorRead: MajorRead | null = null;
      // HOW'S THE MARKET, AS CODE READ IT: the big coins' day and the chain's movers, each null unread.
      let marketRead: MarketRead = { majors: null, chain: null };
      // ANSWERED BY NOTHING, AS RESEARCH READ IT (ResearchBundle.unanswered): no draft, a skipped row, the allowances back.
      let researchUnanswered = false;
      // The names CoinGecko lists the line's coins under, read only against who is asking (authorShows).
      let lineNames: string[] = [];
      // A LARP CHECK AS CODE READ IT: its verdict and reasons, for code's own lines when the draft does not stand.
      let checkRead: CheckRead | null = null;
      if (research && intent) {
        const bundle = await research.gather({ shared, intent, tenant: account.tenant, xUserId: account.xUserId, facts: f, posts, fomo: researchFomo,
          // Under another handle no question is one the exact path reads (ResearchInput.question: absent, never).
          coinNamed: coinNamed || !general, ...(otherHandles ? {} : { question: candidate.text }), ownCoins: olderBought, budgetMs: Math.max(0, sendBy - at()) })
          .catch((): ResearchBundle => ({ facts: [], lookups: 0, notes: ["fault"] }));
        looked = { intent: bundle.intent ?? intent.kind, research: bundle.facts, ...(bundle.claim ? { creatorClaim: bundle.claim } : {}),
          ...(bundle.exact === true && candidate.address && !otherHandles ? { boughtExact: true } : {}) };
        if (bundle.figures?.length && bundle.facts.length) figures = bundle.figures;
        if (bundle.shownNames?.length) lineNames = bundle.shownNames;
        if (hotCoded && bundle.hot) hotRead = bundle.hot;
        if (asked.kind === "major" && figures && bundle.major) majorRead = bundle.major;
        if (marketCoded && bundle.market) marketRead = bundle.market;
        if (asked.kind === "check" && bundle.check) checkRead = bundle.check;
        // Chat as research read it is held to the same allowlists too (unbanteredChat above).
        researchUnanswered = bundle.unanswered === true || (looked.intent === "chat" && !chatAllowed(candidate.text));
        bump(`answer-intent-${intent.kind}`);
        if (bundle.lookups) bump("answer-lookups", bundle.lookups);
        for (const note of new Set(bundle.notes)) bump(`answer-research-${note}`);
      }
      // NEVER DRAFTED, AS RESEARCH READ IT (red-team 2026-10-12): a major's
      // shape whose coin's place held more than a coin and matched none
      // ("thoughts on eth guys") was drafted as chat, and "plenty of room left
      // to run" went out. NOR DECLINED (red-team review, 2026-10-12): code's
      // playful decline here put "haha, brave soul. direction from a bot? nah"
      // under "what do you think of black people?", "thoughts on gay
      // marriage?" and "thoughts on trans kids?", with no model call at all.
      // A skipped row, as before the decline, and the allowances taken for a
      // draft go back.
      if (researchUnanswered) {
        if (!undrafted) {
          await returnAllowance(shared, answerKey, at());
          await returnAllowance(shared, `llm:${utcDay(nowMs)}`, at());
        }
        bump("answer-unanswered");
        const skippedAt = at();
        const id = await schedulePost(shared, {
          tenant: account.tenant, xUserId: account.xUserId, kind: "answer", dedupeKey, body: "", coin: null, decisionId: null, dueAtMs: skippedAt, nowMs: skippedAt,
          replyToTweetId: comment.id, replyRootTweetId: comment.id, replyAuthorId: comment.authorId, status: "skipped", reason: "research:unanswered",
        });
        return id === null ? null : { body: null };
      }
      // NEVER A COIN'S OWN ACCOUNT SHOWN ITS COIN (red-team review of 1ed46625,
      // 2026-10-12): "ZapXOfficial · ZAPX | stealth launch, LP burned" asked
      // "what's hot?" and got "geckoterminal robinhood: trending $ZAPX 24h
      // +64.3% …; fomo: most bought $ZAPX" in reply, the house account handing
      // a token's own account its coin as trending and most bought. A market,
      // hot or major answer whose figures would show a ticker the author's
      // handle or display name holds, or the name coingecko lists such a coin
      // under (red-team review of daaae961: "@chimpplanet" was shown CHMP,
      // listed as "Chimp Planet") (authorShows; bitcoin, ether and solana
      // aside, the same for every asker) is answered by nothing: a skipped row,
      // and the allowances taken for a draft go back.
      const lineTickers = (figures ?? []).flatMap((s) => (s.kind === "pools" || s.kind === "majors" ? s.coins.map((c) => c.symbol)
        : s.kind === "crowd" || s.kind === "trending" ? s.symbols : s.kind === "major" ? [s.symbol] : []))
        .map((s) => cleanTicker(s)).filter((t): t is string => t !== null && !MARKET_MAJORS.some((m) => m.symbol.toUpperCase() === t));
      if ((hotCoded || marketCoded || asked.kind === "major") && (lineTickers.length > 0 || lineNames.length > 0) && authorShows(author, lineTickers, lineNames)) {
        if (!undrafted) {
          await returnAllowance(shared, answerKey, at());
          await returnAllowance(shared, `llm:${utcDay(nowMs)}`, at());
        }
        bump("answer-author-ticker");
        const skippedAt = at();
        const id = await schedulePost(shared, {
          tenant: account.tenant, xUserId: account.xUserId, kind: "answer", dedupeKey, body: "", coin: null, decisionId: null, dueAtMs: skippedAt, nowMs: skippedAt,
          replyToTweetId: comment.id, replyRootTweetId: comment.id, replyAuthorId: comment.authorId, status: "skipped", reason: "research:author-ticker",
        });
        return id === null ? null : { body: null };
      }
      // ITS STRATEGY, ITS BUYS, IN CODE'S WORDS (chatKind above). Its
      // buys: those of the money it trades with now, newest first, never a
      // name no line of the house's answers under, and none at all for an
      // agent that is not trading (as an idle agent's draft was told none),
      // nor for a tag that is not the plain question (`general`: no coin named,
      // no other handle).
      const tradeNames = !general || f.mode === "idle" ? [] : buys.filter((b) => b.paper === (f.mode === "paper") && !unshowableName(b.label)).map((b) => b.label);
      const chatLines = chatKind === "self" ? selfAnswers(facts.strategy, comment.id, facts.style, lineOpts)
        : chatKind === "trades" ? tradesAnswers(tradeNames, comment.id, facts.style, lineOpts) : [];
      if (chatLines.length) bump(`answer-chat-${chatKind}`);
      // NO MODEL WORDS BESIDE A LINE OF COINS (red-team 2026-10-12): the gate
      // read a "what's hot?" draft before code put "$CHUMP 24h +41.2%" after
      // it, so "if i had to pick one it'd be the first", "these are my plays"
      // and "i'm in the top one myself" were each admitted and posted as a
      // pick, or a holding, of a named coin. The words are code's
      // (xpost/market.ts): with coins to show, how many stand out and which
      // way the first went, in one of eight frames; with nothing past the
      // floors, or nothing read, a line that says so.
      // A MAJOR TOO (red-team 2026-10-12): drafted words stood right before
      // "coingecko: $ETH #2, ~$3.4k, …", and "looks set to keep climbing
      // toward new highs", "a dip from here would be a gift" and "it's still
      // early on this move" were posted beside the coin's figures. A tag still
      // a major after research (not gone on as a coin of the chain or as
      // chat) is answered in code's words: what coingecko showed, in one of
      // eight frames, or, coingecko unread or research off, a line that says
      // there is no read. The model allowances taken for a draft go back.
      const stillMajor = asked.kind === "major" && (looked === null || looked.intent === "major");
      const majorLines = stillMajor && majorRead ? majorAnswers(majorRead, comment.id, facts.style, lineOpts) : [];
      // Figures only beside the words that read them: never beside "no read".
      if (stillMajor && !majorLines.length) figures = null;
      const market = hotCoded
        ? hotRead && hotRead.coins >= 1 ? hotAnswers(hotRead, comment.id, facts.style, lineOpts)
          : hotRead ? hotNoneAnswers(comment.id, facts.style, lineOpts) : hotUnreadAnswers(comment.id, facts.style, lineOpts)
        : marketCoded ? marketAnswers(marketRead, comment.id, facts.style, lineOpts)
        : stillMajor ? majorLines.length ? majorLines : majorUnreadAnswers(comment.id, facts.style, lineOpts) : [];
      // Figures only beside the words that read them: a market answer with nothing read says so, with no line.
      if (marketCoded && !marketRead.majors && !marketRead.chain) figures = null;
      if (market.length && !undrafted) {
        await returnAllowance(shared, answerKey, at());
        await returnAllowance(shared, `llm:${utcDay(nowMs)}`, at());
      }
      if (market.length) bump("answer-code-words");
      const coded = templated || market.length > 0 || chatLines.length > 0;
      // CODE'S LINES, the model question's, a market answer's, its strategy or
      // its buys, this mention's own first: one it already said is a repeat to
      // the gate, so the next is tried rather than none, and when all have been
      // said lately, none. A paper agent's lines say paper: it is gated as a
      // paper reply.
      const lines = templated ? modelAnswers(comment.id, facts.style, lineOpts) : chatLines.length ? chatLines : market;
      const out: DraftResult = coded
        ? { ok: true, text: lines[0]! }
        // A LARP CHECK IN ITS OWN VOICE (writer.ts checkPrompt): the take code reached, texted back casually.
        : asked.kind === "check"
        ? await tryDraft(creds, checkPrompt({ ...facts, question: candidate.text, research: looked?.research ?? [], ...(looked?.creatorClaim ? { creatorClaim: looked.creatorClaim } : {}) }),
          { call: deps.llm, timeoutMs: deps.draftTimeoutMs })
        : await tryDraft(creds, answerPrompt({ ...facts, question: candidate.text, recentBuys: buys, boughtLately: boughtKind(f),
          said: said.map(withoutReplyOptOut), walletPublic, coinNamed, general, ...(looked ?? {}) }), { call: deps.llm, timeoutMs: deps.draftTimeoutMs });
      const raw = out.ok ? out.text : null;
      const mode = f.mode === "idle" ? null : f.mode;
      // AN ANSWER NOT TOLD ITS BUYS, BACKSTOPPED AT THE GATE (red-team 2026-10-12):
      // a tag that named a coin, or any question that is not a plain one about
      // what it trades. The gate vouches none of its buys, and a draft that
      // names any coin it bought, however spelled, is refused.
      const exact = looked?.boughtExact === true;
      const told = general || exact;
      // ON THE EXACT PATH, only the tagged contract's own names: "yep, bought wif" under it is a buy it never made.
      // AN IDLE AGENT IS TOLD OF NONE BY NAME (red-team 2026-10-12): its paper
      // and real-money buys side by side were said each as the other's money.
      const vouched = general && f.mode !== "idle" ? buys : exact ? exactBuys(f, candidate.address ?? null) : [];
      const namesNone = told && vouched.length === 0;
      // NEVER THE OTHER MONEY'S COINS (red-team 2026-10-12): a coin bought only
      // with the money it does not trade with now (or whose buy's money is
      // unknown) is never named, and an idle agent that names any paper coin
      // says paper — not only the three newest the buys list holds.
      const money = moneyNames(f, posts);
      // Its older buy posts' coins, but for one it was told of by any of that coin's names.
      const vouchedNames = new Set(vouched.map((v) => v.label.toLowerCase()));
      for (const c of f.calls) {
        if (c.side !== "buy" || !vouched.some((v) => v.label === coinOf(c)?.label)) continue;
        for (const n of [c.symbol, c.name, coinOf(c)?.label]) if (typeof n === "string" && n.trim()) vouchedNames.add(n.trim().toLowerCase());
      }
      const older = olderBought.filter((c) => !vouchedNames.has(c.toLowerCase()));
      // NOR A NAME THE ASKER WROTE (red-team 2026-10-12): under "is $WOJAK safer
      // than bonk?" the answer said "bonk's the shaky one" with WOJAK's index
      // read. A word of the question that could be a coin's name (nameLikeWords)
      // is never said back, unless what it looked up says it; read alike for
      // every name, so a refusal tells nothing of which ones it bought.
      const lookedWords = new Set([...(looked?.research ?? []), looked?.creatorClaim ?? ""].flatMap((r) => textWords(r)));
      // "What's hot?" is a whole question on a strict allowlist (hotAsk): none
      // of its words ("trending", "gainers", "meta") can be a coin's name.
      // Nor a larp check's ask ("larp check", "is this real?": checkAsk), a whole-tag allowlist with no coin's name in it.
      const askerNames = asked.kind === "hot" || asked.kind === "check" ? [] : nameLikeWords(candidate.text).filter((w) => !lookedWords.has(w) && !vouchedNames.has(w));
      // WHAT IT WAS HANDED: research or a creator's claim (an answer handed none cites no source).
      const handed = !!looked && (looked.research.length > 0 || !!looked.creatorClaim);
      // A code line is gated as one (asCode): the draft-only clauses below never read it.
      // `fresh`: weighed against no recent post, to read what a draft says apart from whether it repeats (saidPasses below).
      const gate = (text: string, asCode = coded, fresh = false) => admitXPost(text, {
        // An active owner's answer: never a data provider named, code's line or draft (XGateCtx.house).
        kind: "reply", answer: true, house: true, agentName: f.name, mode, coins: vouched.map((c) => c.label),
        paperCoins: [...vouched.filter((c) => c.paper).map((c) => c.label), ...(f.mode === "idle" ? money.paper : [])],
        recentOwn: fresh ? [] : recentOwn, recentFleet: fresh ? [] : recentFleet, emojiOk: facts.style.emoji > 0,
        // A buy it says is one it was told of, or none at all (XGateCtx.buys).
        // A model's draft: never a claim for the house, a tease, a judgement of the asker or a boast (XGateCtx.drafted).
        ...(asCode ? {} : { drafted: true as const, buys: told ? "vouched" as const : "none" as const, unsaid: [...(told && !namesNone ? [] : bought), ...money.otherOnly, ...older, ...askerNames],
          // A coin named, or its trades or a coin asked about off the plain list: not even that it likes it (XGateCtx.named).
          // AND EVERY MARKET ANSWER (red-team 2026-10-12): "what's hot?" names no
          // coin, but an answer to it is about the coins the index shows, and
          // gated as unnamed it posted "these are my picks", "i might buy one
          // later" and "the ones i like are below". A what's-hot or a major
          // answer drafted at all is gated as of a named coin: no first person
          // but a deflection, no liking, no yes or no.
          named: !told && (coinNamed || asked.kind === "own-trades" || asked.kind === "coin" || asked.kind === "hot" || asked.kind === "major"),
          // Told its buys, every other word is everyday or one it was handed (XGateCtx.known).
          // A check's draft may also use how people talk about digging through a project (CHECK_VOCABULARY).
          known: [facts.strategy ?? "", ...(looked?.research ?? []), looked?.creatorClaim ?? "", asked.kind === "check" ? CHECK_VOCABULARY : ""].filter((k) => k !== ""),
          // HANDED WHAT IT LOOKED UP, AND TOLD NONE OF ITS BUYS (red-team 2026-10-12):
          // "per the index, bonk is ripping", "coingecko shows bitcoin up a
          // little" credited names nothing looked up to a source. Every word
          // is everyday or one it was handed, as for an answer told its buys.
          lookedOnly: !told && handed }),
      }, BASE_GATE);
      // SHERWOOD DOES NOT RUN IT YET: a draft that says so is refused before
      // the gate, research on or off — and so is a draft that names it at
      // all. Only code's own lines name it.
      const claimed = raw !== null && sherwoodClaimed(raw);
      // ON ITS LETTERS, NOT A WORD: "sher\u00adwood" is sherwood to a reader.
      const named = !templated && raw !== null && (sherwoodNamed(raw) || sherwoodMentioned(raw));
      // NO SOURCE NOTHING WAS LOOKED UP IN (red-team 2026-10-12): under "is
      // $WOJAK safer than bonk?", looked up for nothing, "it's only hours old on
      // the public index, thin liquidity" was admitted, a read nobody made. A
      // draft handed no research that cites one (the index, fomo, on-chain
      // data, the project or creator) is refused.
      const unlooked = !coded && raw !== null && !handed && carriesResearch(raw);
      let verdict = raw === null || claimed || named || unlooked ? null : gate(raw);
      for (const line of lines.slice(1)) {
        if (verdict?.ok) break;
        verdict = gate(line);
      }
      // AND ON WHAT WOULD BE POSTED: the gate's cleaned text, not the draft it read.
      const postsName = !templated && verdict?.ok === true && (sherwoodNamed(verdict.text) || sherwoodMentioned(verdict.text));
      // NOR A COIN NOTHING WAS LOOKED UP FOR (red-team 2026-10-12): under a
      // tag read as chat, "wif and bonk look hot right now" went out word for
      // word. A draft the gate admitted, handed nothing and told none of its
      // buys, that names a coin in any words (a word that may be a coin's name
      // beside market talk: xpost/words.ts coinTalkIn) is refused. AND IT SAYS
      // ONLY KNOWN WORDS (red-team 2026-10-12), as the gate holds an answer
      // handed research to (lookedOnly): each word everyday, how an agent talks
      // about its trading, or its own name (unknownWordIn). Market words or
      // none: "wif has been strong lately" and "bonk is where the action is"
      // named coins with none of them.
      // NOR THE MARKET AT ALL (red-team 2026-10-12): "crypto is the future, get in
      // while it's early" and "the chain is about to get busy" were posted as
      // chat, handed nothing (xpost/words.ts marketTalkIn).
      // NOR THE HOUSE, A TOKEN, A LAUNCH, SAFETY OR MONEY (red-team 2026-10-12):
      // "no panic fren, the crew is on it and the money is safe" under "did
      // merrymen get hacked?" (xpost/words.ts houseTalkIn).
      const unlookedCoin = !coded && verdict?.ok === true && !handed && !told
        && (coinTalkIn(withoutReplyOptOut(verdict.text), f.name) || unknownWordIn(withoutReplyOptOut(verdict.text), f.name) || marketTalkIn(withoutReplyOptOut(verdict.text))
          || houseTalkIn(withoutReplyOptOut(verdict.text)));
      // NOR TRUST OR FRAUD, HANDED NOTHING, TOLD ITS BUYS OR NOT (red-team
      // review of 1ed46625, 2026-10-12): "i scam people for fun, honestly.",
      // "a bot that will rug you, fren.", "i'm a fake agent, the trades are fake
      // too." and "the only honest bot on the timeline, the rest are fake."
      // were posted under banter. A drafted answer handed no research that
      // speaks of a scam, a rug, a fake, trust, honesty, legitimacy or the like
      // (xpost/words.ts trustTalkIn) is not posted, and gets no fallback.
      const untrusted = !coded && verdict?.ok === true && !handed && trustTalkIn(withoutReplyOptOut(verdict.text));
      // NOR A COIN POINTED AT AND LIKED WITHOUT ITS NAME (red-team review of
      // 1ed46625, 2026-10-12): under "should i buy $SCAM?", "doing great, this
      // one looks solid to me", "doing good, honestly i like it a lot" and "same
      // one they asked about, curve looked early" read as Alan recommending
      // the coin asked about one post up. A drafted answer in a plain follow-up,
      // or under a top-level tag that named no coin (where "this one" has
      // nothing of the asker's to point at), that says "this one", "same one",
      // "the one you asked about", or calls "it" solid, early or its favourite
      // (xpost/words.ts deicticPickIn) is not posted. Under its own buy post
      // nothing is drafted at all (followUp "own-trade" above), and a coin's
      // own question may say "no read on that one".
      const pointsFree = candidate.followUp === "plain" || (candidate.followUp === undefined && !coinNamed);
      const pointed = !coded && verdict?.ok === true && pointsFree && deicticPickIn(withoutReplyOptOut(verdict.text));
      // NO FRIENDLY LINE IN PLACE OF A REFUSED DRAFT (red-team review of
      // daaae961, 2026-10-12): a draft refused for anything at all, or a PASS,
      // leaves the tag unanswered.
      // NEVER AN ACCUSATION, A SAFETY CALL OR ADVICE IN A CHECK (xpost/check.ts accusationIn).
      const accused = asked.kind === "check" && !coded && verdict?.ok === true && accusationIn(verdict.text);
      const drafted = verdict?.ok === true && !postsName && !unlookedCoin && !untrusted && !pointed && !accused ? verdict.text : null;
      // A CHECK STILL GETS ITS ANSWER WHEN THE DRAFT DOES NOT STAND (2026-10-13):
      // refused, a PASS, or the house model down, and code's own casual lines
      // for the same verdict and reasons go instead (xpost/check.ts
      // checkAnswers), gated as code lines, the first the gate admits. Unlike
      // a friendly line in place of a refused chat draft, these say exactly
      // what code found, and nothing else.
      let admitted = drafted;
      if (!admitted && asked.kind === "check" && checkRead) {
        for (const line of checkAnswers(checkRead, comment.id, lineOpts)) {
          const v = gate(line, true);
          if (v.ok && !accusationIn(v.text)) {
            admitted = v.text;
            bump("answer-check-coded");
            break;
          }
        }
      }
      if (asked.kind === "check" && checkRead) bump(`answer-check-${checkRead.verdict}`);
      const finishedAt = at();
      // THE FIGURES LINE, CODE'S, AFTER THE GATE (xpost/figures.ts): only an
      // active owner's answer, only from what research built for this tag,
      // only a line in the renderer's own grammar (admitFiguresLine, again
      // here), after the admitted words, and only while the
      // whole post fits X; else the answer goes out as the gate admitted it.
      // Never a code-built model line. AND NEVER LAXER THAN THE
      // GATE (red-team 2026-10-12): every ticker it shows must clear the
      // gate's own vocabulary (tickerRefusal); "$BUY", "$WAGMI" or "$SHILL"
      // in the line puts no line in at all. NOR THE HOUSE'S OWN NAME in any
      // spelling ("$MERRIMEN", "$MERYMEN": red-team 2026-10-12), read ticker
      // by ticker beside the sherwood screen.
      // AND A COIN'S NAME IN IT ONLY BESIDE CODE'S WORDS (red-team 2026-10-12):
      // a drafted "i'm in the top one myself" or "the first one is the play"
      // before "$ZAPX 24h +42.1%" claims a coin, or recommends it, by name. A
      // drafted answer carries at most a section that names no coin (a
      // tagged contract's onchain hour); the major, the chain's coins, Fomo's
      // and CoinGecko's tickers stand only beside code's own market words.
      // A CHECK'S GITHUB AND HOLDERS (xpost/check.ts checkFigures) name no coin either, so they stand beside its words, drafted or code's.
      const lineFigures = !figures ? null : market.length > 0 ? figures
        : figures.filter((s) => s.kind === "flow" || (asked.kind === "check" && (s.kind === "git" || s.kind === "holders")));
      // NOR THE AGENT'S OWN NAME, whatever the agent is called, NOR A MODEL'S
      // OR A PROVIDER'S (red-team 2026-10-12): a coin named after the agent or
      // its model, trending under its own answer, reads as the house's coin.
      const ownNames = ownNamesOf(f.name);
      // NOR, IN WHAT'S HOT, A NAME ITS OWN BUYS GO BY, ANY CONTRACT (red-team
      // 2026-10-12): a copy of its ZAPX buy, trending, went out as "$ZAPX 24h
      // +912%" under its own ZAPX buy post. Its buys' names and sixty days of
      // buy posts' coins, read again here as research reads them
      // (ownCoinTicker). Never for a major: the asker named that coin, and a
      // line that came or went by its name would say which names it bought.
      // HOW'S THE MARKET TOO, for the chain's coins (2026-10-12); never for its
      // big coins (bitcoin, ether, solana), which are the same three for every
      // asker and say nothing of what it bought: a buy called "SOLX" or "WETH"
      // would otherwise take the whole line out for $SOL or $ETH.
      const ownCoins = hotCoded || marketCoded ? [...bought, ...olderBought] : [];
      const lined = admitted && lineFigures?.length && !templated && active.has(account.tenant.toLowerCase()) ? figuresFor(admitted, lineFigures, ownNames, ownCoins) : null;
      if (figures && admitted) bump(lined ? (lined.dropped > 0 ? "answer-figures-shortened" : "answer-figures") : "answer-figures-left-out");
      const body = lined ? lined.text : admitted;
      // MARKED BY WHAT IT WAS HANDED, not by what the model wrote: an answer
      // given anything looked up is never handed on (ANSWER_LOOKED_UP).
      const lookedUp = !!looked && (looked.research.length > 0 || !!looked.creatorClaim || lined !== null);
      // AND BY WHAT KIND OF EXCHANGE IT WAS (red-team review of 1ed46625): a
      // greeting or banter was one a follow-up may be chatted under
      // (ANSWER_PLAIN_THREAD, still read on older rows); neither is answered
      // since 2026-10-13, so every answer closes its thread.
      const reason = body ? null : claimed ? "gate:sherwood-claim" : named || postsName ? "gate:sherwood-drafted" : unlooked ? "gate:unlooked-source"
        : unlookedCoin ? "gate:unlooked-coin" : untrusted ? "gate:trust-talk" : pointed ? "gate:deictic-pick" : accused ? "gate:accusation"
        : verdict && !verdict.ok ? `gate:${verdict.reason}` : out.ok ? "no-draft" : `no-draft:${out.reason}`;
      const id = await schedulePost(shared, {
        tenant: account.tenant, xUserId: account.xUserId, kind: "answer", dedupeKey, body: body ?? "",
        coin: lookedUp ? ANSWER_LOOKED_UP : null, decisionId: null, dueAtMs: finishedAt, nowMs: finishedAt,
        replyToTweetId: comment.id, replyRootTweetId: comment.id, replyAuthorId: comment.authorId,
        status: body ? "scheduled" : "skipped",
        reason,
      });
      return id === null ? null : { body, lookedUp, ...(reason ? { why: reason } : {}) };
    }
    return null;
  }

  async function writeReply(
    shared: Db, account: XAccount, f: AgentFacts, comments: XReply[], tz: string | null,
    at: () => number, recentOwn: string[], shownOwn: string[], recentFleet: string[],
  ): Promise<{ body: string | null; lookedUp?: boolean; why?: string } | null> {
    if (!creds) return null;
    const nowMs = at();
    const consentAt = await replyConsentAt(shared, account.tenant, account.xUserId);
    if (consentAt === null) return null;
    const posts = await postsOfXUser(shared, account.xUserId, nowMs - PLAN_HISTORY_MS, 200);
    const roots = new Map(posts.filter((p) => p.tenant === account.tenant && p.kind === "buy" && p.status === "posted" && p.tweetId).map((p) => [p.tweetId!, p]));
    // The model can pass, and only one comment is considered per owner per
    // polling pass. Stable ordering does not reward floods of newer comments.
    const ordered = [...comments].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
    for (const comment of ordered) {
      if (comment.createdAtMs < consentAt) continue;
      const parent = roots.get(comment.inReplyToTweetId);
      if (!parent || !parent.coin) continue;
      // Use the original publishable fill for the coin and paper/live mode.
      // A model's old wording cannot establish either, nor can today's mode.
      const fill = f.calls.find((c) => c.decisionId === parent.decisionId && c.side === "buy");
      const coin = fill ? coinOf(fill) : null;
      if (!fill || !coin || coin.key !== parent.coin) continue;
      const candidate = replyCandidate(comment, { rootTweetId: parent.tweetId!, xUserId: account.xUserId, coin: coin.label });
      if (!candidate.ok || await repliesOptedOut(shared, account.xUserId, comment.authorId)) continue;
      const dedupeKey = `reply:${account.xUserId}:${comment.id}`;
      // Nor one an active owner on the same X account already answered: one comment, one reply.
      if (await keyStatus(shared, dedupeKey) !== null || await keyStatus(shared, `answer:${account.xUserId}:${comment.id}`) !== null) continue;
      const dueAtMs = replyDueAt({ parent, authorId: comment.authorId, commentAtMs: comment.createdAtMs,
        posts, tenant: account.tenant, xUserId: account.xUserId, nowMs, tz, clock: PLAN_CLOCK, perDay: cadenceOf(account.tenant).perDay, ownerPerDay: account.prefs.perDay });
      if (dueAtMs === null) continue;
      if (!(await takeAllowance(shared, `llm:${utcDay(nowMs)}`, llmPerDay, nowMs))) return null;
      const facts = writerFacts(f, localDay(tz, nowMs), shownOwn);
      const paper = fill.paper;
      const prompt = replyPrompt({ ...facts, parentBody: parent.body, comment: candidate.text, coin: coin.label, paper });
      const out = await tryDraft(creds, prompt, { call: deps.llm, timeoutMs: deps.draftTimeoutMs });
      const raw = out.ok ? out.text : null;
      // A drafted reply never names sherwood: only an answer's code-built line
      // does. Read on its letters, in the draft and in what would be posted.
      const named = raw !== null && (sherwoodNamed(raw) || sherwoodMentioned(raw));
      const admitted = raw === null || named ? null : admitXPost(raw, {
        kind: "reply", agentName: f.name, mode: paper ? "paper" : "live", coins: [coin.label],
        paperCoins: paper ? [coin.label] : [], recentOwn, recentFleet, emojiOk: facts.style.emoji > 0,
        // A buy it says is the parent's coin, never another (red-team 2026-10-12).
        buys: "vouched",
      }, BASE_GATE);
      const postsName = admitted?.ok === true && (sherwoodNamed(admitted.text) || sherwoodMentioned(admitted.text));
      const verdict = postsName ? null : admitted;
      // Start the owner's full preview window only after the model finishes.
      // Recheck time-sensitive planning rules in case drafting crossed a limit.
      const finishedAt = at();
      const finalDueAt = replyDueAt({ parent, authorId: comment.authorId, commentAtMs: comment.createdAtMs,
        posts, tenant: account.tenant, xUserId: account.xUserId, nowMs: finishedAt, tz, clock: PLAN_CLOCK, perDay: cadenceOf(account.tenant).perDay, ownerPerDay: account.prefs.perDay });
      const body = finalDueAt !== null && verdict?.ok ? verdict.text : null;
      const reason = body ? null : finalDueAt === null ? "stale" : named || postsName ? "gate:sherwood-drafted" : verdict && !verdict.ok ? `gate:${verdict.reason}`
        : out.ok ? "no-draft" : `no-draft:${out.reason}`;
      const id = await schedulePost(shared, {
        tenant: account.tenant, xUserId: account.xUserId, kind: "reply", dedupeKey, body: body ?? "",
        coin: parent.coin, decisionId: parent.decisionId, dueAtMs: finalDueAt ?? dueAtMs, nowMs: finishedAt,
        replyToTweetId: comment.id, replyRootTweetId: parent.tweetId!, replyAuthorId: comment.authorId,
        status: body ? "scheduled" : "skipped", reason,
      });
      return id === null ? null : { body, ...(reason ? { why: reason } : {}) };
    }
    return null;
  }

  /**
   * ONE LINE A PASS, COUNTS ONLY — never a post's text, never a token. Events
   * (a post sent, drafted, cancelled, failed) are always said. A standing
   * condition (the model's allowance spent, an owner whose plan keeps
   * failing) is said when it changes, or every twenty minutes while it
   * lasts, not every minute. A post waiting for its owner to wake is not news.
   * A SKIP SAYS WHY (2026-10-17): "not-posted 2 (insight no-draft:timeout,
   * buy gate:too-short)", the kind and the reason its row keeps, so a slot
   * that went nowhere is read in the log, not only in xpost_posts.reason.
   */
  function summary(counts: Map<string, number>, nowMs: number, details: Map<string, Map<string, number>> = new Map()): string | null {
    const events: string[] = [];
    const conditions: string[] = [];
    for (const [k, n] of counts) {
      if (k === "waiting") continue;
      const part = k === "owner-failed" && ownerFailure ? `${k} ${n} (${ownerFailure})` : `${k} ${n}${whyText(details.get(k))}`;
      (CONDITIONS.has(k) ? conditions : events).push(part);
    }
    const text = conditions.join(", ");
    if (events.length > 0) {
      if (text) lastCondition = { text, at: nowMs };
      return `xpost: ${[...events, ...conditions].join(", ")}`;
    }
    if (conditions.length === 0) return null;
    if (lastCondition && lastCondition.text === text && nowMs - lastCondition.at <= 20 * MIN) return null;
    lastCondition = { text, at: nowMs };
    return `xpost: ${text}`;
  }

  /**
   * THE MARKET NOW, FOR AN ACTIVE OWNER'S INSIGHT POST (the owner's teammate,
   * 2026-10-13), or null when it cannot be read: research off, a fault, or
   * neither the big coins nor the chain read, or nothing in code's words or
   * its line to show. The same bundle "how's the market?" reads
   * (orchestrator-xpost-research.ts marketBundle), within the same lookup
   * allowances and its twelve seconds. `read` is code's words for the model
   * (market.ts insightFacts, each `sayable`); `figures` the line code puts
   * after the gate; `ownCoins` every name its buys and sixty days of its buy
   * posts go by, which the post may never say and the line never shows.
   */
  async function readInsight(shared: Db, account: XAccount, f: AgentFacts, nowMs: number): Promise<{ read: string[]; figures: FiguresSpec; ownCoins: string[] } | null> {
    if (!research) return null;
    const posts = (await postsOfXUser(shared, account.xUserId, nowMs - OWN_MEMORY_MS, 500)).filter((p) => p.tenant === account.tenant);
    const olderBought = posts.filter((p) => p.kind === "buy" && typeof p.coin === "string" && p.coin.trim() !== "").map((p) => p.coin!.trim());
    const bundle = await research.gather({ shared, intent: { kind: "market" }, tenant: account.tenant, xUserId: account.xUserId, facts: f, posts, fomo: researchFomo,
      coinNamed: true, ownCoins: olderBought }).catch((): ResearchBundle => ({ facts: [], lookups: 0, notes: ["fault"] }));
    if (!bundle.insight || !bundle.figures?.length) return null;
    const read = insightFacts(bundle.insight).filter(sayable);
    if (!read.length) return null;
    return { read, figures: bundle.figures, ownCoins: [...boughtNames(f, posts), ...olderBought] };
  }

  /**
   * DRAFT, GATE, WRITE — one intent, unless its key is already spent. Scheduled when a draft passed; skipped
   * (the key spent) when the model passed or the gate refused, so the same
   * buy or day is not drafted again every minute. The intro alone falls back
   * to the template pool before it gives up. A buy or casual post with no
   * model allowance left is not written at all: nothing was decided.
   */
  async function writeIntent(
    shared: Db,
    account: XAccount,
    f: AgentFacts,
    intent: PlanIntent,
    nowMs: number,
    recentOwn: string[],
    shownOwn: string[],
    recentFleet: string[],
    talked: string[] = [],
  ): Promise<{ outcome: string; body: string | null; why?: string }> {
    // A KEY ALREADY SPENT IS NOT DRAFTED AGAIN. The plan weighs the X
    // account's history, so a key this owner wrote for the X account it had
    // connected earlier (today's casual key, say) is not in it and comes back
    // every minute. Drafting it would spend a model call on a write the
    // UNIQUE key refuses. Nothing is done, and nothing is said.
    if ((await keyStatus(shared, intent.dedupeKey)) !== null) return { outcome: "key-spent", body: null };
    const day = PLAN_CLOCK.localDay(null, nowMs);
    // Shown its recent posts without a research answer; gated against them all.
    const facts = writerFacts(f, day, shownOwn);
    const social = await deps.socialProfile?.(account.tenant);
    if (social?.xVoice === "dry") facts.voice = "dry";
    const wallet = intent.kind === "intro" && social?.publicWallet && social.publicWallet.address.toLowerCase() === f.agentId.toLowerCase()
      ? social.publicWallet : null;
    const gate: XGateCtx = {
      kind: intent.kind,
      agentName: f.name,
      mode: modeOf(f),
      coins: [],
      recentOwn,
      recentFleet,
      emojiOk: facts.style.emoji > 0,
      // An active owner's post never names a data provider, whatever its kind (XGateCtx.house, 2026-10-13).
      ...(active.has(account.tenant.toLowerCase()) ? { house: true as const } : {}),
    };
    let prompt: ReturnType<typeof introPrompt> | null = null;
    let coin: string | null = null;
    let decisionId: string | null = null;
    let projectDescription: string | null = null;
    let tokenDisclosure: PublicWallet | null = null;
    // An active owner's market insight post (2026-10-13): code's figures line goes after the words, and the coins it may not show.
    let insight: { figures: FiguresSpec; ownCoins: string[] } | null = null;
    // AN ACTIVE OWNER'S WIN IS SAID WHATEVER THE MODEL DOES (the owner's ask,
    // 2026-10-14): when its draft is not there (a pass, a refusal, an outage,
    // a spent allowance), code's own sale words are (sale-words.ts).
    const winWords = intent.kind === "sell" && active.has(account.tenant.toLowerCase()) && isWin(intent.call);
    if (intent.kind === "intro") {
      prompt = introPrompt(facts);
    } else if (intent.kind === "buy") {
      const call = f.calls.find((c) => c.decisionId === intent.call.decisionId);
      if (!call) return { outcome: "call-gone", body: null };
      gate.mode = call.paper ? "paper" : "live";
      gate.coins = coinNames(intent.coin, call);
      gate.paperCoins = call.paper ? gate.coins : [];
      // ITS OWN FEED WORDS ARE A SEED, NOT A DRAFT. The feed already printed
      // them under this trade; an X post that only repeats them is the feed's
      // line cross-posted, not something said on X.
      gate.seeds = call.ownWords ? [call.ownWords] : [];
      coin = intent.coinKey;
      decisionId = call.decisionId;
      if (social?.xTokenAddresses === true) {
        const agent = social.currentAgent;
        if (!agent || agent.address.toLowerCase() !== f.agentId.toLowerCase()) return { outcome: "token-unverified", body: null };
        tokenDisclosure = await publicTokenForDecision(shared, agent, call.decisionId, "buy");
        if (!tokenDisclosure || tokenDisclosure.address !== call.token?.toLowerCase()) return { outcome: "token-unverified", body: null };
        if (social.discoveryFocus === "new-projects") {
          const project = await (deps.publicProjectDescription ?? readPublicProjectDescription)(tokenDisclosure.address, tokenDisclosure.chainId).catch(() => null);
          if (project?.token.toLowerCase() === tokenDisclosure.address && project.chainId === tokenDisclosure.chainId) projectDescription = project.description;
        }
      }
      // The gloss dice are the account's and the decision's, so two accounts
      // buying one coin the same hour do not say it the same way.
      prompt = buyPrompt({ ...facts, coin: intent.coin, paper: call.paper, bands: call.bands, ownWords: call.ownWords, projectDescription, glossSeed: `${account.tenant}|${call.decisionId}` });
    } else if (intent.kind === "sell") {
      const agent = social?.currentAgent;
      if (!social?.xTradeResults || !agent || agent.address.toLowerCase() !== f.agentId.toLowerCase()) return { outcome: "sale-unverified", body: null };
      const call = intent.call;
      gate.mode = "live";
      gate.coins = coinNames(intent.coin, call);
      coin = intent.coinKey;
      decisionId = call.decisionId;
      if (social.xTokenAddresses === true) {
        tokenDisclosure = await publicTokenForDecision(shared, agent, call.decisionId, "sell");
        if (!tokenDisclosure || tokenDisclosure.address !== call.token.toLowerCase()) return { outcome: "token-unverified", body: null };
      }
      prompt = sellPrompt({ ...facts, coin: intent.coin, paper: false, outcome: call.outcome });
    } else if (intent.kind === "recap") {
      // A RECAP IS CODE'S WORDS AND CODE'S FIGURES (xpost/recap.ts): no model
      // call, so a burst is said even when the model passes or is down. The
      // first of its lines the gate admits, then its figures line, or nothing.
      const money = f.mode === "idle" ? null : f.mode;
      if (!money) return { outcome: "recap-idle", body: null };
      gate.mode = money;
      let said: string | null = null, why = "recap-gate";
      for (const line of recapLines(intent.dedupeKey, { paper: money === "paper" })) {
        const v = admitXPost(line, gate, BASE_GATE);
        if (v.ok) {
          said = v.text;
          break;
        }
        why = `gate:${v.reason}`;
      }
      // A COIN THE TICKER SCREENS REFUSE COSTS THE COINS, NEVER THE RECAP (review,
      // 2026-10-14): the line is tried whole, then without its "traded" coins.
      const spec = recapFigures(intent);
      const lined = said ? (figuresFor(said, spec, ownNamesOf(f.name), []) ?? figuresFor(said, spec.filter((x) => x.kind !== "traded"), ownNamesOf(f.name), [])) : null;
      const recapBody = lined?.line ? lined.text : null;
      const recapReason = said ? "recap-figures-left-out" : why;
      const written = await schedulePost(shared, {
        tenant: account.tenant, xUserId: account.xUserId, kind: "recap", dedupeKey: intent.dedupeKey, body: recapBody ?? "",
        // WHAT IT COVERS, IN THE SAME INSERT (planner.ts recapCoverText): no
        // later plan posts those trades one by one or recaps them again.
        coin: recapCoverText(intent.covers), decisionId: null, dueAtMs: intent.dueAtMs, nowMs,
        status: recapBody ? "scheduled" : "skipped", reason: recapBody ? null : recapReason,
      });
      if (written === null) return { outcome: "already-written", body: null };
      if (recapBody) return { outcome: "drafted-recap", body: recapBody };
      return { outcome: "not-posted", body: null, why: `recap ${recapReason}` };
    } else {
      // A trade-talk day is handed no seed, any other day no coin: neither is
      // offered, or vouched to the gate, on the day it is not about.
      const casual = casualInputs(f, intent.day, { coins: account.prefs.buys, slot: intent.slot, tradeTalkInTen: cadenceOf(account.tenant).tradeTalkInTen });
      // MARKET INSIGHTS ON THE TIMELINE (the owner's teammate, 2026-10-13: "talk
      // constantly about market insights"): every casual slot of an active owner is a post
      // about the market now, in a trader's technical words, from code's read
      // of the market (readInsight) and nothing else: no digit, no name, no
      // source, no forecast, no advice, no buy or holding (XGateCtx.insight,
      // `buys: "none"`), every word everyday, technical (INSIGHT_VOCABULARY)
      // or one it was handed (`lookedOnly`, `known`), and code's figures line
      // after it. Every other owner's casual post, and a slot whose market
      // cannot be read, are the casual post as before.
      const read = active.has(account.tenant.toLowerCase()) ? await readInsight(shared, account, f, nowMs) : null;
      const insightAsk = read ? insightPrompt({ ...facts, read: read.read }) : null;
      if (read && insightAsk) {
        insight = { figures: read.figures, ownCoins: read.ownCoins };
        Object.assign(gate, { insight: true, buys: "none", lookedOnly: true, known: [...INSIGHT_VOCABULARY, ...read.read], unsaid: read.ownCoins, coins: [], seeds: [] });
        prompt = insightAsk;
      } else {
        gate.coins = casual.recentCoins.map((c) => c.label);
        gate.paperCoins = casual.recentCoins.filter((c) => c.paper).map((c) => c.label);
        gate.seeds = casual.seed ? [casual.seed] : [];
        prompt = casualPrompt({ ...facts, ...casual, talked });
      }
    }

    let body: string | null = null;
    let reason = "no-model";
    if (creds) {
      if (await takeAllowance(shared, `llm:${utcDay(nowMs)}`, llmPerDay, nowMs)) {
        // PASS, an empty answer, an error or a timeout alike spend the key, so
        // a model outage costs posts, never a loop of calls on the allowance;
        // which one it was is kept (no-draft:timeout, no-draft:groq-429).
        const out = await tryDraft(creds, prompt, { call: deps.llm, timeoutMs: deps.draftTimeoutMs });
        if (!out.ok) reason = `no-draft:${out.reason}`;
        else {
          const v = admitXPost(out.text, gate, BASE_GATE);
          if (v.ok && projectDescription && !/\bproject says\b/i.test(v.text)) reason = "gate:project-attribution";
          else if (v.ok) body = v.text;
          else reason = `gate:${v.reason}`;
        }
      } else {
        reason = "no-budget";
        if (intent.kind !== "intro" && !winWords) return { outcome: "no-model-budget", body: null };
      }
    }
    if (!body && intent.kind === "intro") {
      for (let attempt = 0; attempt < TEMPLATE_TRIES && !body; attempt++) {
        // A redraft rolls fresh dice: the draw that was refused last time is not drawn again.
        const redraft = intent.attempt > 0 ? `|redraft-${intent.attempt}` : "";
        const text = introTemplate({ agentName: f.name, mode: f.mode, style: facts.style }, seeded(`intro|${account.tenant}|${account.xUserId}|${attempt}${redraft}`));
        const v = admitXPost(text, gate, BASE_GATE);
        if (v.ok) body = v.text;
        else reason = `template:${v.reason}`;
      }
    }
    // A SALE POST IS WHOLE OR NOT AT ALL: its words, code's result line, and
    // the token link after it, inside X's limit (review of the wins branch,
    // 2026-10-14: an active owner's tx link and contract leave about sixty-five
    // characters for the words, and a win whose words ran longer was skipped).
    // A win takes code's own words (sale-words.ts) whenever the model's are
    // not there or do not fit: the first line the gate admits that fits whole,
    // each held to every rule a drafted sale sentence is.
    if (intent.kind === "sell") {
      const sale = intent.call;
      const whole = (words: string): string | null => {
        const said = appendSaleOutcome(words, sale.outcome, active.has(account.tenant.toLowerCase()) ? sale.gainPct : undefined);
        if (!said) {
          reason = "sale-outcome-invalid";
          return null;
        }
        if (!tokenDisclosure) return said;
        const linked = appendPublicToken(said, tokenDisclosure, active.has(account.tenant.toLowerCase()));
        if (!linked) reason = "token-disclosure-invalid";
        return linked;
      };
      let post = body ? whole(body) : null;
      if (!post && winWords) {
        // The coin's label first, then its other vetted names, shortest first
        // (second review of the wins branch: a long name, a name with a number
        // word or doubled spaces had no line, though its ticker would).
        const tidy = (n: string) => n.replace(/\s+/g, " ").trim();
        const names = [...new Set([tidy(intent.coin), ...gate.coins.map(tidy).sort((x, y) => x.length - y.length)])].filter(Boolean);
        const wordsGate: XGateCtx = { ...gate, coins: [...new Set([...gate.coins, ...names])] };
        // Every name's three-part lines, then the shorter two-part ones.
        names: for (const name of [...names.map((x) => [x, 3] as const), ...names.map((x) => [x, 2] as const)]) {
          for (const line of saleLines(name[0], intent.dedupeKey, name[1])) {
            const v = admitXPost(line, wordsGate, BASE_GATE);
            if (!v.ok) {
              reason = `sale-words:${v.reason}`;
              continue;
            }
            post = whole(v.text);
            if (post) break names;
          }
        }
      }
      body = post;
    }
    // AN INSIGHT POST CARRIES CODE'S FIGURES LINE, OR IS NOT POSTED: the words
    // describe what the line shows, and a post with no line is skipped
    // (insight-figures-left-out) rather than going out on words alone.
    if (body && insight) {
      const lined = figuresFor(body, insight.figures, ownNamesOf(f.name), insight.ownCoins);
      if (lined?.line) body = lined.text;
      else {
        body = null;
        reason = "insight-figures-left-out";
      }
    }
    if (body && wallet) {
      body = appendPublicWallet(body, wallet);
      if (!body) reason = "wallet-intro-invalid";
    }
    // A buy's token link; a sale's is in its whole post above.
    if (body && tokenDisclosure && intent.kind !== "sell") {
      body = appendPublicToken(body, tokenDisclosure, active.has(account.tenant.toLowerCase()));
      if (!body) reason = "token-disclosure-invalid";
    }
    const written = await schedulePost(shared, {
      tenant: account.tenant,
      xUserId: account.xUserId,
      kind: intent.kind,
      dedupeKey: intent.dedupeKey,
      // A refused draft is not kept: whatever made it unpostable stays out of the table too.
      body: body ?? "",
      coin,
      decisionId,
      dueAtMs: intent.dueAtMs,
      nowMs,
      status: body ? "scheduled" : "skipped",
      reason: body ? null : reason,
    });
    if (written === null) return { outcome: "already-written", body: null };
    if (body) return { outcome: insight ? "drafted-insight" : `drafted-${intent.kind}`, body };
    // The skip says why in the pass's line: the kind and the reason the row keeps, an operator code only.
    return { outcome: "not-posted", body: null, why: `${insight ? "insight" : intent.kind} ${reason}` };
  }
}
