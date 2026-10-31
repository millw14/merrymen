/** Public identity retained while a local Perps permission is being replaced. */
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { grantPurpose } from "../../packages/core/src/grant";
import { writeFileAtomicSync, fsyncDirSync } from "./atomic-write";
import { purposeHome } from "./home";
export const LOCAL_PERPS_BINDING_FILE = "permission-replacement.json";
export interface LocalPerpsBinding {
  v: 1;
  purpose: "perps";
  owner: `0x${string}`;
  smartAccount: `0x${string}`;
  sessionKeyAddress: `0x${string}`;
  chainId: number;
}
const address = (value: unknown): value is `0x${string}` => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
/** Whitelist: neither owner/session secrets nor signed permissions enter this record. */
export function localPerpsBinding(value: unknown): LocalPerpsBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Perps replacement identity is unreadable");
  const g = value as Record<string, unknown>;
  if (grantPurpose(g) !== "perps" || !address(g.owner) || !address(g.smartAccount) || !address(g.sessionKeyAddress) ||
      !Number.isSafeInteger(g.chainId) || Number(g.chainId) <= 0) throw new Error("Perps replacement identity is unreadable");
  return { v: 1, purpose: "perps", owner: g.owner.toLowerCase() as `0x${string}`, smartAccount: g.smartAccount.toLowerCase() as `0x${string}`,
    sessionKeyAddress: g.sessionKeyAddress.toLowerCase() as `0x${string}`, chainId: g.chainId as number };
}
/** Only ENOENT means no identity; corruption blocks replacing either wallet. */
export function readLocalPerpsBinding(home = purposeHome("perps")): LocalPerpsBinding | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path.join(home, LOCAL_PERPS_BINDING_FILE), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  if ((raw as { v?: unknown } | null)?.v !== 1) throw new Error("Perps replacement identity is unreadable");
  return localPerpsBinding(raw);
}
/** Caller holds the install writer lock; must complete before removing grant.json. */
export function retainLocalPerpsBinding(grant: unknown, home = purposeHome("perps")): void {
  writeFileAtomicSync(path.join(home, LOCAL_PERPS_BINDING_FILE), JSON.stringify(localPerpsBinding(grant)), 0o600, { durable: true });
}
/** Caller holds the same lock and has durably installed a new grant, or completed a kill. */
export function clearLocalPerpsBinding(home = purposeHome("perps")): void {
  try { rmSync(path.join(home, LOCAL_PERPS_BINDING_FILE)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  fsyncDirSync(home);
}
