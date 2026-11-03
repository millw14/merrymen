import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { privateKeyToAccount } from "viem/accounts";
import { bindingMessage, type GrantPurpose } from "@merrymen/core";
import type { Grant } from "./session";
import { loadRecoveryGrants, saveRecoveryGrant, trustedSavedGrant } from "./saved-grant-binding";

const ORIGIN = "https://app.example.test";
const owner = privateKeyToAccount(`0x${"7".repeat(64)}`);
const tenant = privateKeyToAccount(`0x${"8".repeat(64)}`);
const other = privateKeyToAccount(`0x${"9".repeat(64)}`);
let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM("", { url: ORIGIN });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
});
afterEach(() => { Reflect.deleteProperty(globalThis, "localStorage"); dom.window.close(); });

/**
 * A grant with a historical binding. `wallet: "perps"` is a Perps grant (its
 * own account, `purpose: "perps"`) whose claim was signed for the Perps wallet;
 * `signedFor` signs it for another wallet's text instead, as a replay would.
 */
async function signedGrant(privy: boolean, wallet: GrantPurpose = "spot", signedFor: GrantPurpose = wallet): Promise<Grant> {
  const grant = {
    ...(wallet === "perps" ? { purpose: "perps" } : {}),
    smartAccount: wallet === "perps" ? `0x${"d".repeat(40)}` : `0x${"a".repeat(40)}`, owner: owner.address, chainId: 4663,
    sessionKeyAddress: other.address, serialized: "private-session-payload", demoOwnerPrivateKey: "private-owner", demoSessionPrivateKey: "private-session",
    caps: { perTradeUsdg: 10, dailyUsdg: 50, maxOpsPerDay: 24, maxDrawdownPct: 5, expiryDays: 7 }, grantedAt: wallet === "perps" ? 3 : 1, expiresAt: 4,
    ...(wallet === "perps" ? {} : { trencherFactoryAddress: `0x${"b".repeat(40)}`, trencherVaultAddress: `0x${"c".repeat(40)}` }),
  } as unknown as Grant;
  const common = { origin: ORIGIN, nonce: "expired-and-consumed-historical-nonce", owner: grant.owner, smartAccount: grant.smartAccount, chainId: grant.chainId, purpose: signedFor };
  if (privy) {
    const did = "did:privy:owner";
    grant.binding = { version: "privy-did-owner-v1", did, nonce: common.nonce, ownerSignature: await owner.signMessage({ message: bindingMessage({ ...common, version: "privy-did-owner-v1", did }) }) };
  } else {
    const message = bindingMessage(common);
    grant.binding = { nonce: common.nonce, ownerSignature: await owner.signMessage({ message }), walletSignature: await tenant.signMessage({ message }) };
  }
  return grant;
}

it("a historical signed binding proves local recovery association for the authenticated tenant only", async () => {
  for (const privy of [true, false]) {
    const grant = await signedGrant(privy);
    const session = { hosted: true, address: privy ? owner.address : tenant.address };
    assert.equal(await trustedSavedGrant(grant, session, ORIGIN), true);
    assert.equal(await trustedSavedGrant(grant, { hosted: true, address: other.address }, ORIGIN), false);
    assert.equal(await trustedSavedGrant(grant, { hosted: true, address: null }, ORIGIN), false);
    assert.equal(await trustedSavedGrant(grant, session, "https://other.example"), false);
    for (const mutation of [
      { owner: other.address }, { smartAccount: other.address }, { chainId: 46630 }, { binding: undefined },
      { binding: { ...grant.binding!, ownerSignature: "0x1234" } },
      { binding: { ...grant.binding!, version: "unknown" } },
    ]) assert.equal(await trustedSavedGrant({ ...grant, ...mutation } as Grant, session, ORIGIN), false);
  }
});

it("snapshots preserve public renewal inputs without copying or replacing recovery secrets", async () => {
  const grant = await signedGrant(true);
  localStorage.setItem("merrymen.grant.v1", "original-secret-grant");
  saveRecoveryGrant(grant);
  const [snapshot] = loadRecoveryGrants("spot");
  assert.equal(localStorage.getItem("merrymen.grant.v1"), "original-secret-grant");
  assert.doesNotMatch(JSON.stringify(snapshot), /private-owner|private-session/);
  assert.equal(snapshot.trencherFactoryAddress, grant.trencherFactoryAddress);
  assert.equal(snapshot.trencherVaultAddress, grant.trencherVaultAddress);
  assert.equal(await trustedSavedGrant(snapshot, { hosted: true, address: owner.address }, ORIGIN), true);
});

it("missing recovery is empty, while malformed or unreadable recovery blocks a fresh mint", () => {
  assert.deepEqual(loadRecoveryGrants("spot"), []);
  for (const value of ["{", "null", "{}"]){
    localStorage.setItem("merrymen.permission-recovery.v1.bad", value);
    assert.throws(() => loadRecoveryGrants("spot"), /could not be read/);
  }
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("storage unavailable"); } });
  assert.throws(() => loadRecoveryGrants("spot"), /could not be read/);
});

describe("two wallets (perps slice 5b)", () => {
  it("a Perps grant's claim is rebuilt for the Perps wallet: trusted as signed, never as the other wallet's", async () => {
    for (const privy of [true, false]) {
      const session = { hosted: true, address: privy ? owner.address : tenant.address };
      assert.equal(await trustedSavedGrant(await signedGrant(privy, "perps"), session, ORIGIN), true, "signed for Perps, read as Perps");
      // A Spot claim's signature on a Perps grant, and a Perps claim's on a
      // Spot grant, recover to nobody: the text names the wallet.
      assert.equal(await trustedSavedGrant(await signedGrant(privy, "perps", "spot"), session, ORIGIN), false, "Spot claim on a Perps grant");
      assert.equal(await trustedSavedGrant(await signedGrant(privy, "spot", "perps"), session, ORIGIN), false, "Perps claim on a Spot grant");
      // Relabelling a signed grant moves it to neither wallet.
      const spot = await signedGrant(privy);
      assert.equal(await trustedSavedGrant({ ...spot, purpose: "perps" }, session, ORIGIN), false);
      assert.equal(await trustedSavedGrant({ ...spot, purpose: "solana" } as unknown as Grant, session, ORIGIN), false);
    }
  });

  it("the purpose is saved with the snapshot, and each wallet loads its own: a record with none is Spot", async () => {
    const spot = await signedGrant(true);
    const perps = await signedGrant(true, "perps");
    saveRecoveryGrant(spot);
    saveRecoveryGrant(perps);
    const [savedSpot, ...noMoreSpot] = loadRecoveryGrants("spot");
    const [savedPerps, ...noMorePerps] = loadRecoveryGrants("perps");
    assert.deepEqual([noMoreSpot, noMorePerps], [[], []]);
    assert.equal(savedSpot.smartAccount, spot.smartAccount);
    assert.equal("purpose" in savedSpot, false, "a Spot snapshot is byte for byte what it always was");
    assert.equal(savedPerps.smartAccount, perps.smartAccount);
    assert.equal(savedPerps.purpose, "perps");
    assert.doesNotMatch(JSON.stringify(savedPerps), /private-owner|private-session/);
    // And the saved Perps snapshot still proves its claim, which it could not
    // if the purpose had been dropped on the way into storage.
    assert.equal(await trustedSavedGrant(savedPerps, { hosted: true, address: owner.address }, ORIGIN), true);
  });

  it("a saved record naming a wallet this build does not know blocks a fresh mint in either wallet", () => {
    localStorage.setItem("merrymen.permission-recovery.v1.4663.0xbad", JSON.stringify({ purpose: "solana", smartAccount: "0x1", owner: "0x2", caps: {} }));
    assert.throws(() => loadRecoveryGrants("spot"), /could not be read/);
    assert.throws(() => loadRecoveryGrants("perps"), /could not be read/);
    assert.throws(() => loadRecoveryGrants("solana" as never), /Unrecognised wallet/);
  });
});
