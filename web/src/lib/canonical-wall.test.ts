import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as core from "@merrymen/core";
import {
  GRANT_TRANSFER,
  WITHDRAWAL_ALLOWLIST_LANDED_AT,
  grantHasTransfer,
  type StoredGrant,
} from "@merrymen/core";
import { CANONICAL_GRANT_FEATURES, checkCanonicalWall } from "./canonical-wall";
import { CLASS_FACTORY, CLASS_VAULT, TRENCHER_FACTORY, TRENCHER_VAULT, resealed, signerGrant } from "./canonical-wall-fixture";

/**
 * THE SERVER STORES THE MERRYMEN WALL, AND NOTHING ELSE.
 *
 * Every grant here is built by the real packages. The ones that pass come out of
 * web/src/lib/session.ts prepareAgentGrant — the signer the dashboard, the iOS
 * engine and sdk/browser.ts all go through. The ones that fail are what a tenant
 * holding their own owner key can build instead: a permission the owner really
 * enabled and the chain would really install, carrying a power the canonical
 * wall does not — a USDG transfer, the Rialto target, the v4 UniversalRouter —
 * or metadata that tells the worker's mirror something the wall does not say.
 */

const ACCOUNT = "0x00000000000000000000000000000000000a11ce" as const;
const ATTACKER = "0x000000000000000000000000000000000000bad1" as const;
const V4_ADAPTER = "0x0000000000000000000000000000000000000a4a" as const;
const PONS_ADAPTER = "0x0000000000000000000000000000000000000b0b" as const;
const EXTRA = { symbol: "CATE", address: "0x0000000000000000000000000000000000ca7e00" as const, decimals: 18 };

const verdict = (g: unknown) => checkCanonicalWall(g as Record<string, unknown>);
const refusedWith = (g: unknown, code: string) => {
  const v = verdict(g);
  assert.equal(v.ok, false, "expected a refusal");
  if (!v.ok) assert.equal(v.code, code, v.why);
  return v;
};

const decode = (g: StoredGrant) => JSON.parse(Buffer.from(g.serialized, "base64").toString("utf8"));
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

describe("grants from the real signer pass", () => {
  it("the default mint — official listings and the platform class vault", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT });
    assert.deepEqual(verdict(grant), { ok: true });
    // The fixture must have exercised the class route, or this proves less than it says.
    assert.ok(grant.grantFeatures?.includes("pons-class"), "the platform class factory should be sealed by default");
    assert.equal(grant.ponsClassVaultAddress, CLASS_VAULT);
    assert.equal(grant.ponsClassVaultFactoryAddress, CLASS_FACTORY);
  });

  it("the opt-ins — a custom token with Trencher scope, and both adapters — and between them every accepted marker", async () => {
    // Two grants, not one: all of them at once is a wall the signer itself
    // refuses as too large to install (wallSignable), so no owner can hold it.
    const { grant: trench } = await signerGrant({ account: ACCOUNT, extraTokens: [EXTRA], trencher: true });
    assert.deepEqual(verdict(trench), { ok: true });
    assert.equal(trench.trencherVaultAddress, TRENCHER_VAULT);
    assert.equal(trench.trencherFactoryAddress, TRENCHER_FACTORY);
    assert.ok(trench.grantTokens?.includes(EXTRA.address));

    const { grant: adapters } = await signerGrant({ account: ACCOUNT, v4AdapterAddress: V4_ADAPTER, ponsAdapterAddress: PONS_ADAPTER });
    assert.deepEqual(verdict(adapters), { ok: true });

    const minted = new Set([...(trench.grantFeatures ?? []), ...(adapters.grantFeatures ?? [])]);
    assert.deepEqual([...minted].sort(), [...CANONICAL_GRANT_FEATURES].sort());
  });

  it("hosted delivery adds a binding beside the grant, which this check leaves to verifyGrantBinding", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT });
    const hosted = { ...grant, binding: { nonce: "n", walletSignature: `0x${"11".repeat(65)}`, ownerSignature: `0x${"22".repeat(65)}` } };
    assert.deepEqual(verdict(hosted), { ok: true });
  });

  it("re-sealing the SAME wall passes too, so every refusal below is the change and not the sealing", async () => {
    const { grant, owner } = await signerGrant({ account: ACCOUNT, trencher: true });
    assert.deepEqual(verdict(await resealed(grant, owner)), { ok: true });
  });
});

describe("an owner-enabled permission that is not the Merrymen wall is refused", () => {
  it("an extra USDG transfer permission", async () => {
    const { grant, owner } = await signerGrant({ account: ACCOUNT });
    const drained = await resealed(grant, owner, { withdrawalAddresses: [ATTACKER] });
    const v = refusedWith(drained, "invalid_wall");
    assert.match(v.ok ? "" : v.why, /does not implement/);
  });

  it("the transfer marker, even over a wall dated to when the mirror would honour it", async () => {
    // The mirror-only attack: grantHasTransfer believes any "transfer" marker on
    // a grant dated before the withdrawal allowlist, and reads it as a transfer
    // to ANY recipient. The date is in the signed timestamp policy, so the
    // tenant re-seals the canonical wall at that date and adds the marker.
    const { grant, owner } = await signerGrant({ account: ACCOUNT });
    const backdated = await resealed(grant, owner, { now: WITHDRAWAL_ALLOWLIST_LANDED_AT - 86_400, caps: { ...grant.caps, expiryDays: 365 } });
    const marked = { ...backdated, caps: { ...grant.caps, expiryDays: 365 }, grantFeatures: [...(grant.grantFeatures ?? []), GRANT_TRANSFER] };
    assert.equal(grantHasTransfer(marked), true, "the premise: this is what the worker would believe");
    const v = refusedWith(marked, "invalid_grant");
    assert.match(v.ok ? "" : v.why, /"transfer"/);
    // And with a real transfer permission underneath, the same refusal.
    const both = await resealed(marked, owner, { withdrawalAddresses: [ATTACKER] });
    refusedWith(both, "invalid_grant");
  });

  it("the Rialto target, declared or not", async () => {
    const { grant, owner } = await signerGrant({ account: ACCOUNT });
    const rialto = await resealed(grant, owner, { allowRialto: true });
    refusedWith(rialto, "invalid_wall");
    refusedWith({ ...rialto, grantFeatures: [...(grant.grantFeatures ?? []), "rialto"] }, "invalid_grant");
  });

  it("the v4 Permit2 + UniversalRouter pair, declared or not", async () => {
    const { grant, owner } = await signerGrant({ account: ACCOUNT });
    const router = await resealed(grant, owner, { allowUniswapV4: true });
    refusedWith(router, "invalid_wall");
    refusedWith({ ...router, grantFeatures: [...(grant.grantFeatures ?? []), "v4"] }, "invalid_grant");
  });

  it("retired and unknown markers, over an otherwise canonical wall", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT });
    for (const marker of ["multihop", "v4", "rialto", "transfer", "anything"]) {
      refusedWith({ ...grant, grantFeatures: [...(grant.grantFeatures ?? []), marker] }, "invalid_grant");
    }
    refusedWith({ ...grant, grantFeatures: (grant.grantFeatures ?? []).filter((f) => f !== "tradeable-v2") }, "invalid_grant");
    refusedWith({ ...grant, grantFeatures: undefined }, "invalid_grant");
  });

  it("token metadata that disagrees with the wall, in either direction", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT, extraTokens: [EXTRA] });
    // Wider than the wall: the mirror would call a token sellable that the key cannot approve.
    refusedWith({ ...grant, grantTokens: [...(grant.grantTokens ?? []), ATTACKER] }, "invalid_wall");
    // Narrower than the wall: the wall carries an approve the metadata hides.
    refusedWith({ ...grant, grantTokens: (grant.grantTokens ?? []).filter((a) => a !== EXTRA.address) }, "invalid_wall");
  });

  it("a sealed address without its marker, or a marker without its address", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT, ponsAdapterAddress: PONS_ADAPTER, trencher: true });
    const { ponsAdapterAddress: _p, ...noAdapter } = grant;
    void _p;
    refusedWith(noAdapter, "invalid_grant");
    refusedWith({ ...grant, grantFeatures: (grant.grantFeatures ?? []).filter((f) => f !== "trencher-vault-v1") }, "invalid_grant");
    // Pointed at a different adapter than the one the wall was sealed with.
    refusedWith({ ...grant, ponsAdapterAddress: ATTACKER }, "invalid_wall");
  });

  it("start or expiry edited beside a signature that says otherwise", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT });
    refusedWith({ ...grant, grantedAt: WITHDRAWAL_ALLOWLIST_LANDED_AT - 1 }, "invalid_grant");
    refusedWith({ ...grant, expiresAt: grant.expiresAt + 86_400 }, "invalid_grant");
    refusedWith({ ...grant, caps: { ...grant.caps, perTradeUsdg: grant.caps.perTradeUsdg * 10 } }, "invalid_wall");
  });

  it("an owner key hidden inside the serialized permission", async () => {
    const ownerKey = generatePrivateKey();
    const { grant } = await signerGrant({ account: ACCOUNT, owner: privateKeyToAccount(ownerKey) });
    const params = decode(grant);
    params.action.hidden = ownerKey;
    refusedWith({ ...grant, serialized: encode(params) }, "owner_key_forbidden");
  });

  it("the owner key handed over as though it were the session key", async () => {
    // The one place both owner-key scans look away from: the session key field.
    const ownerKey = generatePrivateKey();
    const owner = privateKeyToAccount(ownerKey);
    const { grant } = await signerGrant({ account: ACCOUNT, owner });
    refusedWith(await resealed(grant, owner, {}, ownerKey), "owner_key_forbidden");
  });

  it("a different session key inside the permission than the one handed to the server", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT });
    refusedWith({ ...grant, demoSessionPrivateKey: generatePrivateKey() }, "invalid_grant");
  });

  it("anything unreadable, without throwing", () => {
    for (const g of [{}, { serialized: "not-a-permission-account" }, { owner: ATTACKER, smartAccount: ACCOUNT, caps: {}, grantedAt: 1, expiresAt: 2, serialized: "e30=" }]) {
      assert.equal(verdict(g).ok, false);
    }
  });
});

describe("the accepted markers are exactly what the signers can mint", () => {
  // Source scans, in the idiom of wall-policy-lockstep.test.ts: the failure this
  // guards is DRIFT. A signer that starts minting a marker, or passing a wall
  // option, that this check does not model would have every new hosted grant
  // refused in production — so it fails here first.
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const SIGNERS = {
    "web signer": "./session.ts",
    "mobile signer": "../../../mobile/src/crypto/signGrant.ts",
  } as const;
  const exported = core as unknown as Record<string, unknown>;

  for (const [who, path] of Object.entries(SIGNERS)) {
    it(`${who}: every minted marker is accepted, and v4 stays pinned off`, () => {
      const src = strip(read(path));
      const block = /grantFeatures:\s*\[([\s\S]*?)\],/.exec(src);
      assert.ok(block, `${who} must still build grantFeatures as an array literal`);
      const names = [...new Set([...block[1].matchAll(/\b(TRADEABLE_V2|GRANT_[A-Z0-9_]+)\b/g)].map((m) => m[1]))];
      assert.ok(names.length > 0);
      for (const name of names) {
        const marker = exported[name];
        assert.equal(typeof marker, "string", `${name} must be a core export`);
        if (name === "GRANT_V4") {
          assert.match(src, /const allowUniswapV4: boolean = false;/, `${who} mints GRANT_V4 only behind allowUniswapV4, which must stay false`);
          continue;
        }
        assert.ok(CANONICAL_GRANT_FEATURES.includes(marker as string), `${who} mints ${name} (${String(marker)}), which the server would refuse`);
      }
    });

    it(`${who}: every wall option it passes is one the rebuild models`, () => {
      const src = strip(read(path));
      const block = /const wallOpts = \{([\s\S]*?)\};/.exec(src);
      assert.ok(block, `${who} must still collect its wall options in one literal`);
      const keys = [...block[1].matchAll(/(?:^|,)\s*(?:\.\.\.)?([A-Za-z0-9_]+)\s*(?=[:,]|$)/g)].map((m) => m[1]);
      assert.ok(keys.includes("allowUniswapV4") && keys.includes("extraTokens"), `${who}: the key scan must see the options it is checking`);
      const modelled = new Set([
        "trenchScope",
        "extraTokens",
        "allowUniswapV4",
        "v4AdapterAddress",
        "ponsAdapterAddress",
        "ponsClassVaultAddress",
        "ponsClassVaultFactoryAddress",
      ]);
      for (const key of keys) assert.ok(modelled.has(key), `${who} passes ${key} to the wall, which canonical-wall.ts does not rebuild`);
      assert.doesNotMatch(block[1], /withdrawalAddresses|allowRialto/, `${who} must not widen the wall with a transfer or Rialto`);
    });
  }
});
