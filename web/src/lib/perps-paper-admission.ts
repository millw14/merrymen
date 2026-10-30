import { NextResponse } from "next/server";
import { perpsPaperTenantAllowed } from "../../../packages/core/src/perps-paper-admission";
import { tenantOf } from "./auth";
import { NO_STORE_HEADERS } from "./route-guard";

/** This gates new authority and switch-on, never reads, off, exits, kills or recovery. */
export function perpsPaperAdmissionRefusal(req: Request, hosted: boolean): NextResponse | null {
  if (!hosted) return null;
  const tenant = tenantOf(req);
  if (!tenant) return NextResponse.json({ error: "Sign in to join the paper pilot." }, { status: 401, headers: NO_STORE_HEADERS });
  if (perpsPaperTenantAllowed(tenant)) return null;
  return NextResponse.json({ error: "Paper Perps is currently limited to invited internal accounts. Your existing wallets and recovery access are unchanged.", code: "perps-pilot-invitation-required" }, { status: 403, headers: NO_STORE_HEADERS });
}
