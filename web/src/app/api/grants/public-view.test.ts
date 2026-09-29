/**
 * GET /api/grants SHOWS A GRANT THROUGH AN ALLOWLIST, AND NEVER STORES IT.
 *
 * It used to strip secrets with a denylist of top-level keys and spread the
 * rest out — safe exactly until a field was added, and perps add a nested
 * one (docs/perps.md rule 5). Now the grant goes out through core's
 * publicGrantView. These tests fill a grant with every secret it has ever
 * carried, plus a field nobody listed holding an 80-hex key, and deep-scan the
 * whole answer — body and headers — for each secret in 0x, bare and upper-case
 * spellings. They also pin that every field a screen reads (web, iOS,
 * Android) is still there, and that every answer is `private, no-store`.
 *
 * Driven through the real GET, self-hosted (grant.json on disk) and hosted
 * (the real file grant store, a real session cookie). The chain reads are
 * refused by a stubbed fetch, which the route renders as unread balances.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const saved = Object.fromEntries(
  ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK", "MERRYMEN_PERPS", "MERRYMEN_PERPS_LIVE_TENANTS"].map(
    (k) => [k, process.env[k]],
  ),
);
const home = mkdtempSync(path.join(tmpdir(), "mm-grants-public-view-"));
process.env.MERRYMEN_HOME = home;
process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_HOSTED;
delete process.env.MERRYMEN_PERPS;
delete process.env.MERRYMEN_PERPS_LIVE_TENANTS;

let GET: (req: Request) => Promise<Response>;
let auth: typeof import("@/lib/auth");
let sealSecret: (plaintext: string, dek: Buffer) => string;

before(async () => {
  auth = await import("@/lib/auth");
  ({ sealSecret } = await import("../../../../../worker/src/store-crypto"));
  // Every chain read the route makes is refused: balances become null (unread).
  mock.method(globalThis, "fetch", async () => {
    throw new Error("no network in this test");
  });
  ({ GET } = await import("./route"));
});
after(() => {
  mock.restoreAll();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const SESSION_KEY = generatePrivateKey();
const OWNER_KEY = generatePrivateKey();
const OWNER = privateKeyToAccount(OWNER_KEY).address;
const SESSION = privateKeyToAccount(SESSION_KEY).address;
const SMART = "0x00000000000000000000000000000000000000a1";
const SERIALIZED = Buffer.from(JSON.stringify({ privateKey: SESSION_KEY, note: "a zerodev blob" })).toString("base64");
const WALLET_SIG = `0x${"1a".repeat(65)}`;
const OWNER_SIG = `0x${"2b".repeat(65)}`;
const NONCE = "nonce-that-is-single-use-and-server-issued";
const DID = "did:privy:secret-ish-identifier";
/** A canonical Lighter public key (five small little-endian limbs). */
const API_PUB = `0x${("01" + "00".repeat(7)).repeat(5)}`;
const API_SEALED = `pk1.${"A".repeat(16)}.${"B".repeat(22)}.${"C".repeat(110)}`;
/** An 80-hex key in a field NOBODY listed — the shape of a Lighter private key. */
const STRAY_80 = `0x${"9f".repeat(40)}`;

function fullGrant(extra: Record<string, unknown> = {}) {
  return {
    smartAccount: SMART,
    owner: OWNER,
    sessionKeyAddress: SESSION,
    serialized: SERIALIZED,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 20, maxOpsPerDay: 100 },
    grantedAt: 1_790_000_000,
    expiresAt: 1_791_209_600,
    chainId: 4663,
    grantFeatures: ["tradeable-v2", "perp-lighter-v1"],
    grantTokens: ["0x00000000000000000000000000000000000000b2"],
    trencherVaultAddress: "0x00000000000000000000000000000000000000c3",
    trencherFactoryAddress: "0x00000000000000000000000000000000000000d4",
    binding: { version: "privy-did-owner-v1", nonce: NONCE, walletSignature: WALLET_SIG, ownerSignature: OWNER_SIG, did: DID },
    perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: API_PUB, apiKeySealed: API_SEALED },
    demoSessionPrivateKey: SESSION_KEY,
    demoOwnerPrivateKey: OWNER_KEY,
    ...extra,
  };
}

/** Every spelling a hex secret could leak in. */
function spellings(secret: string): string[] {
  if (!/^0x[0-9a-fA-F]+$/.test(secret)) return [secret];
  const bare = secret.slice(2);
  return [`0x${bare.toLowerCase()}`, bare.toLowerCase(), bare.toUpperCase(), `0x${bare.toUpperCase()}`];
}

async function scan(res: Response, secrets: Record<string, string>): Promise<Record<string, unknown>> {
  const text = await res.text();
  const headers = JSON.stringify([...res.headers.entries()]);
  const haystack = `${text}\n${headers}`;
  for (const [name, secret] of Object.entries(secrets)) {
    for (const s of spellings(secret)) assert.ok(!haystack.includes(s), `${name} leaked in the GET answer (${s.slice(0, 10)}…)`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function assertNoStore(res: Response) {
  const cc = res.headers.get("cache-control") ?? "";
  assert.match(cc, /no-store/, `every answer is no-store, got "${cc}"`);
  assert.match(cc, /private/);
}

/** What every screen reads — web App/Wallet/YouClient, iOS Grant/Withdraw/Account/OwnerOverview, Android Act/AccountStatus/Models. */
function assertScreensStillFed(grant: Record<string, unknown>, perpExpected = true) {
  assert.equal(grant.smartAccount, SMART);
  assert.equal(grant.owner, OWNER);
  assert.equal(grant.sessionKeyAddress, SESSION);
  assert.equal(grant.chainId, 4663);
  assert.equal(grant.grantedAt, 1_790_000_000);
  assert.equal(grant.expiresAt, 1_791_209_600);
  assert.deepEqual(grant.caps, { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 20, maxOpsPerDay: 100 });
  assert.deepEqual(grant.grantFeatures, ["tradeable-v2", "perp-lighter-v1"]);
  assert.deepEqual(grant.grantTokens, ["0x00000000000000000000000000000000000000b2"]);
  assert.equal(grant.trencherVaultAddress, "0x00000000000000000000000000000000000000c3");
  assert.equal(grant.trencherFactoryAddress, "0x00000000000000000000000000000000000000d4");
  assert.deepEqual(grant.binding, { version: "privy-did-owner-v1" });
  if (perpExpected) assert.deepEqual(grant.perp, { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: API_PUB });
}

const SECRETS = {
  "session key": SESSION_KEY,
  "owner key": OWNER_KEY,
  "serialized permission": SERIALIZED,
  "wallet binding signature": WALLET_SIG,
  "owner binding signature": OWNER_SIG,
  "binding nonce": NONCE,
  "privy did": DID,
  "sealed Lighter key": API_SEALED,
};

describe("self-hosted: grant.json with every secret, and a stray 80-hex key", () => {
  before(() => {
    delete process.env.MERRYMEN_HOSTED;
    writeFileSync(path.join(home, "grant.json"), JSON.stringify(fullGrant({ someFutureField: { nested: STRAY_80 } }), null, 2));
  });

  it("no secret, in any spelling, anywhere in the answer — and every screen's field is still there", async () => {
    const res = await GET(new Request("http://localhost:3100/api/grants"));
    assert.equal(res.status, 200);
    assertNoStore(res);
    const body = await scan(res, { ...SECRETS, "stray 80-hex key": STRAY_80 });
    assert.equal(body.exists, true);
    const grant = body.grant as Record<string, unknown>;
    assertScreensStillFed(grant);
    assert.equal("someFutureField" in grant, false, "a field nobody listed is not shown");
    assert.equal("serialized" in grant, false);
    // Unread chain balances are null, never zero.
    assert.equal((body.balances as Record<string, unknown>).ethWei, null);
  });

  it("{ exists: false } is no-store too", async () => {
    rmSync(path.join(home, "grant.json"), { force: true });
    const res = await GET(new Request("http://localhost:3100/api/grants"));
    assert.deepEqual(await res.json(), { exists: false });
    assertNoStore(res);
  });
});

describe("hosted: the real file grant store, a real session", () => {
  const tenant = privateKeyToAccount(generatePrivateKey()).address;
  const tenantFile = () => path.join(home, "tenants", `${tenant.toLowerCase()}.json`);
  const cookie = () => `${auth.SESSION_COOKIE}=${auth.mintSession(tenant)}`;
  const writeRecord = (grant: Record<string, unknown>) => {
    const { demoSessionPrivateKey, demoOwnerPrivateKey: _o, ...rest } = grant as { demoSessionPrivateKey: string; demoOwnerPrivateKey?: string };
    void _o;
    mkdirSync(path.dirname(tenantFile()), { recursive: true });
    writeFileSync(
      tenantFile(),
      JSON.stringify({ tenant: tenant.toLowerCase(), chainId: 4663, grant: rest, sealedSessionKey: sealSecret(demoSessionPrivateKey, Buffer.alloc(32, 7)), updatedAt: 1 }),
    );
  };
  before(() => {
    process.env.MERRYMEN_HOSTED = "1";
  });
  after(() => {
    delete process.env.MERRYMEN_HOSTED;
  });

  it("the store joins the session key back in; the answer carries none of it — nor a stray 64-hex key", async () => {
    const stray64 = `0x${"7c".repeat(32)}`;
    writeRecord(fullGrant({ demoOwnerPrivateKey: undefined, leftover: { deep: [stray64] } }));
    const res = await GET(new Request("https://app.merrymen.dev/api/grants", { headers: { cookie: cookie() } }));
    assert.equal(res.status, 200);
    assertNoStore(res);
    const body = await scan(res, { ...SECRETS, "owner key": OWNER_KEY, "stray 64-hex key": stray64 });
    assertScreensStillFed(body.grant as Record<string, unknown>);
  });

  it("a stored record holding a plaintext 80-hex key is refused on the way out, so nothing is shown at all", async () => {
    writeRecord(fullGrant({ demoOwnerPrivateKey: undefined, stray: STRAY_80 }));
    const res = await GET(new Request("https://app.merrymen.dev/api/grants", { headers: { cookie: cookie() } }));
    assertNoStore(res);
    const body = await scan(res, { ...SECRETS, "stray 80-hex key": STRAY_80 });
    assert.deepEqual(body, { exists: false });
  });

  it("signed out: { exists: false }, no-store", async () => {
    const res = await GET(new Request("https://app.merrymen.dev/api/grants"));
    assert.deepEqual(await res.json(), { exists: false });
    assertNoStore(res);
  });
});

/**
 * `perpsOptIn` — THE OPERATOR'S OFFER, per account (review: perp-optin-ungated).
 * The dashboard shows the perps box only when this is true, so it must be the
 * same resolution keygen and the intake refuse by: MERRYMEN_PERPS and, hosted,
 * MERRYMEN_PERPS_LIVE_TENANTS, for the grant's own account.
 */
describe("perpsOptIn: offered only where the operator's ceiling for this account is live", () => {
  after(() => {
    delete process.env.MERRYMEN_HOSTED;
    delete process.env.MERRYMEN_PERPS;
    delete process.env.MERRYMEN_PERPS_LIVE_TENANTS;
  });

  it("self-hosted: offered by default (the owner is the operator), not under MERRYMEN_PERPS=paper or off", async () => {
    delete process.env.MERRYMEN_HOSTED;
    writeFileSync(path.join(home, "grant.json"), JSON.stringify(fullGrant(), null, 2));
    const read = async () => (await (await GET(new Request("http://localhost:3100/api/grants"))).json()) as { perpsOptIn?: unknown };
    assert.equal((await read()).perpsOptIn, true);
    for (const ceiling of ["paper", "off"]) {
      process.env.MERRYMEN_PERPS = ceiling;
      assert.equal((await read()).perpsOptIn, false, ceiling);
    }
    delete process.env.MERRYMEN_PERPS;
  });

  it("hosted: not offered by default (paper), nor to an account off the live list; offered to one on it", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    const tenant = privateKeyToAccount(generatePrivateKey()).address;
    const file = path.join(home, "tenants", `${tenant.toLowerCase()}.json`);
    const { demoSessionPrivateKey, demoOwnerPrivateKey: _o, ...rest } = fullGrant() as { demoSessionPrivateKey: string; demoOwnerPrivateKey?: string };
    void _o;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ tenant: tenant.toLowerCase(), chainId: 4663, grant: rest, sealedSessionKey: sealSecret(demoSessionPrivateKey, Buffer.alloc(32, 7)), updatedAt: 1 }));
    const read = async () =>
      (await (await GET(new Request("https://app.merrymen.dev/api/grants", { headers: { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(tenant)}` } }))).json()) as {
        exists?: unknown;
        perpsOptIn?: unknown;
      };
    const first = await read();
    assert.equal(first.exists, true);
    assert.equal(first.perpsOptIn, false, "the hosted default is paper: Rollout Phase 1 offers no opt-in");
    process.env.MERRYMEN_PERPS = "live";
    assert.equal((await read()).perpsOptIn, false, "live with nobody allowlisted");
    process.env.MERRYMEN_PERPS_LIVE_TENANTS = "0x00000000000000000000000000000000000000b2";
    assert.equal((await read()).perpsOptIn, false, "another account on the list");
    // The grant's ACCOUNT is what the list names — never the login.
    process.env.MERRYMEN_PERPS_LIVE_TENANTS = tenant;
    assert.equal((await read()).perpsOptIn, false, "the SIWE tenant is not the account");
    process.env.MERRYMEN_PERPS_LIVE_TENANTS = SMART;
    assert.equal((await read()).perpsOptIn, true);
  });
});
