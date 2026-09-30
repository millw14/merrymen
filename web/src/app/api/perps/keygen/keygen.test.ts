/**
 * POST /api/perps/keygen, with the REAL pinned signer (docs/perps.md rule 5).
 *
 *   self-hosted  the private key lands in $MERRYMEN_HOME/perp-keys (0600)
 *                and the answer carries only the public key;
 *   hosted       the answer carries the public key and a blob that opens
 *                under the DEK for exactly (tenant, account, pubkey, 16) —
 *                and nothing is written to the web container's disk;
 *   both         authenticated like POST /api/grants, POST-only, never
 *                cached, rate-limited, and no answer carries the private key.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const saved = Object.fromEntries(
  [
    "MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK", "MERRYMEN_LIGHTER_VENDOR_DIR",
    "MERRYMEN_PERPS", "MERRYMEN_PERPS_LIVE_TENANTS",
  ].map((k) => [k, process.env[k]]),
);
const root = mkdtempSync(path.join(tmpdir(), "mm-perp-keygen-route-"));
process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_LIGHTER_VENDOR_DIR;
// The operator's levers start at each tier's default; the cases below set them.
delete process.env.MERRYMEN_PERPS;
delete process.env.MERRYMEN_PERPS_LIVE_TENANTS;
const DEK = Buffer.alloc(32, 7);

let route: typeof import("./route");
let auth: typeof import("@/lib/auth");
let loadPerpPrivateKey: typeof import("../../../../../../worker/src/perps/keystore").loadPerpPrivateKey;
let openPerpKey: typeof import("../../../../../../worker/src/perps/key-seal").openPerpKey;

before(async () => {
  auth = await import("@/lib/auth");
  ({ loadPerpPrivateKey } = await import("../../../../../../worker/src/perps/keystore"));
  ({ openPerpKey } = await import("../../../../../../worker/src/perps/key-seal"));
  route = await import("./route");
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const ACCOUNT = "0x00000000000000000000000000000000000000A1";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  route.POST(
    new Request("http://localhost:3100/api/perps/keygen", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const assertNoStore = (res: Response) => assert.match(res.headers.get("cache-control") ?? "", /private, no-store/);
const newHome = (name: string) => {
  const h = path.join(root, name);
  process.env.MERRYMEN_HOME = h;
  return h;
};

it("POST is the only method, and the route is force-dynamic", () => {
  const exported = Object.keys(route).sort();
  assert.deepEqual(exported, ["POST", "dynamic"]);
  assert.equal(route.dynamic, "force-dynamic");
});

describe("self-hosted", () => {
  before(() => {
    delete process.env.MERRYMEN_HOSTED;
  });

  it("the key file is written (0600) and only the public key comes back", async () => {
    const home = newHome("self");
    const res = await post({ smartAccount: ACCOUNT });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assertNoStore(res);
    const body = JSON.parse(text) as { apiPublicKey: `0x${string}`; apiKeyIndex: number };
    assert.deepEqual(Object.keys(body).sort(), ["apiKeyIndex", "apiPublicKey"]);
    assert.equal(body.apiKeyIndex, 16);
    const pair = loadPerpPrivateKey({ home, apiPublicKey: body.apiPublicKey });
    const bare = pair.privateKey.slice(2);
    for (const s of [bare, bare.toUpperCase()]) assert.ok(!text.includes(s) && !JSON.stringify([...res.headers]).includes(s), "the private key never leaves in the answer");
    const file = path.join(home, "perp-keys", `${body.apiPublicKey.slice(2)}.json`);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  // The self-hosted refusal of an opt-in the operator does not offer is in
  // offer.test.ts: its own process, so its own per-caller limiter window.

  it("a body that is not exactly { smartAccount } is refused, uncached", async () => {
    newHome("self-bad");
    for (const bad of ["not json", { smartAccount: "0x1234" }, { smartAccount: ACCOUNT, apiPrivateKey: "x" }]) {
      const res = await post(bad);
      assert.equal(res.status, 400);
      assertNoStore(res);
    }
    assert.equal(existsSync(path.join(root, "self-bad", "perp-keys")), false, "no key was made for a refused request");
  });
});

describe("hosted", () => {
  const cookieFor = (wallet: `0x${string}`) => ({ cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(wallet)}` });
  before(() => {
    process.env.MERRYMEN_HOSTED = "1";
    process.env.MERRYMEN_STORE_DEK = DEK.toString("base64");
    // Admission requires shared custody storage. Keygen only seals a key and
    // does not connect to this synthetic database address.
    process.env.DATABASE_URL = "postgres://127.0.0.1:1/never-connected";
    // Rollout Phase 2 for ACCOUNT: the operator has opened live perps and
    // allowlisted it. Without both, hosted keygen mints nothing (below).
    process.env.MERRYMEN_PERPS = "live";
    process.env.MERRYMEN_PERPS_LIVE_TENANTS = ACCOUNT.toLowerCase();
  });

  it("the hosted default (paper), or an account not on the live list: 403 perp-not-offered — no key made or held", async () => {
    newHome("hosted-not-offered");
    const tenant = privateKeyToAccount(generatePrivateKey()).address;
    const cases: [string | undefined, string | undefined, string][] = [
      [undefined, undefined, ACCOUNT],
      ["paper", ACCOUNT.toLowerCase(), ACCOUNT],
      ["live", undefined, ACCOUNT],
      ["live", ACCOUNT.toLowerCase(), "0x00000000000000000000000000000000000000b2"],
    ];
    try {
      for (const [ceiling, list, account] of cases) {
        if (ceiling === undefined) delete process.env.MERRYMEN_PERPS;
        else process.env.MERRYMEN_PERPS = ceiling;
        if (list === undefined) delete process.env.MERRYMEN_PERPS_LIVE_TENANTS;
        else process.env.MERRYMEN_PERPS_LIVE_TENANTS = list;
        const res = await post({ smartAccount: account }, cookieFor(tenant));
        const text = await res.text();
        assert.equal(res.status, 403, `${ceiling}/${list}/${account}: ${text}`);
        assertNoStore(res);
        assert.equal((JSON.parse(text) as { code?: string }).code, "perp-not-offered");
        assert.doesNotMatch(text, /apiKeySealed|apiPublicKey/);
      }
    } finally {
      process.env.MERRYMEN_PERPS = "live";
      process.env.MERRYMEN_PERPS_LIVE_TENANTS = ACCOUNT.toLowerCase();
    }
  });

  it("signed out: 401, uncached", async () => {
    newHome("hosted-anon");
    const res = await post({ smartAccount: ACCOUNT });
    assert.equal(res.status, 401);
    assertNoStore(res);
  });

  it("the public key + a blob that opens for exactly this tenant, account and key — and nothing on disk", async () => {
    const home = newHome("hosted");
    const tenant = privateKeyToAccount(generatePrivateKey()).address;
    const res = await post({ smartAccount: ACCOUNT }, cookieFor(tenant));
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assertNoStore(res);
    const body = JSON.parse(text) as { apiPublicKey: string; apiKeyIndex: number; apiKeySealed: string };
    assert.deepEqual(Object.keys(body).sort(), ["apiKeyIndex", "apiKeySealed", "apiPublicKey"]);
    const priv = openPerpKey(body.apiKeySealed, { tenant, smartAccount: ACCOUNT, apiPublicKey: body.apiPublicKey, apiKeyIndex: 16 }, DEK);
    assert.ok(!text.includes(priv.slice(2)) && !text.toUpperCase().includes(priv.slice(2).toUpperCase()), "only ciphertext leaves");
    const other = privateKeyToAccount(generatePrivateKey()).address;
    assert.throws(() => openPerpKey(body.apiKeySealed, { tenant: other, smartAccount: ACCOUNT, apiPublicKey: body.apiPublicKey, apiKeyIndex: 16 }, DEK));
    assert.ok(!existsSync(home) || !readdirSync(home).includes("perp-keys"), "hosted keygen writes no key file");
  });

  it("no DEK: hosted custody is not offered, and no key is made", async () => {
    newHome("hosted-nodek");
    delete process.env.MERRYMEN_STORE_DEK;
    try {
      const res = await post({ smartAccount: ACCOUNT }, cookieFor(privateKeyToAccount(generatePrivateKey()).address));
      assert.equal(res.status, 403);
      assertNoStore(res);
      assert.equal(((await res.json()) as { code?: string }).code, "perp-not-offered");
    } finally {
      process.env.MERRYMEN_STORE_DEK = DEK.toString("base64");
    }
  });

  it("rate-limited per tenant: the sixth in a minute is a 429 with Retry-After; another tenant is unaffected", async () => {
    newHome("hosted-limit");
    const tenant = privateKeyToAccount(generatePrivateKey()).address;
    for (let i = 0; i < 5; i++) assert.equal((await post({ smartAccount: ACCOUNT }, cookieFor(tenant))).status, 200);
    const sixth = await post({ smartAccount: ACCOUNT }, cookieFor(tenant));
    assert.equal(sixth.status, 429);
    assertNoStore(sixth);
    assert.ok(Number(sixth.headers.get("retry-after")) >= 1);
    assert.equal((await post({ smartAccount: ACCOUNT }, cookieFor(privateKeyToAccount(generatePrivateKey()).address))).status, 200);
  });
});
