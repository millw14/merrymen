import { expect } from "chai";
import hre from "hardhat";
import { getAddress } from "viem";

const FOREVER = 2n ** 48n;
async function setup() {
  const [owner, outsider] = await hre.viem.getWalletClients();
  const cash = await hre.viem.deployContract("MockERC20");
  const bridge = await hre.viem.deployContract("MockERC20");
  const token = await hre.viem.deployContract("MockERC20");
  const router = await hre.viem.deployContract("TrencherMockRouter");
  const factory = await hre.viem.deployContract("TrencherVaultFactory", [cash.address, bridge.address, router.address, router.address]);
  const predicted = await factory.read.vaultFor([owner!.account.address]);
  await factory.write.deploy([owner!.account.address]);
  const vault = await hre.viem.getContractAt("TrencherVault", predicted);
  await cash.write.mint([owner!.account.address, 100_000_000n]);
  await cash.write.mint([router.address, 100_000_000n]);
  await token.write.mint([router.address, 100_000_000n]);
  await cash.write.approve([vault.address, 100_000_000n]);
  await router.write.setPool([cash.address, token.address, 3000, router.address]);
  return { owner: owner!, outsider: outsider!, cash, bridge, token, router, factory, vault };
}
async function rejects(fn: () => Promise<unknown>, name: string) {
  try { await fn(); expect.fail("expected refusal"); } catch (e) { expect(String(e)).to.include(name); }
}

describe("Autonomous Trencher custody", () => {
  it("buys an unknown-at-signing token and sells it without an owner token approval", async () => {
    const {owner,cash,token,router,vault} = await setup();
    await vault.write.buy([token.address,3000,0,5_000_000n,9_000_000n,FOREVER]);
    expect(await token.read.balanceOf([vault.address])).eq(10_000_000n);
    expect(await vault.read.tokens()).deep.eq([getAddress(token.address)]);
    expect(await vault.read.cost([token.address])).eq(5_000_000n);
    expect((await vault.read.entryAt([token.address])) > 0n).eq(true);
    expect(await token.read.allowance([owner.account.address,vault.address])).eq(0n);
    await router.write.setRate([3n,5n]);
    await vault.write.sell([token.address,3000,0,10_000_000n,5_900_000n,FOREVER]);
    expect(await cash.read.balanceOf([owner.account.address])).eq(101_000_000n);
    expect(await token.read.balanceOf([vault.address])).eq(0n);
    expect(await vault.read.tokens()).deep.eq([]);
    expect(await vault.read.cost([token.address])).eq(0n);
    expect(await cash.read.balanceOf([vault.address])).eq(0n);
    expect(await token.read.allowance([vault.address,router.address])).eq(0n);
    expect(await cash.read.allowance([vault.address,router.address])).eq(0n);
  });
  it("enforces per-buy and rolling daily caps, while leaving exits available", async () => {
    const {token,vault} = await setup();
    await rejects(()=>vault.write.buy([token.address,3000,0,5_000_001n,1n,FOREVER]),"InvalidAmount");
    for(let n=0;n<5;n++) await vault.write.buy([token.address,3000,0,5_000_000n,1n,FOREVER]);
    await rejects(()=>vault.write.buy([token.address,3000,0,1n,1n,FOREVER]),"BudgetExceeded");
    await vault.write.sell([token.address,3000,0,1_000_000n,1n,FOREVER]);
    const test = await hre.viem.getTestClient();
    await test.increaseTime({seconds:86401}); await test.mine({blocks:1});
    await vault.write.buy([token.address,3000,0,5_000_000n,1n,FOREVER]);
    expect(await vault.read.spent()).eq(5_000_000n);
  });
  it("refuses strangers, unknown pools, expired orders and zero minimum outputs", async () => {
    const {outsider,token,vault} = await setup();
    const foreign = await hre.viem.getContractAt("TrencherVault",vault.address,{client:{wallet:outsider}});
    await rejects(()=>foreign.write.buy([token.address,3000,0,1n,1n,FOREVER]),"Unauthorized");
    await rejects(()=>foreign.write.recover([token.address]),"Unauthorized");
    await rejects(()=>vault.write.buy([token.address,500,0,1n,1n,FOREVER]),"InvalidRoute");
    await rejects(()=>vault.write.buy([token.address,3000,0,1n,1n,1n]),"Expired");
    await rejects(()=>vault.write.buy([token.address,3000,0,1n,0n,FOREVER]),"InvalidAmount");
  });
  it("reverts failed fills without charging the budget or taking cash", async () => {
    const {owner,cash,token,vault} = await setup();
    await rejects(()=>vault.write.buy([token.address,3000,0,5_000_000n,20_000_000n,FOREVER]),"slippage");
    expect(await vault.read.spent()).eq(0n);
    expect(await cash.read.balanceOf([owner.account.address])).eq(100_000_000n);
  });
  it("preserves remaining cost and entry time across partial exits and owner recovery", async () => {
    const {owner,outsider,token,vault} = await setup();
    await vault.write.buy([token.address,3000,0,5_000_000n,1n,FOREVER]);
    const at=await vault.read.entryAt([token.address]);
    await vault.write.sell([token.address,3000,0,4_000_000n,1n,FOREVER]);
    expect(await vault.read.cost([token.address])).eq(3_000_000n);
    expect(await vault.read.entryAt([token.address])).eq(at);
    expect(await token.read.balanceOf([vault.address])).eq(6_000_000n);
    const foreign = await hre.viem.getContractAt("TrencherVault",vault.address,{client:{wallet:outsider}});
    await rejects(()=>foreign.write.sell([token.address,3000,0,1n,1n,FOREVER]),"Unauthorized");
    await vault.write.recover([token.address]);
    expect(await token.read.balanceOf([owner.account.address])).eq(6_000_000n);
    expect(await vault.read.tokens()).deep.eq([]);
    expect(await vault.read.cost([token.address])).eq(0n);
    expect(await vault.read.entryAt([token.address])).eq(0n);
  });
  it("supports a fixed bridge route and deterministic idempotent deployment", async () => {
    const {owner,cash,bridge,token,router,factory,vault} = await setup();
    await router.write.setPool([cash.address,bridge.address,500,router.address]);
    await router.write.setPool([bridge.address,token.address,3000,router.address]);
    await vault.write.buy([token.address,500,3000,5_000_000n,1n,FOREVER]);
    await vault.write.sell([token.address,500,3000,10_000_000n,1n,FOREVER]);
    await factory.write.deploy([owner.account.address]);
    expect(getAddress(await factory.read.vaultFor([owner.account.address]))).eq(getAddress(vault.address));
    expect(getAddress(await vault.read.owner())).eq(getAddress(owner.account.address));
  });
});
