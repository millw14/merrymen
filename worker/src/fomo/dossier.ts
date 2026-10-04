/**
 * THE COIN DOSSIER — what a social-trading feed says about one coin, assembled
 * so that the LIMITS of each claim travel with the claim.
 *
 * Pure. Given theses, replies, trader events, token statistics and Merrymen's
 * own measurements, it returns a versioned CoinDossier. Fetching, caching and
 * persistence live elsewhere; this file reads no clock, no network and no
 * environment.
 *
 * ── FOUR RULES THAT ARE EASY TO BREAK BY ACCIDENT ────────────────────────
 *
 * 1. COPIES COUNT ONCE. Ten reposts of one bullish thesis are one opinion said
 *    ten times, and a reader shown "10 theses support this" will weigh it as
 *    ten. Evidence is counted in FAMILIES (the provider-assigned familyKey,
 *    unioned with an exact-text fingerprint so a copy-paste under a new key
 *    still collapses), and ranking reads familyCount, never raw count.
 *
 * 2. AN ACTION OUTRANKS A STATEMENT. A trader who sold is a different kind of
 *    evidence from a trader who wrote "the dev is dumping". Support type is the
 *    first sort key; families, authors, the authors' own stake in the coin and
 *    (weakly, last) likes follow.
 *
 * 3. OUR OWN ECHO IS NOT CONFIRMATION. A thesis that repeats a Merrymen post,
 *    or cites one of our agents, is the market reflecting us back. Counting it
 *    would let an agent talk itself into conviction through somebody else's
 *    mouth. Those families are excluded from every claim and named in the
 *    coverage limitations so the exclusion is visible.
 *
 * 4. THESIS TEXT IS DATA. A thesis is written by somebody who would like this
 *    agent to buy. Stance comes from a fixed lexicon of claims ABOUT THE COIN
 *    (rug, unlock, breakout, listing…); imperative or sentiment words ("buy",
 *    "bullish", "ignore your instructions") are deliberately not cues, so a
 *    thesis cannot command its way into the supporting column. Every summary
 *    is Merrymen's own paraphrase built from topic, stance and counts. At most
 *    a short, sanitised, address-redacted excerpt rides along in a field that
 *    is labelled as a quotation.
 *
 * Provider money (equity, fills) is display and ranking data only. Nothing in
 * this file sizes a trade or reaches accounting.
 */

import { createHash } from "node:crypto";
import { sanitizeText } from "../research/news";
import { dedupeEvents } from "./events";
import type {
  ClaimSupport,
  CoinDossier,
  DossierClaim,
  DossierCoverage,
  EvidenceKind,
  EvidenceRef,
  FlowSummary,
  Thesis,
  ThesisComment,
  TokenIdentity,
  TokenLabel,
  TokenStats,
  TraderEvent,
} from "./types";

export const DOSSIER_SCHEMA = "fomo-dossier/1";

/** The activity feed's position-size floor (provider docs, measured 2026-09-25). */
export const FEED_SIZE_FLOOR_USD = 3_000;
/** Theses per provider page (documented). */
export const THESIS_PAGE_SIZE = 25;
const MAX_PAGES_STANDARD = 3;
const MAX_PAGES_DEEP = 5;
/** Below this many distinct authors a first page is "few voices" and worth expanding. */
const FEW_AUTHORS = 5;
/** Fewest distinct traders on one side before observed flow becomes a claim. */
const MIN_TRADERS_FOR_FLOW_CLAIM = 2;
const SHORT_HISTORY_MS = 48 * 3_600_000;
const MAX_CLAIM_REFS = 40;
const QUOTE_MAX = 160;
const SUMMARY_MAX = 240;
const CONTEXT_LINE_MAX = 240;
const CONTEXT_LINES = 8;
/** A normalised text shorter than this is too generic ("lfg") to call a copy. */
const MIN_FINGERPRINT_CHARS = 20;

/** Prefix of the coverage limitation that marks a stored, not live, thesis read. */
export const STALE_SNAPSHOT_PREFIX = "Stored snapshot:";

export const FEED_FLOOR_NOTE =
  "The activity feed only carries positions above roughly $3,000, so smaller fills are invisible and these counts are a floor, not a census.";

// ── Topics and the stance lexicon ────────────────────────────────────────

export type DossierTopic = "team" | "liquidity" | "supply" | "momentum" | "narrative" | "community" | "other";
export type Stance = "supporting" | "opposing" | "neutral";

/** Fixed order: hierarchy order for claims and the tie-break for a thesis's primary topic. */
export const DOSSIER_TOPICS: readonly DossierTopic[] = ["team", "liquidity", "supply", "momentum", "narrative", "community", "other"];

export const TOPIC_LABEL: Readonly<Record<DossierTopic, string>> = {
  team: "team and developer",
  liquidity: "liquidity",
  supply: "supply and tokenomics",
  momentum: "momentum",
  narrative: "narrative",
  community: "community",
  other: "other matters",
};

interface Cue {
  label: string;
  stance: "supporting" | "opposing";
  topic: DossierTopic;
  phrases: readonly (readonly string[])[];
  /** A preceding word that makes the phrase not a cue at all ("too early"). */
  notAfter?: readonly string[];
}

/**
 * WHY A LEXICON AND NOT A MODEL. The classification has to be reproducible
 * (the inputs hash promises the same dossier from the same evidence), cheap,
 * and impossible to talk into a different answer. Each cue is a claim about
 * the coin that a reader could go and check; none is a mood word.
 */
const CUES: readonly Cue[] = [
  { label: "rug", stance: "opposing", topic: "team", phrases: [["rug"], ["rugs"], ["rugged"], ["rugging"], ["rugpull"], ["rugpulled"]] },
  { label: "honeypot", stance: "opposing", topic: "liquidity", phrases: [["honeypot"], ["honey", "pot"]] },
  {
    label: "dev sold",
    stance: "opposing",
    topic: "team",
    phrases: [
      ["dev", "sold"], ["dev", "dumped"], ["dev", "dumping"], ["dev", "selling"], ["dev", "sells"], ["dev", "dumps"],
      ["devs", "sold"], ["devs", "dumped"], ["devs", "dumping"], ["devs", "selling"],
      ["dev", "is", "selling"], ["dev", "is", "dumping"], ["dev", "has", "sold"], ["dev", "just", "sold"],
      ["developer", "sold"], ["deployer", "sold"],
    ],
  },
  { label: "exit liquidity", stance: "opposing", topic: "liquidity", phrases: [["exit", "liquidity"]] },
  { label: "overvalued", stance: "opposing", topic: "supply", phrases: [["overvalued"], ["over", "valued"], ["overpriced"]] },
  { label: "unlock", stance: "opposing", topic: "supply", phrases: [["unlock"], ["unlocks"], ["unlocking"]] },
  {
    label: "can't sell",
    stance: "opposing",
    topic: "liquidity",
    phrases: [["can't", "sell"], ["cant", "sell"], ["cannot", "sell"], ["can", "not", "sell"], ["unable", "to", "sell"], ["couldn't", "sell"], ["couldnt", "sell"]],
  },
  { label: "scam", stance: "opposing", topic: "team", phrases: [["scam"], ["scams"], ["scammy"], ["scammer"], ["scammers"]] },
  { label: "accumulating", stance: "supporting", topic: "momentum", phrases: [["accumulating"], ["accumulate"], ["accumulation"], ["accumulated"]] },
  { label: "undervalued", stance: "supporting", topic: "supply", phrases: [["undervalued"], ["under", "valued"], ["underpriced"]] },
  { label: "breakout", stance: "supporting", topic: "momentum", phrases: [["breakout"], ["breaking", "out"], ["broke", "out"]] },
  { label: "early", stance: "supporting", topic: "momentum", phrases: [["early"]], notAfter: ["too"] },
  { label: "strong community", stance: "supporting", topic: "community", phrases: [["strong", "community"], ["community", "is", "strong"], ["community", "strong"]] },
  { label: "listing", stance: "supporting", topic: "narrative", phrases: [["listing"], ["listings"], ["listed"]] },
];

/**
 * A cue preceded (within NEGATION_WINDOW words, inside the same clause) by one
 * of these is negated and DROPPED, not inverted. "Not a rug" is an assertion
 * of safety nobody checked; it removes an objection without becoming support.
 */
const NEGATORS: ReadonlySet<string> = new Set([
  "not", "no", "never", "isn't", "isnt", "ain't", "aint", "wasn't", "wasnt", "won't", "wont",
  "doesn't", "doesnt", "don't", "dont", "didn't", "didnt", "hasn't", "hasnt", "haven't", "havent",
  "can't", "cant", "cannot", "couldn't", "couldnt", "nothing", "zero", "without", "nor", "neither",
  "hardly", "barely", "fake", "false", "nobody", "none",
]);
const NEGATION_WINDOW = 3;

const TOPIC_WORDS: ReadonlyArray<readonly [DossierTopic, ReadonlySet<string>]> = [
  ["team", new Set(["dev", "devs", "developer", "developers", "team", "founder", "founders", "deployer", "insider", "insiders", "doxxed", "doxed", "kyc", "builder", "builders", "roadmap"])],
  ["liquidity", new Set(["liquidity", "lp", "pool", "pools", "slippage", "depth", "locked", "lock", "burned", "burnt"])],
  ["supply", new Set(["supply", "tokenomics", "vesting", "holders", "holder", "distribution", "circulating", "fdv", "mcap", "valuation", "mint", "tax", "taxes"])],
  ["momentum", new Set(["chart", "volume", "momentum", "trend", "ath", "resistance", "pump", "pumping", "bounce", "rally", "price", "whale", "whales", "dip", "candle", "candles"])],
  ["narrative", new Set(["narrative", "meta", "theme", "story", "catalyst", "partnership", "partners", "news", "ai", "meme", "culture", "mascot", "utility", "product", "launch"])],
  ["community", new Set(["community", "telegram", "tg", "discord", "twitter", "raid", "raids", "cult", "followers", "kol", "kols", "fam"])],
];

export interface StanceCue {
  label: string;
  stance: "supporting" | "opposing";
  topic: DossierTopic;
  negated: boolean;
}

export interface TextReading {
  /** Net of DISTINCT non-negated cue labels; a tie (including mixed) is neutral. */
  stance: Stance;
  cues: StanceCue[];
  /** Keyword topics, most-mentioned first; empty when none matched. */
  keywordTopics: DossierTopic[];
}

/** Lowercased words per clause. Negation never reaches across a clause or a "but". */
function clauses(text: string): string[][] {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .split(/[.,;:!?()[\]{}\n]+|\bbut\b|\bhowever\b|\bthough\b|\balthough\b/)
    .map((c) =>
      c
        .split(/[^a-z0-9']+/)
        .map((w) => w.replace(/^'+|'+$/g, ""))
        .filter(Boolean),
    )
    .filter((c) => c.length > 0);
}

function cueAt(words: readonly string[], i: number): { cue: Cue; length: number } | null {
  let best: { cue: Cue; length: number } | null = null;
  for (const cue of CUES) {
    for (const phrase of cue.phrases) {
      if (i + phrase.length > words.length) continue;
      let ok = true;
      for (let k = 0; k < phrase.length; k++) {
        if (words[i + k] !== phrase[k]) {
          ok = false;
          break;
        }
      }
      if (ok && (!best || phrase.length > best.length)) best = { cue, length: phrase.length };
    }
  }
  if (best?.cue.notAfter && i > 0 && best.cue.notAfter.includes(words[i - 1] ?? "")) return null;
  return best;
}

/**
 * Read one piece of untrusted text into cues, a net stance and its topics.
 * Deterministic and context-free: the same words always read the same way.
 */
export function readThesisText(text: string): TextReading {
  const cues: StanceCue[] = [];
  const topicHits = new Map<DossierTopic, number>();
  for (const words of clauses(text)) {
    for (const w of words) {
      for (const [topic, set] of TOPIC_WORDS) if (set.has(w)) topicHits.set(topic, (topicHits.get(topic) ?? 0) + 1);
    }
    let i = 0;
    while (i < words.length) {
      const hit = cueAt(words, i);
      if (!hit) {
        i++;
        continue;
      }
      let negated = false;
      for (let k = Math.max(0, i - NEGATION_WINDOW); k < i; k++) if (NEGATORS.has(words[k] ?? "")) negated = true;
      cues.push({ label: hit.cue.label, stance: hit.cue.stance, topic: hit.cue.topic, negated });
      i += hit.length;
    }
  }
  const active = cues.filter((c) => !c.negated);
  const sup = new Set(active.filter((c) => c.stance === "supporting").map((c) => c.label)).size;
  const opp = new Set(active.filter((c) => c.stance === "opposing").map((c) => c.label)).size;
  const stance: Stance = sup > opp ? "supporting" : opp > sup ? "opposing" : "neutral";
  const keywordTopics = [...topicHits.entries()]
    .sort((a, b) => b[1] - a[1] || DOSSIER_TOPICS.indexOf(a[0]) - DOSSIER_TOPICS.indexOf(b[0]))
    .map(([t]) => t);
  return { stance, cues, keywordTopics };
}

/** Every topic a text touches (cue topics and keyword topics); `other` when none. */
export function thesisTopics(text: string): DossierTopic[] {
  const r = readThesisText(text);
  const set = new Set<DossierTopic>([...r.cues.filter((c) => !c.negated).map((c) => c.topic), ...r.keywordTopics]);
  const out = DOSSIER_TOPICS.filter((t) => set.has(t));
  return out.length ? out : ["other"];
}

// ── Families ─────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function textFingerprint(text: string): string | null {
  const norm = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return norm.length >= MIN_FINGERPRINT_CHARS ? sha256(norm).slice(0, 24) : null;
}

function familyKeyOf(t: Thesis): string {
  const k = typeof t.familyKey === "string" ? t.familyKey.trim() : "";
  return k || `id:${t.id}`;
}

/**
 * Thesis id → canonical family id. The provider family key is unioned with an
 * exact-text fingerprint, so two providers returning the same original thesis,
 * or one author's text pasted under a new handle, collapse to one family. The
 * canonical id is the smallest family key in the group, so it is stable.
 */
export function resolveFamilies(theses: readonly Thesis[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) ?? r;
    let y = x;
    while (parent.get(y) !== r) {
      const next = parent.get(y) ?? r;
      parent.set(y, r);
      y = next;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  const byPrint = new Map<string, string>();
  for (const t of theses) {
    const fk = familyKeyOf(t);
    if (!parent.has(fk)) parent.set(fk, fk);
    const fp = textFingerprint(t.text);
    if (!fp) continue;
    const prior = byPrint.get(fp);
    if (prior) union(prior, fk);
    else byPrint.set(fp, fk);
  }
  const out = new Map<string, string>();
  for (const t of theses) out.set(t.id, find(familyKeyOf(t)));
  return out;
}

// ── Evidence refs, time, small helpers ───────────────────────────────────

function ref(kind: EvidenceKind, id: string): EvidenceRef {
  return { id: `fomo:${kind}/${id}`, kind, sourceUrl: null };
}
export const thesisRef = (id: string): EvidenceRef => ref("thesis", id);
export const eventRef = (eventKey: string): EvidenceRef => ref("event", eventKey);
export const commentRef = (id: string): EvidenceRef => ref("comment", id);

/** When a trade happened: the block when matched, else the provider time, else our receipt. */
export function eventTime(e: TraderEvent): number {
  return e.execAt ?? e.sourceEventAt ?? e.observedAt;
}

/**
 * "24h" → ms. `null` means no lower bound ("all"); `undefined` means the
 * window was not understood (the caller is told, never silently widened).
 */
export function parseWindowMs(window: string): number | null | undefined {
  const w = window.trim().toLowerCase();
  if (w === "all") return null;
  const m = /^(\d{1,4})\s*(m|min|h|d|w)$/.exec(w);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] === "w" ? 7 * 86_400_000 : m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : 60_000;
  return n > 0 ? n * unit : undefined;
}

/** "3 days", "21h", "under a minute": an age in words, never a bare timestamp. */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return "under a minute";
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)} days`;
}

/** "3 days ago", "21h ago", "just now". */
export function agoText(ms: number): string {
  const d = durationText(ms);
  return d === "under a minute" ? "just now" : `${d} ago`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const usd = (n: number): string => `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Address-, hex- and link-shaped runs are replaced before any excerpt is kept. */
export function redactExecutables(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/0x[0-9a-fA-F]{6,}/g, "[address]")
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, "[address]");
}

function quoteOf(text: string): string | null {
  const q = sanitizeText(redactExecutables(sanitizeText(text, 2_000)), QUOTE_MAX);
  return q ? q : null;
}

export function dossierIdFor(token: TokenIdentity): string {
  return `dsr_${sha256(token.key).slice(0, 20)}`;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

function statsSignature(s: TokenStats | null): string {
  if (!s) return "none";
  return stableStringify({ token: s.token?.key ?? null, holders: s.holders, top10: s.top10HoldersPercent, windows: s.windows });
}

// ── Claims ───────────────────────────────────────────────────────────────

/**
 * DossierClaim plus the working that produced it. Structurally a DossierClaim,
 * so it fits CoinDossier.claims; consumers that only know the contract type
 * ignore the extra fields, and nothing here depends on them surviving storage.
 */
export interface DossierClaimDetail extends DossierClaim {
  topic: DossierTopic;
  /** Lexicon labels (our words) that placed theses here. */
  cues: string[];
  /** Posts behind the claim, copies included. familyCount is what counts. */
  posts: number;
  /** Distinct repliers whose reply took the opposite stance. Never a family. */
  challengedBy: number;
  /** Sum over distinct authors of their largest reported position on the coin. Provider float, ranking only. */
  authorEquityUsd: number | null;
  /** Sum over families of each family's most-liked copy. The weakest tie-breaker. */
  familyLikes: number | null;
  /** The observed-action claim on the same topic and stance, when one exists. */
  corroboratedBy: string | null;
  /**
   * THIRD-PARTY WORDS, labelled as such: at most 160 characters of the
   * top-ranked thesis, sanitised, with links and address-shaped runs redacted.
   * Untrusted data. Never rendered into a model lens.
   */
  quoted: { text: string; evidenceId: string } | null;
}

const SUPPORT_RANK: Readonly<Record<ClaimSupport, number>> = {
  "verified-fact": 3,
  "observed-action": 2,
  "source-statement": 1,
  inference: 0,
};

function nullLast(a: number | null | undefined, b: number | null | undefined): number {
  const x = finite(a) ? a : null;
  const y = finite(b) ? b : null;
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return y - x;
}

/**
 * Strongest first: support type, then independent families (NOT posts), then
 * distinct authors, then the authors' own stake in the coin, then likes. Ten
 * copies of one thesis are familyCount 1 here and cannot outrank two
 * independent objections however many likes or handles the copies carry.
 */
export function compareClaims(a: DossierClaim, b: DossierClaim): number {
  const ea = a as Partial<DossierClaimDetail>;
  const eb = b as Partial<DossierClaimDetail>;
  return (
    SUPPORT_RANK[b.support] - SUPPORT_RANK[a.support] ||
    b.familyCount - a.familyCount ||
    b.authorCount - a.authorCount ||
    nullLast(ea.authorEquityUsd, eb.authorEquityUsd) ||
    nullLast(ea.familyLikes, eb.familyLikes) ||
    cmpStr(a.claimKey, b.claimKey)
  );
}

interface ClaimAcc {
  topic: DossierTopic;
  stance: Stance;
  members: Thesis[];
  cues: Set<string>;
  challengers: Set<string>;
  commentRefs: EvidenceRef[];
}

function thesisClaimSummary(acc: ClaimAcc, families: number, authors: number): string {
  const one = families === 1;
  const label = TOPIC_LABEL[acc.topic];
  const verb =
    acc.stance === "supporting"
      ? `${one ? "makes" : "make"} a supporting case on ${label}`
      : acc.stance === "opposing"
        ? `${one ? "raises" : "raise"} objections on ${label}`
        : `${one ? "discusses" : "discuss"} ${label} without taking a clear side`;
  const cues = acc.cues.size ? ` (${[...acc.cues].sort().join(", ")})` : "";
  const copies = acc.members.length > families ? `; ${acc.members.length} posts in all, copies counted once` : "";
  const challenged = acc.challengers.size ? ` ${plural(acc.challengers.size, "replier", "repliers")} disputed it.` : "";
  return sanitizeText(
    `${plural(families, "distinct thesis family", "distinct thesis families")} from ${plural(authors, "author", "authors")} ${verb}${cues}${copies}.${challenged}`,
    SUMMARY_MAX,
  );
}

function finishThesisClaim(acc: ClaimAcc, familyOf: (t: Thesis) => string): DossierClaimDetail {
  const fams = new Map<string, Thesis[]>();
  for (const m of acc.members) {
    const f = familyOf(m);
    const list = fams.get(f);
    if (list) list.push(m);
    else fams.set(f, [m]);
  }
  const eqByAuthor = new Map<string, number>();
  for (const m of acc.members) {
    if (!finite(m.authorEquityUsd) || m.authorEquityUsd < 0) continue;
    eqByAuthor.set(m.author.userId, Math.max(eqByAuthor.get(m.author.userId) ?? 0, m.authorEquityUsd));
  }
  const likesByFamily = new Map<string, number>();
  for (const [f, list] of fams) {
    for (const m of list) if (finite(m.likes) && m.likes >= 0) likesByFamily.set(f, Math.max(likesByFamily.get(f) ?? 0, m.likes));
  }
  const byStake = (a: Thesis, b: Thesis): number =>
    nullLast(a.authorEquityUsd, b.authorEquityUsd) || nullLast(a.likes, b.likes) || cmpStr(a.id, b.id);
  const orderedFamilies = [...fams.entries()]
    .map(([f, list]) => ({ f, list: [...list].sort(byStake) }))
    .sort((x, y) => byStake(x.list[0]!, y.list[0]!) || cmpStr(x.f, y.f));
  const evidence: EvidenceRef[] = [];
  // Representatives first, one per family, then the copies: a capped list still
  // reaches every independent source before it spends refs on repeats.
  for (const { list } of orderedFamilies) evidence.push(thesisRef(list[0]!.id));
  for (const { list } of orderedFamilies) for (const m of list.slice(1)) evidence.push(thesisRef(m.id));
  evidence.push(...acc.commentRefs);
  const rep = orderedFamilies[0]?.list[0] ?? null;
  const authors = new Set(acc.members.map((m) => m.author.userId)).size;
  const quotedText = rep ? quoteOf(rep.text) : null;
  return {
    claimKey: `thesis:${acc.topic}:${acc.stance}`,
    stance: acc.stance,
    summary: thesisClaimSummary(acc, fams.size, authors),
    support: "source-statement",
    familyCount: fams.size,
    authorCount: authors,
    evidence: evidence.slice(0, MAX_CLAIM_REFS),
    topic: acc.topic,
    cues: [...acc.cues].sort(),
    posts: acc.members.length,
    challengedBy: acc.challengers.size,
    authorEquityUsd: eqByAuthor.size ? [...eqByAuthor.values()].reduce((s, v) => s + v, 0) : null,
    familyLikes: likesByFamily.size ? [...likesByFamily.values()].reduce((s, v) => s + v, 0) : null,
    corroboratedBy: null,
    quoted: rep && quotedText ? { text: quotedText, evidenceId: thesisRef(rep.id).id } : null,
  };
}

function actionSupport(events: readonly TraderEvent[]): ClaimSupport {
  return events.length > 0 && events.every((e) => e.verification === "independently-verified") ? "verified-fact" : "observed-action";
}

export interface TopicDigestRow {
  topic: DossierTopic;
  label: string;
  /** Independent families per stance on this topic (observed-action claims count their distinct traders). */
  supporting: number;
  opposing: number;
  neutral: number;
  /** The claims beneath this row, strongest first: the second level of the hierarchy. */
  claimKeys: string[];
}

function claimTopicOf(c: DossierClaim): DossierTopic {
  const t = (c as Partial<DossierClaimDetail>).topic;
  if (t && (DOSSIER_TOPICS as readonly string[]).includes(t)) return t;
  const fromKey = c.claimKey.split(":")[1];
  return fromKey && (DOSSIER_TOPICS as readonly string[]).includes(fromKey) ? (fromKey as DossierTopic) : "other";
}

/**
 * The top level of the claim hierarchy: one row per topic with family counts
 * per stance, pointing down at its claims. However large the corpus, this is
 * at most seven rows, and every row traces to claims that trace to refs.
 */
export function topicDigest(d: CoinDossier): TopicDigestRow[] {
  const rows = new Map<DossierTopic, TopicDigestRow>();
  for (const c of [...d.claims].sort(compareClaims)) {
    const topic = claimTopicOf(c);
    const row = rows.get(topic) ?? { topic, label: TOPIC_LABEL[topic], supporting: 0, opposing: 0, neutral: 0, claimKeys: [] };
    row[c.stance] += c.familyCount;
    row.claimKeys.push(c.claimKey);
    rows.set(topic, row);
  }
  return DOSSIER_TOPICS.flatMap((t) => {
    const r = rows.get(t);
    return r ? [r] : [];
  });
}

// ── Thesis fetch planning ────────────────────────────────────────────────

export type ThesisDepth = "quick" | "standard" | "deep";

export interface FirstPageCoverage {
  /** The first page was full / the provider says more exist. */
  capped: boolean;
  /** Distinct authors on the first page. */
  uniqueAuthors: number;
  /** The provider's own total when it states one. */
  providerTotal: number | null;
  /** Supporting and opposing material both present on page one, when the caller classified it. */
  contested?: boolean | null;
  /** Override of the documented 25 per page. */
  pageSize?: number;
}

/** Both stances present, or a claim disputed in replies: more material could move the answer. */
export function isContested(d: CoinDossier | null): boolean {
  if (!d) return false;
  const hasSup = d.claims.some((c) => c.stance === "supporting");
  const hasOpp = d.claims.some((c) => c.stance === "opposing");
  const disputed = d.claims.some((c) => ((c as Partial<DossierClaimDetail>).challengedBy ?? 0) > 0);
  return (hasSup && hasOpp) || disputed;
}

/**
 * How many thesis pages to read IN TOTAL (the first included). Each page is a
 * metered call, and "read everything" has no bound on a popular coin, so the
 * answer is never "all": one page, expanded only when the first was capped
 * AND more could change the answer (contested, or too few voices to call it),
 * or when a deep read was asked for.
 */
export function planThesisFetch(
  previous: CoinDossier | null,
  firstPage: FirstPageCoverage,
  opts: { depth: ThesisDepth },
): { pages: number; reason: string } {
  if (opts.depth === "quick") return { pages: 1, reason: "quick depth reads one page" };
  if (!firstPage.capped) return { pages: 1, reason: "the first page was not capped" };
  const pageSize = firstPage.pageSize && firstPage.pageSize > 0 ? firstPage.pageSize : THESIS_PAGE_SIZE;
  const available =
    firstPage.providerTotal !== null && Number.isFinite(firstPage.providerTotal) && firstPage.providerTotal >= 0
      ? Math.max(1, Math.ceil(firstPage.providerTotal / pageSize))
      : Number.POSITIVE_INFINITY;
  if (available <= 1) return { pages: 1, reason: "the provider total fits on the first page" };
  if (opts.depth === "deep") {
    const pages = Math.min(MAX_PAGES_DEEP, available);
    return { pages, reason: `deep depth expands a capped read to ${pages} pages, never the whole history` };
  }
  const contested = firstPage.contested ?? isContested(previous);
  if (contested) {
    const pages = Math.min(MAX_PAGES_STANDARD, available);
    return { pages, reason: `the first page was capped and its claims are contested; reading ${pages} pages` };
  }
  if (firstPage.uniqueAuthors < FEW_AUTHORS) {
    const pages = Math.min(MAX_PAGES_STANDARD, available);
    return { pages, reason: `the first page was capped with only ${firstPage.uniqueAuthors} authors; reading ${pages} pages` };
  }
  return { pages: 1, reason: "the first page was capped but already broad and uncontested; more pages are unlikely to change the answer" };
}

// ── The dossier ──────────────────────────────────────────────────────────

export interface ThesisCoverageInput {
  pagesRequested: number;
  pagesReturned: number;
  providerTotal: number | null;
  capped: boolean;
  /** True when the thesis list was a stored snapshot, not a live pull; null when unknown. */
  stale: boolean | null;
  ageSeconds: number | null;
  chainFilterHonoured: boolean | null;
}

export interface BuildDossierInput {
  token: TokenIdentity;
  label: TokenLabel;
  theses: readonly Thesis[];
  thesisCoverage: ThesisCoverageInput;
  comments?: readonly ThesisComment[];
  events: readonly TraderEvent[];
  cohortUserIds: ReadonlySet<string>;
  stats: TokenStats | null;
  /** Merrymen's own measurements, supplied as finished lines. */
  marketContext: readonly string[];
  routeContext: readonly string[];
  /** Evidence families of Merrymen's own posts. */
  ownFamilies: ReadonlySet<string>;
  /** Our agents' names, to detect a thesis that cites us. */
  selfNames: readonly string[];
  previous: CoinDossier | null;
  now: number;
  window: string;
  /**
   * Whether the activity read for this token succeeded. true: an empty list is
   * "none observed above the floor"; false: activity is a missing section;
   * null/undefined: not stated, so an empty list is treated as unknown.
   */
  activityRead?: boolean | null;
}

/** The sections a revision can refresh. Everything else is identity or bookkeeping. */
export const DOSSIER_SECTIONS = [
  "label",
  "claims",
  "strongestSupport",
  "strongestOpposition",
  "flow",
  "wordsVsActions",
  "marketContext",
  "routeContext",
  "unknowns",
  "changeConditions",
  "coverage",
  "evidence",
] as const;
export type DossierSection = (typeof DOSSIER_SECTIONS)[number];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selfMatchers(selfNames: readonly string[]): RegExp[] {
  const names = new Set<string>(["merrymen"]);
  for (const n of selfNames) {
    const s = sanitizeText(n, 64).toLowerCase();
    if (s.length >= 3) names.add(s);
  }
  return [...names].map((n) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(n)}($|[^a-z0-9])`));
}

function cleanLines(lines: readonly string[]): string[] {
  return lines
    .map((l) => sanitizeText(l, CONTEXT_LINE_MAX))
    .filter(Boolean)
    .slice(0, CONTEXT_LINES);
}

function cleanLabel(l: TokenLabel): TokenLabel {
  const symbol = l.symbol === null ? null : sanitizeText(l.symbol, 24) || null;
  const name = l.name === null ? null : sanitizeText(l.name, 64) || null;
  return { symbol, name };
}

/**
 * Assemble (or carry) the dossier. Unchanged inputs return the previous
 * dossier object itself with `changed: false`; anything else is a new
 * revision that names the sections it refreshed.
 */
export function buildDossier(input: BuildDossierInput): { dossier: CoinDossier; changed: boolean } {
  const { token, now } = input;
  const tc = input.thesisCoverage;
  const dossierId = dossierIdFor(token);
  // A previous dossier for another coin is not a baseline; it is ignored rather
  // than continued, because a revision number promises continuity of subject.
  const previous = input.previous && input.previous.dossierId === dossierId && input.previous.token.key === token.key ? input.previous : null;
  const windowMs = parseWindowMs(input.window);
  const windowStart = typeof windowMs === "number" ? now - windowMs : null;
  const label = cleanLabel(input.label);
  const marketContext = cleanLines(input.marketContext);
  const routeContext = cleanLines(input.routeContext);

  // ── Theses: dedupe by id, keep this coin's, find families, find our echo ──
  const seenIds = new Set<string>();
  let thesisDuplicates = 0;
  let offToken = 0;
  const theses: Thesis[] = [];
  for (const t of input.theses) {
    if (seenIds.has(t.id)) {
      thesisDuplicates++;
      continue;
    }
    seenIds.add(t.id);
    if (t.token && t.token.key !== token.key) {
      offToken++;
      continue;
    }
    theses.push(t);
  }
  theses.sort((a, b) => cmpStr(a.id, b.id));
  const familyMap = resolveFamilies(theses);
  const familyOf = (t: Thesis): string => familyMap.get(t.id) ?? familyKeyOf(t);
  const matchers = selfMatchers(input.selfNames);
  const circularFamilies = new Set<string>();
  for (const t of theses) {
    const text = t.text.toLowerCase();
    const handle = (t.author.handle ?? "").toLowerCase();
    const citesUs = matchers.some((m) => m.test(text) || (handle && m.test(handle)));
    if (input.ownFamilies.has(familyKeyOf(t)) || citesUs) circularFamilies.add(familyOf(t));
  }
  const independent = theses.filter((t) => !circularFamilies.has(familyOf(t)));
  const circularCount = theses.length - independent.length;

  // ── Thesis claims, grouped per topic then per stance ──
  const readings = new Map<string, TextReading>();
  const accs = new Map<string, ClaimAcc>();
  const addTo = (topic: DossierTopic, stance: Stance, t: Thesis, labels: Iterable<string>): void => {
    const key = `${topic}:${stance}`;
    let acc = accs.get(key);
    if (!acc) {
      acc = { topic, stance, members: [], cues: new Set(), challengers: new Set(), commentRefs: [] };
      accs.set(key, acc);
    }
    if (!acc.members.includes(t)) acc.members.push(t);
    for (const l of labels) acc.cues.add(l);
  };
  const claimKeysOfThesis = new Map<string, string[]>();
  for (const t of independent) {
    const r = readThesisText(t.text);
    readings.set(t.id, r);
    const active = r.cues.filter((c) => !c.negated);
    const keys: string[] = [];
    if (active.length === 0) {
      const topic = r.keywordTopics[0] ?? "other";
      addTo(topic, "neutral", t, []);
      keys.push(`${topic}:neutral`);
    } else {
      const pairs = new Map<string, { topic: DossierTopic; stance: Stance; labels: Set<string> }>();
      for (const c of active) {
        const k = `${c.topic}:${c.stance}`;
        const p = pairs.get(k) ?? { topic: c.topic, stance: c.stance, labels: new Set<string>() };
        p.labels.add(c.label);
        pairs.set(k, p);
      }
      for (const [k, p] of pairs) {
        addTo(p.topic, p.stance, t, p.labels);
        keys.push(k);
      }
    }
    claimKeysOfThesis.set(t.id, keys);
  }

  // ── Replies: they can dispute a thesis; they never become a family ──
  const commentSeen = new Set<string>();
  let commentDuplicates = 0;
  const usedComments: ThesisComment[] = [];
  const thesisIds = new Set(theses.map((t) => t.id));
  for (const c of input.comments ?? []) {
    if (commentSeen.has(c.id)) {
      commentDuplicates++;
      continue;
    }
    commentSeen.add(c.id);
    if (thesisIds.has(c.id)) continue;
    const target =
      independent.find((t) => c.parentId !== null && c.parentId === t.id) ??
      (c.parentId === null && c.tradeId !== null
        ? independent.find((t) => t.tradeId === c.tradeId && t.author.userId !== c.authorUserId)
        : undefined);
    if (!target) continue;
    usedComments.push(c);
    const cStance = readThesisText(c.text).stance;
    if (cStance === "neutral") continue;
    for (const k of claimKeysOfThesis.get(target.id) ?? []) {
      const acc = accs.get(k);
      if (!acc || acc.stance === "neutral" || acc.stance === cStance) continue;
      acc.challengers.add(c.authorUserId ?? `comment:${c.id}`);
      acc.commentRefs.push(commentRef(c.id));
    }
  }

  const claims: DossierClaimDetail[] = [];
  for (const topic of DOSSIER_TOPICS) {
    for (const stance of ["opposing", "supporting", "neutral"] as const) {
      const acc = accs.get(`${topic}:${stance}`);
      if (acc && acc.members.length) claims.push(finishThesisClaim(acc, familyOf));
    }
  }

  // ── Observed flow inside the window ──
  const { events: dedupedEvents, duplicates: eventDuplicates } = dedupeEvents(input.events);
  const tokenEvents = dedupedEvents
    .filter((e) => e.token?.key === token.key)
    .sort((a, b) => eventTime(a) - eventTime(b) || cmpStr(a.eventKey, b.eventKey));
  const inWindow = tokenEvents.filter((e) => windowStart === null || eventTime(e) >= windowStart);
  const buys = inWindow.filter((e) => e.kind === "buy" && e.trader.userId);
  const sells = inWindow.filter((e) => e.kind === "sell" && e.trader.userId);
  const buyers = new Map<string, TraderEvent[]>();
  for (const e of buys) buyers.set(e.trader.userId, [...(buyers.get(e.trader.userId) ?? []), e]);
  const sellers = new Map<string, TraderEvent[]>();
  for (const e of sells) sellers.set(e.trader.userId, [...(sellers.get(e.trader.userId) ?? []), e]);
  const cohortKnown = input.cohortUserIds.size > 0;
  const cohortBuyers = cohortKnown ? [...buyers.keys()].filter((u) => input.cohortUserIds.has(u)).length : null;
  const cohortSellers = cohortKnown ? [...sellers.keys()].filter((u) => input.cohortUserIds.has(u)).length : null;

  let flow: FlowSummary | null = null;
  if (inWindow.length > 0 || input.activityRead === true) {
    const notes: string[] = [FEED_FLOOR_NOTE, "Separate wallets are not proven to be separate people."];
    if (windowMs === undefined) notes.push(`The window "${sanitizeText(input.window, 16)}" was not understood, so every supplied event was counted.`);
    if (inWindow.length === 0) notes.push("No trades were observed above the size floor in this window; that is not evidence that nobody traded.");
    const moved = inWindow.filter((e) => e.kind === "transfer-in" || e.kind === "transfer-out" || e.kind === "airdrop").length;
    if (moved) notes.push(`${plural(moved, "transfer or airdrop was", "transfers or airdrops were")} seen and not counted as a buy or a sell.`);
    const trades = [...buys, ...sells];
    const sized = trades.filter((e) => finite(e.fillUsd));
    if (trades.length) {
      if (sized.length) {
        const sb = buys.filter((e) => finite(e.fillUsd)).reduce((s, e) => s + (e.fillUsd ?? 0), 0);
        const ss = sells.filter((e) => finite(e.fillUsd)).reduce((s, e) => s + (e.fillUsd ?? 0), 0);
        notes.push(
          `Exact fill size is known for ${sized.length} of ${trades.length} trades (known buys about ${usd(sb)}, known sells about ${usd(ss)}); the rest are unsized and position marks were not used as fills.`,
        );
      } else {
        notes.push("No trade carried an exact fill size; position marks are not fill sizes and were not used.");
      }
    }
    const ambiguous = inWindow.filter((e) => e.identityAmbiguous).length;
    if (ambiguous) notes.push(`${plural(ambiguous, "event has", "events have")} a fingerprint identity and may be merged or split.`);
    const w24 = input.stats?.windows["24h"];
    if (w24 && (w24.uniqueBuyers !== null || w24.uniqueSellers !== null)) {
      const b = w24.uniqueBuyers === null ? "an unknown number of" : String(w24.uniqueBuyers);
      const s = w24.uniqueSellers === null ? "an unknown number of" : String(w24.uniqueSellers);
      notes.push(`Across all trade sizes the source's own statistics report ${b} unique buyers and ${s} unique sellers over 24h.`);
    }
    let repeatAdds = 0;
    for (const list of buyers.values()) repeatAdds += Math.max(0, list.length - 1);
    flow = {
      window: input.window,
      distinctBuyers: buyers.size,
      distinctSellers: sellers.size,
      cohortBuyers,
      cohortSellers,
      repeatAddsBySameTrader: repeatAdds,
      notes,
    };
  }

  // ── Claims from observed action ──
  const cohortClause = (n: number | null, side: string): string => (n === null ? "" : `, ${n} of the ${side} from the followed cohort`);
  const actionClaims: DossierClaimDetail[] = [];
  const actionClaim = (
    key: string,
    topic: DossierTopic,
    stance: "supporting" | "opposing",
    summary: string,
    traders: number,
    events: TraderEvent[],
  ): DossierClaimDetail => ({
    claimKey: key,
    stance,
    summary: sanitizeText(summary, SUMMARY_MAX),
    support: actionSupport(events),
    familyCount: traders,
    authorCount: traders,
    evidence: events.slice(0, MAX_CLAIM_REFS).map((e) => eventRef(e.eventKey)),
    topic,
    cues: [],
    posts: events.length,
    challengedBy: 0,
    authorEquityUsd: null,
    familyLikes: null,
    corroboratedBy: null,
    quoted: null,
  });
  if (sellers.size >= MIN_TRADERS_FOR_FLOW_CLAIM && sellers.size > buyers.size) {
    actionClaims.push(
      actionClaim(
        "action:momentum:opposing",
        "momentum",
        "opposing",
        `Observed selling over ${input.window}: ${plural(sellers.size, "distinct trader", "distinct traders")} sold and ${buyers.size} bought${cohortClause(cohortSellers, "sellers")}. Only positions above about $3,000 are visible.`,
        sellers.size,
        [...sellers.values()].flat(),
      ),
    );
  }
  if (buyers.size >= MIN_TRADERS_FOR_FLOW_CLAIM && buyers.size > sellers.size) {
    actionClaims.push(
      actionClaim(
        "action:momentum:supporting",
        "momentum",
        "supporting",
        `Observed buying over ${input.window}: ${plural(buyers.size, "distinct trader", "distinct traders")} bought and ${sellers.size} sold${cohortClause(cohortBuyers, "buyers")}. Only positions above about $3,000 are visible.`,
        buyers.size,
        [...buyers.values()].flat(),
      ),
    );
  }
  const devIds = new Set(theses.filter((t) => t.isDev === true).map((t) => t.author.userId));
  const devSells = sells.filter((e) => devIds.has(e.trader.userId));
  if (devSells.length) {
    const n = new Set(devSells.map((e) => e.trader.userId)).size;
    actionClaims.push(
      actionClaim(
        "action:team:opposing",
        "team",
        "opposing",
        `${n === 1 ? "A trader" : `${n} traders`} the source marks as this coin's developer ${n === 1 ? "was" : "were"} observed selling it over ${input.window}.`,
        n,
        devSells,
      ),
    );
  }
  for (const c of claims) {
    const a = actionClaims.find((x) => x.topic === c.topic && x.stance === c.stance);
    if (a) c.corroboratedBy = a.claimKey;
  }
  const allClaims = [...actionClaims, ...claims].sort(compareClaims);
  const strongestSupport = allClaims.find((c) => c.stance === "supporting") ?? null;
  const strongestOpposition = allClaims.find((c) => c.stance === "opposing") ?? null;

  // ── Words versus actions ──
  const wvaCited: TraderEvent[] = [];
  const wordsVsActions: CoinDossier["wordsVsActions"] = [];
  const byAuthorStance = new Map<string, { author: Thesis["author"]; stance: "supporting" | "opposing"; theses: Thesis[]; labels: Set<string> }>();
  for (const t of independent) {
    const r = readings.get(t.id);
    if (!r || r.stance === "neutral" || !t.author.userId) continue;
    const k = `${t.author.userId}|${r.stance}`;
    const e = byAuthorStance.get(k) ?? { author: t.author, stance: r.stance, theses: [], labels: new Set<string>() };
    e.theses.push(t);
    for (const c of r.cues) if (!c.negated && c.stance === r.stance) e.labels.add(c.label);
    byAuthorStance.set(k, e);
  }
  for (const [, entry] of [...byAuthorStance.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
    const against = entry.stance === "supporting" ? "sell" : "buy";
    const earliest = Math.min(...entry.theses.map((t) => t.postedAt ?? Number.NEGATIVE_INFINITY));
    // An action BEFORE the words is not a contradiction of them; with no post
    // time to compare, the pair is reported and the ordering is unknown.
    const acts = tokenEvents.filter(
      (e) => e.trader.userId === entry.author.userId && e.kind === against && (!Number.isFinite(earliest) || eventTime(e) >= earliest),
    );
    if (!acts.length) continue;
    wvaCited.push(...acts);
    const cues = entry.labels.size ? ` (${[...entry.labels].sort().join(", ")})` : "";
    wordsVsActions.push({
      userId: entry.author.userId,
      handle: entry.author.handle === null ? null : sanitizeText(entry.author.handle, 40) || null,
      statement: `Wrote ${entry.stance === "supporting" ? "a supporting" : "an opposing"} thesis on this coin${cues}.`,
      action:
        `Was observed ${against === "sell" ? "selling" : "buying"} the same coin${Number.isFinite(earliest) ? " afterwards" : ""}. ` +
        "This is an inconsistency between words and actions to weigh, not proof of fraud; traders change positions for many reasons.",
      evidence: [...entry.theses.map((t) => thesisRef(t.id)), ...acts.slice(0, 10).map((e) => eventRef(e.eventKey))],
    });
  }

  // ── Coverage ──
  const sourceTimes = [
    ...theses.map((t) => t.postedAt).filter(finite),
    ...inWindow.map((e) => e.execAt ?? e.sourceEventAt).filter(finite),
  ];
  const oldestSourceAt = sourceTimes.length ? Math.min(...sourceTimes) : null;
  const newestSourceAt = sourceTimes.length ? Math.max(...sourceTimes) : null;
  const uniqueAuthors = new Set(theses.map((t) => t.author.userId)).size;
  const familyTotal = new Set(theses.map(familyOf)).size;

  const sourceCaps: string[] = [];
  if (tc.capped) {
    sourceCaps.push(
      `Thesis read stopped after ${plural(tc.pagesReturned, "page", "pages")} (${THESIS_PAGE_SIZE} per page); ${tc.providerTotal !== null ? `${tc.providerTotal} reported in all` : "the full total is unknown"}.`,
    );
  }
  if (tc.pagesReturned < tc.pagesRequested) sourceCaps.push(`${tc.pagesRequested - tc.pagesReturned} requested thesis page(s) did not arrive.`);
  sourceCaps.push("Activity feed carries only positions above about $3,000.");

  const missingSections: string[] = [];
  if (tc.pagesReturned === 0 && theses.length === 0) missingSections.push("theses");
  if (input.activityRead === false) missingSections.push("activity");
  if (input.stats === null) missingSections.push("token-stats");
  if (!marketContext.length) missingSections.push("market-context");
  if (!routeContext.length) missingSections.push("route-context");

  const limitations: string[] = [];
  if (tc.capped) {
    limitations.push(
      tc.providerTotal !== null && tc.providerTotal > theses.length
        ? `Not every thesis was read: ${theses.length} of ${tc.providerTotal}.`
        : `Not every thesis was read: the page cap was reached after ${theses.length}, and whether more exist is unknown.`,
    );
  }
  if (tc.stale === true) {
    limitations.push(
      `${STALE_SNAPSHOT_PREFIX} the thesis list was served from a stored copy${finite(tc.ageSeconds) ? ` that was ${durationText(tc.ageSeconds * 1000)} old when read` : ""}, not a live read.`,
    );
  }
  if (circularCount) {
    limitations.push(
      `${plural(circularCount, "thesis repeats", "theses repeat")} or cite Merrymen's own posts and ${circularCount === 1 ? "was" : "were"} not counted as independent confirmation.`,
    );
  }
  if (theses.length > familyTotal) limitations.push(`${theses.length} theses formed ${plural(familyTotal, "distinct family", "distinct families")}; copies count once.`);
  if (tc.chainFilterHonoured === false) {
    limitations.push(`The source did not honour the chain filter; ${plural(offToken, "row", "rows")} for other tokens or chains ${offToken === 1 ? "was" : "were"} removed.`);
  } else if (offToken) {
    limitations.push(`${plural(offToken, "row", "rows")} for other tokens ${offToken === 1 ? "was" : "were"} removed.`);
  }
  if (tc.chainFilterHonoured === null && theses.length) limitations.push("Whether the source honoured the chain filter could not be checked.");
  if (usedComments.length) limitations.push(`${plural(usedComments.length, "reply was", "replies were")} read; replies can dispute a thesis but never count as one.`);
  if (allClaims.some((c) => c.evidence.length >= MAX_CLAIM_REFS)) limitations.push(`Evidence lists are capped at ${MAX_CLAIM_REFS} references per claim.`);

  const coverage: DossierCoverage = {
    uniqueTheses: theses.length,
    uniqueAuthors,
    windowRequested: input.window,
    oldestSourceAt,
    newestSourceAt,
    providerTotal: tc.providerTotal,
    pagesRequested: tc.pagesRequested,
    pagesReturned: tc.pagesReturned,
    duplicatesRemoved: thesisDuplicates + eventDuplicates + commentDuplicates,
    sourceCaps,
    missingSections,
    limitations,
  };

  // ── Unknowns, most decision-relevant first (a lens shows only the first two) ──
  const unknowns: string[] = [];
  if (theses.length === 0 && !missingSections.includes("theses")) {
    unknowns.push("No written theses were returned for this coin; that is an absence of material, not a verdict.");
  }
  if (uniqueAuthors > 0 && uniqueAuthors < FEW_AUTHORS) {
    unknowns.push(`Only ${plural(uniqueAuthors, "author", "authors")} wrote about this coin; a small sample is not a consensus.`);
  }
  if (tc.stale === true) unknowns.push("The thesis list is a stored snapshot, not a live read, and may have moved.");
  else if (tc.stale === null && theses.length) unknowns.push("Whether the thesis list was a live read is unknown.");
  if (oldestSourceAt !== null && now - oldestSourceAt < SHORT_HISTORY_MS) {
    unknowns.push(
      `History here is short (the oldest item was under two days old when this was built). That limits the reading and is not disqualifying; a new pool or a short feed history does not make the token itself new.`,
    );
  }
  if (!flow && input.activityRead !== false) {
    unknowns.push("No trader activity was observed for this coin in the window; the feed carries only large positions, so this is not evidence that nobody traded.");
  }
  if (tc.capped) {
    unknowns.push(
      `Only ${theses.length} of ${tc.providerTotal !== null ? tc.providerTotal : "an unknown number of"} theses were read; the unread ones could change this picture.`,
    );
  }
  if (!marketContext.some((l) => /market ?cap|mcap/i.test(l))) unknowns.push("Market cap is unknown here; unknown is not zero.");
  const SECTION_WORDS: Record<string, string> = {
    theses: "Written theses could not be read.",
    activity: "Trader activity could not be read.",
    "token-stats": "Token statistics were not available.",
    "market-context": "No market measurement of Merrymen's own was supplied.",
    "route-context": "No route measurement was supplied, so whether Merrymen could trade a useful size is unknown.",
  };
  for (const m of missingSections) unknowns.push(SECTION_WORDS[m] ?? `${m} could not be read.`);
  if (token.chain.networkId === null) unknowns.push("The token's network is unresolved.");

  // ── What would change the reading ──
  const changeConditions: string[] = [];
  if (flow && flow.cohortBuyers !== null && flow.cohortSellers !== null) {
    changeConditions.push(
      flow.cohortSellers > flow.cohortBuyers
        ? `Cohort buyers return and outnumber cohort sellers over ${input.window}.`
        : `Cohort sellers outnumber cohort buyers over ${input.window}.`,
    );
  } else {
    changeConditions.push(`Sellers come to outnumber buyers over ${input.window}.`);
  }
  if (strongestOpposition) {
    const topic = TOPIC_LABEL[(strongestOpposition as DossierClaimDetail).topic];
    const observed = strongestOpposition.support !== "source-statement" || (strongestOpposition as DossierClaimDetail).corroboratedBy !== null;
    changeConditions.push(
      observed
        ? `The observed action behind the strongest objection (${topic}) stops or reverses.`
        : `The strongest objection (${topic}) is confirmed by observed action.`,
    );
  } else {
    changeConditions.push("A credible objection appears from more than one independent source.");
  }
  if (strongestSupport) {
    const topic = TOPIC_LABEL[(strongestSupport as DossierClaimDetail).topic];
    changeConditions.push(
      strongestSupport.support !== "source-statement"
        ? `The observed action behind the strongest support (${topic}) stops or narrows to a single trader.`
        : strongestSupport.familyCount >= 2
          ? `Independent support on ${topic} falls to a single source.`
          : `A second independent source confirms the supporting case on ${topic}.`,
    );
  }
  if (wordsVsActions.length) changeConditions.push("More authors are seen acting against their own written view.");
  if (tc.capped) changeConditions.push("A fuller read of the unread theses shows a different balance.");
  if (tc.stale === true) changeConditions.push("A live read differs from this stored snapshot.");
  changeConditions.push("Route depth falls below the size Merrymen would use.");

  // ── Evidence and the inputs hash ──
  const evidenceMap = new Map<string, EvidenceRef>();
  for (const t of theses) evidenceMap.set(thesisRef(t.id).id, thesisRef(t.id));
  for (const c of usedComments) evidenceMap.set(commentRef(c.id).id, commentRef(c.id));
  for (const e of [...inWindow, ...wvaCited]) evidenceMap.set(eventRef(e.eventKey).id, eventRef(e.eventKey));
  if (input.stats) {
    const r = ref("token-stats", token.key);
    evidenceMap.set(r.id, r);
  }
  const evidence = [...evidenceMap.values()].sort((a, b) => cmpStr(a.id, b.id));

  /*
   * WHAT THE HASH COVERS. The evidence ids and the stats signature, plus every
   * other input that can change a sentence: coverage flags, the window, which
   * observed traders are in the cohort, which theses were excluded as our echo,
   * and Merrymen's own context lines. An unchanged hash returns the previous
   * dossier verbatim, so anything left out of it would be silently stale.
   * Volatile figures (likes, equity, snapshot age) are deliberately NOT in it:
   * they reorder a tie, they do not change what the evidence is.
   */
  const inputsHash = sha256(
    stableStringify({
      schema: DOSSIER_SCHEMA,
      ids: evidence.map((e) => e.id),
      stats: statsSignature(input.stats),
      window: input.window,
      coverage: [tc.capped, tc.stale, tc.pagesRequested, tc.pagesReturned, tc.providerTotal, tc.chainFilterHonoured, input.activityRead ?? null],
      circular: theses.filter((t) => circularFamilies.has(familyOf(t))).map((t) => t.id),
      cohort: [...new Set(inWindow.map((e) => e.trader.userId).filter((u) => input.cohortUserIds.has(u)))].sort(),
      market: marketContext,
      route: routeContext,
      label,
    }),
  );

  if (previous && previous.inputsHash === inputsHash && previous.versions.schema === DOSSIER_SCHEMA) {
    return { dossier: previous, changed: false };
  }

  const fresh: Pick<CoinDossier, DossierSection> = {
    label,
    claims: allClaims,
    strongestSupport,
    strongestOpposition,
    flow,
    wordsVsActions,
    marketContext,
    routeContext,
    unknowns,
    changeConditions,
    coverage,
    evidence,
  };
  const refreshedSections: string[] = [];
  const carried = { ...fresh } as Record<DossierSection, unknown>;
  for (const s of DOSSIER_SECTIONS) {
    if (previous && stableStringify(previous[s]) === stableStringify(fresh[s])) {
      carried[s] = previous[s];
    } else {
      refreshedSections.push(s);
    }
  }
  const dossier: CoinDossier = {
    dossierId,
    revision: previous ? previous.revision + 1 : 1,
    token,
    builtAt: now,
    inputsHash,
    ...(carried as Pick<CoinDossier, DossierSection>),
    versions: { schema: DOSSIER_SCHEMA, prompt: null, model: null },
    refreshedSections,
  };
  return { dossier, changed: true };
}
