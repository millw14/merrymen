/** Server-only reads. Only a session's Perps grant can select its ledger rows. */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { grantPurpose, isHostedMode } from "@merrymen/core";
import { merrymenHome, purposeHome } from "@merrymen/home";
import { withLocalStateLock } from "../../../../../worker/src/local-state-lock";
import { readLocalPerpsBinding } from "../../../../../worker/src/local-perps-binding";
import { getGrantStore } from "@merrymen/grant-store";
import { tenantOf } from "@/lib/auth";
import { withReadDb } from "@/lib/ledger";
import type { Db } from "@merrymen/db";
import type { PerpsIdentity } from "@/lib/perps-account";
export type PerpsSelection = PerpsIdentity & { state: "ready" | "not-configured" | "unread" };
export async function selectPerpsAccount(req: Request): Promise<PerpsSelection> {
  const owner = isHostedMode() ? tenantOf(req) : null;
  const absent: PerpsSelection = { owner, account: null, state: "not-configured" };
  try {
    let grant: unknown;
    if (isHostedMode()) {
      if (!owner) return absent;
      const store = getGrantStore("perps");
      grant = await store.get(owner);
      if (!grant) return { ...absent, state: await store.hasStoredGrant(owner) ? "unread" : "not-configured" };
    } else {
      grant = await withLocalStateLock(merrymenHome(), async () => {
        try { return JSON.parse((await readFile(path.join(purposeHome("perps"), "grant.json"), "utf8")).replace(/^\ufeff/, "")); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          if (readLocalPerpsBinding()) throw new Error("Perps renewal is pending");
          return undefined;
        }
      });
      if (grant === undefined) return absent;
    }
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) throw new Error("unreadable grant");
    const g = grant as { purpose?: unknown; smartAccount?: unknown; chainId?: unknown };
    if (grantPurpose(g) !== "perps" || typeof g.smartAccount !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(g.smartAccount) ||
      typeof g.chainId !== "number" || !Number.isSafeInteger(g.chainId) || g.chainId <= 0) throw new Error("unreadable grant");
    return { owner, account: { smartAccount: g.smartAccount.toLowerCase(), chainId: g.chainId }, state: "ready" };
  } catch { return { ...absent, state: "unread" }; }
}
/** Unlike the legacy dashboard, a corrupt/open-refused file must not look absent. */
export async function withPerpsReadDb<T>(fn: (db: Db | null) => Promise<T>): Promise<T> {
  let present = false;
  if (!process.env.DATABASE_URL) {
    try { const info = await stat(path.join(purposeHome("perps"), "merrymen.db")); if (!info.isFile()) throw new Error("unreadable ledger"); present = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return withReadDb(db => { if (!db && present) throw new Error("unreadable ledger"); return fn(db); }, "perps");
}
