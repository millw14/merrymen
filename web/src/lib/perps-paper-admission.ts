import { NextResponse } from "next/server";
import { getPerpsPilotStore } from "../../../worker/src/perps/pilot-store";
import { tenantOf } from "./auth";
import { NO_STORE_HEADERS } from "./route-guard";

/** Fresh preflight; the mutation boundary must also use withPerpsPaperAdmission. */
export async function perpsPaperAdmission(owner: string): Promise<"allowed" | "denied" | "unavailable"> {
  try { return (await getPerpsPilotStore().get(owner)).status === "allowed" ? "allowed" : "denied"; }
  catch { return "unavailable"; }
}

/** Orders a short authority write against admin revocation in the shared store.
 * Authentication and network verification belong before this lock. The action
 * must not call the pilot store recursively. Existing exits/off never use it.
 */
export async function withPerpsPaperAdmission<T>(owner: string, action: () => Promise<T>): Promise<
  { status: "allowed"; value: T } | { status: "denied" | "unavailable" }
> {
  try {
    const result = await getPerpsPilotStore().withAdmission(owner, action);
    return result.allowed ? { status: "allowed", value: result.value } : { status: "denied" };
  } catch { return { status: "unavailable" }; }
}

export function perpsPaperAdmissionFailure(admission: "denied" | "unavailable"): NextResponse {
  if (admission === "unavailable") return NextResponse.json({ error: "Paper access could not be verified. Try again shortly; existing recovery and exit controls remain available.", code: "perps-pilot-unavailable", ownerFacing: true }, { status: 503, headers: NO_STORE_HEADERS });
  return NextResponse.json({ error: "Join the paper pilot with an invite code, or ask an administrator for access.", code: "perps-pilot-invitation-required" }, { status: 403, headers: NO_STORE_HEADERS });
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
