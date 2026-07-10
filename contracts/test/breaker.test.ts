import { expect } from "chai";
import hre from "hardhat";
import { encodeAbiParameters, encodePacked, getAddress, parseEventLogs } from "viem";

const U = (v: number) => BigInt(Math.round(v * 1e6)); // USDG 6dp
const ID = `0x${"ab".repeat(32)}` as const; // permission id

/** Minimal PackedUserOperation for policy calls — contents are irrelevant to this policy. */
const NOOP_USER_OP = {
  sender: "0x0000000000000000000000000000000000000000",
  nonce: 0n,
  initCode: "0x",
  callData: "0x",
  accountGasLimits: `0x${"00".repeat(32)}`,
  preVerificationGas: 0n,
  gasFees: `0x${"00".repeat(32)}`,
  paymasterAndData: "0x",
  signature: "0x",
} as const;

async function deployAll() {
  const [owner, keeper, stranger, agentAccount] = await hre.viem.getWalletClients();
  const registry = await hre.viem.deployContract("BreakerRegistry");
  const policy = await hre.viem.deployContract("KernelBreakerPolicy");
  const publicClient = await hre.viem.getPublicClient();
  return { owner, keeper, stranger, agentAccount, registry, policy, publicClient };
}

describe("BreakerRegistry", () => {
  it("arms once with first-come owner binding", async () => {
    const { registry, keeper, stranger, agentAccount } = await deployAll();
    await registry.write.arm([agentAccount.account.address, keeper.account.address, 1000]);
    const b = await registry.read.get([agentAccount.account.address]);
    expect(b.maxDrawdownBps).to.equal(1000);
    expect(getAddress(b.keeper)).to.equal(getAddress(keeper.account.address));
    expect(b.tripped).to.equal(false);

    // second arm reverts
    let reverted = false;
    try {
      await registry.write.arm([agentAccount.account.address, stranger.account.address, 500], {
        account: stranger.account,
      });
    } catch {
      reverted = true;
    }
    expect(reverted, "re-arm must revert").to.equal(true);
  });

  it("rejects zero and >100% thresholds", async () => {
    const { registry, keeper, agentAccount } = await deployAll();
    for (const bps of [0, 10_001]) {
      let reverted = false;
      try {
        await registry.write.arm([agentAccount.account.address, keeper.account.address, bps]);
      } catch {
        reverted = true;
      }
      expect(reverted, `threshold ${bps} must revert`).to.equal(true);
    }
  });

  it("keeper reports ratchet the HWM and do not trip below threshold", async () => {
    const { registry, keeper, agentAccount } = await deployAll();
    const acct = agentAccount.account.address;
    await registry.write.arm([acct, keeper.account.address, 1000]); // 10%

    await registry.write.reportEquity([acct, U(1000)], { account: keeper.account });
    await registry.write.reportEquity([acct, U(950)], { account: keeper.account }); // -5%
    const b = await registry.read.get([acct]);
    expect(b.hwmUsdg).to.equal(U(1000));
    expect(b.tripped).to.equal(false);
    expect(await registry.read.drawdownBps([acct])).to.equal(500n);
  });

  it("trips automatically when a report crosses the threshold, and stays tripped", async () => {
    const { registry, keeper, agentAccount, publicClient } = await deployAll();
    const acct = agentAccount.account.address;
    await registry.write.arm([acct, keeper.account.address, 1000]);

    await registry.write.reportEquity([acct, U(1000)], { account: keeper.account });
    const hash = await registry.write.reportEquity([acct, U(900)], { account: keeper.account }); // exactly -10%
    expect(await registry.read.isTripped([acct])).to.equal(true);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const tripped = parseEventLogs({ abi: registry.abi, logs: receipt.logs, eventName: "Tripped" });
    expect(tripped.length).to.equal(1);
    expect(tripped[0]!.args.drawdownBps).to.equal(1000n);

    // recovery reports do NOT untrip
    await registry.write.reportEquity([acct, U(1200)], { account: keeper.account });
    expect(await registry.read.isTripped([acct])).to.equal(true);
  });

  it("strangers cannot report; anyone can trip only what the data supports", async () => {
    const { registry, keeper, stranger, agentAccount } = await deployAll();
    const acct = agentAccount.account.address;
    await registry.write.arm([acct, keeper.account.address, 1000]);
    await registry.write.reportEquity([acct, U(1000)], { account: keeper.account });

    let reverted = false;
    try {
      await registry.write.reportEquity([acct, U(1)], { account: stranger.account });
    } catch {
      reverted = true;
    }
    expect(reverted, "stranger report must revert").to.equal(true);

    // permissionless trip refused while drawdown is 0
    reverted = false;
    try {
      await registry.write.trip([acct], { account: stranger.account });
    } catch {
      reverted = true;
    }
    expect(reverted, "unsupported trip must revert").to.equal(true);

    // after a legitimate threshold-crossing report... auto-trips; but verify
    // trip() path separately: lower the equity via keeper with a higher threshold first
    await registry.write.setThreshold([acct, 9_999]);
    await registry.write.reportEquity([acct, U(500)], { account: keeper.account }); // -50%, below 99.99%
    expect(await registry.read.isTripped([acct])).to.equal(false);
    await registry.write.setThreshold([acct, 4_000]); // 40% — already exceeded by reported data
    await registry.write.trip([acct], { account: stranger.account }); // anyone can enforce now
    expect(await registry.read.isTripped([acct])).to.equal(true);
  });

  it("owner can halt unconditionally and reset with optional HWM rebase", async () => {
    const { registry, keeper, stranger, agentAccount } = await deployAll();
    const acct = agentAccount.account.address;
    await registry.write.arm([acct, keeper.account.address, 1000]);
    await registry.write.reportEquity([acct, U(1000)], { account: keeper.account });
    await registry.write.reportEquity([acct, U(950)], { account: keeper.account });

    await registry.write.halt([acct]); // owner = deployer wallet (default account)
    expect(await registry.read.isTripped([acct])).to.equal(true);

    let reverted = false;
    try {
      await registry.write.reset([acct, true], { account: stranger.account });
    } catch {
      reverted = true;
    }
    expect(reverted, "stranger reset must revert").to.equal(true);

    await registry.write.reset([acct, true]);
    expect(await registry.read.isTripped([acct])).to.equal(false);
    const b = await registry.read.get([acct]);
    expect(b.hwmUsdg).to.equal(U(950)); // rebased to last equity
  });
});

describe("KernelBreakerPolicy", () => {
  function installData(registry: `0x${string}`) {
    return encodePacked(["bytes32", "bytes"], [ID, encodeAbiParameters([{ type: "address" }], [registry])]);
  }

  it("fails closed before install", async () => {
    const { policy } = await deployAll();
    const res = await policy.simulate.checkUserOpPolicy([ID, NOOP_USER_OP]);
    expect(res.result).to.equal(1n);
  });

  it("passes ops while untripped, fails them once tripped (wallet = msg.sender)", async () => {
    const { registry, policy, keeper, agentAccount } = await deployAll();
    const wallet = agentAccount; // plays the smart account calling the policy

    await policy.write.onInstall([installData(registry.address)], { account: wallet.account });
    await registry.write.arm([wallet.account.address, keeper.account.address, 1000]);
    await registry.write.reportEquity([wallet.account.address, U(1000)], { account: keeper.account });

    const ok = await policy.simulate.checkUserOpPolicy([ID, NOOP_USER_OP], { account: wallet.account });
    expect(ok.result).to.equal(0n);
    const sigOk = await policy.simulate.checkSignaturePolicy(
      [ID, wallet.account.address, `0x${"00".repeat(32)}`, "0x"],
      { account: wallet.account },
    );
    expect(sigOk.result).to.equal(0n);

    await registry.write.reportEquity([wallet.account.address, U(850)], { account: keeper.account }); // -15% → trip

    const blocked = await policy.simulate.checkUserOpPolicy([ID, NOOP_USER_OP], { account: wallet.account });
    expect(blocked.result).to.equal(1n);
    const sigBlocked = await policy.simulate.checkSignaturePolicy(
      [ID, wallet.account.address, `0x${"00".repeat(32)}`, "0x"],
      { account: wallet.account },
    );
    expect(sigBlocked.result).to.equal(1n);
  });

  it("cannot double-install; uninstall deprecates and fails closed", async () => {
    const { registry, policy, agentAccount } = await deployAll();
    const wallet = agentAccount;
    const data = installData(registry.address);

    await policy.write.onInstall([data], { account: wallet.account });
    let reverted = false;
    try {
      await policy.write.onInstall([data], { account: wallet.account });
    } catch {
      reverted = true;
    }
    expect(reverted, "double install must revert").to.equal(true);

    await policy.write.onUninstall([data], { account: wallet.account });
    const res = await policy.simulate.checkUserOpPolicy([ID, NOOP_USER_OP], { account: wallet.account });
    expect(res.result).to.equal(1n);
  });

  it("declares itself a policy module (type 5)", async () => {
    const { policy } = await deployAll();
    expect(await policy.read.isModuleType([5n])).to.equal(true);
    expect(await policy.read.isModuleType([1n])).to.equal(false);
  });
});
