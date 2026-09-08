/**
 * The memecoin scout — a language model deciding what NOT to look at.
 *
 * WHAT IT IS FOR. GeckoTerminal returns far more tokens than the agent should
 * ever consider, and the cheap screen (`venues/geckoterminal.ts`) can only test
 * numbers. Whether a pool that passed the screen is a pump being distributed
 * into, a token whose whole 24h volume is two wallets, or something with real
 * participation is a judgement about a pattern, and that is what a model is
 * actually good for. This is that step.
 *
 * WHAT IT MAY DO. Narrow. Only ever narrow. The plan's rule is that the model
 * must not be able to propose a token the owner has not covered, and a prompt
 * saying "only choose from this list" is not that guarantee — it is a request.
 * Two structural properties make it one:
 *
 *   1. THE MODEL NEVER SEES AN ADDRESS. Candidates go out as an index, a label
 *      and numbers. There is no address in the prompt, so there is no address
 *      to emit, mangle or invent — the failure mode where a model returns a
 *      plausible-looking token that does not exist cannot arise here.
 *   2. IT ANSWERS IN INDICES INTO THE LIST IT WAS GIVEN. `applyVerdicts` maps
 *      those back to pools this process already had. An index out of range is
 *      dropped, not clamped; a repeated index is counted once. The output is a
 *      SUBSET of the input by construction rather than by good behaviour.
 *
 * So the worst a compromised, confused or prompt-injected model can do is
 * choose badly among tokens the deterministic screen already admitted, or
 * choose nothing. It cannot reach a token that was not offered. Downstream, the
 * scout budget and the wall are still the boundary — this layer does not size
 * anything, does not price anything, and cannot approve a trade.
 *
 * Ranking is advisory. Nothing here is a safety check, and a high conviction
 * score is not a permission.
 */

import { llmToolCall, type LlmCreds } from "../llm";
import type { GeckoPool } from "../venues/geckoterminal";
import type { ScoutSiteFields } from "./coin-research";
import { sanitizeMeta } from "../venues/pons-meta";

/**
 * One candidate as the MODEL sees it — a label and numbers, no address.
 *
 * Field names are spelled out rather than abbreviated because they are read by
 * something that has only this text to go on, and `b24`/`s24` would invite a
 * guess about which is which.
 */
export interface ScoutCandidate {
  index: number;
  label: string;
  venue: string;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  fdvUsd: number | null;
  change1hPct: number | null;
  change24hPct: number | null;
  buys24h: number | null;
  sells24h: number | null;
  distinctBuyers24h: number | null;
  ageDays: number | null;
  /**
   * What its own website said, when there was one to visit.
   *
   * Booleans and counts, never the page text: launcher-written prose handed to
   * a model is an instruction channel, and `siteHypeWords: 3` is a number it can
   * weigh and cannot be told by. null everywhere means nothing was published or
   * nothing was visited — which reads differently from visited-and-empty.
   */
  siteReachable: boolean | null;
  siteNamesContract: boolean | null;
  siteTextLength: number | null;
  siteOutboundDomains: number | null;
  siteHypeWords: number | null;
  publishedNothing: boolean | null;
}

/** What the model returns about one candidate. */
export interface ScoutVerdict {
  index: number;
  /** 1..5. Advisory ordering only — never a size and never a permission. */
  conviction: number;
  reason: string;
}

/** A pool the scout kept, with the model's stated ordering and rationale. */
export interface ScoutPick {
  pool: GeckoPool;
  conviction: number;
  reason: string;
}

export interface ScoutResult {
  picks: ScoutPick[];
  /** Offered but not chosen — kept so the owner can see what was passed over. */
  passed: GeckoPool[];
  /**
   * Answers that referred to nothing real, verbatim, for the log.
   *
   * Surfaced rather than swallowed: an index the model made up is the signature
   * of a model that has stopped tracking its input, and silently discarding it
   * would hide the one symptom worth alerting on.
   */
  ignored: string[];
  /**
   * The model could not be reached or refused.
   *
   * Failing closed is right — this step exists to CUT a list down, so an
   * unranked list must not pass through. But closed-because-broken and
   * closed-because-nothing-was-worth-picking are different facts, and without
   * this flag a provider outage reads on every surface as a considered pass.
   */
  failed?: boolean;
}

/** Project pools into the model's view. Index is position in `pools`. */
export function toScoutCandidates(
  pools: readonly GeckoPool[],
  nowSec: number,
  research?: ReadonlyMap<string, ScoutSiteFields>,
): ScoutCandidate[] {
  return pools.map((p, index) => ({
    index,
    // The pool's own name, which is a label the INDEX already disambiguates.
    // Deliberately not the token address: see the header.
    //
    // SANITISED AND BOUNDED, because this is the ONE attacker-controlled string
    // that reaches the prompt. `p.name` is whatever the launcher typed, relayed
    // by GeckoTerminal and never inspected — Vex measured a live baseToken.name
    // of 34,090 characters. JSON.stringify at the call site escapes C0 and
    // nothing else, so invisibles arrived verbatim; and with no length cap at
    // all, one such name blows the 8,000 TPM budget that SCOUT_MAX_CANDIDATES
    // exists to stay inside. That failure has the dangerous shape: the request
    // 413s, the catch below fails closed, and a gate slammed shut by one
    // hostile name reads on every surface as "nothing was worth picking".
    label: sanitizeMeta(p.name ?? "", SCOUT_LABEL_MAX) || `#${index}`,
    venue: p.dex,
    liquidityUsd: p.reserveUsd,
    volume24hUsd: p.volume24hUsd,
    fdvUsd: p.fdvUsd,
    change1hPct: p.change1hPct,
    change24hPct: p.change24hPct,
    buys24h: p.buys24h,
    sells24h: p.sells24h,
    distinctBuyers24h: p.buyers24h,
    ageDays: p.createdAt === null ? null : Math.max(0, (nowSec - p.createdAt) / 86_400),
    ...(research?.get(p.tokenAddress.toLowerCase()) ?? {
      siteReachable: null,
      siteNamesContract: null,
      siteTextLength: null,
      siteOutboundDomains: null,
      siteHypeWords: null,
      publishedNothing: null,
    }),
  }));
}

const SYSTEM = `You are a scout for a memecoin trading agent on Robinhood Chain. Tokens here
launch on the Pons bonding-curve launchpad and graduate to Uniswap pools; they trade 24/7.

You are given candidates that ALREADY passed a liquidity and activity screen. Your job is to
NARROW them — to say which few are worth a closer, more expensive look, and why. You are not
sizing a position, not deciding to buy, and not judging safety; a separate on-chain policy
decides what can be traded at all and how much. Assume anything you pass through will be
checked again.

Answer only via the rank_candidates tool, referring to candidates by their integer "index".
Never invent an index. Returning an empty list is a valid and often correct answer — a
chain with nothing worth trading is normal, and a forced pick is worse than no pick.

What is worth weight:
- Participation. distinctBuyers24h is much harder to fake than buys24h. Many trades between
  few wallets is wash trading, not interest; treat a high buys/buyer ratio as a warning.
- Sustainability. Volume far above liquidity means the pool is being churned. An FDV far
  above liquidity means most of the supply has never been sold into this pool and could be.
- Direction over two horizons. change1hPct against change24hPct separates something still
  moving from something already distributed. A large 24h gain that is now reversing is late.
- Age. A token days old is a different risk to one hours old; neither is disqualifying, and
  both are already inside the screen's limits.
- Size, where the numbers support it. Between two candidates that are otherwise comparable on
  participation and sustainability, prefer the LARGER one: a deeper pool absorbs a position
  without moving the price against it, and a bigger book is harder for one wallet to move.
  This is a tie-breaker and never a thesis — a large coin being distributed is still being
  distributed, and size does not redeem a bad buys/buyer ratio or a reversing 24h move. An
  owner who wants a hard floor on size sets one; you are ordering, not admitting.
- Nulls mean the figure is UNKNOWN, not zero. An unknown is a reason for less conviction,
  never for more.

The site fields are what the coin's OWN WEBSITE said when one was published and visited.
They are weak evidence and easy to fake, so weigh them as colour rather than proof — but the
absence of any effort is itself informative:
- publishedNothing true means the launcher filled in no description and no socials at all.
  That is the shape an abandoned template has, and most of them are.
- siteReachable false means a site was published and did not answer. That is worse than
  never publishing one, because someone meant it to be there.
- siteNamesContract false on a site with real text means the page never mentions the token
  it is supposedly for — common on a template reused across many launches.
- siteHypeWords counts promises like "guaranteed" and "100x". A high count is not proof of
  anything; it is a description of who the page is written for.
- All six null means nothing was published or nothing was visited. Treat that as no
  information, NOT as a bad sign — most coins in any pass are not researched.

conviction is 1..5 and is an ordering, not a size: 5 means look here first, not buy more.`;

/**
 * How many candidates the model is shown at once.
 *
 * Not taste: Groq free tier caps qwen3.8-27b at 8,000 tokens a MINUTE, and 31
 * pretty-printed candidates asked for 11,081 — a 413 on every real-sized list,
 * which failed closed and read as "nothing was worth picking". Twenty compact
 * candidates plus this system prompt and the output reservation sit inside that
 * with room to spare.
 */
/**
 * How much of a launcher-written name the model is shown.
 *
 * Short on purpose. A name is a LABEL here, not content: the numbers beside it
 * are what the model ranks on and the index is what it answers in, so nothing
 * downstream needs the 65th character. Against a 34,090-character name this is
 * the difference between one candidate and no scout pass at all.
 */
export const SCOUT_LABEL_MAX = 64;

export const SCOUT_MAX_CANDIDATES = 20;

const RANK_TOOL = {
  name: "rank_candidates",
  description:
    "Return the subset of candidates worth a closer look, by index, most interesting first. " +
    "Indices not present in the input are discarded downstream. An empty list is valid.",
  schema: {
    type: "object" as const,
    properties: {
      keep: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "number", description: "The candidate's index, exactly as given." },
            conviction: { type: "number", description: "1..5, advisory ordering only." },
            reason: { type: "string", description: "One sentence, citing the figures that decided it." },
          },
          // `reason` optional for the same reason the strategist's is: Groq
          // validates server-side and small models drop it, and an answer
          // missing its rationale is still a usable answer.
          required: ["index", "conviction"],
          additionalProperties: false,
        },
      },
    },
    required: ["keep"],
    additionalProperties: false,
  },
};

/**
 * Map raw model output back onto real pools.
 *
 * This is where "narrow, never widen" is ENFORCED rather than requested. Every
 * rejection below is deliberate:
 *   - an index outside the offered range refers to no pool, so it is dropped
 *     and reported, not clamped into one — clamping would silently substitute
 *     a token the model did not choose;
 *   - a repeated index is one pick, not two;
 *   - a non-integer index is not rounded, for the same reason as clamping;
 *   - conviction is clamped into 1..5, because unlike an index it names no
 *     token and a nonsense ordering cannot select anything.
 * The result is a subset of `pools` no matter what the model returned.
 */
export function applyVerdicts(pools: readonly GeckoPool[], raw: unknown): ScoutResult {
  const keep = (raw as { keep?: unknown })?.keep;
  const rows = Array.isArray(keep) ? keep : [];
  const ignored: string[] = [];
  const seen = new Set<number>();
  const picks: ScoutPick[] = [];

  for (const row of rows) {
    const r = row as { index?: unknown; conviction?: unknown; reason?: unknown };
    const idx = r?.index;
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= pools.length) {
      ignored.push(JSON.stringify(row).slice(0, 120));
      continue;
    }
    if (seen.has(idx)) continue;
    seen.add(idx);
    const conv = typeof r.conviction === "number" && Number.isFinite(r.conviction) ? r.conviction : 1;
    picks.push({
      pool: pools[idx]!,
      conviction: Math.min(5, Math.max(1, Math.round(conv))),
      reason: typeof r.reason === "string" ? r.reason.slice(0, 240) : "",
    });
  }

  picks.sort((a, b) => b.conviction - a.conviction);
  return { picks, passed: pools.filter((_, i) => !seen.has(i)), ignored };
}

export interface MemecoinScout {
  name: string;
  rank(
    pools: readonly GeckoPool[],
    nowSec: number,
    research?: ReadonlyMap<string, ScoutSiteFields>,
  ): Promise<ScoutResult>;
}

/**
 * No key, no model, nothing narrowed — and therefore nothing PICKED.
 *
 * The safe default is an empty pick list rather than "everything passes". This
 * step exists to exclude; with no brain to do the excluding, the honest result
 * is that nothing has been vetted, not that everything has.
 */
export const nullScout: MemecoinScout = {
  name: "null",
  rank: async (pools) => ({ picks: [], passed: [...pools], ignored: [] }),
};

export function createMemecoinScout(creds: LlmCreds): MemecoinScout {
  return {
    name: `${creds.provider}:${creds.model}`,
    async rank(pools, nowSec, research) {
      if (pools.length === 0) return { picks: [], passed: [], ignored: [] };
      // TRIM BEFORE ASKING. Measured against Groq's free tier: 31 candidates
      // pretty-printed asked for 11,081 tokens against an 8,000/minute limit,
      // so the scout returned a 413 and failed closed on every real-sized list —
      // which looked exactly like "nothing was worth picking".
      //
      // Kept by DISTINCT BUYERS, the metric this file already calls the hardest
      // to fake. Choosing by liquidity would favour whichever pool someone was
      // willing to park the most money in, which is the thing being judged.
      const shown =
        pools.length > SCOUT_MAX_CANDIDATES
          ? [...pools].sort((a, b) => (b.buyers24h ?? 0) - (a.buyers24h ?? 0)).slice(0, SCOUT_MAX_CANDIDATES)
          : pools;
      const candidates = toScoutCandidates(shown, nowSec, research);
      try {
        const raw = await llmToolCall(creds, {
          system: SYSTEM,
          maxTokens: 1536,
          tool: RANK_TOOL,
          // Compact, not pretty-printed. The indentation was costing roughly
          // half the prompt for nothing a model reads.
          messages: [
            {
              role: "user",
              content:
                (shown.length < pools.length
                  ? `Candidates (the ${shown.length} with the most distinct buyers, of ${pools.length} that passed the screen):\n`
                  : "Candidates:\n") + JSON.stringify(candidates),
            },
          ],
        });
        // Map back onto the list the model was ACTUALLY shown. Passing `pools`
        // here would resolve its indices against a different array and hand
        // back coins it never saw — the one way this design could widen.
        return applyVerdicts(shown, raw);
      } catch (e) {
        // A provider outage must not open the gate. Failing closed here costs a
        // missed opportunity; failing open would let an unranked list through a
        // step whose only job is to cut it down.
        //
        // But SAY SO. Swallowing it made a dead model indistinguishable from a
        // considered pass, on every surface that reads this — the dashboard
        // showed "no coin was worth picking" for a week of a 404.
        console.log(`[scout] could not rank ${pools.length} candidates: ${e instanceof Error ? e.message : String(e)}`);
        return { picks: [], passed: [...pools], ignored: [], failed: true };
      }
    },
  };
}
