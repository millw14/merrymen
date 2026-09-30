import { randomBytes } from "node:crypto";
import { PartnerError, objectBody, onlyFields, partnerAppOrigin, readPartnerBody, requirePartnerScope, verifyPartnerRequest, type PartnerPrincipal } from "./partner-bridge";
import { PartnerStoreError, type PartnerConnection, type PartnerStore } from "./partner-store";
import type { readPartnerRuntime, replyToPartner } from "./partner-runtime";
import type { createPartnerEnrollmentService } from "./partner-enrollment";

type Runtime = Awaited<ReturnType<typeof readPartnerRuntime>>;
export function partnerFailure(error: unknown): Response {
  const known = error instanceof PartnerError || error instanceof PartnerStoreError;
  return Response.json({ error: { code: known ? error.code : "upstream_unavailable",
    message: known ? error.message : "Agent service is temporarily unavailable",
    request_id: `req_${randomBytes(6).toString("hex")}` } },
  { status: known ? error.status : 503, headers: { "Cache-Control": "no-store" } });
}

function view(connection: PartnerConnection, runtime?: Runtime, token?: string | null) {
  // Explicit wire fields: do not leak tenant addresses, token hashes or wallet material.
  return {
    id: connection.id, external_user_id: connection.externalUserId,
    name: runtime?.name || connection.name,
    status: connection.status === "pending" ? "pending_authorization" : connection.status === "revoked" ? "disconnected" : runtime?.status ?? "connected",
    created_at: connection.createdAt,
    ...(token ? { onboarding_url: `${partnerAppOrigin()}/connect#token=${encodeURIComponent(token)}`, onboarding_expires_at: connection.expiresAt } : {}),
    ...(runtime ? { agent: {
      id: runtime.slug, mode: runtime.mode, worker_alive_at: runtime.worker_alive_at,
      heartbeat_fresh: runtime.heartbeat_fresh, live_blocker: runtime.live_blocker,
      live_trading_enabled: runtime.live_trading_enabled, ledger_available: runtime.ledger_available,
    } } : {}),
  };
}

function allowed(connection: PartnerConnection, scope: string) {
  if (connection.status !== "linked" || !connection.tenant) throw new PartnerError(409, "authorization_required", "The owner must connect their Merryman first");
  if (!connection.scopes.includes(scope)) throw new PartnerError(403, "forbidden_scope", "The owner has not approved this capability");
  return connection.tenant;
}

export function createPartnerService(deps: {
  store: PartnerStore;
  readRuntime: typeof readPartnerRuntime;
  reply: typeof replyToPartner;
  enrollment?: ReturnType<typeof createPartnerEnrollmentService>;
  secret?: string;
}) {
  const store = deps.store;
  async function dispatch(partner: PartnerPrincipal, method: string, path: string, raw: string) {
    if (path === "/agents" && method === "POST") {
      requirePartnerScope(partner, "write:agents");
      const body = objectBody(raw);
      onlyFields(body, ["external_user_id", "name"]);
      if (typeof body.external_user_id !== "string" || !/^[^\s\x00-\x1f\x7f]{1,128}$/.test(body.external_user_id)) {
        throw new PartnerError(400, "bad_request", "external_user_id must be an opaque identifier of 1–128 characters");
      }
      if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length < 1 || body.name.length > 64 || /[\x00-\x1f\x7f]/.test(body.name))) {
        throw new PartnerError(400, "bad_request", "name must contain 1–64 characters");
      }
      const scopes = ["read:agents", ...(partner.scopes.includes("chat:agents") ? ["chat:agents"] : [])];
      const created = await store.create({ partnerId: partner.app_id, partnerName: partner.name,
        externalUserId: body.external_user_id, name: typeof body.name === "string" ? body.name.trim() : "Your Merryman", scopes });
      return { status: created.connection.status === "linked" ? 200 : 202,
        body: view(created.connection, undefined, created.token) };
    }
    if (path === "/agents" && method === "GET") {
      requirePartnerScope(partner, "read:agents");
      return { status: 200, body: { data: (await store.list(partner.app_id)).map(c => view(c)) } };
    }
    const match = /^\/agents\/([a-zA-Z0-9_-]{12,80})(?:\/(messages|connection|challenge|activate))?$/.exec(path);
    if (!match) throw new PartnerError(404, "not_found", "No such endpoint");
    const [, id, resource] = match;
    const connection = await store.byId(partner.app_id, id);
    if (!connection) throw new PartnerError(404, "not_found", "Agent not found");
    if ((resource === "challenge" || resource === "activate") && method === "POST") {
      requirePartnerScope(partner, "write:agents");
      if (!deps.enrollment) throw new PartnerError(503, "upstream_unavailable", "Embedded setup is not configured");
      const input = objectBody(raw);
      if (resource === "challenge") return { status: 200, body: await deps.enrollment.challenge(partner, connection, input) };
      const activated = await deps.enrollment.activate(partner, connection, input);
      return { status: 200, body: { ...view(activated.connection, await deps.readRuntime(activated.connection.tenant!)),
        wallet: { smart_account: activated.smartAccount, chain_id: activated.chainId } } };
    }
    if (!resource && method === "GET") {
      requirePartnerScope(partner, "read:agents");
      const runtime = connection.status === "linked" && connection.tenant ? await deps.readRuntime(allowed(connection, "read:agents")) : undefined;
      return { status: 200, body: view(connection, runtime) };
    }
    if (resource === "connection" && method === "DELETE") {
      requirePartnerScope(partner, "write:agents");
      await store.revoke(partner.app_id, id);
      return { status: 200, body: { id, status: "disconnected" } };
    }
    if (resource === "messages" && ["GET", "POST"].includes(method)) {
      requirePartnerScope(partner, "chat:agents");
      allowed(connection, "chat:agents");
      if (method === "GET") return { status: 200, body: { agent_id: id, messages: await store.readMessages(id) } };
      const body = objectBody(raw);
      onlyFields(body, ["message", "request_id"]);
      if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 2000) throw new PartnerError(400, "bad_request", "message must contain 1–2000 characters");
      if (typeof body.request_id !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(body.request_id)) throw new PartnerError(400, "bad_request", "request_id must contain 8–128 letters, numbers, underscores or hyphens");
      const message = body.message.trim(), requestId = body.request_id;
      return store.withConversationLock(id, async () => {
        // Recheck consent after acquiring the lock; revocation may have raced the request.
        const current = await store.byId(partner.app_id, id);
        if (!current) throw new PartnerError(404, "not_found", "Agent not found");
        const tenant = allowed(current, "chat:agents");
        let exchange = await store.getExchange(id, requestId);
        if (exchange && exchange.message !== message) throw new PartnerError(409, "idempotency_conflict", "request_id was already used for another message");
        if (!exchange) {
          const result = await deps.reply(tenant, { message, history: await store.readMessages(id) });
          const saved = await store.appendExchange(id, { requestId, message, reply: result.reply, command: result.command });
          exchange = saved.exchange;
        }
        return { status: 200, body: { agent_id: id, request_id: requestId, reply: exchange.reply,
          proposal: exchange.command ?? null, created_at: exchange.createdAt } };
      });
    }
    throw new PartnerError(405, "bad_request", "Method not supported for this endpoint");
  }
  return {
    dispatch,
    async handle(req: Request, path: string): Promise<Response> {
      try {
        const raw = await readPartnerBody(req, path.endsWith("/activate") ? 256 * 1024 : 32_768);
        const partner = await verifyPartnerRequest(req, raw, path, { secret: deps.secret, consumeNonce: (nonce, expires) => store.consumeNonce(nonce, expires) });
        const result = await dispatch(partner, req.method, path, raw);
        return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
      } catch (error) { return partnerFailure(error); }
    },
  };
}
