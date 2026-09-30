/** Optional read-only mainnet fork: all writes remain in the local Hardhat chain. */
import { expect } from "chai";
import hre from "hardhat";
import { erc20Abi, parseAbi, encodePacked, type Address } from "viem";

const enabled = process.env.TRENCHER_FORK_TEST === "1";
(enabled ? describe : describe.skip)("Trencher against the real V3 router on a local fork", function () {
  this.timeout(180_000);
  it("buys and sells through the deployed router without broadcasting to mainnet", async () => {
    await hre.network.provider.request({method:"hardhat_reset",params:[{forking:{jsonRpcUrl:"https://rpc.mainnet.chain.robinhood.com"}}]});
    const cash="0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
    const bridge="0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
    const router="0xcaf681a66d020601342297493863e78c959e5cb2" as Address;
    const pools="0x1f7d7550b1b028f7571e69a784071f0205fd2efa" as Address;
    const quoter="0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7" as Address;
    const token="0x232cdfc415d10b673845d83dc02ba2eabe7e30d1" as Address;
    // Public account used only to supply a forked USDG balance. No key is read.
    const holder="0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487" as Address;
    const client=await hre.viem.getPublicClient();
    const [owner]=await hre.viem.getWalletClients();
    const test=await hre.viem.getTestClient();
    await test.impersonateAccount({address:holder}); await test.setBalance({address:holder,value:10n**18n});
    await client.request({method:"eth_sendTransaction",params:[{from:holder,to:cash,data: (await import("viem")).encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[owner!.account.address,5_000_000n]})}]});
    await test.stopImpersonatingAccount({address:holder});
    const factory=await hre.viem.deployContract("TrencherVaultFactory",[cash,bridge,router,pools]);
    await factory.write.deploy([owner!.account.address]);
    const vault=await hre.viem.getContractAt("TrencherVault",await factory.read.vaultFor([owner!.account.address]));
    const poolAbi=parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
    const quoteAbi=parseAbi(["function quoteExactInput(bytes path,uint256 amountIn) returns (uint256,uint160[],uint32[],uint256)"]);
    let selected: {a:number;b:number;output:bigint}|null=null;
    for(const a of [100,500,3000,10000]) {
      for(const b of [0,100,500,3000,10000]) {
        const first=await client.readContract({address:pools,abi:poolAbi,functionName:"getPool",args:[cash,b?bridge:token,a]});
        if (/^0x0{40}$/.test(first)) continue;
        const path=b?encodePacked(["address","uint24","address","uint24","address"],[cash,a,bridge,b,token]):encodePacked(["address","uint24","address"],[cash,a,token]);
        try {
          const q=await client.simulateContract({address:quoter,abi:quoteAbi,functionName:"quoteExactInput",args:[path,5_000_000n]});
          if (!selected||q.result[0]>selected.output) selected={a,b,output:q.result[0]};
        } catch { /* no executable pool */ }
      }
    }
    if (!selected||selected.output<=0n) throw new Error("No executable fork route for the fixture token; do not count this as a passing live-route test");
    const usd=await hre.viem.getContractAt("MockERC20",cash);
    await usd.write.approve([vault.address,5_000_000n]);
    const deadline=(await client.getBlock()).timestamp+600n;
    await vault.write.buy([token,selected.a,selected.b,5_000_000n,selected.output*99n/100n,deadline]);
    const held=await client.readContract({address:token,abi:erc20Abi,functionName:"balanceOf",args:[vault.address]});
    expect(held>0n).eq(true);
    const exitPath=selected.b?encodePacked(["address","uint24","address","uint24","address"],[token,selected.b,bridge,selected.a,cash]):encodePacked(["address","uint24","address"],[token,selected.a,cash]);
    const sellQuote=await client.simulateContract({address:quoter,abi:quoteAbi,functionName:"quoteExactInput",args:[exitPath,held]});
    await vault.write.sell([token,selected.a,selected.b,held,sellQuote.result[0]*99n/100n,deadline]);
    expect(await vault.read.tokens()).deep.eq([]);
    expect((await usd.read.balanceOf([owner!.account.address]))>0n).eq(true);
  });
});
