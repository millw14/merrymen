/**
 * GET /api/grants?wallet=perps SHOWS THE GRANT THROUGH AN ALLOWLIST, AND NEVER
 * STORES IT (perps slice 5b, decision D3).
 *
 * Spot's answer strips secrets with main's denylist of three top-level keys,
 * which is safe exactly until a field is added; the Perps wallet's answer goes
 * through core's publicGrantView instead, an allowlist copied by shape. These
 * tests fill a Perps grant with every secret a grant has ever carried — the
 * session and owner keys, the serialized permission, the binding's nonce, DID
 * and both signatures, a sealed venue key — plus a field nobody listed holding
 * an 80-hex key, and deep-scan the whole answer, body and headers, for each in
 * 0x, bare and upper-case spellings. They pin that every field a screen reads
 * is still there, that every answer is `private, no-store`, and that Spot's
 * answer is main's, byte for byte (its client still needs the binding).
 *
 * Driven through the real GET, self-hosted (the Perps home's grant.json) and
 * hosted (the real file grant store, a real session cookie). The chain reads
 * are refused by a stubbed fetch, which the route renders as unread balances.
 * Adapted from the perps branch's public-view.test.ts (112dbeb6): its
 * `perpsOptIn` and live recovery-notice cases are live, and not ported.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it, mock } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const saved = Object.fromEntries(
  ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK", "MERRYMEN_PERPS"].map((k) => [k, process.env[k]]),
);
const home = mkdtempSync(path.join(tmpdir(), "mm-grants-public-view-"));
const PERPS_HOME = path.join(home, "accounts", "perps");
process.env.MERRYMEN_HOME = home;
process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_HOSTED;
delete process.env.MERRYMEN_PERPS;

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
  // The ledger a hosted GET reads (its recovery hold): with no DATABASE_URL
  // each wallet's read opens its own home's sqlite file (ledger.ts).
  const { wrapSqlite } = await import("../../../../../worker/src/db");
  const { applyLedgerSchema } = await import("../../../../../worker/src/store");
  for (const dir of [home, PERPS_HOME]) {
    mkdirSync(dir, { recursive: true });
    const raw = new DatabaseSync(path.join(dir, "merrymen.db"));
    try { await applyLedgerSchema(wrapSqlite(raw)); } finally { raw.close(); }
  }
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
    purpose: "perps",
    smartAccount: SMART,
    owner: OWNER,
    sessionKeyAddress: SESSION,
    serialized: SERIALIZED,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 20, maxOpsPerDay: 100 },
    grantedAt: 1_790_000_000,
    expiresAt: 1_791_209_600,
    chainId: 4663,
    grantFeatures: [],
    binding: { version: "privy-did-owner-v1", nonce: NONCE, walletSignature: WALLET_SIG, ownerSignature: OWNER_SIG, did: DID },
    // Not a paper grant's, but the view must hold whatever is stored.
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
  const haystack = `${text}\n${JSON.stringify([...res.headers.entries()])}`;
  for (const [name, secret] of Object.entries(secrets)) {
    for (const s of spellings(secret)) assert.ok(!haystack.includes(s), `${name} leaked in the GET answer (${s.slice(0, 10)}…)`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function assertNoStore(res: Response) {
  assert.equal(res.headers.get("cache-control"), "private, no-store");
}

/** What a screen reads of a grant: addresses, caps, times, markers, the binding's version, the venue's public key. */
function assertScreensStillFed(grant: Record<string, unknown>) {
  assert.equal(grant.purpose, "perps");
  assert.equal(grant.smartAccount, SMART);
  assert.equal(grant.owner, OWNER);
  assert.equal(grant.sessionKeyAddress, SESSION);
  assert.equal(grant.chainId, 4663);
  assert.equal(grant.grantedAt, 1_790_000_000);
  assert.equal(grant.expiresAt, 1_791_209_600);
  assert.deepEqual(grant.caps, { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 20, maxOpsPerDay: 100 });
  assert.deepEqual(grant.grantFeatures, []);
  assert.deepEqual(grant.binding, { version: "privy-did-owner-v1" });
  assert.deepEqual(grant.perp, { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: API_PUB });
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

describe("self-hosted: the Perps home's grant.json with every secret, and a stray 80-hex key", () => {
  before(() => {
    delete process.env.MERRYMEN_HOSTED;
    writeFileSync(path.join(PERPS_HOME, "grant.json"), JSON.stringify(fullGrant({ someFutureField: { nested: STRAY_80 } }), null, 2));
  });

  it("no secret, in any spelling, anywhere in the answer — and every screen's field is still there", async () => {
    const res = await GET(new Request("http://localhost:3100/api/grants?wallet=perps"));
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

  it("{ exists: false } is no-store too, for either wallet", async () => {
    rmSync(path.join(PERPS_HOME, "grant.json"), { force: true });
    for (const query of ["?wallet=perps", ""]) {
      const res = await GET(new Request(`http://localhost:3100/api/grants${query}`));
      assert.deepEqual(await res.json(), { exists: false });
      assertNoStore(res);
    }
  });
});

describe("hosted: the real file grant store, a real session", () => {
  const tenant = privateKeyToAccount(generatePrivateKey()).address;
  const cookie = () => `${auth.SESSION_COOKIE}=${auth.mintSession(tenant)}`;
  /** A stored record exactly as the file store writes one: the session key sealed beside the grant. */
  const writeRecord = (dir: "tenants" | "tenants-perps", grant: Record<string, unknown>) => {
    const { demoSessionPrivateKey, demoOwnerPrivateKey: _o, ...rest } = grant as { demoSessionPrivateKey: string; demoOwnerPrivateKey?: string };
    void _o;
    const file = path.join(home, dir, `${tenant.toLowerCase()}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ tenant: tenant.toLowerCase(), chainId: 4663, grant: rest, sealedSessionKey: sealSecret(demoSessionPrivateKey, Buffer.alloc(32, 7)), updatedAt: 1 }));
  };
  before(() => {
    process.env.MERRYMEN_HOSTED = "1";
  });
  after(() => {
    delete process.env.MERRYMEN_HOSTED;
  });

  it("the store joins the session key back in; the Perps answer carries none of it — nor a stray 64-hex key", async () => {
    const stray64 = `0x${"7c".repeat(32)}`;
    writeRecord("tenants-perps", fullGrant({ demoOwnerPrivateKey: undefined, leftover: { deep: [stray64] } }));
    const res = await GET(new Request("https://app.merrymen.dev/api/grants?wallet=perps", { headers: { cookie: cookie() } }));
    assert.equal(res.status, 200);
    assertNoStore(res);
    const body = await scan(res, { ...SECRETS, "stray 64-hex key": stray64 });
    assert.equal(body.tenant, tenant.toLowerCase());
    assertScreensStillFed(body.grant as Record<string, unknown>);
  });

  it("D3: Spot's answer is main's denylist view, byte for byte — its renewal and saved-grant code read the binding", async () => {
    const spot = { ...fullGrant(), purpose: undefined, perp: undefined, grantFeatures: ["tradeable-v2"], smartAccount: "0x00000000000000000000000000000000000000b1" };
    delete (spot as Record<string, unknown>).purpose;
    delete (spot as Record<string, unknown>).perp;
    writeRecord("tenants", spot);
    const res = await GET(new Request("https://app.merrymen.dev/api/grants", { headers: { cookie: cookie() } }));
    assertNoStore(res);
    const body = (await res.json()) as { grant: Record<string, unknown> };
    const { serialized: _s, demoSessionPrivateKey: _k, demoOwnerPrivateKey: _o, ...expected } = spot;
    void _s; void _k; void _o;
    assert.deepEqual(body.grant, expected);
  });

  it("signed out: { exists: false }, no-store, for either wallet", async () => {
    for (const query of ["?wallet=perps", ""]) {
      const res = await GET(new Request(`https://app.merrymen.dev/api/grants${query}`));
      assert.deepEqual(await res.json(), { exists: false, tenant: null });
      assertNoStore(res);
    }
  });
});
