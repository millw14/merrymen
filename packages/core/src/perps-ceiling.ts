/**
 * ONE PERPS GATE, READ THE SAME WAY BY EVERY PROCESS THAT HONOURS IT.
 *
 * MERRYMEN_PERPS is the operator's lever over perpetuals (docs/perps.md rule
 * 1). The worker and the orchestrator read it, and from slice 5 so does the
 * web, which decides whether a Perps wallet may be offered or made at all
 * (web/src/lib/perps-enabled.ts). Moved here from worker/src/settings.ts, which
 * re-exports it unchanged, so that the three cannot come to disagree about what
 * a value means: one parser, and a deployment whose web and orchestrator are
 * given the same value (the Phase 3 deploy checklist) gets the same answer.
 *
 * Pure, and NOT in the core barrel: it is an operator's server-side lever, and
 * the phone bundles the barrel (barrel-mobile.test.ts). The worker and the web
 * import this file by path.
 */

/**
 * How far the operator lets perps go, weakest first. An operator lever, so it
 * restricts and never grants: "live" here still needs the owner's own consent
 * and a perps grant; it only stops the deployment being what says no.
 */
export const PERPS_CEILINGS = ["off", "paper", "live"] as const;
export type PerpsCeiling = (typeof PERPS_CEILINGS)[number];

/**
 * MERRYMEN_PERPS, read restrict-only (docs/perps.md rule 1).
 *
 * UNSET IS OFF, hosted and self-hosted, as MERRYMEN_SOLANA is: perps land on
 * main in slices, and the next deploy of anything else ships every slice
 * already merged, so nothing may depend on an operator remembering to set
 * `off`. An operator turns paper on by writing `paper`. (The perps branch
 * defaulted hosted to paper and self-hosted to live, with an untested write
 * path; the plan's Phase 1 fix 5 replaced that.)
 *
 * `live` IS OFF IN THIS BUILD. Real-money perps are not built yet (Phase 4 of
 * the plan, after the mainnet checklist): there is no live executor, no
 * reconciler and no on-chain leg to reach. An operator who writes `live` gets
 * nothing rather than paper, so a deployment is never trading practice perps
 * its operator believes are real; perpsCeilingNote says so at startup.
 *
 * Anything else it does not recognise is OFF: a typo in a variable that exists
 * to take capability away must not hand it back.
 */
export function perpsCeilingOf(raw: string | undefined): PerpsCeiling {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "paper" ? "paper" : "off";
}

/**
 * The startup line for an operator whose MERRYMEN_PERPS asked for more than
 * this build gives (perpsCeilingOf), or null when it asked for nothing more.
 */
export function perpsCeilingNote(raw: string | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "off" || v === "paper") return null;
  if (v === "live") return "MERRYMEN_PERPS=live: real-money perps are not in this build, so perps are OFF (set paper for practice perps).";
  return `MERRYMEN_PERPS=${JSON.stringify(raw).slice(0, 40)} is not off, paper or live, so perps are OFF.`;
}
