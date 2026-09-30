/**
 * WHAT A BUILDER DIRECTORY CAN HONESTLY BE QUOTED AS SAYING.
 *
 * A fifth lens for the memecoin desk, and the first one that is not about the
 * market. `technical` is price, `liquidity` is depth, `onchain` is who holds
 * the float, `social` is what other Merrymen published — four readings of the
 * same tape. None of them can answer the question a human asks first: is
 * anybody still building the thing this ticker is named after.
 *
 * The arithmetic is somebody else's — a public directory of Robinhood Chain
 * projects, reached through `hey.ts`, which is the only file that knows its
 * name. This file only turns a record into prose, and its whole job is the
 * same one `coin-onchain.ts` has: make the LIMITS of the claim travel with the
 * claim, because both survive being made into a sentence and only one of them
 * survives being read by a model in a hurry.
 *
 * ── THE ONE RULE, AND IT IS THE REASON THIS FILE IS NOT TEN LINES ────────
 *
 * A CONTRACT THE DIRECTORY DOES NOT LIST PRODUCES NO BLOCK AT ALL.
 *
 * Not a hedge, not "no builder page was found", not an empty section. `null`,
 * and Brain answers NO DATA AVAILABLE for the lens — the established
 * discipline, and here it is load-bearing rather than tidy. Most launchpad
 * coins are unlisted. A directory's coverage gap rendered as a sentence is
 * read by an analyst as a finding about the token, and the analyst would be
 * right to read it that way, because a lens that speaks is claiming to have
 * looked at the thing under discussion. It has not. It has looked at an index.
 *
 * The cost of getting this wrong is not a missed trade. It is that every
 * honest project the directory has not indexed gets marked down by a signal
 * with no standing to mark anything down, and the agent learns a rule — quiet
 * directory means bad coin — that is false and that nothing downstream can
 * unlearn.
 *
 * ── WHAT THE BLOCK REFUSES TO IMPLY, STATED IN THE PROSE ITSELF ──────────
 *
 * Shipping code is not a safety property. There is no honeypot simulation
 * here, no sell-path test, no owner/mint/freeze probe, no LP-lock check and no
 * proxy-upgrade check — `coin-onchain.ts` says the same of itself, and between
 * the two lenses a reader could otherwise assemble a sense of "checked" that
 * neither one earns. A diligent team ships commits; so does a diligent rug.
 * The block says so outright, because an analyst handed a verified builder and
 * a hundred commits will otherwise conclude SAFE, which is the most expensive
 * conclusion available to it.
 *
 * AND THE ADDRESS→PROJECT LINK IS THE DIRECTORY'S CLAIM, not an onchain fact.
 * That is the load-bearing half of the lookup: the reason it is keyed on a
 * contract rather than a name is that a name can be copied and a deployed
 * address cannot, so this is precisely the lens that catches a coin borrowing
 * a real team's identity — but only to the extent the directory's own mapping
 * is right. Quoting it as our finding would launder somebody else's inference
 * into our evidence.
 */

import type { BuilderRecord } from "./builder";

/** Hard ceiling, matching `brain-material.ts`. A dossier is billed per call. */
const LENS_MAX = 1200;

/** Past this, the reading is described as old rather than quoted as current. */
const STALE_AFTER_SEC = 6 * 3600;

export interface BuilderInputs {
  /** The symbol as the discovery pass recorded it — address-derived, stable. */
  symbol: string;
  record: BuilderRecord;
  /** Unix seconds. Used only to say how old the reading is. */
  now: number;
}

/** "3 days ago", "21h ago", "just now" — never a bare timestamp in prose. */
function ago(seconds: number): string {
  if (seconds < 90) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours + "h ago";
  return Math.floor(hours / 24) + " days ago";
}

/**
 * One activity count as a clause, or nothing.
 *
 * NOTHING, NEVER ZERO, for a count the directory did not supply. A missing
 * field means the directory does not know; printing "0 releases" would turn
 * our ignorance into their inactivity, and an analyst cannot tell the two
 * apart once they are both a number in a sentence.
 *
 * `partial` prefixes "at least", which is the whole reason the flag survives
 * the trip from `hey.ts`: the directory sometimes stops counting and reports a
 * floor, and a floor quoted as a total is a number we invented.
 */
function clause(n: number | null, one: string, many: string, partial = false): string | null {
  if (n === null) return null;
  return (partial ? "at least " : "") + n + " " + (n === 1 ? one : many);
}

/**
 * A record to prose, or null when there is nothing honest to say.
 *
 * PURE. Given a record, returns a block.
 */
export function renderBuilder(inputs: BuilderInputs): string | null {
  const r = inputs.record;
  // THE RULE. See the module comment — this early return is the whole point of
  // the file and every other line is subordinate to it.
  if (!r.found) return null;

  const who = r.name
    ? r.name + (r.symbol && r.symbol.toUpperCase() !== r.name.toUpperCase() ? " (" + r.symbol + ")" : "")
    : "the project behind this contract";

  const lines: string[] = [];

  // ── WHAT THE DIRECTORY SAYS ──────────────────────────────────────────
  // Attributed in the first clause of the first sentence rather than in a
  // trailing caveat. A block that opens with the finding and qualifies it at
  // the end has already been read as our finding by the time the caveat lands.
  // The gloss arrives as the directory wrote it and usually ends in a full
  // stop of its own, so ours is added to the sentence rather than after it.
  const gloss = r.statusHelp ? " — " + r.statusHelp.replace(/\.+$/, "") : "";
  const status = r.status ? ' Its status word for them is "' + r.status + '"' + gloss + "." : "";
  lines.push(
    "A public directory of projects on this chain holds a page for " +
      inputs.symbol +
      "'s contract, and identifies it as " +
      who +
      "." +
      status,
  );

  // VERIFIED IS A TRI-STATE AND ALL THREE STATES ARE DIFFERENT. Unverified is
  // a thing the directory said; unknown is a thing it did not say; and only
  // the first is evidence. Rendering null as "not verified" would manufacture
  // a negative finding out of an absent field.
  if (r.verified === true) {
    lines.push("The directory records the builder as verified by its own process.");
  } else if (r.verified === false) {
    lines.push(
      "The directory records the builder as NOT verified by its own process. That is its " +
        "statement about its own checks, not a finding about the team.",
    );
  }

  // ── THE ACTIVITY, WITH ITS SAMPLE ────────────────────────────────────
  const parts = [
    clause(r.activity.commits30d, "commit", "commits", r.activity.commitsPartial),
    clause(r.activity.releases30d, "release", "releases"),
    clause(r.activity.ships30d, "ship", "ships"),
  ].filter((p): p is string => p !== null);
  if (parts.length) {
    lines.push(
      "Observed activity in the last 30 days: " +
        parts.join(", ") +
        "." +
        (r.activity.commitsPartial
          ? " The commit figure is a FLOOR the directory stopped counting at, not a total."
          : ""),
    );
  }
  if (r.activity.lastShip) {
    lines.push("Its most recent recorded ship is dated " + r.activity.lastShip + ".");
  }
  if (!parts.length && !r.activity.lastShip) {
    // A LISTED PROJECT WITH NO NUMBERS IS STILL WORTH A BLOCK, and this
    // sentence is why: "the page exists and carries no activity" and "we never
    // asked" are different facts, and the second one never reaches this file.
    lines.push(
      "The page carries no activity counts. The directory holds a page and did not report " +
        "how much was shipped; that is a gap in what it published, not a measurement of zero.",
    );
  }

  // ── AND WHAT IT DOES NOT MEAN ────────────────────────────────────────
  lines.push(
    "WHAT THIS IS NOT. Shipping code is not a safety property: there is no honeypot " +
      "simulation, sell-path test, owner/mint/freeze probe, LP-lock check or " +
      "proxy-upgrade check behind any of this, and a diligent rug also commits. The link " +
      "between this contract and this project is the DIRECTORY'S claim rather than an " +
      "onchain fact, and none of it is a statement about price.",
  );

  const age = Math.max(0, inputs.now - r.readAt);
  if (age > STALE_AFTER_SEC) {
    lines.push("This reading was taken " + ago(age) + " and may have moved since.");
  }

  // The directory's own caveat, carried verbatim and attributed. Last, because
  // it is the source speaking rather than us, and unparaphrased, because a
  // summary of somebody else's disclaimer is our disclaimer.
  if (r.disclaimer) lines.push('The directory states: "' + r.disclaimer + '"');

  return lines.join(" ").slice(0, LENS_MAX);
}
