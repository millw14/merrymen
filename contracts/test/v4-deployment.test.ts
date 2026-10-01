import { expect } from "chai";
import hre from "hardhat";
import { v4DeploymentBuild, verifyV4Runtime } from "../scripts/lib/v4-build";
import { claimDeploymentAttempt } from "../scripts/lib/deployment-attempt";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("V4SelfSwap deployment identity", () => {
  it("reproduces the full deployed runtime including the PoolManager immutable", async () => {
    const manager = await hre.viem.deployContract("MockPoolManager");
    const build = await v4DeploymentBuild(hre, manager.address);
    const adapter = await hre.viem.deployContract("V4SelfSwap", [manager.address]);
    const client = await hre.viem.getPublicClient();
    const actual = await client.getCode({ address: adapter.address });
    expect(actual).to.equal(build.expectedRuntime);
    expect(() => verifyV4Runtime(actual, build.expectedRuntime)).not.to.throw();
  });

  it("refuses a different PoolManager, missing code, and changed runtime", async () => {
    const first = await hre.viem.deployContract("MockPoolManager");
    const second = await hre.viem.deployContract("MockPoolManager");
    const a = await v4DeploymentBuild(hre, first.address);
    const b = await v4DeploymentBuild(hre, second.address);
    expect(() => verifyV4Runtime(b.expectedRuntime, a.expectedRuntime)).to.throw("runtime differs");
    expect(() => verifyV4Runtime(undefined, a.expectedRuntime)).to.throw("runtime differs");
    expect(() => verifyV4Runtime("0x", a.expectedRuntime)).to.throw("runtime differs");
    expect(() => verifyV4Runtime(`0xff${a.expectedRuntime.slice(4)}`, a.expectedRuntime)).to.throw("runtime differs");
  });

  it("refuses creation data that does not belong to the compiler build", async () => {
    const manager = await hre.viem.deployContract("MockPoolManager");
    const artifact = await hre.artifacts.readArtifact("V4SelfSwap");
    const altered = Object.create(hre);
    altered.artifacts = {
      readArtifact: async () => ({ ...artifact, bytecode: "0x60006000f3" }),
      getBuildInfo: hre.artifacts.getBuildInfo.bind(hre.artifacts),
    };
    let error: unknown;
    try { await v4DeploymentBuild(altered, manager.address); } catch (e) { error = e; }
    expect(String(error)).to.contain("creation bytecode or ABI mismatch");
  });

  it("retains a deployment claim before any hash and after recording a hash", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "v4-attempt-"));
    const file = path.join(dir, "attempt.json");
    try {
      const attempt = { chainId: 4663, nonce: 5, transactionHash: "" };
      const claim = claimDeploymentAttempt(file, attempt);
      claim.close(); // Simulate a crash/ambiguous broadcast before the hash was saved.
      expect(JSON.parse(readFileSync(file, "utf8"))).to.deep.equal(attempt);
      expect(() => claimDeploymentAttempt(file, attempt)).to.throw();
      const second = path.join(dir, "second.json");
      const known = claimDeploymentAttempt(second, attempt);
      known.save({ ...attempt, transactionHash: "0x123" });
      known.close();
      expect(JSON.parse(readFileSync(second, "utf8")).transactionHash).to.equal("0x123");
      expect(() => claimDeploymentAttempt(second, attempt)).to.throw();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
