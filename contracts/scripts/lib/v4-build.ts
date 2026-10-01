import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { createHash } from "node:crypto";
import { encodeDeployData, keccak256, type Address, type Hex } from "viem";

export const V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as const;
export const V4_CHAINS = new Set([4663, 46630]);
const SOURCE = "contracts/V4SelfSwap.sol";
const NAME = "V4SelfSwap";

/** Substitute only the compiler-identified PoolManager immutable, never mask bytes. */
export async function v4DeploymentBuild(hre: HardhatRuntimeEnvironment, poolManager: Address) {
  const artifact = await hre.artifacts.readArtifact(NAME);
  const build = await hre.artifacts.getBuildInfo(`${SOURCE}:${NAME}`);
  if (!build) throw new Error("V4SelfSwap build info missing; compile first");
  const compiled = build.output.contracts[SOURCE]![NAME]!;
  const runtime = compiled.evm.deployedBytecode;
  const refs = runtime.immutableReferences;
  if (!refs) throw new Error("Compiler omitted V4SelfSwap immutable references");
  const ids = Object.keys(refs);
  // A new immutable must be deliberately supported, not assigned the PM address.
  const ast = build.output.sources[SOURCE]!.ast;
  const nodes: Record<string, unknown>[] = [];
  function walk(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const node = value as Record<string, unknown>;
    if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable") nodes.push(node);
    Object.values(node).forEach(walk);
  }
  walk(ast);
  if (ids.length !== 1 || nodes.length !== 1 || nodes[0]!.name !== "poolManager" ||
      String(nodes[0]!.id) !== ids[0]) throw new Error("Unexpected V4SelfSwap immutable layout");
  if (artifact.deployedBytecode !== `0x${runtime.object}`) throw new Error("Artifact/build runtime mismatch");
  if (artifact.bytecode !== `0x${compiled.evm.bytecode.object}` ||
      JSON.stringify(artifact.abi) !== JSON.stringify(compiled.abi)) {
    throw new Error("Artifact/build creation bytecode or ABI mismatch");
  }
  let expected = runtime.object;
  const replacement = poolManager.slice(2).toLowerCase().padStart(64, "0");
  if (refs[ids[0]!]!.length === 0) throw new Error("PoolManager immutable has no references");
  for (const ref of refs[ids[0]!]!) {
    if (ref.length !== 32 || ref.start < 0 || (ref.start + ref.length) * 2 > expected.length) {
      throw new Error("Invalid PoolManager immutable reference");
    }
    expected = expected.slice(0, ref.start * 2) + replacement + expected.slice((ref.start + ref.length) * 2);
  }
  const expectedRuntime = `0x${expected}` as Hex;
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode as Hex,
    data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode as Hex, args: [poolManager] }),
    expectedRuntime,
    runtimeHash: keccak256(expectedRuntime),
    compiler: build.solcLongVersion,
    compilerInputSha256: createHash("sha256").update(JSON.stringify(build.input)).digest("hex"),
    optimizer: build.input.settings.optimizer,
    evmVersion: build.input.settings.evmVersion,
  };
}

export function verifyV4Runtime(actual: Hex | undefined, expected: Hex): void {
  if (!actual || actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("Deployed V4SelfSwap runtime differs from the reviewed build; do not authorize this address");
  }
}
