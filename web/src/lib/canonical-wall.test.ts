import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as core from "@merrymen/core";
import {
  ENERGY_ROUTE_V1,
  GRANT_ENERGY,
  GRANT_PERP_LIGHTER,
  GRANT_TRANSFER,
  LIGHTER_ROUTE_V1,
  WITHDRAWAL_ALLOWLIST_LANDED_AT,
  grantEnergyRoute,
  grantHasTransfer,
  grantPerp,
  type StoredGrant,
} from "@merrymen/core";
import { CANONICAL_GRANT_FEATURES, checkCanonicalWall } from "./canonical-wall";
import { CallPolicyVersion, toCallPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { CLASS_FACTORY, CLASS_VAULT, TRENCHER_FACTORY, TRENCHER_VAULT, resealed, sealWall, signerGrant } from "./canonical-wall-fixture";

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
/** Two canonical Lighter API public keys (five little-endian limbs, each below p, not all zero). */
const PERP_KEY = `0x${"1a".repeat(40)}` as `0x${string}`;
const OTHER_PERP_KEY = `0x${"2b".repeat(40)}` as `0x${string}`;

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
    // THE ENERGY BUY rides on the default mint: mainnet, and a class-only wall
    // with no custom tokens has room for it even while paying for deployment.
    assert.ok(grant.grantFeatures?.includes(GRANT_ENERGY), "the default mainnet wall has room for the energy buy");
    assert.equal(grantEnergyRoute(grant), ENERGY_ROUTE_V1, "and the worker would read the route off it");
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

    // NEITHER carries the energy buy, and legitimately: a class+Trencher wall
    // with a token, and a class wall with both adapters, have no room for it
    // on a first install. They sign exactly the wall they signed before it
    // existed — which is the point of sealing it only when it fits.
    assert.ok(!trench.grantFeatures?.includes(GRANT_ENERGY), "no room for the energy buy beside Trencher and a token");
    assert.ok(!adapters.grantFeatures?.includes(GRANT_ENERGY), "no room for the energy buy beside both adapters");

    // So the default mint is what carries GRANT_ENERGY into the union.
    const { grant: plain } = await signerGrant({ account: ACCOUNT });
    // And the perps opt-in is the fourth grant: on a first install the default
    // wall has room for it, with the energy buy giving way (perps are decided
    // first, and only the energy buy may be dropped).
    const { grant: perps } = await signerGrant({ account: ACCOUNT, perp: { apiPublicKey: PERP_KEY } });
    assert.deepEqual(verdict(perps), { ok: true });
    const minted = new Set([
      ...(trench.grantFeatures ?? []),
      ...(adapters.grantFeatures ?? []),
      ...(plain.grantFeatures ?? []),
      ...(perps.grantFeatures ?? []),
    ]);
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

  it("the energy marker and the energy permission, apart — in either direction", async () => {
    // Permission without its marker: the worker would never use it, and the
    // metadata would hide a power the wall grants.
    const { grant, owner } = await signerGrant({ account: ACCOUNT });
    assert.ok(grant.grantFeatures?.includes(GRANT_ENERGY), "premise: the default mint carries the energy buy");
    refusedWith({ ...grant, grantFeatures: (grant.grantFeatures ?? []).filter((f) => f !== GRANT_ENERGY) }, "invalid_wall");

    // Marker without its permission: the mirror would build a buy the chain
    // refuses. Once over a wall re-sealed WITHOUT the router, once over a grant
    // the signer minted without it (no room).
    const bare = await resealed(grant, owner, { energyBuy: false });
    refusedWith(bare, "invalid_wall");
    const { grant: full } = await signerGrant({ account: ACCOUNT, extraTokens: [EXTRA], trencher: true });
    assert.ok(!full.grantFeatures?.includes(GRANT_ENERGY), "premise: no room, no marker");
    refusedWith({ ...full, grantFeatures: [...(full.grantFeatures ?? []), GRANT_ENERGY] }, "invalid_wall");
  });

  it("the energy marker on any chain but mainnet, even over a wall that carries the permission", async () => {
    // The rebuild cannot see the chain, and the route is mainnet addresses: on
    // testnet the router is codeless and a buy would "land" buying nothing.
    const { grant } = await signerGrant({ account: ACCOUNT });
    const v = refusedWith({ ...grant, chainId: 46630 }, "invalid_grant");
    assert.match(v.ok ? "" : v.why, /only on Robinhood Chain mainnet/);
    refusedWith({ ...grant, chainId: undefined }, "invalid_grant");
    // And a testnet grant WITHOUT the marker is not this check's business.
    const { grant: full } = await signerGrant({ account: ACCOUNT, extraTokens: [EXTRA], trencher: true });
    assert.deepEqual(verdict({ ...full, chainId: 46630 }), { ok: true });
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

/**
 * PERPETUALS: A MARKER, A SEALED KEY AND FOUR PERMISSIONS, OR NONE OF THEM.
 *
 * The wall pins ONE Lighter API public key into `changePubKey`, so unlike the
 * energy buy the marker is not the whole permission — the grant's `perp` block
 * names the key, and the rebuild takes marker, chain and block together
 * (grantWallOptions → grantPerp). What a tenant holding the owner key could
 * build instead, each refused below: the key in the wall swapped for another,
 * the block or the marker alone, a key at another index or in another spelling,
 * a private key riding beside the public one, and all of it off mainnet.
 */
describe("perpetuals", () => {
  it("the dashboard's opt-in passes: marker, block and wall from one decision", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT, perp: { apiPublicKey: PERP_KEY } });
    assert.deepEqual(verdict(grant), { ok: true });
    assert.ok(grant.grantFeatures?.includes(GRANT_PERP_LIGHTER));
    assert.deepEqual(grant.perp, { route: GRANT_PERP_LIGHTER, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_KEY });
    assert.ok(grantPerp(grant), "and the worker's reader arms it");
    // The hosted sealed blob is opaque here — the route joins it to its key.
    const { grant: hosted } = await signerGrant({ account: ACCOUNT, perp: { apiPublicKey: PERP_KEY, apiKeySealed: "sealed-blob" } });
    assert.equal(hosted.perp?.apiKeySealed, "sealed-blob");
    assert.deepEqual(verdict(hosted), { ok: true });
  });

  it("a hand-built wall pinning a DIFFERENT key than grant.perp names is refused", async () => {
    // The attack the byte comparison exists for: the owner signs changePubKey
    // for a key they control while the metadata names the key the server holds.
    const { grant, owner } = await signerGrant({ account: ACCOUNT, perp: { apiPublicKey: PERP_KEY } });
    const swapped = await resealed(grant, owner, {
      perpLighter: { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: OTHER_PERP_KEY },
    });
    assert.equal(swapped.perp?.apiPublicKey, PERP_KEY, "premise: the metadata still names the signer's key");
    const v = refusedWith(swapped, "invalid_wall");
    assert.match(v.ok ? "" : v.why, /does not implement/);
    // And the mirror image: the block edited to name another key over the real wall.
    refusedWith({ ...grant, perp: { ...grant.perp!, apiPublicKey: OTHER_PERP_KEY } }, "invalid_wall");
  });

  it("the marker without the block, the block without the marker, and a perps wall declaring neither", async () => {
    const { grant, owner } = await signerGrant({ account: ACCOUNT, perp: { apiPublicKey: PERP_KEY } });
    const { perp: _perp, ...noBlock } = grant;
    void _perp;
    let v = refusedWith(noBlock, "invalid_grant");
    assert.match(v.ok ? "" : v.why, /Perpetuals metadata does not match/);
    v = refusedWith({ ...grant, grantFeatures: (grant.grantFeatures ?? []).filter((f) => f !== GRANT_PERP_LIGHTER) }, "invalid_grant");
    assert.match(v.ok ? "" : v.why, /Perpetuals metadata does not match/);
    // A block riding on a grant whose wall never had perps: the rebuild alone
    // would pass it (both sides narrow), so it must be refused by name.
    const { grant: plain } = await signerGrant({ account: ACCOUNT });
    refusedWith({ ...plain, perp: grant.perp }, "invalid_grant");
    // The four permissions sealed with neither marker nor block: metadata hides a power.
    const hidden = await resealed(plain, owner, {
      perpLighter: { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_KEY },
    });
    refusedWith(hidden, "invalid_wall");
  });

  it("a key at any index but the route's, a non-canonical key, or one spelled differently", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT, perp: { apiPublicKey: PERP_KEY } });
    const perp = grant.perp!;
    for (const apiKeyIndex of [0, 3, 157, 15, 17, 255, "16"]) {
      const v = refusedWith({ ...grant, perp: { ...perp, apiKeyIndex } }, "invalid_grant");
      assert.match(v.ok ? "" : v.why, /key index 16/);
    }
    // A limb at or above the Goldilocks prime (little-endian all-ones), all zero,
    // the wrong length, and the right key in capitals or without its 0x.
    for (const apiPublicKey of [
      `0x${"ff".repeat(40)}`,
      `0x${"00".repeat(40)}`,
      `0x${"1a".repeat(39)}`,
      `0x${"1a".repeat(40).toUpperCase()}`,
      "1a".repeat(40),
      42,
    ]) {
      const v = refusedWith({ ...grant, perp: { ...perp, apiPublicKey } }, "invalid_grant");
      assert.match(v.ok ? "" : v.why, /not a canonical Lighter API public key/);
      assert.ok(!(v.ok ? "" : v.why).toLowerCase().includes("1a1a1a1a"), "a refusal never echoes the key");
    }
    refusedWith({ ...grant, perp: { ...perp, route: "perp-lighter-v2" } }, "invalid_grant");
    for (const apiKeySealed of ["", 7, "x".repeat(4097)]) {
      refusedWith({ ...grant, perp: { ...perp, apiKeySealed } }, "invalid_grant");
    }
    refusedWith({ ...grant, perp: "perp-lighter-v1" }, "bad_request");
  });

  it("a private key riding beside the public one is refused, not stored", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT, perp: { apiPublicKey: PERP_KEY } });
    for (const extra of [{ apiPrivateKey: `0x${"33".repeat(40)}` }, { privateKey: `0x${"33".repeat(40)}` }, { note: "x" }]) {
      refusedWith({ ...grant, perp: { ...grant.perp!, ...extra } }, "bad_request");
    }
  });

  it("perps on any chain but mainnet, even over a wall that carries them", async () => {
    // There is no Lighter on the test network: the proxy is codeless there and a
    // deposit would "land" having posted nothing.
    const { grant } = await signerGrant({ account: ACCOUNT, perp: { apiPublicKey: PERP_KEY } });
    for (const chainId of [46630, undefined, "4663"]) {
      const v = refusedWith({ ...grant, chainId }, "invalid_grant");
      assert.match(v.ok ? "" : v.why, /only on Robinhood Chain mainnet/);
    }
  });
});

/**
 * A SIGNER FROM BEFORE ENERGY, WITH $MERRYMEN IN THE OWNER'S CUSTOM TOKENS.
 *
 * Before energy, an owner who wanted $MERRYMEN in view listed it as a custom
 * token, and the signer of the day sealed it like any other: an uncapped approve
 * and a place in `grantTokens`. Every current signer drops it (core wall.ts
 * usableExtraTokens), so the canonical rebuild never contains that approve and
 * the byte comparison fails — as "does not implement the advertised limits",
 * which tells an owner whose grant is running out nothing they can act on.
 *
 * THE LEGACY WALL IS REBUILT EXACTLY. Today's core cannot seal the reserve, so
 * the wall is built with a stand-in address where $MERRYMEN goes and the
 * stand-in is then replaced by $MERRYMEN in the permission data. That is byte
 * for byte what the base commit's buildWallPolicies sealed (checked against
 * 75995697's core, with the reserve first and last, with and without the class
 * vault): the old signer differed only in keeping the reserve. The control below
 * — the same construction without the reserve — passes, so the refusal is the
 * reserve and nothing about how the wall was sealed.
 */
describe("a grant from a signer that predates energy", () => {
  const MERRY = core.MERRYMEN_TOKEN.address;
  const STANDIN = "0x000000000000000000000000000000000000beef";
  const swap = (v: unknown): unknown =>
    typeof v === "string"
      ? v.toLowerCase() === STANDIN ? MERRY : v
      : Array.isArray(v)
        ? v.map(swap)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]))
          : v;

  /** What a pre-energy signer minted for these custom tokens: no energy marker, the reserve sealed like any extra. */
  async function preEnergyGrant(extras: { symbol: string; address: `0x${string}`; decimals: number }[]) {
    const standins = extras.map((t) => (core.isEnergyReserveToken(t.address) ? { ...t, address: STANDIN as `0x${string}` } : t));
    const { grant, owner } = await signerGrant({ account: ACCOUNT, extraTokens: standins });
    const grantFeatures = (grant.grantFeatures ?? []).filter((f) => f !== GRANT_ENERGY);
    const permissions = swap(
      core.buildCallPermissions(grant.caps, grant.smartAccount, {
        ...core.grantWallOptions({ grantTokens: grant.grantTokens, grantFeatures }),
        ponsClassVaultAddress: grant.ponsClassVaultAddress,
        ponsClassVaultFactoryAddress: grant.ponsClassVaultFactoryAddress,
      }),
    );
    const policies = [
      toTimestampPolicy({ validAfter: grant.grantedAt, validUntil: grant.expiresAt }),
      toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: permissions as never }),
    ];
    const { serialized, sessionKey } = await sealWall({ owner, account: grant.smartAccount, policies });
    return {
      ...grant,
      grantFeatures,
      grantTokens: swap(grant.grantTokens) as string[],
      serialized,
      demoSessionPrivateKey: sessionKey,
      sessionKeyAddress: privateKeyToAccount(sessionKey).address,
    } as StoredGrant;
  }

  it("control: the same construction WITHOUT the reserve is a wall the server accepts", async () => {
    assert.deepEqual(verdict(await preEnergyGrant([EXTRA])), { ok: true });
  });

  it("with $MERRYMEN sealed as a custom token: refused by name, with the way out that works", async () => {
    const legacy = await preEnergyGrant([{ symbol: "MERRYMEN", address: MERRY, decimals: 18 }, EXTRA]);
    assert.ok(legacy.grantTokens?.includes(MERRY.toLowerCase()), "premise: the old signer listed the reserve");
    const v = refusedWith(legacy, "invalid_wall");
    const why = v.ok ? "" : v.why;
    assert.match(why, /\$MERRYMEN/);
    assert.match(why, /This page or app version is out of date/);
    assert.match(why, /Reload the page \(or update the app\) and sign again$/);
    // No screen shows the reserve as a custom token any more (GET /api/settings
    // leaves it out), so that remedy sent the owner to a list with nothing to remove.
    assert.doesNotMatch(why, /custom tokens/i);
    assert.doesNotMatch(why, /does not implement/, "the generic refusal is what left owners stuck");
    assert.doesNotMatch(why, /\.$/, "POST /api/grants appends its own sentence");
    assert.doesNotMatch(why, /price|returns?\b|profit|invest/i);
  });

  it("the reserve in grantTokens is refused before the bytes, whatever the wall and however it is cased", async () => {
    // A current signer's wall (no reserve approve) with metadata naming it.
    const { grant } = await signerGrant({ account: ACCOUNT, extraTokens: [EXTRA] });
    for (const address of [MERRY.toLowerCase(), `0x${MERRY.slice(2).toUpperCase()}`]) {
      const v = refusedWith({ ...grant, grantTokens: [...(grant.grantTokens ?? []), address] }, "invalid_wall");
      assert.match(v.ok ? "" : v.why, /\$MERRYMEN is now its energy/);
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
        // Rebuilt from the GRANT_ENERGY marker by grantWallOptions — a
        // versioned route, so the marker is the whole sealed fact.
        "energyBuy",
        // Rebuilt from the GRANT_PERP_LIGHTER marker AND the grant's `perp`
        // block (the sealed key) by grantWallOptions → grantPerp.
        "perpLighter",
      ]);
      for (const key of keys) assert.ok(modelled.has(key), `${who} passes ${key} to the wall, which canonical-wall.ts does not rebuild`);
      assert.doesNotMatch(block[1], /withdrawalAddresses|allowRialto/, `${who} must not widen the wall with a transfer or Rialto`);
    });
  }
});
