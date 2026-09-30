import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { getPartnerStore } from "@/lib/partner-store";
import { PartnerError, objectBody, onlyFields, partnerAppOrigin, readPartnerBody } from "@/lib/partner-bridge";
import { partnerFailure } from "@/lib/partner-service";
import { getGrantStore } from "../../../../../worker/src/grant-store";
import { getIdentityStore } from "../../../../../worker/src/identity-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const json = (body: unknown) => Response.json(body, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

export async function POST(req: Request) {
  if (!isHostedMode()) return Response.json({ error: { code: "not_found", message: "Hosted API only" } }, { status: 404 });
  try {
    const origin = req.headers.get("origin");
    if (origin && origin !== partnerAppOrigin()) throw new PartnerError(403, "forbidden", "Open this page on Merrymen to connect your agent");
    const body = objectBody(await readPartnerBody(req, 4096));
    onlyFields(body, ["action", "token", "id"]);
    const store = getPartnerStore();
    const tenant = tenantOf(req);
    if (body.action === "disconnect") {
      if (!tenant) throw new PartnerError(401, "unauthorized", "Sign in first");
      if (typeof body.id !== "string" || !await store.revokeByTenant(body.id, tenant)) throw new PartnerError(404, "not_found", "Connection not found");
      return json({ connected: false, id: body.id });
    }
    if (!["inspect", "connect"].includes(String(body.action)) || typeof body.token !== "string" || body.token.length > 512) throw new PartnerError(400, "bad_request", "Invalid connection request");
    const connection = await store.byToken(body.token);
    if (!connection) throw new PartnerError(410, "expired", "This setup link has expired or was already used. Ask your app for a new link.");
    const grant = tenant ? await getGrantStore().get(tenant) : null;
    const active = !!grant && grant.expiresAt > Math.floor(Date.now() / 1000);
    if (body.action === "inspect") return json({ id: connection.id, partner_name: connection.partnerName,
      name: connection.name, scopes: connection.scopes, status: connection.status,
      signed_in: !!tenant, has_agent: active });
    if (!tenant) throw new PartnerError(401, "unauthorized", "Sign in before connecting your Merryman");
    if (!grant || !active) throw new PartnerError(409, "grant_required", "Create or renew your Merryman's trading permission first");
    await getIdentityStore().ensure(tenant, grant.smartAccount);
    await store.bind(body.token, tenant, connection.scopes);
    return json({ connected: true, id: connection.id });
  } catch (error) { return partnerFailure(error); }
}
