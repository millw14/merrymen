import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { deferred, json, testDom } from "./test-dom";

const owner = `0x${"1".repeat(40)}`;
const outsider = `0x${"2".repeat(40)}`;
const challenge = { nonce: "single-use-server-nonce", message: "Sign this exact server challenge.\nNonce: single-use-server-nonce" };
type Wallet = {
  address: string;
  walletClientType: string;
  getEthereumProvider: () => Promise<{ request: (input: unknown) => Promise<string> }>;
};
type Call = { url: string; init?: RequestInit };
let PrivySignIn: typeof import("./PrivySignIn").PrivySignIn;
let ui: ReturnType<typeof testDom>;
let ready: boolean;
let authenticated: boolean;
let walletsReady: boolean;
let modalOpen: boolean;
let wallets: Wallet[];
let user: { id: string; twitter: { subject: string; username: string; name: string; profilePictureUrl: string }; linkedAccounts: unknown[] };
let create: () => Promise<unknown>;
let accessToken: () => Promise<string | null>;
let sign: (input: unknown) => Promise<string>;
let respond: (call: Call) => Promise<Response>;
let creations: number;
let tokens: number;
let logins: number;
let logouts: number;
let completed: number;
let requests: Call[];
let signatures: unknown[];
let identity = 0;
let loginError: (error: string) => void;
const originalFetch = globalThis.fetch;
const getAccessToken = () => { tokens++; return accessToken(); };
const createWallet = () => { creations++; return create(); };
const login = () => { logins++; };
const logout = async () => { logouts++; authenticated = false; };
const onDone = () => { completed++; };
const never = () => new Promise<never>(() => undefined);

function connectOwner() {
  user.linkedAccounts = [{ type: "wallet", address: owner, chainType: "ethereum", walletClientType: "privy", connectorType: "embedded" }];
  wallets = [wallet()];
}

function wallet(address = owner, walletClientType = "privy"): Wallet {
  return {
    address,
    walletClientType,
    getEthereumProvider: async () => ({ request: async (input) => { signatures.push(input); return sign(input); } }),
  };
}

const render = () => ui.render(React.createElement(PrivySignIn, { onDone }));
const posts = () => requests.filter(({ init }) => init?.method === "POST");
const primary = () => ui.container.querySelector<HTMLButtonElement>("button.flow-primary")!;
const drain = () => act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
async function advance(ms: number) {
  await act(async () => { mock.timers.tick(ms); });
  await drain();
}

before(() => {
  // Render the production component and request-json implementation. Only the
  // Privy/browser wallet boundary and HTTP transport are faked; this never
  // contacts Privy, creates a real wallet, or signs with a real private key.
  const path = fileURLToPath(new URL("./PrivySignIn.tsx", import.meta.url));
  const require = createRequire(import.meta.url);
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const load = loader._load;
  const intercepted = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename === path) {
      if (id === "@privy-io/react-auth") return {
        usePrivy: () => ({ ready, authenticated, login, logout, getAccessToken, createWallet, user }),
        useWallets: () => ({ ready: walletsReady, wallets }),
        useCreateWallet: () => ({ createWallet }),
        useLogin: (callbacks: { onError?: (error: string) => void }) => {
          loginError = callbacks?.onError ?? (() => undefined);
          return { login };
        },
        useModalStatus: () => ({ isOpen: modalOpen }),
        getEmbeddedConnectedWallet: (list: Wallet[]) => list.find((item) => item.walletClientType === "privy") ?? null,
      };
      if (id === "./HostedControls") return require(fileURLToPath(new URL("./request-json.ts", import.meta.url)));
    }
    return load.call(this, id, parent, isMain);
  });
  try { PrivySignIn = require(path).PrivySignIn; }
  finally { intercepted.mock.restore(); }
});

beforeEach(() => {
  ui = testDom();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  ready = true;
  authenticated = true;
  walletsReady = true;
  modalOpen = false;
  wallets = [];
  user = {
    id: `did:privy:owner-${++identity}`,
    twitter: { subject: "twitter-subject", username: "owner", name: "Owner", profilePictureUrl: "https://example.test/avatar.png" },
    linkedAccounts: [],
  };
  creations = tokens = logins = logouts = completed = 0;
  requests = [];
  signatures = [];
  create = never;
  accessToken = async () => "verified-owner-token";
  sign = async () => "0xsignature";
  respond = async ({ init }) => init?.method === "POST" ? json({ ok: true }) : json(challenge);
  globalThis.fetch = async (input, init) => {
    const call = { url: String(input), init };
    assert.equal(call.url, "/api/auth/privy", "sign-in must use the existing server proof endpoint");
    requests.push(call);
    return respond(call);
  };
});

afterEach(async () => {
  await ui.close();
  mock.timers.reset();
  globalThis.fetch = originalFetch;
});

describe("Privy sign-in wallet provisioning and proof", () => {
  it("waits for Privy readiness before using an otherwise available wallet", async () => {
    ready = false;
    connectOwner();
    await render();
    await drain();
    assert.equal(tokens, 0);
    assert.equal(requests.length, 0);
    ready = true;
    await render();
    await drain();
    assert.equal(completed, 1);
  });

  it("proves the embedded owner with the exact server challenge and access token", async () => {
    connectOwner();
    await render();
    await drain();
    assert.deepEqual(signatures, [{ method: "personal_sign", params: [challenge.message, owner] }]);
    assert.equal(posts().length, 1);
    assert.equal(new Headers(posts()[0].init?.headers).get("Authorization"), "Bearer verified-owner-token");
    assert.deepEqual(JSON.parse(String(posts()[0].init?.body)), {
      nonce: challenge.nonce,
      signature: "0xsignature",
      provider: "twitter",
      subject: "twitter-subject",
      handle: "owner",
      displayName: "Owner",
      avatarUrl: "https://example.test/avatar.png",
    });
    assert.equal(completed, 1);
    assert.equal(creations, 0, "an existing embedded owner must never be replaced");
  });

  it("ignores an external wallet even when it is first in the SDK list", async () => {
    connectOwner();
    wallets = [wallet(outsider, "metamask"), ...wallets];
    await render();
    await drain();
    assert.deepEqual(signatures, [{ method: "personal_sign", params: [challenge.message, owner] }]);
    assert.equal(completed, 1);
    assert.equal(creations, 0);
  });

  it("waits for SDK hydration and recovers when the embedded wallet arrives", async () => {
    walletsReady = false;
    await render();
    await advance(1_000);
    assert.equal(creations, 0);
    assert.equal(requests.length, 0);
    assert.equal(primary().disabled, true);
    walletsReady = true;
    connectOwner();
    await render();
    await drain();
    assert.equal(completed, 1);
    assert.equal(creations, 0);
  });

  it("lets an active Privy login modal finish before explicitly creating a wallet", async () => {
    modalOpen = true;
    await render();
    await advance(10_000);
    assert.equal(creations, 0);
    modalOpen = false;
    await render();
    await drain();
    assert.equal(creations, 1);
  });

  it("does not replace a previously linked embedded wallet while its connection recovers", async () => {
    connectOwner();
    wallets = [];
    await render();
    await advance(10_000);
    assert.equal(creations, 0, "a disconnected owner is not a missing owner");
    wallets = [wallet()];
    await render();
    await drain();
    assert.equal(completed, 1);
    assert.equal(creations, 0);
  });

  it("does not sign with an embedded wallet belonging to a different SDK user", async () => {
    connectOwner();
    wallets = [wallet(outsider)];
    await render();
    await advance(10_000);
    assert.equal(signatures.length, 0);
    assert.equal(posts().length, 0);
    assert.equal(creations, 0);
  });

  for (const linkedWallet of [
    { walletClientType: "privy-v2" },
    { walletClientType: "privy", imported: true },
  ]) {
    it(`does not replace a disconnected ${linkedWallet.imported ? "imported" : "privy-v2"} owner`, async () => {
      user.linkedAccounts = [{ type: "wallet", chainType: "ethereum", address: owner, ...linkedWallet }];
      await render();
      await advance(120_000);
      assert.equal(creations, 0);
      assert.equal(posts().length, 0);
      assert.ok(ui.container.querySelector('[role="alert"]'));
      assert.equal(primary().disabled, false);
    });
  }

  it("reuses a successful creation across remounts while linked-account metadata catches up", async () => {
    create = async () => ({ address: owner });
    await render();
    await drain();
    assert.equal(creations, 1);
    wallets = [wallet()];
    await render();
    await drain();
    assert.equal(completed, 1, "the creation result identifies the owner before linkedAccounts updates");
    await ui.remount(React.createElement(PrivySignIn, { onDone }));
    await drain();
    assert.equal(creations, 1, "a successful first-wallet creation remains shared across mounts");
    assert.equal(completed, 2);
  });

  it("creates only once through StrictMode effect replay", async () => {
    create = async () => ({ address: owner });
    const strict = () => React.createElement(React.StrictMode, null, React.createElement(PrivySignIn, { onDone }));
    await ui.render(strict());
    await drain();
    assert.equal(creations, 1);
    wallets = [wallet()];
    await ui.render(strict());
    await drain();
    assert.equal(completed, 1);
    assert.equal(posts().length, 1);
  });

  it("recovers the reported authenticated-but-missing-wallet state by creating once", async () => {
    await render();
    await advance(10_000);
    assert.equal(creations, 1, "a hydrated authenticated account cannot wait forever for createOnLogin");
    assert.equal(requests.length, 0, "no proof is possible before an embedded signer exists");
    await render();
    await advance(1_000);
    assert.equal(creations, 1, "rerenders must not create duplicate wallets");
    connectOwner();
    await render();
    await drain();
    assert.equal(completed, 1);
    assert.equal(posts().length, 1);
  });

  it("never signs with an external wallet when no embedded owner is available", async () => {
    wallets = [wallet(outsider, "metamask")];
    await render();
    await advance(10_000);
    assert.equal(signatures.length, 0);
    assert.equal(posts().length, 0);
    assert.equal(completed, 0);
  });

  it("shows a creation failure with enabled retry and start-over instead of an automatic loop", async () => {
    create = async () => { if (creations > 1) return never(); throw new Error("Wallet creation temporarily unavailable."); };
    await render();
    await advance(10_000);
    assert.equal(creations, 1);
    assert.match(ui.container.querySelector('[role="alert"]')?.textContent ?? "", /wallet|creat/i);
    assert.equal(primary().disabled, false);
    assert.ok(Array.from(ui.container.querySelectorAll("button")).some((b) => b.textContent === "Start over" && !b.disabled));
    await advance(10_000);
    assert.equal(creations, 1, "failure must wait for the owner's deliberate retry");
    create = never;
    await ui.click(primary().textContent!.trim());
    await advance(10_000);
    assert.equal(creations, 2, "a deliberate retry starts exactly one new creation attempt");
  });

  it("exits a stalled creation with a visible remedy after a bounded wait", async () => {
    await render();
    await advance(10_000);
    await advance(120_000);
    assert.equal(creations, 1);
    assert.ok(ui.container.querySelector('[role="alert"]'), "the owner must not remain stranded on Creating your wallet");
    assert.equal(primary().disabled, false);
    assert.equal(completed, 0);
    assert.equal(posts().length, 0);
  });

  it("coalesces an unresolved creation across retries and remounts for the same owner", async () => {
    const pending = deferred<{ address: string }>();
    create = () => pending.promise;
    await render();
    await advance(10_000);
    assert.equal(creations, 1);
    await ui.remount(React.createElement(PrivySignIn, { onDone }));
    await advance(10_000);
    assert.equal(creations, 1, "remounting cannot begin a second wallet creation");
    await advance(120_000);
    assert.equal(primary().disabled, false);
    await ui.click(primary().textContent!.trim());
    await drain();
    assert.equal(creations, 1, "retry must rejoin creation when the SDK has not resolved it");
    await act(async () => { pending.resolve({ address: owner }); });
    connectOwner();
    await render();
    await drain();
    assert.equal(completed, 1);
  });

  it("returns to an enabled action when login is cancelled or refused", async () => {
    authenticated = false;
    await render();
    await ui.click("Continue with X");
    assert.equal(logins, 1);
    await act(async () => { loginError("exited_auth_flow"); });
    assert.equal(primary().disabled, false);
    assert.equal(creations, 0);
    assert.equal(requests.length, 0);
  });

  it("can start over while wallet creation is still pending", async () => {
    await render();
    await advance(10_000);
    await ui.click("Start over");
    await render();
    assert.equal(logouts, 1);
    assert.equal(primary().disabled, false);
    assert.equal(completed, 0);
  });

  it("does not restart a refused signature without a deliberate retry", async () => {
    connectOwner();
    sign = async () => { if (signatures.length > 1) return never(); throw new Error("Signature was declined."); };
    await render();
    await drain();
    assert.equal(signatures.length, 1);
    assert.match(ui.container.querySelector('[role="alert"]')?.textContent ?? "", /declined|sign/i);
    assert.equal(primary().disabled, false);
    await render();
    await advance(10_000);
    assert.equal(signatures.length, 1, "a rejected proof must not immediately prompt for another signature");
    assert.equal(posts().length, 0);
    assert.equal(completed, 0);
    sign = async () => "0xretried-signature";
    await ui.click(primary().textContent!.trim());
    await drain();
    assert.equal(signatures.length, 2);
    assert.equal(completed, 1);
  });

  it("times out a stalled proof and ignores its eventual signature", async () => {
    connectOwner();
    const delayed = deferred<string>();
    sign = () => delayed.promise;
    await render();
    await drain();
    assert.equal(signatures.length, 1);
    await advance(120_000);
    assert.ok(ui.container.querySelector('[role="alert"]'));
    assert.equal(primary().disabled, false);
    await act(async () => { delayed.resolve("0xlate-signature"); });
    await drain();
    assert.equal(posts().length, 0);
    assert.equal(completed, 0);
  });

  it("leaves a rejected server proof for deliberate retry using a fresh challenge", async () => {
    connectOwner();
    sign = async () => signatures.length > 1 ? never() : "0xsignature";
    respond = async ({ init }) => init?.method === "POST" ? json({ error: "Sign-in expired. Try again." }, 401) : json(challenge);
    await render();
    await drain();
    assert.equal(posts().length, 1);
    assert.equal(signatures.length, 1);
    assert.equal(primary().disabled, false);
    assert.match(ui.container.querySelector('[role="alert"]')?.textContent ?? "", /expired/i);
    assert.equal(completed, 0);
    sign = async () => "0xretried-signature";
    respond = async ({ init }) => init?.method === "POST" ? json({ ok: true }) : json({ ...challenge, nonce: "fresh-nonce" });
    await ui.click(primary().textContent!.trim());
    await drain();
    assert.equal(requests.filter(({ init }) => init?.method !== "POST").length, 2);
    assert.equal(JSON.parse(String(posts()[1].init?.body)).nonce, "fresh-nonce");
    assert.equal(completed, 1);
  });

  it("does not finish an abandoned attempt when a submitted proof returns late", async () => {
    connectOwner();
    const response = deferred<Response>();
    respond = async ({ init }) => init?.method === "POST" ? response.promise : json(challenge);
    await render();
    await drain();
    assert.equal(posts().length, 1);
    authenticated = false;
    await render();
    assert.equal(posts()[0].init?.signal?.aborted, true, "logout must also cancel the pending HTTP request");
    await act(async () => { response.resolve(json({ ok: true })); });
    await drain();
    assert.equal(completed, 0);
  });

  it("does not use a token resolved after the SDK has switched users", async () => {
    connectOwner();
    const delayed = deferred<string>();
    accessToken = () => delayed.promise;
    await render();
    await drain();
    user = { ...user, id: "did:privy:another-owner", linkedAccounts: [] };
    await render();
    await act(async () => { delayed.resolve("old-users-token"); });
    await drain();
    assert.equal(signatures.length, 0);
    assert.equal(posts().length, 0);
    assert.equal(completed, 0);
  });

  for (const stage of ["token", "signature"] as const) {
    for (const interruptedBy of ["logout", "unmount"] as const) {
      it(`ignores a late ${stage} after ${interruptedBy}`, async () => {
        connectOwner();
        const delayed = deferred<string>();
        if (stage === "token") accessToken = () => delayed.promise;
        else sign = () => delayed.promise;
        await render();
        await drain();
        assert.equal(tokens, 1);
        if (stage === "signature") assert.equal(signatures.length, 1);
        if (interruptedBy === "logout") { authenticated = false; await render(); }
        else await ui.render(null);
        await act(async () => { delayed.resolve(stage === "token" ? "stale-token" : "0xstale-signature"); });
        await drain();
        assert.equal(posts().length, 0, "an abandoned attempt cannot mint a server session");
        assert.equal(completed, 0, "an abandoned attempt cannot finish onboarding");
        if (stage === "token") assert.equal(signatures.length, 0);
      });
    }
  }
});
