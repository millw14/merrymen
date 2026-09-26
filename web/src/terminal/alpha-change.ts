/**
 * A DAY'S CHANGE ONLY ON A POOL A DAY OLD — on the Alpha desk too.
 *
 * The index reports `change24hPct` for a pool that is hours old, and that
 * figure is a change since launch wearing a day's name: the sweep captured on
 * 2026-09-25 had "SI / WETH 0.01%" at +18,062.8% on an age of six hours. The
 * desk printed it raw beside the coin while the phone's Markets list wrote
 * "new pool" for the same coin — the doNotDo list's "a '24h' change on a
 * 9-hour-old pool". So the desk applies Markets' rule: "new pool" under a day,
 * the change only once the pool is known to be a day old, and no figure for an
 * age the index did not give. An unknown age is not assumed old enough.
 */

/** An Alpha row's change figure, and which way it points — null when there is no direction to colour. */
export interface AlphaChange {
  text: string;
  up: boolean | null;
}

/** The index's pool age, when it is a usable one. */
function ageOf(ageDays: number | null | undefined): number | null {
  return typeof ageDays === "number" && Number.isFinite(ageDays) && ageDays >= 0 ? ageDays : null;
}

export function alphaChange(change: number | null | undefined, ageDays: number | null | undefined): AlphaChange {
  const age = ageOf(ageDays);
  if (age !== null && age < 1) return { text: "new pool", up: null };
  if (age === null || typeof change !== "number" || !Number.isFinite(change)) return { text: "—", up: null };
  return { text: `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`, up: change >= 0 };
}

/**
 * The label over a row's "24h" volume: qualified with the pool's age when it
 * is younger than a day ("24h · pool 6h old"). The total is real — nothing
 * traded before the pool existed — but under "24h" alone it reads as a full
 * day's rate. An unknown age adds nothing: it is not evidence of youth.
 *
 * Rounded DOWN: this only ever speaks for a pool under a day old, and rounding
 * 23.6 hours up would call it "24h old" in the caption saying it is not.
 */
export function alphaVolumeLabel(ageDays: number | null | undefined): string {
  const age = ageOf(ageDays);
  if (age === null || age >= 1) return "24h";
  const s = Math.floor(age * 86_400);
  const words = s < 60 ? `${s}s` : s < 3_600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3_600)}h`;
  return `24h · pool ${words} old`;
}
