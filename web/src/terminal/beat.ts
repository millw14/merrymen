import { sizeOf, type LiveAgent, type Thesis } from "./live";
import { strategyForSlug, type StrategyId } from "./strategy";
import { takeFor } from "./why";

export type Action = "buy" | "sell" | "hold";

export interface Actor {
  slug: string;
  name: string;
  handle: string;
  strategy: StrategyId;
}

interface Core {
  /** The RENDER key: stable within one read, and it moves when the post does. */
  id: string;
  /**
   * The LIKE key: stable across reads, and it does not move when the post's
   * outcome does. Null when the agent has no public slug.
   *
   * Two ids because they answer two questions. `id` has `at` in it, which is
   * exactly what a React key wants and exactly what a like must not have —
   * `read-theses.ts` groups on `MAX(d.at)` and the default strategy re-proposes
   * every tick, so `id` advances every few minutes on a post nobody touched.
   */
  postId: string | null;
  at: number;
  actor: Actor;
  /** The agent's own take, already run through `takeFor`. May be empty. */
  reason: string;
  sizeUsd: number | null;
  /**
   * NOTHING CAME OF IT, AND NOTHING COULD HAVE.
   *
   * Carried onto the beat because the rail renders a sentence and the verb is
   * the part that makes the claim. A shadow decision is a real row with a real
   * action and a real size — thesis-policy.ts calls it "indistinguishable, to
   * every gate below, from a real buy" — so a rail reading only `action`
   * published "@robin bought TSLA" about a decision that never reached an
   * executor. worker/src/brain-disconnected.test.ts pins this as a product
   * invariant, not a wording preference.
   */
  shadow: boolean;
  /**
   * IT HAPPENED, WITH PRETEND MONEY.
   *
   * Reported from the beta in one sentence: "In the feed it says I've bought
   * things but nothing shows in my portfolio." Both halves were true. The fill
   * was real on a paper book; the portfolio reads the funded one.
   *
   * `paperTradingEnabled` defaults TRUE, so most of the fleet is pretend money
   * — read-theses.ts says exactly that where it deliberately KEEPS paper
   * agents in the feed, because excluding them emptied it. Its comment says
   * they post "labelled", and `PublicThesis.paper` has carried the flag all
   * along. THE RAIL WAS THE ONE SURFACE THAT NEVER READ IT: ThesisCard,
   * Profile, Agent, the alerts rail and the token seats all draw a paper
   * marker; the feed printed "@robin bought TSLA" and stopped.
   *
   * Same class of defect as `shadow` above, and here for the same reason — the
   * rail lays the facts out itself, so it must make the distinction rather
   * than inherit it. It differs in WHERE the falsehood sits: `shadow` makes
   * the verb wrong, whereas a paper fill's verb is right and what misleads is
   * the consequence a reader draws from it. So this does not touch `verbOf`;
   * it is stated beside the sentence instead.
   */
  paper: boolean;
}

/**
 * One thing an agent did OR SAID, at a time. Attribution is not optional: a
 * beat with nobody attached cannot be built.
 *
 * TWO ARMS BECAUSE THERE ARE TWO CLAIMS. A trade has a verb, a symbol and a
 * direction, and `verbOf` builds a sentence out of them. A view has none of
 * those — a hold, or a thesis about the market with no instrument attached —
 * and the only honest sentence for it is the one the PUBLISHER wrote, because
 * the publisher is the thing that knows what happened. Giving a view an
 * `action` and letting the rail conjugate it is how "@robin bought TSLA"
 * appears under a decision that bought nothing.
 *
 * `chorus` is gone. It was declared, rendered and never constructed —
 * `beatsOf` only ever emitted `trade` — so the branch in wire.tsx, the parts
 * list and `FacesOn` were all dead weight standing in the way of this change.
 */
export type Beat =
  | (Core & { kind: "trade"; action: Action; symbol: string })
  | (Core & {
      kind: "view";
      /**
       * The publisher's own sentence, rendered verbatim.
       *
       * Never rebuilt from `action`: `head` is where the conditional lives
       * ("would buy TSLA 5.00 USDG"), and honesty.test.ts pins that no
       * terminal module conjugates a past-tense verb without consulting
       * `shadow`. A view has no verb of its own, so it borrows none.
       */
      head: string;
      /** Present when the view is about something, absent when it is not. */
      symbol: string | null;
    });

/** What the rail draws, top to bottom. Presentation, not domain. */
export type Lane =
  | { kind: "beat"; id: string; beat: Beat }
  | { kind: "lull"; id: string; ms: number };

/**
 * The verb, and the conditional that has to survive into it.
 *
 * "would buy" and "bought" are the difference between a stated intention and a
 * trade, and this is the one string on the rail that decides which a reader
 * sees. The publisher already bakes the conditional into `head` for exactly
 * this reason; the rail lays the facts out itself, so it has to make the same
 * distinction rather than inherit it.
 *
 * TAKES A TRADE, NOT A BEAT. A view has no direction to conjugate, and a
 * signature that accepted one would invite exactly the fallback this function
 * exists to prevent.
 */
export function verbOf(b: Extract<Beat, { kind: "trade" }>): string {
  if (b.shadow) return `would ${b.action}`;
  switch (b.action) {
    case "buy":
      return "bought";
    case "sell":
      return "sold";
    case "hold":
      return "is holding";
    default: {
      const _x: never = b.action;
      return _x;
    }
  }
}

export function whoOf(b: Beat): string {
  return b.actor.handle;
}

function actorOf(t: Thesis, agents: Map<string, LiveAgent>): Actor | null {
  const slug = t.slug;
  if (!slug) return null;
  return {
    slug,
    name: t.name,
    handle: t.handle ?? t.name,
    strategy: strategyForSlug(slug, agents.get(slug)?.glance.id),
  };
}

/**
 * THE FEED USED TO DROP MOST OF WHAT THE AGENTS SAID.
 *
 * `if (action !== "buy" && action !== "sell") continue` threw away every hold
 * and every pure thesis — rows that already pass the publish gate with
 * `outcome: "view"`, already carry the agent's reasoning, and are most of what
 * a strategist produces on a quiet day. The owner's complaint was that nothing
 * happens on the feed; a large part of what was happening was being filtered
 * out one line above the renderer.
 *
 * Widening it roughly doubles the feed on its own, before any change to how
 * often agents post.
 */
export function beatsOf(theses: Thesis[], agents: LiveAgent[]): Beat[] {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const out: Beat[] = [];

  for (const t of theses) {
    if (t.at == null) continue;
    const actor = actorOf(t, bySlug);
    if (!actor) continue;
    const at = t.at;
    const reason = takeFor(t.reason, bySlug.get(actor.slug)?.thesis);
    // Carried from the published row. `shadow` is set by the publisher; the
    // `outcome` check is the belt to it, for a row written before the flag
    // existed.
    const shadow = t.shadow === true || t.outcome === "shadow";
    // Straight from the published post — the publisher sets it from the
    // agent's mode at its last heartbeat. Nothing here re-derives it.
    const paper = t.paper === true;
    const sizeUsd = sizeOf(t);
    // Carried, never derived here: it is a hash of the ROW as the server read
    // it, including a `source` the published post does not carry.
    const postId = t.postId ?? null;
    const action = t.action;

    if ((action === "buy" || action === "sell") && t.symbol) {
      const symbol = t.symbol.toUpperCase();
      out.push({
        kind: "trade",
        id: `${symbol}-${action}-${actor.slug}-${at}`,
        postId,
        at,
        actor,
        reason,
        sizeUsd,
        shadow,
        paper,
        action,
        symbol,
      });
      continue;
    }

    // A VIEW NEEDS WORDS OR IT IS NOTHING. `head` is the publisher's sentence
    // and the only thing a view is rendered from; with neither it nor a reason
    // there is no post, just a row.
    const head = t.head.trim();
    if (!head && !reason) continue;
    const symbol = t.symbol ? t.symbol.toUpperCase() : null;
    out.push({
      kind: "view",
      id: `view-${actor.slug}-${at}-${symbol ?? ""}`,
      postId,
      at,
      actor,
      reason,
      sizeUsd,
      shadow,
      paper,
      head,
      symbol,
    });
  }

  out.sort((a, b) => b.at - a.at);
  return out;
}

const LULL_MS = 3 * 3_600_000;

export function lanesOf(beats: Beat[]): Lane[] {
  const out: Lane[] = [];

  beats.forEach((beat, i) => {
    const prev = beats[i - 1];
    const gap = prev ? prev.at - beat.at : 0;
    if (gap >= LULL_MS) out.push({ kind: "lull", id: `lull-${beat.id}`, ms: gap });
    out.push({ kind: "beat", id: beat.id, beat });
  });

  return out;
}

/** Returns over a slice of the tail of the curve, in bps. */
export function curveReturn(curve: number[], points: number): number | null {
  if (curve.length < 2) return null;
  const slice = curve.slice(-Math.max(2, Math.min(points, curve.length)));
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  if (first === 0) return null;
  return ((last - first) / first) * 10000;
}
