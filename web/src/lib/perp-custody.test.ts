/**
 * THE SERVER'S HALF OF RULE 5, UNIT BY UNIT (lib/perp-custody.ts).
 *
 *   acceptIncomingPerp  hosted: the sealed key must open for THIS tenant,
 *                       account and public key — or be carried forward from
 *                       the stored grant with an equal public key; self-hosted:
 *                       the key file must exist and pair. Everywhere: no
 *                       plaintext key, marker and block together, no stray
 *                       fields in the block.
 *   dropsVenueKey /     the 409: only when the stored grant carries perps and
 *   perpDropRefusal     the new one drops the block, names another account or
 *                       names another key (a rotation strands the registered one);
 *                       `null` and a throwing reader refuse like `false`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { StoredGrant } from "@merrymen/core";
import { sealPerpKey } from "../../../worker/src/perps/key-seal";
import { writePerpKeyFile } from "../../../worker/src/perps/keystore";
import {
  acceptIncomingPerp,
  dropsVenueKey,
  PERP_NOT_FLAT_MESSAGE,
  perpDropRefusal,
  perpsOptInOffered,
  perRouteLimiter,
  type FlatnessReader,
} from "./perp-custody";

const HOME = mkdtempSync(path.join(tmpdir(), "mm-perp-custody-"));
after(() => rmSync(HOME, { recursive: true, force: true }));

const DEK = Buffer.alloc(32, 7);
const TENANT = "0x00000000000000000000000000000000000000aa" as const;
const OTHER_TENANT = "0x00000000000000000000000000000000000000bb" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000a1" as const;
const OTHER_ACCOUNT = "0x00000000000000000000000000000000000000a2" as const;
const pub = (b: number) => `0x${(b.toString(16).padStart(2, "0") + "00".repeat(7)).repeat(5)}` as `0x${string}`;
const PRIV = `0x${"ab".repeat(40)}` as `0x${string}`;
const seal = (o: { tenant?: string; account?: string; pub?: `0x${string}` } = {}) =>
  sealPerpKey(PRIV, { tenant: o.tenant ?? TENANT, smartAccount: o.account ?? ACCOUNT, apiPublicKey: o.pub ?? pub(1), apiKeyIndex: 16 }, DEK);

function grant(o: { account?: string; perp?: Record<string, unknown> | null; marker?: boolean; extra?: Record<string, unknown> } = {}): StoredGrant {
  const marker = o.marker ?? o.perp !== null;
  return {
    smartAccount: (o.account ?? ACCOUNT) as `0x${string}`,
    owner: "0x00000000000000000000000000000000000000e5",
    sessionKeyAddress: "0x00000000000000000000000000000000000000f6",
    serialized: "eyJ-blob",
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 20, maxOpsPerDay: 100 },
    grantedAt: 1,
    expiresAt: 2,
    chainId: 4663,
    grantFeatures: marker ? ["tradeable-v2", "perp-lighter-v1"] : ["tradeable-v2"],
    ...(o.perp === null ? {} : { perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: pub(1), ...(o.perp ?? {}) } }),
    demoSessionPrivateKey: `0x${"cd".repeat(32)}`,
    ...o.extra,
  } as StoredGrant;
}

const hosted = (incoming: StoredGrant, stored: StoredGrant | null = null, over: Partial<Parameters<typeof acceptIncomingPerp>[0]> = {}) =>
  acceptIncomingPerp({ hosted: true, tenant: TENANT, incoming, stored, dek: DEK, home: HOME, perpsOffered: true, ...over });

function refused(r: ReturnType<typeof acceptIncomingPerp>, status: number, code: string) {
  assert.equal(r.ok, false, "expected a refusal");
  if (r.ok) return;
  assert.equal(r.refusal.status, status, r.refusal.error);
  assert.equal(r.refusal.code, code);
  assert.ok(!r.refusal.error.includes(PRIV.slice(2, 20)), "no key material in a refusal");
}

describe("acceptIncomingPerp — hosted", () => {
  it("a grant without perps passes untouched", () => {
    const g = grant({ perp: null });
    const r = hosted(g);
    assert.ok(r.ok);
    assert.equal(r.ok && r.grant, g);
  });

  it("a sealed key issued for this tenant, account and key is accepted as sent", () => {
    const g = grant({ perp: { apiKeySealed: seal() } });
    const r = hosted(g);
    assert.ok(r.ok);
    assert.equal(r.ok && r.grant, g);
  });

  it("a sealed key issued to anyone else is refused by name", () => {
    refused(hosted(grant({ perp: { apiKeySealed: seal({ tenant: OTHER_TENANT }) } })), 400, "perp-key-not-yours");
    refused(hosted(grant({ perp: { apiKeySealed: seal({ account: OTHER_ACCOUNT }) } })), 400, "perp-key-not-yours");
    refused(hosted(grant({ perp: { apiKeySealed: seal({ pub: pub(2) }) } })), 400, "perp-key-not-yours");
    refused(hosted(grant({ perp: { apiKeySealed: "not-a-blob" } })), 400, "perp-key-not-yours");
  });

  it("CARRY-FORWARD: no blob, the stored grant for the same account has the same key — its blob is re-attached", () => {
    const storedBlob = seal();
    const stored = grant({ perp: { apiKeySealed: storedBlob } });
    const r = hosted(grant(), stored);
    assert.ok(r.ok);
    assert.equal(r.ok && (r.grant.perp as { apiKeySealed?: string }).apiKeySealed, storedBlob);
    // Case of the public key does not matter; the canonical key is compared.
    const upper = grant({ perp: { apiPublicKey: pub(1).toUpperCase().replace("0X", "0x") } });
    assert.ok(hosted(upper, stored).ok);
  });

  it("no blob and nothing to carry forward — another key, another account, or no stored grant — is refused", () => {
    const stored = grant({ perp: { apiKeySealed: seal() } });
    refused(hosted(grant({ perp: { apiPublicKey: pub(2) } }), stored), 400, "perp-key-missing");
    refused(hosted(grant({ account: OTHER_ACCOUNT }), stored), 400, "perp-key-missing");
    refused(hosted(grant(), null), 400, "perp-key-missing");
    // A stored blob that does not open for THIS tenant is not carried forward.
    refused(hosted(grant(), grant({ perp: { apiKeySealed: seal({ tenant: OTHER_TENANT }) } })), 400, "perp-key-missing");
  });

  it("no DEK: 503, nothing accepted", () => {
    refused(hosted(grant({ perp: { apiKeySealed: seal() } }), null, { dek: null }), 503, "perp-key-store-unavailable");
  });

  it("a plaintext private key anywhere is 422 — including in a grant with no perps", () => {
    refused(hosted(grant({ perp: { apiPrivateKey: PRIV } })), 422, "perp-private-key-forbidden");
    refused(hosted(grant({ perp: null, extra: { memo: PRIV.slice(2).toUpperCase() } })), 422, "perp-private-key-forbidden");
  });

  it("the marker and the block come together; the block has only its four fields", () => {
    refused(hosted(grant({ marker: false, perp: { apiKeySealed: seal() } })), 400, "perp-block-malformed");
    refused(hosted(grant({ perp: null, marker: true })), 400, "perp-block-malformed");
    refused(hosted(grant({ perp: { apiKeyIndex: 3 } })), 400, "perp-block-malformed");
    refused(hosted(grant({ perp: { apiPublicKey: `0x${"ff".repeat(40)}` } })), 400, "perp-block-malformed");
    refused(hosted(grant({ extra: { chainId: 46630 } })), 400, "perp-block-malformed");
    refused(hosted(grant({ perp: { apiKeySealed: seal(), note: "hi" } })), 400, "perp-block-fields");
  });
});

describe("acceptIncomingPerp — self-hosted", () => {
  const self = (incoming: StoredGrant, home = HOME) => acceptIncomingPerp({ hosted: false, tenant: null, incoming, stored: null, dek: null, home, perpsOffered: true });

  it("the key file for the sealed public key must exist and pair", () => {
    const h = mkdtempSync(path.join(HOME, "self-"));
    refused(self(grant(), h), 400, "perp-key-missing");
    writePerpKeyFile(h, { privateKey: PRIV, publicKey: pub(1) });
    assert.ok(self(grant(), h).ok);
    refused(self(grant({ perp: { apiPublicKey: pub(2) } }), h), 400, "perp-key-missing");
  });

  it("a sealed blob has no business in a self-hosted grant", () => {
    refused(self(grant({ perp: { apiKeySealed: seal() } })), 400, "perp-key-sealed-self-hosted");
  });
});

describe("a NEW opt-in is the operator's to offer; a carry-forward never is", () => {
  it("not offered: a fresh sealed key, a self-hosted key file, a rotation — all 403 perp-not-offered", () => {
    refused(hosted(grant({ perp: { apiKeySealed: seal() } }), null, { perpsOffered: false }), 403, "perp-not-offered");
    const stored = grant({ perp: { apiKeySealed: seal() } });
    refused(hosted(grant({ perp: { apiPublicKey: pub(2), apiKeySealed: seal({ pub: pub(2) }) } }), stored, { perpsOffered: false }), 403, "perp-not-offered");
    // Another account's stored key is not this account's carry-forward.
    refused(hosted(grant({ account: OTHER_ACCOUNT, perp: { apiKeySealed: seal({ account: OTHER_ACCOUNT }) } }), stored, { perpsOffered: false }), 403, "perp-not-offered");
    const h = mkdtempSync(path.join(HOME, "self-offer-"));
    writePerpKeyFile(h, { privateKey: PRIV, publicKey: pub(1) });
    refused(acceptIncomingPerp({ hosted: false, tenant: null, incoming: grant(), stored: null, dek: null, home: h, perpsOffered: false }), 403, "perp-not-offered");
  });

  it("not offered: the stored key carried forward on the same account is accepted, blob re-attached", () => {
    const storedBlob = seal();
    const r = hosted(grant(), grant({ perp: { apiKeySealed: storedBlob } }), { perpsOffered: false });
    assert.ok(r.ok);
    assert.equal(r.ok && (r.grant.perp as { apiKeySealed?: string }).apiKeySealed, storedBlob);
    // …and with the stored blob sent back, too.
    assert.ok(hosted(grant({ perp: { apiKeySealed: storedBlob } }), grant({ perp: { apiKeySealed: storedBlob } }), { perpsOffered: false }).ok);
  });

  it("not offered changes nothing for a grant without perps", () => {
    assert.ok(hosted(grant({ perp: null }), null, { perpsOffered: false }).ok);
  });

  it("perpsOptInOffered: live only where the operator's ceiling for THIS account is live", () => {
    const saved = process.env.MERRYMEN_HOSTED;
    try {
      const A = "0x00000000000000000000000000000000000000A1";
      process.env.MERRYMEN_HOSTED = "1";
      assert.equal(perpsOptInOffered(A, {}), false, "hosted default is paper: no opt-in (Rollout Phase 1)");
      assert.equal(perpsOptInOffered(A, { MERRYMEN_PERPS: "paper" }), false);
      assert.equal(perpsOptInOffered(A, { MERRYMEN_PERPS: "live" }), false, "hosted live with nobody allowlisted");
      assert.equal(perpsOptInOffered(A, { MERRYMEN_PERPS: "live", MERRYMEN_PERPS_LIVE_TENANTS: A.toLowerCase() }), true);
      assert.equal(perpsOptInOffered(OTHER_ACCOUNT, { MERRYMEN_PERPS: "live", MERRYMEN_PERPS_LIVE_TENANTS: A }), false, "another account is not on the list");
      assert.equal(perpsOptInOffered(null, { MERRYMEN_PERPS: "live", MERRYMEN_PERPS_LIVE_TENANTS: A }), false);
      delete process.env.MERRYMEN_HOSTED;
      assert.equal(perpsOptInOffered(A, {}), true, "self-hosted default is live: the owner is the operator");
      assert.equal(perpsOptInOffered(A, { MERRYMEN_PERPS: "off" }), false);
      assert.equal(perpsOptInOffered(A, { MERRYMEN_PERPS: "paper" }), false);
      assert.equal(perpsOptInOffered(A, { MERRYMEN_PERPS: "lvie" }), false, "a typo in a restrict-only lever is OFF");
    } finally {
      if (saved === undefined) delete process.env.MERRYMEN_HOSTED;
      else process.env.MERRYMEN_HOSTED = saved;
    }
  });
});

describe("the 409 — no path leaves a non-flat venue without its key", () => {
  const perpStored = grant({ perp: { apiKeySealed: seal() } });

  it("dropsVenueKey: only a stored perps grant, and only a drop, an account change or a key change", () => {
    assert.equal(dropsVenueKey(null, grant({ perp: null })), false);
    assert.equal(dropsVenueKey(grant({ perp: null }), grant({ perp: null, account: OTHER_ACCOUNT })), false);
    assert.equal(dropsVenueKey(perpStored, grant({ perp: null })), true, "same account, block dropped");
    assert.equal(dropsVenueKey(perpStored, grant({ account: OTHER_ACCOUNT })), true, "another account, even with perps");
    // A ROTATION lets go of the REGISTERED key: it stays valid at index 16 until
    // a changePubKey for the new one lands (which 21126 can refuse), while the
    // store and the child's perp-key.json keep only the new one.
    assert.equal(dropsVenueKey(perpStored, grant({ perp: { apiPublicKey: pub(2) } })), true, "a key change strands the registered key");
    assert.equal(dropsVenueKey(perpStored, grant({ perp: { apiPublicKey: pub(2), apiKeySealed: seal({ pub: pub(2) }) } })), true, "…with a fresh blob too");
    assert.equal(dropsVenueKey(perpStored, grant()), false, "a carry-forward keeps it");
    assert.equal(dropsVenueKey(perpStored, grant({ perp: { apiPublicKey: pub(1).toUpperCase().replace("0X", "0x") } })), false, "case is not a key change");
    assert.equal(dropsVenueKey(perpStored, grant({ perp: null, account: ACCOUNT.toUpperCase().replace("0X", "0x") })), true);
  });

  it("dropsVenueKey: a stored grant that CLAIMS perps but whose block does not read holds a key all the same", () => {
    const unreadable = grant({ perp: { apiKeyIndex: 3 } }); // marker present, block the worker would not honour
    assert.equal(dropsVenueKey(unreadable, grant({ perp: null })), true);
    assert.equal(dropsVenueKey(unreadable, grant()), true, "no key to compare with: any replacement lets go of it");
    // …and a stored grant with neither marker nor block holds nothing.
    assert.equal(dropsVenueKey(grant({ perp: null }), grant({ perp: { apiPublicKey: pub(2) } })), false);
  });

  it("a ROTATION on a venue that is not provably flat is the 409; on a flat one it is allowed", async () => {
    const asked: string[] = [];
    const rotated = grant({ perp: { apiPublicKey: pub(2), apiKeySealed: seal({ pub: pub(2) }) } });
    // The intake alone would accept it — the blob is genuinely this tenant's —
    // which is exactly why the 409 must cover it.
    assert.ok(hosted(rotated, perpStored).ok);
    const no = await perpDropRefusal({
      stored: perpStored,
      incoming: rotated,
      flatness: async (a) => (asked.push(a), { flat: false, detail: "account 1: 2 open positions" }),
    });
    assert.equal(no?.status, 409);
    assert.equal(no?.code, "perp-venue-not-flat");
    const unread = await perpDropRefusal({ stored: perpStored, incoming: rotated, flatness: async (a) => (asked.push(a), { flat: null, detail: "rate-limited" }) });
    assert.equal(unread?.code, "perp-venue-unread");
    assert.equal(await perpDropRefusal({ stored: perpStored, incoming: rotated, flatness: async (a) => (asked.push(a), { flat: true }) }), null);
    assert.deepEqual([...new Set(asked)], [ACCOUNT], "the stored account's venue is the one read");
  });

  it("flat: allowed; not flat: rule 5's sentence; unread or a throwing reader: refused all the same", async () => {
    const asked: string[] = [];
    const reader = (answer: Awaited<ReturnType<FlatnessReader>>): FlatnessReader => async (a) => {
      asked.push(a);
      return answer;
    };
    assert.equal(await perpDropRefusal({ stored: perpStored, incoming: grant({ perp: null }), flatness: reader({ flat: true }) }), null);
    const no = await perpDropRefusal({ stored: perpStored, incoming: grant({ perp: null, account: OTHER_ACCOUNT }), flatness: reader({ flat: false, detail: "account 1: 2 open positions" }) });
    assert.deepEqual(no, { status: 409, code: "perp-venue-not-flat", error: PERP_NOT_FLAT_MESSAGE, detail: "account 1: 2 open positions", flat: false });
    const unread = await perpDropRefusal({ stored: perpStored, incoming: grant({ perp: null }), flatness: reader({ flat: null, detail: "rate-limited" }) });
    assert.equal(unread?.status, 409);
    assert.equal(unread?.flat, null);
    assert.ok(unread?.error.includes(PERP_NOT_FLAT_MESSAGE));
    const threw = await perpDropRefusal({
      stored: perpStored,
      incoming: grant({ perp: null }),
      flatness: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(threw?.status, 409);
    // The STORED account is the one read — never the new one.
    assert.deepEqual([...new Set(asked)], [ACCOUNT]);
  });

  it("nothing is read when nothing is dropped", async () => {
    let calls = 0;
    const r = await perpDropRefusal({ stored: perpStored, incoming: grant(), flatness: async () => (calls++, { flat: false, detail: "x" }) });
    assert.equal(r, null);
    assert.equal(calls, 0);
  });
});

it("perRouteLimiter: N a minute per caller, then Retry-After", () => {
  let t = 1_000_000;
  const take = perRouteLimiter(2, () => t);
  assert.ok(take("a").ok);
  assert.ok(take("a").ok);
  const third = take("a");
  assert.equal(third.ok, false);
  assert.ok(!third.ok && third.retryAfterSec >= 1 && third.retryAfterSec <= 60);
  assert.ok(take("b").ok, "callers do not share a window");
  t += 60_001;
  assert.ok(take("a").ok, "the window rolls");
});
