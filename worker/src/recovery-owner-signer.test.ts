/**
 * RECOVERY TAKES A SIGNER NOW, NOT A KEY — and the difference is who can escape.
 *
 * `planRecovery` and `recoverFunds` required a raw `ownerPrivateKey`. A hosted
 * agent owned by a PRIVY EMBEDDED WALLET has no such key and never will: the
 * key is never exported, which is the point of it. So those accounts were
 * structurally unrecoverable by the one path that exists to get money out.
 *
 * MEASURED 2026-09-12 on a live funded account: smart account 0x05a198A6…,
 * owner 0x8e93bad5… (a Privy embedded wallet), holding 1,063,408.141815 DOGGOS
 * in class vault 0x3fcdde6e… plus 20.000000 USDG. The CLI could not reach it
 * (no key on disk) and the hosted panel rendered an empty "owner key (0x…)"
 * field asking for something that does not exist.
 *
 * THE OWNER ADDRESS IS THE ONLY FREE VARIABLE in the Kernel CREATE2 preimage —
 * everything else (kernelVersion 0.3.3, EntryPoint 0.7, the ECDSA validator,
 * index 0n) is constant across every construction in this repo. That is why a
 * signer and a private key for the SAME address must derive the SAME account,
 * and it is why supplying the wrong signer is so dangerous: it derives a
 * different, EMPTY account, and a sweep of that reports success having moved
 * nothing.
 *
 * NOT AN EIP-1193 PROVIDER. ZeroDev's `toSigner` resolves a provider's address
 * with `Promise.any([eth_requestAccounts, eth_accounts])` and takes [0] —
 * whichever RPC answers first. On a derivation path that race decides which
 * account you get. `web/src/lib/session.ts:199` and `usePrivyOwner` already
 * refuse providers for exactly this reason; recovery now matches them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";

import {
  ownerAddressOf,
  ownerFromAddress,
  ownerFromPrivateKey,
  ownerFromSigner,
  recoverFunds,
} from "./recover";
import { robinhoodChain } from "../../packages/core/src/index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECOVER = readFileSync(path.join(__dirname, "recover.ts"), "utf8");
/** Comments stripped — this file explains the defect by quoting it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
const RECOVER_CODE = code(RECOVER);

/** A throwaway key. Never used against a real account. */
const KEY = ("0x" + "11".repeat(32)) as `0x${string}`;
const KEY_ACCOUNT = privateKeyToAccount(KEY);

/** The real subject's owner, used only as an address. */
const SHOGUN_OWNER = "0x8e93bad5a60a266b4283855ceffa0979720aed72" as const;

describe("the three owner kinds", () => {
  it("a raw key and a signer for the SAME address are the same owner, as far as derivation sees", () => {
    // The whole safety of the refactor rests on this: derivation reads the
    // owner's ADDRESS and nothing else, so a Privy LocalAccount and a private
    // key for that address must be indistinguishable to it.
    const byKey = ownerFromPrivateKey(KEY);
    const bySigner = ownerFromSigner(KEY_ACCOUNT as unknown as LocalAccount);
    assert.equal(ownerAddressOf(byKey), KEY_ACCOUNT.address);
    assert.equal(ownerAddressOf(bySigner), KEY_ACCOUNT.address);
    assert.equal(ownerAddressOf(byKey), ownerAddressOf(bySigner));
  });

  it("an address-only owner reports its address without holding anything that can sign", () => {
    assert.equal(ownerAddressOf(ownerFromAddress(SHOGUN_OWNER)), SHOGUN_OWNER);
  });
});

describe("an address-only owner can reconstruct but never authorise", () => {
  it("recoverFunds REFUSES it, before any network call", async () => {
    // Pointed at a chain whose RPC would fail if it were ever reached — so the
    // refusal below proves it returned before touching anything, not that the
    // network happened to be down.
    await assert.rejects(
      () =>
        recoverFunds({
          chain: { ...robinhoodChain, rpcUrls: { default: { http: ["http://127.0.0.1:1"] } } } as never,
          owner: ownerFromAddress(SHOGUN_OWNER),
          bundlerUrl: "http://127.0.0.1:1",
          rpcUrl: "http://127.0.0.1:1",
          to: SHOGUN_OWNER,
        }),
      /address-only/,
      "an owner that cannot sign must be refused by name, not by a network error",
    );
  });

  it("the refusal is a property of the CODE, checked before the plan is even built", () => {
    // Ordering matters: reaching this after reading balances and pricing gas
    // would mean having done all that work against money it may not move.
    const fn = RECOVER_CODE.slice(RECOVER_CODE.indexOf("export async function recoverFunds"));
    const refuseAt = fn.indexOf('owner.kind === "address"');
    const planAt = fn.indexOf("await planRecovery");
    assert.ok(refuseAt >= 0, "recoverFunds must refuse an address-only owner");
    assert.ok(planAt >= 0);
    assert.ok(refuseAt < planAt, "and must do so BEFORE planning");
  });
});

describe("the construction cannot drift between planning and signing", () => {
  it("there is exactly ONE place the Kernel account is reconstructed", () => {
    // Two independent constructions with the same three arguments is precisely
    // the duplication that drifts: the plan would show one account's contents
    // and the sweep would sign for another.
    assert.equal(
      (RECOVER_CODE.match(/createKernelAccount\(/g) ?? []).length,
      1,
      "createKernelAccount must appear once, inside deriveKernelAccount",
    );
    assert.equal(
      (RECOVER_CODE.match(/signerToEcdsaValidator\(/g) ?? []).length,
      1,
      "and so must the validator",
    );
    assert.equal((RECOVER_CODE.match(/deriveKernelAccount\(/g) ?? []).length, 3, "one definition, two callers");
  });

  it("no index, salt or address override is passed — the SDK defaults are the contract", () => {
    // index 0n and useMetaFactory true are what web/src/lib/session.ts mints
    // with. Passing anything here would derive an account no owner has.
    const fn = RECOVER_CODE.slice(RECOVER_CODE.indexOf("async function deriveKernelAccount"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.doesNotMatch(body, /\bindex\s*:/, "no index override");
    assert.doesNotMatch(body, /\baddress\s*:/, "no address override — that would bypass derivation");
    assert.doesNotMatch(body, /factoryAddress|metaFactoryAddress|useMetaFactory/, "no factory overrides");
    assert.match(body, /KERNEL_V3_3/, "the same Kernel version");
    assert.match(body, /getEntryPoint\("0\.7"\)/, "the same EntryPoint");
  });

  it("BOTH the plan and the signature check the account against the expected one", () => {
    // planRecovery checked it; recoverFunds re-derives, so it must check again.
    // Otherwise the account that was shown and the account signed for are only
    // assumed to be the same.
    assert.equal(
      (RECOVER_CODE.match(/expectedSmartAccount &&/g) ?? []).length,
      2,
      "the expected-account guard must fire on both paths",
    );
  });

  it("the derivation refuses a zero address on both paths", () => {
    assert.equal(
      (RECOVER_CODE.match(/assertDerivedAccount\(/g) ?? []).length,
      2,
      "a sweep aimed at the zero address would be a signed transaction to nothing",
    );
  });
});

describe("what the refactor must not have loosened", () => {
  it("recovery is still SELF-PAYING — no paymaster anywhere in the engine", () => {
    // The relay refuses any op carrying paymaster fields, so a paymaster here
    // would not be sponsored, it would simply be rejected. More importantly,
    // house-sponsored withdrawals are a thing this system deliberately cannot do.
    assert.doesNotMatch(RECOVER_CODE, /paymaster/i, "the recovery engine must not attach a paymaster");
  });

  it("the two-operation shape survives: sweep the vault, re-read, then transfer", () => {
    const fn = RECOVER_CODE.slice(RECOVER_CODE.indexOf("export async function recoverFunds"));
    const sweepAt = fn.indexOf('functionName: "sweep"');
    const rereadAt = fn.indexOf('functionName: "balanceOf"');
    const transferAt = fn.indexOf('functionName: "transfer"');
    assert.ok(sweepAt >= 0, "UserOp #1 empties the class vault");
    assert.ok(rereadAt > sweepAt, "then the ACTUAL landed balance is re-read");
    assert.ok(transferAt > rereadAt, "and only then is UserOp #2 built from it");
  });

  it("the class holdings still reach the caller, so the disclosure can show them", () => {
    assert.match(RECOVER_CODE, /classHoldings/, "the plan must carry the vault's contents");
    assert.match(
      RECOVER_CODE,
      /plan\.balances\.length === 0 && nativeSweptWei === 0n && plan\.classHoldings\.length === 0/,
      "and an account with a funded vault must never be called empty",
    );
  });

  it("the EIP-1193 hazard is written down where the next person will look", () => {
    // If this explanation is deleted, someone will "simplify" the signer to
    // accept a provider and reintroduce the address race.
    assert.match(RECOVER, /NOT AN EIP-1193 PROVIDER/, "the refusal must stay documented");
    assert.match(RECOVER, /Promise\.any/, "including why: the address race");
  });
});
