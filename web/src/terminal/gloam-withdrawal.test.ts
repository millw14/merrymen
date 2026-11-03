import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { parseUnits, type Address, type Hex, type LocalAccount } from "viem";
import type { Root } from "react-dom/client";
import type { BrowserWallet } from "../lib/recover-client";
import type { GloamWithdrawalRecord } from "../lib/gloam-withdrawal";
import type * as WithdrawalClient from "../lib/gloam-withdrawal-client";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const OWNER = "0x2222222222222222222222222222222222222222" as Address;
const RECEIVE = "gloamr1.OwnerReceiveAddressForViewTest";
const HASH = `0x${"ab".repeat(32)}` as Hex;
const wallet: BrowserWallet = {
  smartAccount: ACCOUNT,
  chainId: 4663,
  // The view reads only presence, never invokes a wallet. No test key exists.
  ownerAccount: { address: OWNER, type: "local" } as LocalAccount,
};

function record(state: GloamWithdrawalRecord["state"] = "prepared"): GloamWithdrawalRecord {
  return {
    version: 1, account: ACCOUNT, chainId: 4663, amount: "17250000", receiveTag: RECEIVE,
    commitment: `0x${"cd".repeat(32)}`, memo: "0x00", hash: HASH,
    state, createdAt: "2026-10-29T12:00:00.000Z",
    operation: {
      sender: ACCOUNT, nonce: "0x0", callData: "0x", signature: "0x01",
      callGasLimit: "0x186a0", verificationGasLimit: "0x186a0", preVerificationGas: "0x186a0",
      maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x3b9aca00",
    },
  };
}

function fakeClient(initial: GloamWithdrawalRecord | null = null) {
  let saved = initial;
  const prepares: { wallet: BrowserWallet; receiveTag: string; amount: string }[] = [];
  const approvals: { wallet: BrowserWallet; hash: Hex }[] = [];
  let clears = 0;
  let loseFirstReceipt = false;
  const api: typeof WithdrawalClient = {
    loadGloamWithdrawal(account) {
      assert.equal(account, ACCOUNT);
      return saved;
    },
    async prepareGloamWithdrawal(w, receiveTag, amount) {
      prepares.push({ wallet: w, receiveTag, amount });
      assert.equal(saved, null, "an existing payment must never be overwritten");
      saved = { ...record(), amount: parseUnits(amount, 6).toString(), receiveTag };
      return saved;
    },
    async approveGloamWithdrawal(w, hash) {
      approvals.push({ wallet: w, hash });
      assert.ok(saved);
      assert.equal(hash, saved.hash);
      if (loseFirstReceipt && approvals.length === 1) {
        saved = { ...saved, state: "signed" };
        throw new Error("The connection was lost after submission. Check the saved withdrawal.");
      }
      saved = { ...saved, state: "confirmed", transactionHash: `0x${"ef".repeat(32)}` };
      return saved;
    },
    async clearGloamWithdrawal() { clears += 1; saved = null; },
  };
  return {
    client: async () => api,
    prepares, approvals,
    saved: () => saved,
    clears: () => clears,
    loseReceipt: () => { loseFirstReceipt = true; },
  };
}

let dom: JSDOM;
let root: Root | undefined;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client")["createRoot"];
let View: typeof import("./GloamWithdrawal")["GloamWithdrawalView"];
let Wrapper: typeof import("./GloamWithdrawal")["GloamWithdrawal"];
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const oldFlag = process.env.NEXT_PUBLIC_GLOAM_WITHDRAWALS_ENABLED;

before(async () => {
  dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", {
    url: "https://app.merrymen.dev/withdraw", pretendToBeVisual: true,
  });
  function setGlobal(name: string, value: unknown) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "localStorage", "getComputedStyle"]) {
    setGlobal(name, (dom.window as unknown as Record<string, unknown>)[name]);
  }
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("fetch", async () => { throw new Error("Mounted withdrawal tests must not contact a network"); });
  React = await import("react");
  setGlobal("React", React); // tsx's classic transform for Next's jsx:preserve.
  createRoot = (await import("react-dom/client")).createRoot;
  process.env.NEXT_PUBLIC_GLOAM_WITHDRAWALS_ENABLED = "1";
  ({ GloamWithdrawalView: View, GloamWithdrawal: Wrapper } = await import("./GloamWithdrawal"));
});

afterEach(async () => {
  if (root) await React.act(async () => root!.unmount());
  root = undefined;
  dom.window.document.getElementById("root")!.replaceChildren();
});

after(() => {
  dom.window.close();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  if (oldFlag === undefined) delete process.env.NEXT_PUBLIC_GLOAM_WITHDRAWALS_ENABLED;
  else process.env.NEXT_PUBLIC_GLOAM_WITHDRAWALS_ENABLED = oldFlag;
});

const container = () => dom.window.document.getElementById("root")!;
function button(text: RegExp): HTMLButtonElement {
  const b = [...container().querySelectorAll("button")].find((element) => text.test(element.textContent ?? ""));
  assert.ok(b, `Expected button ${text}`);
  return b;
}
async function click(element: HTMLElement) {
  await React.act(async () => element.click());
}
async function mount(fake: ReturnType<typeof fakeClient>, w = wallet) {
  root = createRoot(container());
  await React.act(async () => root!.render(React.createElement(View, { wallet: w, client: fake.client })));
}
async function fill(id: string, value: string) {
  const element = container().querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
  assert.ok(element);
  const prototype = element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function prepare(fake: ReturnType<typeof fakeClient>) {
  await mount(fake);
  await click(button(/^Withdraw USDG to Gloam$/));
  await fill("gloam-amount", "17.25");
  await fill("gloam-recipient", RECEIVE);
  await click(button(/^Review withdrawal$/));
}

test("the owner reviews the exact amount and destination, then explicitly confirms before approval", async () => {
  const fake = fakeClient();
  await mount(fake);
  assert.equal(fake.prepares.length, 0);
  assert.equal(fake.approvals.length, 0);
  await click(button(/^Withdraw USDG to Gloam$/));
  assert.equal(container().querySelector('input[type="checkbox"]'), null);
  assert.ok(![...container().querySelectorAll("button")].some((b) => /^Approve /.test(b.textContent ?? "")));
  await fill("gloam-amount", "17.25");
  await fill("gloam-recipient", RECEIVE);
  assert.equal(fake.prepares.length, 0, "typing is not preparation or approval");
  await click(button(/^Review withdrawal$/));
  assert.deepEqual(fake.prepares, [{ wallet, receiveTag: RECEIVE, amount: "17.25" }]);
  assert.equal(fake.approvals.length, 0, "review must not sign");
  assert.match(container().textContent ?? "", /17\.25 USDG/);
  assert.ok(container().textContent!.includes(RECEIVE));
  assert.ok(container().textContent!.includes(ACCOUNT));
  assert.match(container().textContent ?? "", /Robinhood Chain mainnet/);
  assert.match(container().textContent ?? "", /0\.0003 ETH/);
  const approve = button(/^Approve 17\.25 USDG withdrawal$/);
  assert.equal(approve.disabled, true);
  await click(approve);
  assert.equal(fake.approvals.length, 0, "disabled approval must not reach the signer");
  const checkbox = container().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await click(checkbox);
  assert.equal(button(/^Approve /).disabled, false);
  await click(button(/^Approve /));
  assert.deepEqual(fake.approvals, [{ wallet, hash: HASH }]);
  assert.match(container().textContent ?? "", /Deposit confirmed/);
});

test("a lost receipt and reload preserve the signed payment and offer only checking that payment", async () => {
  const fake = fakeClient();
  fake.loseReceipt();
  await prepare(fake);
  await click(container().querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button(/^Approve /));
  assert.equal(fake.saved()?.state, "signed");
  assert.match(container().textContent ?? "", /connection was lost/);
  assert.ok(button(/^Check saved withdrawal$/));
  assert.equal(container().querySelector("form"), null);
  assert.ok(![...container().querySelectorAll("button")].some((b) => /Start another|Cancel unsigned/.test(b.textContent ?? "")));
  await React.act(async () => root!.unmount());
  root = undefined;
  await mount(fake);
  assert.ok(button(/^Check saved withdrawal$/), "a saved signed payment opens automatically after reload");
  assert.equal(container().querySelector("form"), null);
  await click(button(/^Check saved withdrawal$/));
  assert.equal(fake.prepares.length, 1, "reload and check must not create a new note");
  assert.equal(fake.clears(), 0);
  assert.deepEqual(fake.approvals.map((a) => a.hash), [HASH, HASH]);
  assert.match(container().textContent ?? "", /Deposit confirmed/);
});

test("a restored unsigned review still requires fresh owner confirmation", async () => {
  const fake = fakeClient(record());
  await mount(fake);
  assert.equal(button(/^Approve /).disabled, true);
  assert.equal(container().querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false);
  await click(button(/^Approve /));
  assert.equal(fake.approvals.length, 0);
  assert.equal(fake.prepares.length, 0);
});

test("without an owner signer the view cannot review or approve a withdrawal", async () => {
  const fake = fakeClient();
  await mount(fake, { smartAccount: ACCOUNT, chainId: 4663 });
  await click(button(/^Withdraw USDG to Gloam$/));
  assert.match(container().textContent ?? "", /Sign in with this agent’s owner wallet/);
  assert.equal(button(/^Review withdrawal$/).disabled, true);
  await click(button(/^Review withdrawal$/));
  assert.equal(fake.prepares.length, 0);
  assert.equal(fake.approvals.length, 0);
});

test("the enabled public wrapper renders nothing on another chain without mounting Privy", async () => {
  root = createRoot(container());
  await React.act(async () => root!.render(React.createElement(Wrapper, { account: ACCOUNT, chainId: 46630 })));
  assert.equal(container().textContent, "");
  assert.equal(container().querySelector("button"), null);
});
