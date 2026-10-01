import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { JSDOM } from "jsdom";
import { privateKeyToAccount } from "viem/accounts";
import { bindingMessage } from "@merrymen/core";
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

async function signedGrant(privy: boolean): Promise<Grant> {
  const grant = {
    smartAccount: `0x${"a".repeat(40)}`, owner: owner.address, chainId: 4663,
    sessionKeyAddress: other.address, serialized: "private-session-payload", demoOwnerPrivateKey: "private-owner", demoSessionPrivateKey: "private-session",
    caps: { perTradeUsdg: 10, dailyUsdg: 50, maxOpsPerDay: 24, maxDrawdownPct: 5, expiryDays: 7 }, grantedAt: 1, expiresAt: 2,
    trencherFactoryAddress: `0x${"b".repeat(40)}`, trencherVaultAddress: `0x${"c".repeat(40)}`,
  } as unknown as Grant;
  const common = { origin: ORIGIN, nonce: "expired-and-consumed-historical-nonce", owner: grant.owner, smartAccount: grant.smartAccount, chainId: grant.chainId };
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
  const [snapshot] = loadRecoveryGrants();
  assert.equal(localStorage.getItem("merrymen.grant.v1"), "original-secret-grant");
  assert.doesNotMatch(JSON.stringify(snapshot), /private-owner|private-session/);
  assert.equal(snapshot.trencherFactoryAddress, grant.trencherFactoryAddress);
  assert.equal(snapshot.trencherVaultAddress, grant.trencherVaultAddress);
  assert.equal(await trustedSavedGrant(snapshot, { hosted: true, address: owner.address }, ORIGIN), true);
});

it("missing recovery is empty, while malformed or unreadable recovery blocks a fresh mint", () => {
  assert.deepEqual(loadRecoveryGrants(), []);
  for (const value of ["{", "null", "{}"]){
    localStorage.setItem("merrymen.permission-recovery.v1.bad", value);
    assert.throws(loadRecoveryGrants, /could not be read/);
  }
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("storage unavailable"); } });
  assert.throws(loadRecoveryGrants, /could not be read/);
});
