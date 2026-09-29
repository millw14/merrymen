/**
 * PARTNER ACTIVATION NEVER LETS GO OF A VENUE KEY (docs/perps.md rule 5).
 *
 * A partner grant never carries perps (onlyFields has no `perp`). So when the
 * owner's STORED grant does, activating replaces a grant that pins a
 * registered Lighter key with one that pins none — refused with a 409 unless
 * the stored account's venue reads provably flat, and refused BEFORE any
 * settings, identity or grant write. The fixture mirrors
 * partner-enrollment.test.ts: a real wall, a real owner signature.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getActionSelector } from "@zerodev/sdk";
import { buildWallPolicies, derivationOf, type MerrymenSettings, type StoredGrant } from "@merrymen/core";
import { partnerGrantDigest } from "../../../packages/core/src/partner-enrollment";
import { createPartnerEnrollmentService, type PartnerEnrollmentDependencies } from "./partner-enrollment";
import { FilePartnerStore } from "./partner-store";
import { PartnerError, type PartnerPrincipal } from "./partner-bridge";
import { PERP_NOT_FLAT_MESSAGE, type FlatnessReader } from "./perp-custody";

const SECRET = "test-partner-enrollment-secret-at-least-32-characters";
const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const PREVIOUS = "0x3333333333333333333333333333333333333333" as const;
const principal: PartnerPrincipal = { app_id: "partner-a", key_id: "000000000001", name: "Example App", scopes: ["write:agents", "read:agents", "chat:agents"] };
const settings = { name: "Robin", strategy: "steady-basket" as const, basket_symbols: ["QQQ", "NVDA"], live_trading_enabled: false };
const homes: Array<{ store: FilePartnerStore; home: string }> = [];
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toString("base64");
const errorCode = (code: string) => (error: unknown) => error instanceof PartnerError && error.code === code;
const pub = `0x${("01" + "00".repeat(7)).repeat(5)}` as `0x${string}`;

after(() => {
  for (const { store, home } of homes) {
    try {
      store.close();
    } catch {
      /* best effort */
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function fixture(flatness: FlatnessReader, storedAccount: `0x${string}`) {
  const now = 1_800_000_000_000;
  const home = mkdtempSync(join(tmpdir(), "merrymen-enrollment-perp-"));
  const store = new FilePartnerStore(home, () => Math.floor(now / 1000), () => SECRET);
  homes.push({ store, home });
  const owner = privateKeyToAccount(generatePrivateKey());
  const sessionKey = generatePrivateKey();
  const seconds = Math.floor(now / 1000);
  const caps = { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 };
  const wall = buildWallPolicies({ caps, smartAccount: ACCOUNT, now: seconds });
  const grant: StoredGrant = {
    owner: owner.address,
    smartAccount: ACCOUNT,
    sessionKeyAddress: privateKeyToAccount(sessionKey).address,
    demoSessionPrivateKey: sessionKey,
    caps,
    grantedAt: seconds,
    expiresAt: wall.expiresAt,
    chainId: 4663,
    grantFeatures: ["tradeable-v2"],
    serialized: encode({
      privateKey: sessionKey,
      accountParams: { accountAddress: ACCOUNT, initCode: "0x1234" },
      permissionParams: { policies: wall.policies.map((policy) => ({ policyParams: policy.policyParams })) },
      enableSignature: `0x${"12".repeat(65)}`,
      action: { selector: getActionSelector("0.7"), address: "0x0000000000000000000000000000000000000000" },
      validityData: { validAfter: 0, validUntil: 0 },
      isPreInstalled: false,
    }),
  };
  const tenant = owner.address.toLowerCase();
  // The owner's CURRENT grant carries perps.
  const stored: StoredGrant = {
    ...grant,
    smartAccount: storedAccount,
    grantFeatures: ["tradeable-v2", "perp-lighter-v1"],
    perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: pub, apiKeySealed: `pk1.${"A".repeat(16)}.${"B".repeat(22)}.${"C".repeat(110)}` },
  };
  const savedGrants = new Map<string, StoredGrant>([[tenant, stored]]);
  const savedSettings = new Map<string, MerrymenSettings>();
  const events: string[] = [];
  const created = await store.create({ partnerId: principal.app_id, partnerName: principal.name, externalUserId: "external-user", name: "Robin", scopes: ["read:agents", "chat:agents"] });
  const deps: PartnerEnrollmentDependencies = {
    store,
    now: () => now,
    secret: () => SECRET,
    recover: async (args) => (await import("viem")).recoverMessageAddress(args),
    derive: async () => derivationOf(ACCOUNT),
    grants: {
      get: async (t) => savedGrants.get(t) ?? null,
      tenantForAccount: async (account) => ([...savedGrants].find(([, g]) => g.smartAccount.toLowerCase() === account.toLowerCase())?.[0] as `0x${string}`) ?? null,
      put: async (t, g) => {
        events.push("grant");
        savedGrants.set(t, g);
      },
    },
    settings: {
      get: async (t) => savedSettings.get(t) ?? null,
      put: async (t, s) => {
        events.push("settings");
        savedSettings.set(t, s);
      },
    },
    identities: {
      ensure: async (t, account) => {
        events.push("identity");
        return { tenant: t, slug: "0000000000000001", accounts: [account], createdAt: seconds, updatedAt: seconds };
      },
    },
    flatness,
  };
  const service = createPartnerEnrollmentService(deps);
  const challenge = await service.challenge(principal, created.connection, {
    owner: grant.owner,
    smart_account: grant.smartAccount,
    chain_id: grant.chainId,
    grant_hash: partnerGrantDigest(grant),
    settings,
  });
  const activation = { grant, challenge_token: challenge.challenge_token, signature: await owner.signMessage({ message: challenge.message }) };
  return { service, connection: created.connection, activation, events, savedGrants, tenant, stored };
}

for (const [label, storedAccount] of [
  ["the same account", ACCOUNT],
  ["a different account", PREVIOUS],
] as const) {
  test(`${label}: a stored perps grant whose venue is NOT FLAT refuses activation with rule 5's sentence, before any write`, async () => {
    const asked: string[] = [];
    const f = await fixture(async (a) => (asked.push(a), { flat: false, detail: "account 22149: 1 open position" }), storedAccount);
    await assert.rejects(f.service.activate(principal, f.connection, f.activation), (e: unknown) => {
      assert.ok(errorCode("perp_venue_not_flat")(e), String(e));
      assert.equal((e as PartnerError).status, 409);
      assert.equal((e as Error).message, PERP_NOT_FLAT_MESSAGE);
      return true;
    });
    assert.deepEqual(asked, [storedAccount.toLowerCase()], "the STORED account's venue is read");
    assert.deepEqual(f.events, []);
    assert.equal(f.savedGrants.get(f.tenant), f.stored, "the perps grant is untouched");
  });

  test(`${label}: an UNREAD venue refuses the same way`, async () => {
    const f = await fixture(async () => ({ flat: null, detail: "rate-limited" }), storedAccount);
    await assert.rejects(f.service.activate(principal, f.connection, f.activation), errorCode("perp_venue_unread"));
    assert.deepEqual(f.events, []);
  });

  test(`${label}: a PROVABLY FLAT venue lets the activation through`, async () => {
    const f = await fixture(async () => ({ flat: true }), storedAccount);
    const result = await f.service.activate(principal, f.connection, f.activation);
    assert.equal(result.smartAccount, ACCOUNT);
    assert.ok(f.events.includes("grant"));
    assert.equal(f.savedGrants.get(f.tenant)?.perp, undefined);
  });
}
