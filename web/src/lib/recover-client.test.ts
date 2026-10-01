/**
 * A GRANT'S OWN TOKENS MUST REACH THE SIGNED-OUT SWEEP.
 *
 * Signed out, the browser and the phone know an owner's tokens only as the
 * grant's `grantTokens`: addresses, no names. They passed each one on as
 * `{ symbol: "", decimals: 18 }`, the engine's validator refused the empty
 * symbol, and every owner-added token was dropped from the sweep without a word
 * — left in the account by the one path that exists to get money out, while the
 * CLI and the hosted route (which have real symbols) swept the same account
 * whole.
 *
 * So this drives the real `planFromBrowser` and `sweepFromBrowser`, unmodified,
 * against a stubbed chain: the mapping in recover-client.ts, the engine's
 * `sweepList` and its decimals read are all the production code. Only `fetch`
 * is replaced — the browser path takes no RPC URL, so the chain default is what
 * it calls, and a stubbed fetch is the one seam that reaches it.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { encodeErrorResult, encodeFunctionResult, formatUnits, parseAbi, toFunctionSelector } from "viem";
import { formatUserOperation, getUserOperationHash, type RpcUserOperation } from "viem/account-abstraction";
import { preflightRevocationFromBrowser, revokeFromBrowser } from "./revoke-client";
import { ownerGasError, planFromBrowser, sweepFromBrowser, type BrowserWallet } from "./recover-client";

/** A throwaway owner key. The derived account comes from the stub below. */
const OWNER_KEY = ("0x" + "31".repeat(32)) as `0x${string}`;
const ACCOUNT = "0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487" as const;
const DESTINATION = "0x8e93bad5a60a266b4283855ceffa0979720aed72" as const;

/** A 9-decimal memecoin the owner added — the case an 18dp guess misstates by 10^9. */
const MEME = "0x15e498ff2dbca95e8648a1f025cbbd12c2525461" as const;
const MEME_HELD = 1_063_408_141_815_000n;
/** An owner token that holds a balance but will not say its decimals. */
const MUTE = "0x9d4454b023096f34b160d6b654540c56a1f81688" as const;
const MUTE_HELD = 42n;

const SENDER_ADDRESS_RESULT = parseAbi(["error SenderAddressResult(address sender)"]);
const UINT256 = parseAbi(["function f() view returns (uint256)"]);
const UINT8 = parseAbi(["function f() view returns (uint8)"]);
const SEL = { getSenderAddress: "0x9b249f69", balanceOf: "0x70a08231", decimals: "0x313ce567", getNonce: "0x35567e1a" };
const hex = (n: bigint) => `0x${n.toString(16)}`;

const submitted: RpcUserOperation<"0.7">[] = [];
const sentHashes = new Set<string>();
const receiptReads: string[] = [];
const storage = new Map<string, string>();
let activeChain = 4663;
const PAYMASTER = "0x0000000000000000000000000000000000001234";
let gasSponsored = true;
let sponsorRefuses = false;
let quoteCount = 0;
let nativeBalance = 0n;
const balanceReads = new Set<string>();

/** One JSON-RPC answer, for the chain and the bundler relay alike. */
function answer(method: string, params: unknown[]): { result?: unknown; error?: unknown } {
  if (method === "eth_sendUserOperation") {
    submitted.push(params[0] as typeof submitted[number]);
    const hash = getUserOperationHash({ userOperation: formatUserOperation(params[0] as RpcUserOperation<"0.7">), chainId: activeChain,
      entryPointAddress: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", entryPointVersion: "0.7" });
    sentHashes.add(hash);
    return { result: hash };
  }
  if (method === "pm_getPaymasterStubData" || method === "pm_getPaymasterData") {
    if (sponsorRefuses || !gasSponsored) return { error: { code: -32000, message: "paymaster sponsorship refused by policy" } };
    const data = method === "pm_getPaymasterData" ? `0x${(++quoteCount).toString(16).padStart(2, "0")}` : "0x";
    return { result: { paymaster: PAYMASTER, paymasterData: data === "0x1" ? "0x01" : data,
      paymasterVerificationGasLimit: hex(100_000n), paymasterPostOpGasLimit: hex(50_000n) } };
  }
  if (method === "eth_estimateUserOperationGas") {
    return { result: { preVerificationGas: hex(60_000n), verificationGasLimit: hex(300_000n), callGasLimit: hex(400_000n) } };
  }
  if (method === "eth_getUserOperationReceipt") {
    receiptReads.push(String(params[0]));
    if (!sentHashes.has(String(params[0]))) return { result: null };
    return {
      result: {
        userOpHash: params[0], sender: ACCOUNT, nonce: "0x0", actualGasCost: "0x1", actualGasUsed: "0x1",
        success: true, logs: [],
        receipt: {
          transactionHash: `0x${"cd".repeat(32)}`, blockHash: `0x${"ef".repeat(32)}`, blockNumber: "0x1",
          transactionIndex: "0x0", from: ACCOUNT, to: ACCOUNT, cumulativeGasUsed: "0x1", gasUsed: "0x1",
          effectiveGasPrice: "0x1", status: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`,
          contractAddress: null, type: "0x2",
        },
      },
    };
  }
  if (method === "eth_supportedEntryPoints") return { result: ["0x0000000071727De22E5E9d8BAf0edAc6f37da032"] };
  if (method === "pimlico_getUserOperationGasPrice") {
    const tier = { maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1" };
    return { result: { slow: tier, standard: tier, fast: tier } };
  }
  if (method === "eth_chainId") return { result: hex(BigInt(activeChain)) };
  if (method === "eth_getCode") return { result: "0x" };
  if (method === "eth_getBalance") return { result: hex(nativeBalance) };
  if (method === "eth_gasPrice") return { result: hex(1_000_000_000n) };
  if (method === "eth_maxPriorityFeePerGas") return { result: "0x1" };
  if (method === "eth_getLogs") return { result: [] };
  if (method === "eth_blockNumber") return { result: "0x1" };
  if (method === "eth_estimateGas") return { result: hex(500_000n) };
  if (method === "eth_getTransactionCount") return { result: "0x0" };
  if (method === "eth_getBlockByNumber") {
    return { result: { number: "0x1", baseFeePerGas: "0x1", timestamp: "0x1", hash: `0x${"ef".repeat(32)}` } };
  }
  if (method === "eth_call") {
    const call = params[0] as { to?: string; data?: string };
    const to = String(call.to ?? "").toLowerCase();
    const data = String(call.data ?? "").toLowerCase();
    if (data.startsWith(SEL.getSenderAddress)) {
      return {
        error: {
          code: 3,
          message: "execution reverted",
          data: encodeErrorResult({ abi: SENDER_ADDRESS_RESULT, errorName: "SenderAddressResult", args: [ACCOUNT] }),
        },
      };
    }
    if (data.startsWith(SEL.balanceOf)) {
      // Held by the ACCOUNT only — a class vault asking the same token must
      // see nothing, or the sweep would grow a vault leg this test is not about.
      const holder = data.slice(-40);
      const mine = holder === ACCOUNT.slice(2).toLowerCase();
      if (mine) balanceReads.add(to);
      const held = !mine ? 0n : to === MEME ? MEME_HELD : to === MUTE ? MUTE_HELD : 0n;
      return { result: encodeFunctionResult({ abi: UINT256, result: held }) };
    }
    if (data.startsWith(SEL.decimals)) {
      if (to === MEME) return { result: encodeFunctionResult({ abi: UINT8, result: 9 }) };
      return { error: { code: 3, message: "execution reverted" } };
    }
    if (data.startsWith(toFunctionSelector("validNonceFrom()"))) return { result: encodeFunctionResult({ abi: UINT256, result: 2n }) };
    if (data.startsWith(SEL.getNonce)) return { result: encodeFunctionResult({ abi: UINT256, result: 0n }) };
    // Every other call is a transfer simulation: it succeeds, returning nothing.
    return { result: "0x" };
  }
  return { error: { code: -32601, message: `unstubbed ${method}` } };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
const g = globalThis as { window?: unknown };
before(() => {
  // The page's origin, which `relayUrl` builds the bundler relay from. Without
  // one it is a relative URL, which only a browser can resolve.
  g.window = { location: { origin: "https://app.merrymen.test" } };
  globalThis.localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } } as Storage;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/bundler/46630") || url.includes("rpc.testnet.chain")) activeChain = 46630;
    else if (url.includes("/api/bundler/4663") || url.includes("rpc.mainnet.chain")) activeChain = 4663;
    // The relay ticket: a challenge to sign, then the account the server derived.
    if (url.includes("/api/recover/ticket")) {
      return init?.method === "POST" ? json({ smartAccount: ACCOUNT }) : json({ nonce: "n", message: "recover" });
    }
    if (url.includes("/api/bundler/") && !init?.body) return json({ gasSponsored, sponsorshipEnabled: gasSponsored, reason: gasSponsored ? null : "Merrymen gas coverage is unavailable." });
    const parsed = JSON.parse(String(init?.body ?? (input as Request).body)) as unknown;
    const batch = (Array.isArray(parsed) ? parsed : [parsed]) as { id: number; method: string; params: unknown[] }[];
    const out = batch.map(({ id, method, params }) => ({ jsonrpc: "2.0", id, ...answer(method, params ?? []) }));
    return json(Array.isArray(parsed) ? out : out[0]);
  }) as typeof fetch;
});
beforeEach(() => { gasSponsored = true; sponsorRefuses = false; submitted.length = 0; quoteCount = 0; nativeBalance = 0n; storage.clear(); sentHashes.clear(); receiptReads.length = 0; activeChain = 4663; });
after(() => {
  globalThis.fetch = realFetch;
  delete g.window;
});

/** A signed-out browser wallet, exactly as RecoverPanel builds it from the stored grant. */
const wallet: BrowserWallet = { smartAccount: ACCOUNT, ownerKey: OWNER_KEY, chainId: 4663, grantTokens: [MEME, MUTE] };

describe("grantTokens reach the browser recovery", () => {
  it("planFromBrowser reads and discloses a grantTokens memecoin", async () => {
    const plan = await planFromBrowser(wallet);
    assert.ok(balanceReads.has(MEME), "the memecoin must be in the sweep list — it was never even read before");

    const meme = plan.balances.find((b) => b.address.toLowerCase() === MEME);
    assert.ok(meme, "the owner-added memecoin must appear in the plan the owner confirms");
    assert.equal(meme.symbol, "0x15e4…5461", "labelled by its address, since the grant carries no name");
    assert.equal(meme.decimals, 9, "at the decimals the token states, not a guessed 18");
    assert.equal(meme.amount, formatUnits(MEME_HELD, 9));
  });

  it("a token that will not state its decimals is disclosed by raw count, never formatted at a guess", async () => {
    const plan = await planFromBrowser(wallet);
    const mute = plan.balances.find((b) => b.address.toLowerCase() === MUTE);
    assert.ok(mute, "held is held: an unreadable decimals figure must not hide the balance");
    assert.equal(mute.amount, `${MUTE_HELD} raw units`, "the exact count, since no unit could be established");
    assert.equal(mute.raw, MUTE_HELD);
    // NOT in `unreadable`: that list means a balance could not be read, and the
    // phone disables "Review withdrawal" while it is non-empty
    // (WithdrawScreen.swift). A missing display unit must not veto a
    // withdrawal that would move this token and everything else.
    assert.ok(
      !plan.unreadable.some((u) => u.includes(mute.symbol)),
      `a read balance is not an unreadable one: ${JSON.stringify(plan.unreadable)}`,
    );
  });

  it("sweepFromBrowser moves it", async () => {
    submitted.length = 0;
    const result = await sweepFromBrowser(wallet, DESTINATION);
    assert.equal(submitted.length, 1, "exactly one operation must reach the relay");
    const callData = String(submitted[0]!.callData ?? "").toLowerCase();
    assert.ok(callData.includes(MEME.slice(2)), "the memecoin transfer must be in the signed operation");
    assert.ok(callData.includes(MUTE.slice(2)), "and so must the token whose decimals were unreadable");
    assert.deepEqual(
      result.balances.map((b) => b.address.toLowerCase()).sort(),
      [MEME, MUTE].sort(),
      "and the result must report both as moved",
    );
    assert.ok(result.txHash);
    assert.equal(submitted[0]!.paymaster?.toLowerCase(), PAYMASTER);
    assert.notEqual(submitted[0]!.paymasterData, "0x", "a real final quote must be signed for the zero-ETH account");
  });
});


describe("owner gas coverage", () => {
  it("plans a zero-ETH account as covered and reserves no fee ETH", async () => {
    const plan = await planFromBrowser(wallet);
    assert.equal(plan.gasSponsored, true);
    assert.equal(plan.needsGas, false);
    assert.equal(plan.nativeReserveWei, 0n);
  });
  it("plans the whole native balance when coverage is enabled", async () => {
    nativeBalance = 1_000_000_000_000_000n;
    const plan = await planFromBrowser(wallet);
    assert.equal(plan.nativeRecoverableWei, nativeBalance);
    assert.equal(plan.nativeReserveWei, 0n);
  });
  it("still shows balances but refuses a withdrawal when house coverage is unavailable", async () => {
    gasSponsored = false;
    const plan = await planFromBrowser(wallet);
    assert.equal(plan.gasSponsored, false);
    assert.ok(plan.balances.some(b => b.address.toLowerCase() === MEME));
    await assert.rejects(sweepFromBrowser(wallet, DESTINATION), /gas coverage is unavailable/);
    assert.equal(submitted.length, 0);
  });
  it("does not self-pay even with ETH when the paymaster refuses", async () => {
    nativeBalance = 10n ** 18n;
    sponsorRefuses = true;
    await assert.rejects(sweepFromBrowser(wallet, DESTINATION), /Merrymen could not obtain gas coverage/);
    assert.equal(submitted.length, 0);
  });
  it("maps the screenshot's AA21 error to a clear service failure", () => {
    const text = ownerGasError(new Error("AA21 insufficient prefund Request Arguments: callData: 0xabcdef factoryData: 0x1234"));
    assert.match(text, /Merrymen could not obtain gas coverage/);
    assert.doesNotMatch(text, /callData|factoryData/);
  });
});


describe("sponsored permission revocations", () => {
  it("preflights both networks without broadcasting or signing an operation", async () => {
    const { privateKeyToAccount } = await import("viem/accounts");
    const signer = privateKeyToAccount(OWNER_KEY);
    const signedMessages: unknown[] = [];
    const ownerAccount = { ...signer, signMessage: async (p: Parameters<typeof signer.signMessage>[0]) => {
      signedMessages.push(p.message); return signer.signMessage(p);
    } };
    for (const chainId of [46630, 4663]) await preflightRevocationFromBrowser({ ...wallet, chainId, ownerAccount });
    assert.equal(submitted.length, 0);
    assert.equal(storage.size, 0);
    assert.deepEqual(signedMessages, ["recover", "recover"], "only the fee eligibility proof is signed before approval");
    assert.equal(quoteCount, 2, "both networks must obtain an actual final quote");
  });
  it("revokes a zero-ETH account on each network with owner-signed sponsorship", async () => {
    for (const chainId of [46630, 4663]) {
      const result = await revokeFromBrowser({ ...wallet, chainId }, () => {});
      assert.equal(result.validNonceFrom, 2);
    }
    assert.equal(submitted.length, 2);
    for (const op of submitted) {
      assert.equal(op.paymaster?.toLowerCase(), PAYMASTER);
      assert.notEqual(op.paymasterData, "0x");
      assert.match(op.signature, /^0x[0-9a-f]{130}$/i);
    }
    assert.equal(storage.size, 0, "confirmed revocations clear the saved operation");
  });
  it("refuses before saving or broadcasting when Pimlico declines coverage", async () => {
    sponsorRefuses = true;
    await assert.rejects(preflightRevocationFromBrowser(wallet), /No revocation was submitted/);
    await assert.rejects(revokeFromBrowser(wallet, () => {}), /Merrymen could not obtain gas coverage/);
    assert.equal(submitted.length, 0);
    assert.equal(storage.size, 0);
  });
  it("refreshes sponsorship for a saved fee replacement while preserving the nonce and revocation", async () => {
    await revokeFromBrowser(wallet, () => {});
    const original = submitted[0]!;
    const oldHash = [...sentHashes][0]!;
    const journalKey = `merrymen.permission-revocation.v1.${wallet.chainId}.${wallet.smartAccount.toLowerCase()}`;
    storage.set(journalKey, JSON.stringify({ hash: oldHash, nonce: 2, operation: original }));
    sentHashes.clear(); submitted.length = 0; receiptReads.length = 0;
    const before = quoteCount;
    await revokeFromBrowser(wallet, () => {});
    assert.equal(quoteCount, before + 1, "fee changes require fresh final sponsorship");
    assert.equal(receiptReads[0], oldHash, "check the old receipt before preparing a replacement");
    const replacement = submitted[0]!;
    assert.equal(replacement.nonce, original.nonce);
    assert.equal(replacement.callData, original.callData);
    assert.notEqual(replacement.paymasterData, original.paymasterData);
    assert.ok(BigInt(replacement.maxFeePerGas) > BigInt(original.maxFeePerGas));
    assert.equal(storage.size, 0);
  });
  it("uses an already-confirmed saved receipt without buying a replacement quote", async () => {
    await revokeFromBrowser(wallet, () => {});
    const original = submitted[0]!;
    const oldHash = [...sentHashes][0]!;
    storage.set(`merrymen.permission-revocation.v1.${wallet.chainId}.${wallet.smartAccount.toLowerCase()}`,
      JSON.stringify({ hash: oldHash, nonce: 2, operation: original }));
    submitted.length = 0;
    gasSponsored = false;
    const before = quoteCount;
    await preflightRevocationFromBrowser(wallet);
    assert.equal(quoteCount, before, "a confirmed saved revocation needs no new coverage during preflight either");
    const result = await revokeFromBrowser(wallet, () => {});
    assert.equal(result.userOpHash, oldHash);
    assert.equal(quoteCount, before);
    assert.equal(submitted.length, 0);
  });
});
