import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { before, beforeEach, afterEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { deferred, testDom } from "./test-dom";

type Hook = ReturnType<typeof import("./useSolanaOwner").useSolanaOwner>;
let useSolanaOwner: typeof import("./useSolanaOwner").useSolanaOwner;
let hook: Hook;
let ui: ReturnType<typeof testDom>;
let did: string, authenticated: boolean, ready: boolean;
let wallets: Array<{ address: string }>, accounts: Array<Record<string, unknown>>;
let signed: string[], creates: number, exported: Array<{ address: string } | undefined>;
let signing: (input: { wallet: { address: string } }) => Promise<{ signature: Uint8Array }>;
const OWNER = "So11111111111111111111111111111111111111112";
before(() => {
  const path = fileURLToPath(new URL("./useSolanaOwner.ts", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const original = loader._load;
  const interception = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename === path) {
      if (id === "@privy-io/react-auth") return { usePrivy: () => ({ authenticated, ready: true, user: { id: did, linkedAccounts: accounts }, getAccessToken: async () => "token" }) };
      if (id === "@privy-io/react-auth/solana") return {
        useWallets: () => ({ wallets, ready }), useCreateWallet: () => ({ createWallet: async () => { creates++; return {}; } }),
        useExportWallet: () => ({ exportWallet: async (options?: { address: string }) => { exported.push(options); } }),
        useSignMessage: () => ({ signMessage: signing }), useSignTransaction: () => ({ signTransaction: async (input: { wallet: { address: string } }) => {
          const result = await signing(input); return { signedTransaction: result.signature };
        } }),
      };
    }
    return original.call(this, id, parent, isMain);
  });
  try { useSolanaOwner = createRequire(import.meta.url)(path).useSolanaOwner; }
  finally { interception.mock.restore(); }
});
function Probe() { hook = useSolanaOwner(); return React.createElement("span", null, hook.address ?? "none"); }
const render = () => ui.render(React.createElement(Probe));
beforeEach(() => {
  ui = testDom(); did = "did:privy:alice"; authenticated = true; ready = true; creates = 0; signed = []; exported = [];
  wallets = [{ address: "external" }, { address: OWNER }];
  accounts = [{ type: "wallet", chainType: "solana", walletClientType: "privy", address: OWNER }];
  signing = async (input) => { signed.push(input.wallet.address); return { signature: new Uint8Array(64).fill(4) }; };
});
afterEach(async () => ui.close());
test("the Solana signer selects the exact linked embedded owner, never the first external wallet", async () => {
  await render(); assert.equal(hook.address, OWNER);
  await hook.signBinding("proof"); assert.deepEqual(signed, [OWNER]);
  accounts = [{ type: "wallet", chainType: "ethereum", walletClientType: "privy", address: OWNER }];
  await render(); assert.equal(hook.address, null);
  await assert.rejects(hook.signSetup(new Uint8Array([1])));
});
test("ambiguous wallets and case-mismatched addresses cannot select an owner", async () => {
  wallets.push({ address: "second" }); accounts.push({ type: "wallet", chainType: "solana", walletClientType: "privy", address: "second" });
  await render(); assert.equal(hook.ambiguous, true); assert.equal(hook.address, null);
  await assert.rejects(hook.signBinding("proof"));
  accounts = [{ type: "wallet", chainType: "solana", walletClientType: "privy", address: OWNER.toLowerCase() }];
  await render(); assert.equal(hook.address, null); assert.deepEqual(signed, []);
});
test("changing identity while a wallet signature is pending discards the result", async () => {
  const wait = deferred<{ signature: Uint8Array }>(); signing = async () => wait.promise;
  await render(); const previous = hook;
  const pending = previous.signBinding("proof");
  did = "did:privy:bob"; await render();
  wait.resolve({ signature: new Uint8Array(64) });
  await assert.rejects(pending, /account changed/);
  await assert.rejects(previous.signSetup(new Uint8Array([1])), /account changed/);
});
test("wallet creation is deduplicated per identity and signed-out users cannot create", async () => {
  did = "did:privy:create-dedupe"; accounts = []; wallets = []; await render();
  await Promise.all([hook.create(), hook.create()]); assert.equal(creates, 1);
  authenticated = false; await render(); await assert.rejects(hook.create());
  assert.equal(hook.address, null);
});
test("key export opens Privy's window for the exact embedded owner only", async () => {
  await render();
  await hook.exportKey();
  assert.deepEqual(exported, [{ address: OWNER }]);
  // Never an implicit "first wallet" export: Privy's default with no address.
  wallets.push({ address: "second" }); accounts.push({ type: "wallet", chainType: "solana", walletClientType: "privy", address: "second" });
  await render(); await assert.rejects(hook.exportKey(), /account changed/);
  accounts = [{ type: "wallet", chainType: "solana", walletClientType: "privy", address: OWNER }]; wallets = [{ address: OWNER }];
  authenticated = false; await render(); await assert.rejects(hook.exportKey());
  assert.deepEqual(exported, [{ address: OWNER }]);
});
