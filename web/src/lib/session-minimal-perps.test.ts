import assert from "node:assert/strict";
import { test } from "node:test";
import { signerGrant } from "./canonical-wall-fixture";
import { checkCanonicalWall } from "./canonical-wall";
import { restoreAgentWallet, prepareAgentGrant } from "./session";
import { privateKeyToAccount } from "viem/accounts";
import { PONS_CLASS_VAULT_FACTORY, GRANT_V4_ADAPTER, GRANT_PONS_ADAPTER, GRANT_PONS_CLASS, GRANT_TRENCHER, GRANT_PERP_LIGHTER } from "@merrymen/core";

const ACCOUNT = "0x0000000000000000000000000000000000000042" as const;
const OPTIONAL = "0x0000000000000000000000000000000000000099" as const;
const KEY = `0x${"11".repeat(32)}` as `0x${string}`;

test("minimal new perps grant omits optional spot capabilities and never probes their factories", async () => {
  const calls: string[] = [];
  const { grant } = await signerGrant({ account: ACCOUNT, newAccountPerpsOnly: true,
    extraTokens: [{ symbol: "EXTRA", address: OPTIONAL, decimals: 18 }],
    v4AdapterAddress: OPTIONAL, ponsAdapterAddress: OPTIONAL, trencher: true,
    onRpc(method, params) {
      if (method === "eth_call") calls.push(String((params[0] as { to: string }).to).toLowerCase());
      if (method === "eth_getCode") calls.push(String(params[0]).toLowerCase());
    },
  });
  for (const marker of [GRANT_V4_ADAPTER, GRANT_PONS_ADAPTER, GRANT_PONS_CLASS, GRANT_TRENCHER, GRANT_PERP_LIGHTER])
    assert.ok(!grant.grantFeatures?.includes(marker), marker);
  assert.deepEqual(grant.grantTokens, []);
  assert.equal(grant.v4AdapterAddress, undefined);
  assert.equal(grant.ponsAdapterAddress, undefined);
  assert.equal(grant.ponsClassVaultFactoryAddress, undefined);
  assert.ok(!calls.includes(OPTIONAL.toLowerCase()));
  assert.ok(!calls.includes(PONS_CLASS_VAULT_FACTORY[4663]!.toLowerCase()));
  const checked = await checkCanonicalWall(grant as unknown as Record<string, unknown>);
  assert.equal(checked.ok, true, JSON.stringify(checked));
});

test("minimal mode refuses restore, previous authority and deployed accounts instead of narrowing renewals", async () => {
  await assert.rejects(restoreAgentWallet(KEY, { newAccountPerpsOnly: true } as never), /not allowed on restore/);
  await assert.rejects(prepareAgentGrant(privateKeyToAccount(KEY), { newAccountPerpsOnly: true,
    expectAccount: ACCOUNT } as never), /brand-new account/);
  await assert.rejects(signerGrant({ account: ACCOUNT, newAccountPerpsOnly: true,
    previousGrant: { smartAccount: ACCOUNT } }), /brand-new account/);
  await assert.rejects(signerGrant({ account: ACCOUNT, newAccountPerpsOnly: true, deployed: true }), /deployed account/);
});
