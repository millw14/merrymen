import { requestJson } from "../terminal/request-json";

export const PILOT_URL = "/api/perps/pilot?wallet=perps";
export const PILOT_ADMIN_URL = "/api/perps/pilot/admin?wallet=perps";
export interface PilotAccess { tenant: string; status: "allowed" | "revoked" | "not-admitted"; revision: number; paperAvailable: boolean; admin: boolean }
export interface PilotAdmission { owner: string; status: "allowed" | "revoked"; revision: number; updatedAt: number }
export interface PilotInvite { id: string; createdAt: number; expiresAt: number; maxUses: number; uses: number; revoked: boolean }
export interface PilotAdminData { tenant: string; revision: number; admissions: PilotAdmission[]; invites: PilotInvite[]; capacity: number }
export type PilotAdminAction = { action: "create-invite"; maxUses: number; expiresInDays: number }
  | { action: "set-admission"; owner: string; status: "allowed" | "revoked"; expectedRevision: number }
  | { action: "revoke-invite"; id: string };

export const isOwner = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export function parsePilotAccess(v: unknown): PilotAccess {
  if (!record(v) || !isOwner(v.tenant) || !["allowed", "revoked", "not-admitted"].includes(String(v.status))
      || !integer(v.revision) || typeof v.paperAvailable !== "boolean" || typeof v.admin !== "boolean") throw new Error("Pilot access could not be verified. Refresh before continuing.");
  return { tenant: v.tenant.toLowerCase(), status: v.status as PilotAccess["status"], revision: v.revision, paperAvailable: v.paperAvailable, admin: v.admin };
}
export function parsePilotInvite(v: unknown): PilotInvite {
  if (!record(v) || typeof v.id !== "string" || !v.id || v.id.length > 128 || !integer(v.createdAt) || !integer(v.expiresAt)
      || !integer(v.maxUses) || v.maxUses < 1 || v.maxUses > 100 || !integer(v.uses) || v.uses > v.maxUses || typeof v.revoked !== "boolean") throw new Error("The invitation record could not be verified.");
  return { id: v.id, createdAt: v.createdAt, expiresAt: v.expiresAt, maxUses: v.maxUses, uses: v.uses, revoked: v.revoked };
}
export function parsePilotAdmin(v: unknown, tenant: string): PilotAdminData {
  if (!record(v) || !isOwner(v.tenant) || v.tenant.toLowerCase() !== tenant.toLowerCase() || !integer(v.revision)
      || !integer(v.capacity) || v.capacity !== 100 || !Array.isArray(v.admissions) || !Array.isArray(v.invites)) throw new Error("The admin response belongs to an unknown account or could not be read.");
  const admissions = v.admissions.map(row => {
    if (!record(row) || !isOwner(row.owner) || !["allowed", "revoked"].includes(String(row.status)) || !integer(row.revision) || !integer(row.updatedAt)) throw new Error("An admission record could not be verified.");
    return { owner: row.owner.toLowerCase(), status: row.status as PilotAdmission["status"], revision: row.revision, updatedAt: row.updatedAt };
  });
  if (new Set(admissions.map(row => row.owner)).size !== admissions.length) throw new Error("Duplicate admission records were returned. Refresh before changing access.");
  return { tenant: v.tenant.toLowerCase(), revision: v.revision, capacity: v.capacity, admissions, invites: v.invites.map(parsePilotInvite) };
}
export async function readPilotSession(signal?: AbortSignal): Promise<string | null> {
  const v = await requestJson<unknown>("/api/auth/session", { signal });
  if (!record(v) || v.hosted !== true || v.address !== null && !isOwner(v.address)) throw new Error("A hosted sign-in is required for the paper pilot.");
  return v.address === null ? null : (v.address as string).toLowerCase();
}
export const pilotError = (error: unknown) => error instanceof Error ? error.message : "The request could not be confirmed. Refresh before trying again.";
