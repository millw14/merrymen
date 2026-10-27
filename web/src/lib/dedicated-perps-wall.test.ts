/**
 * THE BROWSER SIGNS THE PERPS WALL THE SERVER EXPECTS, AT THE PERPS INDEX
 * (perps slice 5b, decision D5).
 *
 * A paper Perps wallet's permission is EMPTY: core WallOptions.perpsOnly with
 * no perp block and no energy buy, `purpose: "perps"`, chain 4663, no marker,
 * no token and no sealed address. POST /api/grants rebuilds exactly that wall
 * from the grant (canonical-wall.ts) and refuses anything else, so a signer
 * that sealed one permission more, or minted one marker more, would make a
 * grant the server throws away after its account-link nonce is spent. And the
 * account is the owner's Kernel account at index 1, which the server proves
 * at intake (derive-account.ts); a signature made at index 0 would be refused.
 *
 * Everything here runs the REAL signer (session.ts) over the stub chains in
 * canonical-wall-fixture.ts, and every grant it mints is put through the
 * server's own check. Adapted from the perps branch's dedicated-perps-wall
 * test (112dbeb6): its Lighter-key cases are live and stay out (D5), and the
 * Perps signature now REFUSES Spot opt-ins instead of dropping them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, parseAbi, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
// FIRST, before ./session: the fixture pins the Trencher factory's trusted
// bytecode hash in the environment, which trencher-permission.ts reads once.
import { CLASS_FACTORY, TEST_CAPS, TRENCHER_FACTORY, derivingChain, signerGrant, withStubChain } from "./canonical-wall-fixture";
import {
  GRANT_PERP_LIGHTER,
  LIGHTER_ROUTE_V1,
  buildCallPermissions,
  grantWallOptions,
  robinhoodTestnet,
} from "@merrymen/core";
import { checkCanonicalWall } from "./canonical-wall";
import { deriveKernelAccountAddress } from "./derive-account";

const ACCOUNT = "0x00000000000000000000000000000000000a11ce" as const;
const KEY = `0x${"1a".repeat(40)}` as `0x${string}`;
const EXTRA = { symbol: "CATE", address: "0x0000000000000000000000000000000000ca7e00" as const, decimals: 18 };
const V4_ADAPTER = "0xe0ce6bd81a472f021a9e85392a8008b8786f9218" as const;

const verdict = (g: unknown) => checkCanonicalWall(g as Record<string, unknown>);
const decoded = (g: { serialized: string }) =>
  JSON.parse(Buffer.from(g.serialized, "base64").toString("utf8")) as {
    accountParams: { initCode: Hex };
    permissionParams: { policies: { policyParams: { permissions?: unknown[] } }[] };
  };

/** The Kernel index the SDK's factory call was built with: the salt of deployWithFactory. */
function kernelIndexOf(g: { serialized: string }): bigint {
  const call = decodeFunctionData({
    abi: parseAbi(["function deployWithFactory(address factory, bytes createData, bytes32 salt)"]),
    data: decoded(g).accountParams.initCode,
  });
  return BigInt(call.args[2]);
}

/** An owner whose every signature is counted, so a refusal can be shown to come first. */
function countingOwner(): { owner: LocalAccount; signatures: () => number } {
  const base = privateKeyToAccount(generatePrivateKey());
  let n = 0;
  const owner: LocalAccount = {
    ...base,
    async signMessage(a) { n++; return base.signMessage(a); },
    async signTypedData(a) { n++; return base.signTypedData(a as never); },
  };
  return { owner, signatures: () => n };
}

describe("the paper Perps grant the real signer mints", () => {
  it("is what the server's canonical check expects: purpose perps, mainnet, no marker, no token, the EMPTY Perps wall", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT, purpose: "perps" });
    assert.deepEqual(verdict(grant), { ok: true });
    assert.equal(grant.purpose, "perps");
    assert.equal(grant.chainId, 4663);
    assert.deepEqual(grant.grantFeatures, [], "no Spot marker, no scoped-spenders shape, no energy buy, no perps key");
    assert.deepEqual(grant.grantTokens, []);
    for (const field of ["v4AdapterAddress", "ponsAdapterAddress", "ponsClassVaultAddress", "ponsClassVaultFactoryAddress", "trencherVaultAddress", "trencherFactoryAddress", "perp", "perpRecovery", "binding", "demoOwnerPrivateKey"] as const) {
      assert.equal(grant[field], undefined, field);
    }
    // THE PIN: the call policy the owner signed permits nothing, and the
    // server's rebuild from the grant (grantWallOptions, perpsOnly from the
    // purpose) permits nothing too. Any permission here is one a paper wallet's
    // key would hold over the real money its mainnet account can receive.
    assert.deepEqual(decoded(grant).permissionParams.policies.flatMap((p) => p.policyParams.permissions ?? []), []);
    assert.equal(grantWallOptions(grant).perpsOnly, true);
    assert.deepEqual(buildCallPermissions(grant.caps, ACCOUNT, grantWallOptions(grant)), []);
  });

  it("cannot be relabelled or widened: the purpose and the markers are what the wall is rebuilt from", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT, purpose: "perps" });
    // As Spot, the rebuild is the Spot wall, which this signature does not carry.
    assert.equal(verdict({ ...grant, purpose: "spot" }).ok, false, "purpose cannot relabel a signed wall");
    assert.equal(verdict({ ...grant, purpose: undefined }).ok, false);
    for (const features of [["tradeable-v2"], ["scoped-spenders"], ["energy-buy-v1"], [GRANT_PERP_LIGHTER]]) {
      assert.equal(verdict({ ...grant, grantFeatures: features }).ok, false, features.join());
    }
  });

  it("never seals the energy buy, though an empty mainnet wall has room for it (D5)", async () => {
    // Premise: the same chain and caps give a Spot wall the energy buy.
    const { grant: spot } = await signerGrant({ account: ACCOUNT });
    assert.ok(spot.grantFeatures?.includes("energy-buy-v1"));
    const { grant } = await signerGrant({ account: ACCOUNT, purpose: "perps" });
    assert.ok(!grant.grantFeatures?.includes("energy-buy-v1"));
  });

  it("the same owner signs Spot at Kernel index 0 and Perps at index 1: the index reaches the SDK's factory call", async () => {
    const owner = privateKeyToAccount(`0x${"31".repeat(32)}`);
    const { grant: spot } = await signerGrant({ account: ACCOUNT, owner });
    const { grant: perps } = await signerGrant({ account: ACCOUNT, owner, purpose: "perps" });
    assert.equal(kernelIndexOf(spot), 0n, "Spot keeps Kernel's default, so every existing address stays where it is");
    assert.equal(kernelIndexOf(perps), 1n);
    assert.equal(spot.owner, perps.owner);
    // And a Spot grant is the object it always was: no purpose key at all.
    assert.equal("purpose" in spot, false);
    assert.deepEqual(verdict(spot), { ok: true });
  });
});

describe("a Perps signature refuses what a Perps wallet cannot hold, before the owner signs anything", () => {
  const perpsSign = async (extra: Record<string, unknown>, chainId = 4663) => {
    const { owner, signatures } = countingOwner();
    const { prepareAgentGrant } = await import("./session");
    await withStubChain(ACCOUNT, () =>
      assert.rejects(
        prepareAgentGrant(owner, { purpose: "perps", caps: TEST_CAPS, onStatus: () => {}, chainId, ...extra }),
        (e: unknown) => e instanceof Error && /Nothing was signed/.test(e.message),
      ),
    );
    assert.equal(signatures(), 0, JSON.stringify(extra));
  };

  it("every Spot opt-in, by name rather than quietly dropped", async () => {
    for (const extra of [
      { extraTokens: [EXTRA] },
      { v4AdapterAddress: V4_ADAPTER },
      { ponsAdapterAddress: `0x${"5".repeat(40)}` },
      { ponsClassVaultFactory: CLASS_FACTORY },
      { trencherFactory: TRENCHER_FACTORY },
    ]) await perpsSign(extra);
  });

  it("any Lighter key in this build: a new one, a drop, a recovery, or one carried from a previous Perps grant", async () => {
    for (const extra of [{ perp: { apiPublicKey: KEY } }, { perpDrop: true, venueFlat: true }, { recovery: { v: 1 } }]) await perpsSign(extra);
    const previous = {
      purpose: "perps", smartAccount: ACCOUNT, chainId: 4663, grantFeatures: [GRANT_PERP_LIGHTER],
      perp: { route: GRANT_PERP_LIGHTER, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: KEY },
    };
    await perpsSign({ previousGrant: previous });
  });

  it("any network but Robinhood Chain mainnet", async () => {
    await perpsSign({}, robinhoodTestnet.id);
  });

  it("and a wallet this build does not know signs nothing, never as Spot", async () => {
    const { owner, signatures } = countingOwner();
    const { prepareAgentGrant } = await import("./session");
    await withStubChain(ACCOUNT, () =>
      assert.rejects(prepareAgentGrant(owner, { purpose: "solana" as never, caps: TEST_CAPS, onStatus: () => {}, chainId: 4663 }), /Nothing was signed/),
    );
    assert.equal(signatures(), 0);
  });
});

describe("the Perps account is the one the server will derive (derive-account.ts)", () => {
  it("a renewal preflight for the Perps wallet lands on the owner's index-1 account, and only there", async () => {
    // derivingChain answers getSenderAddress from the initCode it is handed,
    // so index 0 and index 1 are two real, different addresses, as on chain.
    const chain = derivingChain();
    chain.install();
    try {
      const { preflightAgentGrant } = await import("./session");
      const { owner, signatures } = countingOwner();
      const at = async (wallet: "spot" | "perps") => {
        const d = await deriveKernelAccountAddress(owner.address, 4663, wallet);
        assert.ok(d.ok);
        return d.address as `0x${string}`;
      };
      const spot = await at("spot");
      const perps = await at("perps");
      assert.notEqual(spot, perps);
      const options = { caps: TEST_CAPS, onStatus: () => {}, chainId: 4663 };
      await preflightAgentGrant(owner, { ...options, purpose: "perps", expectAccount: perps });
      await assert.rejects(
        preflightAgentGrant(owner, { ...options, purpose: "perps", expectAccount: spot }),
        /this owner derives/,
        "a Perps signature can never land on the Spot account",
      );
      assert.equal(signatures(), 0, "a preflight signs nothing");
    } finally {
      chain.restore();
    }
  });
});
