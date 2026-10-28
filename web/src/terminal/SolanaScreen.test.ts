import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, test, mock } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { ed25519 } from "@noble/curves/ed25519";
import { address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Blockhash, type Instruction } from "@solana/kit";
import { base58Encode, CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../../packages/core/src/ids";
import { buildCreateSolanaSessionInstruction, buildInitializeSolanaVaultInstruction, buildRevokeSolanaSessionsInstruction, buildSetSolanaBreakerInstruction,
  buildWithdrawSolanaNativeInstruction, buildWithdrawSolanaVaultInstruction, deriveSolanaAta, deriveSolanaVaultAddress, SOLANA_ASSOCIATED_TOKEN_PROGRAM,
  SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../../packages/core/src/solana-live";
import { JSDOM } from "jsdom";
import { runSolanaRecoverCommand } from "../../../worker/src/solana-recover-command";
import { SOLANA_VAULT_RELEASES as TOOL_RELEASES, solanaRecoveryProgramTrust } from "../../../worker/src/solana-recover";
import { SOLANA_OTHER_SIGN_IN } from "../lib/solana-sign-in";
import { SOLANA_LIVE_PER_TRADE_BELOW_MINIMUM, SOLANA_REGISTERED_AFTER_REVOKE } from "../../../packages/core/src/solana";
import { SOLANA_LIVE_CAP_DEFAULTS, SOLANA_LIVE_NOT_OPEN, SOLANA_LIVE_PAUSED, SOLANA_LIVE_PAUSED_NO_PERMISSION, SOLANA_LIVE_ROLLOUT_DIFFERS, SOLANA_LIVE_ROLLOUT_MISCONFIGURED,
  SOLANA_LIVE_ROLLOUT_MISCONFIGURED_NO_PERMISSION, solanaLiveCapRefusal, solanaLiveSavedAboveCaps, solanaLiveSessionAboveCaps } from "../lib/solana-live-caps";

const OWNER = "So11111111111111111111111111111111111111112";
const TENANT = `0x${"11".repeat(20)}`;
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: Date.now() + 3_600_000 };
const paper = { cashRaw: "1000000000", positions: [] };
const PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM;
/** Saved live limits: 10 USDG a trade, 50 a day, 0.25/1 SOL sold, 7 days. */
const liveLimits = () => ({ ...limits, perTradeWsol: "250000000", dailyWsol: "1000000000", expiresAtMs: Date.now() + 168 * 3_600_000 });
/** CreateIdempotent for `wallet`'s token account of `mint`, paid by the owner, as prepareLive builds it. */
async function createAta(wallet: string, mint: string): Promise<Instruction> {
  const program = mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM;
  return { programAddress: address(SOLANA_ASSOCIATED_TOKEN_PROGRAM), data: Uint8Array.of(1), accounts: [
    { address: address(OWNER), role: 3 }, { address: address(await deriveSolanaAta(wallet, mint, program)), role: 1 }, { address: address(wallet), role: 0 },
    { address: address(mint), role: 0 }, { address: address(SOLANA_SYSTEM_PROGRAM), role: 0 }, { address: address(program), role: 0 }] };
}
/** The registration the server prepares from the saved limits, as real wire bytes (the real builder's are in SolanaServerContract.test.ts). */
async function permissionTransaction(session: string, signed: ReturnType<typeof liveLimits>, extra: Instruction[] = []) {
  const vault = await deriveSolanaVaultAddress(PROGRAM, OWNER);
  const instructions = [buildInitializeSolanaVaultInstruction({ programAddress: PROGRAM, vault, owner: OWNER }),
    await createAta(vault, SOLANA_USDG_MINT), await createAta(vault, SOLANA_WRAPPED_SOL_MINT), await createAta(OWNER, SOLANA_USDG_MINT), await createAta(OWNER, SOLANA_WRAPPED_SOL_MINT),
    buildCreateSolanaSessionInstruction({ programAddress: PROGRAM, vault, owner: OWNER, session, perTrade: BigInt(signed.perTradeUsdg), daily: BigInt(signed.dailyUsdg),
      perTradeWsol: BigInt(signed.perTradeWsol), dailyWsol: BigInt(signed.dailyWsol), maxOps: signed.maxOpsPerDay, expiresAt: BigInt(Math.floor(signed.expiresAtMs / 1000)) }), ...extra];
  return { transactionBase64: ownerPaid(instructions), vault, programId: PROGRAM, session, expiresAtMs: Date.now() + 60_000 };
}
/** A v0 transaction the owner pays for, as wire bytes. */
function ownerPaid(instructions: Instruction[]): string {
  const message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: address("11111111111111111111111111111111") as unknown as Blockhash, lastValidBlockHeight: 1n },
    setTransactionMessageFeePayer(address(OWNER), appendTransactionMessageInstructions(instructions, createTransactionMessage({ version: 0 }))));
  return getBase64EncodedWireTransaction(compileTransaction(message));
}
/**
 * The owner transaction the runtime prepares for an owner route `body`, as
 * real wire bytes for OWNER's vault of the status's program, after `before`
 * (a priority fee, say). SolanaServerContract.test.ts runs the server's own
 * through the same page check.
 */
async function ownerBytes(body: Record<string, unknown> | undefined, before: Instruction[] = []): Promise<string> {
  const programAddress = state.runtime.live.programId!, vault = await deriveSolanaVaultAddress(programAddress, OWNER), amount = () => BigInt(String(body!.amountRaw));
  let instructions: Instruction[];
  if (body?.action === "revoke") instructions = [buildRevokeSolanaSessionsInstruction({ programAddress, vault, owner: OWNER })];
  else if (body?.action === "resume-buys") instructions = [buildSetSolanaBreakerInstruction({ programAddress, vault, authority: OWNER, paused: false })];
  else if (body?.action === "withdraw-sol") instructions = [buildWithdrawSolanaNativeInstruction({ programAddress, vault, owner: OWNER, amount: amount() })];
  else if (body?.action === "withdraw") {
    const mint = String(body.mint), tokenProgram = mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM;
    instructions = [await createAta(OWNER, mint), buildWithdrawSolanaVaultInstruction({ programAddress, vault, owner: OWNER, mint, tokenProgram,
      vaultToken: await deriveSolanaAta(vault, mint, tokenProgram), ownerToken: await deriveSolanaAta(OWNER, mint, tokenProgram), amount: amount() })];
  } else throw new Error("Unexpected owner action");
  return ownerPaid([...before, ...instructions]);
}
/** The owner route's prepare answer for `body`, with real bytes. */
const prepareAnswer = async (body: Record<string, unknown> | undefined) => json({ prepared: { transactionBase64: await ownerBytes(body) } });
/** Types into the input whose label starts with `label`, the way a person does. */
async function type(label: string, value: string) {
  const input = [...ui.container.querySelectorAll("label")].find((item) => item.textContent?.startsWith(label))!.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true })); });
}
/** Clicks, then lets work outside React's microtasks (WebCrypto for the vault address) finish. */
async function press(text: string) {
  await ui.click(text);
  await settle();
}
/** True while the page says it is working: owner controls (aria-busy) or the account's own requests (Refresh account disabled). */
const pageBusy = () => !!ui.container.querySelector('[aria-busy="true"]')
  || [...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Refresh account" && item.disabled);
/** The real clock's setTimeout, kept before any test mocks the page's timers (mock.timers). */
const realSetTimeout = globalThis.setTimeout;
/**
 * Lets the page finish what a click or a settled promise started (submit,
 * refresh, WebCrypto for vault and token account addresses): 20 timer turns,
 * then more while the page is still busy, up to a bound, so a slow machine
 * does not fail a test. Not while the fixture wallet is open: the page waits
 * on it, and the test decides when it answers. Its turns are on the real
 * clock, so it works the same while a test drives the page's own timers and
 * Date with mock.timers: those move only when the test ticks them.
 */
async function settle() {
  const turn = () => act(async () => { await new Promise((resolve) => realSetTimeout(resolve, 1)); });
  for (let i = 0; i < 20; i++) await turn();
  for (let i = 0; i < 2_000 && walletOpen === 0 && pageBusy(); i++) await turn();
}
/** Presses an owner action, then signs the transaction it prepared once the review shows it, as an owner does. */
async function ownerPress(text: string) {
  await press(text);
  if ([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Sign with my wallet")) await press("Sign with my wallet");
}
/** Registers in the page's two steps: prepare and review, then sign with the wallet. */
async function register() {
  await press("Register bounded trading permission");
  if ([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Sign permission with my wallet")) await press("Sign permission with my wallet");
}
const field = (label: string) => [...ui.container.querySelectorAll("label")].find((item) => item.textContent?.startsWith(label))!.querySelector("input")!.value;
let SolanaScreen: typeof import("./SolanaScreen").SolanaScreen, screen: typeof import("./SolanaScreen");
const recoveryPath = fileURLToPath(new URL("./SolanaRecovery.tsx", import.meta.url));
let testDom: typeof import("./test-dom").testDom, json: typeof import("./test-dom").json, deferred: typeof import("./test-dom").deferred;
let ui: ReturnType<typeof testDom>;
let state: ReturnType<typeof initial>;
let calls: Array<{ path: string; body: Record<string, unknown> | undefined }>;
let signCount: number, exportCount = 0;
/** Wallet signature requests the fixture has not answered yet. */
let walletOpen = 0;
/** What the fixture wallet returns for a signature request (a promise: the wallet stays open until it settles). */
let signedBytes: () => Uint8Array | Promise<Uint8Array>;
let signerDid = "did:privy:alice";
/** The release pin SolanaRecovery reads (SOLANA_VAULT_RELEASES); undefined reads the real one. */
let releases: Array<{ programId: string; sha256: string }> | undefined;
let respond: (path: string, body: Record<string, unknown> | undefined) => Promise<Response>;
const originalFetch = globalThis.fetch;
function initial(mode: "paper" | "live" = "paper") {
  return { binding: { tenant: TENANT, owner: OWNER, did: signerDid, chain: CHAINS.solana, requestedMode: mode, limits, revision: 0, createdAtMs: 1, updatedAtMs: 1 },
    runtime: { owner: OWNER, requestedMode: mode, paper: null as typeof paper | null, limits,
      live: { ready: false, blockers: ["Deploy and verify the vault program before enabling live trading."], programId: null as string | null, vault: null, session: null, pending: [] } } };
}
before(async () => {
  // React DOM checks input-event support when it first loads. Supply a DOM
  // before importing the harness so typing exercises real React onChange.
  const boot = new JSDOM("<!doctype html><p></p>", { pretendToBeVisual: true });
  Object.assign(globalThis as Record<string, unknown>, { window: boot.window, document: boot.window.document });
  ({ testDom, json, deferred } = await import("./test-dom"));
  const path = fileURLToPath(new URL("./SolanaScreen.tsx", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const original = loader._load;
  const intercept = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    // The recovery card's release pin, as a test sets it.
    if (parent?.filename === recoveryPath && id === "../../../packages/core/src/solana-live") {
      const real = original.call(this, id, parent, isMain) as Record<string, unknown>;
      const pinned = { ...real };
      Object.defineProperty(pinned, "SOLANA_VAULT_RELEASES", { enumerable: true, get: () => releases ?? Reflect.get(real, "SOLANA_VAULT_RELEASES") });
      return pinned;
    }
    if (parent?.filename === path) {
      if (id === "./SolanaScreen.css") return {};
      if (id === "@/lib/privy-client") return { privyEnabled: () => true };
      if (id === "./HostedControls") return { SignIn: () => React.createElement("p", null, "Sign in") };
      if (id === "./useSolanaOwner") return { useSolanaOwner: () => ({
        ready: true, authenticated: true, did: signerDid, address: OWNER, ambiguous: false,
        getAccessToken: async () => "fixture-token", create: async () => {}, signBinding: async () => "fixture-signature",
        signSetup: async () => { signCount++; walletOpen++; try { return await signedBytes(); } finally { walletOpen--; } },
        exportKey: async () => { exportCount++; },
      }) };
    }
    return original.call(this, id, parent, isMain);
  });
  try { screen = createRequire(import.meta.url)(path); SolanaScreen = screen.SolanaScreen; }
  finally { intercept.mock.restore(); }
});
beforeEach(() => {
  ui = testDom(); signerDid = "did:privy:alice"; state = initial(); calls = []; signCount = 0; exportCount = 0; walletOpen = 0; signedBytes = () => Uint8Array.from([1, 2, 3]); releases = undefined;
  respond = async (path) => { if (path === "status") return json(state); throw new Error("Unexpected fixture route"); };
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
    const path = String(url).replace("/api/solana/", "");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, body }); return respond(path, body);
  };
});
afterEach(async () => { globalThis.fetch = originalFetch; await ui.close(); });
const render = () => ui.render(React.createElement(SolanaScreen));
const button = (text: string) => [...ui.container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text)!;

test("saved live consent cannot masquerade as active trading before program registration", async () => {
  state = initial("live"); await render();
  assert.match(ui.container.textContent!, /Live trading is not active yet/);
  assert.match(ui.container.textContent!, /Deploy and verify the vault program/);
  assert.equal(button("Register bounded trading permission").disabled, true);
  assert.equal(button("Preview trade").disabled, true);
  assert.equal(signCount, 0); assert.equal(calls.some((call) => call.path === "setup"), false);
});

test("paper creation uses exact raw USDG and never sends a browser-declared owner", async () => {
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "paper") { assert.deepEqual(body, { initialCashRaw: "1000000000" }); state.runtime.paper = paper; return json({ paper }); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Create paper portfolio");
  assert.match(ui.container.textContent!, /1000 USDG/);
  assert.equal(signCount, 0);
});

test("an uncertain paper response retries the same request ID instead of creating a second fill", async () => {
  state.runtime.paper = paper;
  const trades: Record<string, unknown>[] = [];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") return json({ preview: { quote: {
      source: "jupiter", inputMint: SOLANA_USDG_MINT, outputMint: OWNER, inAmount: "1000000", outAmount: "10000000", minOutAmount: "9950000", slippageBps: 50, contextSlot: 1, quotedAtMs: Date.now(), expiresAtMs: Date.now() + 20000,
    } } });
    if (path === "intent" && body?.action === "trade") {
      trades.push(body); if (trades.length === 1) throw new Error("Lost response after commit");
      return json({ receipt: { mode: "paper", requestId: (body.intent as { requestId: string }).requestId } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Preview trade"); await ui.click("Simulate trade"); await ui.click("Simulate trade");
  assert.equal(trades.length, 2); assert.deepEqual(trades[0], trades[1]);
  assert.equal("owner" in trades[0]!, false); assert.equal("tenant" in trades[0]!, false);
  assert.match(ui.container.textContent!, /Simulated trade recorded/);
  assert.equal(button("Simulate trade").disabled, true);
  await ui.click("Start a new trade"); await ui.click("Preview trade"); await ui.click("Simulate trade");
  assert.equal(trades.length, 3);
  assert.notEqual((trades[2]!.intent as { requestId: string }).requestId, (trades[0]!.intent as { requestId: string }).requestId);
});

test("registration retries the same signed bytes and bounded seed after an unknown submit outcome", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let sessionPublicKey = "";
  const submissions: unknown[] = [];
  let activation: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") {
      sessionPublicKey = String(body.sessionPublicKey);
      return json({ setup: await permissionTransaction(sessionPublicKey, saved) });
    }
    if (path === "setup" && body?.stage === "submit") {
      submissions.push(body.signedTransactionBase64);
      if (submissions.length === 1) throw new Error("Unknown submit outcome");
      return json({ registration: { signature: "fixture-chain-signature", status: "finalized" } });
    }
    if (path === "setup" && body?.stage === "activate") { activation = body; state.runtime.live.ready = true; return json({ live: { ready: true } }); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.equal(signCount, 1); assert.equal(activation, undefined);
  await press("Finish permission registration");
  assert.equal(signCount, 1); assert.deepEqual(submissions, ["AQID", "AQID"]);
  assert.ok(activation);
  const seed = Buffer.from(String((activation as Record<string, unknown>).sessionSecretKey), "base64");
  assert.equal(seed.length, 32); assert.equal(base58Encode(ed25519.getPublicKey(seed)), sessionPublicKey);
  assert.equal(ui.dom.window.localStorage.length, 0);
});

test("registration and the deposit address are offered only for a program the page's own pin trusts, never one the server names alone", async () => {
  const OTHER = base58Encode(new Uint8Array(32).fill(77));
  const depositFor = async (program: string) => deriveSolanaAta(await deriveSolanaVaultAddress(program, OWNER), SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
  // A server naming a program the pin does not list: no registration, no deposit address, whatever the server says is ready.
  state = initial("live"); state.binding.limits = liveLimits(); state.runtime.live.programId = OTHER;
  Object.assign(state.runtime.live, { ready: true, canExit: true, vault: await deriveSolanaVaultAddress(OTHER, OWNER), cashTokenAccount: await depositFor(OTHER) });
  // A fresh page each time: the pin is fixed at build time, and the page derives the address once per program.
  const mount = async () => {
    await ui.remount(React.createElement(SolanaScreen));
    // Address derivation is asynchronous (WebCrypto); let it settle.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  };
  await mount();
  assert.match(ui.container.textContent!, /not a released Merrymen vault program/);
  assert.equal(button("Register bounded trading permission").disabled, true);
  assert.ok(!ui.container.textContent!.includes("Fund the Solana vault"));
  assert.equal(calls.some((call) => call.path === "setup"), false);
  // Once the pin lists it, both are offered.
  releases = [{ programId: OTHER, sha256: "ab".repeat(32) }];
  await mount();
  assert.ok(!ui.container.textContent!.includes("not a released Merrymen vault program"));
  assert.match(ui.container.textContent!, /Fund the Solana vault/);
  assert.equal(button("Register bounded trading permission").disabled, false);
  // A deposit address that is not the bound owner's vault of that program is never shown.
  Object.assign(state.runtime.live, { cashTokenAccount: await depositFor(PROGRAM) });
  await mount();
  assert.ok(!ui.container.textContent!.includes("Fund the Solana vault"));
});

test("the page trusts a released program, and the local test program only outside a production build", async () => {
  const recovery = createRequire(import.meta.url)(recoveryPath) as typeof import("./SolanaRecovery");
  const OTHER = base58Encode(new Uint8Array(32).fill(77)), pin = [{ programId: OTHER, sha256: "ab".repeat(32) }];
  assert.equal(recovery.pageTrustsVaultProgram(OTHER, [], false), false);
  assert.equal(recovery.pageTrustsVaultProgram(OTHER, pin, true), true);
  assert.equal(recovery.pageTrustsVaultProgram(PROGRAM, [], false), true);
  assert.equal(recovery.pageTrustsVaultProgram(PROGRAM, [], true), false);
});

test("a delayed response from the previous identity never populates a new account view", async () => {
  const old = deferred<Response>();
  let reads = 0;
  respond = async () => ++reads === 1 ? old.promise : json({ binding: null, runtime: null });
  await render();
  signerDid = "did:privy:bob"; await render();
  await act(async () => { old.resolve(json(state)); });
  assert.ok(!ui.container.textContent!.includes("Solana trading mode"));
  assert.match(ui.container.textContent!, /Verify Solana wallet/);
});

/** How many times the page says `text`. */
const timesSaid = (text: string) => ui.container.textContent!.split(text).length - 1;
test("a status answer that another sign-in verified this account's wallet offers no wallet to create or verify, and names the way back", async () => {
  respond = async (path) => { if (path === "status") return json({ error: SOLANA_OTHER_SIGN_IN }, 403); throw new Error("Unexpected fixture route"); };
  await render(); await settle();
  assert.equal(timesSaid(SOLANA_OTHER_SIGN_IN), 1, "said once, in the wallet card");
  assert.equal(button("Verify Solana wallet"), undefined); assert.equal(button("Create Solana wallet"), undefined);
  assert.ok(button("Refresh account"), "a refresh is still offered");
  // Still that answer on a refresh: still no wallet offered.
  await press("Refresh account");
  assert.equal(timesSaid(SOLANA_OTHER_SIGN_IN), 1); assert.equal(button("Verify Solana wallet"), undefined);
  // The login that verified it: the account shows, and the message goes.
  respond = async (path) => { if (path === "status") return json(state); throw new Error("Unexpected fixture route"); };
  signerDid = "did:privy:bob"; await render(); await settle();
  assert.equal(timesSaid(SOLANA_OTHER_SIGN_IN), 0);
  assert.ok(ui.container.textContent!.includes(OWNER) && /Verified wallet connected/.test(ui.container.textContent!));
});
test("a verify the bind route refuses as another sign-in's stops offering create and verify, and names the way back", async () => {
  respond = async (path) => {
    if (path === "status") return json({ binding: null, runtime: null });
    if (path.startsWith("bind?owner=")) return json({ error: SOLANA_OTHER_SIGN_IN }, 409);
    throw new Error("Unexpected fixture route");
  };
  await render();
  assert.ok(button("Verify Solana wallet"));
  await press("Verify Solana wallet");
  assert.equal(timesSaid(SOLANA_OTHER_SIGN_IN), 1);
  assert.equal(button("Verify Solana wallet"), undefined); assert.equal(button("Create Solana wallet"), undefined);
  assert.equal(calls.filter((call) => call.path === "bind").length, 0, "nothing was signed or posted");
  // Any other refusal of a verify is shown as before, and the button stays.
  ui = (await ui.close(), testDom());
  respond = async (path) => {
    if (path === "status") return json({ binding: null, runtime: null });
    if (path.startsWith("bind?owner=")) return json({ error: "That Solana wallet is already bound to another account." }, 409);
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Verify Solana wallet");
  assert.match(ui.container.textContent!, /already bound to another account/);
  assert.ok(button("Verify Solana wallet"));
});
test("the live permission card names a revocation signed beside the owner transaction", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  ownerTransaction("withdraw-sig", "pending", "withdraw"); revokeBeside("revoke-sig", "pending");
  await render();
  assert.match(ui.container.textContent!, /Owner transaction: pending\. View owner transaction Revocation signed beside it: pending\. View revocation/);
  const link = [...ui.container.querySelectorAll("a")].find((item) => item.textContent === "View revocation")!;
  assert.equal(link.getAttribute("href"), "https://solscan.io/tx/revoke-sig");
});
test("owner recovery stays available in paper mode and retries exact signed bytes", async () => {
  state.runtime.live.programId = PROGRAM;
  const submissions: unknown[] = [];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") {
      assert.deepEqual(body, { stage: "prepare", action: "revoke" });
      return prepareAnswer(body);
    }
    if (path === "owner" && body?.stage === "submit") {
      submissions.push(body.signedTransactionBase64);
      if (submissions.length === 1) throw new Error("Unknown owner submission");
      return json({ result: { signature: "owner-proof", status: "finalized" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ownerPress("Revoke all Solana sessions");
  assert.equal(signCount, 1);
  await press("Check existing owner transaction");
  assert.equal(signCount, 1); assert.deepEqual(submissions, ["AQID", "AQID"]);
  assert.match(ui.container.textContent!, /Owner transaction: finalized/);
});

test("autonomous strategy is disabled by default and saves explicit bounded settings", async () => {
  let saved: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "strategy") { saved = body; return json({ binding: state.binding }); }
    throw new Error("Unexpected fixture route");
  };
  await render();
  assert.match(ui.container.textContent!, /Autonomous trading is disabled/);
  await ui.click("Save autonomous strategy");
  assert.deepEqual(saved, { revision: 0, strategy: { enabled: false, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 60 } });
  assert.equal(signCount, 0);
  // Paper strategies have no minimum; a live one says its 1 USDG minimum beside the fields.
  assert.doesNotMatch(ui.container.textContent!, /set at least 1 USDG per strategy trade/);
  state = initial("live"); await ui.click("Refresh account");
  assert.match(ui.container.textContent!, /Each live trade must be worth at least 1 USDG, so set at least 1 USDG per strategy trade/);
});
test("a paced answer is a wait wherever it is read: the first status load, owner controls and the strategy, never a failure", async () => {
  const PACED = "Your Solana account was refreshed too often. Try again in 3 seconds.";
  const paced = () => json({ error: PACED, ownerFacing: true }, 429);
  const alerts = () => [...ui.container.querySelectorAll('[role="alert"]')].map((item) => item.textContent);
  const notices = () => [...ui.container.querySelectorAll('[role="status"].solana-notice')].map((item) => item.textContent);
  const card = (heading: string) => [...ui.container.querySelectorAll(".solana-card")].find((item) => item.querySelector("h2")?.textContent === heading)!;
  const fresh = async () => { await ui.close(); ui = testDom(); calls = []; };
  // The first status read of the page.
  let statusAnswer: () => Response = paced;
  respond = async (path) => { if (path === "status") return statusAnswer(); throw new Error("Unexpected fixture route"); };
  await render();
  assert.deepEqual(alerts(), []); assert.deepEqual(notices(), [PACED]);
  statusAnswer = () => json(state);
  await ui.click("Refresh account");
  assert.deepEqual(notices(), []); assert.match(ui.container.textContent!, /Saved preference: paper/);
  // Checking the server's pending owner record.
  await fresh(); state = initial("live"); state.runtime.live.programId = PROGRAM;
  Object.assign(state.runtime.live, { ownerTransaction: { signature: "withdraw-sig", status: "pending", kind: "withdraw" } });
  statusAnswer = () => json(state);
  await render();
  statusAnswer = paced;
  await press("Check owner transaction");
  assert.deepEqual(alerts(), []);
  assert.equal(card("Owner controls").querySelector('[role="status"].solana-notice')?.textContent, PACED);
  // Any other failure still reads as one.
  statusAnswer = () => json({ error: "Solana is temporarily unavailable.", ownerFacing: true }, 503);
  await press("Check owner transaction");
  assert.deepEqual(alerts(), ["Solana is temporarily unavailable."]); assert.equal(card("Owner controls").querySelector(".solana-notice"), null);
  // Preparing an owner transaction: nothing was prepared, so there is nothing to review or sign.
  await fresh(); state = initial("live"); state.runtime.live.programId = PROGRAM;
  respond = async (path) => { if (path === "status") return json(state); if (path === "owner") return json({ error: "Too many Solana owner requests. Try again in 5 seconds.", ownerFacing: true }, 429); throw new Error("Unexpected fixture route"); };
  await render(); await press("Withdraw to my wallet");
  assert.deepEqual(alerts(), []);
  assert.equal(card("Owner controls").querySelector('[role="status"].solana-notice')?.textContent, "Too many Solana owner requests. Try again in 5 seconds.");
  assert.doesNotMatch(ui.container.textContent!, /Review before your wallet opens/); assert.equal(signCount, 0);
  // Saving the strategy.
  await fresh(); state = initial();
  respond = async (path) => { if (path === "status") return json(state); if (path === "strategy") return json({ error: "Too many Solana strategy changes. Try again in 9 seconds.", ownerFacing: true }, 429); throw new Error("Unexpected fixture route"); };
  await render(); await press("Save autonomous strategy");
  assert.deepEqual(alerts(), []);
  assert.equal(card("Autonomous rebalancing").querySelector('[role="status"].solana-notice')?.textContent, "Too many Solana strategy changes. Try again in 9 seconds.");
});
test("resuming buys requires a separate owner signature without changing trading limits", async () => {
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") {
      assert.deepEqual(body, { stage: "prepare", action: "resume-buys" });
      return prepareAnswer(body);
    }
    if (path === "owner" && body?.stage === "submit") return json({ result: { signature: "resume-proof", status: "finalized" } });
    throw new Error("Unexpected fixture route");
  };
  await render(); await ownerPress("Ask wallet to resume buys");
  assert.equal(signCount, 1);
  assert.equal(calls.some((call) => call.path === "settings"), false);
  assert.match(ui.container.textContent!, /drawdown still exceeds your limit/);
});

test("enabled automation reports a missing worker separately from saved consent", async () => {
  Object.assign(state.binding, { strategy: { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 60 } });
  Object.assign(state.runtime, { automation: { workerOnline: false, lastSeenAtMs: null } });
  await render();
  assert.match(ui.container.textContent!, /Waiting for Solana worker/);
  assert.ok(!ui.container.textContent!.includes("Solana worker connected"));
  Object.assign(state.runtime, { automation: { workerOnline: true, lastSeenAtMs: Date.now() } });
  await ui.click("Refresh account");
  assert.match(ui.container.textContent!, /Solana worker connected/);
  assert.ok(!ui.container.textContent!.includes("Waiting for Solana worker"));
});

test("unknown fees from proven expired submissions are not presented as zero fees", async () => {
  state = initial("live");
  Object.assign(state.runtime.live, { book: { realizedPnlUsdgRaw: "0", networkFeesLamports: "0", unresolvedFeeCount: 1, reservedUnknownFeeLamports: "10000" } });
  await render();
  assert.match(ui.container.textContent!, /Network fees are incomplete for 1 expired submission/);
  assert.match(ui.container.textContent!, /recorded fee total excludes unknown fees/);
  assert.match(ui.container.textContent!, /Reserved fee allowance: 0\.00001 SOL/);
});

test("live buying breaker leaves authenticated exits available and displays actual accounting", async () => {
  state = initial("live");
  Object.assign(state.runtime.live, { canExit: true, balances: { slot: 123, cashUsdg: "123456789", wsolRaw: "1200000000" },
    book: { realizedPnlUsdgRaw: "-1500001", networkFeesLamports: "5000" } });
  state.runtime.live.blockers = ["The on-chain buying breaker is paused; exits remain available."];
  await render();
  assert.equal(button("Preview trade").disabled, true);
  const direction = ui.container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => { direction.value = "sell"; direction.dispatchEvent(new ui.dom.window.Event("change", { bubbles: true })); });
  assert.equal(button("Preview trade").disabled, false);
  assert.match(ui.container.textContent!, /123\.456789 USDG/); assert.match(ui.container.textContent!, /1\.2 wrapped SOL/);
  assert.match(ui.container.textContent!, /-1\.500001 USDG/); assert.match(ui.container.textContent!, /0\.000005 SOL/);
});

test("live limits carry the owner's SOL sell bounds in lamports; paper limits do not", async () => {
  state = initial("live");
  state.binding.limits = { ...limits, perTradeWsol: "250000000", dailyWsol: "1000000000" } as typeof limits;
  const saved: Array<Record<string, unknown>> = [];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "settings") { saved.push(body!); return json({ binding: state.binding }); }
    throw new Error("Unexpected fixture route");
  };
  await render();
  assert.match(ui.container.textContent!, /Sales are limited to 0\.25 SOL per trade and 1 SOL per 24 hours/);
  const consent = ui.container.querySelector("input[type=checkbox]") as HTMLInputElement;
  await act(async () => { consent.click(); });
  await ui.click("Save Solana mode and limits");
  const live = saved[0]!.limits as Record<string, unknown>;
  assert.equal(live.perTradeWsol, "250000000"); assert.equal(live.dailyWsol, "1000000000");
  state = initial("paper");
  await ui.click("Refresh account");
  const paperRadio = [...ui.container.querySelectorAll("input[type=radio]")][0] as HTMLInputElement;
  await act(async () => { paperRadio.click(); });
  await ui.click("Save Solana mode and limits");
  assert.equal("perTradeWsol" in (saved[1]!.limits as Record<string, unknown>), false);
  assert.equal(signCount, 0);
});

test("the live limits say the 1 USDG live minimum beside the fields, and a per-trade limit under it is refused before anything is sent", async () => {
  state = initial("live");
  state.binding.limits = { ...limits, perTradeWsol: "250000000", dailyWsol: "1000000000" } as typeof limits;
  const saved: Array<Record<string, unknown>> = [];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "settings") { saved.push(body!); return json({ binding: state.binding }); }
    throw new Error("Unexpected fixture route");
  };
  await render();
  assert.match(ui.container.textContent!, /Each live trade must be worth at least 1 USDG; only a sale of your whole SOL position may be smaller/);
  const consent = ui.container.querySelector("input[type=checkbox]") as HTMLInputElement;
  await act(async () => { consent.click(); });
  await type("USDG per trade", "0.99");
  await ui.click("Save Solana mode and limits");
  assert.ok(ui.container.textContent!.includes(SOLANA_LIVE_PER_TRADE_BELOW_MINIMUM));
  assert.equal(saved.length, 0, "nothing sent");
  await type("USDG per trade", "1");
  await ui.click("Save Solana mode and limits");
  assert.equal((saved[0]!.limits as Record<string, unknown>).perTradeUsdg, "1000000");
  // Paper mode has no minimum and says none.
  state = initial("paper");
  await ui.click("Refresh account");
  const paperRadio = [...ui.container.querySelectorAll("input[type=radio]")][0] as HTMLInputElement;
  await act(async () => { paperRadio.click(); });
  assert.doesNotMatch(ui.container.textContent!, /Each live trade must be worth at least 1 USDG/);
  await type("USDG per trade", "0.5");
  await ui.click("Save Solana mode and limits");
  assert.equal((saved[1]!.limits as Record<string, unknown>).perTradeUsdg, "500000");
});

test("wrapped SOL sent by someone else is shown held aside, not as trading performance", async () => {
  state = initial("live");
  Object.assign(state.runtime.live, { canExit: true, balances: { slot: 9, cashUsdg: "90000000", wsolRaw: "50000001" },
    book: { realizedPnlUsdgRaw: "0", networkFeesLamports: "10000", quarantinedWsolRaw: "1" } });
  await render();
  assert.match(ui.container.textContent!, /0\.000000001 wrapped SOL arrived outside your recorded trades\. It is held aside/);
});

test("the live card shows the saved limits and signed expiry, and unsaved edits block registration", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    throw new Error("Unexpected fixture route");
  };
  await render();
  const text = () => ui.container.textContent!;
  // The duration is the saved one, not a 24-hour default; the expiry is the instant signed on chain.
  assert.equal(field("Permission duration"), "168");
  assert.match(text(), /Your wallet will be asked to sign these saved limits/);
  assert.match(text(), /10 USDG per trade and 50 USDG per 24 hours/);
  assert.match(text(), /0\.25 SOL sold per trade and 1 SOL sold per 24 hours/);
  assert.ok(text().includes(`Expires ${new Date(Math.floor(saved.expiresAtMs / 1000) * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`));
  assert.equal(button("Register bounded trading permission").disabled, false);
  // Lower the per-trade limit without saving: the page must not offer to sign the old 10 USDG.
  await type("USDG per trade", "1");
  assert.equal(button("Register bounded trading permission").disabled, true);
  assert.match(text(), /The form has unsaved changes/);
  assert.match(text(), /10 USDG per trade/);
  await type("USDG per trade", "10");
  await type("Permission duration", "24");
  assert.equal(button("Register bounded trading permission").disabled, true);
  await type("Permission duration", "168");
  assert.equal(button("Register bounded trading permission").disabled, false);
  assert.equal(signCount, 0); assert.equal(calls.some((call) => call.path === "setup"), false);
});

test("a prepared permission that encodes anything but the shown limits never reaches the wallet", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let prepared: (session: string) => Promise<unknown> = async (session) => permissionTransaction(session, { ...saved, perTradeUsdg: "20000000", dailyUsdg: "60000000" });
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await prepared(String(body.sessionPublicKey)) });
    throw new Error("Unexpected fixture route");
  };
  await render();
  await press("Register bounded trading permission");
  assert.equal(signCount, 0);
  assert.match(ui.container.textContent!, /does not match the saved limits shown on this page\. Nothing was signed/);
  // A different expiry, or an extra instruction (an owner SOL transfer), is refused the same way.
  prepared = async (session) => permissionTransaction(session, { ...saved, expiresAtMs: saved.expiresAtMs + 3_600_000 });
  await press("Register bounded trading permission");
  assert.equal(signCount, 0);
  assert.match(ui.container.textContent!, /does not match the saved limits shown on this page\. Nothing was signed/);
  const transfer: Instruction = { programAddress: address("11111111111111111111111111111111"), data: Uint8Array.of(2, 0, 0, 0, 0, 202, 154, 59, 0, 0, 0, 0),
    accounts: [{ address: address(OWNER), role: 3 }, { address: address(base58Encode(new Uint8Array(32).fill(9))), role: 1 }] };
  prepared = async (session) => permissionTransaction(session, saved, [transfer]);
  await press("Register bounded trading permission");
  assert.equal(signCount, 0);
  assert.match(ui.container.textContent!, /The prepared permission does not match what this page shows\. Nothing was signed/);
  assert.equal(calls.filter((call) => call.path === "setup" && call.body?.stage === "submit").length, 0);
});

const refusal = (error: string, status = 409) => json({ error, ownerFacing: true }, status);
/** A refusal the server marks as having saved and sent nothing for this request (solanaResponse's notSaved). */
const unsaved = (error: string, status = 409) => json({ error, ownerFacing: true, notSaved: true }, status);
/** Signed wire bytes the server records by their owner signature (signatureOf), and that signature. */
const WIRE = Uint8Array.from([1, ...new Uint8Array(64).fill(7), 9, 9, 9]), WIRE_SIGNATURE = base58Encode(new Uint8Array(64).fill(7));
test("a refused owner submission discards the stale signed bytes and leaves Revoke usable", async () => {
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
    if (path === "owner" && body?.stage === "submit") {
      const prepared = calls.filter((call) => call.path === "owner" && call.body?.stage === "prepare");
      if (prepared.at(-1)!.body!.action === "withdraw") return unsaved("The prepared owner transaction expired before submission.");
      return json({ result: { signature: "revoke-proof", status: "finalized" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ownerPress("Withdraw to my wallet");
  assert.equal(signCount, 1);
  assert.match(ui.container.textContent!, /expired before submission\. This signed withdrawal was not accepted and has been discarded/);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Check existing owner transaction"), false);
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  assert.equal(button("Withdraw to my wallet").disabled, false);
  await ownerPress("Revoke all Solana sessions");
  assert.equal(signCount, 2);
  const owner = calls.filter((call) => call.path === "owner").map((call) => call.body!.stage === "prepare" ? `prepare:${call.body!.action}` : "submit");
  assert.deepEqual(owner, ["prepare:withdraw", "submit", "prepare:revoke", "submit"]);
  assert.match(ui.container.textContent!, /Owner transaction: finalized/);
});

type ServerOwnerRecord = { signature: string; status: string; kind?: string; revoke?: { signature: string; status: string; kind?: string; revokeAgain?: boolean } | null } | null;
const serverOwnerRecord = () => (state.runtime.live as { ownerTransaction?: ServerOwnerRecord }).ownerTransaction ?? null;
/**
 * The owner route's prepare, as prepareOwner answers it (pinned in SolanaServerContract.test.ts): while a saved
 * owner transaction is pending, only a revocation beside a pending non-revoke one; nothing while a revocation is;
 * and no second revocation beside it once one beside it landed, until a permission registered after it is live
 * (revokeAgain; pinned in solana-app-runtime.test.ts).
 */
const REVOKE_ALREADY_LANDED = "Your revocation already landed, and no trading permission has registered on Solana since, so nothing is left to revoke. If one registers later, Revoke works again.";
const ownerPrepare = (body: Record<string, unknown> | undefined) => {
  const record = serverOwnerRecord(), main = record?.status === "pending", revoking = record?.revoke?.status === "pending";
  const beside = body?.action === "revoke" && main && record!.kind !== "revoke" && !revoking;
  if (beside && record?.revoke?.status === "finalized" && !record.revoke.revokeAgain) return refusal(REVOKE_ALREADY_LANDED);
  return (main || revoking) && !beside ? refusal("Refresh the pending owner transaction before preparing another.") : prepareAnswer(body);
};
/** A revocation the server saved beside its pending main record (its revoke slot). */
const revokeBeside = (signature: string, status: string, more: { revokeAgain?: boolean } = {}) => Object.assign(state.runtime.live, { ownerTransaction: { ...serverOwnerRecord()!, revoke: { signature, status, kind: "revoke", ...more } } });
const ownerTransaction = (signature: string, status: string, kind: string) => Object.assign(state.runtime.live, { ownerTransaction: { signature, status, kind } });
test("withdrawal bytes the server never saved do not hold back Revoke: the revocation replaces them", async () => {
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return ownerPrepare(body);
    if (path === "owner" && body?.stage === "submit") {
      // The withdrawal's submission never reached the server; the revocation's is saved and broadcast.
      if (ownerCalls().filter((call) => call === "submit").length === 1) throw new Error("Lost response");
      ownerTransaction("revoke-sig", "pending", "revoke");
      return json({ result: { signature: "revoke-sig", status: "pending" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ownerPress("Withdraw to my wallet");
  assert.equal(button("Check existing owner transaction").disabled, false);
  assert.equal(button("Withdraw to my wallet").disabled, true);
  assert.equal(button("Ask wallet to resume buys").disabled, true);
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  assert.match(ui.container.textContent!, /Revoking stays available: if the server never saved this withdrawal, a revocation replaces it and it can no longer be sent; if the server saved it, a revocation is prepared beside it\./);
  await ownerPress("Revoke all Solana sessions");
  // A fresh revocation was prepared and signed; the withdrawal bytes were not resent as a revoke.
  assert.equal(signCount, 2);
  assert.deepEqual(ownerCalls(), ["prepare:withdraw", "submit", "prepare:revoke", "submit"]);
  // Now the server holds the revocation: nothing else, another revocation included, until it resolves.
  assert.match(ui.container.textContent!, /A signed revocation is awaiting final confirmation on Solana\. Until it is final or expired, no other owner transaction can be prepared, a revocation included/);
  assert.equal(button("Revoke all Solana sessions").disabled, true);
});

test("signed bytes the server never saved, next to a different pending server record: Revoke is prepared beside it, and only a revocation beside it, pending or landed, holds Revoke back", async () => {
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return ownerPrepare(body);
    // The withdrawal's submission never reaches the server.
    if (path === "owner" && body?.stage === "submit") throw new Error("Lost response");
    throw new Error("Unexpected fixture route");
  };
  await render(); await ownerPress("Withdraw to my wallet");
  assert.match(ui.container.textContent!, /Revoking stays available/);
  // Another device's resume request is saved and pending on the server: a revocation goes beside it, and the page says so.
  ownerTransaction("other-device-sig", "pending", "resume-buys");
  await ui.click("Refresh account");
  let text = ui.container.textContent!;
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  assert.match(text, /Your request to resume buys is awaiting final confirmation on Solana\. Until it is final, or its blockhash expires \(usually within a few minutes\), the server prepares no other withdrawal, resume request or permission; revoking stays available and is prepared beside it\./);
  assert.match(text, /A signed withdrawal has no confirmed outcome yet\. Check it before signing another withdrawal or resume request\. Revoking stays available: it is prepared beside the server's pending request to resume buys above\./);
  assert.equal(button("Check existing owner transaction").disabled, false);
  // That device then revoked beside it: now Revoke waits too, and the page never promises it.
  revokeBeside("other-device-revoke", "pending");
  await ui.click("Refresh account");
  text = ui.container.textContent!;
  assert.equal(button("Revoke all Solana sessions").disabled, true);
  assert.doesNotMatch(text, /Revoking stays available/);
  assert.match(text, /Your revocation is awaiting final confirmation on Solana\. Until it is final, or its blockhash expires \(usually within a few minutes\), the server prepares no other owner transaction, a revocation included\./);
  assert.match(text, /A signed withdrawal has no confirmed outcome yet\. Check it before signing another withdrawal or resume request\. Revoking waits for the server's pending revocation above: it can be prepared once that is final or expired\./);
  // Once the revocation landed, its record is kept beside the resume request: Revoke waits for that to resolve, and the page says why.
  revokeBeside("other-device-revoke", "finalized");
  await ui.click("Refresh account");
  text = ui.container.textContent!;
  assert.equal(button("Revoke all Solana sessions").disabled, true);
  assert.doesNotMatch(text, /Revoking stays available/);
  assert.match(text, /Your request to resume buys is awaiting final confirmation on Solana\. Until it is final, or its blockhash expires \(usually within a few minutes\), the server prepares no other owner transaction: your revocation beside it already landed, so every session it covered is revoked, and no permission has registered since\./);
  assert.match(text, /Your revocation beside the server's pending request to resume buys above already landed; you can revoke again once that resolves\./);
  // A permission registered on Solana after that revocation is live (the server says revokeAgain): Revoke is available beside it again.
  revokeBeside("other-device-revoke", "finalized", { revokeAgain: true });
  await ui.click("Refresh account");
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  assert.match(ui.container.textContent!, /revoking stays available and is prepared beside it/);
  // A revocation that provably never ran leaves nothing to keep: Revoke is available again beside the resume request.
  revokeBeside("other-device-revoke", "failed");
  await ui.click("Refresh account");
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  assert.match(ui.container.textContent!, /Revoking stays available/);
  assert.equal(signCount, 1, "nothing but the withdrawal was signed");
});

test("while the server holds a submitted withdrawal every other owner action waits for it, Revoke is prepared beside it, and then everything waits for the revocation", async () => {
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return ownerPrepare(body);
    if (path === "owner" && body?.stage === "submit") {
      const withdrawal = ownerCalls().filter((call) => call.startsWith("prepare:")).at(-1) === "prepare:withdraw";
      if (!withdrawal) {
        if (!serverOwnerRecord()?.revoke) revokeBeside("revoke-sig", "pending");
        return json({ result: { signature: "revoke-sig", status: serverOwnerRecord()!.revoke!.status } });
      }
      const record = serverOwnerRecord();
      if (!record) ownerTransaction("withdraw-sig", "pending", "withdraw");
      return json({ result: { signature: "withdraw-sig", status: record?.status ?? "pending" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ownerPress("Withdraw to my wallet");
  const text = () => ui.container.textContent!;
  assert.match(text(), /A signed withdrawal is awaiting final confirmation on Solana\. Until it is final or expired, no other withdrawal or resume request can be prepared; revoking stays available and is prepared beside it\./);
  for (const name of ["Ask wallet to resume buys", "Withdraw to my wallet", "Withdraw native SOL"]) assert.equal(button(name).disabled, true, name);
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  assert.equal(button("Check existing owner transaction").disabled, false);
  assert.deepEqual(ownerCalls(), ["prepare:withdraw", "submit"]);
  // The emergency revoke goes beside it; then nothing else, another revocation included, until that resolves.
  await ownerPress("Revoke all Solana sessions");
  assert.equal(signCount, 2);
  assert.deepEqual(ownerCalls(), ["prepare:withdraw", "submit", "prepare:revoke", "submit"]);
  assert.match(text(), /A signed revocation is awaiting final confirmation on Solana\. Until it is final or expired, no other owner transaction can be prepared, a revocation included/);
  assert.match(text(), /Your withdrawal is awaiting final confirmation on Solana\. Until it is final, or its blockhash expires \(usually within a few minutes\), the server prepares no other owner transaction, and the revocation beside it is pending too\./);
  for (const name of ["Revoke all Solana sessions", "Ask wallet to resume buys", "Withdraw to my wallet", "Withdraw native SOL"]) assert.equal(button(name).disabled, true, name);
  // Both finalize; the check reads that, and the actions come back.
  ownerTransaction("withdraw-sig", "finalized", "withdraw"); revokeBeside("revoke-sig", "finalized");
  await press("Check existing owner transaction");
  assert.doesNotMatch(text(), /awaiting final confirmation/);
  for (const name of ["Revoke all Solana sessions", "Ask wallet to resume buys", "Withdraw to my wallet", "Withdraw native SOL"]) assert.equal(button(name).disabled, false, name);
});

test("a Revoke pressed before the page knew of a pending owner transaction is refused before the wallet opens, and the page shows why", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return ownerPrepare(body);
    if (path === "owner" && body?.stage === "submit") return json({ result: { signature: "revoke-sig", status: "pending" } });
    throw new Error("Unexpected fixture route");
  };
  await render();
  // Another device submitted a revocation after this page last read the status.
  ownerTransaction("revoke-elsewhere-sig", "pending", "revoke");
  await ownerPress("Revoke all Solana sessions");
  const text = () => ui.container.textContent!;
  assert.equal(signCount, 0, "the wallet never opened");
  assert.match(text(), /Refresh the pending owner transaction before preparing another\./);
  assert.match(text(), /Your revocation is awaiting final confirmation on Solana\. Until it is final, or its blockhash expires \(usually within a few minutes\), the server prepares no other owner transaction, a revocation included/);
  assert.equal(button("Revoke all Solana sessions").disabled, true);
  // A record this page has no bytes for is checked by reading the server's status.
  ownerTransaction("revoke-elsewhere-sig", "failed", "revoke");
  await ui.click("Check owner transaction");
  assert.doesNotMatch(text(), /awaiting final confirmation on Solana/);
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  // A pending permission registration does not hold Revoke back: the revocation is prepared beside it.
  ownerTransaction("permission-sig", "pending", "session");
  await ui.click("Refresh account");
  assert.match(text(), /Your trading permission is awaiting final confirmation on Solana\. Until it is final, or its blockhash expires \(usually within a few minutes\), the server prepares no other withdrawal, resume request or permission; revoking stays available and is prepared beside it\./);
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  // A revocation beside it landed: the server keeps that record (no second press overwrites it), so Revoke waits for the permission to resolve.
  revokeBeside("revoke-beside-sig", "finalized");
  await ui.click("Refresh account");
  assert.match(text(), /Your trading permission is awaiting final confirmation on Solana\. Until it is final, or its blockhash expires \(usually within a few minutes\), the server prepares no other owner transaction: your revocation beside it already landed, so every session it covered is revoked, and no permission has registered since\./);
  assert.equal(button("Revoke all Solana sessions").disabled, true);
  // The permission itself landed after the revocation and is live on Solana while the providers still disagree about it: Revoke works again.
  revokeBeside("revoke-beside-sig", "finalized", { revokeAgain: true });
  await ui.click("Refresh account");
  assert.match(text(), /revoking stays available and is prepared beside it\./);
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  // The permission resolved (it registered after the revocation): Revoke is available again, in the main slot.
  ownerTransaction("permission-sig", "finalized", "session"); revokeBeside("revoke-beside-sig", "finalized");
  await ui.click("Refresh account");
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  // An unknown kind from the server is named plainly, never looked up on the prototype.
  ownerTransaction("odd-sig", "pending", "constructor");
  await ui.click("Refresh account");
  assert.match(text(), /Your owner transaction is awaiting final confirmation on Solana/);
  assert.deepEqual(ownerCalls(), ["prepare:revoke"]);
});

const ownerCalls = () => calls.filter((call) => call.path === "owner").map((call) => call.body!.stage === "prepare" ? `prepare:${call.body!.action}` : "submit");
test("a 4xx on a re-check of accepted withdrawal bytes keeps them and reports the server's record, never 'not accepted'", async () => {
  state.runtime.live.programId = PROGRAM;
  let submits = 0;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
    if (path === "owner" && body?.stage === "submit") {
      submits++;
      // The server saved and broadcast these bytes; it holds them as pending.
      if (submits === 1) { Object.assign(state.runtime.live, { ownerTransaction: { signature: "withdraw-sig", status: "pending", kind: "withdraw" } }); return json({ result: { signature: "withdraw-sig", status: "pending" } }); }
      // The re-check reaches ownerStatus, which cannot use the RPC's answer.
      if (submits === 2) return refusal("Owner confirmation does not match the saved transaction.", 400);
      // A route-level refusal (Solana's mode changed) after the withdrawal finalized.
      return refusal("Review and save live mode and its limits before registering a trading permission.");
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ownerPress("Withdraw to my wallet");
  assert.match(ui.container.textContent!, /Owner transaction: pending/);
  await press("Check existing owner transaction");
  const text = ui.container.textContent!;
  assert.doesNotMatch(text, /not accepted|discarded/);
  assert.match(text, /does not match the saved transaction\. The server holds this signed withdrawal and still records it as awaiting confirmation, so it was kept\. It may already have completed on Solana/);
  assert.equal(button("Check existing owner transaction").disabled, false);
  assert.equal(button("Withdraw to my wallet").disabled, true, "no second withdrawal while the first may complete");
  // The server's record, not the refusal, settles it.
  (state.runtime.live as { ownerTransaction?: { status: string } }).ownerTransaction!.status = "finalized";
  await press("Check existing owner transaction");
  assert.doesNotMatch(ui.container.textContent!, /not accepted|discarded/);
  assert.match(ui.container.textContent!, /Owner transaction: finalized/);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Check existing owner transaction"), false);
  assert.equal(signCount, 1);
  assert.deepEqual(ownerCalls(), ["prepare:withdraw", "submit", "submit", "submit"]);
});

test("a 4xx after an unknown outcome clears bytes the server holds no record of, without claiming they were never sent", async () => {
  state.runtime.live.programId = PROGRAM;
  // Real wire bytes: one owner signature, then a message.
  const signature = new Uint8Array(64).fill(9), wire = Uint8Array.from([1, ...signature, 0x80, 1, 2, 3]);
  let submits = 0;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
    if (path === "owner" && body?.stage === "submit") {
      assert.equal(body.signedTransactionBase64, Buffer.from(wire).toString("base64"));
      if (++submits === 1) throw new Error("Lost response");
      return refusal("The prepared owner transaction expired before submission.");
    }
    throw new Error("Unexpected fixture route");
  };
  signedBytes = () => wire;
  await render(); await ownerPress("Withdraw to my wallet");
  assert.equal(button("Withdraw to my wallet").disabled, true);
  await press("Check existing owner transaction");
  const text = ui.container.textContent!;
  assert.doesNotMatch(text, /not accepted/);
  assert.match(text, /expired before submission\. The server holds no record of this signed withdrawal, so it was cleared and cannot be resent/);
  // Its own transaction link, so the owner can see whether an earlier attempt landed.
  const link = [...ui.container.querySelectorAll("a")].find((item) => item.textContent === "Check this withdrawal on Solana")!;
  assert.equal(link.getAttribute("href"), `https://solscan.io/tx/${base58Encode(signature)}`);
  assert.equal(button("Withdraw to my wallet").disabled, false);
  assert.equal(calls.filter((call) => call.path === "status").length, 2, "the server's record was read before clearing");
});

test("a revocation saved beside a pending withdrawal is found in the server's record when its retry is refused: kept, never 'no record'", async () => {
  state.runtime.live.programId = PROGRAM;
  ownerTransaction("withdraw-elsewhere", "pending", "withdraw");
  signedBytes = () => WIRE;
  let submits = 0;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return ownerPrepare(body);
    if (path === "owner" && body?.stage === "submit") {
      // The server saved the revocation beside the withdrawal, then refused the retry.
      if (++submits === 1) { revokeBeside(WIRE_SIGNATURE, "pending"); throw new Error("Lost response"); }
      if (submits === 2) return refusal("This request conflicts with an owner transaction that was just recorded.");
      revokeBeside(WIRE_SIGNATURE, "finalized");
      return json({ result: { signature: WIRE_SIGNATURE, status: "finalized" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ownerPress("Revoke all Solana sessions");
  await press("Check existing owner transaction");
  const text = ui.container.textContent!;
  assert.doesNotMatch(text, /no record|not accepted|discarded|cleared/);
  assert.match(text, /just recorded\. The server holds this signed revocation and still records it as awaiting confirmation, so it was kept/);
  await press("Check existing owner transaction");
  assert.match(ui.container.textContent!, /Owner transaction: finalized/);
  assert.equal(signCount, 1); assert.deepEqual(ownerCalls(), ["prepare:revoke", "submit", "submit", "submit"]);
});

test("withdrawals made outside Merrymen are recorded by their signatures, read by the server, and nothing is signed", async () => {
  state.runtime.live.programId = PROGRAM;
  const first = base58Encode(new Uint8Array(64).fill(3)), second = base58Encode(new Uint8Array(64).fill(4));
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "record") return json({ recorded: { booked: [{ signature: first, mint: SOLANA_USDG_MINT, amountRaw: "90000000" },
      { signature: second, mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1500000000" }], book: {} } });
    throw new Error("Unexpected fixture route");
  };
  await render();
  assert.equal(button("Record these withdrawals").disabled, true, "nothing to record yet");
  const box = [...ui.container.querySelectorAll("label")].find((item) => item.textContent?.startsWith("Withdrawal transaction signatures"))!.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(box, ` ${first}\n${second}, `); box.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true })); });
  await press("Record these withdrawals");
  assert.deepEqual(calls.filter((call) => call.path === "owner").map((call) => call.body), [{ stage: "record", action: "external-withdrawals", signatures: [first, second] }]);
  assert.match(ui.container.textContent!, /Recorded your withdrawals made outside Merrymen: 90 USDG, 1\.5 wrapped SOL\./);
  assert.equal(signCount, 0); assert.equal(box.value, "");
  // A refusal is shown as the server words it, and the signatures stay to correct.
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "record") return refusal("That withdrawal is already recorded. Nothing was recorded.");
    throw new Error("Unexpected fixture route");
  };
  await act(async () => { setter.call(box, first); box.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true })); });
  await press("Record these withdrawals");
  assert.match(ui.container.textContent!, /That withdrawal is already recorded\. Nothing was recorded\./); assert.equal(box.value, first);
});

test("a refused retry keeps the signed bytes when the server's record cannot be read", async () => {
  state.runtime.live.programId = PROGRAM;
  let submits = 0, statusUp = true;
  respond = async (path, body) => {
    if (path === "status") return statusUp ? json(state) : json({ error: "Solana is temporarily unavailable.", ownerFacing: true }, 503);
    if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
    if (path === "owner" && body?.stage === "submit") {
      if (++submits === 1) throw new Error("Lost response");
      statusUp = false; return refusal("The prepared owner transaction expired before submission.");
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ownerPress("Withdraw to my wallet"); await press("Check existing owner transaction");
  assert.doesNotMatch(ui.container.textContent!, /not accepted|discarded|cleared/);
  assert.match(ui.container.textContent!, /An earlier submission of this signed withdrawal may already be on Solana, so it was kept\. This does not mean it failed/);
  assert.equal(button("Check existing owner transaction").disabled, false);
  assert.equal(button("Withdraw to my wallet").disabled, true);
});

test("a first owner submission refused without notSaved is decided by the server's record, never assumed unsaved", async () => {
  state.runtime.live.programId = PROGRAM;
  signedBytes = () => WIRE;
  let submits = 0, record: "pending" | "unheld" | "unreadable" = "pending", statusUp = true;
  respond = async (path, body) => {
    if (path === "status") return statusUp ? json(state) : json({ error: "Solana is temporarily unavailable.", ownerFacing: true }, 503);
    if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
    if (path === "owner" && body?.stage === "submit") {
      submits++;
      if (record === "pending" && submits === 1) { ownerTransaction(WIRE_SIGNATURE, "pending", "withdraw"); return refusal("This request conflicts with an owner transaction that was just recorded."); }
      if (record === "pending") return json({ result: { signature: WIRE_SIGNATURE, status: "finalized" } });
      if (record === "unreadable" && submits === 1) { statusUp = false; return refusal("This request conflicts with an owner transaction that was just recorded."); }
      if (record === "unreadable") return unsaved("Another owner transaction is already saved.");
      return refusal("This request conflicts with an owner transaction that was just recorded.");
    }
    throw new Error("Unexpected fixture route");
  };
  // The server holds these bytes as pending: they are kept, and checking them again settles them.
  await render(); await ownerPress("Withdraw to my wallet");
  assert.doesNotMatch(ui.container.textContent!, /not accepted|discarded|cleared/);
  assert.match(ui.container.textContent!, /just recorded\. The server holds this signed withdrawal and still records it as awaiting confirmation, so it was kept/);
  await press("Check existing owner transaction");
  assert.match(ui.container.textContent!, /Owner transaction: finalized/);
  assert.equal(signCount, 1); assert.deepEqual(ownerCalls(), ["prepare:withdraw", "submit", "submit"]);
  // The server's record cannot be read: kept, and the next refusal is a retry.
  await ui.close(); ui = testDom(); state = initial(); state.runtime.live.programId = PROGRAM; calls = []; submits = 0; record = "unreadable"; statusUp = true;
  await render(); await ownerPress("Withdraw to my wallet");
  assert.doesNotMatch(ui.container.textContent!, /not accepted|discarded|cleared/);
  assert.match(ui.container.textContent!, /The server could not say whether it saved this signed withdrawal, so it was kept\. This does not mean it failed/);
  assert.equal(button("Check existing owner transaction").disabled, false);
  // It may have been saved, so the next submission is a retry: a notSaved answer to it no longer drops bytes the server holds.
  ownerTransaction(WIRE_SIGNATURE, "pending", "withdraw"); statusUp = true;
  await press("Check existing owner transaction");
  assert.doesNotMatch(ui.container.textContent!, /not accepted|discarded|cleared/);
  assert.match(ui.container.textContent!, /already saved\. The server holds this signed withdrawal and still records it as awaiting confirmation, so it was kept/);
  // The server holds no record of them: discarded, and the owner starts again.
  await ui.close(); ui = testDom(); state = initial(); state.runtime.live.programId = PROGRAM; calls = []; submits = 0; record = "unheld"; statusUp = true;
  await render(); await ownerPress("Withdraw to my wallet");
  assert.match(ui.container.textContent!, /just recorded\. The server holds no record of this signed withdrawal, so it has been discarded\. Start it again to review and sign a new one\./);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Check existing owner transaction"), false);
  assert.equal(button("Withdraw to my wallet").disabled, false);
});
test("a refused retry marked notSaved still keeps bytes the server's record holds, and never says they were not sent", async () => {
  state.runtime.live.programId = PROGRAM;
  signedBytes = () => WIRE;
  let submits = 0;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
    if (path === "owner" && body?.stage === "submit") {
      // The first submission was saved and broadcast, but its answer was lost.
      if (++submits === 1) { ownerTransaction(WIRE_SIGNATURE, "pending", "withdraw"); throw new Error("Lost response"); }
      // This request saved nothing: it says nothing about the first one.
      return unsaved("Another owner transaction is already saved.");
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ownerPress("Withdraw to my wallet"); await press("Check existing owner transaction");
  const text = ui.container.textContent!;
  assert.doesNotMatch(text, /not accepted|discarded|cleared|nothing was sent/i);
  assert.match(text, /already saved\. The server holds this signed withdrawal and still records it as awaiting confirmation, so it was kept/);
  assert.equal(button("Check existing owner transaction").disabled, false);
  assert.equal(button("Withdraw to my wallet").disabled, true);
  // Once the server's record is someone else's, the bytes are cleared, still without "not sent", and the owner is told to check before starting again.
  ownerTransaction("another-sig", "finalized", "revoke");
  await press("Check existing owner transaction");
  assert.doesNotMatch(ui.container.textContent!, /not accepted|nothing was sent/i);
  assert.match(ui.container.textContent!, /The server holds no record of this signed withdrawal, so it was cleared and cannot be resent\. If an earlier submission reached Solana, its result shows on Solana and in your vault balances\. Check there before starting it again to review and sign a new one\./);
  assert.equal(signCount, 1);
});
test("a 404 or a sign-in answer to signed owner bytes is not a refusal: the bytes are kept", async () => {
  state.runtime.live.programId = PROGRAM;
  const answers = [refusal("Solana trading is not available.", 404), refusal("Your sign-in expired.", 401), refusal("Too many requests.", 429), refusal(SOLANA_OTHER_SIGN_IN, 403), refusal("Request timed out.", 408)];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
    if (path === "owner" && body?.stage === "submit") return answers.shift()!;
    throw new Error("Unexpected fixture route");
  };
  await render(); await ownerPress("Withdraw to my wallet");
  for (let i = 0; i < 4; i++) {
    assert.doesNotMatch(ui.container.textContent!, /not accepted|discarded|cleared/);
    assert.equal(button("Check existing owner transaction").disabled, false);
    await press("Check existing owner transaction");
  }
  assert.doesNotMatch(ui.container.textContent!, /not accepted|discarded|cleared/);
  assert.equal(button("Check existing owner transaction").disabled, false);
  assert.equal(signCount, 1);
  assert.deepEqual(ownerCalls(), ["prepare:withdraw", "submit", "submit", "submit", "submit", "submit"]);
});

test("a 4xx on a re-check of an accepted permission keeps its bytes and session key", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let sessionPublicKey = "", submits = 0;
  let activation: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") { sessionPublicKey = String(body.sessionPublicKey); return json({ setup: await permissionTransaction(sessionPublicKey, saved) }); }
    if (path === "setup" && body?.stage === "submit") {
      submits++;
      if (submits === 1) { Object.assign(state.runtime.live, { ownerTransaction: { signature: "accepted-sig", status: "pending", kind: "session" } }); return json({ registration: { signature: "accepted-sig", status: "pending" } }); }
      if (submits === 2) return refusal("Invalid owner transaction confirmation.", 400);
      return json({ registration: { signature: "accepted-sig", status: "finalized" } });
    }
    if (path === "setup" && body?.stage === "activate") { activation = body; return json({ live: { registered: true } }); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.match(ui.container.textContent!, /awaiting final confirmation/);
  await press("Finish permission registration");
  const text = ui.container.textContent!;
  assert.doesNotMatch(text, /not accepted|discarded/);
  assert.match(text, /Invalid owner transaction confirmation\. The server holds this signed permission and still records it as awaiting final confirmation, so its session key was kept/);
  assert.ok(button("Finish permission registration"));
  await press("Finish permission registration");
  // The same bytes, the same session key: never a second permission.
  assert.equal(signCount, 1);
  const submitted = calls.filter((call) => call.path === "setup" && call.body?.stage === "submit").map((call) => call.body!.signedTransactionBase64);
  assert.deepEqual(submitted, ["AQID", "AQID", "AQID"]);
  const seed = Buffer.from(String(activation!.sessionSecretKey), "base64");
  assert.equal(base58Encode(ed25519.getPublicKey(seed)), sessionPublicKey);
});

test("a permission submit refused without notSaved, or a notSaved retry, keeps a permission the server holds and its session key", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  signedBytes = () => WIRE;
  let sessionPublicKey = "", submits = 0;
  let activation: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") { sessionPublicKey = String(body.sessionPublicKey); return json({ setup: await permissionTransaction(sessionPublicKey, saved) }); }
    if (path === "setup" && body?.stage === "submit") {
      submits++;
      // The server saved these bytes, then refused without saying it saved nothing.
      if (submits === 1) { ownerTransaction(WIRE_SIGNATURE, "pending", "session"); return refusal("This request conflicts with an owner transaction that was just recorded."); }
      // A retry refused as notSaved: this request saved nothing, the first one did.
      if (submits === 2) return unsaved("Another owner transaction is already saved.");
      return json({ registration: { signature: WIRE_SIGNATURE, status: "finalized" } });
    }
    if (path === "setup" && body?.stage === "activate") { activation = body; return json({ live: { registered: true } }); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.doesNotMatch(ui.container.textContent!, /not accepted|discarded|nothing was activated/);
  assert.match(ui.container.textContent!, /The server holds this signed permission and still records it as awaiting final confirmation, so its session key was kept/);
  await press("Finish permission registration");
  assert.doesNotMatch(ui.container.textContent!, /not accepted|discarded|nothing was activated/);
  assert.match(ui.container.textContent!, /already saved\. The server holds this signed permission and still records it as awaiting final confirmation, so its session key was kept/);
  await press("Finish permission registration");
  assert.equal(signCount, 1);
  assert.equal(base58Encode(ed25519.getPublicKey(Buffer.from(String(activation!.sessionSecretKey), "base64"))), sessionPublicKey);
});
test("a refused permission retry the server holds no record of is cleared without claiming it was never sent", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let submits = 0;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    if (path === "setup" && body?.stage === "submit") {
      if (++submits === 1) throw new Error("Lost response");
      return refusal("The prepared owner transaction expired before submission.");
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.ok(button("Finish permission registration"));
  await press("Finish permission registration");
  const text = ui.container.textContent!;
  assert.doesNotMatch(text, /not accepted|nothing was activated/);
  assert.match(text, /expired before submission\. The server holds no record of this signed permission, so it and its session key were cleared from this page\. Refresh to check whether a permission is active/);
  assert.equal(button("Register bounded trading permission").disabled, false);
  assert.equal(signCount, 1); assert.equal(calls.some((call) => call.body?.stage === "activate"), false);
});

test("a confirmed permission whose activation is refused keeps its session key while the server holds it", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let sessionPublicKey = "", activations = 0;
  let activation: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") { sessionPublicKey = String(body.sessionPublicKey); return json({ setup: await permissionTransaction(sessionPublicKey, saved) }); }
    if (path === "setup" && body?.stage === "submit") {
      Object.assign(state.runtime.live, { ownerTransaction: { signature: "fixture-chain-signature", status: "finalized", kind: "session" } });
      return json({ registration: { signature: "fixture-chain-signature", status: "finalized" } });
    }
    if (path === "setup" && body?.stage === "activate") {
      // The first vault read lags the finalized permission.
      if (++activations === 1) return refusal("The current vault permission does not match the signed limits.", 400);
      activation = body; return json({ live: { registered: true } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.doesNotMatch(ui.container.textContent!, /discarded/);
  assert.match(ui.container.textContent!, /does not match the signed limits\. This permission is confirmed on Solana but is not active yet, so its session key was kept/);
  await press("Finish permission registration");
  assert.equal(signCount, 1); assert.equal(activations, 2);
  const seed = Buffer.from(String(activation!.sessionSecretKey), "base64");
  assert.equal(base58Encode(ed25519.getPublicKey(seed)), sessionPublicKey);
});

test("an activation refused because a revocation landed after the permission was prepared drops its session key instead of offering a retry", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let activations = 0;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    if (path === "setup" && body?.stage === "submit") {
      Object.assign(state.runtime.live, { ownerTransaction: { signature: "fixture-chain-signature", status: "finalized", kind: "session" } });
      return json({ registration: { signature: "fixture-chain-signature", status: "finalized" } });
    }
    if (path === "setup" && body?.stage === "activate") { activations++; return refusal(SOLANA_REGISTERED_AFTER_REVOKE); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.equal(activations, 1);
  assert.ok(ui.container.textContent!.includes(`${SOLANA_REGISTERED_AFTER_REVOKE} Its session key has been discarded from this page.`), ui.container.textContent!);
  assert.doesNotMatch(ui.container.textContent!, /session key was kept|Finish permission registration again shortly/);
  assert.equal(button("Finish permission registration"), undefined, "no retry that cannot succeed");
  assert.equal(signCount, 1);
});

test("a refused permission submit discards the signed bytes and the next click prepares a fresh one", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  const sessions: string[] = [];
  let activation: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") { sessions.push(String(body.sessionPublicKey)); return json({ setup: await permissionTransaction(sessions.at(-1)!, saved) }); }
    if (path === "setup" && body?.stage === "submit") {
      if (sessions.length === 1) return unsaved("The prepared owner transaction expired before submission.");
      return json({ registration: { signature: "fixture-chain-signature", status: "finalized" } });
    }
    if (path === "setup" && body?.stage === "activate") { activation = body; return json({ live: { registered: true } }); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.equal(signCount, 1);
  assert.match(ui.container.textContent!, /expired before submission\. The signed permission was not accepted, so it has been discarded/);
  // Not "Finish permission registration": retrying the refused bytes could never succeed.
  await register();
  assert.equal(signCount, 2); assert.equal(sessions.length, 2);
  assert.equal(calls.filter((call) => call.path === "setup" && call.body?.stage === "submit").length, 2);
  const seed = Buffer.from(String(activation!.sessionSecretKey), "base64");
  assert.equal(base58Encode(ed25519.getPublicKey(seed)), sessions[1]);
});

test("a registration that later fails on chain is discarded instead of being activated forever", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let outcome = "pending";
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    if (path === "setup" && body?.stage === "submit") return json({ registration: { signature: "fixture-chain-signature", status: outcome } });
    if (path === "setup" && body?.stage === "activate") return refusal("The permission transaction failed. Prepare a new permission.");
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.match(ui.container.textContent!, /awaiting final confirmation/);
  assert.equal(calls.some((call) => call.body?.stage === "activate"), false);
  outcome = "failed";
  await press("Finish permission registration");
  assert.match(ui.container.textContent!, /The permission transaction failed\. No session was activated/);
  assert.equal(calls.some((call) => call.body?.stage === "activate"), false);
  assert.equal(button("Register bounded trading permission").disabled, false);
  assert.equal(signCount, 1);
});

test("a held permission that expires before activation is discarded without resubmitting it", async () => {
  // The page's clock is the test's: the permission expires when the test ticks
  // past it, never while a loaded machine is still registering it.
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  try {
    state = initial("live"); state.runtime.live.programId = PROGRAM;
    const saved = { ...liveLimits(), expiresAtMs: Date.now() + 400 }; state.binding.limits = saved;
    respond = async (path, body) => {
      if (path === "status") return json(state);
      if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
      if (path === "setup" && body?.stage === "submit") return json({ registration: { signature: "fixture-chain-signature", status: "pending" } });
      throw new Error("Unexpected fixture route");
    };
    await render(); await register();
    assert.match(ui.container.textContent!, /awaiting final confirmation/);
    // Still held before its expiry: finishing it submits the same bytes again.
    await act(async () => { mock.timers.tick(399); });
    await press("Finish permission registration");
    assert.match(ui.container.textContent!, /awaiting final confirmation/);
    assert.equal(calls.filter((call) => call.path === "setup" && call.body?.stage === "submit").length, 2);
    await act(async () => { mock.timers.tick(1); });
    await press("Finish permission registration");
    assert.match(ui.container.textContent!, /This permission expired at .* before it was activated, so its session key has been discarded/);
    assert.equal(calls.filter((call) => call.path === "setup" && call.body?.stage === "submit").length, 2);
    assert.equal(calls.some((call) => call.body?.stage === "activate"), false);
    assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Finish permission registration"), false);
  } finally { mock.timers.reset(); }
});

test("a confirmed permission the server no longer holds drops its session key instead of retrying", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    // Another device prepared a newer owner transaction: the server's record is no longer this one.
    if (path === "setup" && body?.stage === "submit") return json({ registration: { signature: "fixture-chain-signature", status: "finalized" } });
    if (path === "setup" && body?.stage === "activate") return refusal("The signed permission does not match this session key.", 400);
    throw new Error("Unexpected fixture route");
  };
  await render(); await register();
  assert.match(ui.container.textContent!, /does not match this session key\. The server no longer holds this permission, so it cannot be activated and its session key has been discarded/);
  assert.equal(button("Register bounded trading permission").disabled, false);
});

const quoteFor = (lifetimeMs: number, quotedAtMs = Date.now()) => ({ source: "jupiter", inputMint: SOLANA_USDG_MINT, outputMint: OWNER, inAmount: "1000000", outAmount: "10000000",
  minOutAmount: "9950000", slippageBps: 50, contextSlot: 1, quotedAtMs, expiresAtMs: quotedAtMs + lifetimeMs });
test("a previewed minimum expires with its quote and the trade needs a new preview", async () => {
  state.runtime.paper = paper;
  // The page's clock and its expiry timer are the test's: the expiry is asserted
  // at an exact instant, never against a real sleep and the machine's load.
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const lifetime = 20_000;
    const trades: Record<string, unknown>[] = [];
    respond = async (path, body) => {
      if (path === "status") return json(state);
      if (path === "intent" && body?.action === "preview") return json({ preview: { quote: quoteFor(lifetime) } });
      if (path === "intent" && body?.action === "trade") { trades.push(body); return json({ receipt: { mode: "paper", requestId: (body.intent as { requestId: string }).requestId } }); }
      throw new Error("Unexpected fixture route");
    };
    await render(); await ui.click("Preview trade");
    assert.match(ui.container.textContent!, /Minimum received: 0\.00995 wrapped SOL/);
    assert.equal(button("Simulate trade").disabled, false);
    // The page re-renders when the quote's lifetime has passed (its timer fires a millisecond after).
    await act(async () => { mock.timers.tick(lifetime + 1); });
    // Its minimum is no longer offered and nothing can be traded on it.
    assert.ok(!ui.container.textContent!.includes("Minimum received"));
    assert.match(ui.container.textContent!, /This quote expired\. Preview again/);
    assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Simulate trade"), false);
    assert.equal(trades.length, 0);
    await ui.click("Preview trade"); await ui.click("Simulate trade");
    assert.equal(trades.length, 1);
    // The trade carries exactly the minimum the owner was shown: the server refuses it, sending nothing, below that.
    assert.equal((trades[0]!.intent as { minOutAmount?: string }).minOutAmount, "9950000");
  } finally { mock.timers.reset(); }
});
test("a quote's time left is said in whole seconds, and one second is never \"1 seconds\"", () => onTestClock(async () => {
  state.runtime.paper = paper;
  let lifetime = 20_000;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") return json({ preview: { quote: quoteFor(lifetime) } });
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Preview trade");
  assert.match(ui.container.textContent!, /This quote is valid for about 20 seconds\. The trade is quoted again/);
  lifetime = 1_000;
  await ui.click("Preview trade");
  assert.match(ui.container.textContent!, /This quote is valid for about 1 second\. The trade is quoted again/);
}));
test("a trade carries the minimum of its own preview, and nothing is sent without a current preview of exactly that trade", async () => {
  state.runtime.paper = paper;
  const trades: Record<string, unknown>[] = [];
  let minimum = "9950000";
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") {
      const intent = body.intent as { amountRaw: string };
      return json({ preview: { quote: { ...quoteFor(20_000), inAmount: intent.amountRaw, minOutAmount: minimum } } });
    }
    if (path === "intent" && body?.action === "trade") { trades.push(body); return json({ receipt: { mode: "paper", requestId: (body.intent as { requestId: string }).requestId } }); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Preview trade");
  assert.equal(button("Simulate trade").disabled, false);
  // A different amount drops the preview: its minimum belonged to another trade.
  await type("USDG to spend", "2");
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Simulate trade"), false);
  assert.doesNotMatch(ui.container.textContent!, /Minimum received/);
  assert.equal(trades.length, 0);
  // The new amount's own preview, and its own minimum, travel with its trade.
  minimum = "19900000";
  await ui.click("Preview trade"); await ui.click("Simulate trade");
  assert.equal(trades.length, 1);
  const intent = trades[0]!.intent as { amountRaw: string; minOutAmount?: string };
  assert.equal(intent.amountRaw, "2000000"); assert.equal(intent.minOutAmount, "19900000");
});

test("the Solana fetch keeps a refusal's validated notSaved and freshMinOutAmount, and otherwise answers as requestJson does", async () => {
  const { SolanaRequestError, refusedByServer } = await import("./SolanaOwnerActions");
  const { RequestError, UNREACHABLE } = await import("./request-json");
  const answer = (response: () => Response) => { globalThis.fetch = async () => response(); return screen.solanaRequestJson<unknown>("/api/solana/intent", { method: "POST", body: "{}" }).then(() => null, (e: unknown) => e); };
  const moved = await answer(() => json({ error: "The price moved. Preview again; nothing was sent.", ownerFacing: true, freshMinOutAmount: "9000000" }, 409)) as InstanceType<typeof SolanaRequestError>;
  assert.ok(moved instanceof SolanaRequestError); assert.ok(moved instanceof RequestError); assert.ok(refusedByServer(moved));
  assert.equal(moved.status, 409); assert.equal(moved.message, "The price moved. Preview again; nothing was sent."); assert.equal(moved.freshMinOutAmount, "9000000"); assert.equal(moved.notSaved, false);
  const unsaved = await answer(() => json({ error: "Nothing prepared.", ownerFacing: true, notSaved: true }, 409)) as InstanceType<typeof SolanaRequestError>;
  assert.equal(unsaved.notSaved, true); assert.equal(unsaved.freshMinOutAmount, null);
  // Anything but the exact shapes reads as absent.
  for (const [notSaved, fresh] of [["true", "0"], [1, "09000000"], [null, 9000000], [{}, "9e6"], [false, "9000000.0"], [[true], " 9000000"], [undefined, "1".repeat(40)], [undefined, "-1"]] as const) {
    const odd = await answer(() => json({ error: "Refused.", ownerFacing: true, notSaved, freshMinOutAmount: fresh }, 409)) as InstanceType<typeof SolanaRequestError>;
    assert.equal(odd.notSaved, false, JSON.stringify(notSaved)); assert.equal(odd.freshMinOutAmount, null, JSON.stringify(fresh));
  }
  // No answer, an answer that is not JSON, an unexplained 5xx, and success: requestJson's sentences.
  const none = await answer(() => { throw new TypeError("network down"); }) as InstanceType<typeof SolanaRequestError>;
  assert.equal(none.status, 0); assert.equal(none.message, UNREACHABLE);
  const proxy = await answer(() => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })) as Error & { status: number };
  assert.equal(proxy.status, 502); assert.equal(proxy.message, "merrymen answered with an error (502). Try again in a moment.");
  const warn = mock.method(console, "warn", () => undefined);
  try {
    const hidden = await answer(() => json({ error: "internal detail" }, 503)) as Error & { status: number };
    assert.equal(hidden.message, "merrymen answered with an error (503). Try again in a moment."); assert.equal(warn.mock.callCount(), 1);
  } finally { warn.mock.restore(); }
  const owned = await answer(() => json({ error: "Solana is temporarily unavailable.", ownerFacing: true }, 503)) as Error;
  assert.equal(owned.message, "Solana is temporarily unavailable.");
  const text = await answer(() => new Response("ok", { status: 200 })) as Error & { status: number };
  assert.equal(text.message, "merrymen sent back something that isn't data. Try again in a moment.");
  globalThis.fetch = async () => json({ preview: 1 });
  assert.deepEqual(await screen.solanaRequestJson("/api/solana/intent"), { preview: 1 });
  // A caller's cancellation reaches the request.
  const abort = new AbortController(); let seen: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => { seen = init?.signal ?? undefined; abort.abort(); throw new DOMException("aborted", "AbortError"); };
  const cancelled = await screen.solanaRequestJson("/api/solana/status", { signal: abort.signal }).then(() => null, (e: unknown) => e as Error & { status: number });
  assert.equal(seen?.aborted, true); assert.equal(cancelled!.status, 0);
});
test("a paced preview or trade (429) is a wait, not a failure: nothing more is sent and the preview stays", async () => {
  state.runtime.paper = paper;
  const trades: Record<string, unknown>[] = [];
  let pacePreview = true, paceTrade = true;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") return pacePreview ? json({ error: "Too many Solana previews. Try again in 3 seconds.", ownerFacing: true }, 429) : json({ preview: { quote: quoteFor(20_000) } });
    if (path === "intent" && body?.action === "trade") {
      trades.push(body);
      if (paceTrade) return json({ error: "Too many Solana trade requests. This request was not processed; a trade you already placed is unaffected. Refresh to check it, then try again in 2 seconds.", ownerFacing: true }, 429);
      return json({ receipt: { mode: "paper", requestId: (body.intent as { requestId: string }).requestId } });
    }
    throw new Error("Unexpected fixture route");
  };
  // Text, never the node: a failed assertion must not inspect a whole DOM.
  const alert = () => ui.container.querySelector('[role="alert"]')?.textContent ?? null;
  await render(); await ui.click("Preview trade");
  assert.equal(alert(), null);
  assert.equal(ui.container.querySelector(".solana-notice[role=status]")?.textContent, "Too many Solana previews. Try again in 3 seconds.");
  assert.equal(calls.filter((call) => call.path === "intent").length, 1);
  pacePreview = false;
  await ui.click("Preview trade");
  assert.equal(ui.container.querySelector(".solana-notice")?.textContent ?? null, null, "the next request clears the wait");
  await ui.click("Simulate trade");
  assert.equal(alert(), null);
  assert.match(ui.container.querySelector(".solana-notice[role=status]")!.textContent!, /^Too many Solana trade requests\. This request was not processed/);
  assert.equal(trades.length, 1);
  // The preview the owner saw is still there, to try again with the same request and minimum.
  assert.match(ui.container.textContent!, /Minimum received: 0\.00995 wrapped SOL/);
  assert.equal(button("Simulate trade").disabled, false);
  paceTrade = false;
  await ui.click("Simulate trade");
  assert.equal(trades.length, 2); assert.deepEqual(trades[1], trades[0]);
  assert.match(ui.container.textContent!, /Simulated trade recorded/);
});
const PRICE_MOVED = "The price moved. Preview again; nothing was sent.";
test("the page's price-moved and too-small sentences, and its write-off slippage, are the server's own", async () => {
  const api = readFileSync(fileURLToPath(new URL("../lib/solana-api.ts", import.meta.url)), "utf8");
  assert.equal(screen.SOLANA_PRICE_MOVED, PRICE_MOVED);
  assert.ok(api.includes(`const PRICE_MOVED = "${screen.SOLANA_PRICE_MOVED}";`), "solana-api.ts's PRICE_MOVED");
  assert.ok(api.includes(`const TOO_SMALL = "${screen.SOLANA_TOO_SMALL}";`), "solana-api.ts's TOO_SMALL");
  const { SOLANA_PAPER_WRITE_OFF_SLIPPAGE_BPS } = await import("../../../worker/src/solana-paper-store");
  assert.equal(screen.SOLANA_WRITE_OFF_SLIPPAGE_BPS, SOLANA_PAPER_WRITE_OFF_SLIPPAGE_BPS);
});
test("a price-moved refusal drops the stale preview and offers the fresh minimum only for the owner's own click, as the same request", async () => {
  state.runtime.paper = paper;
  const trades: Record<string, unknown>[] = [];
  let answers: Array<() => Response> = [];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") return json({ preview: { quote: quoteFor(20_000) } });
    if (path === "intent" && body?.action === "trade") { trades.push(body); return answers.shift()!(); }
    throw new Error("Unexpected fixture route");
  };
  const moved = (fresh?: unknown) => () => json({ error: PRICE_MOVED, ownerFacing: true, ...(fresh === undefined ? {} : { freshMinOutAmount: fresh }) }, 409);
  const alert = () => ui.container.querySelector('[role="alert"]')?.textContent ?? null;
  const offer = () => [...ui.container.querySelectorAll("button")].find((item) => item.textContent === "Simulate trade at the new minimum");
  answers = [moved("9000000")];
  await render(); await ui.click("Preview trade"); await ui.click("Simulate trade");
  assert.equal(trades.length, 1); assert.equal((trades[0]!.intent as { minOutAmount: string }).minOutAmount, "9950000");
  // Nothing went wrong and nothing was sent: no alert, and the refused minimum is never offered again.
  assert.equal(alert(), null);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Simulate trade"), false);
  assert.match(ui.container.textContent!, /The price moved, so nothing was sent\. The current quote guarantees at least 0\.009 wrapped SOL, below the 0\.00995 wrapped SOL you previewed\./);
  assert.doesNotMatch(ui.container.textContent!, /Minimum received/);
  // Nothing more is sent until the owner clicks.
  await settle();
  assert.equal(trades.length, 1);
  assert.equal(offer()!.disabled, false);
  // The click sends exactly the fresh minimum, as the same trade: same request ID, same amount.
  answers = [() => json({ receipt: { mode: "paper", requestId: (trades[0]!.intent as { requestId: string }).requestId } })];
  await ui.click("Simulate trade at the new minimum");
  assert.equal(trades.length, 2);
  const [first, second] = trades.map((trade) => trade.intent as Record<string, unknown>);
  assert.equal(second!.minOutAmount, "9000000");
  assert.deepEqual({ ...second, minOutAmount: undefined }, { ...first, minOutAmount: undefined });
  assert.match(ui.container.textContent!, /Simulated trade recorded/);
  // If it moves again, the server refuses again, and the next fresh minimum is offered against the one just refused.
  await ui.click("Start a new trade"); await ui.click("Preview trade");
  answers = [moved("9500000"), moved("9400000")];
  await ui.click("Simulate trade"); await ui.click("Simulate trade at the new minimum");
  assert.equal(trades.length, 4);
  assert.equal((trades[3]!.intent as { minOutAmount: string }).minOutAmount, "9500000");
  assert.match(ui.container.textContent!, /guarantees at least 0\.0094 wrapped SOL, below the 0\.0095 wrapped SOL you previewed/);
  assert.equal(trades.length, 4);
});
test("a price-moved refusal without a usable fresh minimum offers nothing to trade: preview again", async () => {
  state.runtime.paper = paper;
  const trades: Record<string, unknown>[] = [];
  let fresh: unknown;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") return json({ preview: { quote: quoteFor(20_000) } });
    if (path === "intent" && body?.action === "trade") { trades.push(body); return json({ error: PRICE_MOVED, ownerFacing: true, freshMinOutAmount: fresh }, 409); }
    throw new Error("Unexpected fixture route");
  };
  await render();
  // Missing, malformed, not canonical, or not below the refused minimum of 9950000: never offered.
  for (const value of [undefined, "0", "09000000", "-9000000", "9e6", "9000000.0", " 9000000", 9_000_000, "1".repeat(40), "9950000", "9950001"]) {
    fresh = value;
    await ui.click("Preview trade"); await ui.click("Simulate trade");
    const buttons = [...ui.container.querySelectorAll("button")].map((item) => item.textContent);
    assert.ok(!buttons.some((text) => text?.startsWith("Simulate trade")), JSON.stringify(value));
    assert.doesNotMatch(ui.container.textContent!, /Minimum received|new minimum|guarantees at least/);
    assert.equal(ui.container.querySelector('[role="alert"]')?.textContent ?? null, null);
    assert.equal(ui.container.querySelector(".solana-notice")?.textContent, PRICE_MOVED);
  }
  assert.equal(trades.length, 11);
});
test("a fresh minimum expires like a preview, and is then never sent", async () => {
  state.runtime.paper = paper;
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const trades: Record<string, unknown>[] = [];
    respond = async (path, body) => {
      if (path === "status") return json(state);
      if (path === "intent" && body?.action === "preview") return json({ preview: { quote: quoteFor(20_000) } });
      if (path === "intent" && body?.action === "trade") { trades.push(body); return json({ error: PRICE_MOVED, ownerFacing: true, freshMinOutAmount: "9000000" }, 409); }
      throw new Error("Unexpected fixture route");
    };
    await render(); await ui.click("Preview trade"); await ui.click("Simulate trade");
    assert.ok([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Simulate trade at the new minimum"));
    await act(async () => { mock.timers.tick(20_001); });
    assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent?.startsWith("Simulate trade")), false);
    assert.match(ui.container.textContent!, /This quote expired\. Preview again/);
    assert.equal(trades.length, 1);
  } finally { mock.timers.reset(); }
});
const TOO_SMALL = "This amount is too small to trade: no route returns anything for it. Nothing was sent or recorded. Try a larger amount.";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const hasButton = (text: string) => [...ui.container.querySelectorAll("button")].some((item) => item.textContent === text);
test("a paper lot is offered for write-off only after the market answers its whole sale with zero output, and only once confirmed", async () => {
  // An ordinary wrapped SOL lot, a wrapped SOL dust lot is what the form sells; another token's lot the form cannot sell.
  state.runtime.paper = { ...paper, positions: [{ mint: OWNER, decimals: 9, amountRaw: "5", costBasisUsdgRaw: "1" }, { mint: BONK, decimals: 5, amountRaw: "1200", costBasisUsdgRaw: "2" }] } as never;
  const writeOffs: unknown[] = [];
  let writeOff: () => Response = () => json({ error: "A route still buys this position back, so it cannot be written off. Sell it instead. Nothing was changed.", ownerFacing: true }, 409);
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") {
      const intent = body.intent as { inputMint: string; amountRaw: string };
      // The whole wrapped SOL lot and the whole token lot are dust; any other amount is quoted.
      if ((intent.inputMint === OWNER && intent.amountRaw === "5") || (intent.inputMint === BONK && intent.amountRaw === "1200")) return json({ error: TOO_SMALL, ownerFacing: true }, 400);
      if (intent.inputMint === OWNER && intent.amountRaw === "4") return json({ error: TOO_SMALL, ownerFacing: true }, 400);
      return json({ preview: { quote: { ...quoteFor(20_000), inputMint: intent.inputMint, outputMint: SOLANA_USDG_MINT, inAmount: intent.amountRaw } } });
    }
    if (path === "paper/write-off") { writeOffs.push(body); return writeOff(); }
    throw new Error("Unexpected fixture route");
  };
  const text = () => ui.container.textContent!;
  await render();
  // No write-off for either lot yet; the token lot the form cannot sell can be checked.
  assert.equal(hasButton("Write off…"), false); assert.equal(hasButton("Write off at zero"), false);
  assert.equal(hasButton("Check for write-off"), true);
  assert.equal([...ui.container.querySelectorAll("button")].filter((item) => item.textContent === "Check for write-off").length, 1, "never for the wrapped SOL lot the form sells");
  // Selling part of the wrapped SOL lot is just too small: no offer.
  const direction = [...ui.container.querySelectorAll("label")].find((item) => item.textContent?.startsWith("Direction"))!.querySelector("select")!;
  await act(async () => { direction.value = "sell"; direction.dispatchEvent(new ui.dom.window.Event("change", { bubbles: true })); });
  await type("Wrapped SOL to sell", "0.000000004");
  await ui.click("Preview trade");
  assert.equal(ui.container.querySelector('[role="alert"]')?.textContent, TOO_SMALL);
  assert.equal(hasButton("Write off…"), false);
  // Selling all of it: the market quotes nothing, so the lot is offered for write-off instead of "try a larger amount".
  await type("Wrapped SOL to sell", "0.000000005");
  await ui.click("Preview trade");
  assert.equal(ui.container.querySelector('[role="alert"]')?.textContent ?? null, null);
  assert.match(ui.container.querySelector(".solana-notice")!.textContent!, /No route buys back this whole lot, so it cannot be sold\. Nothing was sent or recorded/);
  assert.match(text(), /Wrapped SOL: 0\.000000005No route buys back this whole lot: the market quotes nothing for it, so it cannot be sold\./);
  // Nothing is sent until the owner confirms, and "Keep it" sends nothing.
  await ui.click("Write off…");
  assert.match(text(), /Write off this whole lot of 0\.000000005 wrapped SOL\? It is booked at zero: removed from your paper portfolio at no value, which frees its position slot\. This cannot be undone\./);
  assert.equal(writeOffs.length, 0);
  await ui.click("Keep it");
  assert.equal(hasButton("Write off at zero"), false); assert.equal(hasButton("Write off…"), false);
  assert.equal(writeOffs.length, 0);
  // Confirmed: exactly the lot's mint, nothing else. The server's refusal is shown in its own words and ends the offer.
  await ui.click("Preview trade"); await ui.click("Write off…"); await ui.click("Write off at zero");
  assert.deepEqual(writeOffs, [{ mint: OWNER }]);
  assert.equal(ui.container.querySelector('[role="alert"]')?.textContent, "A route still buys this position back, so it cannot be written off. Sell it instead. Nothing was changed.");
  assert.equal(hasButton("Write off at zero"), false); assert.equal(hasButton("Write off…"), false);
  // The token lot: its check previews selling all of it at the write-off's slippage, records nothing, and offers it.
  await ui.click("Check for write-off");
  const check = calls.filter((call) => call.path === "intent").at(-1)!.body!;
  assert.equal(check.action, "preview"); assert.equal(check.mode, "paper");
  assert.deepEqual({ ...(check.intent as Record<string, unknown>), requestId: "id" }, { kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "id", inputMint: BONK,
    outputMint: SOLANA_USDG_MINT, amountRaw: "1200", slippageBps: 100 });
  assert.equal(calls.some((call) => call.body?.action === "trade"), false);
  // A paced write-off is a wait: the offer stays to try again.
  writeOff = () => json({ error: "Too many Solana paper requests. Nothing was changed. Try again in 4 seconds.", ownerFacing: true }, 429);
  await ui.click("Write off…"); await ui.click("Write off at zero");
  assert.equal(ui.container.querySelector('[role="alert"]')?.textContent ?? null, null);
  assert.equal(ui.container.querySelector(".solana-notice")!.textContent, "Too many Solana paper requests. Nothing was changed. Try again in 4 seconds.");
  assert.equal(hasButton("Write off at zero"), true);
  // Written off: the portfolio is read again, and the lot is gone.
  writeOff = () => { state.runtime.paper = { ...paper, positions: [{ mint: OWNER, decimals: 9, amountRaw: "5", costBasisUsdgRaw: "1" }] } as never; return json({ paper: state.runtime.paper, writtenOff: { mint: BONK } }); };
  await ui.click("Write off at zero");
  assert.deepEqual(writeOffs.at(-1), { mint: BONK });
  assert.doesNotMatch(text(), new RegExp(BONK));
  assert.match(ui.container.querySelector(".solana-notice")!.textContent!, /written off at zero/);
});
test("the write-off offer holds only for the exact lot the market answered: a changed lot is offered nothing until checked again", async () => {
  state.runtime.paper = { ...paper, positions: [{ mint: BONK, decimals: 5, amountRaw: "1200", costBasisUsdgRaw: "2" }] } as never;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") return json({ error: TOO_SMALL, ownerFacing: true }, 400);
    throw new Error("Unexpected fixture route");
  };
  const grow = async (amountRaw: string) => {
    state.runtime.paper = { ...paper, positions: [{ mint: BONK, decimals: 5, amountRaw, costBasisUsdgRaw: "2" }] } as never;
    await ui.click("Refresh account");
  };
  await render(); await ui.click("Check for write-off");
  assert.equal(hasButton("Write off…"), true);
  // The lot changed after the market's answer: that answer was about another amount, so nothing is offered.
  await grow("1300");
  assert.equal(hasButton("Write off…"), false); assert.equal(hasButton("Write off at zero"), false);
  assert.equal(hasButton("Check for write-off"), true);
  // The same holds while the owner is confirming.
  await ui.click("Check for write-off"); await ui.click("Write off…");
  assert.equal(hasButton("Write off at zero"), true);
  await grow("1400");
  assert.equal(hasButton("Write off…"), false); assert.equal(hasButton("Write off at zero"), false);
  assert.doesNotMatch(ui.container.textContent!, /Write off this whole lot/);
  assert.equal(calls.some((call) => call.path === "paper/write-off"), false);
});
test("a booked write-off says so and shows the lot gone, even when the status read after it is paced or never arrives", async () => {
  const lot = { mint: BONK, decimals: 5, amountRaw: "1200", costBasisUsdgRaw: "2" };
  const PACED = "Your Solana account was refreshed too often. Try again in 3 seconds.";
  // How the status read after the write-off answers, and what the write-off's 200 carries.
  let after: "paced" | "unreachable" = "paced";
  let answer: () => unknown = () => ({ paper: { ...paper, version: 4, positions: [] }, writtenOff: { mint: BONK } });
  let booked = false;
  respond = async (path, body) => {
    if (path === "status") {
      if (!booked) return json(state);
      if (after === "paced") return json({ error: PACED, ownerFacing: true }, 429);
      throw new Error("offline");
    }
    if (path === "intent" && body?.action === "preview") return json({ error: TOO_SMALL, ownerFacing: true }, 400);
    if (path === "paper/write-off") { booked = true; return json(answer()); }
    throw new Error("Unexpected fixture route");
  };
  const writeOff = async () => {
    await ui.click("Check for write-off"); await ui.click("Write off…"); await ui.click("Write off at zero");
  };
  for (const [scenario, failure, carries] of [
    ["paced", PACED, "its book"], ["unreachable", "Can't reach merrymen right now.", "its book"],
    // An answer without a usable book (none, or one still listing the lot): the shown book drops exactly that lot.
    ["paced", PACED, "no book"], ["paced", PACED, "the lot"],
    // A book older than the one shown never replaces it: only the lot is dropped.
    ["paced", PACED, "an older book"],
  ] as const) {
    const label = `${scenario}, ${carries}`;
    await ui.close(); ui = testDom(); calls = []; booked = false; after = scenario;
    state.runtime.paper = { ...paper, version: 3, positions: [lot] } as never;
    answer = carries === "its book" ? () => ({ paper: { ...paper, version: 4, positions: [] }, writtenOff: { mint: BONK } })
      : carries === "no book" ? () => ({ writtenOff: { mint: BONK } })
      : carries === "an older book" ? () => ({ paper: { ...paper, cashRaw: "5000000", version: 2, positions: [] }, writtenOff: { mint: BONK } })
      : () => ({ paper: { ...paper, version: 4, positions: [lot] }, writtenOff: { mint: BONK } });
    await render(); await writeOff();
    assert.equal(calls.filter((call) => call.path === "paper/write-off").length, 1, label);
    assert.equal(calls.at(-1)!.path, "status", label);
    // The success is said first, the failed read after it, and nothing reads as a failure.
    assert.equal(ui.container.querySelector('[role="alert"]')?.textContent ?? null, null, label);
    assert.equal(ui.container.querySelector(".solana-notice")!.textContent,
      `The lot was written off at zero and removed from your paper portfolio. Your account could not be read again just now: ${failure}`, label);
    // The lot is gone from the portfolio, with nothing left to check or write off.
    assert.doesNotMatch(ui.container.textContent!, new RegExp(BONK), label);
    assert.match(ui.container.textContent!, /Paper portfolio1000 USDGSimulated cash\. 0 open position\(s\)\./, label);
    assert.equal(hasButton("Check for write-off"), false, label);
    assert.equal(hasButton("Write off…"), false, label); assert.equal(hasButton("Write off at zero"), false, label);
  }
});
test("with expired saved limits the paper card says a lot can be checked for write-off only after saving new ones", async () => {
  const expired = Date.UTC(2025, 0, 2, 9, 30, 0);
  state.runtime.paper = { ...paper, positions: [{ mint: BONK, decimals: 5, amountRaw: "1200", costBasisUsdgRaw: "2" }] } as never;
  const NOTE = "Your saved limits expired at 2025-01-02 09:30:00 UTC. Checking a lot for write-off previews selling all of it, which needs current limits: save new limits above, then check it.";
  const notes = () => [...ui.container.querySelectorAll('[role="status"]')].map((item) => item.textContent).filter((text) => /expired|write-off/.test(text ?? ""));
  // Current limits: no note.
  await render();
  assert.deepEqual(notes(), []);
  // Expired: said once, next to the lots, and the check stays available (the server decides).
  state.binding.limits = { ...limits, expiresAtMs: expired }; state.runtime.limits = state.binding.limits;
  await ui.click("Refresh account");
  assert.deepEqual(notes(), [NOTE]);
  assert.equal(hasButton("Check for write-off"), true);
  // No lot held: nothing to check, so no note.
  state.runtime.paper = { ...paper, positions: [] } as never;
  await ui.click("Refresh account");
  assert.deepEqual(notes(), []);
});
test("a lot a route still buys is never offered for write-off", async () => {
  state.runtime.paper = { ...paper, positions: [{ mint: BONK, decimals: 5, amountRaw: "1200", costBasisUsdgRaw: "2" }] } as never;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") return json({ preview: { quote: { ...quoteFor(20_000), inputMint: BONK, outputMint: SOLANA_USDG_MINT, inAmount: "1200" } } });
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Check for write-off");
  assert.equal(hasButton("Write off…"), false);
  assert.equal(ui.container.querySelector(".solana-notice")!.textContent, "A route still buys this whole lot back, so it is not dust and cannot be written off.");
  assert.equal(calls.some((call) => call.path === "paper/write-off"), false);
});
test("a quote that is already past its expiry never offers a trade, whatever the device clock says", async () => {
  state.runtime.paper = paper;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    // Server clock ten minutes ahead of the device; the quote itself has no lifetime left.
    if (path === "intent" && body?.action === "preview") return json({ preview: { quote: quoteFor(0, Date.now() + 600_000) } });
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Preview trade");
  assert.match(ui.container.textContent!, /This quote expired/);
  assert.equal(calls.some((call) => call.body?.action === "trade"), false);
});

test("receipts show the minimum the recorded trade enforced, not the earlier preview", async () => {
  state = initial("live"); Object.assign(state.runtime.live, { ready: true, canExit: true, programId: PROGRAM });
  let sent: Record<string, unknown> | undefined;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") return json({ preview: { quote: quoteFor(20_000) } });
    if (path === "intent" && body?.action === "trade") {
      sent = body;
      return json({ receipt: { mode: "live", requestId: (body.intent as { requestId: string }).requestId, status: "pending", intent: { outputMint: OWNER }, minOutAmount: "9900000", quotedOutAmount: "9940000" } });
    }
    throw new Error("Unexpected fixture route");
  };
  await render(); await ui.click("Preview trade"); await ui.click("Place live trade");
  assert.ok(sent);
  assert.match(ui.container.textContent!, /Quoted output: 0\.00994 wrapped SOL\. Minimum enforced on chain: 0\.0099 wrapped SOL\./);
  state = initial("paper"); state.runtime.paper = paper;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "intent" && body?.action === "preview") return json({ preview: { quote: quoteFor(20_000) } });
    if (path === "intent" && body?.action === "trade") return json({ receipt: { mode: "paper", requestId: "r", intent: { outputMint: OWNER }, quote: { minOutAmount: "9950000" }, outputAmountRaw: "9990000" } });
    throw new Error("Unexpected fixture route");
  };
  await ui.click("Refresh account"); await ui.click("Start a new trade"); await ui.click("Preview trade"); await ui.click("Simulate trade");
  assert.match(ui.container.textContent!, /Simulated output: 0\.00999 wrapped SOL, against a quoted minimum of 0\.00995 wrapped SOL\./);
});

const EXPORT_FLAG = "NEXT_PUBLIC_MERRYMEN_SOLANA_OWNER_KEY_EXPORT";
/** A live owner whose vault the server has read: what key export can protect. */
function liveVault() {
  state = initial("live");
  Object.assign(state.runtime.live, { programId: PROGRAM, vault: "Vau1tAddress1111111111111111111111111111111", balances: { slot: 9, cashUsdg: "0", wsolRaw: "0" } });
}
const exportCard = () => [...ui.container.querySelectorAll(".solana-card")].find((item) => [...item.querySelectorAll("button")].some((b) => b.textContent === "Export owner key with Privy"));
async function withExportFlag(value: string | undefined, run: () => Promise<void>) {
  const before = process.env[EXPORT_FLAG];
  if (value === undefined) delete process.env[EXPORT_FLAG]; else process.env[EXPORT_FLAG] = value;
  try { await run(); } finally { if (before === undefined) delete process.env[EXPORT_FLAG]; else process.env[EXPORT_FLAG] = before; }
}
test("owner key export is off unless the deployment turns it on, even for a live vault", async () => {
  for (const value of [undefined, "", "0", "true"]) await withExportFlag(value, async () => {
    liveVault(); await render();
    assert.equal(!!exportCard(), false, String(value));
    assert.doesNotMatch(ui.container.textContent!, /Export owner key|solana-recover|recovery tool/);
    await ui.close(); ui = testDom();
  });
  assert.equal(exportCount, 0);
});
test("with export turned on, it is offered only to the bound owner of a vault the server has read", async () => {
  await withExportFlag("1", async () => {
    // Paper only: no vault to protect, so no reason to handle the key.
    await render(); assert.equal(!!exportCard(), false);
    // Status could not load: nothing shows that a vault exists.
    respond = async () => { throw new Error("Merrymen is down"); };
    await ui.click("Refresh account"); assert.equal(!!exportCard(), false);
    respond = async (path) => { if (path === "status") return json(state); throw new Error("Unexpected fixture route"); };
    liveVault(); await ui.click("Refresh account");
    const card = exportCard()!;
    assert.ok(card.textContent!.includes(`Vault program: ${PROGRAM}`));
    assert.ok(card.textContent!.includes("Vault: Vau1tAddress1111111111111111111111111111111"));
    assert.ok(card.textContent!.includes(`Owner wallet: ${OWNER}`));
    assert.match(card.textContent!, /Anyone who has this key controls your owner wallet and everything in your vault/);
    assert.match(card.textContent!, /Merrymen never sees it and will never ask for it/);
    assert.match(card.textContent!, /any app or person offering to recover your funds/);
    // Export needs an explicit acknowledgement each time.
    assert.equal(button("Export owner key with Privy").disabled, true);
    const acknowledge = [...card.querySelectorAll("label")].find((item) => item.textContent?.includes("anyone with this key can take my funds"))!.querySelector("input")!;
    await act(async () => { acknowledge.click(); });
    await ui.click("Export owner key with Privy");
    assert.equal(exportCount, 1);
    assert.match(ui.container.textContent!, /export window is closed/);
    assert.equal(button("Export owner key with Privy").disabled, true, "acknowledged again before another export");
    assert.equal(signCount, 0);
    // Never for a different connected wallet.
    state.binding.owner = base58Encode(new Uint8Array(32).fill(5));
    await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
  });
});
test("the export card never names a merrymen command that cli/bin.mjs does not register", async () => {
  const cli = readFileSync(fileURLToPath(new URL("../../../cli/bin.mjs", import.meta.url)), "utf8");
  await withExportFlag("1", async () => {
    liveVault(); await render();
    const text = exportCard()!.textContent!;
    for (const [, command] of text.matchAll(/merrymen ([a-z][a-z0-9-]*)/g)) assert.ok(cli.includes(`case "${command}"`), `merrymen ${command} is not a registered command`);
  });
});

test("the live card shows warnings, the fee payer's level and the runtime's setup and refund blockers", async () => {
  state = initial("live");
  const refund = "Someone sent USDG to your vault's next swap account. The vault returns it to your own USDG token account, which is closed or not safe to use (it has a delegate or close authority, or is frozen). Reopen your USDG token account in your wallet, or withdraw a little USDG here, which opens it. Buying is paused until then; exits remain available.";
  Object.assign(state.runtime.live, { programId: PROGRAM, blockers: ["Live Solana trading needs the same answer from two independent RPC providers.", "The fee payer warning threshold is misconfigured.", refund],
    warnings: ["The shared network fee payer is low (0.01 SOL; operators are alerted below 0.02 SOL). Trading continues."],
    feePayer: { lamports: "10000000", exitMinimumLamports: "2044280", buyMinimumLamports: "2084280", lowLamports: "20000000", level: "low" } });
  await render();
  const text = ui.container.textContent!;
  assert.ok(text.includes("Live Solana trading needs the same answer from two independent RPC providers."));
  assert.ok(text.includes("The fee payer warning threshold is misconfigured."));
  assert.ok(text.includes(refund));
  assert.match(text, /The shared network fee payer is low \(0\.01 SOL; operators are alerted below 0\.02 SOL\)\. Trading continues\./);
  assert.match(text, /Shared network fee payer: low; trading continues and operators are alerted \(0\.01 SOL\)/);
  assert.ok(ui.container.querySelector("[aria-label=Warnings]"));
  // A malformed or unknown fee payer answer hides that line; it never blanks the screen.
  Object.assign(state.runtime.live, { feePayer: { lamports: "-5", level: "drained" }, warnings: [] });
  await ui.click("Refresh account");
  assert.doesNotMatch(ui.container.textContent!, /Shared network fee payer/);
  assert.match(ui.container.textContent!, /Owner controls/);
});

test("owner controls show the owner wallet's SOL against what revoke and withdraw need, and the recoverable SOL", async () => {
  state.runtime.live.programId = PROGRAM;
  Object.assign(state.runtime.live, { ownerWallet: { lamports: "500000", revokeLamports: "895880", withdrawLamports: "2934280" },
    recoverable: { nativeLamports: "1500000000", unsyncedWsolLamports: "250000000" } });
  await render();
  const text = () => ui.container.textContent!;
  assert.match(text(), /Your owner wallet holds 0\.0005 SOL and pays the network fees of these transactions\. To revoke it must hold at least 0\.00089588 SOL; to withdraw, up to 0\.00293428 SOL/);
  assert.match(text(), /Merrymen adds a priority fee only from SOL beyond that, and this page signs none above 0\.001 SOL/);
  assert.match(text(), /That is too little to revoke\. Send SOL to your owner wallet now/);
  assert.match(text(), /The vault account holds 1\.5 SOL above its rent reserve/);
  assert.match(text(), /0\.25 SOL was sent to the vault's wrapped SOL account without being wrapped/);
  Object.assign(state.runtime.live, { ownerWallet: { lamports: "900000", revokeLamports: "895880", withdrawLamports: "2934280" }, recoverable: { nativeLamports: "0", unsyncedWsolLamports: "0" } });
  await ui.click("Refresh account");
  assert.doesNotMatch(text(), /too little to revoke/);
  assert.doesNotMatch(text(), /without being wrapped/);
  assert.match(text(), /The vault account holds 0 SOL above its rent reserve/);
});

test("Withdraw native SOL prepares the runtime's withdraw-sol in lamports, and shows what the owner wallet must hold", async () => {
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") {
      assert.deepEqual(body, { stage: "prepare", action: "withdraw-sol", amountRaw: "1500000000" });
      // 200,000 units at 50,000 micro-lamports: a 0.00001 SOL priority fee.
      return json({ prepared: { transactionBase64: await ownerBytes(body, priorityFee(200_000, 50_000n)), requiredLamports: "905880", ownerLamports: "10000000", priorityFeeLamports: "10000" } });
    }
    if (path === "owner" && body?.stage === "submit") return json({ result: { signature: "native-proof", status: "finalized" } });
    throw new Error("Unexpected fixture route");
  };
  await render();
  await type("Native SOL to withdraw", "1.5");
  // Shown in the review before the wallet opens, and still while it is open on these bytes.
  const wallet = deferred<Uint8Array>();
  signedBytes = () => wallet.promise;
  await ownerPress("Withdraw native SOL");
  assert.equal(signCount, 1);
  assert.match(ui.container.textContent!, /The prepared native SOL withdrawal needs your owner wallet to hold at least 0\.00090588 SOL \(it holds 0\.01 SOL\): its network fee, a priority fee of 0\.00001 SOL so it lands under congestion/);
  wallet.resolve(Uint8Array.from([1, 2, 3])); await settle();
  assert.match(ui.container.textContent!, /Owner transaction: finalized/);
  assert.deepEqual(calls.filter((call) => call.path === "owner").map((call) => call.body!.stage), ["prepare", "submit"]);
});
const COST = /needs your owner wallet to hold at least/;
test("the owner-controls cost line describes only the action in flight: gone once it finishes, and after a refused prepare", async () => {
  state.runtime.live.programId = PROGRAM;
  let prepare: (body: Record<string, unknown>) => Promise<Response> = async (body) =>
    json({ prepared: { transactionBase64: await ownerBytes(body, priorityFee(200_000, 50_000n)), requiredLamports: "905880", ownerLamports: "10000000" } });
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return prepare(body);
    if (path === "owner" && body?.stage === "submit") return json({ result: { signature: "revoke-proof", status: "finalized" } });
    throw new Error("Unexpected fixture route");
  };
  await render();
  const wallet = deferred<Uint8Array>();
  signedBytes = () => wallet.promise;
  await ownerPress("Revoke all Solana sessions");
  assert.match(ui.container.textContent!, /The prepared revocation needs your owner wallet to hold at least 0\.00090588 SOL \(it holds 0\.01 SOL\)/);
  // The revocation completes: the line no longer describes anything the server is asking for.
  wallet.resolve(Uint8Array.from([1, 2, 3])); await settle();
  assert.match(ui.container.textContent!, /Owner transaction: finalized/);
  assert.doesNotMatch(ui.container.textContent!, COST);
  // A withdrawal the server refuses to prepare never shows the revocation's cost again.
  prepare = async () => refusal("Refresh the pending owner transaction before preparing another.");
  await ownerPress("Withdraw to my wallet");
  assert.match(ui.container.textContent!, /Refresh the pending owner transaction before preparing another/);
  assert.doesNotMatch(ui.container.textContent!, COST);
  // A wallet closed on a reviewed withdrawal leaves its review to sign again while its window lasts; discarding it ends the line.
  prepare = async (body) => json({ prepared: { transactionBase64: await ownerBytes(body), requiredLamports: "2934280" } });
  signedBytes = () => Promise.reject(new Error("The owner closed the wallet."));
  await ownerPress("Withdraw to my wallet");
  assert.match(ui.container.textContent!, /The owner closed the wallet\./);
  assert.match(ui.container.textContent!, /The prepared withdrawal needs your owner wallet to hold at least 0\.00293428 SOL/);
  assert.equal(signCount, 2);
  await press("Discard");
  assert.doesNotMatch(ui.container.textContent!, COST);
  assert.equal(calls.filter((call) => call.path === "owner" && call.body?.stage === "submit").length, 1, "only the revocation was ever submitted");
});
test("every owner action is reviewed before the wallet opens: what it does, its fee and what the wallet must hold", async () => {
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") {
      // 0.00001 SOL of priority fee, on at least each instruction's default compute budget; none for the resume request.
      const fee = body.action === "resume-buys" ? [] : body.action === "withdraw" ? priorityFee(400_000, 25_000n) : priorityFee(200_000, 50_000n);
      return json({ prepared: { transactionBase64: await ownerBytes(body, fee), requiredLamports: "905880", ownerLamports: "10000000",
        priorityFeeLamports: body.action === "resume-buys" ? "0" : "10000" } });
    }
    if (path === "owner" && body?.stage === "submit") return json({ result: { signature: "owner-proof", status: "finalized" } });
    throw new Error("Unexpected fixture route");
  };
  const text = () => ui.container.textContent!;
  const submits = () => calls.filter((call) => call.path === "owner" && call.body?.stage === "submit").length;
  await render();
  await type("Amount to withdraw", "2.5"); await type("Native SOL to withdraw", "0.75");
  for (const [label, effect] of [
    ["Revoke all Solana sessions", /the prepared revocation revokes every trading session of your vault, and nothing else\./],
    ["Ask wallet to resume buys", /the prepared request to resume buys turns your vault's buying back on, with its existing limits, and nothing else\./],
    ["Withdraw to my wallet", /the prepared withdrawal withdraws 2\.5 USDG from your vault to your own USDG token account, and nothing else\./],
    ["Withdraw native SOL", /the prepared native SOL withdrawal withdraws 0\.75 SOL from your vault to your owner wallet, and nothing else\./],
  ] as const) {
    const before = submits();
    await press(label);
    // Prepared and checked, nothing signed: the owner sees what it does and costs first. A revocation too: one extra click.
    assert.equal(signCount, 0, label); assert.equal(submits(), before, label);
    assert.match(text(), /Review before your wallet opens/, label);
    assert.match(text(), effect, label);
    if (label === "Ask wallet to resume buys") assert.match(text(), /It carries no priority fee: your owner wallet pays only the network fee\./);
    else assert.match(text(), /It carries a priority fee of 0\.00001 SOL \(at most 0\.001 SOL\), paid by your owner wallet with the network fee so it lands under congestion\./, label);
    assert.match(text(), /needs your owner wallet to hold at least 0\.00090588 SOL \(it holds 0\.01 SOL\)/, label);
    assert.match(text(), /Nothing has been signed yet\. Sign within about 45 seconds/, label);
    // Discard sends nothing and signs nothing.
    await press("Discard");
    assert.doesNotMatch(text(), /Review before your wallet opens/, label);
    assert.equal(signCount, 0, label); assert.equal(submits(), before, label);
  }
  // Signing the reviewed bytes opens the wallet once and submits them.
  await press("Revoke all Solana sessions");
  await press("Sign with my wallet");
  assert.equal(signCount, 1); assert.equal(submits(), 1);
  assert.match(text(), /Owner transaction: finalized/);
  assert.doesNotMatch(text(), /Review before your wallet opens/);
});
test("a reviewed owner transaction not signed in time is discarded without opening the wallet", async () => {
  state.runtime.live.programId = PROGRAM;
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  try {
    respond = async (path, body) => {
      if (path === "status") return json(state);
      if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
      throw new Error("Unexpected fixture route");
    };
    // press settles on the real clock (WebCrypto and the prepare request), so a slow runner still shows the review.
    await render(); await press("Withdraw to my wallet");
    assert.match(ui.container.textContent!, /Review before your wallet opens/);
    await act(async () => { mock.timers.tick(30_000); });
    assert.match(ui.container.textContent!, /Sign within about 15 seconds/);
    // At the very end it says one second, never "1 seconds".
    await act(async () => { mock.timers.tick(14_000); });
    assert.match(ui.container.textContent!, /Sign within about 1 second, or start it again/);
    await act(async () => { mock.timers.tick(1_000); });
    assert.doesNotMatch(ui.container.textContent!, /Review before your wallet opens/);
    assert.match(ui.container.textContent!, /The prepared withdrawal was not signed in time, so it was discarded\. Nothing was signed\./);
    assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Sign with my wallet"), false);
    assert.equal(signCount, 0);
    assert.equal(calls.some((call) => call.body?.stage === "submit"), false);
  } finally { mock.timers.reset(); }
});

test("a click on Sign with my wallet after the review's deadline, before its timer has run, opens no wallet and sends nothing", () => onTestClock(async () => {
  state.runtime.live.programId = PROGRAM;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return prepareAnswer(body);
    if (path === "owner" && body?.stage === "submit") return json({ result: { signature: "owner-proof", status: "finalized" } });
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Withdraw to my wallet");
  assert.match(ui.container.textContent!, /Review before your wallet opens/);
  // One millisecond before the deadline the review can still be signed: the check is the deadline itself.
  const shownAt = Date.now();
  mock.timers.setTime(shownAt + 44_999);
  signedBytes = () => Promise.reject(new Error("The owner closed the wallet."));
  await press("Sign with my wallet");
  assert.equal(signCount, 1);
  assert.match(ui.container.textContent!, /Review before your wallet opens/);
  // At the deadline the clock has passed it but the review's timer has not run (setTime fires no timer), so the button is still there.
  mock.timers.setTime(shownAt + 45_000);
  signedBytes = () => Uint8Array.from([1, 2, 3]);
  await press("Sign with my wallet");
  assert.equal(signCount, 1, "the wallet never opened");
  assert.equal(calls.some((call) => call.body?.stage === "submit"), false);
  assert.match(ui.container.querySelector('[role="alert"]')!.textContent!, /^This prepared withdrawal was not signed in time, so it was discarded\. Nothing was signed\. Start it again to prepare a new one\.$/);
  assert.doesNotMatch(ui.container.textContent!, /Review before your wallet opens/);
  assert.match(ui.container.textContent!, /The prepared withdrawal was not signed in time, so it was discarded\. Nothing was signed\./);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Sign with my wallet"), false);
}));

test("owner transaction bytes that do anything but what the owner asked never reach the wallet, and the fee shown is the one they carry", async () => {
  state.runtime.live.programId = PROGRAM;
  const vault = await deriveSolanaVaultAddress(PROGRAM, OWNER), stranger = base58Encode(new Uint8Array(32).fill(9));
  const usdgAccount = (wallet: string) => deriveSolanaAta(wallet, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
  const wsolAccount = (wallet: string) => deriveSolanaAta(wallet, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const transfer: Instruction = { programAddress: address(SOLANA_SYSTEM_PROGRAM), data: Uint8Array.of(2, 0, 0, 0, 0, 202, 154, 59, 0, 0, 0, 0),
    accounts: [{ address: address(OWNER), role: 3 }, { address: address(stranger), role: 1 }] };
  const syncNative = async (wallet: string, program = SOLANA_CLASSIC_TOKEN_PROGRAM): Promise<Instruction> =>
    ({ programAddress: address(program), data: Uint8Array.of(17), accounts: [{ address: address(await wsolAccount(wallet)), role: 1 }] });
  const withdrawUsdg = async (ownerToken: string, amount = 1_000_000n) => [await createAta(OWNER, SOLANA_USDG_MINT), buildWithdrawSolanaVaultInstruction({ programAddress: PROGRAM, vault, owner: OWNER,
    mint: SOLANA_USDG_MINT, tokenProgram: TOKEN_2022_PROGRAM, vaultToken: await usdgAccount(vault), ownerToken, amount })];
  let answer: (body: Record<string, unknown>) => Promise<{ transactionBase64: string; requiredLamports?: string; priorityFeeLamports?: string }>;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "owner" && body?.stage === "prepare") return json({ prepared: await answer(body) });
    if (path === "owner" && body?.stage === "submit") return json({ result: { signature: "owner-proof", status: "finalized" } });
    throw new Error("Unexpected fixture route");
  };
  await render();
  await type("Native SOL to withdraw", "1.5");
  const text = () => ui.container.textContent!;
  const refused: Array<[string, string, (body: Record<string, unknown>) => Promise<{ transactionBase64: string; requiredLamports?: string; priorityFeeLamports?: string }>, RegExp]> = [
    ["a revocation that also moves the owner's SOL", "Revoke all Solana sessions", async (body) => ({ transactionBase64: await ownerBytes(body, [transfer]) }), /The prepared revocation does not match what you asked for\. Nothing was signed/],
    ["a revocation that also registers a trading session", "Revoke all Solana sessions", async () => ({ transactionBase64: ownerPaid([
      buildRevokeSolanaSessionsInstruction({ programAddress: PROGRAM, vault, owner: OWNER }),
      buildCreateSolanaSessionInstruction({ programAddress: PROGRAM, vault, owner: OWNER, session: stranger, perTrade: 1n << 40n, daily: 1n << 40n, perTradeWsol: 1n << 40n, dailyWsol: 1n << 40n, maxOps: 96, expiresAt: 1n << 40n })]) }),
      /The prepared revocation does not match what you asked for/],
    ["a revocation of another owner's vault", "Revoke all Solana sessions", async () => ({ transactionBase64: ownerPaid([buildRevokeSolanaSessionsInstruction({ programAddress: PROGRAM, vault: await deriveSolanaVaultAddress(PROGRAM, stranger), owner: OWNER })]) }),
      /The prepared revocation does not match what you asked for/],
    ["a revocation under another program", "Revoke all Solana sessions", async () => ({ transactionBase64: ownerPaid([buildRevokeSolanaSessionsInstruction({ programAddress: stranger, vault, owner: OWNER })]) }),
      /The prepared revocation does not match what you asked for/],
    ["a resume request that pauses buying", "Ask wallet to resume buys", async () => ({ transactionBase64: ownerPaid([buildSetSolanaBreakerInstruction({ programAddress: PROGRAM, vault, authority: OWNER, paused: true })]) }),
      /The prepared request to resume buys does not match what you asked for/],
    ["a native SOL withdrawal of another amount", "Withdraw native SOL", async () => ({ transactionBase64: ownerPaid([buildWithdrawSolanaNativeInstruction({ programAddress: PROGRAM, vault, owner: OWNER, amount: 1_500_000_001n })]) }),
      /The prepared native SOL withdrawal does not match what you asked for/],
    ["a USDG withdrawal to someone else's token account", "Withdraw to my wallet", async () => ({ transactionBase64: ownerPaid(await withdrawUsdg(await usdgAccount(stranger))) }),
      /The prepared withdrawal does not match what you asked for/],
    ["a USDG withdrawal of another amount", "Withdraw to my wallet", async () => ({ transactionBase64: ownerPaid(await withdrawUsdg(await usdgAccount(OWNER), 2_000_000n)) }),
      /The prepared withdrawal does not match what you asked for/],
    ["a USDG withdrawal after a SyncNative of the vault's USDG account", "Withdraw to my wallet", async () => ({ transactionBase64: ownerPaid([
      { programAddress: address(SOLANA_CLASSIC_TOKEN_PROGRAM), data: Uint8Array.of(17), accounts: [{ address: address(await usdgAccount(vault)), role: 1 }] }, ...await withdrawUsdg(await usdgAccount(OWNER))]) }),
      /The prepared withdrawal does not match what you asked for/],
    ["a priority fee above 0.001 SOL", "Revoke all Solana sessions", async (body) => ({ transactionBase64: await ownerBytes(body, priorityFee(1_400_000, 1_000_000n)) }),
      /The prepared revocation does not match what you asked for/],
    ["a priority fee limit without a price", "Revoke all Solana sessions", async (body) => ({ transactionBase64: await ownerBytes(body, priorityFee(200_000, 50_000n).slice(0, 1)) }),
      /The prepared revocation does not match what you asked for/],
    // Below what the runtime gives the instructions with no limit (200,000 each): from an under-reported
    // simulation (1 unit × 1.2 + 40,000 headroom), it could run out of compute on chain, the owner paying each time.
    ["a revocation's compute limit from an under-reported simulation", "Revoke all Solana sessions", async (body) => ({ transactionBase64: await ownerBytes(body, priorityFee(40_002, 1n)) }),
      /The prepared revocation does not match what you asked for/],
    ["a revocation's compute limit one unit short of the default", "Revoke all Solana sessions", async (body) => ({ transactionBase64: await ownerBytes(body, priorityFee(199_999, 1n)) }),
      /The prepared revocation does not match what you asked for/],
    ["a withdrawal's compute limit below its two instructions' default", "Withdraw to my wallet", async (body) => ({ transactionBase64: await ownerBytes(body, priorityFee(399_999, 1n)) }),
      /The prepared withdrawal does not match what you asked for/],
    ["a stated fee its bytes do not carry", "Revoke all Solana sessions", async (body) => ({ transactionBase64: await ownerBytes(body, priorityFee(200_000, 50_000n)), requiredLamports: "905880", priorityFeeLamports: "0" }),
      /The prepared revocation's priority fee does not match its bytes\. Nothing was signed/],
    ["bytes that are not a transaction", "Revoke all Solana sessions", async () => ({ transactionBase64: "AQID" }), /The prepared revocation does not match what you asked for/],
  ];
  for (const [name, label, prepared, refusedWith] of refused) {
    answer = prepared;
    await press(label);
    assert.match(text(), refusedWith, name);
    assert.equal(signCount, 0, name);
    assert.equal(calls.some((call) => call.body?.stage === "submit"), false, name);
    assert.doesNotMatch(text(), /needs your owner wallet to hold/, name);
  }
  // What the server really builds is signed: the fee shown is the one decoded from the bytes, not the server's claim.
  answer = async (body) => ({ transactionBase64: await ownerBytes(body, priorityFee(200_000, 50_000n)), requiredLamports: "905880" });
  const wallet = deferred<Uint8Array>();
  signedBytes = () => wallet.promise;
  await ownerPress("Revoke all Solana sessions");
  assert.equal(signCount, 1);
  assert.match(text(), /The prepared revocation needs your owner wallet to hold at least 0\.00090588 SOL: its network fee, a priority fee of 0\.00001 SOL so it lands under congestion/);
  wallet.resolve(Uint8Array.from([1, 2, 3])); await settle();
  signedBytes = () => Uint8Array.from([1, 2, 3]);
  // A wrapped SOL withdrawal that first wraps native SOL sent to the vault's wrapped SOL account.
  const mint = [...ui.container.querySelectorAll("label")].find((item) => item.textContent?.startsWith("Asset"))!.querySelector("select")!;
  await act(async () => { mint.value = SOLANA_WRAPPED_SOL_MINT; mint.dispatchEvent(new ui.dom.window.Event("change", { bubbles: true })); });
  answer = async (body) => ({ transactionBase64: await ownerBytes(body, [await syncNative(vault)]) });
  await ownerPress("Withdraw to my wallet");
  assert.equal(signCount, 2);
  assert.deepEqual(calls.filter((call) => call.path === "owner" && call.body?.stage === "prepare").at(-1)!.body, { stage: "prepare", action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000000" });
  // But never a SyncNative of someone else's account, or under another token program.
  for (const before of [[await syncNative(stranger)], [await syncNative(vault, TOKEN_2022_PROGRAM)]]) {
    answer = async (body) => ({ transactionBase64: await ownerBytes(body, before) });
    await ownerPress("Withdraw to my wallet");
    assert.match(text(), /The prepared withdrawal does not match what you asked for/);
  }
  assert.equal(signCount, 2);
});

/** SetComputeUnitLimit and SetComputeUnitPrice, as the runtime adds them to an owner transaction. */
function priorityFee(units: number, microLamports: bigint): Instruction[] {
  const limit = new Uint8Array(5), price = new Uint8Array(9);
  limit[0] = 2; new DataView(limit.buffer).setUint32(1, units, true);
  price[0] = 3; new DataView(price.buffer).setBigUint64(1, microLamports, true);
  const program = address("ComputeBudget111111111111111111111111111111");
  return [{ programAddress: program, data: limit }, { programAddress: program, data: price }];
}
test("a permission's priority fee is shown from its bytes, with what the owner wallet must hold, before the wallet opens", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  let claimed = "10000";
  respond = async (path, body) => {
    if (path === "status") return json(state);
    // Six instructions get 1,200,000 units with no limit, so no less is signed:
    // 1,200,000 units at 8,333 micro-lamports, a 0.00001 SOL priority fee (ceil(9,999.6) lamports).
    if (path === "setup" && body?.stage === "prepare") return json({ setup: { ...await permissionTransaction(String(body.sessionPublicKey), saved, priorityFee(1_200_000, 8_333n)),
      requiredLamports: "9915880", ownerLamports: "50000000", priorityFeeLamports: claimed } });
    if (path === "setup" && body?.stage === "submit") return json({ registration: { signature: "fixture-chain-signature", status: "pending" } });
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Register bounded trading permission");
  const text = () => ui.container.textContent!;
  assert.equal(signCount, 0, "the wallet has not opened");
  assert.match(text(), /Review before your wallet opens/);
  assert.match(text(), /It carries a priority fee of 0\.00001 SOL \(at most 0\.001 SOL\), paid by your owner wallet/);
  assert.match(text(), /your owner wallet must hold at least 0\.00991588 SOL \(it holds 0\.05 SOL\), including rent for any vault and token accounts it opens/);
  assert.match(text(), /10 USDG per trade and 50 USDG per 24 hours/);
  assert.match(text(), /Nothing has been signed yet/);
  assert.equal(calls.some((call) => call.body?.stage === "submit"), false);
  await press("Sign permission with my wallet");
  assert.equal(signCount, 1);
  assert.equal(calls.filter((call) => call.body?.stage === "submit").length, 1);
  assert.match(text(), /awaiting final confirmation/);
  // Discarding a review signs nothing; a server that states another fee than its bytes never reaches the wallet.
  state = initial("live"); state.runtime.live.programId = PROGRAM; state.binding.limits = saved;
  await ui.close(); ui = testDom(); signCount = 0; calls = [];
  await render(); await press("Register bounded trading permission");
  await ui.click("Discard prepared permission");
  assert.ok(button("Register bounded trading permission")); assert.equal(signCount, 0);
  claimed = "0";
  await press("Register bounded trading permission");
  assert.match(text(), /The prepared permission's fee does not match its bytes\. Nothing was signed/);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Sign permission with my wallet"), false);
  assert.equal(signCount, 0);
});

test("a reviewed permission not signed in time is discarded without opening the wallet", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Register bounded trading permission");
  assert.match(ui.container.textContent!, /It carries no priority fee/);
  const now = Date.now;
  Date.now = () => now() + 46_000;
  try { await press("Sign permission with my wallet"); } finally { Date.now = now; }
  assert.match(ui.container.textContent!, /was not signed in time, so it was discarded\. Nothing was signed/);
  assert.equal(signCount, 0);
  assert.equal(calls.some((call) => call.body?.stage === "submit"), false);
  assert.equal(button("Register bounded trading permission").disabled, false);
});

test("the review's time left to sign counts down while it is open", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    throw new Error("Unexpected fixture route");
  };
  // The page's clock and its one-second re-render are the test's: each step is an exact instant.
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  try {
    await render(); await press("Register bounded trading permission");
    assert.match(ui.container.textContent!, /Sign within about 45 seconds/);
    // Ten seconds on, the page says so without anyone touching it (each one-second tick re-renders it).
    await act(async () => { mock.timers.tick(10_000); });
    assert.match(ui.container.textContent!, /Sign within about 35 seconds/);
    // At the very end it says one second, never "1 seconds".
    await act(async () => { mock.timers.tick(34_000); });
    assert.match(ui.container.textContent!, /Sign within about 1 second, or register again/);
    assert.equal(signCount, 0);
  } finally { mock.timers.reset(); }
});

/**
 * A live owner whose prepared permission is under review with `leftMs` left
 * to sign. The page's clock and timers are the test's (the caller enables
 * mock.timers): the window passes only when the test ticks it, never while a
 * loaded machine is still rendering.
 */
async function reviewEndingIn(leftMs: number) {
  state = initial("live"); state.runtime.live.programId = PROGRAM;
  const saved = liveLimits(); state.binding.limits = saved;
  const progress = { submits: 0, activated: false };
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "setup" && body?.stage === "prepare") return json({ setup: await permissionTransaction(String(body.sessionPublicKey), saved) });
    if (path === "setup" && body?.stage === "submit") { progress.submits++; return json({ registration: { signature: "fixture-chain-signature", status: "finalized" } }); }
    if (path === "setup" && body?.stage === "activate") { progress.activated = true; state.runtime.live.ready = true; return json({ live: { registered: true } }); }
    throw new Error("Unexpected fixture route");
  };
  await render(); await press("Register bounded trading permission");
  await act(async () => { mock.timers.tick(45_000 - leftMs); });
  assert.match(ui.container.textContent!, /Nothing has been signed yet/);
  return progress;
}
/** Runs `body` with the page's setTimeout, setInterval and Date on the test's clock. */
async function onTestClock(body: () => Promise<void>) {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  try { await body(); } finally { mock.timers.reset(); }
}
const LAPSED = /not signed in time|Nothing was signed/;
test("a review whose deadline passes while the wallet is open never says nothing was signed, and the signed permission is submitted", () => onTestClock(async () => {
  const progress = await reviewEndingIn(300);
  const wallet = deferred<Uint8Array>();
  signedBytes = () => wallet.promise;
  await press("Sign permission with my wallet");
  assert.equal(signCount, 1, "the wallet is open");
  // The deadline passes with the wallet still open: the review's timer fires and leaves it alone.
  await act(async () => { mock.timers.tick(600); });
  assert.doesNotMatch(ui.container.textContent!, LAPSED);
  // The owner signs: the bytes are submitted (the server's window decides) and activated.
  wallet.resolve(Uint8Array.from([1, 2, 3]));
  await settle();
  assert.equal(progress.submits, 1); assert.equal(progress.activated, true);
  assert.match(ui.container.textContent!, /Registered permission ready/);
  assert.doesNotMatch(ui.container.textContent!, LAPSED);
}));
test("a wallet that refuses after the review's deadline leaves the review lapsed; before it, the review stays to sign again", () => onTestClock(async () => {
  let progress = await reviewEndingIn(300);
  let refuse!: (error: Error) => void;
  signedBytes = () => new Promise<Uint8Array>((_, reject) => { refuse = reject; });
  await press("Sign permission with my wallet");
  await act(async () => { mock.timers.tick(600); });
  assert.doesNotMatch(ui.container.textContent!, LAPSED);
  refuse(new Error("The owner closed the wallet."));
  await settle();
  assert.match(ui.container.textContent!, /The owner closed the wallet\./);
  assert.match(ui.container.textContent!, /The prepared permission was not signed in time, so it was discarded\. Nothing was signed/);
  assert.equal([...ui.container.querySelectorAll("button")].some((item) => item.textContent === "Sign permission with my wallet"), false);
  assert.equal(progress.submits, 0);
  // Refused well before the deadline: the same review stays, and signing it again submits once.
  await ui.close(); ui = testDom(); signCount = 0;
  progress = await reviewEndingIn(30_000);
  signedBytes = () => Promise.reject(new Error("The owner closed the wallet."));
  await press("Sign permission with my wallet");
  assert.doesNotMatch(ui.container.textContent!, LAPSED);
  assert.match(ui.container.textContent!, /Nothing has been signed yet/);
  signedBytes = () => Uint8Array.from([1, 2, 3]);
  await press("Sign permission with my wallet");
  assert.equal(signCount, 2); assert.equal(progress.submits, 1); assert.equal(progress.activated, true);
}));
/** The `merrymen solana-recover` command the card shows, as the arguments a shell passes. */
function cardCommand(text: string): string[] {
  const shown = text.match(/merrymen solana-recover (--program \S+ [^\n]*?)(?=The key goes|Nothing is signed|Use --rpc|$)/)?.[1];
  assert.ok(shown, text);
  return shown.trim().split(/\s+/);
}
/** What the card tells the owner to run first: the RPC goes in the environment, never on a command line. */
const RECOVER_RPC_READ = "read -rs MERRYMEN_SOLANA_RECOVER_RPC; export MERRYMEN_SOLANA_RECOVER_RPC";
const RECOVER_RPC_PUBLIC_ONLY = "Use --rpc <https-url> instead only for a public URL with no API key in it.";
/**
 * Runs the real tool on `args` offline: no answer ever comes from the RPC,
 * so it stops at its first chain read, or refuses before it. A generated
 * test key stands in on standard input. The environment is always explicit
 * (by default the RPC as the card's read -rs line leaves it), so a
 * MERRYMEN_SOLANA_RECOVER_RPC in the developer's own shell changes nothing.
 */
async function runTool(args: string[], list: readonly { programId: string; sha256: string }[],
  env: Record<string, string | undefined> = { MERRYMEN_SOLANA_RECOVER_RPC: "https://rpc.example.test" }) {
  const reads: string[] = [];
  const fetch = (async (url: unknown) => { reads.push(String(url)); throw new Error("offline"); }) as typeof globalThis.fetch;
  const key = base58Encode(crypto.getRandomValues(new Uint8Array(32)));
  const stdin = Object.assign((async function* () { yield key; })(), { isTTY: false });
  const error = await runSolanaRecoverCommand(args, { releases: list, fetch, stdin, env, sleep: async () => {}, log: () => {}, warn: () => {} })
    .then(() => null, (e: unknown) => e as Error);
  return { reads: reads.length, error };
}
const NOT_RELEASED = /is not a released Merrymen vault program/;
test("for a released program, step 2 names the signing command with the key on standard input and the pinned hash, and the tool accepts it", async () => {
  await withExportFlag("1", async () => {
    const pin = [{ programId: PROGRAM, sha256: "ab".repeat(32) }];
    releases = pin;
    // A hash in the status answer is never shown: the tool checks its own pin, not the server.
    liveVault(); Object.assign(state.runtime.live, { programSha256: "cd".repeat(32) });
    await render();
    const text = exportCard()!.textContent!;
    assert.ok(text.includes(`Step 2: recover without Merrymen`));
    assert.ok(text.includes(RECOVER_RPC_READ), text);
    assert.ok(text.includes(`merrymen solana-recover --program ${PROGRAM} --key-file - --send`), text);
    assert.ok(text.includes(RECOVER_RPC_PUBLIC_ONLY), text);
    // No provider URL on a command line: it would stay in shell history and ps.
    assert.doesNotMatch(text, /solana-recover --program \S+ --rpc|Replace <https-url>/);
    assert.match(text, /The key goes in on standard input \(--key-file -\), for example pbpaste \| merrymen solana-recover … on a Mac/);
    assert.match(text, /Never type the key into the command itself/);
    assert.ok(text.includes(`--owner ${OWNER} in place of --key-file - --send: nothing is signed or sent`));
    assert.ok(text.includes(`Vault program: ${PROGRAM}`));
    assert.ok(text.includes(`Released program binary SHA-256: ${"ab".repeat(32)}`));
    assert.doesNotMatch(text, /cdcdcdcd/);
    assert.match(text, /after checking that program's deployed binary against its released hash, built into the tool/);
    // Never the escape hatch the tool tells owners to refuse.
    assert.doesNotMatch(text, /unlisted-program|program-sha256/);
    // The tool's own program check passes on exactly these arguments, with the same pin: it goes on to read the chain.
    const args = cardCommand(text);
    assert.deepEqual(args, ["--program", PROGRAM, "--key-file", "-", "--send"]);
    assert.deepEqual(solanaRecoveryProgramTrust({ programId: PROGRAM, send: true, releases: pin }), { listed: true, sha256: "ab".repeat(32) });
    const run = await runTool(args, pin);
    assert.ok(run.reads > 0, "past the program check, at its first RPC read");
    assert.doesNotMatch(run.error?.message ?? "", NOT_RELEASED);
    // The RPC comes from the environment the read -rs line sets: without it the tool asks for it and reads nothing.
    const unset = await runTool(args, pin, {});
    assert.equal(unset.reads, 0); assert.match(unset.error!.message, /^Set MERRYMEN_SOLANA_RECOVER_RPC /);
    // The same command against a tool with no release refuses before reading anything: why it is shown only for a listed program.
    const unreleased = await runTool(args, []);
    assert.equal(unreleased.reads, 0); assert.match(unreleased.error!.message, NOT_RELEASED);
  });
});
test("for a program no release lists, step 2 offers only the read-only plan, which the tool accepts, and no hash", async () => {
  await withExportFlag("1", async () => {
    // Today's pin (none released), then a pin that lists another program.
    for (const pin of [undefined, [{ programId: OWNER, sha256: "ab".repeat(32) }], [{ programId: PROGRAM, sha256: "AB".repeat(32) }]]) {
      releases = pin;
      liveVault(); Object.assign(state.runtime.live, { programSha256: "ab".repeat(32) });
      await render();
      const text = exportCard()!.textContent!;
      assert.ok(text.includes("Step 2: check your vault without Merrymen"), JSON.stringify(pin));
      assert.match(text, /This vault program is not a released Merrymen vault program yet, so the Merrymen command-line tool does not sign for it/);
      assert.ok(text.includes(RECOVER_RPC_READ), text);
      assert.ok(text.includes(`merrymen solana-recover --program ${PROGRAM} --owner ${OWNER}`), text);
      assert.ok(text.includes(`Nothing is signed or sent. ${RECOVER_RPC_PUBLIC_ONLY}`), text);
      assert.doesNotMatch(text, /solana-recover --program \S+ --rpc|Replace <https-url>/);
      assert.doesNotMatch(text, /--send|--key-file|SHA-256|released hash|unlisted-program|program-sha256/);
      // Step 1 still keeps the owner's offline copy of the key.
      assert.ok(button("Export owner key with Privy"));
      const args = cardCommand(text);
      assert.deepEqual(args, ["--program", PROGRAM, "--owner", OWNER]);
      const run = await runTool(args, TOOL_RELEASES);
      assert.ok(run.reads > 0, "the plan is accepted and reads the chain");
      assert.doesNotMatch(run.error?.message ?? "", NOT_RELEASED);
      await ui.close(); ui = testDom();
    }
  });
});
test("the card's release pin is the one the recovery tool trusts by default", async () => {
  const recovery = createRequire(import.meta.url)(recoveryPath) as typeof import("./SolanaRecovery");
  // The card imports SOLANA_VAULT_RELEASES from core by type (solanaVaultReleases): a renamed pin fails
  // to compile. The tool must trust that very array, not a copy of its own.
  const core = createRequire(import.meta.url)("../../../packages/core/src/solana-live") as typeof import("../../../packages/core/src/solana-live");
  assert.equal(TOOL_RELEASES, core.SOLANA_VAULT_RELEASES, "the tool trusts core's pin, the one the card reads");
  assert.match(readFileSync(recoveryPath, "utf8"), /^import \{ SOLANA_VAULT_RELEASES \} from "\.\.\/\.\.\/\.\.\/packages\/core\/src\/solana-live";$/m,
    "the card reads the pin by a typed import, never by name");
  // The real pin (no test override): what the page offers to sign for is exactly what the tool signs for.
  assert.deepEqual(recovery.solanaVaultReleases(), TOOL_RELEASES);
  for (const release of TOOL_RELEASES) assert.equal(recovery.releasedProgramSha256(release.programId), release.sha256);
  // A malformed pin entry never counts as released.
  releases = [{ programId: PROGRAM, sha256: "not-a-hash" }, { programId: 7, sha256: "ab".repeat(32) } as unknown as { programId: string; sha256: string }];
  assert.deepEqual(recovery.solanaVaultReleases(), []);
  assert.equal(recovery.releasedProgramSha256(PROGRAM), null);
});

test("the recovery card waits for the status, and shows only for a live binding's read vault: never paper, unbound or a vault not read", async () => {
  await withExportFlag("1", async () => {
    // Loading: nothing is known about a vault yet.
    liveVault();
    const first = deferred<Response>();
    respond = async (path) => { if (path === "status") return first.promise; throw new Error("Unexpected fixture route"); };
    await render();
    assert.equal(!!exportCard(), false);
    await act(async () => { first.resolve(json(state)); });
    assert.ok(exportCard(), "shown once the status names a read vault");
    respond = async (path) => { if (path === "status") return json(state); throw new Error("Unexpected fixture route"); };
    // A live binding whose vault the server has not read (no balances, book or session).
    Object.assign(state.runtime.live, { balances: null }); await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
    // Paper only: the vault address is known but holds nothing of this account's.
    state = initial("paper"); Object.assign(state.runtime.live, { programId: PROGRAM, vault: "Vau1tAddress1111111111111111111111111111111" });
    await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
    // Paper, with the vault's balances read but no live book or session: still no card
    // (a live binding would show one: the paper restriction is what hides it).
    Object.assign(state.runtime.live, { balances: { slot: 9, cashUsdg: "5000000", wsolRaw: "0" } });
    await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
    // Paper with a live session still registered, or back to paper after trading live (a live book): no card
    // either, the stricter owner decision (SolanaScreen's recoveryVault). Revoke and withdraw stay in owner controls.
    Object.assign(state.runtime.live, { session: "Sess1onKey111111111111111111111111111111111" });
    await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
    assert.equal(button("Revoke all Solana sessions").disabled, false);
    Object.assign(state.runtime.live, { session: null, balances: null, book: { realizedPnlUsdgRaw: "0", networkFeesLamports: "0" } });
    await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
    // The same vault on a live binding does get the card.
    state.binding.requestedMode = "live"; state.runtime.requestedMode = "live";
    await ui.click("Refresh account");
    assert.ok(exportCard());
    // The server cannot name the program (its configuration failed): no command to give, so no card.
    Object.assign(state.runtime.live, { programId: null, vault: null }); await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
    // Unbound: no card, whatever the wallet.
    respond = async (path) => { if (path === "status") return json({ binding: null, runtime: null }); throw new Error("Unexpected fixture route"); };
    await ui.click("Refresh account");
    assert.equal(!!exportCard(), false);
    assert.equal(exportCount, 0);
  });
});

const UNAVAILABLE = "Owner transaction confirmation is unavailable.";
// A stuck withdrawal never holds back the revocation; a stuck revocation holds back everything.
const STUCK = /Until it does, the server prepares no other withdrawal, resume request or permission; revoking stays available and is prepared beside it, and this may not resolve by itself\./;
const STUCK_REVOKE = /Until it does, the server prepares no other owner transaction, a revocation included, and this may not resolve by itself\./;
const USUAL = /usually within a few minutes/;
test("a pending owner record the server cannot settle says so plainly, never 'a few minutes', and names a recovery path only when the page shows one", async () => {
  // The page reacts to the server's exact words.
  const runtime = readFileSync(fileURLToPath(new URL("../../../worker/src/solana-app-runtime.ts", import.meta.url)), "utf8");
  assert.ok(runtime.includes(`blockers.push("${UNAVAILABLE}")`), "the runtime's blocker for an unreadable owner outcome");
  const text = () => ui.container.textContent!;
  const pendingRecord = (signature: string, kind = "withdraw") => Object.assign(state.runtime.live, { ownerTransaction: { signature, status: "pending", kind } });
  // Default build (no key export): the server could not read the outcome.
  liveVault(); pendingRecord("stuck-sig");
  state.runtime.live.blockers = [UNAVAILABLE, "An owner transaction is awaiting final confirmation."];
  await render();
  assert.match(text(), /Your withdrawal is awaiting final confirmation, and the server cannot read its outcome from Solana right now\./);
  assert.match(text(), STUCK); assert.doesNotMatch(text(), USUAL);
  assert.match(text(), /Check it again later\. If it stays this way, Merrymen has to fix how the server reads Solana: nothing on this page can settle it\./);
  assert.doesNotMatch(text(), /solana-recover|owner key card|recovery tool/);
  assert.equal(button("Revoke all Solana sessions").disabled, false, "a stuck withdrawal never holds back the revocation");
  assert.equal(button("Ask wallet to resume buys").disabled, true);
  assert.equal(button("Check owner transaction").disabled, false);
  // The next read settles nothing but reads fine: the usual wording, as long as the record is young.
  state.runtime.live.blockers = ["An owner transaction is awaiting final confirmation."];
  await press("Check owner transaction");
  assert.match(text(), USUAL); assert.doesNotMatch(text(), STUCK);
  // The page's reads keep reporting the same record pending for five minutes: no more "a few minutes".
  const now = Date.now;
  Date.now = () => now() + 5 * 60_000;
  try { await press("Check owner transaction"); } finally { Date.now = now; }
  assert.match(text(), /Your withdrawal has been awaiting final confirmation for over 5 minutes, well past the minute or so its blockhash lasts: the server has not been able to settle its outcome\./);
  assert.match(text(), STUCK); assert.doesNotMatch(text(), USUAL);
  assert.equal(button("Revoke all Solana sessions").disabled, false);
  // A revocation the server cannot settle holds back everything, another revocation included.
  pendingRecord("stuck-revoke", "revoke"); state.runtime.live.blockers = [UNAVAILABLE];
  await press("Check owner transaction");
  assert.match(text(), /Your revocation is awaiting final confirmation, and the server cannot read its outcome from Solana right now\./);
  assert.match(text(), STUCK_REVOKE); assert.equal(button("Revoke all Solana sessions").disabled, true);
  state.runtime.live.blockers = ["An owner transaction is awaiting final confirmation."];
  // A different pending record starts its own clock.
  pendingRecord("next-sig");
  await press("Check owner transaction");
  assert.match(text(), USUAL); assert.doesNotMatch(text(), STUCK);
  await ui.close(); ui = testDom();
  // With key export on, the page points to the recovery card's step 2: the signing command for a released program, the plan otherwise.
  await withExportFlag("1", async () => {
    for (const [pin, pointer] of [[[{ programId: PROGRAM, sha256: "ab".repeat(32) }], /Step 2 of the owner key card below revokes every session and withdraws your vault with your offline owner key, without this server\./],
      [[], /Step 2 of the owner key card below shows your vault and its session without this server\./]] as const) {
      releases = [...pin];
      // A hash in the status answer never turns the plan into the signing command: only the pin decides.
      liveVault(); pendingRecord("stuck-sig"); state.runtime.live.blockers = [UNAVAILABLE];
      Object.assign(state.runtime.live, { programSha256: "ab".repeat(32) });
      await render();
      assert.match(text(), pointer); assert.ok(exportCard());
      if (!pin.length) assert.doesNotMatch(text(), /SHA-256|--send|--key-file|offline owner key/);
      assert.doesNotMatch(text(), /Merrymen has to fix/);
      await ui.close(); ui = testDom();
    }
  });
});

/** A whole or decimal USDG amount in raw micro-USDG. */
const units = (usdg: string) => String(Math.round(Number(usdg) * 1_000_000));
/** The live mode radio, or undefined when the page offers none. */
const liveSwitch = () => [...ui.container.querySelectorAll("label")].find((item) => item.textContent?.includes("Live · real funds"))?.querySelector("input");
/** The live rollout as status reports it. */
const access = (onList: boolean, misconfigured = false) => ({ onList, misconfigured, caps: misconfigured ? null : { ...SOLANA_LIVE_CAP_DEFAULTS } });

test("off the live list a paper account is told why and offered no live switch; on it the page names the caps and refuses a live limit above one before sending anything", async () => {
  const runtime = state.runtime as typeof state.runtime & { liveAccess?: ReturnType<typeof access> };
  runtime.liveAccess = access(false);
  const saved: Array<Record<string, unknown>> = [];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "settings") { saved.push(body!); return json({ binding: state.binding }); }
    throw new Error("Unexpected fixture route");
  };
  await render();
  assert.equal(!!liveSwitch(), false, "no live switch");
  assert.ok(ui.container.textContent!.includes(SOLANA_LIVE_NOT_OPEN));
  // A list or cap setting the server cannot read: said, and no switch either.
  runtime.liveAccess = access(false, true); await press("Refresh account");
  assert.equal(!!liveSwitch(), false); assert.ok(ui.container.textContent!.includes(SOLANA_LIVE_ROLLOUT_MISCONFIGURED));
  // On the list: the switch, and the caps beside the live limits.
  runtime.liveAccess = access(true); await press("Refresh account");
  assert.ok(!ui.container.textContent!.includes(SOLANA_LIVE_NOT_OPEN));
  await act(async () => { liveSwitch()!.click(); });
  assert.match(ui.container.textContent!, /Live limits on this platform are at most 10 USDG per trade, 25 USDG per 24 hours, 0\.1 SOL sold per trade and 0\.25 SOL sold per 24 hours\./);
  await act(async () => { (ui.container.querySelector("input[type=checkbox]") as HTMLInputElement).click(); });
  // The saved paper limits allow 50 USDG a day: above the 25 USDG live cap.
  for (const daily of ["50", "25.5"]) {
    if (daily !== "50") await type("USDG per 24 hours", daily);
    await ui.click("Save Solana mode and limits");
    const over = { perTradeUsdg: "10000000", dailyUsdg: units(daily), perTradeWsol: "100000000", dailyWsol: "250000000" };
    assert.ok(ui.container.textContent!.includes(solanaLiveCapRefusal(over, SOLANA_LIVE_CAP_DEFAULTS, "save")!), ui.container.textContent!);
  }
  assert.equal(saved.length, 0, "nothing sent");
  await type("USDG per 24 hours", "25");
  await ui.click("Save Solana mode and limits");
  assert.equal((saved[0]!.limits as Record<string, unknown>).dailyUsdg, "25000000");
});

test("with no limits saved, the paper form starts at paper's own defaults and choosing live starts at the live caps in force", async () => {
  (state.binding as { limits: unknown }).limits = null;
  const runtime = state.runtime as typeof state.runtime & { liveAccess?: ReturnType<typeof access> };
  runtime.liveAccess = access(true);
  await render();
  const paperSwitch = () => [...ui.container.querySelectorAll("label")].find((item) => item.textContent?.includes("Paper · simulated funds"))!.querySelector("input")!;
  // Paper limits are never capped: 10 and 50 USDG, as before the live caps.
  assert.deepEqual(["USDG per trade", "USDG per 24 hours"].map(field), ["10", "50"]);
  await act(async () => { liveSwitch()!.click(); });
  assert.deepEqual(["USDG per trade", "USDG per 24 hours", "SOL sold per trade", "SOL sold per 24 hours"].map(field), ["10", "25", "0.1", "0.25"]);
  // Back to paper: its own defaults again.
  await act(async () => { paperSwitch().click(); });
  assert.deepEqual(["USDG per trade", "USDG per 24 hours"].map(field), ["10", "50"]);
  // Other caps in force: live starts at those. A typed limit is kept.
  runtime.liveAccess = { onList: true, misconfigured: false, caps: { perTradeUsdg: "5000000", dailyUsdg: "20000000", perTradeWsol: "50000000", dailyWsol: "200000000" } };
  await press("Refresh account");
  await act(async () => { liveSwitch()!.click(); });
  assert.deepEqual(["USDG per trade", "USDG per 24 hours", "SOL sold per trade", "SOL sold per 24 hours"].map(field), ["5", "20", "0.05", "0.2"]);
  await act(async () => { paperSwitch().click(); });
  await type("USDG per 24 hours", "40");
  await act(async () => { liveSwitch()!.click(); });
  assert.deepEqual(["USDG per trade", "USDG per 24 hours"].map(field), ["10", "40"], "typed limits are never replaced");
  // A server that reports no caps: live starts at the default caps (a fresh page).
  delete runtime.liveAccess;
  await ui.remount(React.createElement(SolanaScreen));
  await act(async () => { liveSwitch()!.click(); });
  assert.deepEqual(["USDG per trade", "USDG per 24 hours", "SOL sold per trade", "SOL sold per 24 hours"].map(field), ["10", "25", "0.1", "0.25"]);
});

test("a saved live mode with no permission yet, off the list, stays shown and says live trading is not open; nothing can be registered", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM; state.binding.limits = liveLimits();
  (state.runtime as typeof state.runtime & { liveAccess?: ReturnType<typeof access> }).liveAccess = access(false);
  await render();
  assert.equal(!!liveSwitch(), true, "the saved mode is shown; the server refuses saving it again");
  assert.ok(ui.container.textContent!.includes(SOLANA_LIVE_NOT_OPEN)); assert.ok(!ui.container.textContent!.includes(SOLANA_LIVE_PAUSED));
  assert.equal(button("Register bounded trading permission").disabled, true);
});

test("an account that went live and is off the list keeps its live switch for exits, says live trading is paused, offers no new permission and still offers a sale", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM; state.binding.limits = liveLimits();
  const runtime = state.runtime as typeof state.runtime & { liveAccess?: ReturnType<typeof access> };
  runtime.liveAccess = access(false);
  Object.assign(state.runtime.live, { session: OWNER, canExit: true, blockers: [SOLANA_LIVE_PAUSED] });
  await render();
  assert.equal(!!liveSwitch(), true, "live mode stays offered: it is how its exits are sold");
  assert.equal(button("Register bounded trading permission").disabled, true);
  assert.ok(ui.container.textContent!.includes(SOLANA_LIVE_PAUSED));
  assert.doesNotMatch(ui.container.textContent!, /Live limits on this platform/, "no caps to fit: it cannot register while off the list");
  assert.equal(button("Preview trade").disabled, true, "no buy");
  const direction = ui.container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => { direction.value = "sell"; direction.dispatchEvent(new ui.dom.window.Event("change", { bubbles: true })); });
  assert.equal(button("Preview trade").disabled, false, "a sale back to USDG");
  // Back on the list with saved limits above the caps: registration waits for limits within them.
  runtime.liveAccess = access(true); Object.assign(state.runtime.live, { session: null, blockers: [] });
  await press("Refresh account");
  assert.equal(button("Register bounded trading permission").disabled, true);
  assert.ok(ui.container.textContent!.includes(solanaLiveSavedAboveCaps(SOLANA_LIVE_CAP_DEFAULTS)));
  assert.equal(signCount, 0); assert.equal(calls.some((call) => call.path === "setup"), false);
});

test("off the list, an account that went live whose permission expired or was replaced is told selling needs a permission, never that exits still work", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM; state.binding.limits = liveLimits();
  const runtime = state.runtime as typeof state.runtime & { liveAccess?: ReturnType<typeof access> };
  runtime.liveAccess = access(false);
  Object.assign(state.runtime.live, { session: OWNER, canExit: false, blockers: ["The on-chain trading permission has expired.", SOLANA_LIVE_PAUSED_NO_PERMISSION] });
  await render();
  assert.ok(ui.container.textContent!.includes(SOLANA_LIVE_PAUSED_NO_PERMISSION));
  assert.ok(!ui.container.textContent!.includes(SOLANA_LIVE_PAUSED), "never \"exits, revoke and withdraw still work\"");
  assert.equal(button("Register bounded trading permission").disabled, true);
  // The same while a rollout setting cannot be read.
  runtime.liveAccess = access(false, true);
  state.runtime.live.blockers = ["Register an owner-approved live trading permission.", SOLANA_LIVE_ROLLOUT_MISCONFIGURED_NO_PERMISSION];
  await press("Refresh account");
  assert.ok(ui.container.textContent!.includes(SOLANA_LIVE_ROLLOUT_MISCONFIGURED_NO_PERMISSION));
  assert.ok(!ui.container.textContent!.includes(SOLANA_LIVE_ROLLOUT_MISCONFIGURED));
});

test("an account that went live and later chose paper keeps its live switch off the list, so it can return to live mode to sell its exits", async () => {
  // Paper is selected, but the account holds a live permission (or a live book): admission sells only in live mode.
  state = initial("paper"); state.runtime.live.programId = PROGRAM;
  const runtime = state.runtime as typeof state.runtime & { liveAccess?: ReturnType<typeof access> };
  runtime.liveAccess = access(false);
  Object.assign(state.runtime.live, { session: OWNER, canExit: false, blockers: [SOLANA_LIVE_PAUSED, "Live mode is not selected."] });
  const saved: Array<Record<string, unknown>> = [];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "settings") { saved.push(body!); return json({ binding: { ...state.binding, requestedMode: "live", limits: body!.limits } }); }
    throw new Error("Unexpected fixture route");
  };
  await render();
  assert.equal(!!liveSwitch(), true, "live mode stays offered: it is how its exits are sold");
  assert.ok(ui.container.textContent!.includes(SOLANA_LIVE_PAUSED));
  assert.doesNotMatch(ui.container.textContent!, /Live limits on this platform/, "no caps: it cannot register while off the list");
  await act(async () => { liveSwitch()!.click(); });
  // Live limits bound sales too: the program charges a sale's proceeds to the same USDG limits.
  assert.match(ui.container.textContent!, /Sales back to USDG count against these USDG limits as buys do, and against the SOL sold limits/);
  await act(async () => { (ui.container.querySelector("input[type=checkbox]") as HTMLInputElement).click(); });
  await press("Save Solana mode and limits");
  assert.equal(saved.length, 1, ui.container.textContent!);
  assert.equal(saved[0]!.mode, "live"); assert.equal(saved[0]!.liveConsent, true);
  // The same paper account that never went live is offered no live switch.
  Object.assign(state.runtime.live, { session: null, blockers: ["Live mode is not selected."] });
  state.binding.requestedMode = "paper";
  await press("Refresh account");
  assert.equal(!!liveSwitch(), false);
});

test("the deposit address is offered only while the account may buy: exits-only off the list, or while the services' settings differ, it is not, and the page says why", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM; state.binding.limits = liveLimits();
  const runtime = state.runtime as typeof state.runtime & { liveAccess?: ReturnType<typeof access> };
  runtime.liveAccess = access(true);
  const vault = await deriveSolanaVaultAddress(PROGRAM, OWNER);
  Object.assign(state.runtime.live, { session: OWNER, ready: true, canExit: true, blockers: [], vault, cashTokenAccount: await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM) });
  const mount = async () => {
    await ui.remount(React.createElement(SolanaScreen));
    // Address derivation is asynchronous (WebCrypto); let it settle.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  };
  const paused = "Buying is paused for this account, so no deposit address is shown";
  await mount();
  assert.match(ui.container.textContent!, /Fund the Solana vault/); assert.ok(!ui.container.textContent!.includes(paused));
  // Taken off the list after going live: exits-only, so no deposit address, and the page says why.
  runtime.liveAccess = access(false); Object.assign(state.runtime.live, { ready: false, canExit: true, blockers: [SOLANA_LIVE_PAUSED] });
  await mount();
  assert.ok(!ui.container.textContent!.includes("Fund the Solana vault")); assert.ok(ui.container.textContent!.includes(paused));
  // On the list while the web and the worker run different settings: buying waits, and so does the deposit address.
  runtime.liveAccess = access(true); Object.assign(state.runtime.live, { blockers: [SOLANA_LIVE_ROLLOUT_DIFFERS] });
  await mount();
  assert.ok(!ui.container.textContent!.includes("Fund the Solana vault")); assert.ok(ui.container.textContent!.includes(paused));
});

test("on the list, while the server says the registered permission allows more than the caps, the page leaves a live save above them to the server, and still asks for limits within them before a new permission", async () => {
  state = initial("live"); state.runtime.live.programId = PROGRAM; state.binding.limits = liveLimits();
  const runtime = state.runtime as typeof state.runtime & { liveAccess?: ReturnType<typeof access> };
  runtime.liveAccess = access(true);
  Object.assign(state.runtime.live, { session: OWNER, canExit: true, blockers: [solanaLiveSessionAboveCaps(SOLANA_LIVE_CAP_DEFAULTS)] });
  const saved: Array<Record<string, unknown>> = [];
  respond = async (path, body) => {
    if (path === "status") return json(state);
    if (path === "settings") { saved.push(body!); return json({ binding: state.binding }); }
    throw new Error("Unexpected fixture route");
  };
  await render();
  await act(async () => { (ui.container.querySelector("input[type=checkbox]") as HTMLInputElement).click(); });
  // The saved limits (50 USDG and 1 SOL a day) are above the 25 USDG and 0.25 SOL caps: the server bounds them by the permission it holds.
  await ui.click("Save Solana mode and limits");
  assert.equal(saved.length, 1, ui.container.textContent!);
  const { expiresAtMs: _sent, ...sent } = saved[0]!.limits as typeof limits, { expiresAtMs: _held, ...held } = state.binding.limits!;
  assert.deepEqual(sent, held);
  assert.equal(button("Register bounded trading permission").disabled, true, "a new permission still needs limits within the caps");
  assert.ok(ui.container.textContent!.includes(solanaLiveSavedAboveCaps(SOLANA_LIVE_CAP_DEFAULTS)));
  // Without that blocker (a permission within the caps), the page refuses the same save itself, before anything is sent.
  Object.assign(state.runtime.live, { blockers: [] });
  await press("Refresh account");
  const consent = ui.container.querySelector("input[type=checkbox]") as HTMLInputElement;
  if (!consent.checked) await act(async () => { consent.click(); });
  await ui.click("Save Solana mode and limits");
  assert.equal(saved.length, 1, "nothing sent");
  assert.ok(ui.container.textContent!.includes(solanaLiveCapRefusal(state.binding.limits!, SOLANA_LIVE_CAP_DEFAULTS, "save")!), ui.container.textContent!);
});
