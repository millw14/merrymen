/**
 * THE PARTNER API END TO END, ACROSS EVERY SEAM A PARTNER'S REQUEST CROSSES.
 *
 *   partner backend --fetch, Bearer mmp_--> gateway/server.mjs (a real child process)
 *     --HMAC bridge, Node fetch--> web middleware (the real one)
 *     --> createPartnerService / createPartnerEnrollmentService (the real ones)
 *
 * Every piece above already had its own tests, and the API was still down in
 * production for a week: every partner POST and DELETE answered 503, because
 * web/src/middleware.ts's cross-site block refused the gateway's Node fetch
 * (it sends Sec-Fetch-Mode: cors with no Origin, which reads as an opaque
 * browser request). The unit tests signed requests in-process and called the
 * service directly, so no test ever sent one through the middleware the way the
 * gateway does. This file does, with the gateway process, its bridge signer and
 * its transport all real, so a seam that refuses the other side fails here.
 *
 * What is NOT real: the worker's stores, account derivation and the model are
 * injected (as partner-enrollment.test.ts and partner-service.test.ts inject
 * them), and the "web" server is a node:http server that hands each request to
 * the real middleware and then to the service, where Next would route it to
 * web/src/app/api/partner/[...path]/route.ts. Nothing leaves 127.0.0.1.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getActionSelector } from "@zerodev/sdk";
import { buildWallPolicies, derivationOf, type MerrymenSettings, type StoredGrant } from "@merrymen/core";
import { partnerGrantDigest, signMerrymanAuthorization } from "../../../sdk/browser";
import { hashSecret, makeKey } from "../../../gateway/lib/partners.mjs";
import { checkCanonicalWall } from "./canonical-wall";
import { createPartnerEnrollmentService } from "./partner-enrollment";
import type { PartnerRuntime } from "./partner-runtime";
import { createPartnerService, partnerFailure } from "./partner-service";
import { FilePartnerStore, PARTNER_LOCK_WAIT_MS } from "./partner-store";

const GATEWAY_SECRET = "e2e-gateway-holder-signing-secret-32-bytes-or-more";
const BRIDGE_SECRET = "e2e-partner-bridge-secret-shared-by-gateway-and-web";
const APP_ID = "e2e_partner_app";
const APP_NAME = "E2E Partner";
const PARTNER = makeKey();
const SCOPES = ["read:agents", "chat:agents"];
const CAPS = { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 };
const SETTINGS = { name: "Robin", strategy: "steady-basket" as const, basket_symbols: ["QQQ", "NVDA"], live_trading_enabled: false };
const REQUEST_ID = /^req_[0-9a-f]{12}$/;

// ── the injected worker side: what activation wrote, and what chat cost ─────
const accounts = new Map<string, Address>();
const savedGrants = new Map<string, StoredGrant>();
const savedSettings = new Map<string, MerrymenSettings>();
const runtimeReads: string[] = [];
const replies: Array<{ tenant: string; message: string }> = [];
const runtimeOf = (tenant: string): PartnerRuntime => ({
  exists: true, smart_account: accounts.get(tenant) ?? null, name: "Robin", slug: "robin", status: "starting",
  mode: null, last_observed_mode: null, worker_alive_at: null, heartbeat_fresh: false, live_blocker: null,
  last_observed_live_blocker: null, strategy: "steady-basket", live_trading_enabled: false, paper_trading_enabled: true, ledger_available: false,
});

// ── the "web" side: the real middleware in front of the real partner service ──
const cleanup: string[] = [];
let store: FilePartnerStore;
let middleware: typeof import("../middleware").middleware;
let service: ReturnType<typeof createPartnerService>;
let web: Server;
let webOrigin = "";
/** What reached the middleware from the gateway, and what it refused. */
const arrivals: Array<{ method: string; path: string; headers: Headers }> = [];
const refusals: string[] = [];
const harnessFailures: unknown[] = [];

/** Each Node request as Next would hand it over: method, headers as received, raw body. */
async function serveWeb(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  const url = `http://${req.headers.host}${req.url}`;
  const request = () => {
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    return new NextRequest(url, { method: req.method, headers, ...(raw.length ? { body: new Uint8Array(raw) } : {}) });
  };
  const incoming = request();
  const pathname = incoming.nextUrl.pathname;
  arrivals.push({ method: incoming.method, path: pathname, headers: incoming.headers });
  const verdict = middleware(incoming);
  let response: Response;
  if (verdict.headers.get("x-middleware-next") !== "1") {
    // The middleware answered itself, as it did for every partner POST in the outage.
    refusals.push(`${incoming.method} ${pathname} -> ${verdict.status} ${await verdict.clone().text()}`);
    response = verdict;
  } else if (verdict.headers.has("x-middleware-override-headers") || verdict.headers.has("x-middleware-rewrite")) {
    // Next would rewrite the request before the route saw it; this harness does not, so say so.
    throw new Error(`the middleware now rewrites ${incoming.method} ${pathname}: apply that here as Next does`);
  } else if (pathname.startsWith("/api/partner/")) {
    // What route.ts does for /api/partner/[...path], with this test's store and worker side.
    try { response = await service.handle(request(), pathname.slice("/api/partner".length)); }
    catch (error) { response = partnerFailure(error); }
  } else {
    response = new Response("not found", { status: 404 });
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

// ── the gateway: server.mjs as deployed, with one partner key ─────────────────
let gateway: ChildProcess;
let gatewayOrigin = "";
let gatewayLog = "";

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

// after() does not run when this file's process is killed (a watch-mode
// restart, a SIGTERM from another tool), and the gateway, a separate process,
// would keep listening with its temp dir on disk. Synchronous, so it can also
// run from the exit handler; a no-op once after() has cleaned up.
function reap() {
  if (gateway && gateway.exitCode === null && gateway.signalCode === null) gateway.kill("SIGKILL");
  for (const dir of cleanup) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort on the way out */ } }
}
const REAPED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
function reapOnSignal(signal: NodeJS.Signals) {
  reap();
  // Then die of the signal as this process would have, unless something else
  // (a test runner running files in-process) is there to handle it.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

before(async () => {
  process.once("exit", reap);
  for (const signal of REAPED_SIGNALS) process.once(signal, reapOnSignal);
  web = createServer((req, res) => {
    serveWeb(req, res).catch(error => {
      harnessFailures.push(error);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("test harness failure");
    });
  });
  await new Promise<void>(resolve => web.listen(0, "127.0.0.1", resolve));
  webOrigin = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;

  // Production's configuration (the partner route answers only in hosted mode),
  // set before the import because the middleware reads it once, at load.
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_PUBLIC_ORIGIN = webOrigin;
  process.env.MERRYMEN_PARTNER_BRIDGE_SECRET = BRIDGE_SECRET;
  delete process.env.MERRYMEN_OAUTH_ISSUER;
  delete process.env.MERRYMEN_MCP_RESOURCE_URL;
  ({ middleware } = await import("../middleware"));

  const home = mkdtempSync(join(tmpdir(), "merrymen-partner-e2e-web-"));
  cleanup.push(home);
  // Defaults everywhere route.ts relies on them: the clock, and the bridge
  // secret read from the environment by the store, service and enrollment.
  // Only the chat lock's wait is shortened, so a busy answer takes 300ms, not 20s.
  store = new FilePartnerStore(home, undefined, undefined, { ...PARTNER_LOCK_WAIT_MS, conversation: 300 });
  const enrollment = createPartnerEnrollmentService({
    store,
    derive: async owner => derivationOf(accounts.get(owner.toLowerCase())),
    classVault: async () => { throw new Error("no grant in this file seals a class vault"); },
    grants: {
      get: async tenant => savedGrants.get(tenant) ?? null,
      tenantForAccount: async account => [...savedGrants].find(([, g]) => g.smartAccount.toLowerCase() === account.toLowerCase())?.[0] as `0x${string}` ?? null,
      put: async (tenant, grant) => { savedGrants.set(tenant, grant); },
    },
    settings: {
      get: async tenant => savedSettings.get(tenant) ?? null,
      put: async (tenant, settings) => { savedSettings.set(tenant, settings); },
    },
    identities: { ensure: async (tenant, account) => ({ tenant, slug: "0000000000000001", accounts: [account], createdAt: 1, updatedAt: 1 }) },
    // recover, now and secret are the production defaults.
  });
  service = createPartnerService({
    store, enrollment,
    readRuntime: async tenant => { runtimeReads.push(tenant); return runtimeOf(tenant); },
    reply: async (tenant, { message }) => {
      replies.push({ tenant, message });
      return { reply: `Robin here. You said: ${message}`, generation: "model", runtime: runtimeOf(tenant) };
    },
  });

  const dataDir = mkdtempSync(join(tmpdir(), "merrymen-partner-e2e-gateway-"));
  cleanup.push(dataDir);
  const port = await freePort();
  gatewayOrigin = `http://127.0.0.1:${port}`;
  gateway = spawn(process.execPath, [fileURLToPath(new URL("../../../gateway/server.mjs", import.meta.url))], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      // Only what the deployment sets: nothing from this process leaks in (no KV, no keys).
      PATH: process.env.PATH,
      NODE_ENV: "test", // unread by the gateway; Next's ProcessEnv type requires it
      PORT: String(port),
      MERRYMEN_DATA_DIR: dataDir,
      MERRYMEN_PARTNER_KEYS: JSON.stringify([{ keyId: PARTNER.keyId, appId: APP_ID, name: APP_NAME,
        hash: hashSecret(GATEWAY_SECRET, PARTNER.secret), scopes: ["read:agents", "write:agents", "chat:agents"], status: "active" }]),
      MERRYMEN_PARTNER_BRIDGE_SECRET: BRIDGE_SECRET,
      MERRYMEN_PARTNER_APP_ORIGIN: webOrigin,
      MERRYMEN_GATEWAY_UPSTREAM_KEY: "unused-by-partner-routes",
      MERRYMEN_GATEWAY_SECRET: GATEWAY_SECRET,
      // Partner routes never read the chain; nothing listens here.
      MERRYMEN_GATEWAY_RPC: "http://127.0.0.1:9",
    },
  });
  gateway.stderr!.on("data", chunk => { gatewayLog += chunk; });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`gateway did not start: ${out}${gatewayLog}`)), 10_000);
    gateway.stdout!.on("data", chunk => { out += chunk; if (out.includes("listening")) { clearTimeout(timer); resolve(); } });
    gateway.once("exit", code => { clearTimeout(timer); reject(new Error(`gateway exited ${code}: ${out}${gatewayLog}`)); });
  });
});

after(async () => {
  const failures: unknown[] = [];
  const attempt = async (fn: () => unknown) => { try { await fn(); } catch (error) { failures.push(error); } };
  await attempt(() => {
    if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) return;
    const exited = new Promise(resolve => gateway.once("exit", resolve));
    gateway.kill();
    return exited;
  });
  await attempt(() => web && new Promise<void>(resolve => { web.closeAllConnections(); web.close(() => resolve()); }));
  await attempt(() => store?.close());
  // See partner-store.test.ts: SQLite can still be clearing its -shm file after close().
  for (const dir of cleanup) await attempt(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  // The exit reaper stays: if anything above failed, it tries once more.
  for (const signal of REAPED_SIGNALS) process.off(signal, reapOnSignal);
  if (failures.length) throw failures[0];
});

// ── a partner backend ─────────────────────────────────────────────────────────
interface Answer { status: number; body: any; headers: Headers; label: string }

/** One call exactly as a partner's server makes it. Every refusal must carry a request_id. */
async function partner(method: string, route: string, body?: unknown, key = PARTNER.key): Promise<Answer> {
  const label = `${method} /partner/v1${route}`;
  const response = await fetch(`${gatewayOrigin}/partner/v1${route}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: any;
  try { json = JSON.parse(text); } catch { assert.fail(`${label}: the gateway answered ${response.status} without JSON: ${text}`); }
  if (response.status >= 400) {
    assert.equal(typeof json?.error?.code, "string", `${label}: a refusal without an error code: ${text}`);
    assert.match(String(json.error.request_id), REQUEST_ID, `${label}: a refusal without a request_id: ${text}`);
  }
  return { status: response.status, body: json, headers: response.headers, label };
}

/** The status, or a failure that says where the request stopped. */
function expectStatus(answer: Answer, status: number) {
  assert.equal(answer.status, status, [
    `${answer.label} answered ${answer.status}: ${JSON.stringify(answer.body)}`,
    refusals.length ? `the web middleware refused: ${refusals.join("; ")}` : "the web middleware refused nothing",
    harnessFailures.length ? `the test's web server failed: ${harnessFailures.map(String).join("; ")}` : "",
    `gateway log: ${gatewayLog.trim().split("\n").slice(-5).join(" | ")}`,
  ].filter(Boolean).join("\n"));
  return answer.body;
}

// ── grants, built the way partner-enrollment.test.ts builds its fixture ───────
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v)).toString("base64");
type WallOptions = Partial<Parameters<typeof buildWallPolicies>[0]>;

/** A real session key and a serialized permission that installs exactly this grant's wall. */
function grantFor(owner: PrivateKeyAccount, account: Address, extra: Partial<StoredGrant> = {}, wallOptions: WallOptions = {}): StoredGrant {
  accounts.set(owner.address.toLowerCase(), account);
  const sessionKey = generatePrivateKey();
  const seconds = Math.floor(Date.now() / 1000);
  const wall = buildWallPolicies({ caps: CAPS, smartAccount: account, now: seconds, ...wallOptions });
  return {
    owner: owner.address, smartAccount: account, sessionKeyAddress: privateKeyToAccount(sessionKey).address,
    demoSessionPrivateKey: sessionKey, caps: CAPS, grantedAt: seconds, expiresAt: wall.expiresAt, chainId: 4663,
    grantFeatures: ["tradeable-v2"],
    serialized: encode({
      privateKey: sessionKey, accountParams: { accountAddress: account, initCode: "0x1234" },
      permissionParams: { policies: wall.policies.map(policy => ({ policyParams: policy.policyParams })) },
      enableSignature: `0x${"12".repeat(65)}`, action: { selector: getActionSelector("0.7"), address: "0x0000000000000000000000000000000000000000" },
      validityData: { validAfter: 0, validUntil: 0 }, isPreInstalled: false,
    }),
    ...extra,
  } as StoredGrant;
}

/** Challenge through the partner's backend, then the owner signs in the browser with the SDK. */
async function authorize(id: string, externalUserId: string, owner: PrivateKeyAccount, grant: StoredGrant) {
  const challenge = expectStatus(await partner("POST", `/agents/${id}/challenge`, {
    owner: owner.address, smart_account: grant.smartAccount, chain_id: grant.chainId, grant_hash: partnerGrantDigest(grant), settings: SETTINGS,
  }), 200);
  // Pinned to what the partner itself knows, never to identifiers the challenge reports.
  return signMerrymanAuthorization({
    owner, grant, challenge, settings: SETTINGS,
    expectedAppId: APP_ID, expectedAgentId: id, expectedExternalUserId: externalUserId, expectedScopes: SCOPES,
  });
}

test("a partner key is recognised, and a wrong one refused with a request_id", async () => {
  const meta = expectStatus(await partner("GET", "/meta"), 200);
  assert.equal(meta.app_id, APP_ID);
  assert.equal(meta.key_id, PARTNER.keyId);
  assert.deepEqual(meta.scopes, ["read:agents", "write:agents", "chat:agents"]);
  const forged = await partner("GET", "/meta", undefined, `mmp_${PARTNER.keyId}_${"A".repeat(43)}`);
  expectStatus(forged, 401);
  assert.equal(forged.body.error.code, "unauthorized");
});

test("the embedded flow, end to end: create, authorize with the SDK, activate, chat, disconnect, reconnect", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const tenant = owner.address.toLowerCase();
  const account = "0x1111111111111111111111111111111111111111" as const;
  const user = "user-e2e-0001";

  // 1. Create. A POST: the first kind of request the outage refused.
  const created = expectStatus(await partner("POST", "/agents", { external_user_id: user, name: "Robin" }), 202);
  assert.equal(created.status, "pending_authorization");
  assert.equal(created.external_user_id, user);
  assert.ok(created.onboarding_url.startsWith(`${webOrigin}/connect#token=`), created.onboarding_url);
  const id: string = created.id;
  // The requests that reached the web app carried the gateway's signature and
  // the shape the outage refused: Fetch Metadata with no Origin to check.
  const post = arrivals.find(a => a.method === "POST" && a.path === "/api/partner/agents");
  assert.ok(post, "the gateway's POST reached the web app");
  assert.match(post.headers.get("x-merrymen-partner-signature") ?? "", /^[a-f0-9]{64}$/);
  assert.equal(post.headers.get("sec-fetch-mode"), "cors");
  assert.equal(post.headers.get("origin"), null);
  // Repeating the create is answered with the same pending connection.
  assert.equal(expectStatus(await partner("POST", "/agents", { external_user_id: user, name: "Robin" }), 202).id, id);
  // A pending agent cannot chat yet.
  assert.equal(expectStatus(await partner("POST", `/agents/${id}/messages`, { message: "hi", request_id: "early-request" }), 409).error.code, "authorization_required");

  // 2. Challenge, owner signature (the real SDK), activation.
  const grant = grantFor(owner, account);
  const authorization = await authorize(id, user, owner, grant);
  const activated = expectStatus(await partner("POST", `/agents/${id}/activate`, authorization), 200);
  assert.equal(activated.id, id);
  assert.equal(activated.status, "starting", "linked, and reported with the worker's own status");
  assert.deepEqual(activated.wallet, { smart_account: account, chain_id: 4663 });
  assert.equal(activated.agent.id, "robin");
  assert.equal(savedGrants.get(tenant)?.demoSessionPrivateKey, grant.demoSessionPrivateKey, "the owner-signed grant reached the worker's store");
  assert.equal(savedGrants.get(tenant)?.serialized, grant.serialized);
  assert.equal(savedSettings.get(tenant)?.liveTradingEnabled, false);
  assert.deepEqual(runtimeReads, [tenant], "the status read is for the owner who signed");
  // A lost-response retry of the same signed activation is answered, and applies nothing again.
  const installed = savedGrants.get(tenant);
  const replayed = expectStatus(await partner("POST", `/agents/${id}/activate`, authorization), 200);
  assert.equal(replayed.id, id);
  assert.deepEqual(replayed.wallet, activated.wallet);
  assert.equal(savedGrants.get(tenant), installed, "the grant was not installed twice");

  // 3. Read it back, singly and in the list. No owner address leaves the web app.
  const detail = expectStatus(await partner("GET", `/agents/${id}`), 200);
  assert.equal(detail.status, "starting");
  assert.equal(detail.agent.heartbeat_fresh, false);
  assert.ok(!JSON.stringify(detail).toLowerCase().includes(tenant.slice(2)), "the owner's address is not exposed");
  const listed = expectStatus(await partner("GET", "/agents"), 200);
  assert.deepEqual(listed.data.filter((c: { external_user_id: string }) => c.external_user_id === user).map((c: { id: string; status: string }) => [c.id, c.status]), [[id, "connected"]]);

  // 4. Chat, idempotent by request_id.
  const message = { message: "How is my agent doing?", request_id: "e2e-request-0001" };
  const reply = expectStatus(await partner("POST", `/agents/${id}/messages`, message), 200);
  assert.equal(reply.agent_id, id);
  assert.equal(reply.request_id, message.request_id);
  assert.equal(reply.reply, `Robin here. You said: ${message.message}`);
  assert.deepEqual(replies, [{ tenant, message: message.message }], "one generation, for the consenting owner");
  const again = expectStatus(await partner("POST", `/agents/${id}/messages`, message), 200);
  assert.deepEqual(again, reply, "a retry gets the saved reply");
  assert.equal(replies.length, 1, "and no second model call");
  const conflict = await partner("POST", `/agents/${id}/messages`, { ...message, message: "Something else entirely" });
  expectStatus(conflict, 409);
  assert.equal(conflict.body.error.code, "idempotency_conflict");
  assert.equal(replies.length, 1);
  const history = expectStatus(await partner("GET", `/agents/${id}/messages`), 200);
  assert.deepEqual(history.messages.map((m: { role: string; content: string }) => [m.role, m.content]),
    [["user", message.message], ["assistant", reply.reply]]);
  // Still busy past the wait: the partner is told when to come back, in the
  // body and in the Retry-After header the gateway relays, and resends unchanged.
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const holder = store.withConversationLock(id, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  await inside;
  const next = { message: "And now?", request_id: "e2e-request-0002" };
  let busy: Answer;
  try { busy = await partner("POST", `/agents/${id}/messages`, next); } finally { release(); }
  await holder;
  expectStatus(busy, 409);
  assert.equal(busy.body.error.code, "conversation_busy");
  assert.equal(busy.body.error.retry_after, 2);
  assert.equal(busy.headers.get("retry-after"), "2", "the gateway relays the runtime's Retry-After");
  assert.equal(replies.length, 1, "nothing was generated while busy");
  assert.equal(expectStatus(await partner("POST", `/agents/${id}/messages`, next), 200).reply, `Robin here. You said: ${next.message}`);

  // 5. Disconnect: a DELETE, the other kind of request the outage refused.
  assert.deepEqual(expectStatus(await partner("DELETE", `/agents/${id}/connection`), 200), { id, status: "disconnected" });
  assert.equal(expectStatus(await partner("GET", `/agents/${id}/messages`), 409).error.code, "authorization_required");

  // 6. The same user again: a fresh authorization under a new id; the old id stays disconnected.
  const renewed = expectStatus(await partner("POST", "/agents", { external_user_id: user, name: "Robin" }), 202);
  assert.notEqual(renewed.id, id);
  assert.equal(renewed.status, "pending_authorization");
  assert.ok(renewed.onboarding_url.startsWith(`${webOrigin}/connect#token=`));
  assert.equal(expectStatus(await partner("GET", `/agents/${id}`), 200).status, "disconnected");
  const relisted = expectStatus(await partner("GET", "/agents"), 200);
  assert.deepEqual(relisted.data.filter((c: { external_user_id: string }) => c.external_user_id === user).map((c: { id: string }) => c.id), [renewed.id]);
  assert.equal(expectStatus(await partner("GET", "/agents/pa_doesnotexist0"), 404).error.code, "not_found");

  assert.deepEqual(refusals, [], "the web middleware let every gateway request through");
  assert.deepEqual(harnessFailures, []);
});

test("a grant sealing the partner's own adapter is refused through the gateway, and links nothing", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const account = "0x3333333333333333333333333333333333333333" as const;
  const FOREIGN = "0x00000000000000000000000000000000badbad01" as const;
  const user = "user-e2e-hostile";
  const created = expectStatus(await partner("POST", "/agents", { external_user_id: user }), 202);

  // A permission that genuinely installs what the grant declares, so the
  // canonical wall alone would accept it; the worker would trade through FOREIGN.
  const hostile = grantFor(owner, account, { grantFeatures: ["tradeable-v2", "pons-adapter"], ponsAdapterAddress: FOREIGN }, { ponsAdapterAddress: FOREIGN });
  assert.deepEqual(checkCanonicalWall(hostile as unknown as Record<string, unknown>), { ok: true }, "precondition: the wall matches the grant");
  const authorization = await authorize(created.id, user, owner, hostile);
  const refused = await partner("POST", `/agents/${created.id}/activate`, authorization);
  expectStatus(refused, 422);
  assert.equal(refused.body.error.code, "unsupported_permission");
  // Refused before the single-use nonce: the same authorization is refused for the same reason, not as used.
  assert.equal(expectStatus(await partner("POST", `/agents/${created.id}/activate`, authorization), 422).error.code, "unsupported_permission");

  assert.equal(savedGrants.has(owner.address.toLowerCase()), false, "nothing was installed");
  assert.equal(expectStatus(await partner("GET", `/agents/${created.id}`), 200).status, "pending_authorization");
  assert.deepEqual(refusals, []);
  assert.deepEqual(harnessFailures, []);
});
