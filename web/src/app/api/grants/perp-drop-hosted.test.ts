/**
 * HOSTED POST /api/grants REFUSES TO LET GO OF A VENUE KEY (docs/perps.md
 * rule 5) — the one layer an app build that predates perps cannot sign past.
 *
 * Driven through the real hosted POST with real signatures and a real signer
 * grant (no perps — exactly what an old build sends), so the claim passes the
 * canonical wall and the binding and reaches the stored-grant read. The stored
 * grant carries perp-lighter-v1. Stood in for: the nonce store (hosted refuses
 * a local one), the grant store's reads and write, and the venue (through
 * perp-custody's flatness seam). The chain is refused by a stubbed fetch.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, it, mock } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bindingMessage, type StoredGrant } from "@merrymen/core";
import { signerGrant } from "@/lib/canonical-wall-fixture";
import { sealPerpKey } from "../../../../../worker/src/perps/key-seal";

const ORIGIN = "https://app.merrymen.dev";
const SMART = "0x00000000000000000000000000000000000000a1" as const;
const OTHER = "0x00000000000000000000000000000000000000a2" as const;
const CHAIN = 4663;
const pub = (b: number) => `0x${(b.toString(16).padStart(2, "0") + "00".repeat(7)).repeat(5)}` as `0x${string}`;
const DEK = Buffer.alloc(32, 7);
const PRIV2 = `0x${"cd".repeat(40)}`;

const saved = Object.fromEntries(
  [
    "MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_PUBLIC_ORIGIN", "MERRYMEN_STORE_DEK",
    "MERRYMEN_PERPS", "MERRYMEN_PERPS_LIVE_TENANTS",
  ].map((k) => [k, process.env[k]]),
);
let home: string;
let POST: (req: Request) => Promise<Response>;
let auth: typeof import("@/lib/auth");
let custody: typeof import("@/lib/perp-custody");

let stored: StoredGrant | null = null;
const puts: unknown[] = [];
const flatAsked: string[] = [];
let flatAnswer: { flat: true } | { flat: false; detail: string } | { flat: null; detail: string } = { flat: true };

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-perp-drop-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
  process.env.DATABASE_URL = "postgres://127.0.0.1:1/never-connected";
  delete process.env.MERRYMEN_PUBLIC_ORIGIN;
  // The operator offers live perps to SMART (Rollout Phase 2), so a rotation's
  // NEW key is admitted by the offer gate and reaches the 409 below; the
  // not-offered case sets its own.
  process.env.MERRYMEN_PERPS = "live";
  process.env.MERRYMEN_PERPS_LIVE_TENANTS = SMART;
  auth = await import("@/lib/auth");
  custody = await import("@/lib/perp-custody");
  custody.setVenueFlatnessForTest(async (a) => {
    flatAsked.push(a);
    return flatAnswer;
  });
  // Through require, as owner-facing.test.ts explains: the route reaches the
  // worker modules that way, and a stub on the ESM instance is never called.
  const req = createRequire(import.meta.url);
  const { SqlNonceStore } = req("../../../../../worker/src/auth-nonce-store.ts") as typeof import("../../../../../worker/src/auth-nonce-store");
  mock.method(SqlNonceStore.prototype, "consume", async () => true);
  const grants = req("../../../../../worker/src/grant-store.ts") as typeof import("../../../../../worker/src/grant-store");
  grants.resetGrantStoreForTest();
  const store = grants.getGrantStore();
  const separate = grants.getGrantStore("perps");
  mock.method(separate, "get", async () => null);
  mock.method(separate as { hasStoredGrant(tenant: `0x${string}`): Promise<boolean> }, "hasStoredGrant", async () => false);
  mock.method(store, "tenantForAccount", async () => null);
  mock.method(store, "get", async () => stored);
  mock.method(store, "put", async (_t: unknown, g: unknown) => {
    puts.push(g);
  });
  ({ POST } = await import("./route"));
});
after(() => {
  custody.setVenueFlatnessForTest(null);
  mock.restoreAll();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
beforeEach(() => {
  puts.length = 0;
  flatAsked.length = 0;
});

function storedPerpGrant(account: `0x${string}`): StoredGrant {
  return {
    smartAccount: account,
    owner: "0x00000000000000000000000000000000000000e5",
    sessionKeyAddress: "0x00000000000000000000000000000000000000f6",
    serialized: "eyJ-stored",
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 20, maxOpsPerDay: 100 },
    grantedAt: 1_790_000_000,
    expiresAt: 1_791_209_600,
    chainId: CHAIN,
    grantFeatures: ["tradeable-v2", "perp-lighter-v1"],
    perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: pub(1), apiKeySealed: `pk1.${"A".repeat(16)}.${"B".repeat(22)}.${"C".repeat(110)}` },
    demoSessionPrivateKey: `0x${"cd".repeat(32)}`,
  };
}

/** A hosted claim from an app build that knows nothing about perps. */
async function oldBuildClaim() {
  return claim();
}

/**
 * A hosted claim for SMART. With `rotateTo`, it is a perps grant sealing a
 * FRESH key — the public key plus a blob keygen would genuinely have issued to
 * this tenant and account — minted by the real signer with no previous grant
 * (the SDK path: prior "none", so it seals whatever it is given).
 */
async function claim(o: { rotateTo?: `0x${string}` } = {}) {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const nonce = auth.issueChallengeNonce(ORIGIN);
  const message = bindingMessage({ origin: ORIGIN, nonce, owner: owner.address, smartAccount: SMART, chainId: CHAIN });
  const perp = o.rotateTo
    ? {
        apiPublicKey: o.rotateTo,
        apiKeySealed: sealPerpKey(PRIV2, { tenant: wallet.address, smartAccount: SMART, apiPublicKey: o.rotateTo, apiKeyIndex: 16 }, DEK),
      }
    : undefined;
  const { grant: signed } = await signerGrant({ account: SMART, owner, perp });
  const grant = {
    ...signed,
    binding: { nonce, walletSignature: await wallet.signMessage({ message }), ownerSignature: await owner.signMessage({ message }) },
  };
  return new Request(`${ORIGIN}/api/grants`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(wallet.address)}` },
    body: JSON.stringify(grant),
  });
}

for (const [label, account] of [
  ["the same account, re-signed without perps", SMART],
  ["a new account replacing a perps agent", OTHER],
] as const) {
  it(`${label}: the venue NOT FLAT → 409, and nothing is stored`, async () => {
    stored = storedPerpGrant(account);
    flatAnswer = { flat: false, detail: "account 22149: 1 open position (BTC-PERP)" };
    const res = await POST(await oldBuildClaim());
    const body = (await res.json()) as { error?: string; code?: string };
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.code, "perp-venue-not-flat");
    assert.equal(body.error, custody.PERP_NOT_FLAT_MESSAGE);
    assert.deepEqual(flatAsked, [account], "the STORED account is the one read");
    assert.equal(puts.length, 0);
  });

  it(`${label}: the venue UNREAD → 409 too`, async () => {
    stored = storedPerpGrant(account);
    flatAnswer = { flat: null, detail: "rate-limited" };
    const res = await POST(await oldBuildClaim());
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, "perp-venue-unread");
    assert.equal(puts.length, 0);
  });

  it(`${label}: the venue PROVABLY FLAT → the claim goes on (to the derivation check)`, async () => {
    stored = storedPerpGrant(account);
    flatAnswer = { flat: true };
    const fetch = mock.method(globalThis, "fetch", async () => {
      throw new Error("no chain in this test");
    });
    try {
      const res = await POST(await oldBuildClaim());
      assert.notEqual(res.status, 409, "flat is not refused");
      assert.deepEqual(flatAsked, [account]);
    } finally {
      fetch.mock.restore();
    }
  });
}

it("a stored grant WITHOUT perps never asks the venue", async () => {
  stored = { ...storedPerpGrant(SMART), grantFeatures: ["tradeable-v2"], perp: undefined };
  flatAnswer = { flat: false, detail: "x" };
  const fetch = mock.method(globalThis, "fetch", async () => {
    throw new Error("no chain in this test");
  });
  try {
    const res = await POST(await oldBuildClaim());
    assert.notEqual(res.status, 409);
    assert.deepEqual(flatAsked, []);
  } finally {
    fetch.mock.restore();
  }
});

// A KEY CHANGE on the same account lets go of the REGISTERED key just as a drop
// does: it stays valid at index 16 until a changePubKey for the new one lands
// (21126 can refuse it outright), while the store's put overwrites the only
// sealed copy of the old one. The signers refuse it (`perp-key-changed`); this
// is the door a caller that is not one of them — the SDK with no previous
// grant, a hand-built POST, a replayed older blob — would otherwise walk through.
it("a ROTATION to a fresh, genuinely-issued key: the venue NOT FLAT → 409, and nothing is stored", async () => {
  stored = storedPerpGrant(SMART);
  flatAnswer = { flat: false, detail: "account 22149: 2 open positions" };
  const res = await POST(await claim({ rotateTo: pub(2) }));
  const body = (await res.json()) as { error?: string; code?: string };
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, "perp-venue-not-flat");
  assert.equal(body.error, custody.PERP_NOT_FLAT_MESSAGE);
  assert.deepEqual(flatAsked, [SMART], "the stored account's venue is what is read");
  assert.equal(puts.length, 0, "the stored key's only sealed copy is not overwritten");
});

it("a ROTATION with the venue UNREAD → 409 too", async () => {
  stored = storedPerpGrant(SMART);
  flatAnswer = { flat: null, detail: "rate-limited" };
  const res = await POST(await claim({ rotateTo: pub(2) }));
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code?: string }).code, "perp-venue-unread");
  assert.equal(puts.length, 0);
});

it("a ROTATION on a PROVABLY FLAT venue → the claim goes on (to the derivation check)", async () => {
  stored = storedPerpGrant(SMART);
  flatAnswer = { flat: true };
  const fetch = mock.method(globalThis, "fetch", async () => {
    throw new Error("no chain in this test");
  });
  try {
    const res = await POST(await claim({ rotateTo: pub(2) }));
    assert.notEqual(res.status, 409, "flat is not refused");
    assert.deepEqual(flatAsked, [SMART]);
  } finally {
    fetch.mock.restore();
  }
});

it("a ROTATION where the operator does not offer perps (the hosted default): 403 perp-not-offered, nothing read or stored", async () => {
  stored = storedPerpGrant(SMART);
  flatAnswer = { flat: true };
  delete process.env.MERRYMEN_PERPS;
  try {
    const res = await POST(await claim({ rotateTo: pub(2) }));
    const body = (await res.json()) as { code?: string };
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal(body.code, "perp-not-offered");
    assert.deepEqual(flatAsked, []);
    assert.equal(puts.length, 0);
  } finally {
    process.env.MERRYMEN_PERPS = "live";
  }
});
