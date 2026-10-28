/**
 * HOW FAST THE COINGECKO PRO LANE MAY SPEND — two knobs and one ceiling.
 *
 * WHY A KNOB AT ALL. The Pro lane's pace was a constant, 3000 ms between
 * requests for the whole fleet (20/min), chosen when the key was on a small
 * plan. The owner has since bought a plan of about 5,000,000 credits a month at
 * 1,000 requests a minute, and the tape burst, the Brain's evidence legs, the
 * desk and the facts all still queue on that one 20/min slot. The pace belongs
 * to the plan, which is an operator fact, not a code fact.
 *
 * WHY A CEILING AS WELL. A pace knob alone is a way to exhaust a monthly quota
 * by typing a small number. So when the operator also says how many credits
 * the month holds, the pace is clamped to a FLOOR at which this lane, running
 * flat out for a whole 30-day month, spends at most its share of them. That is
 * a worst case, not a forecast: a lane that idles spends less, and no request
 * here ever spends more than its slot.
 *
 * THE SHARES ADD UP TO LESS THAN THE WHOLE, on purpose. The fleet worker lane
 * (every tenant child, one SQLite-coordinated slot) may use 70%. A
 * process-local lane — the web service, or a self-hosted worker — may use 20%.
 * The last 10% is headroom: CoinGecko counts failed requests against the
 * quota too, and the two services are configured separately, so neither may
 * assume the other is idle.
 *
 * DEFAULTS ARE THE OLD BEHAVIOUR. Neither variable set means 3000 ms, exactly
 * as before. An unreadable value keeps the default and is said once — by its
 * NAME only: the raw text is never echoed, because the most likely unreadable
 * value in this variable is something pasted into the wrong one.
 */

/** The Pro pace before this knob existed; still the default. */
export const PRO_DEFAULT_SPACING_MS = 3000;
/** The plan's hard rate: 1,000 requests a minute. No setting goes faster. */
export const PRO_MIN_SPACING_MS = 60;
/** The month the credit ceiling is computed over. */
export const CREDIT_MONTH_MS = 30 * 86_400_000;
/**
 * The share of monthly credits each kind of lane may spend at full pace.
 * See the header for why they do not add up to 1.
 */
export const PRO_LANE_SHARE = { fleet: 0.7, local: 0.2 } as const;
export type ProLane = keyof typeof PRO_LANE_SHARE;

export interface ProPacing {
  /** The spacing the lane uses, after every clamp. */
  spacingMs: number;
  /** The floor the credit ceiling imposes, or null when no ceiling is set. */
  creditFloorMs: number | null;
  /** Operator-facing lines, safe to log: names and numbers, never raw values. */
  notes: string[];
}

/**
 * DID THE OPERATOR SET EITHER KNOB AT ALL — whatever the value, readable or
 * not? A caller that was never on the lane before these knobs existed (web's
 * chart reads) joins it only then, so that neither set still means exactly
 * the previous behaviour for it.
 */
export function proPacingSet(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return [env.MERRYMEN_COINGECKO_PRO_SPACING_MS, env.MERRYMEN_COINGECKO_MONTHLY_CREDITS].some((v) => typeof v === "string" && v.trim() !== "");
}

/** A positive whole number, allowing `_` and `,` as digit separators. Null otherwise. */
function wholeNumber(raw: string | undefined): number | null | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const digits = text.replace(/[_,]/g, "");
  if (!/^\d{1,15}$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The slowest pace at which `share` of `credits` lasts a 30-day month at full use. */
export function creditFloorMs(credits: number, share: number): number {
  return Math.ceil(CREDIT_MONTH_MS / (credits * share));
}

/**
 * Resolve the Pro lane's spacing from the environment.
 *
 * Pure: it reports what it decided in `notes` and leaves logging to the one
 * caller that builds the lane, so a note is said once per process rather than
 * once per read.
 */
export function proPacing(
  env: Readonly<Record<string, string | undefined>> = process.env,
  lane: ProLane = "fleet",
): ProPacing {
  const notes: string[] = [];
  const asked = wholeNumber(env.MERRYMEN_COINGECKO_PRO_SPACING_MS);
  const credits = wholeNumber(env.MERRYMEN_COINGECKO_MONTHLY_CREDITS);
  let spacingMs = PRO_DEFAULT_SPACING_MS;
  if (asked === null) {
    notes.push(`MERRYMEN_COINGECKO_PRO_SPACING_MS is unreadable (want a whole number of milliseconds); keeping ${PRO_DEFAULT_SPACING_MS} ms`);
  } else if (asked !== undefined) {
    spacingMs = asked;
  }
  if (spacingMs < PRO_MIN_SPACING_MS) {
    notes.push(`MERRYMEN_COINGECKO_PRO_SPACING_MS ${spacingMs} ms is faster than the plan's 1,000/min; using ${PRO_MIN_SPACING_MS} ms`);
    spacingMs = PRO_MIN_SPACING_MS;
  }
  if (credits === null) {
    notes.push("MERRYMEN_COINGECKO_MONTHLY_CREDITS is unreadable (want a whole number of credits); no monthly ceiling applied");
  }
  const share = PRO_LANE_SHARE[lane];
  const floor = typeof credits === "number" ? Math.max(PRO_MIN_SPACING_MS, creditFloorMs(credits, share)) : null;
  if (floor !== null && spacingMs < floor) {
    notes.push(`coingecko-pro ${lane} lane: ${spacingMs} ms would spend more than ${Math.round(share * 100)}% of ${credits!.toLocaleString("en-US")} monthly credits; using ${floor} ms`);
    spacingMs = floor;
  }
  if (floor === null && spacingMs < PRO_DEFAULT_SPACING_MS) {
    notes.push(`coingecko-pro ${lane} lane: ${spacingMs} ms with no MERRYMEN_COINGECKO_MONTHLY_CREDITS set — nothing bounds the month's spend`);
  }
  if (typeof asked === "number" || typeof credits === "number") {
    const perMonth = Math.floor(CREDIT_MONTH_MS / spacingMs);
    notes.push(`coingecko-pro ${lane} lane: ${spacingMs} ms spacing (${(60_000 / spacingMs).toFixed(1)}/min), at most ${perMonth.toLocaleString("en-US")} requests per 30 days at full use`);
  }
  return { spacingMs, creditFloorMs: floor, notes };
}
