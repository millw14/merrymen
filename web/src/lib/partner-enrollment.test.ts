import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getActionSelector } from "@zerodev/sdk";
import { buildWallPolicies, derivationOf, PONS_CLASS_VAULT_FACTORY, type MerrymenSettings, type StoredGrant } from "@merrymen/core";
import { partnerGrantDigest } from "../../../packages/core/src/partner-enrollment";
import { createPartnerEnrollmentService, PARTNER_ENROLLMENT_TTL_MS, type PartnerEnrollmentDependencies } from "./partner-enrollment";
import { FilePartnerStore, PartnerStoreError, type PartnerConnection } from "./partner-store";
import { PartnerError, type PartnerPrincipal } from "./partner-bridge";
import { checkCanonicalWall } from "./canonical-wall";

const SECRET = "test-partner-enrollment-secret-at-least-32-characters";
const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const principal: PartnerPrincipal = { app_id: "partner-a", key_id: "000000000001", name: "Example App", scopes: ["write:agents", "read:agents", "chat:agents"] };
const settings = { name: "Robin", strategy: "steady-basket" as const, basket_symbols: ["QQQ", "NVDA"], live_trading_enabled: false };
const fixtures: Array<{ store: FilePartnerStore; home: string }> = [];
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v)).toString("base64");
const decode = (g: StoredGrant) => JSON.parse(Buffer.from(g.serialized, "base64").toString("utf8"));
const errorCode = (code: string) => (error: unknown) => error instanceof PartnerError && error.code === code;

async function fixture(overrides: Partial<PartnerEnrollmentDependencies> = {}) {
  let now = 1_800_000_000_000;
  const home = mkdtempSync(join(tmpdir(), "merrymen-enrollment-"));
  // Short lock waits: a contention test should not sit out the production bound.
  const store = new FilePartnerStore(home, () => Math.floor(now / 1000), () => SECRET, { conversation: 100, enrollment: 100 });
  fixtures.push({ store, home });
  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  const sessionKey = generatePrivateKey();
  const seconds = Math.floor(now / 1000);
  const caps = { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 };
  const wall = buildWallPolicies({ caps, smartAccount: ACCOUNT, now: seconds });
  const grant: StoredGrant = {
    owner: owner.address, smartAccount: ACCOUNT, sessionKeyAddress: privateKeyToAccount(sessionKey).address,
    demoSessionPrivateKey: sessionKey, caps, grantedAt: seconds, expiresAt: wall.expiresAt, chainId: 4663,
    grantFeatures: ["tradeable-v2"],
    serialized: encode({
      privateKey: sessionKey, accountParams: { accountAddress: ACCOUNT, initCode: "0x1234" },
      permissionParams: { policies: wall.policies.map(policy => ({ policyParams: policy.policyParams })) },
      enableSignature: `0x${"12".repeat(65)}`, action: { selector: getActionSelector("0.7"), address: "0x0000000000000000000000000000000000000000" },
      validityData: { validAfter: 0, validUntil: 0 }, isPreInstalled: false,
    }),
  };
  const created = await store.create({ partnerId: principal.app_id, partnerName: principal.name, externalUserId: "external-user", name: "Robin", scopes: ["read:agents", "chat:agents"] });
  const savedGrants = new Map<string, StoredGrant>();
  const savedSettings = new Map<string, MerrymenSettings>();
  const events: string[] = [];
  const deps: PartnerEnrollmentDependencies = {
    store, now: () => now, secret: () => SECRET,
    recover: async args => (await import("viem")).recoverMessageAddress(args),
    derive: async () => derivationOf(ACCOUNT),
    classVault: async () => { throw new Error("this grant seals no class vault"); },
    grants: {
      get: async tenant => savedGrants.get(tenant) ?? null,
      tenantForAccount: async account => [...savedGrants].find(([, g]) => g.smartAccount.toLowerCase() === account.toLowerCase())?.[0] as `0x${string}` ?? null,
      put: async (tenant, g) => { events.push("grant"); savedGrants.set(tenant, g); },
    },
    settings: {
      get: async tenant => savedSettings.get(tenant) ?? null,
      put: async (tenant, s) => { events.push(s.liveTradingEnabled ? "settings-live" : "settings-paper"); savedSettings.set(tenant, s); },
    },
    identities: { ensure: async (tenant, account) => { events.push("identity"); return { tenant, slug: "0000000000000001", accounts: [account], createdAt: seconds, updatedAt: seconds }; } },
    ...overrides,
  };
  const service = createPartnerEnrollmentService(deps);
  const challengeFor = (g = grant, selected = settings, connection = created.connection, app = principal) => service.challenge(app, connection, {
    owner: g.owner, smart_account: g.smartAccount, chain_id: g.chainId, grant_hash: partnerGrantDigest(g), settings: selected,
  });
  const activationFor = async (g = grant, selected = settings, connection = created.connection) => {
    const challenge = await challengeFor(g, selected, connection);
    return { grant: g, challenge_token: challenge.challenge_token, signature: await owner.signMessage({ message: challenge.message }) };
  };
  return { store, service, deps, grant, owner, ownerKey, connection: created.connection, savedGrants, savedSettings, events, challengeFor, activationFor, advance: (ms: number) => { now += ms; } };
}
// Windows clears a WAL database's -shm mapping after close() returns, so a
// zero-retry rmSync rmdir's into ENOTEMPTY under a loaded full-suite run; see the
// cleanup note in partner-store.test.ts. Retry, and close everything even if one
// teardown throws, so a stuck directory cannot strand the rest of this file.
after(() => {
  const failures: unknown[] = [];
  const attempt = (fn: () => void) => { try { fn(); } catch (error) { failures.push(error); } };
  for (const { store } of fixtures) attempt(() => store.close());
  for (const { home } of fixtures) attempt(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  if (failures.length) throw failures[0];
});

test("a real owner signature persists the worker grant and scopes the durable connection", async () => {
  const f = await fixture();
  const result = await f.service.activate(principal, f.connection, await f.activationFor());
  const tenant = f.owner.address.toLowerCase();
  assert.equal(result.connection.tenant, tenant);
  assert.equal(result.connection.status, "linked");
  assert.equal(result.smartAccount, ACCOUNT);
  assert.equal(f.savedGrants.get(tenant)?.demoSessionPrivateKey, f.grant.demoSessionPrivateKey);
  assert.equal(f.savedGrants.get(tenant)?.binding, undefined);
  assert.equal(f.savedSettings.get(tenant)?.liveTradingEnabled, false);
  assert.deepEqual(f.events, ["settings-paper", "identity", "grant"]);
  assert.equal((await f.store.byTenant(principal.app_id, f.owner.address))?.id, f.connection.id);
});

test("live consent enables trading only after the signed grant was stored", async () => {
  const f = await fixture();
  await f.service.activate(principal, f.connection, await f.activationFor(f.grant, { ...settings, live_trading_enabled: true }));
  assert.deepEqual(f.events, ["settings-paper", "identity", "grant", "settings-live"]);
  assert.equal(f.savedSettings.get(f.owner.address.toLowerCase())?.liveTradingEnabled, true);
});

test("re-presenting a completed activation answers with the current connection and applies nothing again", async () => {
  const f = await fixture();
  const tenant = f.owner.address.toLowerCase();
  const activation = await f.activationFor(f.grant, { ...settings, live_trading_enabled: true });
  const first = await f.service.activate(principal, f.connection, activation);
  assert.equal(first.replayed, false);
  const applied = [...f.events];
  // The owner turns live trading off afterwards; a lost-response retry must not turn it back on.
  f.savedSettings.set(tenant, { ...f.savedSettings.get(tenant)!, liveTradingEnabled: false });
  const again = await f.service.activate(principal, f.connection, activation);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.connection, first.connection);
  assert.equal(again.smartAccount, ACCOUNT);
  assert.deepEqual(f.events, applied, "no grant, settings or identity write on a retry");
  assert.equal(f.savedSettings.get(tenant)?.liveTradingEnabled, false);
  // The same token with a changed grant, or a signature by anyone else, is still refused.
  await assert.rejects(f.service.activate(principal, f.connection, { ...activation, grant: { ...f.grant, caps: { ...f.grant.caps, dailyUsdg: 40 } } }), errorCode("grant_digest_mismatch"));
  const stranger = await privateKeyToAccount(generatePrivateKey()).signMessage({ message: (await f.challengeFor()).message });
  await assert.rejects(f.service.activate(principal, f.connection, { ...activation, signature: stranger }), errorCode("wrong_owner"));
  assert.deepEqual(f.events, applied);
});

test("only the latest completed activation is answered again; an earlier or unfinished one stays used", async () => {
  const f = await fixture();
  const original = await f.activationFor();
  const initial = await f.service.activate(principal, f.connection, original);
  const renewal = await f.activationFor(f.grant, settings, initial.connection);
  await f.service.activate(principal, initial.connection, renewal);
  await assert.rejects(f.service.activate(principal, initial.connection, original), errorCode("challenge_used"));
  assert.equal((await f.service.activate(principal, initial.connection, renewal)).replayed, true);
  // Bound and paper-installed, but live trading failed: not complete, so not answerable as a success.
  let failLive = true;
  const g = await fixture({ settings: { get: async () => null, put: async (_tenant, s) => { if (s.liveTradingEnabled && failLive) throw new Error("settings database unavailable"); } } });
  const live = await g.activationFor(g.grant, { ...settings, live_trading_enabled: true });
  await assert.rejects(g.service.activate(principal, g.connection, live), errorCode("enrollment_storage_failed"));
  failLive = false;
  await assert.rejects(g.service.activate(principal, g.connection, live), errorCode("challenge_used"));
});

test("an activation whose every effect committed is a success even when its retry proof cannot be recorded", async t => {
  const logged = t.mock.method(console, "error", () => {});
  const f = await fixture();
  const tenant = f.owner.address.toLowerCase();
  const recordActivation = f.store.recordActivation.bind(f.store);
  f.store.recordActivation = async () => { throw new Error("connection reset"); };
  const activation = await f.activationFor(f.grant, { ...settings, live_trading_enabled: true });
  const done = await f.service.activate(principal, f.connection, activation);
  assert.equal(done.replayed, false);
  assert.equal(done.connection.status, "linked");
  assert.equal(done.connection.tenant, tenant);
  assert.equal(done.connection.activation, undefined);
  assert.deepEqual(f.events, ["settings-paper", "identity", "grant", "settings-live"]);
  assert.equal(f.savedSettings.get(tenant)?.liveTradingEnabled, true, "live trading is on, and the answer says the activation succeeded");
  assert.equal(logged.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(logged.mock.calls[0].arguments), /connection reset/, "only the error's name is logged");
  // With no recorded proof a lost-response retry gets the old answer, and nothing is applied twice.
  f.store.recordActivation = recordActivation;
  await assert.rejects(f.service.activate(principal, f.connection, activation), errorCode("challenge_used"));
  assert.deepEqual(f.events, ["settings-paper", "identity", "grant", "settings-live"]);
  // A connection revoked meanwhile is still an answer, not a success.
  const g = await fixture();
  const record = g.store.recordActivation.bind(g.store);
  g.store.recordActivation = async (id, partnerId, owner, proof) => { await g.store.revoke(partnerId, id); return record(id, partnerId, owner, proof); };
  await assert.rejects(g.service.activate(principal, g.connection, await g.activationFor()), (e: unknown) => e instanceof PartnerStoreError && e.code === "connection_changed");
  assert.equal((await g.store.byId(principal.app_id, g.connection.id))?.status, "revoked");
});

test("contention for the owner's enrollment lock leaves the signature usable for a retry", async () => {
  const f = await fixture();
  const activation = await f.activationFor();
  let entered!: () => void, free!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const freed = new Promise<void>(resolve => { free = resolve; });
  // Another activation for the same owner, still in progress past the wait.
  const holder = f.store.withEnrollmentLock(f.owner.address, async () => { entered(); await freed; });
  await inside;
  try {
    await assert.rejects(f.service.activate(principal, f.connection, activation),
      (e: unknown) => e instanceof PartnerStoreError && e.status === 409 && e.code === "enrollment_busy" && e.retryAfter! > 0);
  } finally { free(); }
  await holder;
  assert.equal(f.events.length, 0);
  // The same owner signature still works: busy never spent its nonce.
  const result = await f.service.activate(principal, f.connection, activation);
  assert.equal(result.connection.status, "linked");
  assert.equal(f.events.filter(e => e === "grant").length, 1);
});

test("challenge tokens bind app, external user, agent, and exact scopes", async () => {
  const f = await fixture();
  const activation = await f.activationFor();
  const variants: Array<[PartnerPrincipal, PartnerConnection]> = [
    [{ ...principal, app_id: "another-app" }, { ...f.connection, partnerId: "another-app" }],
    [principal, { ...f.connection, externalUserId: "victim-user" }],
    [principal, { ...f.connection, id: "other-agent" }],
    [principal, { ...f.connection, scopes: ["read:agents"] }],
  ];
  for (const [app, c] of variants) await assert.rejects(f.service.activate(app, c, activation), errorCode("challenge_context_mismatch"));
  assert.equal(f.events.length, 0);
});

test("expired or modified HMAC challenges never reach persistence", async () => {
  const f = await fixture();
  const activation = await f.activationFor();
  const [encoded, mac] = activation.challenge_token.split(".");
  const claim = JSON.parse(Buffer.from(encoded, "base64url").toString());
  claim.settings.live_trading_enabled = true;
  await assert.rejects(f.service.activate(principal, f.connection, { ...activation, challenge_token: `${Buffer.from(JSON.stringify(claim)).toString("base64url")}.${mac}` }), errorCode("invalid_challenge"));
  f.advance(PARTNER_ENROLLMENT_TTL_MS);
  await assert.rejects(f.service.activate(principal, f.connection, activation), errorCode("challenge_expired"));
  assert.equal(f.events.length, 0);
});

test("a different wallet signature and a changed grant are both refused", async () => {
  const f = await fixture();
  const challenge = await f.challengeFor();
  const wrong = await privateKeyToAccount(generatePrivateKey()).signMessage({ message: challenge.message });
  await assert.rejects(f.service.activate(principal, f.connection, { grant: f.grant, challenge_token: challenge.challenge_token, signature: wrong }), errorCode("wrong_owner"));
  const activation = await f.activationFor();
  await assert.rejects(f.service.activate(principal, f.connection, { ...activation, grant: { ...f.grant, caps: { ...f.grant.caps, dailyUsdg: 100 } } }), errorCode("grant_digest_mismatch"));
  assert.equal(f.events.length, 0);
});

test("owner keys in outer payloads or in decoded permissions are rejected", async () => {
  const f = await fixture();
  const direct = { ...f.grant, demoOwnerPrivateKey: f.ownerKey };
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(direct)), errorCode("owner_key_forbidden"));
  const params = decode(f.grant);
  params.action.privateKey = f.ownerKey;
  const nested = { ...f.grant, serialized: encode(params) };
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(nested)), errorCode("owner_key_forbidden"));
  delete params.action.privateKey;
  params.action.hidden = f.ownerKey;
  const renamed = { ...f.grant, serialized: encode(params) };
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(renamed)), errorCode("owner_key_forbidden"));
  assert.equal(f.events.length, 0);
});

test("the session key must match its address and the serialized signer, and cannot be the owner", async () => {
  const f = await fixture();
  const wrongAddress = { ...f.grant, sessionKeyAddress: OTHER };
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(wrongAddress)), errorCode("invalid_grant"));
  const params = decode(f.grant);
  params.privateKey = generatePrivateKey();
  const wrongBlob = { ...f.grant, serialized: encode(params) };
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(wrongBlob)), errorCode("invalid_grant"));
  const ownerSession = { ...f.grant, sessionKeyAddress: f.owner.address, demoSessionPrivateKey: f.ownerKey };
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(ownerSession)), errorCode("owner_key_forbidden"));
  assert.equal(f.events.length, 0);
});

test("metadata cannot advertise a narrower wall than its actual serialized permission", async () => {
  const f = await fixture();
  const params = decode(f.grant);
  const call = params.permissionParams.policies.find((p: { policyParams: { type: string } }) => p.policyParams.type === "call");
  call.policyParams.permissions[0].target = OTHER;
  const broadened = { ...f.grant, serialized: encode(params) };
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(broadened)), errorCode("invalid_wall"));
  const understatedCap = { ...f.grant, caps: { ...f.grant.caps, perTradeUsdg: 1 } };
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(understatedCap)), errorCode("invalid_wall"));
  assert.equal(f.events.length, 0);
});

test("a partner cannot seal its own adapter, vault, route or token, even inside a matching wall", async () => {
  const f = await fixture();
  let spent = 0;
  const consume = f.store.consumeNonce.bind(f.store);
  f.store.consumeNonce = async (...args) => { spent++; return consume(...args); };
  const FOREIGN = "0x00000000000000000000000000000000badbad01" as const;
  // A permission that genuinely implements what the grant declares, so the
  // canonical wall alone accepts it; the worker would then trade through FOREIGN.
  const sealed = (extra: Partial<StoredGrant>, wallOptions: Parameters<typeof buildWallPolicies>[0] extends infer O ? Partial<O> : never) => {
    const wall = buildWallPolicies({ caps: f.grant.caps, smartAccount: ACCOUNT, now: f.grant.grantedAt, ...wallOptions });
    const params = decode(f.grant);
    params.permissionParams = { policies: wall.policies.map(policy => ({ policyParams: policy.policyParams })) };
    return { ...f.grant, ...extra, serialized: encode(params) } as StoredGrant;
  };
  const pons = sealed({ grantFeatures: ["tradeable-v2", "pons-adapter"], ponsAdapterAddress: FOREIGN }, { ponsAdapterAddress: FOREIGN });
  assert.deepEqual(checkCanonicalWall(pons as unknown as Record<string, unknown>), { ok: true }, "the wall check alone would accept this grant");
  const refused = [
    pons,
    sealed({ grantFeatures: ["tradeable-v2", "v4-adapter"], v4AdapterAddress: FOREIGN }, { v4AdapterAddress: FOREIGN }),
    { ...f.grant, grantFeatures: ["tradeable-v2", "v4"] },
    { ...f.grant, grantFeatures: ["tradeable-v2", "rialto"] },
    { ...f.grant, grantFeatures: "tradeable-v2" as unknown as string[] },
    { ...f.grant, grantTokens: [FOREIGN] },
  ];
  for (const grant of refused) {
    await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(grant)), errorCode("unsupported_permission"));
  }
  assert.equal(spent, 0, "refused before the single-use nonce");
  assert.equal(f.events.length, 0);
  // What prepareMerryman mints from owner, caps and chain alone still activates.
  const plain = await f.service.activate(principal, f.connection, await f.activationFor({ ...f.grant, grantTokens: [] }));
  assert.equal(plain.connection.status, "linked");
});

test("a class vault is accepted only from the platform factory, as the vault it answers for this account", async () => {
  const PLATFORM = (PONS_CLASS_VAULT_FACTORY[4663] ?? "").toLowerCase() as `0x${string}`;
  const VAULT = "0x00000000000000000000000000000000000c1a55" as const;
  const FOREIGN = "0x00000000000000000000000000000000badbad01" as const;
  let answer: () => Promise<`0x${string}`> = async () => VAULT;
  const reads: string[] = [];
  const f = await fixture({ classVault: async (factory, account) => { reads.push(`${factory}:${account}`); return answer(); } });
  let spent = 0;
  const consume = f.store.consumeNonce.bind(f.store);
  f.store.consumeNonce = async (...args) => { spent++; return consume(...args); };
  const classGrant = (vault: `0x${string}`, factory: `0x${string}`) => {
    const wall = buildWallPolicies({ caps: f.grant.caps, smartAccount: ACCOUNT, now: f.grant.grantedAt, ponsClassVaultAddress: vault, ponsClassVaultFactoryAddress: factory });
    const params = decode(f.grant);
    params.permissionParams = { policies: wall.policies.map(policy => ({ policyParams: policy.policyParams })) };
    return { ...f.grant, grantFeatures: ["tradeable-v2", "pons-class"], ponsClassVaultAddress: vault, ponsClassVaultFactoryAddress: factory, serialized: encode(params) } as StoredGrant;
  };
  // Another factory: refused without a chain read.
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(classGrant(VAULT, FOREIGN))), errorCode("unsupported_permission"));
  assert.equal(reads.length, 0);
  // The platform factory beside a vault it does not answer for this account.
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(classGrant(FOREIGN, PLATFORM))), errorCode("unsupported_permission"));
  // An unreadable chain is retryable: the same signed authorization works once it answers.
  answer = async () => { throw new Error("rpc down"); };
  const retry = await f.activationFor(classGrant(VAULT, PLATFORM));
  await assert.rejects(f.service.activate(principal, f.connection, retry), errorCode("class_vault_unavailable"));
  assert.equal(spent, 0, "no refusal above spent the single-use nonce");
  assert.equal(f.events.length, 0);
  answer = async () => VAULT;
  const linked = await f.service.activate(principal, f.connection, retry);
  assert.equal(linked.connection.status, "linked");
  assert.equal([...f.savedGrants.values()][0]?.ponsClassVaultAddress, VAULT);
});

test("invalid caps and a mismatch between serialized expiry and metadata cannot arm a worker", async () => {
  const f = await fixture();
  for (const caps of [{ ...f.grant.caps, dailyUsdg: 0 }, { ...f.grant.caps, perTradeUsdg: 100 }, { ...f.grant.caps, maxDrawdownPct: 101 }]) {
    const invalid = { ...f.grant, caps };
    await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(invalid)), errorCode("invalid_grant"));
  }
  const params = decode(f.grant);
  const timestamp = params.permissionParams.policies.find((p: { policyParams: { type: string } }) => p.policyParams.type === "timestamp");
  timestamp.policyParams.validUntil += 3600;
  const invalidExpiry = { ...f.grant, serialized: encode(params) };
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(invalidExpiry)), errorCode("invalid_grant"));
  assert.equal(f.events.length, 0);
});

test("alternate executor actions and preinstalled permission claims cannot bypass SDK enrollment", async () => {
  const f = await fixture();
  for (const change of [(p: ReturnType<typeof decode>) => { p.action.address = OTHER; }, (p: ReturnType<typeof decode>) => { p.isPreInstalled = true; }, (p: ReturnType<typeof decode>) => { p.validityData.validUntil = 1; }]) {
    const params = decode(f.grant);
    change(params);
    const changed = { ...f.grant, serialized: encode(params) };
    await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor(changed)), errorCode("invalid_grant"));
  }
  assert.equal(f.events.length, 0);
});

test("safe settings reject privileged fields, unsupported strategies, invalid baskets, and unsupported chains", async () => {
  const f = await fixture();
  for (const selected of [
    { ...settings, bundlerUrl: "https://untrusted.example" },
    { ...settings, strategy: "dip-hunter" },
    { ...settings, basket_symbols: ["UNKNOWN"] },
    { ...settings, live_trading_enabled: "true" },
  ]) await assert.rejects(f.challengeFor(f.grant, selected as typeof settings));
  await assert.rejects(f.challengeFor({ ...f.grant, chainId: 1 }), errorCode("unsupported_chain"));
  await assert.rejects(f.challengeFor(f.grant, settings, f.connection, { ...principal, scopes: ["read:agents"] }), errorCode("forbidden_scope"));
  assert.equal(f.events.length, 0);
});

test("failed account derivation and mismatching account ownership refuse before writing", async () => {
  const f = await fixture({ derive: async () => derivationOf(OTHER) });
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor()), errorCode("account_mismatch"));
  assert.equal(f.events.length, 0);
  const unreachable = await fixture({ derive: async () => ({ ok: false, failure: "unreachable", why: "chain unavailable" }) });
  await assert.rejects(unreachable.service.activate(principal, unreachable.connection, await unreachable.activationFor()), errorCode("derivation_unavailable"));
  assert.equal(unreachable.events.length, 0);
});

test("an account or external identity collision cannot alter existing worker settings or grants", async () => {
  const f = await fixture();
  f.savedGrants.set(OTHER, f.grant);
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor()), errorCode("account_already_claimed"));
  assert.equal(f.events.length, 0);
  f.savedGrants.clear();
  const other = await f.store.create({ partnerId: principal.app_id, partnerName: principal.name, externalUserId: "another-user", name: "Other", scopes: ["read:agents", "chat:agents"] });
  await f.store.bindAuthorized(other.connection.id, principal.app_id, f.owner.address, other.connection.scopes);
  await assert.rejects(f.service.activate(principal, f.connection, await f.activationFor()), errorCode("wallet_already_linked"));
  assert.equal(f.events.length, 0);
});

test("revocation after challenge and same owner renewal are resolved against fresh stored state", async () => {
  const f = await fixture();
  const initial = await f.service.activate(principal, f.connection, await f.activationFor());
  const renewal = await f.activationFor(f.grant, settings, initial.connection);
  const renewed = await f.service.activate(principal, initial.connection, renewal);
  assert.equal(renewed.connection.id, initial.connection.id);
  const revokedActivation = await f.activationFor(f.grant, settings, initial.connection);
  await f.store.revoke(principal.app_id, initial.connection.id);
  await assert.rejects(f.service.activate(principal, initial.connection, revokedActivation), errorCode("connection_revoked"));
  assert.equal(f.events.filter(e => e === "grant").length, 2);
});

test("a storage failure never enables live trading and does not reopen its signed nonce", async () => {
  const f = await fixture({ identities: { ensure: async () => { throw new Error("private internal database failure"); } } });
  const activation = await f.activationFor(f.grant, { ...settings, live_trading_enabled: true });
  await assert.rejects(f.service.activate(principal, f.connection, activation), errorCode("enrollment_storage_failed"));
  assert.deepEqual(f.events, ["settings-paper"]);
  assert.equal(f.savedGrants.size, 0);
  await assert.rejects(f.service.activate(principal, f.connection, activation), errorCode("challenge_used"));
});

test("a partner is told a name the soul would refuse, instead of the agent silently running as Robin", async () => {
  // The web and the soul both require a letter in an agent's name. Enrollment
  // accepted any 1-24 characters, so "007" got a 200 here and the worker then
  // refused it and kept the default: the partner was told one name while the
  // agent answered to another.
  const f = await fixture();
  for (const name of ["007", "99.5", `Robin${String.fromCharCode(0x202e)}evil`, "-Robin"]) {
    await assert.rejects(f.challengeFor(f.grant, { ...settings, name }), errorCode("invalid_settings"), `"${name}" must be refused`);
  }
  // A name the rule admits is stored the way the settings route stores it.
  const challenge = await f.challengeFor(f.grant, { ...settings, name: "  Little   John  " });
  assert.ok(challenge.challenge_token);
  await f.service.activate(principal, f.connection, {
    grant: f.grant,
    challenge_token: challenge.challenge_token,
    signature: await f.owner.signMessage({ message: challenge.message }),
  });
  assert.equal([...f.savedSettings.values()][0]?.agentName, "Little John");
});
