/**
 * WHAT BRAIN IS ALLOWED TO KNOW, AND WHAT IT ACTUALLY DOES.
 *
 * The first production shadow decisions all said the same thing:
 *
 *   "All analyst lenses report no data for TSLA; the only price point is stale
 *    and unreliable. With no recent market, news, sentiment or fundamentals,
 *    there is no actionable evidence to take a position."
 *
 * That is the correct answer to the question it was asked, and it means the
 * evaluation was measuring the wrong thing: whether Brain refuses to invent,
 * rather than whether Brain reasons. It refuses to invent. Now give it
 * something to reason about.
 *
 * THE RULE IS UNCHANGED — a lens with nothing gets NOTHING, never a plausible
 * sentence. `news` and `fundamentals` stay absent because the worker has no
 * honest source for either on this chain, and an omitted lens makes Brain
 * answer NO DATA AVAILABLE, which is true. What this module adds is the
 * material the worker genuinely holds and was simply not sending.
 *
 * MEMORY ARRIVES ALREADY THROUGH THE PUBLICATION GATE, and that is the
 * load-bearing decision here. The raw `decisions` table is not safe text: a
 * `chat`-sourced row embeds a raw counterparty address by template, on every
 * chat transfer, and `dropped_rule` is a template with a model-supplied hole in
 * it. Feeding either straight into a prompt would put an owner's counterparties
 * into a model's context and then into `signals_json`, where the next prompt
 * reads them back.
 *
 * So the rule is: AN AGENT MAY REMEMBER WHAT IT COULD HAVE SAID IN PUBLIC.
 * The orchestrator materialises exactly that — the same `publishableThesis`
 * output the feed publishes, with its source allowlist, its 220-character cap
 * on model prose, its address backstop and its fail-closed default — into the
 * child's peer file. This module renders it and adds nothing, so memory cannot
 * drift from publication, and a new decision source stays unreadable by Brain
 * until somebody classifies it. That is the correct default for a field which,
 * if it is ever wrong, is wrong permanently.
 *
 * Everything here is bounded on length as well as on source, because this text
 * is billed by the token on every analyst call, and prompt size is the real
 * cost driver — not call count.
 */

import type { PublicThesis } from "./thesis-policy";

/** How many past decisions Brain is reminded of. */
const MEMORY_LINES = 6;
/** How many peer voices reach the sentiment lens. */
const PEER_LINES = 5;
/** Hard ceiling per lens. A dossier is billed on every analyst call. */
const LENS_MAX = 1200;

export interface FocusView {
  symbol: string;
  priceUsd: string;
  priceSource: string;
  priceStale: boolean;
  /** Micro-USDG held in this instrument. Zero when it is a candidate to open. */
  valueUsdg: number;
  /**
   * Does the book already hold this?
   *
   * "You hold 65% of the book in this" and "you hold none of this" are
   * different questions, and a run that did not say which was which would let a
   * model narrate a position that does not exist — then publish a thesis about
   * trimming something it never owned.
   */
  held: boolean;
  equityUsdg: number;
  cashUsdg: number;
  /** How many names the book holds, this one included when it is held. */
  positionCount: number;
}

const usdg = (micro: number): string => (micro / 1e6).toFixed(2);

/**
 * The technical lens, from what the worker can see without asking anybody.
 *
 * Staleness is stated rather than hidden. A model told the price is stale and
 * left to guess how stale will assume the number is usable; told plainly, it
 * discounts it — and the first production run proves it does, because that is
 * exactly what it did with the one line it had.
 */
/**
 * Where this instrument sits in THIS book — separate from what the market did.
 *
 * Split out because the two travel together but come from different places: the
 * market series is the oracle's, the book is ours. When a real price series is
 * available the series renderer states the price and the history, and this
 * states the exposure; without one, `technicalLine` states both. Neither path
 * may drop the book, because "should I trim this" and "should I open this" are
 * different questions and the answer depends on which one it is.
 */
export function positionContext(f: FocusView): string {
  const share = f.equityUsdg > 0 ? (f.valueUsdg / f.equityUsdg) * 100 : 0;
  const position = f.held
    ? `The book holds ${usdg(f.valueUsdg)} USDG of ${f.symbol}, which is ` +
      `${share.toFixed(1)}% of ${usdg(f.equityUsdg)} USDG total equity, ` +
      `across ${f.positionCount} position${f.positionCount === 1 ? "" : "s"}.`
    : `The book holds NONE of ${f.symbol}. This is a candidate to open, not a ` +
      `position to manage, and the only actions available are to buy it or to stay out. ` +
      `Total equity is ${usdg(f.equityUsdg)} USDG across ` +
      `${f.positionCount} position${f.positionCount === 1 ? "" : "s"}.`;
  return `${position} Uncommitted cash is ${usdg(f.cashUsdg)} USDG.`;
}

export function technicalLine(f: FocusView): string {
  const share = f.equityUsdg > 0 ? (f.valueUsdg / f.equityUsdg) * 100 : 0;
  // HELD AND UNHELD ARE DIFFERENT QUESTIONS, and the sentence has to say which.
  // A book with nothing in it that was told "the book holds 0.00 USDG of NVDA,
  // which is 0.0% of 0.00 USDG total equity" would be technically true and
  // useless; worse, it invites a model to reason about trimming a position that
  // does not exist.
  const position = f.held
    ? `The book holds ${usdg(f.valueUsdg)} USDG of ${f.symbol}, which is ` +
      `${share.toFixed(1)}% of ${usdg(f.equityUsdg)} USDG total equity, ` +
      `across ${f.positionCount} position${f.positionCount === 1 ? "" : "s"}.`
    : `The book holds NONE of ${f.symbol}. This is a candidate to open, not a ` +
      `position to manage, and the only actions available are to buy it or to stay out. ` +
      `Total equity is ${usdg(f.equityUsdg)} USDG across ` +
      `${f.positionCount} position${f.positionCount === 1 ? "" : "s"}.`;
  const parts = [
    `${f.symbol} marked at ${f.priceUsd} USD from ${f.priceSource}` +
      (f.priceStale ? " — STALE, treat this price as unreliable" : "") +
      ".",
    position,
    `Uncommitted cash is ${usdg(f.cashUsdg)} USDG.`,
  ];
  // WHY CONCENTRATION IS STATED AND NOT SCORED. "84% of the book is in one
  // name" is a fact the worker knows; "that is too concentrated" is a judgement
  // the risk side is there to make. Handing the model a verdict dressed as an
  // input is how a signal starts deciding.
  return parts.join(" ").slice(0, LENS_MAX);
}

/**
 * What other Merrymen have published, as the sentiment lens.
 *
 * These are real opinions from real agents on the same chain, and they are the
 * only genuine sentiment source this fleet has. They arrive having already
 * passed `publishableThesis` on the orchestrator's side, so they carry no
 * address and no unclassified source — and Brain fences them as untrusted
 * before any model sees them, which is what makes it safe to pass another
 * model's words into a prompt at all.
 *
 * SAME NAME FIRST, then the rest. A peer talking about the instrument under
 * consideration is evidence; a peer talking about something else is context,
 * and context that crowds out evidence is just cost.
 */
export function sentimentLine(peers: readonly PublicThesis[], symbol: string): string | null {
  if (!peers.length) return null;
  const want = symbol.trim().toUpperCase();
  const onName = peers.filter((p) => (p.symbol ?? "").toUpperCase() === want);
  const rest = peers.filter((p) => (p.symbol ?? "").toUpperCase() !== want);
  const chosen = [...onName, ...rest].slice(0, PEER_LINES);
  if (!chosen.length) return null;

  const lines = chosen.map((p) => {
    // `head` already carries the conditional for a shadow post — "would buy
    // TSLA 5.00 USDG" — so a peer that only thought about a trade is never
    // reported to Brain as one that made it.
    const what = [p.head, p.outcomeText].filter(Boolean).join(" · ");
    const why = (p.reason ?? "").trim();
    return `${p.name}: ${what}${why ? ` — "${why}"` : ""}`;
  });

  return (
    `Other Merrymen on this chain have published these views (${onName.length} about ${want}):\n` +
    lines.join("\n")
  ).slice(0, LENS_MAX);
}

/**
 * What this agent thought before, and what came of it.
 *
 * THROUGH THE PUBLICATION GATE — see the module comment. The outcome is the
 * half that makes memory worth having: "I said buy and it landed" and "I said
 * buy and the wall refused it" are different lessons, and a thesis remembered
 * without its ending teaches nothing.
 */
export function memoryLines(
  own: readonly PublicThesis[],
  now: number,
): string[] {
  const out: string[] = [];
  for (const t of own) {
    const age = Math.max(0, Math.floor((now - (t.at || now)) / 60));
    const when = age < 90 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
    const said = t.said > 1 ? ` (said ${t.said}×)` : "";
    out.push(
      `${when}${said}: ${t.head || "a view"} · ${t.outcomeText}${t.reason ? ` — "${t.reason}"` : ""}`,
    );
    if (out.length >= MEMORY_LINES) break;
  }
  return out;
}
