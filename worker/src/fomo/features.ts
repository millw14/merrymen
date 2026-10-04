/**
 * SOCIAL-FEED INTELLIGENCE — what changed in who is buying, selling and
 * writing about a coin, read without mistaking any of it for a verdict.
 *
 * Pure functions over normalised events, theses and dossiers. No clock, no
 * network, no environment: every time is passed in.
 *
 * ── THE MISTAKES EACH FUNCTION EXISTS TO PREVENT ─────────────────────────
 *
 *   A RISING POSITION VALUE IS NOT ACCUMULATION. A trader whose $10k position
 *   is now marked at $30k did nothing; the price did. Only BUY events count as
 *   adding. Transfers in and airdrops are not purchases either.
 *
 *   ONE TRADER ADDING FIVE TIMES IS NOT FIVE BUYERS. Breadth is distinct
 *   traders; repeat adds are reported as what they are.
 *
 *   WALLETS ARE NOT PEOPLE, AND NEITHER IS PROVEN. Buys landing in the same few
 *   seconds can be a shared signal, coordination or coincidence. This module
 *   says the timing and says the ownership is unknown; it never claims that two
 *   wallets share an owner, and never that they do not.
 *
 *   POPULARITY IS NOT MERIT. A topic everybody is writing about is a topic
 *   everybody is writing about. Every narrative row carries that flag.
 *
 *   "NO CHANGE" IS A FINDING THAT NEEDS A BASELINE. Without an earlier reading
 *   over the same scope, and a check that actually succeeded, the honest answer
 *   is "not comparable", never "nothing changed".
 *
 * Provider money is read only to classify (a position marked at zero after a
 * sell is an exit); it is never summed into anything that sizes a trade.
 */

import { sanitizeText } from "../research/news";
import {
  TOPIC_LABEL,
  agoText,
  compareClaims,
  eventRef,
  eventTime,
  resolveFamilies,
  thesisRef,
  thesisTopics,
  type DossierClaimDetail,
  type DossierTopic,
} from "./dossier";
import type { CoinDossier, DossierClaim, EvidenceRef, Thesis, TokenIdentity, TokenLabel, TraderEvent } from "./types";

/** The provider quantises event time to 5 s; buys inside one bucket are "the same moment". */
const TIME_BUCKET_MS = 5_000;
const DEFAULT_DETERIORATION_WINDOW_MS = 24 * 3_600_000;
const DEFAULT_DOSSIER_STALE_MS = 6 * 3_600_000;
const MAX_REFS = 20;

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const cleanHandle = (h: string | null): string | null => (h === null ? null : sanitizeText(h, 40) || null);
const cleanLabel = (l: TokenLabel): TokenLabel => ({
  symbol: l.symbol === null ? null : sanitizeText(l.symbol, 24) || null,
  name: l.name === null ? null : sanitizeText(l.name, 64) || null,
});

function byToken(events: readonly TraderEvent[]): Map<string, TraderEvent[]> {
  const out = new Map<string, TraderEvent[]>();
  for (const e of events) {
    if (!e.token) continue;
    const list = out.get(e.token.key);
    if (list) list.push(e);
    else out.set(e.token.key, [e]);
  }
  for (const list of out.values()) list.sort((a, b) => eventTime(a) - eventTime(b) || cmpStr(a.eventKey, b.eventKey));
  return out;
}

function uniqueByKey(events: readonly TraderEvent[]): TraderEvent[] {
  const seen = new Set<string>();
  const out: TraderEvent[] = [];
  for (const e of events) {
    if (seen.has(e.eventKey)) continue;
    seen.add(e.eventKey);
    out.push(e);
  }
  return out;
}

// ── Early discovery ──────────────────────────────────────────────────────

export interface EarlyDiscovery {
  tokenKey: string;
  token: TokenIdentity;
  label: TokenLabel;
  /** Earliest cohort purchase seen in this batch: what the caller records as first-seen. */
  firstCohortBuyAt: number;
  cohortBuyers: number;
  cohortBuyEvents: number;
  evidence: EvidenceRef[];
  note: string;
}

/**
 * Coins entering the followed cohort's PURCHASES for the first time: a token
 * key absent from `firstSeen` that a cohort member bought. Only buy events
 * count. The caller persists `firstCohortBuyAt` into its first-seen map.
 */
export function earlyDiscovery(
  events: readonly TraderEvent[],
  firstSeen: ReadonlyMap<string, number>,
  cohortUserIds: ReadonlySet<string>,
): EarlyDiscovery[] {
  const cohortBuys = uniqueByKey(events).filter((e) => e.kind === "buy" && e.token && cohortUserIds.has(e.trader.userId));
  const out: EarlyDiscovery[] = [];
  for (const [key, list] of byToken(cohortBuys)) {
    if (firstSeen.has(key)) continue;
    const first = list[0]!;
    const buyers = new Set(list.map((e) => e.trader.userId)).size;
    out.push({
      tokenKey: key,
      token: first.token!,
      label: cleanLabel(first.tokenLabel),
      firstCohortBuyAt: eventTime(first),
      cohortBuyers: buyers,
      cohortBuyEvents: list.length,
      evidence: list.slice(0, MAX_REFS).map((e) => eventRef(e.eventKey)),
      note:
        `${plural(buyers, "followed trader", "followed traders")} bought this coin for the first time in the cohort's record. ` +
        "A purchase is a reason to investigate, not an instruction to buy" +
        (buyers === 1 ? ", and one buyer is not breadth." : "."),
    });
  }
  return out.sort((a, b) => a.firstCohortBuyAt - b.firstCohortBuyAt || cmpStr(a.tokenKey, b.tokenKey));
}

// ── Participation breadth ────────────────────────────────────────────────

export type BreadthReading = "broad" | "narrow" | "single-trader" | "insufficient";

export interface ParticipationBreadth {
  tokenKey: string;
  distinctBuyers: number;
  buyEvents: number;
  repeatAdds: number;
  /** Share of buy events made by the most active buyer, 0..1. */
  topTraderBuyShare: number;
  reading: BreadthReading;
  /** Distinct buyers whose buy shared a 5-second bucket with another trader's buy. */
  sameMomentBuyers: number;
  notes: string[];
}

/**
 * Distinct buyers versus one trader repeatedly adding, per token, over the
 * trailing window. Buy events only.
 */
export function participationBreadth(events: readonly TraderEvent[], windowMs: number, now: number): ParticipationBreadth[] {
  const start = now - windowMs;
  const buys = uniqueByKey(events).filter((e) => e.kind === "buy" && e.trader.userId && eventTime(e) >= start && eventTime(e) <= now);
  const out: ParticipationBreadth[] = [];
  for (const [key, list] of byToken(buys)) {
    const perTrader = new Map<string, number>();
    for (const e of list) perTrader.set(e.trader.userId, (perTrader.get(e.trader.userId) ?? 0) + 1);
    const distinct = perTrader.size;
    const top = Math.max(...perTrader.values());
    const share = top / list.length;
    const reading: BreadthReading =
      list.length < 2 ? "insufficient" : distinct === 1 ? "single-trader" : distinct >= 3 && share <= 0.5 ? "broad" : "narrow";
    const buckets = new Map<number, Set<string>>();
    for (const e of list) {
      const b = Math.floor(eventTime(e) / TIME_BUCKET_MS);
      const s = buckets.get(b) ?? new Set<string>();
      s.add(e.trader.userId);
      buckets.set(b, s);
    }
    const clustered = new Set<string>();
    for (const s of buckets.values()) if (s.size >= 2) for (const u of s) clustered.add(u);
    const notes: string[] = ["Only positions above roughly $3,000 appear in the feed, so breadth among small buyers is invisible."];
    if (reading === "single-trader") notes.push(`One trader made all ${list.length} buys; repeated adds by one trader are not breadth.`);
    if (clustered.size >= 2) {
      notes.push(
        `${clustered.size} buyers bought within the same few seconds. That can be a shared signal, coordination or coincidence; ` +
          "whether these wallets belong to the same person is unknown, and nothing here shows it either way.",
      );
    }
    out.push({
      tokenKey: key,
      distinctBuyers: distinct,
      buyEvents: list.length,
      repeatAdds: list.length - distinct,
      topTraderBuyShare: share,
      reading,
      sameMomentBuyers: clustered.size,
      notes,
    });
  }
  return out.sort((a, b) => cmpStr(a.tokenKey, b.tokenKey));
}

// ── Conviction changes ───────────────────────────────────────────────────

export type ConvictionChangeKind = "accumulation" | "reduction" | "exit" | "sell-unclassified";

export interface ConvictionChange {
  userId: string;
  handle: string | null;
  tokenKey: string;
  change: ConvictionChangeKind;
  buyEvents: number;
  sellEvents: number;
  firstAt: number;
  lastAt: number;
  evidence: EvidenceRef[];
  note: string;
}

/**
 * Per trader and token: accumulation (two or more BUY events), and the latest
 * sell classified as a reduction (position still marked above zero), an exit
 * (marked at zero) or unclassified (the provider sent no mark, which is the
 * common case for sells). Price-driven value changes, transfers and airdrops
 * are not conviction changes and produce nothing.
 */
export function convictionChanges(events: readonly TraderEvent[]): ConvictionChange[] {
  const out: ConvictionChange[] = [];
  const groups = new Map<string, TraderEvent[]>();
  for (const e of uniqueByKey(events)) {
    if (!e.token || !e.trader.userId || (e.kind !== "buy" && e.kind !== "sell")) continue;
    const k = `${e.trader.userId}|${e.token.key}`;
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }
  for (const [, raw] of [...groups.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
    const list = [...raw].sort((a, b) => eventTime(a) - eventTime(b) || cmpStr(a.eventKey, b.eventKey));
    const first = list[0]!;
    const buys = list.filter((e) => e.kind === "buy");
    const sells = list.filter((e) => e.kind === "sell");
    const base = {
      userId: first.trader.userId,
      handle: cleanHandle(list[list.length - 1]!.trader.handle),
      tokenKey: first.token!.key,
      buyEvents: buys.length,
      sellEvents: sells.length,
    };
    if (buys.length >= 2) {
      out.push({
        ...base,
        change: "accumulation",
        firstAt: eventTime(buys[0]!),
        lastAt: eventTime(buys[buys.length - 1]!),
        evidence: buys.slice(0, MAX_REFS).map((e) => eventRef(e.eventKey)),
        note: `${buys.length} separate buys observed. Accumulation is counted from purchases only; a rising position value from price is not accumulation.`,
      });
    }
    const lastSell = sells[sells.length - 1];
    if (lastSell) {
      const mark = lastSell.positionValueUsd;
      const change: ConvictionChangeKind =
        typeof mark !== "number" || !Number.isFinite(mark) ? "sell-unclassified" : mark <= 0 ? "exit" : "reduction";
      out.push({
        ...base,
        change,
        firstAt: eventTime(sells[0]!),
        lastAt: eventTime(lastSell),
        evidence: sells.slice(0, MAX_REFS).map((e) => eventRef(e.eventKey)),
        note:
          change === "exit"
            ? "The latest sell left the position marked at zero."
            : change === "reduction"
              ? "The latest sell left part of the position in place."
              : "Sold; whether the position was reduced or closed was not reported.",
      });
    }
  }
  return out;
}

// ── Thesis changes between dossier revisions ─────────────────────────────

export interface ThesisChangeSet {
  /** Same families and support type as before. */
  kept: string[];
  strengthened: { claimKey: string; reason: string }[];
  weakened: { claimKey: string; reason: string }[];
  added: string[];
  dropped: string[];
}

const SUPPORT_ORDER: Readonly<Record<DossierClaim["support"], number>> = {
  inference: 0,
  "source-statement": 1,
  "observed-action": 2,
  "verified-fact": 3,
};

/** Claims kept, strengthened, weakened, new or gone, by claim key. */
export function thesisChanges(prev: CoinDossier | null, next: CoinDossier): ThesisChangeSet {
  const before = new Map((prev?.claims ?? []).map((c) => [c.claimKey, c]));
  const after = new Map(next.claims.map((c) => [c.claimKey, c]));
  const out: ThesisChangeSet = { kept: [], strengthened: [], weakened: [], added: [], dropped: [] };
  for (const key of [...after.keys()].sort(cmpStr)) {
    const a = after.get(key)!;
    const b = before.get(key);
    if (!b) {
      out.added.push(key);
      continue;
    }
    const support = SUPPORT_ORDER[a.support] - SUPPORT_ORDER[b.support];
    const families = a.familyCount - b.familyCount;
    if (support < 0 || (support === 0 && families < 0)) {
      out.weakened.push({
        claimKey: key,
        reason: support < 0 ? `support fell from ${b.support} to ${a.support}` : `independent families fell from ${b.familyCount} to ${a.familyCount}`,
      });
    } else if (support > 0 || families > 0) {
      out.strengthened.push({
        claimKey: key,
        reason: support > 0 ? `support rose from ${b.support} to ${a.support}` : `independent families rose from ${b.familyCount} to ${a.familyCount}`,
      });
    } else {
      out.kept.push(key);
    }
  }
  for (const key of [...before.keys()].sort(cmpStr)) if (!after.has(key)) out.dropped.push(key);
  return out;
}

// ── Narrative development ────────────────────────────────────────────────

export interface NarrativeTopic {
  topic: DossierTopic;
  recentFamilies: number;
  priorFamilies: number;
  recentAuthors: number;
  emerging: boolean;
  /** Always true: how much a topic is written about says nothing about whether it is right. */
  popularityIsNotMerit: true;
  evidence: EvidenceRef[];
}

/**
 * Topics in the trailing window against the window before it, counted in
 * independent families. Emerging means at least two families now and more
 * than before. Undated theses are counted out and reported.
 */
export function narrativeDevelopment(
  theses: readonly Thesis[],
  windowMs: number,
  now: number,
): { topics: NarrativeTopic[]; undated: number; note: string } {
  const seen = new Set<string>();
  const unique = theses.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  const families = resolveFamilies(unique);
  const recentStart = now - windowMs;
  const priorStart = now - 2 * windowMs;
  let undated = 0;
  const acc = new Map<DossierTopic, { recent: Set<string>; prior: Set<string>; authors: Set<string>; refs: EvidenceRef[] }>();
  for (const t of unique) {
    if (typeof t.postedAt !== "number" || !Number.isFinite(t.postedAt)) {
      undated++;
      continue;
    }
    if (t.postedAt > now || t.postedAt < priorStart) continue;
    const fam = families.get(t.id) ?? t.id;
    for (const topic of thesisTopics(t.text)) {
      const a = acc.get(topic) ?? { recent: new Set<string>(), prior: new Set<string>(), authors: new Set<string>(), refs: [] };
      if (t.postedAt >= recentStart) {
        a.recent.add(fam);
        a.authors.add(t.author.userId);
        if (a.refs.length < MAX_REFS) a.refs.push(thesisRef(t.id));
      } else {
        a.prior.add(fam);
      }
      acc.set(topic, a);
    }
  }
  const topics: NarrativeTopic[] = [...acc.entries()]
    .map(([topic, a]) => ({
      topic,
      recentFamilies: a.recent.size,
      priorFamilies: a.prior.size,
      recentAuthors: a.authors.size,
      emerging: a.recent.size >= 2 && a.recent.size > a.prior.size,
      popularityIsNotMerit: true as const,
      evidence: a.refs,
    }))
    .sort((x, y) => y.recentFamilies - x.recentFamilies || cmpStr(x.topic, y.topic));
  return {
    topics,
    undated,
    note: "Counts are of independent thesis families. A topic being written about more is popularity, not evidence that the claims are right.",
  };
}

// ── Position deterioration ───────────────────────────────────────────────

export interface DeteriorationSignal {
  code:
    | "data-missing"
    | "dossier-stale"
    | "rising-sellers"
    | "flow-reversal"
    | "cohort-sellers-lead"
    | "objection-confirmed"
    | "objection-strengthened"
    | "objection-leads"
    | "words-vs-actions";
  text: string;
}

export interface DeteriorationReading {
  tokenKey: string;
  /** review: look again now; watch: one signal; none: nothing found in what was read. */
  level: "none" | "watch" | "review";
  signals: DeteriorationSignal[];
  evidence: EvidenceRef[];
}

/**
 * Whether a held coin's social picture is getting worse. Missing or stale data
 * is itself a reason to REVIEW: a quiet feed about a position we hold is not
 * reassurance. This never says sell; it says look.
 */
export function positionDeterioration(
  tokenKey: string,
  events: readonly TraderEvent[],
  dossier: CoinDossier | null,
  now: number,
  opts: { windowMs?: number; staleAfterMs?: number; previous?: CoinDossier | null } = {},
): DeteriorationReading {
  const windowMs = opts.windowMs ?? DEFAULT_DETERIORATION_WINDOW_MS;
  const staleAfter = opts.staleAfterMs ?? DEFAULT_DOSSIER_STALE_MS;
  const signals: DeteriorationSignal[] = [];
  const evidence: EvidenceRef[] = [];
  const mine = uniqueByKey(events).filter((e) => e.token?.key === tokenKey && eventTime(e) <= now && eventTime(e) >= now - windowMs);
  const half = now - windowMs / 2;
  const sellersIn = (from: number, to: number): Set<string> =>
    new Set(mine.filter((e) => e.kind === "sell" && eventTime(e) >= from && eventTime(e) < to).map((e) => e.trader.userId));
  const buyersIn = (from: number, to: number): Set<string> =>
    new Set(mine.filter((e) => e.kind === "buy" && eventTime(e) >= from && eventTime(e) < to).map((e) => e.trader.userId));

  if (!dossier || dossier.token.key !== tokenKey) {
    signals.push({ code: "data-missing", text: "No research dossier is held for this coin; review before relying on silence." });
  } else {
    if (now - dossier.builtAt > staleAfter) {
      signals.push({ code: "dossier-stale", text: `The research dossier was built ${agoText(now - dossier.builtAt)} and may no longer describe the coin.` });
    }
    if (!dossier.flow && mine.length === 0) {
      signals.push({ code: "data-missing", text: "No trader activity is available for this coin; the absence is unknown, not calm." });
    }
  }

  const earlySellers = sellersIn(now - windowMs, half);
  const lateSellers = sellersIn(half, now + 1);
  const earlyBuyers = buyersIn(now - windowMs, half);
  const lateBuyers = buyersIn(half, now + 1);
  if (lateSellers.size >= 2 && lateSellers.size > earlySellers.size) {
    signals.push({
      code: "rising-sellers",
      text: `Distinct sellers rose from ${earlySellers.size} to ${lateSellers.size} between the two halves of the window.`,
    });
  }
  if (earlyBuyers.size > earlySellers.size && lateSellers.size > lateBuyers.size) {
    signals.push({ code: "flow-reversal", text: "Observed flow turned from net buyers to net sellers within the window." });
  }
  if (signals.some((s) => s.code === "rising-sellers" || s.code === "flow-reversal")) {
    for (const e of mine.filter((x) => x.kind === "sell" && eventTime(x) >= half).slice(0, MAX_REFS)) evidence.push(eventRef(e.eventKey));
  }

  if (dossier && dossier.token.key === tokenKey) {
    const f = dossier.flow;
    if (f && f.cohortSellers !== null && f.cohortBuyers !== null && f.cohortSellers > f.cohortBuyers) {
      signals.push({ code: "cohort-sellers-lead", text: `Cohort sellers (${f.cohortSellers}) outnumber cohort buyers (${f.cohortBuyers}) over ${f.window}.` });
    }
    const opp = dossier.strongestOpposition;
    const sup = dossier.strongestSupport;
    if (opp) {
      const detail = opp as Partial<DossierClaimDetail>;
      const topic = detail.topic ? TOPIC_LABEL[detail.topic] : "an objection";
      if (opp.support !== "source-statement" || (detail.corroboratedBy ?? null) !== null) {
        signals.push({ code: "objection-confirmed", text: `The strongest objection (${topic}) is backed by observed action.` });
        evidence.push(...opp.evidence.slice(0, 5));
      }
      const before = opts.previous?.claims.find((c) => c.claimKey === opp.claimKey);
      if (before && opp.familyCount > before.familyCount) {
        signals.push({
          code: "objection-strengthened",
          text: `Independent sources behind the strongest objection rose from ${before.familyCount} to ${opp.familyCount}.`,
        });
      } else if (!sup || compareClaims(opp, sup) < 0) {
        signals.push({ code: "objection-leads", text: "The strongest objection now outranks the strongest supporting case." });
      }
    }
    if (dossier.wordsVsActions.length) {
      signals.push({
        code: "words-vs-actions",
        text: `${plural(dossier.wordsVsActions.length, "author has", "authors have")} acted against their own written view; an inconsistency, not proof of bad faith.`,
      });
    }
  }

  const missing = signals.some((s) => s.code === "data-missing" || s.code === "dossier-stale");
  const deteriorating = signals.filter((s) => s.code !== "data-missing" && s.code !== "dossier-stale").length;
  const level = missing || deteriorating >= 2 ? "review" : deteriorating === 1 ? "watch" : "none";
  const uniqueEvidence = [...new Map(evidence.map((r) => [r.id, r])).values()];
  return { tokenKey, level, signals, evidence: uniqueEvidence };
}

// ── Change summaries ─────────────────────────────────────────────────────

export interface ChangeCheck {
  dossier: CoinDossier;
  checkedAt: number;
  /** What the check covered (window, chain, depth…). Two checks compare only over the same scope. */
  scope: string;
}

export type ChangeSummaryReason =
  | "no-baseline"
  | "check-failed"
  | "different-scope"
  | "different-token"
  | "baseline-not-earlier"
  | "compared";

export interface ChangeSummary {
  /** A comparison was actually made: an earlier baseline over the same scope and a successful new check. */
  comparable: boolean;
  /** True ONLY when comparable and nothing material moved. */
  noChange: boolean;
  changes: string[];
  reason: ChangeSummaryReason;
}

function claimLine(c: DossierClaim | undefined, key: string): string {
  return c ? c.summary : key;
}

/**
 * What changed since the last check, in plain lines. "No change" is returned
 * only against a comparable earlier baseline over the same scope AND after a
 * successful new check; anything else is "not comparable" with the reason.
 */
export function changeSummary(prev: ChangeCheck | null, next: ChangeCheck & { succeeded: boolean }): ChangeSummary {
  const not = (reason: ChangeSummaryReason): ChangeSummary => ({ comparable: false, noChange: false, changes: [], reason });
  if (!next.succeeded) return not("check-failed");
  if (!prev) return not("no-baseline");
  if (prev.scope !== next.scope) return not("different-scope");
  if (prev.dossier.token.key !== next.dossier.token.key) return not("different-token");
  if (!(prev.checkedAt < next.checkedAt)) return not("baseline-not-earlier");

  const a = prev.dossier;
  const b = next.dossier;
  const changes: string[] = [];
  if (a.inputsHash !== b.inputsHash) {
    const tc = thesisChanges(a, b);
    const afterBy = new Map(b.claims.map((c) => [c.claimKey, c]));
    const beforeBy = new Map(a.claims.map((c) => [c.claimKey, c]));
    for (const k of tc.added) changes.push(`New: ${claimLine(afterBy.get(k), k)}`);
    for (const s of tc.strengthened) changes.push(`Strengthened (${s.reason}): ${claimLine(afterBy.get(s.claimKey), s.claimKey)}`);
    for (const w of tc.weakened) changes.push(`Weakened (${w.reason}): ${claimLine(afterBy.get(w.claimKey), w.claimKey)}`);
    for (const k of tc.dropped) changes.push(`No longer present: ${claimLine(beforeBy.get(k), k)}`);
    if ((a.strongestOpposition?.claimKey ?? null) !== (b.strongestOpposition?.claimKey ?? null)) {
      changes.push(b.strongestOpposition ? `Strongest objection is now: ${b.strongestOpposition.summary}` : "There is no longer an objection on record.");
    }
    if ((a.strongestSupport?.claimKey ?? null) !== (b.strongestSupport?.claimKey ?? null)) {
      changes.push(b.strongestSupport ? `Strongest support is now: ${b.strongestSupport.summary}` : "There is no longer a supporting case on record.");
    }
    if (a.flow && !b.flow) changes.push("Trader activity is no longer available for this coin.");
    else if (!a.flow && b.flow) changes.push("Trader activity is now available for this coin.");
    else if (a.flow && b.flow) {
      const pairs: [string, number | null, number | null][] = [
        ["Distinct buyers", a.flow.distinctBuyers, b.flow.distinctBuyers],
        ["Distinct sellers", a.flow.distinctSellers, b.flow.distinctSellers],
        ["Cohort buyers", a.flow.cohortBuyers, b.flow.cohortBuyers],
        ["Cohort sellers", a.flow.cohortSellers, b.flow.cohortSellers],
      ];
      for (const [name, x, y] of pairs) {
        if (x === y) continue;
        changes.push(`${name}: ${x === null ? "unknown" : x} → ${y === null ? "unknown" : y}.`);
      }
    }
    if (b.wordsVsActions.length > a.wordsVsActions.length) {
      changes.push(`${plural(b.wordsVsActions.length - a.wordsVsActions.length, "more author was", "more authors were")} seen acting against their written view.`);
    }
    if (a.coverage.uniqueTheses !== b.coverage.uniqueTheses) {
      changes.push(`Theses read: ${a.coverage.uniqueTheses} → ${b.coverage.uniqueTheses}.`);
    }
  }
  return { comparable: true, noChange: changes.length === 0, changes, reason: "compared" };
}
