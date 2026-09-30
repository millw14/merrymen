/**
 * THE SOCIAL LAYER — an agent saying what it thinks, in its own words.
 *
 * ── THE TWO LAYERS, AND WHY THE SEAM IS HERE ─────────────────────────────
 *
 * `class-evidence.ts` is the fact layer: measurements, deterministic, auditable,
 * kept on the decision row. This module turns one of those into a sentence a
 * person would actually write, and it is allowed to be conversational about the
 * evidence — it is never allowed to have any evidence the fact layer did not
 * give it.
 *
 * ── HOW THAT IS ENFORCED, since a prompt instruction is not enforcement ──
 *
 * THE MODEL IS NEVER SHOWN A NUMBER. `classEvidenceOf` has already converted
 * every measurement into a word from a closed set — "liquidity thin", "buyers
 * mostly new", "curve early". The prompt carries those words, the ticker and
 * nothing else. There is no depth figure, no trade count, no percentage and no
 * price anywhere in the model's context.
 *
 * That single choice is what makes the check below a TOTAL PREDICATE rather than
 * a fact-checker. A fact-checker has to be right every time and has a false-
 * negative surface that grows with the vocabulary; `admitPost` only has to ask
 * whether a post contains a digit, which is decidable, cheap, and has no
 * judgement in it at all. A model cannot fabricate a figure it was never given,
 * and if it invents one anyway the post is dropped rather than repaired.
 *
 * DROPPED, NOT REPAIRED, and not softened. Redaction implies we understood the
 * string well enough to know what was left of it; we do not. This is the same
 * rule `thesis-policy.ts` applies to an address and for the same reason.
 *
 * ── AND NOT POSTING IS A NORMAL OUTCOME ──────────────────────────────────
 *
 * Every refusal here returns null and the trade is simply not spoken about. The
 * fact layer is still on the row, the deterministic sentence is still published,
 * and the feed is not silent about the trade — only about the agent's view of
 * it. A social layer that must always produce something is a social layer that
 * will eventually produce anything.
 */
import type { ClassEvidence } from "./class-evidence";

/** How many of an agent's own recent posts are weighed for repetition. */
export const VOICE_WINDOW = 6;

/**
 * The longest a post may be.
 *
 * REASON_MAX is 220 because that is where Telegram's `/why` truncates, and a
 * post that is cut mid-word reads as a broken product. A social post is shown in
 * the same places, so it lives under the same ceiling.
 */
export const POST_MAX = 220;

/**
 * THE LENGTH OF A TAKE — what the writer is asked for, and held to.
 *
 * The feed now renders the agent's own post as a row's PRIMARY line, with our
 * deterministic sentence behind it as the "why". A primary line has to be one
 * line: at the 220-character ceiling the writer used to be offered ("one
 * sentence, or two or three if you have more to say") it was a paragraph, and
 * a paragraph is a report. POST_MAX stays the ceiling every surface shares;
 * this is the tighter budget a post is written to.
 */
export const TAKE_MAX = 100;

/**
 * A post has to be a sentence, not a word.
 *
 * Both a length AND a word count, because either alone lets something through:
 * "Interesting." clears a character floor and says nothing, and three very short
 * words clear a word floor and say nothing either.
 */
export const POST_MIN = 20;
export const POST_MIN_WORDS = 4;

/**
 * WHAT THIS AGENT CARES ABOUT — the honest basis for a voice.
 *
 * NOT a persona string, and not a catchphrase. Each of these is a setting the
 * OWNER actually chose, and it is a real statement about disposition: an agent
 * that holds for twenty minutes and one that holds for a day are different
 * traders, and they should not sound alike when they say why they sold.
 *
 * A HONEST LIMITATION, STATED RATHER THAN PAPERED OVER: two agents configured
 * identically will produce the same traits and therefore similar voices, and
 * that is correct. Shogun and SirSendIt are byte-identically configured today —
 * same hold window, same entry size, same graduation exit, same impact ceiling —
 * so nothing here can make them sound different, and inventing a difference
 * would mean inventing a fact about the agent. What separates them over time is
 * `recent`: their own past posts, which diverge as their books do.
 */
export interface Disposition {
  maxHoldSec: number;
  exitAtGraduationPct: number;
  perEntryUsdg: number;
  maxImpactBps: number;
  minDepthUsdg: number;
}

/**
 * Traits, derived RELATIVE TO THE DEFAULTS rather than from absolute numbers.
 *
 * "Acts early" is not a property of a 20-minute hold; it is a property of a hold
 * shorter than the one the product ships. Absolute thresholds here would quietly
 * become a second set of trading opinions nobody signed off on.
 */
export function traitsOf(d: Disposition, defaults: Disposition): string[] {
  const t: string[] = [];
  if (d.maxHoldSec < defaults.maxHoldSec * 0.75) t.push("moves early and does not wait around");
  if (d.maxHoldSec > defaults.maxHoldSec * 1.5) t.push("sits on a position longer than most");
  if (d.maxImpactBps < defaults.maxImpactBps * 0.75) t.push("dislikes pushing a price around");
  if (d.maxImpactBps > defaults.maxImpactBps * 1.5) t.push("will take size even when it moves the market");
  if (d.minDepthUsdg > defaults.minDepthUsdg * 1.5) t.push("wants real liquidity before committing");
  if (d.minDepthUsdg < defaults.minDepthUsdg * 0.75) t.push("will go into thinner things than most");
  if (d.exitAtGraduationPct < defaults.exitAtGraduationPct * 0.9) t.push("leaves well before the curve graduates");
  return t;
}

/** Everything the writer is allowed to know. */
export interface WriterContext {
  name: string;
  evidence: ClassEvidence;
  traits: string[];
  /** This agent's own recent posts, newest first — for not repeating itself. */
  recent: string[];
}

/**
 * The instruction.
 *
 * EXPLICITLY AGAINST A HOUSE STYLE. The failure this is written to avoid is not
 * a bad sentence; it is twenty good sentences with the same skeleton, which is
 * what a feed of one agent printing "X is 0.27 USDG under its equal weight —
 * topping it up from cash" twenty-seven times actually looks like. So the prompt
 * shows no example to copy, and says plainly that sometimes there is nothing
 * worth saying.
 *
 * ONE LINE, A TAKE. It used to offer "one sentence, or two or three if you have
 * more to say" under the 220-character ceiling, and asked for the basis AND the
 * uncertainty — which is a report. The post is now a feed row's primary line,
 * so it is asked for one line under TAKE_MAX, and `admitPost` holds it there.
 */
export function writerPrompt(c: WriterContext): string {
  const bands = Object.values(c.evidence.bands);
  const act = c.evidence.act === "enter" ? "just bought" : "just sold";
  // THE NAME A READER RECOGNISES, when the tape carried one. The id stays the
  // ticker the post is checked against (`admitPost` strips exactly this), so
  // naming the coin changes what a human reads and nothing about what is
  // verified. Absent name, absent clause — never a placeholder.
  const named = c.evidence.displayName
    ? `$${c.evidence.symbol}, the coin that calls itself ${c.evidence.displayName}`
    : `$${c.evidence.symbol}`;
  const lines = [
    `You are ${c.name}, a trader. You ${act} ${named}.`,
    "",
    "This is what you observed, and it is ALL you observed:",
    ...bands.map((b) => `- ${b}`),
    "",
    c.traits.length ? `How you trade: ${c.traits.join("; ")}.` : "",
    c.recent.length
      ? `You recently posted:\n${c.recent.map((r) => `- "${r}"`).join("\n")}\nDo not reuse their shape or their phrasing.`
      : "",
    "",
    // The budget itself is stated under Rules: this block is the one the model
    // reads as what it was told, and it carries no figure of any kind.
    "Write ONE line: your take on it, the way one trader says it to another.",
    "",
    "MOST IMPORTANT: it is a take, not a report. Pick the ONE thing that actually made",
    "up your mind and say what you make of it. Leave the rest out. Do NOT walk through",
    "the list above — a line that recites what you observed is a report, and nobody",
    "reads reports. Say what you think, not what you measured.",
    "",
    "Rules:",
    "- NO numbers, percentages, prices or amounts of any kind. Not one digit.",
    "- Say nothing you were not told above. No prediction, no price target.",
    "- The take rests on what you observed. You may say what would change your mind; never claim that change has happened.",
    "- A completed order is not evidence the view was right. No operational error or inability-to-sell report in place of a thesis.",
    "- No hashtags, no emoji, no @mentions, no links.",
    `- ONE line, under ${TAKE_MAX} characters. No line breaks.`,
    "- Do not start with the ticker or with the word 'Just'.",
    "- Write in your own voice, not in the clipped register of a market summary.",
    "- If there is genuinely nothing worth saying, reply with exactly: PASS",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/**
 * MAY THIS TRADE BE SPOKEN ABOUT AT ALL?
 *
 * The one gate that runs BEFORE any model is called, and the reason it is a
 * named function rather than a condition inside the fill hook: a decision row
 * exists for every intent, including every one the wall turns back, and class
 * entries are re-proposed with a fresh intent every tick. A writer keyed on the
 * decision would post — in the agent's own voice — about a position it never
 * took, once per tick, forever, each one a model call.
 *
 * "landed" and "paper" are the two statuses that mean money actually moved (or
 * was simulated to). Everything else — rejected by the wall, reverted on-chain,
 * submitted and not yet confirmed, or no trade row at all — is not a trade the
 * agent made, and an agent that narrates trades it did not make is the thing
 * this whole layer exists to not be.
 */
export function postableStatus(status: string | null | undefined): boolean {
  return status === "landed" || status === "paper";
}

/** Why a post was refused, for the operator log. Never shown to a reader. */
export type PostRefusal =
  | "passed"
  | "empty"
  | "too-short"
  | "too-long"
  | "not-one-line"
  | "has-digits"
  | "has-address"
  | "has-handle"
  | "unvouched-claim"
  | "repeats-itself";

export interface PostVerdict {
  ok: boolean;
  body?: string;
  refusal?: PostRefusal;
}

/** The same shape `thesis-policy.ts` refuses on, applied one layer earlier. */
const ADDRESSY = /\b(?:0x[0-9a-fA-F]{6,}|rh:[A-Za-z0-9-]{1,64})\b/;
/** A handle or a link would make the agent reachable, or make it endorse someone. */
const HANDLEY = /(^|\s)[@#]\w|https?:\/\//;

/** Words a post may use freely — they carry no claim on their own. */
const STOPWORDS = new Set(
  ("a an and are as at be been but by for from had has have i if in is it its my no not of on or so " +
    "that the their them then there these they this to too was were what when which who will with you your " +
    "me we us our am can could would should might just still now yet only very much more less than into " +
    "out up down over under about after before while because since though although")
    .split(" "),
);

/**
 * Normalise for comparison: lower case, letters and spaces only.
 *
 * Deliberately lossy. Two posts differing only in ticker and punctuation are the
 * same post for the purpose of "is this agent repeating itself", and that is the
 * whole question being asked.
 */
function shapeOf(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Overlap between two posts' content words, 0..1. */
export function similarity(a: string, b: string): number {
  const A = new Set(shapeOf(a));
  const B = new Set(shapeOf(b));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/**
 * How similar to a recent post is too similar.
 *
 * 0.6 of the SHORTER post's content words. Chosen so that two posts about the
 * same kind of trade may share their vocabulary — they are about the same thing
 * — while a template with the ticker swapped cannot pass.
 */
export const REPEAT_LIMIT = 0.6;

/**
 * THE GATE. Total, decidable, and it never repairs.
 *
 * `vouched` is every word the evidence layer could have produced, plus the
 * ticker. Content words outside it are the model's own — which is fine and is
 * the point, since we asked for a human sentence — so the check is NOT "every
 * word came from evidence". It is narrower and much harder to argue with: no
 * digits at all, no address, no handle, and no quantity word that implies a
 * measurement the agent was never given.
 */
export function admitPost(raw: string, c: WriterContext): PostVerdict {
  const body = raw.trim().replace(/^["']|["']$/g, "").trim();

  // A model deciding there is nothing to say is a SUCCESS of the design, not a
  // failure of the call. It is the "sometimes it should not post at all" case.
  if (/^PASS\b/i.test(body)) return { ok: false, refusal: "passed" };
  if (body.length === 0) return { ok: false, refusal: "empty" };
  // LENGTH BEFORE WORD COUNT. A 300-character single word is over the ceiling,
  // not under the floor, and filing it as "too-short" would send whoever reads
  // the refusal log looking in precisely the wrong direction.
  //
  // THE TAKE'S BUDGET, not the surfaces' ceiling: the writer was asked for one
  // line under TAKE_MAX, and a prompt instruction is not enforcement. Refused,
  // not cut — the same rule as everything else here.
  if (body.length > TAKE_MAX) return { ok: false, refusal: "too-long" };
  // One line. A second line is a second thought, and a primary line that wraps
  // into two is a paragraph. (The trim above has already taken a trailing
  // newline off, so only a break INSIDE the post reaches this.)
  if (/[\r\n]/.test(body)) return { ok: false, refusal: "not-one-line" };
  if (body.length < POST_MIN || body.split(/\s+/).filter(Boolean).length < POST_MIN_WORDS) {
    return { ok: false, refusal: "too-short" };
  }

  /**
   * THE ADDRESS CHECK RUNS BEFORE THE DIGIT CHECK, and the order is not
   * cosmetic. Every `0x…` contains a digit, so after a digit check the address
   * arm would be unreachable and every doxxed counterparty would be filed as
   * "has-digits" in the operator log — a refusal that says the wrong thing
   * about why, on the one case where knowing why matters most.
   */
  if (ADDRESSY.test(body)) return { ok: false, refusal: "has-address" };
  if (HANDLEY.test(body)) return { ok: false, refusal: "has-handle" };

  /**
   * NOT ONE DIGIT, and this is the load-bearing line in the module.
   *
   * The model was shown no figures, so any digit in its output was invented.
   * Checking the FINAL string rather than the model's raw output matters: a
   * ticker is substituted from evidence and `sanitizeSymbol` permits digits, so
   * a launch called MOON100X would smuggle "100" past a check that ran earlier.
   * The ticker is stripped first and then the rest must be digit-free.
   */
  const withoutTicker = body.replaceAll(new RegExp(escapeRe(c.evidence.symbol), "gi"), " ");
  if (/\d/.test(withoutTicker)) return { ok: false, refusal: "has-digits" };

  /**
   * SPELLED-OUT QUANTITIES ARE STILL QUANTITIES. "forty buyers" carries exactly
   * the claim "40 buyers" does and walks straight through a digit check.
   *
   * "ONE" IS DELIBERATELY NOT ON THIS LIST, and leaving it off cost a rewrite to
   * work out. As a quantity it is nearly worthless — nobody smuggles a
   * measurement as "one" — and as a PRONOUN it is one of the commonest words in
   * the kind of sentence this feature exists to produce: "watching this one",
   * "hitting it once and leaving". Including it rejected almost every honest
   * post while catching nothing, which is the worst trade a filter can make: it
   * would have read as the writer being broken rather than as the gate being
   * strict, and the fix somebody reached for would have been to loosen the gate.
   */
  if (
    /\b(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|dozen|hundred|thousand|million|billion|percent|per cent)\b/i.test(
      withoutTicker,
    )
  ) {
    return { ok: false, refusal: "unvouched-claim" };
  }

  for (const prev of c.recent) {
    if (similarity(body, prev) >= REPEAT_LIMIT) return { ok: false, refusal: "repeats-itself" };
  }

  return { ok: true, body };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
