/**
 * ONE LOGIN, TWO WORKERS: the hosted orchestrator's key for each.
 *
 * A login has two wallets from one owner key (docs/perps.md "One login, two
 * wallets"): Spot at Kernel index 0 and Perps at index 1, each with its own
 * grant store and settings store. The orchestrator runs one child per wallet,
 * and its maps, leases and mirror cursors need a key that tells the two apart:
 *
 *   0x<owner>          the Spot wallet's worker, exactly the tenant key every
 *                      map, lease, home and mirror cursor has always used;
 *   0x<owner>:perps    the Perps wallet's worker.
 *
 * A WORKER KEY IS NOT AN OWNER, and that is the mistake this module exists to
 * make loud. The stores are keyed by the owner address and do not check what
 * they are given: `getGrantStore("spot").get("0x…:perps")` answers null, which
 * a kill would read as "already revoked". So every store call takes
 * `workerOwner(key)` and `workerPurpose(key)`, never the key itself, and both
 * throw on anything that is not exactly one of the two shapes above.
 *
 * Nothing here widens fleet-id.ts. The rollout, the accounting hold and the
 * operator one-shots name owners, and `0x…:perps` stays an unsupported fleet
 * id there, so no operator variable can name one wallet's worker on its own:
 * whatever an operator says about a login holds for both of its workers.
 */
import path from "node:path";
import type { GrantPurpose } from "../../packages/core/src/index";

/** A worker key: an owner address, alone (Spot) or with `:perps`. Lowercase only. */
export type WorkerKey = `0x${string}`;

const SPOT_KEY = /^0x[0-9a-f]{40}$/;
const PERPS_SUFFIX = ":perps";

/** The Perps workers' homes, beside Spot's `children/` so no Spot path moves. */
export const PERPS_CHILDREN_DIR = "children-perps";

/** The owner and wallet a worker key names, or null for anything else (uppercase, padding, another suffix). */
export function parseWorkerKey(raw: unknown): { owner: `0x${string}`; purpose: GrantPurpose } | null {
  if (typeof raw !== "string") return null;
  if (raw.endsWith(PERPS_SUFFIX)) {
    const owner = raw.slice(0, -PERPS_SUFFIX.length);
    return SPOT_KEY.test(owner) ? { owner: owner as `0x${string}`, purpose: "perps" } : null;
  }
  return SPOT_KEY.test(raw) ? { owner: raw as `0x${string}`, purpose: "spot" } : null;
}

/** The worker key for an owner's wallet. Throws on an owner that is not a 0x address. */
export function workerKey(owner: string, purpose: GrantPurpose): WorkerKey {
  const lc = owner.toLowerCase();
  if (!SPOT_KEY.test(lc)) throw new RangeError("a worker's owner must be a 0x address");
  return (purpose === "perps" ? `${lc}${PERPS_SUFFIX}` : lc) as WorkerKey;
}

function parsed(key: string): { owner: `0x${string}`; purpose: GrantPurpose } {
  const p = parseWorkerKey(key);
  if (!p) throw new RangeError("not a worker key");
  return p;
}

/** The owner address a worker key belongs to: what every store is keyed by. Throws on a non-key. */
export function workerOwner(key: string): `0x${string}` {
  return parsed(key).owner;
}

/** Which wallet a worker key serves. Throws on a non-key. */
export function workerPurpose(key: string): GrantPurpose {
  return parsed(key).purpose;
}

/** True only for a well-formed Perps worker key. Never throws. */
export function isPerpsWorkerKey(key: unknown): boolean {
  return parseWorkerKey(key)?.purpose === "perps";
}

/** The home directory of a Perps worker, under `<fleet home>/children-perps/<owner>`. */
export function perpsChildHome(fleetHome: string, owner: string): string {
  return path.join(fleetHome, PERPS_CHILDREN_DIR, workerOwner(owner));
}
