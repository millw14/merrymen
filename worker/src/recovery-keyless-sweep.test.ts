import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import {
  encodeErrorResult,
  encodeFunctionResult,
  parseAbi,
  type Address,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { robinhoodChain } from "../../packages/core/src/index";
import { ownerFromPrivateKey, ownerFromSigner, planRecovery, recoverFunds } from "./recover";

/**
 * CAN A WALLET WITH NO KEY ACTUALLY GET THE MONEY OUT?
 *
 * `recovery-owner-signer.test.ts` proves a signer and a raw key DERIVE the same
 * account, but the "signer" it uses is `privateKeyToAccount` — a LocalAccount
 * with a key behind it. That is not the shape under test. A Privy embedded
 * wallet is a CUSTOM account built by `toAccount`: no `publicKey`, no key
 * material of any kind, and it signs by asking an iframe. Everything that could
 * go wrong for it goes wrong at SIGNING time, not derivation time — a missing
 * method, a field the SDK reaches for, a raw-transaction fallback — and
 * derivation-equivalence cannot see any of it.
 *
 * SO THE SWEEP HALF GOES THROUGH `recoverFunds` ITSELF, not through a Kernel
 * account this file builds. An earlier version of this test assembled the
 * account directly and signed with it; mutating `ownerAccountOf` to drop the
 * signer on the floor left it PASSING, because the seam it was supposed to
 * cover was the one part it never touched. The engine has to be the thing under
 * test — the defect was always in the plumbing, never in the cryptography.
 *
 * Measured against the account this was found on: owner 0x8e93bad5… controls
 * 0x05a198A6…, holding 1,063,408.141815 DOGGOS. Nothing here touches it — the
 * chain and bundler below are stubs and the only key is a throwaway.
 */

/** The key that stands in for Privy's iframe. It NEVER leaves this closure. */
const HIDDEN = ("0x" + "27".repeat(32)) as `0x${string}`;
const hidden = privateKeyToAccount(HIDDEN);

interface Calls {
  signMessage: number;
  signTypedData: number;
  signTransaction: number;
}

const noCalls = (): Calls => ({ signMessage: 0, signTypedData: 0, signTransaction: 0 });

/**
 * A Privy embedded wallet, as viem sees it.
 *
 * `toAccount` with an address and three signing functions is what
 * `toViemAccount({ wallet })` hands back: `source: "custom"`, and no key. The
 * delegation to `hidden` models the iframe holding the key — the account object
 * itself carries nothing, which is the property under test.
 *
 * `signTransaction` THROWS on purpose. An embedded wallet on a 4337 path never
 * signs a raw transaction, so if the Kernel signing path ever reached for one
 * this test must fail here rather than let it be found on a funded account.
 */
function privyShapedAccount(calls: Calls): LocalAccount {
  return toAccount({
    address: hidden.address,
    async signMessage({ message }) {
      calls.signMessage += 1;
      return hidden.signMessage({ message });
    },
    async signTypedData(typedData) {
      calls.signTypedData += 1;
      return hidden.signTypedData(typedData as never);
    },
    async signTransaction() {
      calls.signTransaction += 1;
      throw new Error("an embedded wallet does not sign raw transactions");
    },
  }) as LocalAccount;
}

const SENDER_ADDRESS_RESULT = parseAbi(["error SenderAddressResult(address sender)"]);
const UINT256 = parseAbi(["function f() view returns (uint256)"]);
const SEL = {
  getSenderAddress: "0x9b249f69",
  balanceOf: "0x70a08231",
  getNonce: "0x35567e1a",
} as const;

/** The token the real subject holds. Here it is only an address to read. */
const DOGGOS = "0x15e498ff2dbca95e8648a1f025cbbd12c2525461" as const;
const HELD = 1_063_408_141_815n;

/** Where the stub says the factory deploys. */
const DEPLOYS_TO = "0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487" as const;
const DESTINATION = "0x8e93bad5a60a266b4283855ceffa0979720aed72" as const;

const hex = (n: bigint) => `0x${n.toString(16)}`;

/** Every UserOperation that reached the bundler, exactly as it was sent. */
const submitted: Record<string, unknown>[] = [];

/** The one op that went out, or a failure saying none did. */
function sentOp(): Record<string, unknown> {
  const op = submitted[0];
  assert.ok(op, "no operation reached the bundler at all");
  return op;
}

/**
 * A chain and a bundler that answer what a recovery actually asks them.
 *
 * Served over REAL HTTP rather than through a `custom()` transport, because
 * `deriveKernelAccount` builds its own client with `http(rpcUrl)` and is not
 * exported — so a transport stub could only test a replica of the derivation,
 * and a replica is the exact thing that drifts from the code it stands for.
 *
 * `getSenderAddress` works by CALLING the EntryPoint and reading the address
 * out of the revert, so reverting with `SenderAddressResult(x)` IS a chain
 * whose factory deploys to x.
 */
function stubNode() {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as unknown;
      const batch = (Array.isArray(parsed) ? parsed : [parsed]) as {
        id: number;
        method: string;
        params: unknown[];
      }[];
      const out = batch.map(({ id, method, params }) => {
        seen.push(method);
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });

        // ── the bundler ────────────────────────────────────────────────────
        if (method === "eth_sendUserOperation") {
          submitted.push(params[0] as Record<string, unknown>);
          return ok(`0x${"ab".repeat(32)}`);
        }
        if (method === "eth_estimateUserOperationGas") {
          return ok({
            preVerificationGas: hex(60_000n),
            verificationGasLimit: hex(300_000n),
            callGasLimit: hex(400_000n),
          });
        }
        if (method === "eth_getUserOperationReceipt") {
          return ok({
            userOpHash: `0x${"ab".repeat(32)}`,
            sender: DEPLOYS_TO,
            nonce: "0x0",
            actualGasCost: hex(1n),
            actualGasUsed: hex(1n),
            success: true,
            logs: [],
            receipt: {
              transactionHash: `0x${"cd".repeat(32)}`,
              blockHash: `0x${"ef".repeat(32)}`,
              blockNumber: "0x1",
              transactionIndex: "0x0",
              from: DEPLOYS_TO,
              to: DEPLOYS_TO,
              cumulativeGasUsed: hex(1n),
              gasUsed: hex(1n),
              effectiveGasPrice: hex(1n),
              status: "0x1",
              logs: [],
              logsBloom: `0x${"00".repeat(256)}`,
              contractAddress: null,
              type: "0x2",
            },
          });
        }
        if (method === "eth_supportedEntryPoints") {
          return ok(["0x0000000071727De22E5E9d8BAf0edAc6f37da032"]);
        }
        if (method === "pimlico_getUserOperationGasPrice") {
          return ok({
            slow: { maxFeePerGas: hex(1n), maxPriorityFeePerGas: hex(1n) },
            standard: { maxFeePerGas: hex(2n), maxPriorityFeePerGas: hex(1n) },
            fast: { maxFeePerGas: hex(3n), maxPriorityFeePerGas: hex(1n) },
          });
        }

        // ── the chain ──────────────────────────────────────────────────────
        if (method === "eth_chainId") return ok(hex(BigInt(robinhoodChain.id)));
        if (method === "eth_getCode") return ok("0x");
        if (method === "eth_getBalance") return ok("0x0");
        if (method === "eth_gasPrice") return ok(hex(1_000_000_000n));
        if (method === "eth_maxPriorityFeePerGas") return ok(hex(1n));
        if (method === "eth_getLogs") return ok([]);
        if (method === "eth_blockNumber") return ok("0x1");
        if (method === "eth_estimateGas") return ok(hex(500_000n));
        if (method === "eth_getTransactionCount") return ok("0x0");
        if (method === "eth_getBlockByNumber") {
          return ok({ number: "0x1", baseFeePerGas: hex(1n), timestamp: "0x1", hash: `0x${"ef".repeat(32)}` });
        }
        if (method === "eth_call") {
          const call = params[0] as { to?: string; data?: string };
          const data = String(call.data ?? "");
          if (data.startsWith(SEL.getSenderAddress)) {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: 3,
                message: "execution reverted",
                data: encodeErrorResult({
                  abi: SENDER_ADDRESS_RESULT,
                  errorName: "SenderAddressResult",
                  args: [DEPLOYS_TO],
                }),
              },
            };
          }
          if (data.startsWith(SEL.balanceOf)) {
            const held = String(call.to ?? "").toLowerCase() === DOGGOS ? HELD : 0n;
            return ok(encodeFunctionResult({ abi: UINT256, result: held }));
          }
          // The account has never sent an operation, so its 4337 nonce is zero.
          if (data.startsWith(SEL.getNonce)) {
            return ok(encodeFunctionResult({ abi: UINT256, result: 0n }));
          }
          // Every other call is a transfer simulation: it succeeds, returning
          // nothing, which is the USDT shape `recoverFunds` deliberately allows.
          return ok("0x");
        }
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `unstubbed ${method}` } };
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
    });
  });
  return { server, seen };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const { server, seen } = stubNode();
const url = await listen(server);
after(() => server.close());

const extraTokens = [{ address: DOGGOS as Address, symbol: "DOGGOS", decimals: 6 }];

describe("a keyless owner can PLAN", () => {
  it("planRecovery reconstructs the account from a Privy-shaped signer", async () => {
    const calls = noCalls();
    const plan = await planRecovery({
      chain: robinhoodChain,
      owner: ownerFromSigner(privyShapedAccount(calls)),
      rpcUrl: url,
      extraTokens,
    });

    assert.equal(plan.smartAccount, DEPLOYS_TO);
    assert.equal(plan.ownerAddress, hidden.address);
    assert.ok(
      plan.balances.some((b) => b.address.toLowerCase() === DOGGOS),
      "the holding the owner is trying to rescue must appear in the plan",
    );
    // Planning must never ask the owner to sign. If it did, a read-only
    // disclosure would raise an iframe prompt before the owner chose anything.
    assert.deepEqual(calls, noCalls());
    assert.ok(seen.includes("eth_call"), "it really talked to a chain");
  });

  it("the keyless account derives the SAME account as the raw key would", async () => {
    const [keyed, keyless] = await Promise.all([
      planRecovery({ chain: robinhoodChain, owner: ownerFromPrivateKey(HIDDEN), rpcUrl: url }),
      planRecovery({
        chain: robinhoodChain,
        owner: ownerFromSigner(privyShapedAccount(noCalls())),
        rpcUrl: url,
      }),
    ]);
    assert.equal(keyless.smartAccount, keyed.smartAccount);
  });

  it("it carries no key material — the property that made it unrecoverable", () => {
    const account = privyShapedAccount(noCalls());
    assert.equal(account.source, "custom");
    assert.equal((account as { publicKey?: string }).publicKey, undefined);
    assert.equal(JSON.stringify(account).includes(HIDDEN.slice(2)), false);
  });
});

describe("a keyless owner can SWEEP — the half a derivation test cannot see", () => {
  it("recoverFunds signs with the embedded wallet and reaches the bundler", async () => {
    const calls = noCalls();
    submitted.length = 0;

    const result = await recoverFunds({
      chain: robinhoodChain,
      owner: ownerFromSigner(privyShapedAccount(calls)),
      bundlerUrl: url,
      rpcUrl: url,
      to: DESTINATION,
      expectedSmartAccount: DEPLOYS_TO,
      extraTokens,
    });

    assert.equal(submitted.length, 1, "exactly one recovery operation must be submitted");
    const op = sentOp();

    // THE WHOLE POINT: a wallet with no key produced a real signature.
    const signature = String(op.signature ?? "");
    assert.match(signature, /^0x[0-9a-f]{40,}$/i, "the op must carry a real signature");
    assert.ok(
      calls.signMessage + calls.signTypedData > 0,
      "and it must have come from the embedded wallet, not from somewhere else",
    );
    assert.equal(calls.signTransaction, 0, "the 4337 path must never need a raw transaction");
    assert.equal(String(op.sender).toLowerCase(), DEPLOYS_TO.toLowerCase());
    assert.ok(result.txHash, "the owner must be told the sweep landed");
  });

  it("the swept operation is SELF-PAYING — no paymaster smuggled in", () => {
    // The relay refuses any op carrying paymaster fields, so an engine that
    // started attaching them would strand recovery behind gate 4 instead of
    // sponsoring it. Asserted on the op that actually went out.
    const op = sentOp();
    for (const field of [
      "paymaster",
      "paymasterData",
      "paymasterAndData",
      "paymasterVerificationGasLimit",
      "paymasterPostOpGasLimit",
    ]) {
      const v = op[field];
      assert.ok(
        v === undefined || v === null || v === "0x" || v === "",
        `recovery must not carry ${field}`,
      );
    }
  });
});
