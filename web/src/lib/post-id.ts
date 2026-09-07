/**
 * A STABLE NAME FOR A POST, so a like can outlive the row it was cast on.
 *
 * THE ID THE BROWSER HAD WAS NOT ONE. `beat.ts` built
 * `${symbol}-${action}-${slug}-${at}` from `at`, and `read-theses.ts` selects
 * `MAX(d.at)` over a group — while the default strategy re-proposes the same
 * thesis every tick. So the id ADVANCES every few minutes on a post that has
 * not changed, and a like cast against it detaches from the thing it was about
 * within minutes of being cast. It is also degenerate for a pure thesis, where
 * `symbol` and `action` are both null and every one of an agent's views in a
 * window collides on `--slug-at`.
 *
 * WHAT GOES IN, AND WHY EACH ONE.
 *
 *   slug     — the agent's PUBLIC id. Deliberately not `agent_id`, which is a
 *              smart-account address: hashing it would put a wallet in an id
 *              that appears in URLs and logs, and the hash of a known address
 *              is a lookup table. The consequence is intended — AN UNSLUGGED
 *              POST GETS NO ID AND IS NOT LIKEABLE. A post with no identity
 *              behind it has nothing for a like to attach to.
 *   action, symbol, size, reason, shadow — the post itself.
 *
 * EVERY INPUT IS A FIELD OF THE POST IT NAMES, and that is the whole safety
 * argument: the id is published in the same object as its own preimage, so it
 * discloses nothing that is not already on the screen beside it.
 *
 * THE ROW'S `source` WAS AN INPUT AND IS NOT ANY MORE. It is the one thing
 * here that is NOT on the published post — `PublicThesis` has no such field —
 * and `PUBLISHABLE_SOURCES` has seven members. A hash whose preimage is fully
 * known except for one field drawn from a seven-element public set is not a
 * hash, it is an encoding: seven sha-256 calls recover it from a page anybody
 * can fetch. Most of what it would have revealed is published anyway (a
 * strategy id appears on the leaderboard; a shadow row already carries
 * `shadow: true`), which is exactly why removing it costs nothing — and why
 * leaving it in would have been an oracle built for no gain. `shadow` replaces
 * the only discrimination that mattered, and it is a published boolean.
 *
 * WHAT IS DELIBERATELY LEFT OUT.
 *
 *   outcome  — so a LIKE SURVIVES ITS TRADE SETTLING. The group key in the SQL
 *              includes trade status; a thesis liked while pending would
 *              otherwise lose every like the moment it landed, which is exactly
 *              when a reader would look for them.
 *   at, said — both move on every tick for an unchanged post. They are the bug.
 *
 * TWO POSTS IN ONE RESPONSE CAN SHARE AN ID. The same thesis with a pending
 * trade and a landed one are two rows and one post id, and they will show the
 * same count. That is the intended reading: the like is on the thesis.
 *
 * PURE, and in its own module so it can be tested as a table and so nothing
 * about likes ever has a reason to live in `thesis-policy.ts` — that module has
 * NO IMPORTS AT ALL, which is what let it become the one gate both readers
 * share, and adding a hash to it would end that.
 */
import { createHash } from "node:crypto";

/** What a post id looks like on the wire. Validated before any store call. */
export const POST_ID_SHAPE = /^[0-9a-f]{32}$/;

/**
 * The joiner: ASCII UNIT SEPARATOR (0x1f), built from its code point rather than
 * typed as a literal control character — an invisible byte in source is the
 * kind of thing a later edit silently eats.
 */
const SEP = String.fromCharCode(31);

export interface PostIdParts {
  slug: string | null;
  action: string | null;
  symbol: string | null;
  sizeUsdg: number | null;
  reason: string | null;
  /** Published on the post, and the one thing that separates a shadow row. */
  shadow: boolean;
}

/**
 * The id, or null when there is nothing stable to name.
 *
 * Half a sha-256, hex. 128 bits is far past collision-resistance for a set this
 * size, and the shorter string keeps it readable in a URL and a log line.
 */
export function postIdOf(p: PostIdParts): string | null {
  if (!p.slug) return null;
  // A UNIT SEPARATOR, not a hyphen. The fields are free text — a reason can
  // contain anything — and joining on a character that can appear inside a
  // field makes ("a-b", "c") and ("a", "b-c") the same post.
  const key = [
    p.slug,
    p.action ?? "",
    p.symbol ?? "",
    p.sizeUsdg === null ? "" : String(p.sizeUsdg),
    p.reason ?? "",
    p.shadow ? "1" : "0",
  ].join(SEP);
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
}
