/** Explicit real-SQL admission fixture; never selected by a production environment flag. */
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import type { PerpsPilotStore } from "../../../worker/src/perps/pilot-store";

export function pilotFixture(owners: readonly string[] = []) {
  const require = createRequire(import.meta.url);
  const { SqlPerpsPilotStore, setPerpsPilotStoreForTest } = require("../../../worker/src/perps/pilot-store.ts") as typeof import("../../../worker/src/perps/pilot-store");
  const raw = new DatabaseSync(":memory:");
  const store: PerpsPilotStore = new SqlPerpsPilotStore(wrapSqlite(raw), { bootstrapOwners: () => owners.join(",") });
  setPerpsPilotStoreForTest(store);
  return {
    store, raw,
    async set(owner: string, status: "allowed" | "revoked") {
      const { revision } = await store.snapshot();
      const result = await store.setAdmission({ actor: owner, owner, status, expectedRevision: revision });
      if (!["updated", "unchanged"].includes(result.outcome)) throw new Error(`Pilot fixture setup failed: ${result.outcome}`);
    },
    close() { setPerpsPilotStoreForTest(null); raw.close(); },
  };
}
