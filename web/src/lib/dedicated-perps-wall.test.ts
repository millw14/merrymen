import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { buildCallPermissions, buildWallPolicies, CASH, LIGHTER_ROUTE_V1, ENERGY_ROUTE_V1, grantWallOptions, GRANT_PERP_LIGHTER } from "@merrymen/core";
import { checkCanonicalWall } from "./canonical-wall";
import { signerGrant, TEST_CAPS } from "./canonical-wall-fixture";
const ACCOUNT = "0x00000000000000000000000000000000000a11ce" as const;
const key = `0x${"1a".repeat(40)}` as `0x${string}`;
test("dedicated Perps wall has only cash approve, pinned Lighter operations, and optional energy", () => {
  const permissions = buildCallPermissions(TEST_CAPS, ACCOUNT, { perpsOnly: true,
    perpLighter: { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: key }, energyBuy: true });
  assert.ok(permissions.length > 1);
  assert.ok(permissions.every(p => [CASH.USDG, LIGHTER_ROUTE_V1.proxy, ENERGY_ROUTE_V1.router].some(a => a.toLowerCase() === p.target.toLowerCase())));
  assert.ok(!permissions.some(p => ["transfer", "exactInputSingle", "tradeExactIn", "createVault"].includes(p.functionName ?? "")));
  const approval = permissions.find(p => p.target === CASH.USDG)!;
  assert.equal(approval.functionName, "approve");
  assert.deepEqual(approval.args?.[0]?.value, [ENERGY_ROUTE_V1.router, LIGHTER_ROUTE_V1.proxy]);
  assert.equal(approval.args?.[1]?.value, 10_000_000n);
  const empty = buildCallPermissions(TEST_CAPS, ACCOUNT, { perpsOnly: true });
  assert.deepEqual(empty, []);
  assert.doesNotThrow(() => buildWallPolicies({ caps: TEST_CAPS, smartAccount: ACCOUNT, perpsOnly: true }));
});
test("real dedicated signer and canonical verifier agree without granting Spot routes", async () => {
  const { grant } = await signerGrant({ account: ACCOUNT, purpose: "perps", perp: { apiPublicKey: key }, trencher: true });
  assert.equal(grant.purpose, "perps");
  assert.ok(grant.grantFeatures?.includes(GRANT_PERP_LIGHTER));
  assert.ok(!grant.grantFeatures?.includes("tradeable-v2"));
  assert.equal(grant.trencherFactoryAddress, undefined);
  assert.deepEqual(checkCanonicalWall(grant as unknown as Record<string, unknown>), { ok: true });
  assert.equal(grantWallOptions(grant).perpsOnly, true);
  const swapped = { ...grant, purpose: "spot" };
  assert.equal(checkCanonicalWall(swapped).ok, false, "purpose cannot relabel a signed wall");
  const widened = { ...grant, grantFeatures: [...grant.grantFeatures!, "tradeable-v2"] };
  assert.equal(checkCanonicalWall(widened).ok, false);
});
test("paper dedicated account signs without live Lighter authority", async () => {
  const { grant } = await signerGrant({ account: ACCOUNT, purpose: "perps" });
  assert.deepEqual(checkCanonicalWall(grant as unknown as Record<string, unknown>), { ok: true });
  assert.equal(grant.perp, undefined);
});

test("the same owner signs distinct Kernel deployment inputs for Spot and Perps", async () => {
  const owner = privateKeyToAccount(`0x${"31".repeat(32)}`);
  const { grant: spot } = await signerGrant({ account: ACCOUNT, owner });
  const { grant: perps } = await signerGrant({ account: ACCOUNT, owner, purpose: "perps" });
  const initial = (grant: { serialized: string }) => JSON.parse(Buffer.from(grant.serialized, "base64").toString("utf8")).accountParams.initCode;
  assert.notEqual(initial(spot), initial(perps), "the purpose index must reach the SDK factory calldata, not just grant metadata");
  assert.equal(spot.owner, perps.owner);
});
