/**
 * THE LIGHTER KEY AT REST (docs/perps.md rule 5), against a real temp
 * filesystem and the real FileGrantStore in hosted mode.
 *
 * A grant carries `perp = { route, apiKeyIndex, apiPublicKey, apiKeySealed? }`
 * and nothing else. What must hold where bytes hit disk:
 *   - the sealed blob may be stored (it is DEK ciphertext), and only if it
 *     opens for THIS tenant, account and public key;
 *   - no plaintext private key is ever stored — by field name or by shape —
 *     and a record that holds one anyway is refused on the way out and stops
 *     the boot scan;
 *   - hosted, a perp grant with no DEK, or with no sealed key, is refused.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-gstore-perp-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_HOSTED = "1";
const DEK_B64 = Buffer.alloc(32, 7).toString("base64");
process.env.MERRYMEN_STORE_DEK = DEK_B64;

const { FileGrantStore } = await import("./grant-store");
const { sealPerpKey } = await import("./perps/key-seal");
const { assertNoPerpKeysAtRest, carriesPerpPrivateKey } = await import("../../packages/core/src/index");

after(() => {
  delete process.env.MERRYMEN_HOSTED;
  rmSync(HOME, { recursive: true, force: true });
});

const DEK = Buffer.alloc(32, 7);
const ALICE = "0x00000000000000000000000000000000000000a1" as const;
const BOB = "0x00000000000000000000000000000000000000b2" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000c3" as const;
const OTHER_ACCOUNT = "0x00000000000000000000000000000000000000d4" as const;
const SESSION = ("0x" + "cd".repeat(32)) as `0x${string}`;
/** Canonical 40-byte public keys: five little-endian limbs, each small. */
const pub = (b: number) => `0x${(b.toString(16).padStart(2, "0") + "00".repeat(7)).repeat(5)}` as `0x${string}`;
const PRIV = `0x${"ab".repeat(40)}` as `0x${string}`;
const PUB = pub(1);

function perpGrant(over: { tenant?: string; account?: string; sealedFor?: { tenant: string; account: string; pub: string }; perp?: unknown; extra?: Record<string, unknown>; marker?: boolean } = {}): never {
  const account = over.account ?? ACCOUNT;
  const sealedFor = over.sealedFor ?? { tenant: over.tenant ?? ALICE, account, pub: PUB };
  const apiKeySealed = sealPerpKey(PRIV, { tenant: sealedFor.tenant, smartAccount: sealedFor.account, apiPublicKey: sealedFor.pub, apiKeyIndex: 16 }, DEK);
  return {
    smartAccount: account,
    owner: "0x00000000000000000000000000000000000000e5",
    sessionKeyAddress: "0x00000000000000000000000000000000000000f6",
    serialized: "eyJ-a-zerodev-blob",
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 20, maxOpsPerDay: 100 },
    grantedAt: 1_790_000_000,
    expiresAt: 1_791_209_600,
    chainId: 4663,
    grantFeatures: over.marker === false ? ["tradeable-v2"] : ["tradeable-v2", "perp-lighter-v1"],
    grantTokens: [],
    perp: over.perp === undefined ? { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: PUB, apiKeySealed } : over.perp,
    demoSessionPrivateKey: SESSION,
    ...over.extra,
  } as never;
}

const forms = (hex: string) => {
  const bare = hex.replace(/^0x/, "");
  return [`0x${bare}`, bare, bare.toUpperCase(), `0x${bare.toUpperCase()}`];
};

describe("carriesPerpPrivateKey — the one definition", () => {
  it("a clean perp grant passes: the public key where it belongs, a sealed blob, a 130-hex binding signature", () => {
    const g = perpGrant({ extra: { binding: { nonce: "n", ownerSignature: `0x${"12".repeat(65)}`, walletSignature: `0x${"34".repeat(65)}` } } });
    assert.equal(carriesPerpPrivateKey(g), false);
  });
  it("a field NAMED like a private key is caught at any depth, whatever it holds", () => {
    assert.equal(carriesPerpPrivateKey({ perp: { apiPrivateKey: "x" } }), true);
    assert.equal(carriesPerpPrivateKey({ a: { b: [{ privateKey: 1 }] } }), true);
    assert.equal(carriesPerpPrivateKey({ API_PRIVATE_KEY: "x" }), true);
    assert.equal(carriesPerpPrivateKey({ demoSessionPrivateKey: SESSION }), false, "the session key is carriesOwnerKey's business");
  });
  it("an 80-hex run anywhere but perp.apiPublicKey is caught, in every spelling", () => {
    for (const f of forms(PRIV)) {
      assert.equal(carriesPerpPrivateKey({ notes: f }), true, f);
      assert.equal(carriesPerpPrivateKey({ perp: { route: "perp-lighter-v1", apiPublicKey: PUB, memo: `key=${f};` } }), true, f);
    }
    // Exempt by POSITION, not by name: an apiPublicKey anywhere else is scanned.
    assert.equal(carriesPerpPrivateKey({ nested: { apiPublicKey: PUB } }), true);
    // A private key written INTO the public slot is the one thing shape cannot
    // see — which is why signers never hold the private half (rule 5).
    assert.equal(carriesPerpPrivateKey({ perp: { apiPublicKey: PRIV } }), false);
  });
  it("assertNoPerpKeysAtRest refuses in hosted mode, and is inert self-hosted", () => {
    assert.throws(() => assertNoPerpKeysAtRest([{ ok: true }, { perp: { apiPrivateKey: PRIV } }]), /1 stored grant/);
    process.env.MERRYMEN_HOSTED = "0";
    try {
      assert.doesNotThrow(() => assertNoPerpKeysAtRest([{ perp: { apiPrivateKey: PRIV } }]));
    } finally {
      process.env.MERRYMEN_HOSTED = "1";
    }
  });
});

describe("FileGrantStore, hosted, with a perp block", () => {
  const store = new FileGrantStore();
  const file = (t: string) => path.join(HOME, "tenants", `${t.toLowerCase()}.json`);

  it("stores a grant whose sealed key is THIS tenant's, and the file holds ciphertext, never the key", async () => {
    const g = perpGrant() as { perp: { apiKeySealed: string } };
    await store.put(ALICE, g as never);
    const raw = readFileSync(file(ALICE), "utf8");
    for (const f of forms(PRIV)) assert.ok(!raw.includes(f), `plaintext key on disk (${f.slice(0, 6)}…)`);
    assert.match(raw, /"apiKeySealed": "pk1\./);
    const back = await store.get(ALICE);
    assert.equal(back?.perp?.apiPublicKey, PUB);
    assert.equal(back?.perp?.apiKeySealed, g.perp.apiKeySealed, "the blob round-trips untouched");
    assert.equal(back?.demoSessionPrivateKey, SESSION);
  });

  it("REFUSES a sealed key issued to another tenant, another account or another public key", async () => {
    await assert.rejects(store.put(BOB, perpGrant({ tenant: BOB, sealedFor: { tenant: ALICE, account: ACCOUNT, pub: PUB } })), /not issued to this login/);
    await assert.rejects(store.put(ALICE, perpGrant({ sealedFor: { tenant: ALICE, account: OTHER_ACCOUNT, pub: PUB } })), /not issued to this login/);
    await assert.rejects(store.put(ALICE, perpGrant({ sealedFor: { tenant: ALICE, account: ACCOUNT, pub: pub(2) } })), /not issued to this login/);
  });

  it("REFUSES a hosted perp grant with no sealed key — the key the wall pins would be held nowhere", async () => {
    await assert.rejects(store.put(BOB, perpGrant({ tenant: BOB, perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: PUB } })), /without its sealed Lighter key/);
  });

  it("REFUSES a plaintext key, by name or by shape, wherever it hides", async () => {
    await assert.rejects(
      store.put(BOB, perpGrant({ tenant: BOB, perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: PUB, apiPrivateKey: PRIV } })),
      /plaintext Lighter API private key/,
    );
    for (const f of forms(PRIV)) {
      await assert.rejects(store.put(BOB, perpGrant({ tenant: BOB, extra: { memo: f } })), /plaintext Lighter API private key/);
    }
    await assert.rejects(store.put(BOB, perpGrant({ tenant: BOB, extra: { x: { privateKey: "anything" } } })), /plaintext Lighter API private key/);
    // And even with no perp block at all.
    await assert.rejects(store.put(BOB, perpGrant({ tenant: BOB, marker: false, perp: null, extra: { perp: undefined, leaked: PRIV } })), /plaintext Lighter API private key/);
  });

  it("REFUSES a marker without its block, and a block without its marker", async () => {
    await assert.rejects(store.put(BOB, perpGrant({ tenant: BOB, extra: { perp: undefined } })), /marker and perp block disagree/);
    await assert.rejects(store.put(BOB, perpGrant({ tenant: BOB, marker: false })), /marker and perp block disagree/);
  });

  it("REFUSES a hosted perp grant when there is no DEK", async () => {
    const g = perpGrant({ tenant: BOB });
    delete process.env.MERRYMEN_STORE_DEK;
    try {
      await assert.rejects(store.put(BOB, g), /MERRYMEN_STORE_DEK is not set/);
    } finally {
      process.env.MERRYMEN_STORE_DEK = DEK_B64;
    }
  });

  it("a record that reached disk holding a plaintext key anyway is refused on the way out, and stops the boot scan", async () => {
    const dirty = path.join(HOME, "tenants", `${BOB}.json`);
    mkdirSync(path.dirname(dirty), { recursive: true });
    writeFileSync(
      dirty,
      JSON.stringify({ tenant: BOB, chainId: 4663, grant: { smartAccount: OTHER_ACCOUNT, perp: { apiPrivateKey: PRIV } }, sealedSessionKey: "x", updatedAt: 1 }),
    );
    try {
      assert.equal(await new FileGrantStore().get(BOB), null, "never handed to a child");
      await assert.rejects(new FileGrantStore().listTenants(), /plaintext Lighter API private key/);
      await assert.rejects(new FileGrantStore().put(ALICE, perpGrant()), /plaintext Lighter API private key/);
    } finally {
      rmSync(dirty, { force: true });
    }
    // Once purged, the store comes up.
    assert.ok((await new FileGrantStore().listTenants()).includes(ALICE));
  });
});
