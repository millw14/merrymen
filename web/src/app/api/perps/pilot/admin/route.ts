import { getPerpsPilotStore } from "../../../../../../../worker/src/perps/pilot-store";
import { readWalletParam } from "@/lib/wallet-param";
import { walletUnknown } from "@/lib/route-guard";
import { isPerpsPilotAdmin, pilotActor, pilotAddress, pilotFields, pilotMutationRefusal, pilotReply, pilotSessionRefusal, pilotUnavailable, pilotWalletRefusal, preparePilotAdmission, readPilotBody } from "@/lib/perps-pilot-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const wallet = readWalletParam(req);
  if (wallet === null) return walletUnknown("Nothing was read.");
  if (wallet !== "perps") return pilotWalletRefusal();
  const tenant = pilotActor(req, true); if (typeof tenant !== "string") return tenant;
  try {
    const result = await getPerpsPilotStore().list();
    if (!isPerpsPilotAdmin(tenant)) return pilotReply({ error: "Administrator access changed. Reload this page." }, 403);
    return pilotReply({ tenant, revision: result.revision, capacity: result.limit, requestLimit: result.requestLimit,
      requests: result.requests.map(({ owner, inviteId, submittedAt }) => ({ owner, inviteId, submittedAt })),
      admissions: result.admissions.map(({ owner, status, revision, updatedAt }) => ({ owner, status, revision, updatedAt })),
      invites: result.invites.map(({ id, createdAt, expiresAt, maxUses, uses, revokedAt }) => ({ id, createdAt, expiresAt, maxUses, uses, revoked: revokedAt !== null })) });
  } catch { return pilotUnavailable(); }
}

export async function POST(req: Request) {
  const wallet = readWalletParam(req);
  if (wallet === null) return walletUnknown("Nothing was changed.");
  if (wallet !== "perps") return pilotWalletRefusal();
  const tenant = pilotActor(req, true); if (typeof tenant !== "string") return tenant;
  const originRefused = pilotMutationRefusal(req); if (originRefused) return originRefused;
  const body = await readPilotBody(req); if (body instanceof Response) return body;
  const switched = pilotSessionRefusal(body, tenant); if (switched) return switched;
  if (!isPerpsPilotAdmin(tenant)) return pilotReply({ error: "Administrator access changed. Reload this page." }, 403);
  try {
    const store = getPerpsPilotStore();
    if (body.action === "create-invite") {
      if (!pilotFields(body, ["action", "expectedTenant", "maxUses", "expiresInDays"]) || typeof body.maxUses !== "number" || !Number.isInteger(body.maxUses) || body.maxUses < 1 || body.maxUses > 100 || typeof body.expiresInDays !== "number" || !Number.isInteger(body.expiresInDays) || body.expiresInDays < 1 || body.expiresInDays > 30) return pilotReply({ error: "Choose 1–100 uses and an expiry of 1–30 days." }, 400);
      const result = await store.createInvite({ actor: tenant, maxUses: body.maxUses, expiresAt: Date.now() + body.expiresInDays * 86_400_000 });
      const { id, createdAt, expiresAt, maxUses, uses, revokedAt } = result.invite;
      return pilotReply({ code: result.code, invite: { id, createdAt, expiresAt, maxUses, uses, revoked: revokedAt !== null } }, 201);
    }
    if (body.action === "set-admission") {
      if (!pilotFields(body, ["action", "expectedTenant", "owner", "status", "expectedRevision"]) || !pilotAddress(body.owner) || !["allowed", "revoked"].includes(String(body.status)) || typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) return pilotReply({ error: "Check the public owner wallet, access choice and current list revision." }, 400);
      const owner = body.owner;
      const result = await store.setAdmission({ actor: tenant, owner, status: body.status as "allowed" | "revoked", expectedRevision: body.expectedRevision, beforeAdmit: () => preparePilotAdmission(owner) });
      if (result.outcome === "stale") return pilotReply({ error: "The access list changed. Reload and review it before saving.", code: "pilot-list-changed" }, 409);
      if (result.outcome === "full") return pilotReply({ error: "The pilot has reached its 100-account limit.", code: "pilot-full" }, 409);
      return pilotReply({ ok: true, revision: result.revision });
    }
    if (body.action === "revoke-invite") {
      if (!pilotFields(body, ["action", "expectedTenant", "id"]) || typeof body.id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.id)) return pilotReply({ error: "Choose a valid invite from the list." }, 400);
      await store.revokeInvite({ actor: tenant, id: body.id });
      return pilotReply({ ok: true });
    }
    return pilotReply({ error: "Choose a supported access-management action." }, 400);
  } catch { return pilotUnavailable(); }
}
