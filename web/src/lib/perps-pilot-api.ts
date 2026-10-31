/** Server boundaries for pilot enrollment and its separate administrator role. */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { getPerpsPilotStore } from "../../../worker/src/perps/pilot-store";
import { disablePaperPerpsForKill, getSettingsStore } from "@merrymen/settings-store";
import { requestOrigin, tenantOf } from "./auth";
import { perpsCreationAllowed } from "./perps-enabled";
import { NO_STORE_HEADERS } from "./route-guard";

export const pilotAddress = (value: unknown): value is `0x${string}` => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
export function pilotReply(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE_HEADERS, ...headers } });
}
export const pilotUnavailable = () => pilotReply({ error: "Paper access is temporarily unavailable. Please try again shortly.", code: "perps-pilot-unavailable", ownerFacing: true }, 503);
export const pilotWalletRefusal = () => pilotReply({ error: "Name the Perps wallet explicitly. Nothing was read or changed.", code: "wallet-not-supported" }, 400);

/** Dedicated role; membership, invite possession and body fields never confer it. */
export function isPerpsPilotAdmin(owner: string): boolean {
  const raw = process.env.MERRYMEN_PERPS_PILOT_ADMINS;
  if (!raw || !pilotAddress(owner)) return false;
  const entries = raw.split(",").map(value => value.trim().toLowerCase());
  return entries.length <= 20 && entries.every(pilotAddress) && entries.some(entry => entry === owner.toLowerCase());
}

export function pilotActor(req: Request, admin = false): `0x${string}` | NextResponse {
  if (!isHostedMode()) return pilotReply({ error: "Pilot enrollment is available on the hosted app only." }, 404);
  const tenant = tenantOf(req);
  if (!tenant) return pilotReply({ error: "Sign in to continue.", code: "sign-in-required" }, 401);
  if (admin && !isPerpsPilotAdmin(tenant)) return pilotReply({ error: "This account cannot manage pilot access.", code: "pilot-admin-required" }, 403);
  return tenant;
}

/** Browser mutations carry the signed session and an exact same-origin request. */
export function pilotMutationRefusal(req: Request): NextResponse | null {
  const origin = req.headers.get("origin");
  try {
    if (!origin || origin !== new URL(requestOrigin(req)).origin) return pilotReply({ error: "Open this page on the Merrymen app and try again.", code: "origin-refused" }, 403);
  } catch { return pilotReply({ error: "This request's origin could not be verified.", code: "origin-refused" }, 403); }
  return null;
}

/** Bounded bytes and time, including chunked bodies without Content-Length. */
export async function readPilotBody(req: Request): Promise<Record<string, unknown> | NextResponse> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers.get("content-type") ?? "")) return pilotReply({ error: "Send a JSON request." }, 415);
  const limit = 4096;
  const length = req.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) return pilotReply({ error: "That request is too large." }, 413);
  if (!req.body) return pilotReply({ error: "The request is empty." }, 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("body-timeout")), 10_000); timer.unref?.(); });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) { void reader.cancel().catch(() => {}); return pilotReply({ error: "That request is too large." }, 413); }
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) return pilotReply({ error: "Send a JSON object." }, 400);
    return body as Record<string, unknown>;
  } catch { void reader.cancel().catch(() => {}); return pilotReply({ error: "The request could not be read. Please try again." }, 400); }
  finally { if (timer) clearTimeout(timer); reader.releaseLock(); }
}

export function pilotFields(body: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(body).every(key => fields.includes(key));
}
export function pilotSessionRefusal(body: Record<string, unknown>, tenant: string): NextResponse | null {
  return pilotAddress(body.expectedTenant) && body.expectedTenant.toLowerCase() === tenant.toLowerCase() ? null
    : pilotReply({ error: "The signed-in account changed. Reload before continuing.", code: "account-changed" }, 409);
}
export async function pilotStatus(tenant: `0x${string}`) {
  const admission = await getPerpsPilotStore().get(tenant);
  return { tenant, status: admission.status, revision: admission.revision, paperAvailable: perpsCreationAllowed(), admin: isPerpsPilotAdmin(tenant) };
}

/** Called under the cohort transaction before a new admission commits. A
 * renewed membership never resurrects an old entries-on switch or stale save.
 * A failure leaves membership denied; a later commit failure leaves entries off. */
export function preparePilotAdmission(owner: `0x${string}`) {
  return disablePaperPerpsForKill(owner, getSettingsStore("perps"), true);
}
