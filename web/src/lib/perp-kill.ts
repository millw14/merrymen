/**
 * THE SELF-HOSTED WEB KILL STANDS THE PERPS DOWN FIRST (docs/perps.md rule 13;
 * worker/src/perps/standdown-files.ts).
 *
 * Self-hosted, the web, the CLI and the worker share one MERRYMEN_HOME, and
 * the worker is the only process holding the Lighter key a stand-down needs.
 * So the web does not stand anything down itself; it asks, in the one way the
 * worker listens:
 *
 *   1. write `standdown-request-<nonce>.json` (reason "kill") — BEFORE
 *      grant.json is archived, so the worker still holds the key and knows the
 *      account when it reads the request
 *   2. wait up to KILL_STANDDOWN_WAIT_MS for `standdown-result-<nonce>.json`
 *   3. only then does the route archive the grant, and it answers with the
 *      custody sentence built from the result (custodySentence), or — when the
 *      worker has not answered in time — says so and builds it from the last
 *      report instead
 *
 * A REQUEST THAT CANNOT BE WRITTEN STOPS THE KILL. writeStanddownRequest's
 * contract: "a kill path that gets a throw must not archive the grant as if
 * the worker had been asked". Archiving anyway would pull the key out from
 * under positions nobody was asked to close, and their only protection would
 * be stops that expire; refusing leaves the agent exactly as it was — its
 * protective loop still running — and tells the owner to try again or use
 * `merrymen kill`.
 *
 * THE WAIT IS SHORT ON PURPOSE. The CLI waits 120 s and prints progress; a
 * browser request is not a terminal. Twenty seconds covers a worker that is
 * up and a venue that answers; anything longer is reported as "not reported
 * yet", never as done.
 *
 * Hosted is not this path, and has none yet: rule 13's sealed
 * `perp_standdown` row and stand-down-only child are not built, so the hosted
 * DELETE closes nothing and says so (api/grants perpsHostedKillCustody, and
 * `perpsStanddownOnKill: false` for every kill control's warning).
 *
 * Server-only: it writes into the home.
 */
import { custodySentence, type PerpExposure, type PerpsReport } from "@merrymen/core";
import { standdownExposure, type StanddownOutcome, type StanddownResult } from "../../../worker/src/perps/standdown";
import {
  newStanddownNonce,
  waitForStanddownResult,
  writeStanddownRequest,
} from "../../../worker/src/perps/standdown-files";
import { custodyText, grantMentionsPerps, perpExposureOfReport, perpsBookOf } from "./perps-view";

/** How long the web kill waits for the worker's stand-down result. */
export const KILL_STANDDOWN_WAIT_MS = 20_000;

/** What the kill's response says about the perps — no key, no path, no venue detail beyond words. */
export interface KillStanddown {
  /** A stand-down request was written for the worker. */
  requested: true;
  /** The request's nonce — the CLI can `merrymen status` it; it is not a secret. */
  nonce: string;
  /** The worker's result arrived within the wait. */
  reported: boolean;
  /** The result's outcome; null when it has not reported. */
  outcome: StanddownOutcome | null;
}

export type KillPerpsAnswer =
  | {
      ok: true;
      /** Null when the grant never carried perps: nothing was asked. */
      standdown: KillStanddown | null;
      /** Where the money is, in the owner's words (custodySentence — never a constant). */
      custody: string;
    }
  | { ok: false; error: string };

/** The sentence said when the report cannot say what is in transit between the account and Lighter. */
const TRANSIT_UNREAD = "Whether any USDG is still moving between your smart account and Lighter could not be read.";

/**
 * The stand-down's result as the owner's custody sentence. What the result
 * cannot know comes from the last report, and what the report cannot know is
 * said as unknown: money in transit (counted as still on Lighter — see
 * perpExposureOfReport for why), and the other accounts under our L1 address,
 * which neither reads and custodySentence says could not be read.
 */
export function killCustodyFromResult(result: StanddownResult, report: PerpsReport | null, accountMode: string | null = null): string {
  // Only a REAL book's transit is money moving to or from Lighter: a practice
  // report's figures (perpsBookOf — the rail may read "off" while practice is
  // held) are simulated, and one the report does not place is not counted as
  // real either — it is said as unread instead.
  const book = report === null ? null : perpsBookOf(report, accountMode);
  const inTransit =
    report !== null && book === "live" && report.inTransitMicro !== null && /^-?\d{1,40}$/.test(report.inTransitMicro)
      ? BigInt(report.inTransitMicro)
      : null;
  const exposure: PerpExposure = standdownExposure(result, {
    pendingWithdrawalsMicro: 0n,
    depositsInTransitMicro: 0n,
    otherAccounts: null,
    withdrawalDelaySec: null,
  });
  if (exposure.kind !== "known") return custodySentence(exposure);
  if (inTransit === null) return `${custodySentence(exposure)} ${TRANSIT_UNREAD}`;
  return custodySentence({ ...exposure, collateralMicro: exposure.collateralMicro + inTransit });
}

/**
 * Ask the worker to stand this grant's perps down, and wait for its answer.
 * A grant that never mentioned perps asks nothing and gets the sentence its
 * report supports (none, for an agent that never had a venue leg).
 */
export async function standDownForKill(args: {
  home: string;
  grant: unknown;
  /** `agents.perps` as read before the kill; null when not said or unreadable. */
  report: PerpsReport | null;
  /** The account's own book (agents.mode), which says whether a held book off the paper rail is practice. */
  accountMode?: string | null;
  waitMs?: number;
  now?: () => number;
  /** Seams for tests. */
  write?: typeof writeStanddownRequest;
  wait?: typeof waitForStanddownResult;
}): Promise<KillPerpsAnswer> {
  const now = args.now ?? Date.now;
  if (!grantMentionsPerps(args.grant)) {
    return {
      ok: true,
      standdown: null,
      custody: custodyText(perpExposureOfReport(args.report, { grantMentionsPerps: false, nowMs: now(), accountMode: args.accountMode })),
    };
  }
  const nonce = newStanddownNonce();
  try {
    (args.write ?? writeStanddownRequest)(args.home, { reason: "kill", requestedAt: Math.floor(now()), nonce });
  } catch (e) {
    return {
      ok: false,
      error:
        "Couldn't ask the agent to close its perpetuals on Lighter first, so nothing was stopped — your agent is " +
        "still running, and its stops at Lighter are still in place. Try again, or run `merrymen kill` on the " +
        `machine running your agent. (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  let result: StanddownResult | null = null;
  try {
    result = await (args.wait ?? waitForStanddownResult)(args.home, nonce, args.waitMs ?? KILL_STANDDOWN_WAIT_MS, undefined, { pollMs: 250 });
  } catch {
    // The wait only throws on a nonce it did not make; treat it as no answer.
    result = null;
  }
  if (result !== null) {
    return {
      ok: true,
      standdown: { requested: true, nonce, reported: true, outcome: result.outcome },
      custody: killCustodyFromResult(result, args.report, args.accountMode ?? null),
    };
  }
  // NOT REPORTED IS NOT DONE. The request stays in the home for the worker;
  // what is said about the money comes from the last report, prefixed with
  // the plain fact that the stand-down has not answered.
  const before = custodyText(perpExposureOfReport(args.report, { grantMentionsPerps: true, nowMs: now(), accountMode: args.accountMode }));
  const secs = Math.round((args.waitMs ?? KILL_STANDDOWN_WAIT_MS) / 1000);
  return {
    ok: true,
    standdown: { requested: true, nonce, reported: false, outcome: null },
    custody:
      `Your agent was asked to close its perpetuals on Lighter and has not reported back within ` +
      `${secs} ${secs === 1 ? "second" : "seconds"}. ${before}`,
  };
}
