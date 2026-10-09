import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatePrivateKey, privateKeyToAccount, toAccount } from "viem/accounts";
import { verifyMessage, type Hex } from "viem";
import { derivationOf, type MerrymenSettings } from "@merrymen/core";
// FIRST, before ./browser: the fixture trusts its stub Trencher bytecode by
// setting the env var trencher-permission.ts reads once, when session.ts loads.
import { CLASS_FACTORY, CLASS_VAULT, TRENCHER_FACTORY, withStubChain, type KernelState } from "../web/src/lib/canonical-wall-fixture";
import {
  prepareMerryman, signMerrymanAuthorization, partnerGrantDigest, PARTNER_API_VERSION, SDK_VERSION,
  type LocalAccount, type PrepareMerrymanOptions, type StoredGrant, type PartnerEnrollmentClaim,
} from "./browser";
import { partnerEnrollmentMessage } from "../packages/core/src/partner-enrollment";
import { carriesOwnerKey } from "../packages/core/src/hosted";
import { prepareAgentGrant } from "../web/src/lib/session";
import { checkCanonicalWall } from "../web/src/lib/canonical-wall";
import { MAX_USDG_UI } from "../packages/core/src/wall";
import { createPartnerEnrollmentService } from "../web/src/lib/partner-enrollment";
import { FilePartnerStore } from "../web/src/lib/partner-store";
import { PartnerError } from "../web/src/lib/partner-bridge";

const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const grant: StoredGrant = {
  owner: owner.address,
  smartAccount: `0x${"22".repeat(20)}`,
  sessionKeyAddress: `0x${"33".repeat(20)}`,
  demoSessionPrivateKey: `0x${"44".repeat(32)}`,
  serialized: "signed-session-permission",
  caps: { perTradeUsdg: 20, dailyUsdg: 100, expiryDays: 7, maxDrawdownPct: 20, maxOpsPerDay: 20 } as StoredGrant["caps"],
  chainId: 4663,
  grantedAt: Date.now() / 1000,
  expiresAt: Date.now() / 1000 + 86400,
};
const settings = { name: "Little John", strategy: "steady-basket" as const, basket_symbols: ["NVDA"], live_trading_enabled: false };
function fixture() {
  const claim: PartnerEnrollmentClaim = {
    v: 1, app_id: "prism", app_name: "Prism", agent_id: "mpa_example", external_user_id: "user_123",
    owner: owner.address, smart_account: grant.smartAccount, chain_id: grant.chainId,
    grant_hash: partnerGrantDigest(grant), settings, scopes: ["read:agents", "chat:agents"],
    nonce: "one-use-nonce", expires_at: Date.now() + 300_000,
  };
  return {
    owner, grant, settings, expectedAppId: "prism", expectedAgentId: "mpa_example", expectedExternalUserId: "user_123",
    expectedScopes: ["read:agents", "chat:agents"],
    challenge: { claim, message: partnerEnrollmentMessage(claim), challenge_token: "signed-challenge-token" },
  };
}

describe("browser partner authorization", () => {
  it("signs the canonical challenge with the existing owner wallet", async () => {
    const input = fixture();
    const signed = await signMerrymanAuthorization(input);
    assert.equal(await verifyMessage({ address: owner.address, message: input.challenge.message, signature: signed.signature }), true);
    assert.equal(signed.grant, grant);
    assert.equal(signed.challenge_token, "signed-challenge-token");
    assert.equal(signed.grant.demoOwnerPrivateKey, undefined);
  });

  it("refuses swapped app, agent, wallet, account, chain, grant and settings before signing", async () => {
    const edits: ((input: ReturnType<typeof fixture>) => void)[] = [
      (i) => { i.challenge.claim.app_id = "another-app"; },
      (i) => { i.challenge.claim.agent_id = "another-agent"; },
      (i) => { i.challenge.claim.external_user_id = "another-user"; },
      (i) => { i.challenge.claim.scopes = ["read:agents"]; },
      (i) => { i.challenge.claim.scopes.push("write:agents"); },
      (i) => { i.challenge.claim.owner = `0x${"55".repeat(20)}`; },
      (i) => { i.challenge.claim.smart_account = `0x${"55".repeat(20)}`; },
      (i) => { i.challenge.claim.chain_id = 1; },
      (i) => { i.challenge.claim.grant_hash = `0x${"55".repeat(32)}`; },
      (i) => { i.challenge.claim.settings = { ...settings, live_trading_enabled: true }; },
    ];
    for (const edit of edits) {
      const input = fixture();
      edit(input);
      input.challenge.message = partnerEnrollmentMessage(input.challenge.claim);
      let signed = false;
      input.owner = { ...owner, signMessage: async () => { signed = true; return "0x00"; } };
      await assert.rejects(signMerrymanAuthorization(input));
      assert.equal(signed, false, "refuse before asking the owner to sign");
    }
  });

  it("compares capabilities as exact normalized sets", async () => {
    const input = fixture();
    input.expectedScopes = ["chat:agents", "read:agents", "read:agents"];
    await assert.doesNotReject(signMerrymanAuthorization(input));
  });

  it("refuses expired challenges, edited messages and owner-key-bearing grants", async () => {
    const expired = fixture();
    expired.challenge.claim.expires_at = Date.now() - 1;
    await assert.rejects(signMerrymanAuthorization(expired), /expired/);
    const message = fixture();
    message.challenge.message += "\nAuthorize another wallet.";
    await assert.rejects(signMerrymanAuthorization(message), /message does not match/);
    const key = fixture();
    key.grant = { ...grant, demoOwnerPrivateKey: `0x${"11".repeat(32)}` };
    await assert.rejects(signMerrymanAuthorization(key), /owner private key/);
  });
});

/**
 * ── prepareMerryman, over a stub chain and the REAL partner activation ───────
 *
 * The chain is canonical-wall-fixture's stub, which answers exactly the reads
 * the signer makes and refuses anything else. Activation is
 * createPartnerEnrollmentService from web/src/lib/partner-enrollment.ts, so
 * "activation accepts this grant" is that code's verdict, not a copy of its
 * allowed-field list that could drift from it.
 */
const ACCOUNT = "0x00000000000000000000000000000000000a11ce" as const;
/** A contract a partner controls, as far as any check here can tell. */
const FOREIGN = "0x000000000000000000000000000000000badbad1" as const;
const CAPS = { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 };
const APP = { app_id: "prism-production", key_id: "000000000001", name: "Prism", scopes: ["read:agents", "write:agents", "chat:agents"] };
const SCOPES = ["read:agents", "chat:agents"];
const SETTINGS = { name: "Robin", strategy: "steady-basket" as const, basket_symbols: ["AAPL", "MSFT"], live_trading_enabled: false };
const SECRET = "sdk-test-partner-enrollment-secret-at-least-32-bytes";

/** An owner wallet that can only be asked to sign: no key is reachable through it. */
function wallet() {
  const key = generatePrivateKey();
  const signer = privateKeyToAccount(key);
  const log: string[] = [];
  const owner: LocalAccount = toAccount({
    address: signer.address,
    signMessage: async (args) => { log.push("sign:message"); return signer.signMessage(args); },
    signTypedData: async (args) => { log.push("sign:typed-data"); return signer.signTypedData(args); },
    signTransaction: async (args) => { log.push("sign:transaction"); return signer.signTransaction(args); },
  });
  return { owner, key, log };
}

/** prepareMerryman on the stub chain; statuses and signatures share one log, in order. */
function attempt(options: Record<string, unknown> = {}) {
  const w = wallet();
  const reads: NonNullable<KernelState["reads"]> = [];
  const grant = withStubChain(ACCOUNT, () => prepareMerryman({
    owner: w.owner, caps: CAPS, onStatus: (status: string) => { w.log.push(`status:${status}`); }, ...options,
  } as PrepareMerrymanOptions), { currentNonce: 0, undeployed: true, reads });
  return { ...w, reads, grant };
}

/** Refused before the chain is read, a status is shown or the owner is asked anything. */
async function refusedUpFront(options: Record<string, unknown>, why: RegExp) {
  const a = attempt(options);
  await assert.rejects(a.grant, why);
  assert.deepEqual(a.log, [], "no status and no signature request");
  assert.deepEqual(a.reads, [], "no chain read");
}

const stores: { store: FilePartnerStore; home: string }[] = [];
after(() => {
  for (const { store, home } of stores) {
    store.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/** Challenge, owner authorization and activation, exactly as a partner backend forwards them. */
async function activate(grant: StoredGrant, owner: LocalAccount) {
  const home = mkdtempSync(join(tmpdir(), "merrymen-sdk-"));
  const store = new FilePartnerStore(home, undefined, () => SECRET);
  stores.push({ store, home });
  const saved = new Map<string, StoredGrant>();
  const service = createPartnerEnrollmentService({
    store, secret: () => SECRET,
    derive: async () => derivationOf(ACCOUNT),
    // The stub chain's factory answer, which activation re-reads to pin the vault.
    classVault: async (factory, account) => {
      assert.equal(factory.toLowerCase(), CLASS_FACTORY);
      assert.equal(account.toLowerCase(), ACCOUNT.toLowerCase());
      return CLASS_VAULT;
    },
    grants: { get: async (t) => saved.get(t) ?? null, put: async (t, g) => { saved.set(t, g); }, tenantForAccount: async () => null },
    settings: { get: async () => null, put: async () => {} },
    identities: { ensure: async (tenant, account) => ({ tenant, slug: "0000000000000001", accounts: [account], createdAt: 1, updatedAt: 1 }) },
  });
  const { connection } = await store.create({ partnerId: APP.app_id, partnerName: APP.name, externalUserId: "usr_123", name: "Robin", scopes: SCOPES });
  const challenge = await service.challenge(APP, connection, {
    owner: grant.owner, smart_account: grant.smartAccount, chain_id: grant.chainId, grant_hash: partnerGrantDigest(grant), settings: SETTINGS,
  });
  const authorization = await signMerrymanAuthorization({
    owner, grant, challenge, settings: SETTINGS,
    expectedAppId: APP.app_id, expectedAgentId: connection.id, expectedExternalUserId: "usr_123", expectedScopes: SCOPES,
  });
  const result = await service.activate(APP, connection, JSON.parse(JSON.stringify(authorization)));
  return { result, stored: saved.get(grant.owner.toLowerCase()) };
}
const partnerCode = (code: string) => (error: unknown) => error instanceof PartnerError && error.code === code;

describe("prepareMerryman", () => {
  it("refuses a Trencher factory before any chain read or signature", async () => {
    await refusedUpFront({ trencherFactory: TRENCHER_FACTORY }, /does not grant Trencher permissions: remove trencherFactory/);
  });

  it("offers only owner, caps, chainId and onStatus in its option type", () => {
    const { owner } = wallet();
    const options: PrepareMerrymanOptions[] = [
      { owner, caps: CAPS, chainId: 46630, onStatus: () => {} },
      // @ts-expect-error Partner enrollment grants no Trencher permission.
      { owner, caps: CAPS, trencherFactory: TRENCHER_FACTORY },
      // @ts-expect-error Nor a route through a contract the partner names.
      { owner, caps: CAPS, ponsAdapterAddress: FOREIGN },
      // @ts-expect-error
      { owner, caps: CAPS, v4AdapterAddress: FOREIGN },
      // @ts-expect-error
      { owner, caps: CAPS, ponsClassVaultFactory: FOREIGN },
      // @ts-expect-error
      { owner, caps: CAPS, extraTokens: [{ symbol: "PRTNR", address: FOREIGN, decimals: 18 }] },
    ];
    assert.ok(options);
  });

  // Each one the dashboard signer honours, and each address it seals.
  const UNOFFERED: [string, unknown][] = [
    ["ponsAdapterAddress", FOREIGN],
    ["v4AdapterAddress", FOREIGN],
    ["ponsClassVaultFactory", FOREIGN],
    ["extraTokens", [{ symbol: "PRTNR", address: FOREIGN, decimals: 18 }]],
    ["expectAccount", ACCOUNT],
    ["minimumValidationNonce", 2],
    ["hostedAs", ACCOUNT],
    // Perpetuals: a partner enrollment can never seal, carry or drop a Lighter key.
    ["perp", { apiPublicKey: `0x${"1a".repeat(40)}` }],
    ["previousGrant", { smartAccount: ACCOUNT }],
    ["perpDrop", true],
    ["venueFlat", true],
    ["recovery", { v: 1 }],
  ];

  it("refuses every signer option it does not offer, before any chain read or signature", async () => {
    for (const [option, value] of UNOFFERED) {
      await refusedUpFront({ [option]: value }, new RegExp(`takes only owner, caps, chainId and onStatus; remove ${option}\\. Partner enrollment seals`));
    }
    await refusedUpFront({ ponsAdapterAddress: FOREIGN, extraTokens: [] }, /remove ponsAdapterAddress, extraTokens\./);
    // Absent and undefined are the same thing, as for chainId.
    const a = attempt({ ponsAdapterAddress: undefined, trencherFactory: undefined });
    assert.equal((await a.grant).ponsAdapterAddress, undefined);
  });

  it("refuses them because the signer seals any adapter or token it is given, unverified", async () => {
    // What a partner's own contract would have become: a sealed route and an
    // approved spender in the owner's one signature.
    const { owner } = wallet();
    const grant = await withStubChain(ACCOUNT, () => prepareAgentGrant(owner, {
      caps: CAPS, onStatus: () => {}, ponsAdapterAddress: FOREIGN, extraTokens: [{ symbol: "PRTNR", address: FOREIGN, decimals: 18 }],
    }));
    assert.equal(grant.ponsAdapterAddress, FOREIGN);
    assert.ok(grant.grantFeatures?.includes("pons-adapter"));
    assert.deepEqual(grant.grantTokens, [FOREIGN]);
    assert.deepEqual(checkCanonicalWall({ ...grant }), { ok: true }, "the wall rebuilds from the grant's own addresses");
  });

  it("refuses it because activation refuses the fields a Trencher factory seals", async () => {
    // If activation ever accepts Trencher, this fails, and the refusal above
    // should be revisited rather than kept out of habit.
    const { owner } = wallet();
    const trench = await withStubChain(ACCOUNT, () => prepareAgentGrant(owner, { caps: CAPS, onStatus: () => {}, trencherFactory: TRENCHER_FACTORY }));
    assert.equal(trench.trencherFactoryAddress, TRENCHER_FACTORY);
    await assert.rejects(activate(trench, owner), partnerCode("bad_request"));
  });

  it("produces a grant partner activation accepts and stores unmodified", async () => {
    // The default mainnet mint is the fullest grant the SDK makes: it seals the
    // platform class vault, so its vault fields are what activation must accept.
    const a = attempt();
    const grant = await a.grant;
    assert.ok(grant.ponsClassVaultAddress, "the class vault was sealed");
    assert.equal(grant.ponsClassVaultFactoryAddress, CLASS_FACTORY, "from the platform's own factory");
    assert.equal(grant.ponsAdapterAddress, undefined, "and no adapter route anyone named");
    assert.equal(grant.v4AdapterAddress, undefined);
    assert.deepEqual(grant.grantTokens ?? [], [], "nor a token beyond the listings");
    const { result, stored } = await activate(grant, a.owner);
    assert.equal(result.connection.status, "linked");
    assert.equal(result.smartAccount, ACCOUNT);
    assert.deepEqual(stored, {
      ...grant,
      owner: grant.owner.toLowerCase(),
      smartAccount: grant.smartAccount.toLowerCase(),
      sessionKeyAddress: grant.sessionKeyAddress.toLowerCase(),
    });
  });

  it("seals the caps it was given into the wall, not only into the metadata", async () => {
    const wide = { perTradeUsdg: 25, dailyUsdg: 25, expiryDays: 30, maxDrawdownPct: 100, maxOpsPerDay: 1 };
    const [narrow, broad] = [await attempt().grant, await attempt({ caps: wide }).grant];
    assert.deepEqual(narrow.caps, CAPS);
    assert.deepEqual(broad.caps, wide);
    assert.equal(broad.expiresAt - broad.grantedAt, wide.expiryDays * 86_400);
    assert.deepEqual(checkCanonicalWall({ ...broad }), { ok: true });
    // The server rebuilds the wall from the grant's caps: claiming the other
    // grant's caps over this signed wall does not match it.
    assert.equal(checkCanonicalWall({ ...narrow, caps: wide }).ok, false);
    assert.equal(checkCanonicalWall({ ...broad, caps: CAPS }).ok, false);
  });

  // Each breaks exactly one of activation's rules, and the signer seals every one.
  const UNACTIVATABLE_CAPS: Record<string, unknown>[] = [
    { ...CAPS, note: 1 },
    { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5 },
    { ...CAPS, perTradeUsdg: 0.5 },
    { ...CAPS, maxOpsPerDay: 0 },
    { ...CAPS, perTradeUsdg: 60 },
    { ...CAPS, maxDrawdownPct: 101 },
    { ...CAPS, expiryDays: 7.5 },
    { ...CAPS, expiryDays: 366 },
    { ...CAPS, maxOpsPerDay: 2.5 },
  ];

  it("refuses limits activation would refuse, before the owner is asked to sign them", async () => {
    for (const caps of [...UNACTIVATABLE_CAPS, { ...CAPS, dailyUsdg: Infinity }, { ...CAPS, perTradeUsdg: "10" }, null, []]) {
      await refusedUpFront({ caps }, /These limits cannot be activated/);
    }
  });

  it("refuses them because activation refuses each one after the signer has sealed it", async () => {
    // The parity pin: if activation's rules change, this or the next test fails.
    const refused = (error: unknown) => partnerCode("invalid_grant")(error) || partnerCode("bad_request")(error);
    for (const caps of UNACTIVATABLE_CAPS) {
      const { owner } = wallet();
      const grant = await withStubChain(ACCOUNT, () => prepareAgentGrant(owner, { caps: caps as unknown as typeof CAPS, onStatus: () => {} }));
      await assert.rejects(activate(grant, owner), refused, JSON.stringify(caps));
    }
  });

  // Each accepted by both, at a bound or an odd value of one field, so a check
  // here made STRICTER than activation's (a whole drawdown, an ops or USDG
  // ceiling, a minimum expiry) fails too, not only a looser one.
  const ACTIVATABLE_CAPS = [
    { perTradeUsdg: 1.5, dailyUsdg: 1.5, expiryDays: 365, maxDrawdownPct: 100, maxOpsPerDay: 1 },
    { perTradeUsdg: 1, dailyUsdg: 1, expiryDays: 1, maxDrawdownPct: 1, maxOpsPerDay: 1 },
    { ...CAPS, perTradeUsdg: 2.25, dailyUsdg: 7.75 },
    { ...CAPS, maxDrawdownPct: 12.5 },
    { ...CAPS, maxOpsPerDay: 1_000_000 },
    // The largest whole USDG amount the signer can seal exactly.
    { ...CAPS, perTradeUsdg: Math.floor(MAX_USDG_UI), dailyUsdg: Math.floor(MAX_USDG_UI) },
  ];

  it("accepts limits at activation's own bounds, and odd values inside them", async () => {
    for (const caps of ACTIVATABLE_CAPS) {
      const a = attempt({ caps });
      const { result } = await activate(await a.grant, a.owner);
      assert.equal(result.connection.status, "linked", JSON.stringify(caps));
    }
  });

  it("signs for mainnet by default and for the testnet when asked, and activation keeps that chain", async () => {
    assert.equal((await attempt().grant).chainId, 4663);
    const testnet = attempt({ chainId: 46630 });
    const grant = await testnet.grant;
    assert.equal(grant.chainId, 46630);
    const { result } = await activate(grant, testnet.owner);
    assert.equal(result.chainId, 46630);
  });

  it("refuses any other chain id instead of quietly signing for mainnet", async () => {
    // The signer maps every id but the testnet's to mainnet, so each of these
    // used to come back as a real-funds chain 4663 grant.
    for (const chainId of [1, 46631, 0, "46630", "4663", null, 46630n, NaN]) {
      await refusedUpFront({ chainId }, /is not a partner enrollment chain: use Robinhood Chain 4663 or its testnet 46630/);
    }
    // Named as given: a bigint is not JSON, and "46630" is not 46630.
    await refusedUpFront({ chainId: 46630n }, /^Error: chainId 46630n is not/);
    await refusedUpFront({ chainId: "46630" }, /^Error: chainId "46630" is not/);
    await refusedUpFront({ chainId: null }, /^Error: chainId null is not/);
  });

  it("reports progress through onStatus, and the last status precedes the owner's one signature", async () => {
    const a = attempt();
    await a.grant;
    assert.equal(a.log[0], "status:deriving your smart account…");
    assert.deepEqual(a.log.slice(-2), ["status:sealing the permission grant…", "sign:typed-data"]);
    assert.ok(a.log.every((entry) => entry !== "status:"), "every status has text");
    // onStatus is optional.
    const quiet = wallet();
    await withStubChain(ACCOUNT, () => prepareMerryman({ owner: quiet.owner, caps: CAPS }));
    assert.deepEqual(quiet.log, ["sign:typed-data"]);
  });

  it("asks the owner wallet only to sign, and never emits an owner key", async () => {
    // The owner here is a signer with no key behind it that the SDK could reach.
    const a = attempt();
    const grant = await a.grant;
    assert.deepEqual(a.log.filter((entry) => entry.startsWith("sign:")), ["sign:typed-data"], "one permission signature, nothing else");
    assert.equal(grant.owner, a.owner.address);
    assert.equal(grant.demoOwnerPrivateKey, undefined);
    assert.equal(carriesOwnerKey(grant), false);
    const emitted = JSON.stringify([grant, a.log]).toLowerCase();
    assert.ok(!emitted.includes(a.key.slice(2).toLowerCase()), "the owner key appears nowhere in the grant or statuses");
    assert.notEqual(grant.sessionKeyAddress.toLowerCase(), a.owner.address.toLowerCase());
    // An address alone is not a signer: refused before anything is read or shown.
    await refusedUpFront({ owner: { address: a.owner.address } }, /explicit wallet signer/);
  });
});

const BUILD = fileURLToPath(new URL("./build.mjs", import.meta.url));
/** Run a build script (sdk/build.mjs unless given a copy) and return what it printed. */
const buildTo = (out: string, script = BUILD) =>
  execFileSync(process.execPath, [script, "--outfile", out], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Import a built bundle the way a partner's page does, in a process with no
 * process, Buffer or global. Importing it into this test's own Node process
 * hid a top-level process.env read that broke the SDK in every browser.
 */
function importLikeABrowser(file: string): Record<string, unknown> {
  const script = `const url = process.argv[1];
for (const name of ["process", "Buffer", "global"]) delete globalThis[name];
try {
  const sdk = await import(url);
  console.log(JSON.stringify({ exports: Object.fromEntries(Object.entries(sdk).map(([k, v]) => [k, typeof v === "function" ? "function" : v])) }));
} catch (error) { console.log(JSON.stringify({ error: String(error) })); }`;
  const { exports, error } = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, pathToFileURL(file).href], { encoding: "utf8" }));
  if (error) throw new Error(`The bundle does not load in a browser: ${error}`);
  return exports;
}

describe("SDK version", () => {
  it("speaks the partner API contract version the gateway reports", () => {
    // The gateway's /meta api_version default; a contract bump there must move this too.
    const gateway = readFileSync(new URL("../gateway/lib/partner-api.mjs", import.meta.url), "utf8");
    assert.equal(/\bversion = "([^"]+)"/.exec(gateway)?.[1], PARTNER_API_VERSION);
    assert.equal(SDK_VERSION, `${PARTNER_API_VERSION}+source`, "unbundled, the build is named as source");
  });

  it("is stamped into the built bundle as a fingerprint of its contents, and printed", () => {
    const home = mkdtempSync(join(tmpdir(), "merrymen-sdk-build-"));
    try {
      const out = join(home, "browser.mjs");
      const printed = buildTo(out);
      const version = new RegExp(`${PARTNER_API_VERSION}\\+[0-9a-f]{12}`).exec(printed)?.[0];
      assert.ok(version, `the build prints its version: ${printed}`);
      const code = readFileSync(out, "utf8");
      assert.ok(code.startsWith(`/* merrymen-browser ${version} */\n`), "the file names its version on its first line");
      assert.ok(!code.includes("placeholder"));
      assert.equal(importLikeABrowser(out).SDK_VERSION, version, "and the module exports it");
      assert.match(buildTo(out), new RegExp(`${version.replace("+", "\\+")}\\b`), "the same sources build the same version");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("built bundle", () => {
  it("loads in a page with no Node globals and exports the documented API", () => {
    const home = mkdtempSync(join(tmpdir(), "merrymen-sdk-build-"));
    try {
      const out = join(home, "browser.mjs");
      buildTo(out);
      assert.equal(/process\.env\.NEXT_PUBLIC_\w+/.exec(readFileSync(out, "utf8"))?.[0], undefined, "Next inlines these; esbuild does not");
      const sdk = importLikeABrowser(out);
      assert.match(String(sdk.SDK_VERSION), new RegExp(`^${PARTNER_API_VERSION}\\+[0-9a-f]{12}$`));
      assert.deepEqual(sdk, {
        PARTNER_API_VERSION, SDK_VERSION: sdk.SDK_VERSION,
        partnerGrantDigest: "function", prepareMerryman: "function", signMerrymanAuthorization: "function",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to build when a bundled module reads a NEXT_PUBLIC_ setting it does not settle", () => {
    // build.mjs bundles the browser.ts beside it, so a copy of it next to an
    // entry that reads a new setting stands in for a dashboard module that
    // starts to.
    const home = mkdtempSync(join(tmpdir(), "merrymen-sdk-build-"));
    try {
      mkdirSync(join(home, "sdk"));
      copyFileSync(BUILD, join(home, "sdk", "build.mjs"));
      symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(home, "node_modules"));
      writeFileSync(join(home, "tsconfig.json"), "{}");
      writeFileSync(join(home, "sdk", "browser.ts"), [
        `export const PARTNER_API_VERSION = "${PARTNER_API_VERSION}";`,
        "declare const __MERRYMEN_SDK_BUILD__: string;",
        "export const SDK_VERSION = __MERRYMEN_SDK_BUILD__;",
        "export const venue = process.env.NEXT_PUBLIC_SOMETHING_NEW;",
      ].join("\n"));
      const out = join(home, "browser.mjs");
      assert.throws(() => buildTo(out, join(home, "sdk", "build.mjs")), /reads process\.env\.NEXT_PUBLIC_SOMETHING_NEW, which no browser defines/);
      assert.equal(existsSync(out), false, "and writes nothing");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
