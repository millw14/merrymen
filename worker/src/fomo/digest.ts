/**
 * WHAT TRADERS ARE SAYING ABOUT A COIN, WRITTEN BY CODE (docs/fomo.md
 * "Telegram groups"; plan WP9 P1).
 *
 * A group never hears a thesis quoted (docs/tg-groups.md rule 3), and the
 * stance counts it used to hear ("0 supporting, 0 opposing, 25 neutral")
 * read as a verdict when they only meant that no cue in the lexicon matched
 * (Milla, 2026-10-07: drop the counts and "evidence families" from group
 * answers). This digest says instead WHAT the theses argue, in fixed words
 * this file owns:
 *
 *   - one thesis per family (the most liked, then the newest), so a pasted
 *     copy or a reposted call counts once;
 *   - the coin's own dev's posts left out of the tallies, counted apart;
 *   - content-free rows ("lfg", "send it", a bare link) dropped;
 *   - the lexicon's cues that are not negated ("not a rug" removes nothing
 *     and adds nothing), tallied per family and said through GROUP_PHRASE,
 *     never in the author's words: "rug" is "fears it could collapse", "dev
 *     sold" is "worries about the dev's wallet" (the group gate refuses an
 *     accusation, and a thesis is a claim, not a finding);
 *   - the topics a thesis touches, and what holders say they are waiting on
 *     (never an airdrop: that word is a lure, not a catalyst).
 *
 * Deterministic and model-free: the same theses give the same lines. No
 * digit, handle, link or cashtag can reach a phrase: every phrase is a
 * constant here. The group model's paraphrase (tg-groups/theses.ts, P2)
 * falls back to this.
 */

import { DOSSIER_TOPICS, readThesisText, redactExecutables, thesisTopics, type DossierTopic } from "./dossier";

/** A non-negated stance cue, as a thesis view carries it (service.ts thesisViews). */
export interface ThesisCue {
  label: string;
  stance: "supporting" | "opposing";
}

/** What the digest reads of one thesis, from its full text. */
export interface ThesisReading {
  cues: ThesisCue[];
  /** Topics other than "other", in DOSSIER_TOPICS order. */
  topics: DossierTopic[];
  /** WAITING_PHRASE keys the text names. */
  waitingOn: string[];
}

/**
 * Each cue label (dossier.ts CUES) as a room may hear it. Worries stay
 * worries: nothing here says the coin IS anything. Every phrase is pinned
 * through the group gate as `research` and as `answer` (digest.test.ts,
 * tg-fomo-port.test.ts).
 */
export const GROUP_PHRASE: Readonly<Record<string, string>> = Object.freeze({
  early: "it's still early",
  "strong community": "a strong community",
  breakout: "the chart setting up",
  listing: "hopes of a listing",
  accumulating: "holders adding on dips",
  undervalued: "it looks undervalued",
  rug: "fears it could collapse",
  honeypot: "worries it can't be sold",
  "dev sold": "worries about the dev's wallet",
  "exit liquidity": "worries late buyers end up holding it",
  overvalued: "it looks overvalued",
  unlock: "token unlocks ahead",
  "can't sell": "worries it can't be sold",
  scam: "trust worries",
});

/** A topic as a room may hear it. "other" is never said. */
export const TOPIC_PHRASE: Readonly<Record<Exclude<DossierTopic, "other">, string>> = Object.freeze({
  team: "the team",
  liquidity: "liquidity",
  supply: "supply and holders",
  momentum: "the chart and volume",
  narrative: "the story behind it",
  community: "the community",
});

/**
 * What holders say they are waiting on, by the words that name it. An
 * airdrop is deliberately absent: "claim your airdrop" is the commonest lure
 * in a thesis feed, and a room must never hear one as something to wait for.
 */
export const WAITING_PHRASE: Readonly<Record<string, string>> = Object.freeze({
  listing: "a listing",
  roadmap: "the roadmap",
  launch: "a launch",
  partnership: "a partnership",
  update: "an update",
  announcement: "an announcement",
});

const WAITING_WORDS: ReadonlyArray<readonly [string, RegExp]> = [
  ["listing", /\b(?:listing|listings|listed|relist(?:ed|ing)?)\b/],
  ["roadmap", /\broad\s?map\b/],
  ["launch", /\b(?:launch(?:es|ing)?|mainnet)\b/],
  ["partnership", /\b(?:partnerships?|partnered|collab(?:oration)?s?)\b/],
  ["update", /\b(?:update|upgrade|v2|release)\b/],
  ["announcement", /\b(?:announcements?|announcing|news\s+drops?)\b/],
];

/** Words of three letters or more: fewer than three left after redaction is content-free ("lfg", "send it"). */
const CONTENT_WORD = /\p{L}{3,}/gu;
const MIN_CONTENT_WORDS = 3;

/** True when a thesis says nothing a digest could use. */
export function contentFree(text: string): boolean {
  const t = redactExecutables(typeof text === "string" ? text : "").replace(/\[(?:link|address|handle)\]/g, " ");
  return (t.match(CONTENT_WORD) ?? []).length < MIN_CONTENT_WORDS;
}

/** One thesis's cues, topics and waiting-on, from its full text (service.ts fills ThesisView with it). */
export function readThesisForDigest(text: string): ThesisReading {
  const t = typeof text === "string" ? text : "";
  const r = readThesisText(t);
  const seen = new Set<string>();
  const cues: ThesisCue[] = [];
  for (const c of r.cues) {
    if (c.negated || seen.has(c.label)) continue;
    seen.add(c.label);
    cues.push({ label: c.label, stance: c.stance });
  }
  const topics = thesisTopics(t).filter((x): x is DossierTopic => x !== "other");
  const low = redactExecutables(t).toLowerCase();
  const waitingOn = /\bairdrops?\b/.test(low) ? [] : WAITING_WORDS.filter(([, re]) => re.test(low)).map(([k]) => k);
  return { cues, topics, waitingOn };
}

/** What the digest needs of a thesis view (tools.ts ThesisView). */
export interface DigestThesis {
  excerpt: string;
  likes: number | null;
  postedAt: number | null;
  isDev: boolean | null;
  family: string;
  author: { userId: string };
  cues?: ThesisCue[];
  topics?: DossierTopic[];
  waitingOn?: string[];
}

export interface ThesesDigest {
  /** Theses read (every view given). */
  theses: number;
  /** Distinct authors of those theses. */
  authors: number;
  /** Families that said something (one thesis each), dev posts excluded. */
  families: number;
  /** The coin's dev's own posts, left out of every tally. */
  devPosts: number;
  /** Families dropped as content-free. */
  contentFree: number;
  /** GROUP_PHRASE phrases, most-raised first: at most four in favour, three against. */
  forIt: string[];
  against: string[];
  /** TOPIC_PHRASE phrases, most-touched first, at most three. */
  about: string[];
  /** WAITING_PHRASE phrases, at most two. */
  waitingOn: string[];
}

const FOR_MAX = 4;
const AGAINST_MAX = 3;
const ABOUT_MAX = 3;
const WAITING_MAX = 2;

const num = (n: number | null | undefined): number => (typeof n === "number" && Number.isFinite(n) ? n : -1);

/** Phrases by how many families raised them, ties in first-seen order (views come newest first). */
function ranked(counts: Map<string, number>, max: number): string[] {
  const order = [...counts.keys()];
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
    .slice(0, max)
    .map(([p]) => p);
}

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/** The digest of a coin's theses. Deterministic; never throws on odd input. */
export function digestTheses(views: readonly DigestThesis[]): ThesesDigest {
  const list = Array.isArray(views) ? views.filter((v) => v && typeof v === "object") : [];
  const authors = new Set(list.map((v) => v.author?.userId ?? "")).size;
  let devPosts = 0;
  // One thesis per family: the most liked, then the newest, then the first given.
  const byFamily = new Map<string, DigestThesis>();
  for (const v of list) {
    if (v.isDev === true) {
      devPosts += 1;
      continue;
    }
    const fam = typeof v.family === "string" && v.family ? v.family : `view:${byFamily.size}`;
    const cur = byFamily.get(fam);
    if (!cur || num(v.likes) > num(cur.likes) || (num(v.likes) === num(cur.likes) && num(v.postedAt) > num(cur.postedAt))) byFamily.set(fam, v);
  }
  const forIt = new Map<string, number>();
  const against = new Map<string, number>();
  const about = new Map<DossierTopic, number>();
  const waiting = new Map<string, number>();
  let dropped = 0;
  let families = 0;
  for (const v of byFamily.values()) {
    const text = typeof v.excerpt === "string" ? v.excerpt : "";
    if (contentFree(text)) {
      dropped += 1;
      continue;
    }
    families += 1;
    const read = v.cues && v.topics && v.waitingOn ? { cues: v.cues, topics: v.topics, waitingOn: v.waitingOn } : readThesisForDigest(text);
    const said = new Set<string>();
    for (const c of read.cues) {
      const p = Object.hasOwn(GROUP_PHRASE, c.label) ? GROUP_PHRASE[c.label]! : null;
      if (!p || said.has(p)) continue;
      said.add(p);
      bump(c.stance === "supporting" ? forIt : against, p);
    }
    for (const t of new Set(read.topics)) if (t !== "other" && Object.hasOwn(TOPIC_PHRASE, t)) bump(about as Map<string, number>, t);
    for (const w of new Set(read.waitingOn)) if (Object.hasOwn(WAITING_PHRASE, w)) bump(waiting, w);
  }
  const topicOrder = (m: Map<DossierTopic, number>): string[] =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || DOSSIER_TOPICS.indexOf(a[0]) - DOSSIER_TOPICS.indexOf(b[0]))
      .slice(0, ABOUT_MAX)
      .map(([t]) => TOPIC_PHRASE[t as Exclude<DossierTopic, "other">]);
  const forPhrases = ranked(forIt, FOR_MAX);
  // A listing already said as a hope is not said again as something waited on.
  const waitingKeys = ranked(waiting, WAITING_MAX + 1).filter((k) => !(k === "listing" && forPhrases.includes(GROUP_PHRASE.listing!)));
  return {
    theses: list.length,
    authors,
    families,
    devPosts,
    contentFree: dropped,
    forIt: forPhrases,
    against: ranked(against, AGAINST_MAX),
    about: topicOrder(about),
    waitingOn: waitingKeys.slice(0, WAITING_MAX).map((k) => WAITING_PHRASE[k]!),
  };
}

/** "a, b and c". */
export function listWords(xs: readonly string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
