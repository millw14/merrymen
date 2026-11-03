/**
 * The grant binding — how the server decides an agent account is yours.
 *
 * This is the check that replaced `grant.owner === tenant`, which could never
 * hold: the owner key is minted in the browser, so it is never the signed-in
 * wallet, and requiring it refused every hosted grant ever submitted.
 *
 * The replacement is two signatures over one server-issued nonce, and the
 * second one is the whole point. With only the wallet's authorization the
 * server's remaining checks are functions of PUBLIC addresses — an attacker
 * signs in as themselves, names someone else's (owner, account) pair, and both
 * checks pass. That is account-id squatting relocated, not prevented, and every
 * ledger table keys on smart_account. The owner key's co-signature is what
 * makes the claim unforgeable, so the test that matters most here is the one
 * asserting a claim WITHOUT it is refused.
 *
 * Real viem signatures throughout, no mocks: the server recovers addresses the
 * same way production does.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bindingMessage } from "@merrymen/core";

// Set BEFORE the auth functions are called — they read the secret at call time,
// not at import — so a static import is safe and the CJS test target is happy.
// Same arrangement as auth.test.ts.
process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
const testHome = mkdtempSync(join(tmpdir(), "merrymen-binding-"));
process.env.MERRYMEN_HOME = testHome;
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_HOSTED;
after(() => rmSync(testHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

import { challengeMessage, issueChallengeNonce, verifyGrantBinding } from "./auth";

const ORIGIN = "https://app.merrymen.dev";
const SMART = "0x00000000000000000000000000000000000000a1" as `0x${string}`;
const CHAIN = 4663;

/** A tenant wallet and the browser-generated owner key it vouches for. */
function actors() {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  return { wallet, owner };
}

async function claim(opts: {
  wallet: ReturnType<typeof privateKeyToAccount>;
  owner: ReturnType<typeof privateKeyToAccount>;
  /** Who the server thinks is logged in. Defaults to the wallet that signed. */
  tenant?: `0x${string}`;
  /** Override what the request CLAIMS the owner is, without re-signing. */
  declaredOwner?: `0x${string}`;
  smartAccount?: `0x${string}`;
  /** Drop the co-signature, i.e. the attack this design exists to stop. */
  omitCoSignature?: boolean;
  /** Sign the co-signature with a different key than the declared owner. */
  coSigner?: ReturnType<typeof privateKeyToAccount>;
}) {
  const nonce = issueChallengeNonce(ORIGIN);
  const smartAccount = opts.smartAccount ?? SMART;
  const owner = opts.declaredOwner ?? opts.owner.address;
  const message = bindingMessage({ origin: ORIGIN, nonce, owner, smartAccount, chainId: CHAIN });
  const coSigner = opts.coSigner ?? opts.owner;
  return verifyGrantBinding({
    origin: ORIGIN,
    tenant: (opts.tenant ?? opts.wallet.address).toLowerCase() as `0x${string}`,
    nonce,
    owner,
    smartAccount,
    chainId: CHAIN,
    purpose: "spot",
    walletSignature: await opts.wallet.signMessage({ message }),
    ownerSignature: opts.omitCoSignature
      ? ("0x" + "11".repeat(65) as `0x${string}`)
      : await coSigner.signMessage({ message }),
  });
}

test("a well-formed claim is accepted", async () => {
  const { wallet, owner } = actors();
  const r = await claim({ wallet, owner });
  assert.equal(r.ok, true, r.ok ? "" : r.why);
});

test("THE ATTACK: claiming someone else's account without their owner key is refused", async () => {
  // The victim's account and owner address are PUBLIC — an attacker can read
  // both off a block explorer. They sign in as themselves and authorize the
  // victim's pair. The wallet signature is genuine and recovers to the attacker,
  // who is genuinely the tenant, so the only thing standing between them and the
  // victim's ledger partition is the co-signature they cannot produce.
  const attacker = privateKeyToAccount(generatePrivateKey());
  const victimOwner = privateKeyToAccount(generatePrivateKey());
  const r = await claim({
    wallet: attacker,
    owner: victimOwner,
    declaredOwner: victimOwner.address,
    coSigner: privateKeyToAccount(generatePrivateKey()), // any key they DO hold
  });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.why, /co-sign/i);
});

test("a missing/garbage co-signature is refused", async () => {
  const { wallet, owner } = actors();
  const r = await claim({ wallet, owner, omitCoSignature: true });
  assert.equal(r.ok, false);
});

test("the wallet signature must be the SIGNED-IN tenant, not just any wallet", async () => {
  // Someone else's valid authorization replayed into your session.
  const { wallet, owner } = actors();
  const someoneElse = privateKeyToAccount(generatePrivateKey());
  const r = await claim({ wallet, owner, tenant: someoneElse.address.toLowerCase() as `0x${string}` });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.why, /signed-in wallet/i);
});

test("altering the claimed account after signing is refused", async () => {
  // Both signatures are made over one text that NAMES the account, so changing
  // it means the reconstructed message differs and neither recovers. This is
  // why the server can trust the bound values without parsing the message.
  const { wallet, owner } = actors();
  const nonce = issueChallengeNonce(ORIGIN);
  const signed = bindingMessage({ origin: ORIGIN, nonce, owner: owner.address, smartAccount: SMART, chainId: CHAIN });
  const r = await verifyGrantBinding({
    origin: ORIGIN,
    tenant: wallet.address.toLowerCase() as `0x${string}`,
    nonce,
    owner: owner.address,
    smartAccount: "0x00000000000000000000000000000000000000ff", // swapped
    chainId: CHAIN,
    purpose: "spot",
    walletSignature: await wallet.signMessage({ message: signed }),
    ownerSignature: await owner.signMessage({ message: signed }),
  });
  assert.equal(r.ok, false);
});

test("a nonce cannot be spent twice", async () => {
  const { wallet, owner } = actors();
  const nonce = issueChallengeNonce(ORIGIN);
  const message = bindingMessage({ origin: ORIGIN, nonce, owner: owner.address, smartAccount: SMART, chainId: CHAIN });
  const args = {
    origin: ORIGIN,
    tenant: wallet.address.toLowerCase() as `0x${string}`,
    nonce,
    owner: owner.address,
    smartAccount: SMART,
    chainId: CHAIN,
    purpose: "spot" as const,
    walletSignature: await wallet.signMessage({ message }),
    ownerSignature: await owner.signMessage({ message }),
  };
  const results = await Promise.all([verifyGrantBinding(args), verifyGrantBinding(args)]);
  assert.equal(results.filter((result) => result.ok).length, 1, "concurrent claims have one winner");
  assert.equal((await verifyGrantBinding(args)).ok, false, "replay must fail");
});

test("a claim signed for another origin is refused", async () => {
  const { wallet, owner } = actors();
  const nonce = issueChallengeNonce("https://evil.example");
  const message = bindingMessage({ origin: "https://evil.example", nonce, owner: owner.address, smartAccount: SMART, chainId: CHAIN });
  const r = await verifyGrantBinding({
    origin: ORIGIN, // the real server
    tenant: wallet.address.toLowerCase() as `0x${string}`,
    nonce,
    owner: owner.address,
    smartAccount: SMART,
    chainId: CHAIN,
    purpose: "spot",
    walletSignature: await wallet.signMessage({ message }),
    ownerSignature: await owner.signMessage({ message }),
  });
  assert.equal(r.ok, false);
});

test("the binding text is not confusable with the login challenge", async () => {
  // Both are plain personal_sign over the same key. If a login signature could
  // be replayed as an account claim (or the reverse) the whole scheme leaks, so
  // the two texts must not be mistakable for one another.
  const nonce = issueChallengeNonce(ORIGIN);
  const login = challengeMessage(ORIGIN, nonce);
  const bind = bindingMessage({
    origin: ORIGIN, nonce, owner: "0x" + "11".repeat(20) as `0x${string}`, smartAccount: SMART, chainId: CHAIN,
  });
  assert.notEqual(login, bind);
  assert.ok(!login.includes("Agent account:"), "the login text must not look like a claim");
  assert.ok(bind.includes("Agent account:"), "the claim names what is being claimed");
  assert.notEqual(login.split("\n")[0], bind.split("\n")[0], "different opening lines");
});

test("a claim on one chain does not bind on the other", async () => {
  // merrymen runs testnet 46630 and mainnet 4663 from one origin.
  const { wallet, owner } = actors();
  const nonce = issueChallengeNonce(ORIGIN);
  const onTestnet = bindingMessage({ origin: ORIGIN, nonce, owner: owner.address, smartAccount: SMART, chainId: 46630 });
  const r = await verifyGrantBinding({
    origin: ORIGIN,
    tenant: wallet.address.toLowerCase() as `0x${string}`,
    nonce,
    owner: owner.address,
    smartAccount: SMART,
    chainId: 4663, // mainnet — not what was signed
    purpose: "spot",
    walletSignature: await wallet.signMessage({ message: onTestnet }),
    ownerSignature: await owner.signMessage({ message: onTestnet }),
  });
  assert.equal(r.ok, false);
});

test("A CLAIM ON ONE WALLET DOES NOT BIND ON THE OTHER: Spot replayed as Perps, and Perps as Spot", async () => {
  // One owner key holds both wallets (Spot at Kernel index 0, Perps at 1), and
  // both claims name the same login, owner, chain and origin. Only the purpose
  // line in the signed text tells them apart, so the server must rebuild the
  // text with the wallet the request is for: a signature made over one
  // wallet's claim recovers to nobody when it is offered for the other.
  for (const [signedFor, offeredAs] of [["spot", "perps"], ["perps", "spot"]] as const) {
    const { wallet, owner } = actors();
    const nonce = issueChallengeNonce(ORIGIN);
    const signed = bindingMessage({ origin: ORIGIN, nonce, owner: owner.address, smartAccount: SMART, chainId: CHAIN, purpose: signedFor });
    const offer = async (purpose: "spot" | "perps") => verifyGrantBinding({
      origin: ORIGIN,
      tenant: wallet.address.toLowerCase() as `0x${string}`,
      nonce,
      owner: owner.address,
      smartAccount: SMART,
      chainId: CHAIN,
      purpose,
      walletSignature: await wallet.signMessage({ message: signed }),
      ownerSignature: await owner.signMessage({ message: signed }),
    });
    const replayed = await offer(offeredAs);
    assert.equal(replayed.ok, false, `${signedFor} replayed as ${offeredAs}`);
    // Refused BEFORE the nonce was spent: the honest claim still goes through.
    const honest = await offer(signedFor);
    assert.equal(honest.ok, true, honest.ok ? "" : honest.why);
  }
});

test("a claim that names no wallet the deployment knows is refused, never read as Spot", async () => {
  const { wallet, owner } = actors();
  const nonce = issueChallengeNonce(ORIGIN);
  const message = bindingMessage({ origin: ORIGIN, nonce, owner: owner.address, smartAccount: SMART, chainId: CHAIN });
  for (const purpose of [undefined, "Spot", "solana", ""]) {
    const r = await verifyGrantBinding({
      origin: ORIGIN,
      tenant: wallet.address.toLowerCase() as `0x${string}`,
      nonce,
      owner: owner.address,
      smartAccount: SMART,
      chainId: CHAIN,
      purpose: purpose as unknown as "spot",
      walletSignature: await wallet.signMessage({ message }),
      ownerSignature: await owner.signMessage({ message }),
    });
    assert.equal(r.ok, false, String(purpose));
    assert.match(r.ok ? "" : r.why, /names a wallet this deployment does not know/);
  }
});
