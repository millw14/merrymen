import { expect } from "chai";
import { createHash } from "node:crypto";
import hre from "hardhat";
import {
  concat, encodeAbiParameters, encodeFunctionData, encodePacked, getAddress,
  pad, parseAbi, toFunctionSelector, zeroAddress, zeroHash,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getUserOperationHash, toPackedUserOperation, type UserOperation } from "viem/account-abstraction";
import { nextRevocationNonce } from "../../web/src/lib/permission-revocation";
import fixture from "./fixtures/kernel-v3.3/runtime.json";

// These are public deterministic test keys. No RPC, secrets or chain fork is used.
const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const session = privateKeyToAccount(`0x${"22".repeat(32)}`);
const entryPoint = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
const account = "0x1000000000000000000000000000000000000001" as const;
const counterfactual = "0x1000000000000000000000000000000000000002" as const;
const validator = fixture.contracts.ECDSAValidator.address as Address;
const signer = fixture.contracts.ECDSASigner.address as Address;
const executeSelector = toFunctionSelector("execute(bytes32,bytes)");
const abi = parseAbi([
  "function initialize(bytes21 rootValidator,address hook,bytes validatorData,bytes hookData,bytes[] initConfig)",
  "function entrypoint() view returns (address)",
  "function currentNonce() view returns (uint32)",
  "function validNonceFrom() view returns (uint32)",
  "function validationConfig(bytes21 id) view returns (uint32 nonce,address hook)",
  "function invalidateNonce(uint32 nonce) payable",
  "function execute(bytes32 mode,bytes data) payable",
  "function validateUserOp((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp,bytes32 hash,uint256 missingFunds) payable returns (uint256)",
  "error InvalidNonce()",
  "error EnableNotApproved()",
  "error InvalidCaller()",
]);
const enableTypes = { Enable: [
  { name: "validationId", type: "bytes21" }, { name: "nonce", type: "uint32" },
  { name: "hook", type: "address" }, { name: "validatorData", type: "bytes" },
  { name: "hookData", type: "bytes" }, { name: "selectorData", type: "bytes" },
] } as const;
const validationId = (id: Hex) => concat(["0x02", pad(id, { size: 20, dir: "right" })]);
const permissionData = encodeAbiParameters([{ type: "bytes[]" }], [[concat(["0x0000", signer, session.address])]]);

describe("Kernel v3.3 actual runtime permission revocation", function () {
  this.timeout(30_000);

  async function setup() {
    const publicClient = await hre.viem.getPublicClient();
    const [deployer, stranger] = await hre.viem.getWalletClients();
    const snapshot = await hre.network.provider.send("evm_snapshot");
    for (const module of [fixture.contracts.ECDSAValidator, fixture.contracts.ECDSASigner]) {
      await hre.network.provider.send("hardhat_setCode", [module.address, module.runtime]);
    }
    await hre.network.provider.send("hardhat_impersonateAccount", [entryPoint]);
    await hre.network.provider.send("hardhat_setBalance", [entryPoint, "0x56bc75e2d63100000"]);
    const entryPointClient = await hre.viem.getWalletClient(entryPoint);
    const chainId = await publicClient.getChainId();

    async function deploy(address: Address) {
      // Materialize a fresh account at its known counterfactual address. This
      // deliberately uses real Kernel code and its real initialize(), not a
      // Solidity approximation of the nonce logic or an edited storage slot.
      await hre.network.provider.send("hardhat_setCode", [address, fixture.contracts.Kernel.runtime]);
      await deployer.writeContract({ address, abi, functionName: "initialize", args: [concat(["0x01", validator]), zeroAddress, owner.address, "0x", []] });
      expect(getAddress(await publicClient.readContract({ address, abi, functionName: "entrypoint" }))).to.equal(getAddress(entryPoint));
    }
    async function enable(address: Address, id: Hex, nonce: number) {
      return owner.signTypedData({
        domain: { name: "Kernel", version: "0.3.3", chainId, verifyingContract: address },
        types: enableTypes, primaryType: "Enable",
        message: { validationId: validationId(id), nonce, hook: zeroAddress, validatorData: permissionData, hookData: "0x", selectorData: executeSelector },
      });
    }
    async function operation(address: Address, id?: Hex, enableSignature?: Hex, callData?: Hex) {
      // Kernel packs validation mode/type/id into the EntryPoint nonce key.
      const nonce = id ? BigInt(concat([enableSignature ? "0x01" : "0x00", "0x02", pad(id, { size: 20, dir: "right" }), "0x0000", "0x0000000000000000"])) : 0n;
      const op: UserOperation<"0.7"> = {
        sender: address, nonce, callData: callData ?? encodeFunctionData({ abi, functionName: "execute", args: [zeroHash, encodePacked(["address", "uint256", "bytes"], [stranger.account.address, 0n, "0x"])] }),
        callGasLimit: 1_000_000n, verificationGasLimit: 1_000_000n, preVerificationGas: 50_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: "0x",
      };
      const hash = getUserOperationHash({ userOperation: op, entryPointAddress: entryPoint, entryPointVersion: "0.7", chainId });
      const userSignature = await (id ? session : owner).signMessage({ message: { raw: hash } });
      op.signature = id ? concat(["0xff", userSignature]) : userSignature;
      if (enableSignature) op.signature = concat([zeroAddress, encodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }, { type: "bytes" }, { type: "bytes" }],
        [permissionData, "0x", executeSelector, enableSignature, op.signature],
      )]);
      return { op, hash, packed: toPackedUserOperation(op) };
    }
    async function validate(signed: Awaited<ReturnType<typeof operation>>, commit = false) {
      const args = [signed.packed, signed.hash, 0n] as const;
      const result = await publicClient.simulateContract({ address: signed.op.sender, abi, functionName: "validateUserOp", args, account: entryPoint });
      // ERC-4337 validationData packs aggregator/signature failure (160 bits),
      // validUntil (48 bits), and validAfter (48 bits). An unrestricted
      // permission can encode maxUint48 instead of zero for validUntil.
      expect(result.result & ((1n << 160n) - 1n), "real ECDSA validation must succeed").to.equal(0n);
      const now = (await publicClient.getBlock()).timestamp;
      const until = (result.result >> 160n) & ((1n << 48n) - 1n);
      expect((result.result >> 208n) <= now, "permission is already valid").to.equal(true);
      expect(until === 0n || until >= now, "permission is not expired").to.equal(true);
      if (commit) await entryPointClient.writeContract({ address: signed.op.sender, abi, functionName: "validateUserOp", args });
    }
    async function revoke(address: Address, undeployed = false) {
      const current = undeployed ? 0 : await publicClient.readContract({ address, abi, functionName: "currentNonce" });
      const target = nextRevocationNonce(current);
      if (undeployed) await deploy(address);
      const inner = encodeFunctionData({ abi, functionName: "invalidateNonce", args: [target] });
      const callData = encodeFunctionData({ abi, functionName: "execute", args: [zeroHash, encodePacked(["address", "uint256", "bytes"], [address, 0n, inner])] });
      const signed = await operation(address, undefined, undefined, callData);
      await validate(signed, true);
      // EntryPoint executes only after successful root signature validation.
      await entryPointClient.sendTransaction({ to: address, data: callData });
      expect(await publicClient.readContract({ address, abi, functionName: "validNonceFrom" })).to.equal(target);
      expect(await publicClient.readContract({ address, abi, functionName: "currentNonce" })).to.equal(target);
      return target;
    }
    return { publicClient, stranger, deploy, enable, operation, validate, revoke, restore: async () => {
      await hre.network.provider.send("hardhat_stopImpersonatingAccount", [entryPoint]);
      await hre.network.provider.send("evm_revert", [snapshot]);
    } };
  }

  it("pins the deployed Kernel and ECDSA modules with bytecode hashes", () => {
    for (const module of Object.values(fixture.contracts)) {
      expect(createHash("sha256").update(Buffer.from(module.runtime.slice(2), "hex")).digest("hex")).to.equal(module.sha256);
    }
  });

  it("invalidates installed permissions AND copied unused enable signatures while preserving root and fresh grants", async () => {
    const h = await setup();
    try {
      await h.deploy(account);
      const installed = "0x11111111", unused = "0x22222222", fresh = "0x33333333";
      const unusedSignature = await h.enable(account, unused, 1);
      await h.validate(await h.operation(account, installed, await h.enable(account, installed, 1)), true);
      const oldOperation = await h.operation(account, installed);
      const unusedOperation = await h.operation(account, unused, unusedSignature);
      await h.validate(oldOperation);
      await h.validate(unusedOperation); // simulate only: prove valid before revoke without installing
      await expectRevert(h.publicClient.simulateContract({ address: account, abi, functionName: "invalidateNonce", args: [2], account: h.stranger.account }), "ECDSAValidator: sender is not owner");
      const nonce = await h.revoke(account);
      await expectRevert(h.validate(oldOperation), "InvalidNonce");
      await expectRevert(h.validate(unusedOperation), "EnableNotApproved");
      await h.validate(await h.operation(account)); // owner remains valid despite its installation nonce 1
      await h.validate(await h.operation(account, fresh, await h.enable(account, fresh, nonce)), true);
      await h.validate(await h.operation(account, fresh));
    } finally { await h.restore(); }
  });

  it("invalidates an unused counterfactual grant after first deployment and owner revocation", async () => {
    const h = await setup();
    try {
      expect(await h.publicClient.getCode({ address: counterfactual })).to.equal(undefined);
      const id = "0x44444444";
      const captured = await h.enable(counterfactual, id, 1);
      // Prove the captured counterfactual authorization works against a fresh
      // deployment, then return to undeployed state before the actual test.
      const before = await hre.network.provider.send("evm_snapshot");
      await h.deploy(counterfactual);
      await h.validate(await h.operation(counterfactual, id, captured));
      await hre.network.provider.send("evm_revert", [before]);
      const nonce = await h.revoke(counterfactual, true);
      await expectRevert(h.validate(await h.operation(counterfactual, id, captured)), "EnableNotApproved");
      await h.validate(await h.operation(counterfactual));
      await h.validate(await h.operation(counterfactual, id, await h.enable(counterfactual, id, nonce)), true);
      await h.validate(await h.operation(counterfactual, id));
    } finally { await h.restore(); }
  });
});

async function expectRevert(promise: Promise<unknown>, name: string) {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  // Hardhat has no source artifact for the pinned external runtime, so it
  // reports the exact custom-error bytes instead of decoding the ABI name.
  if (name.includes(":")) {
    expect(String(failure)).to.contain(`reverted with reason string '${name}'`);
    return;
  }
  const revertData = String(failure).match(/return data: (0x[0-9a-f]+)/i)?.[1];
  expect(revertData, `must revert specifically with ${name}`).to.equal(toFunctionSelector(`${name}()`));
}
