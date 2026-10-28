import { xWeightedLength, X_MAX_WEIGHTED } from "./client";
import { hash32, type SaleOutcome } from "./planner";

/** Old scheduled rows remain verifiable against fresh receipt evidence. */
const LEGACY_RESULT = {
  profit: "gross gain before fees and gas. pleased with that part.",
  loss: "gross loss before fees and gas. not my finest call.",
  flat: "flat before fees and gas. no victory lap.",
} as const;

export const SALE_TAGS = [
  "{f} gross before fees and gas",
  "{f} gross, before fees and gas",
  "that's {f} gross before fees and gas",
  "{f} on that one, gross before fees and gas",
  "the receipt: {f} gross before fees and gas",
  "on the sale: {f} gross before fees and gas",
] as const;

/** Reactions describe only the measured gross result, never the net result or an exit. */
export const SALE_REACTIONS = {
  small: [""],
  modest: ["fair enough", "a modest nod", "a modest smile", "a small smile", "quietly noted", "a gentle thumbs up", "a little brighter", "a pleasant detail", "a muted cheer", "a soft grin", "i can nod at that", "reason for a smile", "a welcome detail", "a tiny cheer", "a quiet thumbs up", "a subdued yay"],
  solid: ["that earns a grin", "a welcome surprise", "a cheerful footnote", "that feels good", "a brighter note", "i like that detail", "a grin from me", "a happy aside", "that gets a smile", "a pleasing number", "a reason to grin", "cheery about that", "feeling pleased", "a nod and a smile", "a smile at the receipt", "pleasant to read"],
  large: ["a proper eyebrow raise", "well, hello there", "that got my attention", "a rather big grin", "okay, that's something", "a double take from me", "that deserves a pause", "a cheerful eyebrow lift", "a very welcome detail", "hard to miss that", "a smile at that figure", "quite the footnote", "a decidedly happy aside", "that reads rather well", "a wider grin here", "a moment to appreciate"],
  loss: ["taking note", "a sober footnote", "no cheering here", "not a cheerful read", "an unwelcome detail", "a quiet sigh", "that stings", "a tough read", "no grin from me", "a muted reaction", "a sobering number", "a rough note", "a frown at that", "a candid footnote", "hard to cheer", "a rueful nod"],
  flat: ["", "an even reading", "a neutral footnote", "no cheering here", "a quiet shrug", "a level reading", "neither cheer nor sigh", "a muted reaction", "plainly noted", "a calm footnote", "a neutral nod", "no fanfare here", "an unexciting detail", "no grin or frown", "a subdued note", "a simple shrug"],
} as const;
export type SaleBand = keyof typeof SALE_REACTIONS;
export interface SaleOutcomeOptions {
  seed?: string;
  /** Newest-first own sale bodies; only their last ten reactions matter. */
  recentSales?: readonly string[];
  /** Exact already-verified disclosure, still counted conservatively as raw text. */
  suffix?: string;
}

/** Explicit sign, whole percent from ten up, one decimal under ten. */
export function gainFigure(pct: number | null | undefined): string | null {
  if (typeof pct !== "number" || !Number.isFinite(pct) || Math.abs(pct) >= 1e7) return null;
  const abs = Math.abs(pct);
  if (abs < 0.05) return null;
  const shown = abs >= 10 ? Math.round(abs).toLocaleString("en-US") : abs.toFixed(1).replace(/\.0$/, "");
  return `${pct < 0 ? "-" : "+"}${shown}%`;
}

export function saleBand(outcome: SaleOutcome, gainPct?: number | null): SaleBand {
  if (outcome === "flat") return "flat";
  // No celebration without a measurable gross figure, including tiny losses.
  if (typeof gainPct !== "number" || !Number.isFinite(gainPct) || Math.abs(gainPct) < 1) return "small";
  if (outcome === "loss") return "loss";
  return gainPct < 10 ? "modest" : gainPct < 50 ? "solid" : "large";
}

function evidenceAgrees(outcome: SaleOutcome, gainPct?: number | null): boolean {
  if (!(outcome === "unknown" || Object.hasOwn(LEGACY_RESULT, outcome))) return false;
  if (gainPct == null) return true;
  if (!Number.isFinite(gainPct) || Math.abs(gainPct) >= 1e7) return false;
  return outcome === "unknown" || (outcome === "profit" ? gainPct > 0 : outcome === "loss" ? gainPct < 0 : gainPct === 0);
}

function tagsFor(outcome: SaleOutcome, gainPct?: number | null): string[] {
  if (!evidenceAgrees(outcome, gainPct) || outcome === "unknown") return [];
  const figure = gainFigure(gainPct);
  // Without a publishable figure, never imply the exact result was zero.
  const f = outcome === "flat" ? "flat" : figure ?? (outcome === "profit" ? "a gain" : "a loss");
  return SALE_TAGS.map((tag) => tag.replace("{f}", f));
}

function legacyLine(outcome: Exclude<SaleOutcome, "unknown">, gainPct?: number | null): string {
  const figure = outcome === "flat" ? null : gainFigure(gainPct);
  return `${figure ? `${figure} ` : ""}${LEGACY_RESULT[outcome]}`;
}

/** Every allowed exact string for this fresh result; no model-authored suffixes. */
export function saleOutcomeLines(outcome: SaleOutcome, gainPct?: number | null): string[] {
  return tagsFor(outcome, gainPct).flatMap((tag) => [tag, ...SALE_REACTIONS[saleBand(outcome, gainPct)].filter(Boolean).map((reaction) => `${tag}. ${reaction}`)]);
}

/** Strip only result lines, before a post's public-token disclosure. */
export function withoutSaleOutcome(body: string): string {
  return body.split("\n").filter((line) => !line.includes("before fees and gas")).join("\n").trim();
}

/** Largest safe prose budget; the final append still checks the entire weighted post. */
export function saleWordBudget(outcome: SaleOutcome, gainPct?: number | null, suffix = "", margin = 0): number {
  if (!evidenceAgrees(outcome, gainPct)) return 0;
  const tags = tagsFor(outcome, gainPct);
  const reserve = outcome === "unknown" ? 0 : Math.min(...tags.map(xWeightedLength)) + 1;
  return Math.max(0, X_MAX_WEIGHTED - xWeightedLength(suffix) - reserve - Math.max(0, margin));
}

/** Seeded exact tags; recent reactions are skipped, and a tag alone is always an option. */
export function appendSaleOutcome(body: string, outcome: SaleOutcome, gainPct?: number | null, opts: SaleOutcomeOptions = {}): string | null {
  if (!evidenceAgrees(outcome, gainPct)) return null;
  const words = body.trim();
  if (words.includes("before fees and gas")) return null;
  const suffix = opts.suffix ?? "";
  if (outcome === "unknown") return xWeightedLength(words + suffix) <= X_MAX_WEIGHTED ? words : null;
  const tags = tagsFor(outcome, gainPct);
  const reactions: readonly string[] = SALE_REACTIONS[saleBand(outcome, gainPct)];
  const recent = (opts.recentSales ?? []).filter((text) => text.includes("before fees and gas")).slice(0, 10);
  const start = hash32(`sale-tag|${opts.seed ?? words}`) % tags.length;
  const reactionStart = hash32(`sale-reaction|${opts.seed ?? words}`) % reactions.length;
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[(start + i) % tags.length]!;
    for (let j = 0; j < reactions.length; j++) {
      const reaction = reactions[(reactionStart + j) % reactions.length]!;
      if (!reaction || recent.some((text) => text.split("\n").some((line) => line.endsWith(`. ${reaction}`)))) continue;
      const text = `${words}\n${tag}. ${reaction}`;
      if (xWeightedLength(text + suffix) <= X_MAX_WEIGHTED) return text;
    }
    const text = `${words}\n${tag}`;
    if (xWeightedLength(text + suffix) <= X_MAX_WEIGHTED) return text;
  }
  return null;
}

/** Fresh evidence must match the complete result line, including its reaction band. */
export function hasSaleOutcome(body: string, outcome: SaleOutcome, gainPct?: number | null): boolean {
  if (!evidenceAgrees(outcome, gainPct)) return false;
  const resultLines = body.split("\n").filter((line) => line.includes("before fees and gas"));
  if (outcome === "unknown") return resultLines.length === 0;
  if (resultLines.length !== 1 || !body.includes(`\n${resultLines[0]}`)) return false;
  const allowed = new Set([...saleOutcomeLines(outcome, gainPct), legacyLine(outcome, gainPct)]);
  return allowed.has(resultLines[0]!);
}
