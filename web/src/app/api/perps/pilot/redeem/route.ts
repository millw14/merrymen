import { getIdentityStore } from "@merrymen/identity-store";
import { getPerpsPilotStore } from "../../../../../../../worker/src/perps/pilot-store";
import { privyTokenOf, verifyPrivyToken } from "@/lib/privy";
import { readWalletParam } from "@/lib/wallet-param";
import { walletUnknown } from "@/lib/route-guard";
import { pilotActor, pilotFields, pilotMutationRefusal, pilotReply, pilotSessionRefusal, pilotStatus, pilotUnavailable, pilotWalletRefusal, readPilotBody } from "@/lib/perps-pilot-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const wallet = readWalletParam(req);
  if (wallet === null) return walletUnknown("Nothing was registered.");
  if (wallet !== "perps") return pilotWalletRefusal();
  const tenant = pilotActor(req);
  if (typeof tenant !== "string") return tenant;
  const originRefused = pilotMutationRefusal(req); if (originRefused) return originRefused;
  const body = await readPilotBody(req); if (body instanceof Response) return body;
  const switched = pilotSessionRefusal(body, tenant); if (switched) return switched;
  if (!pilotFields(body, ["code", "expectedTenant"]) || typeof body.code !== "string" || body.code.length > 128) return pilotReply({ error: "Enter a valid invite code.", code: "invalid-invite" }, 400);
  try {
    // Current verified login, not a claimed DID or a user-supplied wallet.
    const token = await verifyPrivyToken(privyTokenOf(req));
    if (!token.ok) return pilotReply({ error: "Sign in again before using this invite.", code: "sign-in-required" }, 401);
    const identity = await getIdentityStore().byDid(token.identity.did);
    if (!identity || identity.tenant.toLowerCase() !== tenant.toLowerCase()) return pilotReply({ error: "Your login does not match this session. Sign in again before continuing.", code: "account-changed" }, 409);
    // An invitation submits this verified owner for review. Only the admin
    // approval route may admit the owner or reset their entry settings.
    const result = await getPerpsPilotStore().redeem({ owner: tenant, code: body.code.trim() });
    if (result.outcome === "pending" || result.outcome === "already-pending" || result.outcome === "already-admitted") return pilotReply(await pilotStatus(tenant));
    if (result.outcome === "limited") return pilotReply({ error: "Too many invite attempts. Wait a moment before trying again.", code: "invite-rate-limited" }, 429, { "Retry-After": String(result.retryAfterSec ?? 60) });
    if (result.outcome === "revoked") return pilotReply({ error: "An administrator has removed access for this account. Ask them to review it.", code: "pilot-access-revoked" }, 403);
    if (result.outcome === "full") return pilotReply({ error: "The review queue is currently full. Please try again after an administrator reviews the pending requests.", code: "pilot-queue-full" }, 409);
    return pilotReply({ error: "That invite is unavailable, expired or fully used. Ask for a new code.", code: "invalid-invite" }, 400);
  } catch { return pilotUnavailable(); }
}
