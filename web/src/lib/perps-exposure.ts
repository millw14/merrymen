/**
 * WHAT IS AT LIGHTER, AS THE BROWSER CAN LEARN IT — for the kill and discard
 * controls, which must say it before and after (docs/perps.md rule 13).
 *
 * One GET of /api/grants: the grant's public view (does it mention perps?),
 * `perps` (the worker's own report; null = not said or unreadable), `mode`
 * (the account's own book — the report's mode is the perps rail, see
 * perps-view.ts perpsBookOf) and `perpsStanddownOnKill` (does THIS server's
 * kill can request perps stand-down on this server). The pure
 * judgement is lib/perps-view.ts perpExposureOfReport; this is only the read.
 *
 *   exposure null     no agent is armed here — nothing to stand down, and
 *                     nothing is claimed about Lighter either way
 *   exposure unread   the status could not be read at all: never `none`,
 *                     which is the one state allowed to say the funds are home
 *   the rest          whatever the report supports
 *
 * Browser-safe: fetch and core's parser only.
 */
import { parsePerpsReport, type PerpExposure } from "@merrymen/core";
import { grantMentionsPerps, perpExposureOfReport } from "./perps-view";

export interface KillPerps {
  exposure: PerpExposure | null;
  /**
   * Can this server request a perpetual stand-down on kill? True when the
   * local worker or hosted shutdown runner is available, false when unavailable,
   * null when the status did not say — and
   * null is never read as a promise to close anything.
   */
  standsDown: boolean | null;
}

/** The kill's perps facts from an /api/grants body — split out so a test can drive it without a network. */
export function killPerpsFromStatus(status: unknown, nowMs: number): KillPerps {
  if (typeof status !== "object" || status === null) return { exposure: { kind: "unread" }, standsDown: null };
  const s = status as { exists?: unknown; grant?: unknown; perps?: unknown; mode?: unknown; perpsStanddownOnKill?: unknown; perpsShutdown?: unknown };
  const standsDown = typeof s.perpsStanddownOnKill === "boolean" ? s.perpsStanddownOnKill : null;
  if (s.perpsShutdown && typeof s.perpsShutdown === "object") return { exposure: { kind: "unread" }, standsDown };
  if (s.exists === false) return { exposure: null, standsDown };
  if (s.exists !== true) return { exposure: { kind: "unread" }, standsDown };
  // Parsed again here, by the same whitelist: whatever arrives over the wire
  // is read strictly, and anything it refuses is unread.
  return {
    exposure: perpExposureOfReport(parsePerpsReport(s.perps ?? null), {
      grantMentionsPerps: grantMentionsPerps(s.grant),
      nowMs,
      accountMode: typeof s.mode === "string" ? s.mode : null,
    }),
    standsDown,
  };
}

/** The exposure alone, from an /api/grants body. */
export function exposureFromStatus(status: unknown, nowMs: number): PerpExposure | null {
  return killPerpsFromStatus(status, nowMs).exposure;
}

export async function readKillPerps(): Promise<KillPerps> {
  try {
    const r = await fetch("/api/grants", { cache: "no-store" });
    if (!r.ok) return { exposure: { kind: "unread" }, standsDown: null };
    return killPerpsFromStatus(await r.json(), Date.now());
  } catch {
    return { exposure: { kind: "unread" }, standsDown: null };
  }
}
