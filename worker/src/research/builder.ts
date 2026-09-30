/**
 * WHETHER ANYBODY IS STILL BUILDING THE THING THE TICKER IS NAMED AFTER.
 *
 * The shape, not the source — the same split `news.ts` holds against the news
 * vendor, and for the same reason: the first directory is never the last, and a
 * name that has reached the desk, the prompt or a persisted decision cannot be
 * replaced without a migration. Everything above this file speaks
 * `BuilderRecord`; exactly one file below it speaks somebody's JSON.
 *
 * ── WHY THIS LENS IS WORTH A CALL AT ALL ─────────────────────────────────
 *
 * The memecoin desk asks for technical, onchain, social and liquidity, and all
 * four are MARKET data: price, holder distribution, route depth, and what other
 * Merrymen published. Not one of them can answer whether there is a person
 * shipping code behind the ticker, which is the first question a human asks and
 * the only one on that list that is not downstream of the price.
 *
 * It is also the other half of a gap this repo has already named once.
 * `coin-onchain.ts` says outright that it carries provenance and distribution
 * and is NOT a safety check. This is the provenance of the TEAM rather than of
 * the float. Neither is a rug check; together they are two different questions
 * that were both previously unasked.
 *
 * ── THE PROPERTY THIS MODULE EXISTS TO PROTECT ───────────────────────────
 *
 * ABSENCE IS NOT A VERDICT. A directory that holds no page for a contract has
 * told us about ITS COVERAGE, not about the token. Most launchpad coins will
 * come back unlisted, and if that quietly renders as "no builder found" then
 * every honest project the directory has not indexed yet is punished, the
 * agent learns a rule that is false, and the lens becomes a rug signal it has
 * no standing to be.
 *
 * So `found: false` carries no status, no counts and no verdict, and the
 * renderer refuses to speak at all on one — the established discipline, stated
 * by coin-liquidity.ts in the words this repo keeps returning to: a lens fed a
 * guess is worse than a lens fed nothing.
 *
 * ── AND A FLOOR IS NOT A TOTAL ───────────────────────────────────────────
 *
 * `commitsPartial` is the same fact `onchain-forensics.ts` calls `complete:
 * false`: the sample travels with the number, because "87 commits" and "at
 * least 87 commits, we stopped counting" are different claims that look
 * identical once they are a sentence.
 */

/** Why a lookup produced no record. Each is a different fact and they log apart. */
export type BuilderFetchFailure =
  /** The address was not 20 bytes of hex. OUR bug, never the directory's. */
  | "bad-address"
  /** The credential was refused. The house's gap, not the token's. */
  | "unauthorized"
  /** We are asking too fast. Carries the directory's own retry hint. */
  | "rate-limited"
  /**
   * WE ASKED ABOUT A CHAIN THIS DIRECTORY DOES NOT INDEX.
   *
   * Kept apart from `not-listed` because they are opposite facts wearing the
   * same `found: false`. One says the token has no page; this one says the
   * question never reached a corpus that could have answered it — a testnet
   * address, or a directory pointed at the wrong chain. Collapsing them would
   * make every testnet run report its whole universe as unlisted.
   */
  | "wrong-chain"
  /** The request did not complete. */
  | "unreachable"
  /** A status we cannot use. */
  | "http-error"
  /** The body was too large, or would not parse. */
  | "unreadable";

/**
 * What a directory recorded about the builder behind one contract.
 *
 * EVERY NUMERIC FIELD IS NULLABLE AND NULL MEANS UNKNOWN. Never zero. The
 * directory omits a count it does not have, and a `?? 0` written in a hurry
 * would turn "we do not know how much they shipped" into "they shipped
 * nothing" — which is the single most expensive mistranslation available here.
 */
export interface BuilderActivity {
  /** Commits in the trailing 30 days, or null when the directory did not say. */
  commits30d: number | null;
  /**
   * True when `commits30d` is a FLOOR rather than a total — the directory
   * stopped counting. A renderer must say "at least" or drop the number.
   */
  commitsPartial: boolean;
  releases30d: number | null;
  /** Releases, tags, announcements — whatever the directory counts as a ship. */
  ships30d: number | null;
  /** ISO date of the most recent ship, as given. Null when there is none. */
  lastShip: string | null;
}

export interface BuilderRecord {
  /** The contract this was keyed on, lowercased. */
  address: string;
  /** Unix seconds the lookup was answered. */
  readAt: number;
  /**
   * Did the directory hold a page for this contract?
   *
   * FALSE IS A FACT ABOUT THE DIRECTORY. See the module comment. When it is
   * false every field below is absent, so there is nothing for a careless
   * reader to mistake for a negative finding.
   */
  found: boolean;
  /** The project's own name and ticker, sanitised. Absent when not found. */
  name: string | null;
  symbol: string | null;
  /** The directory's status word — its vocabulary, not ours. Sanitised. */
  status: string | null;
  /** The directory's own gloss on that word, so we never invent one. */
  statusHelp: string | null;
  /**
   * Has the directory verified that this builder is who the page says?
   *
   * NULL IS NOT FALSE. Null means the directory did not answer; false means it
   * answered no. A lens that renders both as "unverified" invents a finding.
   */
  verified: boolean | null;
  activity: BuilderActivity;
  /**
   * A link a human can follow. NEVER RENDERED INTO A PROMPT — the same rule
   * the news adapter holds for an article url. It exists for the drill-down.
   */
  url: string | null;
  /**
   * The directory's own disclaimer about what its words do and do not mean.
   *
   * CARRIED RATHER THAN SUMMARISED. It is the source's statement about the
   * limits of its own claim, and a paraphrase of somebody else's caveat is our
   * caveat. The renderer decides whether it fits; this schema makes sure it is
   * never lost before that decision.
   */
  disclaimer: string | null;
}

/** An empty record for a contract the directory does not list. */
export function unlisted(address: string, readAt: number): BuilderRecord {
  return {
    address: address.trim().toLowerCase(),
    readAt,
    found: false,
    name: null,
    symbol: null,
    status: null,
    statusHelp: null,
    verified: null,
    activity: { commits30d: null, commitsPartial: false, releases30d: null, ships30d: null, lastShip: null },
    url: null,
    disclaimer: null,
  };
}

/** The one address shape this chain uses. Checked before a request is spent. */
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The minimum a stored row must be before a desk will read it as a record.
 *
 * The file this travels in lives in a tenant-writable home, so its shape is
 * re-checked on every read rather than trusted — the same reason
 * `research-files.ts` re-validates its news items.
 */
export function isBuilderRecord(v: unknown): v is BuilderRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<BuilderRecord>;
  return (
    typeof r.address === "string" &&
    ADDRESS_RE.test(r.address) &&
    typeof r.found === "boolean" &&
    typeof r.readAt === "number" &&
    Number.isFinite(r.readAt) &&
    !!r.activity &&
    typeof r.activity === "object"
  );
}
