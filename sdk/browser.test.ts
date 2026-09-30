import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { signMerrymanAuthorization, partnerGrantDigest, type StoredGrant, type PartnerEnrollmentClaim } from "./browser";
import { partnerEnrollmentMessage } from "../packages/core/src/partner-enrollment";

const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const grant: StoredGrant = {
  owner: owner.address,
  smartAccount: `0x${"22".repeat(20)}`,
  sessionKeyAddress: `0x${"33".repeat(20)}`,
  demoSessionPrivateKey: `0x${"44".repeat(32)}`,
  serialized: "signed-session-permission",
  caps: { perTradeUsdg: 20, dailyUsdg: 100, expiryDays: 7, maxDrawdownPct: 20, maxOpsPerDay: 20 } as StoredGrant["caps"],
  chainId: 4663,
  grantedAt: Date.now() / 1000,
  expiresAt: Date.now() / 1000 + 86400,
};
const settings = { name: "Little John", strategy: "steady-basket" as const, basket_symbols: ["NVDA"], live_trading_enabled: false };
function fixture() {
  const claim: PartnerEnrollmentClaim = {
    v: 1, app_id: "prism", app_name: "Prism", agent_id: "mpa_example", external_user_id: "user_123",
    owner: owner.address, smart_account: grant.smartAccount, chain_id: grant.chainId,
    grant_hash: partnerGrantDigest(grant), settings, scopes: ["read:agents", "chat:agents"],
    nonce: "one-use-nonce", expires_at: Date.now() + 300_000,
  };
  return {
    owner, grant, settings, expectedAppId: "prism", expectedAgentId: "mpa_example", expectedExternalUserId: "user_123",
    expectedScopes: ["read:agents", "chat:agents"],
    challenge: { claim, message: partnerEnrollmentMessage(claim), challenge_token: "signed-challenge-token" },
  };
}

describe("browser partner authorization", () => {
  it("signs the canonical challenge with the existing owner wallet", async () => {
    const input = fixture();
    const signed = await signMerrymanAuthorization(input);
    assert.equal(await verifyMessage({ address: owner.address, message: input.challenge.message, signature: signed.signature }), true);
    assert.equal(signed.grant, grant);
    assert.equal(signed.challenge_token, "signed-challenge-token");
    assert.equal(signed.grant.demoOwnerPrivateKey, undefined);
  });

  it("refuses swapped app, agent, wallet, account, chain, grant and settings before signing", async () => {
    const edits: ((input: ReturnType<typeof fixture>) => void)[] = [
      (i) => { i.challenge.claim.app_id = "another-app"; },
      (i) => { i.challenge.claim.agent_id = "another-agent"; },
      (i) => { i.challenge.claim.external_user_id = "another-user"; },
      (i) => { i.challenge.claim.scopes = ["read:agents"]; },
      (i) => { i.challenge.claim.scopes.push("write:agents"); },
      (i) => { i.challenge.claim.owner = `0x${"55".repeat(20)}`; },
      (i) => { i.challenge.claim.smart_account = `0x${"55".repeat(20)}`; },
      (i) => { i.challenge.claim.chain_id = 1; },
      (i) => { i.challenge.claim.grant_hash = `0x${"55".repeat(32)}`; },
      (i) => { i.challenge.claim.settings = { ...settings, live_trading_enabled: true }; },
    ];
    for (const edit of edits) {
      const input = fixture();
      edit(input);
      input.challenge.message = partnerEnrollmentMessage(input.challenge.claim);
      let signed = false;
      input.owner = { ...owner, signMessage: async () => { signed = true; return "0x00"; } };
      await assert.rejects(signMerrymanAuthorization(input));
      assert.equal(signed, false, "refuse before asking the owner to sign");
    }
  });

  it("compares capabilities as exact normalized sets", async () => {
    const input = fixture();
    input.expectedScopes = ["chat:agents", "read:agents", "read:agents"];
    await assert.doesNotReject(signMerrymanAuthorization(input));
  });

  it("refuses expired challenges, edited messages and owner-key-bearing grants", async () => {
    const expired = fixture();
    expired.challenge.claim.expires_at = Date.now() - 1;
    await assert.rejects(signMerrymanAuthorization(expired), /expired/);
    const message = fixture();
    message.challenge.message += "\nAuthorize another wallet.";
    await assert.rejects(signMerrymanAuthorization(message), /message does not match/);
    const key = fixture();
    key.grant = { ...grant, demoOwnerPrivateKey: `0x${"11".repeat(32)}` };
    await assert.rejects(signMerrymanAuthorization(key), /owner private key/);
  });
});
