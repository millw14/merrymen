/**
 * THE TRADER-FLOW LENS — what a social-trading feed can honestly be quoted as
 * saying about one coin, rendered for Brain.
 *
 * Pure. Given a dossier, returns a block of at most 1200 characters, or null.
 *
 * ── THE RULES, EACH OF WHICH IS A WAY THIS BLOCK COULD LIE ──────────────
 *
 * ABSENCE IS NOT A VERDICT. A dossier with no observed trades, no claims and
 * no inconsistencies renders NOTHING (null), and Brain answers NO DATA
 * AVAILABLE for the lens. "Nobody on the feed is talking about this coin" is a
 * statement about a feed with a $3,000 floor and patchy coverage, and rendered
 * as a sentence it would be read as a finding about the coin. The source's
 * holder and buyer/seller statistics (or that they were unavailable) ride in a
 * lens that has something else to say, in the room its other lines leave, and
 * never make one by themselves.
 *
 * VENDOR-NEUTRAL. Brain is told "a third-party social-trading platform" and
 * nothing else. It must weigh the KIND of source, not a brand, and a brand in a
 * prompt is an invitation to recall whatever the model believes about it.
 *
 * NO ADDRESSES, NO HEX, NO MINTS. Brain names instruments; trusted code maps an
 * instrument to an address (services/brain schemas reject address-shaped
 * output). If anything address-shaped reaches the rendered text, the whole
 * lens is withheld rather than trimmed, because a guard that edits its way
 * past a leak is a guard that will one day edit its way past the wrong one.
 *
 * NO THIRD-PARTY WORDS. Every sentence is Merrymen's own, built from topics,
 * stances and counts. Thesis text, handles and token names are attacker-
 * writable and never appear here, not even quoted: the dossier's labelled
 * excerpt stays in the dossier for humans.
 *
 * ATTRIBUTION FIRST, LIMITS NEXT. The block opens by saying whose data this is
 * and what it is not, before any number. A caveat that arrives after the
 * finding has already been read as part of it.
 *
 * Citations are opaque ([ref:d<id>r<rev>c<n>]) so Brain can point at an item
 * without being handed an identifier that means anything outside this
 * dossier. `lensRefs` returns exactly the refs a render emits, so the worker
 * can reject a citation Brain invented.
 */

import { createHash } from "node:crypto";
import { sanitizeText } from "../research/news";
import { STALE_SNAPSHOT_PREFIX, STATS_UNAVAILABLE_UNKNOWN, TOPIC_LABEL, agoText, type DossierClaimDetail } from "./dossier";
import type { CoinDossier, DossierClaim, DossierStatsWindow, EvidenceRef } from "./types";

/** The Brain lens key this block is sent under. */
export const TRADER_FLOW_LENS = "trader-flow";

/** Hard ceiling, matching brain-material.ts and coin-builder.ts. */
const LENS_MAX = 1200;
/** Room kept for the staleness sentence, so which lines fit never depends on the clock. */
const STALENESS_RESERVE = 150;
/** Past this the block says the reading may have moved. */
const STALE_AFTER_MS = 6 * 3_600_000;

const ADDRESS_HEX = /0x[0-9a-fA-F]{6,}/;
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]{32,}/;
const VENDOR = /fomo/i;

const ATTRIBUTION =
  "Source: trader activity and written theses reported by a third-party social-trading platform, grouped and counted by Merrymen. Theses are the traders' own claims, not findings.";
const NOT_LINE =
  "WHAT THIS IS NOT: independent market evidence. Trader activity is a reason to investigate, not a reason to buy, and separate wallets are not proven independent people.";

const SUPPORT_WORDS: Readonly<Record<DossierClaim["support"], string>> = {
  "verified-fact": "verified on chain",
  "observed-action": "observed action",
  "source-statement": "traders' statements",
  inference: "inference",
};

export interface LensCitation {
  ref: string;
  /** Which part of the dossier the ref points at. */
  section: "flow" | "strongestOpposition" | "strongestSupport" | "claim" | "wordsVsActions";
  /** The dossier evidence behind it, for the worker's own trace. Never rendered. */
  evidence: EvidenceRef[];
}

function shortId(dossierId: string): string {
  return createHash("sha256").update(dossierId).digest("hex").slice(0, 6);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function topicOf(c: DossierClaim): string {
  const t = (c as Partial<DossierClaimDetail>).topic;
  return t && t in TOPIC_LABEL ? TOPIC_LABEL[t] : "this coin";
}

/** The summary already carries its counts; the line adds what KIND of support it is. */
function claimLine(lead: string, c: DossierClaim, ref: string): string {
  return `${lead}, from ${SUPPORT_WORDS[c.support]}: ${sanitizeText(c.summary, 240).replace(/\.+$/, "")}. ${ref}`;
}

/**
 * THE STATS LINE: one sentence of the source's own all-size statistics
 * (holders, the top ten's share, unique buyers against unique sellers over the
 * last hour and day), or that they were unavailable on this read, or nothing
 * for a revision built before they were kept.
 *
 * NUMBERS ONLY, RE-CHECKED HERE: the dossier came back from storage, and a
 * figure that is not a plain count (or a 0–100 share) is unknown, never
 * repeated. A side that is unknown is said to be unknown, never zero.
 *
 * "UNAVAILABLE" IS NOT CONTENT. A provider outage (a 503, a refused budget)
 * gives the line below, never a lens of its own (absence is not a verdict).
 * It says the dossier's own "statistics were not available" unknown in other
 * words, in that unknown's place.
 *
 * ONLY THE ROOM LEFT OVER (composeBody). Every other line is fitted first,
 * exactly as it would be without statistics, and this line goes in only if it
 * still fits. Figures that were read are SHOWN right after the strongest
 * cases, but they never take the budget of the coverage line, an `Unknown:`
 * or `Would change the reading:` caveat, or a written case: a buyers-
 * outnumber-sellers figure in place of the invalidation condition would leave
 * the lens more one-sided toward buying than it was without figures at all.
 */
const STATS_LEAD = "Across all trade sizes, the same platform counts";
const STATS_UNAVAILABLE = "Holder and unique buyer/seller statistics: unavailable on this read.";

function statsCount(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function statsSide(w: DossierStatsWindow | null | undefined, label: string): string | null {
  if (!w || typeof w !== "object") return null;
  const b = statsCount(w.uniqueBuyers);
  const s = statsCount(w.uniqueSellers);
  if (b === null && s === null) return null;
  return `${label} ${b ?? "unknown"} vs ${s ?? "unknown"}`;
}

/** The figures as phrases, or [] when none is a usable number. */
function statsParts(d: CoinDossier): string[] {
  const s = d.stats;
  if (!s || typeof s !== "object") return [];
  const parts: string[] = [];
  const holders = statsCount(s.holders);
  if (holders !== null) parts.push(plural(holders, "holder", "holders"));
  const top = s.top10HoldersPercent;
  if (typeof top === "number" && Number.isFinite(top) && top >= 0 && top <= 100) parts.push(`the top 10 wallets hold ${top.toFixed(1)}%`);
  const sides = [statsSide(s.window1h, "last hour"), statsSide(s.window24h, "last 24h")].filter((p): p is string => p !== null);
  if (sides.length) parts.push(`unique buyers vs sellers: ${sides.join(", ")}`);
  return parts;
}

/** The line, and whether it carries figures (true) or says they were unavailable (false); null: nothing to say. */
function statsLine(d: CoinDossier): { text: string; known: boolean } | null {
  const parts = statsParts(d);
  if (parts.length) return { text: `${STATS_LEAD} ${parts.join("; ")}.`, known: true };
  if (d.stats === undefined && !d.coverage.missingSections.includes("token-stats")) return null;
  return { text: STATS_UNAVAILABLE, known: false };
}

/**
 * STATISTICS NEVER MAKE A LENS BY THEMSELVES. Brain holds a pulse slot for
 * this lens whenever it is fed (services/brain PULSE_RESERVED_LENSES) on the
 * premise that it is fed only when traders were actually seen on the coin;
 * holder counts exist for nearly every coin, so a statistics-only block would
 * displace a market analyst on almost every review. They ride along in a lens
 * that traders' activity or words already justify.
 */
function hasUsableContent(d: CoinDossier): boolean {
  const traded = d.flow !== null && (d.flow.distinctBuyers ?? 0) + (d.flow.distinctSellers ?? 0) > 0;
  return traded || d.claims.length > 0 || d.wordsVsActions.length > 0;
}

/** Anything address-shaped or vendor-named anywhere withholds the WHOLE lens. */
function leaks(text: string): boolean {
  return VENDOR.test(text) || ADDRESS_HEX.test(text) || BASE58_RUN.test(text);
}

/**
 * Everything but the staleness sentence, in priority order, fitted to the
 * budget. Pure in the dossier alone, which is what lets `lensRefs` agree with
 * the render without knowing the time.
 */
function composeBody(d: CoinDossier): { lines: string[]; citations: LensCitation[] } | null {
  if (!hasUsableContent(d)) return null;
  const tag = `d${shortId(d.dossierId)}r${d.revision}`;
  /** A line is built from its ref, so numbering follows what was actually emitted. */
  type Candidate = { build: (ref: string) => string; cite: Pick<LensCitation, "section" | "evidence"> | null };
  const candidates: Candidate[] = [];

  const f = d.flow;
  const flowShown = f !== null && (f.distinctBuyers ?? 0) + (f.distinctSellers ?? 0) > 0;
  if (f && flowShown) {
    const cohort =
      f.cohortBuyers !== null && f.cohortSellers !== null ? ` (${f.cohortBuyers} and ${f.cohortSellers} of them from the watched-trader cohort)` : "";
    const repeats = f.repeatAddsBySameTrader ? `; ${plural(f.repeatAddsBySameTrader, "repeat add", "repeat adds")} by traders already buying` : "";
    const buyers = f.distinctBuyers === null ? "an unknown number of distinct buyers" : plural(f.distinctBuyers, "distinct buyer", "distinct buyers");
    const sellers = f.distinctSellers === null ? "an unknown number of distinct sellers" : plural(f.distinctSellers, "distinct seller", "distinct sellers");
    candidates.push({
      build: (ref) =>
        `Activity over ${sanitizeText(f.window, 12)}: ${buyers} and ${sellers}${cohort}${repeats}. ` +
        `Only positions above about $3,000 appear, so small trades are invisible. ${ref}`,
      cite: { section: "flow", evidence: d.evidence.filter((e) => e.kind === "event") },
    });
  }

  // WHEN THE STRONGEST CASE IS THE FLOW ITSELF, it is pointed at rather than
  // restated, and the best WRITTEN case on that side follows: Brain should see
  // both what traders did and the best of what they said.
  const written: Candidate[] = [];
  const strongest: [string, DossierClaim | null, LensCitation["section"]][] = [
    ["Strongest objection", d.strongestOpposition, "strongestOpposition"],
    ["Strongest support", d.strongestSupport, "strongestSupport"],
  ];
  for (const [lead, claim, section] of strongest) {
    if (!claim) continue;
    if (flowShown && claim.claimKey.startsWith("action:momentum:")) {
      const side = claim.stance === "supporting" ? "buying" : "selling";
      candidates.push({ build: (ref) => `${lead} is the observed ${side} counted above. ${ref}`, cite: { section, evidence: claim.evidence } });
      const top = d.claims.find((c) => c.stance === claim.stance && c.support === "source-statement");
      if (top) {
        written.push({ build: (ref) => claimLine(`${lead} in writing`, top, ref), cite: { section: "claim", evidence: top.evidence } });
      }
    } else {
      candidates.push({ build: (ref) => claimLine(lead, claim, ref), cite: { section, evidence: claim.evidence } });
    }
  }
  // FIGURES ARE SHOWN RIGHT AFTER THE STRONGEST CASES, ahead of the written
  // follow-ups: holder concentration and who is still buying are often the
  // whole reading on a coin nobody wrote about (most of what a review is
  // shown), and a risk to weigh on one they did. Only shown there: the line
  // is fitted last, into the room every other line left (below). No ref: it
  // cites no item of the evidence, so adding it never renumbers one.
  const stats = statsLine(d);
  const statsSlot = candidates.length;
  candidates.push(...written);

  if (!d.strongestOpposition && !d.strongestSupport && d.claims.length) {
    const neutral = d.claims.filter((c) => c.stance === "neutral");
    const families = neutral.reduce((s, c) => s + c.familyCount, 0);
    const topics = [...new Set(neutral.map(topicOf))].slice(0, 3).join(", ");
    if (families) {
      candidates.push({
        build: (ref) => `${plural(families, "independent thesis discusses", "independent theses discuss")} ${topics} without taking a clear side. ${ref}`,
        cite: { section: "claim", evidence: neutral.flatMap((x) => x.evidence).slice(0, 40) },
      });
    }
  }
  if (d.wordsVsActions.length) {
    candidates.push({
      build: (ref) =>
        `${plural(d.wordsVsActions.length, "author was", "authors were")} seen acting against their own written view; an inconsistency to weigh, not proof of bad faith. ${ref}`,
      cite: { section: "wordsVsActions", evidence: d.wordsVsActions.flatMap((w) => w.evidence).slice(0, 40) },
    });
  }
  const cov = d.coverage;
  const capped = cov.sourceCaps.some((s) => s.startsWith("Thesis read stopped"));
  candidates.push({
    build: () =>
      `Coverage: ${plural(cov.uniqueTheses, "thesis", "theses")} from ${plural(cov.uniqueAuthors, "author", "authors")}` +
      (cov.providerTotal !== null ? ` of ${cov.providerTotal} reported` : "") +
      (capped ? "; the read was capped and the rest are unread." : "."),
    cite: null,
  });
  const coverageSlot = candidates.length;
  // The caveats, exactly as a lens without statistics carries them.
  const shownUnknowns = d.unknowns.slice(0, 2);
  const firstUnknown = candidates.length;
  for (const u of shownUnknowns) candidates.push({ build: () => `Unknown: ${u}`, cite: null });
  for (const cc of d.changeConditions.slice(0, 2)) candidates.push({ build: () => `Would change the reading: ${cc}`, cite: null });

  const lines = [ATTRIBUTION, NOT_LINE];
  const citations: LensCitation[] = [];
  /** For each body line lines[2 + i], the candidate it was built from. */
  const from: number[] = [];
  let used = ATTRIBUTION.length + 1 + NOT_LINE.length;
  const budget = LENS_MAX - STALENESS_RESERVE;
  for (const [i, cand] of candidates.entries()) {
    const ref = cand.cite ? `[ref:${tag}c${citations.length + 1}]` : "";
    const text = sanitizeText(cand.build(ref), 400);
    if (!text) continue;
    // Checked before fitting, not after: a leaking line that happened not to
    // fit would otherwise let a corrupted dossier render as if it were clean.
    if (leaks(text)) return null;
    if (used + 1 + text.length > budget) continue;
    lines.push(text);
    from.push(i);
    used += 1 + text.length;
    if (cand.cite) citations.push({ ref, ...cand.cite });
  }
  // Statistics never make a lens: one with nothing else to say ends here.
  if (lines.length === 2) return null;

  // THE STATISTICS, INTO THE ROOM LEFT, never in place of a line that fitted
  // without them (the stats-line comment above says why).
  const statsText = stats ? sanitizeText(stats.text, 400) : "";
  if (statsText && leaks(statsText)) return null;
  if (stats && statsText) {
    /** Where a line that belongs before candidate `slot` goes among the lines emitted. */
    const lineAt = (slot: number): number => 2 + from.filter((i) => i < slot).length;
    const k = shownUnknowns.indexOf(STATS_UNAVAILABLE_UNKNOWN);
    const unknownLine = k < 0 ? -1 : from.indexOf(firstUnknown + k);
    if (stats.known) {
      if (used + 1 + statsText.length <= budget) lines.splice(lineAt(statsSlot), 0, statsText);
    } else if (unknownLine >= 0) {
      // The dossier's own "not available" unknown, said once, in the stats
      // line's words when the longer wording still fits; otherwise as it was.
      const old = lines[2 + unknownLine]!;
      if (used - old.length + statsText.length <= budget) lines[2 + unknownLine] = statsText;
    } else if (used + 1 + statsText.length <= budget) {
      lines.splice(lineAt(coverageSlot), 0, statsText);
    }
  }
  if (leaks(lines.join(" "))) return null;
  return { lines, citations };
}

function stalenessLine(d: CoinDossier, now: number): string {
  const age = Math.max(0, now - d.builtAt);
  const newest = d.coverage.newestSourceAt;
  const snapshot = d.coverage.limitations.some((l) => l.startsWith(STALE_SNAPSHOT_PREFIX));
  const parts = [`Summary built ${agoText(age)}`];
  if (newest !== null) parts.push(`newest item ${agoText(Math.max(0, now - newest))}`);
  let s = parts.join("; ") + ".";
  if (snapshot) s += " Theses came from a stored snapshot, not a live read.";
  if (age > STALE_AFTER_MS) s += " It may have moved since.";
  return s.slice(0, STALENESS_RESERVE - 1);
}

/**
 * The trader-flow lens, or null when there is nothing honest to say (or when
 * anything address-shaped or vendor-named would have been said).
 */
export function renderTraderFlowLens(dossier: CoinDossier | null, now: number): string | null {
  if (!dossier) return null;
  const body = composeBody(dossier);
  if (!body) return null;
  const [attribution, notLine, ...rest] = body.lines;
  const text = sanitizeText([attribution, notLine, stalenessLine(dossier, now), ...rest].join(" "), LENS_MAX);
  return leaks(text) ? null : text;
}

/** The refs a render of this dossier emits, in order; [] when it renders nothing. */
export function lensRefs(dossier: CoinDossier | null): string[] {
  if (!dossier) return [];
  return composeBody(dossier)?.citations.map((c) => c.ref) ?? [];
}

/** The refs with the dossier evidence each stands for, for the worker's trace. */
export function lensCitations(dossier: CoinDossier | null): LensCitation[] {
  if (!dossier) return [];
  return composeBody(dossier)?.citations ?? [];
}
