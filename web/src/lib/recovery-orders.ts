/** Server-only queue guard. It cannot clear a recovery hold or replay an old command. */
import type { Db } from "../../../worker/src/db";
import { readFleetCommandRefusal, withFleetRecoveryLock } from "../../../worker/src/fleet-recovery";
import { placeHostedOrder, type PlaceResult } from "./order-state";

export async function placeRecoveryCheckedOrder(db: Db | null,
  order: Parameters<typeof placeHostedOrder>[1]): Promise<PlaceResult> {
  if (!db) return { ok: false, why: "unreachable" };
  try {
    return await withFleetRecoveryLock(db, order.agent, async locked => {
      // Read optional tables before BEGIN: PostgreSQL's missing-table error
      // would otherwise abort the subsequent insert on an older deployment.
      if (await readFleetCommandRefusal(locked, order.agent, order.now)) return { ok: false, why: "recovery" };
      return locked.tx(tx => placeHostedOrder(tx, order));
    });
  } catch { return { ok: false, why: "unreachable" }; }
}
