import { randomBytes } from "node:crypto";
import { PartnerError, objectBody, onlyFields, partnerAppOrigin, readPartnerBody, requirePartnerScope, verifyPartnerRequest, type PartnerPrincipal } from "./partner-bridge";
import {
  fitPartnerReply, partnerCommandFits, partnerText, PartnerStoreError, PARTNER_MESSAGE_MAX, toWellFormed, wellFormed,
  type PartnerConnection, type PartnerStore,
} from "./partner-store";
import type { readPartnerRuntime, replyToPartner } from "./partner-runtime";

/** From the request's arrival to its reply being saved: 5s inside the gateway bridge's 45s timeout. */
export const PARTNER_REPLY_BUDGET_MS = 40_000;
import type { createPartnerEnrollmentService } from "./partner-enrollment";

type Runtime = Awaited<ReturnType<typeof readPartnerRuntime>>;
/** Saved, like any reply, when a model answer had nothing printable left: never an empty message. */
const UNUSABLE_REPLY = "My conversational service did not return a usable reply. I have not executed any action from this message.";
export function partnerFailure(error: unknown): Response {
  // PartnerRuntimeError is a PartnerError: its status and code are answers too.
  // Anything else may carry internal detail and becomes a generic 503.
  const known = error instanceof PartnerError || error instanceof PartnerStoreError;
  // A busy lock is safe to resend unchanged. The hint rides in the body too:
  // the gateway forwards a status and JSON, not this response's headers.
  const retryAfter = error instanceof PartnerStoreError && Number.isSafeInteger(error.retryAfter) && error.retryAfter! > 0 ? error.retryAfter! : null;
  return Response.json({ error: { code: known ? error.code : "upstream_unavailable",
    message: known ? error.message : "Agent service is temporarily unavailable",
    ...(retryAfter ? { retry_after: retryAfter } : {}),
    request_id: `req_${randomBytes(6).toString("hex")}` } },
  { status: known ? error.status : 503, headers: { "Cache-Control": "no-store", ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) } });
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
      // Well-formed, like every text the store keeps (partnerText): a lone surrogate is not an identifier.
      if (typeof body.external_user_id !== "string" || !/^[^\s\x00-\x1f\x7f]{1,128}$/.test(body.external_user_id) || !wellFormed(body.external_user_id)) {
        throw new PartnerError(400, "bad_request", "external_user_id must be an opaque identifier of 1–128 characters");
      }
      if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length < 1 || body.name.length > 64 || /[\x00-\x1f\x7f]/.test(body.name) || !wellFormed(body.name))) {
        throw new PartnerError(400, "bad_request", "name must contain 1–64 characters");
      }
      const scopes = ["read:agents", ...(partner.scopes.includes("chat:agents") ? ["chat:agents"] : [])];
      // The key's name is the gateway's signed metadata, not the partner's input
      // to refuse: made well-formed rather than failing every create for that key.
      const created = await store.create({ partnerId: partner.app_id, partnerName: toWellFormed(partner.name),
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
      // Activation has committed. A failed status read used to answer 503, and
      // the partner's retry then met a spent challenge: report the success with
      // the worker's state marked unknown instead.
      const runtime = await deps.readRuntime(activated.connection.tenant!).catch(() => null);
      return { status: 200, body: { ...view(activated.connection, runtime ?? undefined), ...(runtime ? {} : { runtime_available: false }),
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
      // The store's own rule, checked before the model is paid for: a message it
      // would refuse used to cost a generation first, then fail as a 400 anyway.
      if (typeof body.message !== "string" || body.message.length > PARTNER_MESSAGE_MAX || !partnerText(body.message.trim(), PARTNER_MESSAGE_MAX, true)) {
        throw new PartnerError(400, "bad_request", "message must contain 1–2000 characters, with no control characters other than tabs and line breaks");
      }
      if (typeof body.request_id !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(body.request_id)) throw new PartnerError(400, "bad_request", "request_id must contain 8–128 letters, numbers, underscores or hyphens");
      const message = body.message.trim(), requestId = body.request_id;
      // The whole answer, lock wait included, must reach the gateway inside its
      // 45s upstream timeout; the model gets what is left of this budget.
      const deadline = Date.now() + PARTNER_REPLY_BUDGET_MS;
      return store.withConversationLock(id, async () => {
        // Recheck consent after acquiring the lock; revocation may have raced the request.
        const current = await store.byId(partner.app_id, id);
        if (!current) throw new PartnerError(404, "not_found", "Agent not found");
        const tenant = allowed(current, "chat:agents");
        let exchange = await store.getExchange(id, requestId);
        if (exchange && exchange.message !== message) throw new PartnerError(409, "idempotency_conflict", "request_id was already used for another message");
        if (!exchange) {
          const result = await deps.reply(tenant, { message, history: await store.readMessages(id), deadline });
          // The model's output is not the partner's input: fit it to what the
          // store keeps rather than answer the partner's message with a 400.
          const reply = fitPartnerReply(result.reply);
          const saved = await store.appendExchange(id, reply
            ? { requestId, message, reply, command: partnerCommandFits(result.command) ? result.command : undefined }
            : { requestId, message, reply: UNUSABLE_REPLY });
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
