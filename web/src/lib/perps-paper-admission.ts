import { NextResponse } from "next/server";
import type { Db } from "../../../worker/src/db";
import { getPerpsPilotStore } from "../../../worker/src/perps/pilot-store";
import { tenantOf } from "./auth";
import { NO_STORE_HEADERS } from "./route-guard";

/**
 * Fresh preflight; the mutation boundary must also use withPerpsPaperAdmission.
 * `held`: the connection a caller holding a session lock already has (the
 * settings save lock's): the read runs on it, never on a second connection
 * from the pool that lock came from.
 */
export async function perpsPaperAdmission(owner: string, held?: Db | null): Promise<"allowed" | "denied" | "unavailable"> {
  try { return (await getPerpsPilotStore().get(owner, held)).status === "allowed" ? "allowed" : "denied"; }
  catch { return "unavailable"; }
}

/** Orders a short authority write against admin revocation in the shared store.
 * Authentication and network verification belong before this lock. The action
 * must not call the pilot store recursively. Existing exits/off never use it.
 * `held`: as perpsPaperAdmission's.
 */
export async function withPerpsPaperAdmission<T>(owner: string, action: () => Promise<T>, held?: Db | null): Promise<
  { status: "allowed"; value: T } | { status: "denied" | "unavailable" }
> {
  try {
    const result = await getPerpsPilotStore().withAdmission(owner, action, held);
    return result.allowed ? { status: "allowed", value: result.value } : { status: "denied" };
  } catch { return { status: "unavailable" }; }
}

export function perpsPaperAdmissionFailure(admission: "denied" | "unavailable"): NextResponse {
  if (admission === "unavailable") return NextResponse.json({ error: "Paper access could not be verified. Try again shortly; existing recovery and exit controls remain available.", code: "perps-pilot-unavailable", ownerFacing: true }, { status: 503, headers: NO_STORE_HEADERS });
  return NextResponse.json({ error: "Paper-pilot access requires administrator approval. Submit an invite code to request access, then wait for your wallet to be approved.", code: "perps-pilot-invitation-required" }, { status: 403, headers: NO_STORE_HEADERS });
}

/** This gates new authority and switch-on, never reads, off, exits, kills or recovery. */
export async function perpsPaperAdmissionRefusal(req: Request, hosted: boolean): Promise<NextResponse | null> {
  if (!hosted) return null;
  const tenant = tenantOf(req);
  if (!tenant) return NextResponse.json({ error: "Sign in to join the paper pilot." }, { status: 401, headers: NO_STORE_HEADERS });
  const admission = await perpsPaperAdmission(tenant);
  if (admission === "allowed") return null;
  return perpsPaperAdmissionFailure(admission);
}
