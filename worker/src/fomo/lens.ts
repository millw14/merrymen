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
 * as a sentence it would be read as a finding about the coin.
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
import { STALE_SNAPSHOT_PREFIX, TOPIC_LABEL, agoText, type DossierClaimDetail } from "./dossier";
import type { CoinDossier, DossierClaim, EvidenceRef } from "./types";

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
  for (const u of d.unknowns.slice(0, 2)) candidates.push({ build: () => `Unknown: ${u}`, cite: null });
  for (const cc of d.changeConditions.slice(0, 2)) candidates.push({ build: () => `Would change the reading: ${cc}`, cite: null });

  const lines = [ATTRIBUTION, NOT_LINE];
  const citations: LensCitation[] = [];
  let used = ATTRIBUTION.length + 1 + NOT_LINE.length;
  const budget = LENS_MAX - STALENESS_RESERVE;
  for (const cand of candidates) {
    const ref = cand.cite ? `[ref:${tag}c${citations.length + 1}]` : "";
    const text = sanitizeText(cand.build(ref), 400);
    if (!text) continue;
    // Checked before fitting, not after: a leaking line that happened not to
    // fit would otherwise let a corrupted dossier render as if it were clean.
    if (leaks(text)) return null;
    if (used + 1 + text.length > budget) continue;
    lines.push(text);
    used += 1 + text.length;
    if (cand.cite) citations.push({ ref, ...cand.cite });
  }
  if (lines.length === 2) return null;
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
