/**
 * WHAT THE ROOM MAY KNOW ABOUT EACH AGENT — and the calls it actually made.
 *
 * Everything an agent line can say that is a FACT comes from here: its name,
 * whether it trades live or on paper, how long it has existed, the strategy its
 * owner picked, and the trades it made in the last few hours. The voice layer
 * decorates these; it never adds to them. A template or a model that is handed
 * no figure cannot print one, so the discipline lives in what this module
 * refuses to return rather than in anything downstream remembering a rule.
 *
 * READ-ONLY, AND ONLY FROM THE SHARED LEDGER — plus the room's own record of
 * which calls it already posted (callsSql). The room lives in its own tables
 * and nothing here writes to any of them; the one statement that is not a read
 * is the room's own CREATE TABLE IF NOT EXISTS, memoised per Db, so that record
 * can be read before the room has ever run. Nothing here feeds a trading
 * decision either: this module reads trading's tables, never the other way
 * round.
 *
 * ONE QUERY PER KIND PER PASS, for the whole roster. The conductor steps every
 * ~15 s across the whole fleet, and a query per agent would be fifty round
 * trips to the shared Postgres the trading mirror also writes to.
 *
 * NAMED COLUMNS ONLY, NEVER A STAR. `decisions.signals_json` is the owner's
 * whole balance sheet, `size_usdg` is a private trade size, and the agents row
 * carries the owner's wallet, the session key, the caps and the live blocker.
 * None of them is filtered out below — they are never selected, which is a
 * stronger guarantee than any filter, and facts.test.ts scans this file's SQL
 * to keep it so.
 */

import { agentNameForSlug, DEFAULT_AGENT_NAME, normalizeAgentName, STORED_AGENT_NAME_RE } from "../../../packages/core/src/agent-name";
import { SETTINGS_DEFAULTS } from "../../../packages/core/src/settings";
import { CASH } from "../../../packages/core/src/tokens";
import { everyBand } from "../class-evidence";
import { coinDisplayName } from "../coin-name";
import type { Db } from "../db";
import { getIdentityStore, SLUG_RE } from "../identity-store";
import { traitsOf, type Disposition } from "../social-post";
import { LANDED_STATUSES, PUBLISHABLE_SOURCES, PUBLISHABLE_STRATEGIES, publishableThesis } from "../thesis-policy";
import { nameRefusal } from "./policy";
import { ensureGroupchatSchema } from "./store";
import type { CallRef } from "./types";

// ── profiles ─────────────────────────────────────────────────────────────────

export interface RosterEntry {
  tenant: string;
  agentId: string;
}

/** What the owner chose, as far as the room may say it. Projected in the orchestrator from sealed settings. */
export interface ChatProfile {
  strategy: string | null;
  traits: string[];
}

/**
 * A setting read the way the child reads it, minus the environment.
 *
 * THE SAME BOUNDS AS worker/src/settings.ts's `num`, so an out-of-range value
 * falls to the default here exactly as it does in the agent that trades on it.
 * A trait claimed from a value the agent itself refused would be a trait the
 * agent does not have.
 */
function bounded(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

/**
 * THE DEFAULTS THE SOCIAL WRITER MEASURES TRAITS AGAINST, copied from its call
 * site in index.ts rather than re-derived. Two writers measuring "moves early"
 * against different baselines would give one agent two personalities.
 */
const DISPOSITION_DEFAULTS: Disposition = {
  maxHoldSec: SETTINGS_DEFAULTS.classMaxHoldSec ?? 21600,
  exitAtGraduationPct: SETTINGS_DEFAULTS.classExitAtGraduationPct ?? 85,
  perEntryUsdg: SETTINGS_DEFAULTS.classPerEntryUsdg ?? 5,
  maxImpactBps: SETTINGS_DEFAULTS.maxImpactBps ?? 300,
  minDepthUsdg: SETTINGS_DEFAULTS.classMinDepthUsdg ?? 100,
};

/**
 * The owner's strategy and traits, as the room may state them.
 *
 * RESOLVED THE WAY THE CHILD RESOLVES IT: an absent or malformed strategy is
 * the default the child actually runs, and a settings object that is missing
 * entirely is the "safe defaults" the orchestrator hands a tenant who never
 * saved anything. What differs is what may be SAID: only a strategy on the
 * publication list is named. A tenant's own file is a string we did not write,
 * and `llm-strategist` is off that list on purpose (thesis-policy.ts).
 *
 * NO ENVIRONMENT. The child also honours MERRYMEN_* overrides, but this runs in
 * the orchestrator from a raw settings object and has to stay pure; an
 * operator-wide override is not something the owner chose, so it is not a
 * trait of their agent either.
 */
export function chatProfileOf(settings: unknown): ChatProfile {
  const file: Record<string, unknown> =
    settings !== null && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};

  const typed = typeof file.strategy === "string" ? file.strategy.trim() : "";
  const runs = typed && /^[A-Za-z0-9_-]{1,64}$/.test(typed) ? typed : SETTINGS_DEFAULTS.strategy;
  const strategy = (PUBLISHABLE_STRATEGIES as readonly string[]).includes(runs) ? runs : null;

  const d = DISPOSITION_DEFAULTS;
  const own: Disposition = {
    maxHoldSec: bounded(file.classMaxHoldSec, d.maxHoldSec, 60, 30 * 86_400),
    exitAtGraduationPct: bounded(file.classExitAtGraduationPct, d.exitAtGraduationPct, 1, 100),
    perEntryUsdg: bounded(file.classPerEntryUsdg, d.perEntryUsdg, 0, 1_000_000),
    maxImpactBps: bounded(file.maxImpactBps, d.maxImpactBps, 0, 10_000),
    minDepthUsdg: bounded(file.classMinDepthUsdg, d.minDepthUsdg, 0, 10_000_000),
  };
  return { strategy, traits: traitsOf(own, d) };
}

// ── facts ────────────────────────────────────────────────────────────────────

/** A trade the agent made, as the room may show it. See CallRef for why it has no size. */
/**
 * TWO CARDS FOR THE SAME COIN. The contract decides when both have one. With
 * neither, the ticker — case aside — or, failing that, the name. With only ONE
 * of them known, never: a coin with an address and one without are not
 * evidence of the same coin, and "PEPE" is more than one contract. Shared by
 * the conductor (repeats, re-entries, a buy since sold) and voice.ts (which
 * card a thread is about), so both mean the same thing by "the same coin".
 */
export function sameCoin(a: Pick<CallRef, "token" | "symbol" | "name">, b: Pick<CallRef, "token" | "symbol" | "name">): boolean {
  const ta = a.token ? String(a.token).toLowerCase() : "";
  const tb = b.token ? String(b.token).toLowerCase() : "";
  if (ta || tb) return ta !== "" && ta === tb;
  const sa = a.symbol ? String(a.symbol).toLowerCase() : "";
  const sb = b.symbol ? String(b.symbol).toLowerCase() : "";
  if (sa || sb) return sa !== "" && sa === sb;
  const na = a.name ? String(a.name).toLowerCase() : "";
  return na !== "" && na === (b.name ? String(b.name).toLowerCase() : "");
}

export interface CallFact extends CallRef {
  decisionId: string;
  /** Unix seconds the decision was taken. */
  atSec: number;
  /** Only words from `everyBand()` — the closed vocabulary. Never a figure. */
  bands: string[];
  /** The agent's own published post about this trade, clipped like the feed clips it, or null. */
  ownWords: string | null;
}

export interface AgentFacts {
  tenant: string;
  agentId: string;
  slug: string | null;
  name: string;
  mode: "live" | "paper" | "idle";
  ageDays: number | null;
  strategy: string | null;
  traits: string[];
  /**
   * Newest first, within the call window, in LEDGER ORDER: by the decision's
   * time, then by its trade's id, so two fills in the same second keep the
   * order the ledger wrote them in. The conductor tells same-second fills
   * apart by their place here (a sell and the re-buy after it), never by
   * their ids, which are random.
   */
  calls: CallFact[];
}

/** Six hours: the conductor announces a call only within this long of the fill. */
const CALL_WINDOW_SEC = 6 * 3600;

/**
 * NEWEST CALLS KEPT PER AGENT, in SQL. A fleet-wide LIMIT would let one busy
 * paper book fill the whole budget and leave every other agent with nothing
 * to call; a per-agent bound makes each agent's share independent of the
 * others'.
 *
 * AT LEAST WHAT ONE AGENT CAN ANNOUNCE IN THE WINDOW. The cut keeps the
 * NEWEST, but the conductor announces the OLDEST call not yet said — so a call
 * cut here is a call never said, even though it is inside the window. That is
 * exactly an agent that traded all night: its calls wait for morning. The
 * conductor's per-agent ceiling (perAgentPerHour, 30 by default) over the six
 * hours is 180 lines, so a cap of 180 cuts only calls the room could not have
 * said anyway. The scan over `decisions` costs the same either way; only a
 * hyperactive book returns more rows.
 *
 * BUT THE CONDUCTOR READS TWICE THE ANNOUNCEMENT WINDOW, and the older half is
 * not calls to announce: it is the ANCHORS a repeat is weighed against (the
 * fill behind the card a later buy of the same coin only repeats). Since the
 * read became twelve hours, a paper basket filling three coins every four
 * minutes pushed its earlier card's fill past the newest 180 within five
 * hours; a redeploy then weighed the unsaid fills again, found no card before
 * them, and posted three hours-old "bought TSLA" cards at once (2026-09-25
 * 16:53). So a call the room ALREADY POSTED is kept past the cut (callsSql,
 * `keepPosted`) — about one per coin per side per six hours, an index seek on
 * the unique dedupe key each — and the cut still bounds everything unposted.
 */
export const CALLS_PER_AGENT = 180;

/**
 * Anything that looks like an on-chain identifier — thesis-policy.ts's
 * backstop, duplicated because that module does not export it and is being
 * edited elsewhere. `rh:` because the brokerage rail's agent id embeds an
 * account number.
 */
const ADDRESSY = /\b(?:0x[0-9a-fA-F]{6,}|rh:[A-Za-z0-9-]{1,64})\b/;

/** What CallRef.token may be: a contract, for /t/<token>. The cash legs are never the coin. */
const CONTRACT = /^0x[0-9a-fA-F]{40}$/;
const CASH_LEGS: ReadonlySet<string> = new Set([CASH.USDG.toLowerCase(), CASH.WETH.toLowerCase()]);

/** A ticker as the ledger recorded it, or null when it is not one a reader could be shown. */
const SYMBOL = /^[A-Za-z0-9._-]{1,24}$/;

/** everyBand() sweeps every band function; once per process is enough, since the vocabulary is code. */
let vocab: ReadonlySet<string> | null = null;
function vocabulary(): ReadonlySet<string> {
  return (vocab ??= everyBand());
}

function holes(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/**
 * THE FLEET'S NAMES, and the last-heartbeat mode — nothing else.
 *
 * THE WHOLE TABLE, not only this replica's roster: a name is settled against
 * every agent in the room (settleRoomNames), and one that runs on another
 * replica, or is not running right now, still owns its name. `agents` is
 * fleet-sized, and this is still one statement a pass. Matched on LOWER(...)
 * in code because the ledger stores whatever case the child wrote and the
 * roster carries whatever case the grant did.
 */
export function rosterSql(): string {
  return `SELECT smart_account, name, mode FROM agents`;
}

/**
 * THE CALLS: decision first, its latest trade, its post.
 *
 * DECISION-FIRST, bounded by `d.at > ?`, so the scan rides `decisions_time`
 * and the trade is found through `trades_decision` one decision at a time —
 * `trades` is the one table nothing may add an index to. The latest trade per
 * decision because a decision can be retried; the last word on it is the
 * outcome.
 *
 * The trade must belong to the decision's own agent, and so must the post: a
 * decision id is a UUID, so a mismatch is never a coincidence, and a row that
 * disagrees about whose trade it is is dropped rather than attributed.
 *
 * `evidence_json` is selected whole because JSON access is spelled differently
 * on the two engines; only its `bands` are read, below, and only the ones in
 * the closed vocabulary. Its `raw` figures never leave this module. `reason`
 * is selected for the gate alone — a trade with nothing publishable behind it
 * is not a call — and is never returned: a model's reason may quote the
 * owner's cash.
 *
 * `keepPosted`: a row whose call the room already posted (a groupchat_messages
 * row keyed "call:<decision>") survives the per-agent cut — see
 * CALLS_PER_AGENT. Only when the room's table exists: a bare ledger has none.
 */
export function callsSql(agents: number, opts: { keepPosted?: boolean } = {}): { sql: string; fixed: string[] } {
  const actions = ["buy", "sell"];
  return {
    sql: `SELECT x.decision_id, x.agent_id, x.source, x.action, x.symbol, x.display_name, x.reason,
                 x.dropped_rule, x.hold_kind, x.evidence_json, x.at, x.status, x.buy_token, x.sell_token, x.post
            FROM (
              SELECT d.id AS decision_id, d.agent_id, d.source, d.action, d.symbol, d.display_name, d.reason,
                     d.dropped_rule, d.hold_kind, d.evidence_json, d.at,
                     t.id AS trade_id, t.status, t.buy_token, t.sell_token,
                     p.body AS post,
                     ROW_NUMBER() OVER (PARTITION BY LOWER(d.agent_id) ORDER BY d.at DESC, t.id DESC) AS rn
                FROM decisions d
                JOIN trades t ON t.id = (SELECT MAX(t2.id) FROM trades t2 WHERE t2.decision_id = d.id)
                LEFT JOIN posts p ON p.decision_id = d.id AND LOWER(p.agent_id) = LOWER(d.agent_id)
               WHERE d.at > ?
                 AND LOWER(d.agent_id) IN (${holes(agents)})
                 AND LOWER(d.agent_id) NOT LIKE 'rh:%'
                 AND LOWER(t.agent_id) = LOWER(d.agent_id)
                 AND d.action IN (${holes(actions.length)})
                 AND d.source IN (${holes(PUBLISHABLE_SOURCES.length)})
                 AND t.status IN (${holes(LANDED_STATUSES.length)})
            ) x
           WHERE x.rn <= ?${opts.keepPosted ? POSTED_CALL : ""}
           ORDER BY x.at DESC, x.trade_id DESC`,
    fixed: [...actions, ...PUBLISHABLE_SOURCES, ...LANDED_STATUSES],
  };
}

/**
 * The room's own record that a call was posted: its card's durable dedupe
 * key. A separate literal rather than one nested in callsSql's, so the source
 * scan in facts.test.ts reads it as the SELECT it is. Both engines spell `||`
 * and EXISTS alike, and `dedupe_key` is UNIQUE, so this is an index seek.
 */
const POSTED_CALL = `
              OR EXISTS (SELECT 1 FROM groupchat_messages g WHERE g.dedupe_key = 'call:' || x.decision_id)`;

/**
 * THE NAME THE ROOM USES.
 *
 * The owner's name when they chose one. The stock "Robin", an empty name, an
 * address-shaped one, or one the soul's stored-name rule would refuse becomes
 * the slug's generated name, so a room of unnamed agents is not a room of
 * Robins — the same suggestion every other screen offers for that slug.
 *
 * SO DOES A NAME THE ROOM'S OWN GATE WOULD REFUSE. The name heads every line
 * the agent writes and sits in the public presence list, and neither passes
 * through a door: "pump.fun", "vitalik.eth", "0XDEADBEEF12345678" or an
 * "sk-…"/"AKIA…" key would be a link, an address or a secret printed on every
 * bubble. And a name that reads as a figure ("Up 400x") would be shown to every
 * model as who is speaking — rule 2 is that a model is never shown one.
 * "Agent 47" is a name, not a figure, and stays.
 *
 * AND SO DOES A NAME THAT IS ANOTHER SPEAKER'S LABEL. The room tells speakers
 * apart by the name on the bubble: an owner's line is headed "<agent>'s owner"
 * and the room's own lines "merrymen". An agent named "Bob's owner", "owner",
 * "human" or "Merry Men" would post under a label that says a person, or the
 * room itself, is talking. See `impersonates`.
 *
 * WITH NO SLUG, "Robin" rather than the raw value. The generated name needs a
 * seed, and falling back to whatever the row held would put an address — maybe
 * the owner's — at the head of a public line.
 */
export function roomName(raw: unknown, slug: string | null): string {
  const name = typeof raw === "string" ? normalizeAgentName(raw) : "";
  const usable =
    name !== "" && !ADDRESSY.test(name) && STORED_AGENT_NAME_RE.test(name) && nameRefusal(name) === null && !impersonates(name);
  if (usable && name !== DEFAULT_AGENT_NAME) return name;
  return (slug ? agentNameForSlug(slug) : null) ?? DEFAULT_AGENT_NAME;
}

/** The room's own voice on system lines — conductor.ts SYSTEM_NAME, which facts.test.ts reads to keep the two equal. */
const SYSTEM_SPEAKER = "merrymen";

/** Every mark a reader takes for an apostrophe, including the modifier letters the stored-name rule admits as letters. */
const APOSTROPHE = /['‘’‛′‵＇`´ʹʻʼʽʾʿˈˊˋˮꞋꞌՙ՚׳ߴߵ]/gu;

/**
 * Combining marks drawn as an apostrophe — comma above, turned and reversed
 * comma above, comma above right, horn, koronis. Read as one BEFORE every
 * other mark is dropped: "Pine Stoat" + U+0315 + "s owner" is drawn as
 * "Pine Stoat's owner", and with the mark simply gone it read "stoats owner".
 */
const APOSTROPHE_MARK = /[̒-̛̓̕]/gu;

/**
 * Letters a reader takes for a plain Latin one that no normalisation folds:
 * Cyrillic and Greek lookalikes and the Latin small capitals. Not a general
 * confusables table — enough that "Mеrrymen" with a Cyrillic е, or "ᴏᴡɴᴇʀ",
 * reads as what it spells.
 */
const LOOKALIKE: ReadonlyMap<string, string> = new Map(
  (
    [
      ["аАαΑɑᴀ", "a"],
      ["ВΒʙ", "b"],
      ["сСϲᴄ", "c"],
      ["ԁᴅ", "d"],
      ["еЕΕᴇ", "e"],
      ["һНнΗʜ", "h"],
      ["іІΙιıɪ", "i"],
      ["јЈȷᴊ", "j"],
      ["КкΚκᴋ", "k"],
      ["ʟ", "l"],
      ["МмΜᴍ", "m"],
      ["Νηɴп", "n"],
      ["оОοΟօᴏ", "o"],
      ["рРρΡᴘ", "p"],
      ["гʀ", "r"],
      ["ѕЅꜱ", "s"],
      ["ТтΤᴛ", "t"],
      ["υսᴜ", "u"],
      ["νᴠ", "v"],
      ["ԝԜωᴡ", "w"],
      ["хХχΧ", "x"],
      ["уУүҮΥγʏ", "y"],
      ["Ζᴢ", "z"],
    ] as const
  ).flatMap(([from, to]) => Array.from(from, (ch) => [ch, to] as const)),
);

/** A name as DRAWN: apostrophe-like marks made apostrophes, every other mark and invisible gone, compatibility forms folded. Case kept. */
function drawnAs(name: string): string {
  return name
    .normalize("NFKD")
    .replace(APOSTROPHE_MARK, "'")
    .replace(/[\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .normalize("NFKC");
}

/** How a name READS: marks and invisibles gone, lookalikes folded, lower case, one kind of apostrophe, one space. */
function readsAs(name: string): string {
  let out = "";
  for (const ch of drawnAs(name)) out += LOOKALIKE.get(ch) ?? ch.toLowerCase();
  return out.replace(APOSTROPHE, "'").replace(/\s+/g, " ").trim();
}

/**
 * A NAME THAT READS AS ANOTHER SPEAKER'S LABEL: the room's system voice, a bare
 * "owner" or "human" (plural, or with "the"), or any name ending in a
 * possessive "owner"/"human" — "Bob's owner" in any case and with any
 * apostrophe, with the apostrophe dropped to a space, and with a dot, hyphen
 * or apostrophe after it. Spaces, dots, hyphens and apostrophes do not tell
 * two labels apart, so "Merry Men" and "merry-men" are the room. Digits do:
 * "Owner 2" and "Agent 47" are names.
 *
 * THE APOSTROPHE LEFT OUT ENTIRELY ("Pine Stoats owner") is the one reading a
 * real name also has — "Chris Owner", "Mrs Owner" — so it is the label only
 * when it is spelled like one: "owner"/"human" in lower case, as the label
 * writes it, or after a name of two words or more, the shape of every name the
 * room generates ("Pine Stoats Owner").
 */
function impersonates(name: string): boolean {
  const drawn = drawnAs(name);
  const reads = readsAs(name);
  const tight = reads.replace(/[\s.'-]+/g, "");
  if (tight === SYSTEM_SPEAKER || /^(?:the)?(?:owner|human)s?$/.test(tight)) return true;
  const end = reads.replace(/[\s.'-]+$/u, "");
  if (/(?:'\s*s|s\s*'|\ss)[\s.-]*(?:owner|human)s?$/.test(end)) return true;
  const bare = /^(.*\p{L})s[\s.-]*(?:owner|human)s?$/u.exec(end);
  if (!bare) return false;
  const lastWord = /(\p{L})\p{L}*[^\p{L}]*$/u.exec(drawn)?.[1] ?? "";
  return /\p{Ll}/u.test(lastWord) || bare[1]!.split(/[\s.-]+/).filter(Boolean).length >= 2;
}

// ── one name per agent ───────────────────────────────────────────────────────

/**
 * WHETHER A READER CAN TELL TWO NAMES APART: how the name reads (readsAs —
 * marks and invisibles gone, lookalikes folded, lower case) with spaces,
 * dots, hyphens and apostrophes gone too. "Pine Stoat", "Pine Stoatㅤ" (an
 * invisible Hangul filler), "PINE-STOAT" and "Pine Stoat." are one name.
 */
export function nameKey(name: string): string {
  return readsAs(name).replace(/[\s.'-]+/g, "");
}

/** A tenant whose agent holds, or may hold, a name in the room. */
export interface NameHolder {
  tenant: string;
  slug: string | null;
  /** The smart account whose `agents` row carries the agent's name, or null. */
  account: string | null;
  /** When the tenant's identity was minted — seconds or milliseconds — or null when unknown, which comes last. */
  mintedAt: number | null;
}

/**
 * THE JUDGED NAME AND ITS KEY, REMEMBERED. Judging a name reads it half a
 * dozen ways; the conductor settles the whole fleet every ~15 s on the
 * orchestrator's one thread, and a thousand agents cost ~80 ms a pass
 * unremembered. Names rarely change, so each (name, slug) is judged once.
 * Bounded: cleared whole when it outgrows any fleet.
 */
const judged = new Map<string, { name: string; key: string }>();
const JUDGED_MAX = 20_000;
function judge(raw: unknown, slug: string | null): { name: string; key: string } {
  const text = typeof raw === "string" ? raw : "";
  const memo = `${slug ?? ""}\u0000${text}`;
  let hit = judged.get(memo);
  if (!hit) {
    const name = roomName(text, slug);
    hit = { name, key: nameKey(name) };
    if (judged.size >= JUDGED_MAX) judged.clear();
    judged.set(memo, hit);
  }
  return hit;
}

/** A mint time in seconds, whichever unit was stored; unknown sorts last. */
function mintedSec(v: number | null): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return Number.POSITIVE_INFINITY;
  return v > 1_000_000_000_000 ? Math.floor(v / 1000) : v;
}

/**
 * ONE NAME PER AGENT, ACROSS THE WHOLE FLEET.
 *
 * roomName judges a name alone. An owner who renames their agent "Pine Stoat"
 * — or "Pine Stoatㅤ" — when another agent is already called that has their
 * own lines headed "Pine Stoat's owner", the other owner's label, and their
 * agent's lines read as the other agent's; with an uploaded face over the
 * slug's colours the two rows look the same, and a line naming "Pine Stoat"
 * draws both. So the name stays with the agent whose identity was minted
 * FIRST — nobody can mint theirs earlier than one that exists — and a later
 * agent whose name reads the same (nameKey) takes its slug's generated name, as
 * a refused name does. A generated name holds its place like a chosen one, and
 * a later agent's fallback is claimed too, so the settled names never meet.
 * Two generated names can still meet (the grid is finite); the later one has
 * nothing further to fall back to and keeps its own.
 *
 * THE SAME FUNCTION ON BOTH SIDES — the conductor over the fleet every pass,
 * the web's speakerOf for an owner's label — so an owner's label and their
 * agent's name never disagree about who kept it. `rawNames` is `agents.name`
 * by lowercased smart account; the answer is the room's name by lowercased
 * tenant. Ties in mint time go to the lower tenant, the same on both sides.
 */
export function settleRoomNames(holders: Iterable<NameHolder>, rawNames: ReadonlyMap<string, unknown>): Map<string, string> {
  const byTenant = new Map<string, NameHolder>();
  for (const h of holders) {
    const tenant = h.tenant.toLowerCase();
    if (!byTenant.has(tenant)) byTenant.set(tenant, { ...h, tenant });
  }
  const order = [...byTenant.values()].sort(
    (a, b) => mintedSec(a.mintedAt) - mintedSec(b.mintedAt) || (a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0),
  );
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const h of order) {
    const own = judge(h.account ? rawNames.get(h.account.toLowerCase()) : undefined, h.slug);
    const settled = taken.has(own.key) ? judge(null, h.slug) : own;
    taken.add(settled.key);
    out.set(h.tenant, settled.name);
  }
  return out;
}

function modeOf(v: unknown): AgentFacts["mode"] {
  return v === "live" || v === "paper" ? v : "idle";
}

/** Seconds, whichever unit the store wrote — the file backend and Postgres both write seconds today. */
function ageDaysOf(createdAt: number | undefined, nowSec: number): number | null {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  const sec = createdAt > 1_000_000_000_000 ? Math.floor(createdAt / 1000) : createdAt;
  return Math.max(0, Math.floor((nowSec - sec) / 86_400));
}

/** The band words of a decision's evidence that are in the closed vocabulary, deduplicated, in stored order. */
function bandsOf(evidence: unknown): string[] {
  if (typeof evidence !== "string" || evidence === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidence);
  } catch {
    return [];
  }
  const bands = (parsed as { bands?: unknown } | null)?.bands;
  if (!bands || typeof bands !== "object" || Array.isArray(bands)) return [];
  const words = vocabulary();
  const out: string[] = [];
  for (const v of Object.values(bands as Record<string, unknown>)) {
    if (typeof v === "string" && words.has(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The coin's contract on the side that moved: bought on a buy, sold on a sell. */
function tokenOf(side: "buy" | "sell", buy: unknown, sell: unknown): string | null {
  const v = side === "buy" ? buy : sell;
  if (typeof v !== "string" || !CONTRACT.test(v)) return null;
  const t = v.toLowerCase();
  return CASH_LEGS.has(t) ? null : t;
}

/**
 * The coin's own name, through the one sanitiser every surface shares.
 *
 * `kind: "memecoin"` because only a memecoin's decision ever carries a
 * display name (coinDisplayName refuses the rest at write time), so the rule
 * that would null it for a stock has already run. A name that still looks like
 * an address costs the call its name, not the call — and so does one the
 * room's gate would refuse as a link or secret, or one that reads as a figure
 * ("up 500 percent"): the deployer chose it, and it is shown to every model
 * that talks about the call.
 */
function coinNameOf(raw: unknown, symbol: string | null): string | null {
  if (typeof raw !== "string") return null;
  const clean = coinDisplayName({ symbol: symbol ?? "", name: raw, kind: "memecoin" });
  if (!clean || ADDRESSY.test(clean) || nameRefusal(clean) !== null) return null;
  return symbol && clean.toUpperCase() === symbol.toUpperCase() ? null : clean;
}

/** A minted identity as the room keeps it: its slug, when it was minted, and its smart accounts, newest first. */
interface RoomIdentity {
  slug: string;
  createdAt: number;
  accounts?: readonly string[];
}

/**
 * The identities the room knows, by lowercased tenant: at least every one of
 * `tenants` that has one, and every other the source holds — the other
 * tenants' names are settled against (settleRoomNames).
 */
type Identities = (tenants: string[]) => Promise<Map<string, RoomIdentity>>;

/** A snapshot of slugs is re-read at least this often: a removed and re-minted tenant is the one way a slug changes. */
const IDENTITY_TTL_MS = 60 * 60_000;
/** A roster tenant the store has no identity for is looked for again at most this often. */
const IDENTITY_MISS_RETRY_MS = 60_000;

/**
 * THE IDENTITY READ, CACHED. A slug and its mint time never change once minted
 * (identity-store.ts: `ensure` "MUST NOT change an existing slug"), yet the room
 * used to read the whole identity table — Privy columns and all — on every
 * ~15 s pass, over the identity store's ONE long-lived client that the main
 * loop also runs transactions on. Now: one read at start, one more whenever a
 * tenant appears that the snapshot has not seen (a new agent must be greeted by
 * its real name, so that read is immediate), and one an hour. A tenant still
 * missing after a fresh read is not looked for again for a minute, so an agent
 * with no identity costs what it always did at most once a minute rather than
 * every pass.
 *
 * Only tenant, slug, mint time and smart accounts are kept from each row —
 * the social half is dropped by the reader before it gets here. The answer is
 * the whole snapshot, the requested tenants included: every agent's name is
 * settled against the fleet's.
 */
export function cachedIdentities(
  read: () => Promise<Iterable<{ tenant: unknown; slug: unknown; createdAt: unknown; accounts?: unknown }>>,
  clock: () => number = Date.now,
): Identities {
  let snapshot: Map<string, RoomIdentity> | null = null;
  let readAt = 0;
  const missedAt = new Map<string, number>();
  return async (tenants) => {
    const want = [...new Set(tenants.map((t) => t.toLowerCase()))];
    const now = clock();
    const unseen = (k: string) => {
      if (snapshot?.has(k)) return false;
      const at = missedAt.get(k);
      return at === undefined || now - at >= IDENTITY_MISS_RETRY_MS;
    };
    if (snapshot === null || now - readAt >= IDENTITY_TTL_MS || want.some(unseen)) {
      const next = new Map<string, RoomIdentity>();
      for (const r of await read()) {
        if (typeof r.slug !== "string") continue;
        const accounts = Array.isArray(r.accounts)
          ? r.accounts.filter((a): a is string => typeof a === "string").map((a) => a.toLowerCase())
          : [];
        next.set(String(r.tenant).toLowerCase(), { slug: r.slug, createdAt: Number(r.createdAt), accounts });
      }
      snapshot = next;
      readAt = now;
      missedAt.clear();
      for (const k of want) if (!next.has(k)) missedAt.set(k, now);
    }
    return new Map(snapshot);
  };
}

/**
 * THE DEFAULT IDENTITY READ, which drops everything social on the first line.
 *
 * `all()` returns the Privy half too — handle, display name, avatar — and the
 * owner's Privy name is on the list of things that must never reach the room.
 * It is gone before anything else touches the rows, and the cache above holds
 * only what survives.
 */
const identitiesFromStore: Identities = cachedIdentities(async () =>
  (await getIdentityStore().all()).map(({ tenant, slug, createdAt, accounts }) => ({ tenant, slug, createdAt, accounts })),
);

interface CallRow {
  decision_id: unknown;
  agent_id: unknown;
  source: unknown;
  action: unknown;
  symbol: unknown;
  display_name: unknown;
  reason: unknown;
  dropped_rule: unknown;
  hold_kind: unknown;
  evidence_json: unknown;
  at: unknown;
  status: unknown;
  buy_token: unknown;
  sell_token: unknown;
  post: unknown;
}

const s = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Everything the room may know about each roster agent, keyed by the
 * LOWERCASED tenant — the key every groupchat table and the sleep window use.
 *
 * Every roster entry gets an answer, even one whose ledger row has not been
 * mirrored yet: it is running, so it is in the room, as an idle agent with no
 * calls rather than as a hole in the conductor's map.
 *
 * FAILURES PROPAGATE. A statement that breaks on Postgres must say so in the
 * conductor's log line rather than read as a quiet fleet.
 */
export async function loadFacts(
  shared: Db,
  roster: RosterEntry[],
  profiles: Map<string, ChatProfile>,
  nowSec: number,
  opts: {
    callWindowSec?: number;
    identities?: Identities;
    /**
     * The shared Db's dialect. Given, the room's tables are made if absent
     * (memoised per Db — the conductor has already done it) and a call the
     * room already posted is kept past the per-agent cut, so a repeat always
     * finds the card it repeats (CALLS_PER_AGENT). Absent — a bare ledger, as
     * facts.test.ts builds one — the cut is plain.
     */
    dialect?: "postgres" | "sqlite";
  } = {},
): Promise<Map<string, AgentFacts>> {
  const out = new Map<string, AgentFacts>();
  if (roster.length === 0) return out;

  const byAgent = new Map<string, string>();
  for (const r of roster) byAgent.set(r.agentId.toLowerCase(), r.tenant.toLowerCase());
  const agentIds = [...byAgent.keys()];
  const tenants = [...new Set(roster.map((r) => r.tenant.toLowerCase()))];

  const ids = await (opts.identities ?? identitiesFromStore)(tenants);

  const agentRows = (await shared.prepare(rosterSql()).all()) as {
    smart_account: unknown;
    name: unknown;
    mode: unknown;
  }[];
  const rowOf = new Map<string, { name: unknown; mode: unknown }>();
  for (const a of agentRows) {
    const key = String(a.smart_account ?? "").toLowerCase();
    if (!rowOf.has(key)) rowOf.set(key, { name: a.name, mode: a.mode });
  }

  const slugOf = (id: RoomIdentity | null | undefined): string | null =>
    id && typeof id.slug === "string" && SLUG_RE.test(id.slug) ? id.slug : null;
  for (const r of roster) {
    const tenant = r.tenant.toLowerCase();
    const agentId = r.agentId.toLowerCase();
    const id = ids.get(tenant) ?? null;
    const slug = slugOf(id);
    const row = rowOf.get(agentId);
    const profile = profiles.get(tenant) ?? profiles.get(r.tenant) ?? { strategy: null, traits: [] };
    out.set(tenant, {
      tenant,
      agentId: r.agentId,
      slug,
      name: roomName(row?.name, slug),
      mode: modeOf(row?.mode),
      ageDays: ageDaysOf(id?.createdAt, nowSec),
      strategy: profile.strategy,
      traits: [...profile.traits],
      calls: [],
    });
  }

  // ONE NAME PER AGENT, settled against the fleet (settleRoomNames): the
  // roster by the account it runs on, every other minted tenant by its current
  // account — the same holders the web's speakerOf settles an owner's label with.
  const holders: NameHolder[] = [];
  for (const f of out.values()) holders.push({ tenant: f.tenant, slug: f.slug, account: f.agentId, mintedAt: ids.get(f.tenant)?.createdAt ?? null });
  for (const [tenant, id] of ids) {
    const account = id.accounts?.[0];
    if (out.has(tenant.toLowerCase()) || typeof account !== "string") continue;
    holders.push({ tenant, slug: slugOf(id), account, mintedAt: id.createdAt });
  }
  const settled = settleRoomNames(holders, new Map([...rowOf].map(([k, v]) => [k, v.name])));
  for (const f of out.values()) f.name = settled.get(f.tenant) ?? f.name;

  // THE BROKERAGE RAIL NEVER EVEN REACHES THE QUERY: its id is an account number.
  const callable = agentIds.filter((a) => !a.startsWith("rh:"));
  if (callable.length === 0) return out;

  const windowSec = opts.callWindowSec ?? CALL_WINDOW_SEC;
  const keepPosted = opts.dialect !== undefined;
  if (keepPosted) await ensureGroupchatSchema(shared, opts.dialect!);
  const { sql, fixed } = callsSql(callable.length, { keepPosted });
  const rows = (await shared.prepare(sql).all(nowSec - windowSec, ...callable, ...fixed, CALLS_PER_AGENT)) as CallRow[];

  for (const row of rows) {
    const tenant = byAgent.get(String(row.agent_id ?? "").toLowerCase());
    const facts = tenant ? out.get(tenant) : undefined;
    if (!facts) continue;
    const side = row.action === "buy" || row.action === "sell" ? row.action : null;
    if (!side) continue;

    // THE PUBLICATION GATE, unchanged: a call is a thesis the public feed would
    // print as landed, or it is not a call. Size is nulled going in so no
    // figure can come out, and the name is the room's so a Robin or an
    // address-named row is not dropped for its name alone.
    const thesis = publishableThesis({
      agent_id: s(row.agent_id),
      name: facts.name,
      source: s(row.source),
      action: side,
      symbol: s(row.symbol),
      display_name: coinNameOf(row.display_name, s(row.symbol)),
      size_usdg: null,
      reason: s(row.reason),
      dropped_rule: s(row.dropped_rule),
      hold_kind: s(row.hold_kind),
      status: s(row.status),
      mode: facts.mode,
      slug: facts.slug,
      post: s(row.post),
    });
    if (!thesis || thesis.outcome !== "landed" || thesis.shadow) continue;

    const symbol = thesis.symbol && SYMBOL.test(thesis.symbol) && !/^0x/i.test(thesis.symbol) ? thesis.symbol : null;
    facts.calls.push({
      side,
      symbol,
      name: coinNameOf(row.display_name, symbol),
      token: tokenOf(side, row.buy_token, row.sell_token),
      paper: row.status === "paper",
      decisionId: String(row.decision_id),
      atSec: Number(row.at),
      bands: bandsOf(row.evidence_json),
      ownWords: thesis.post,
    });
  }
  return out;
}
