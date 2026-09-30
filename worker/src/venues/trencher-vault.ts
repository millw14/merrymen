import { decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, type Address, type PublicClient } from "viem";
import type { FenceCall, FenceVerdict } from "../final-fence";
import { CASH, UNISWAP, TRENCHER_FACTORY_ABI, TRENCHER_VAULT_ABI, grantTrencher, type StoredGrant } from "../../../packages/core/src/index";
import type { Quote } from "./uniswap";

/** This permission cannot be inferred from settings or from a successful quote. */
export async function verifyTrencherCustody(client: PublicClient, grant: StoredGrant) {
  const scope = grantTrencher(grant);
  if (!scope) throw new Error("Autonomous Trencher permission has not been signed");
  const trustedHash = process.env.TRENCHER_FACTORY_CODE_HASH;
  if (!trustedHash || !/^0x[0-9a-fA-F]{64}$/.test(trustedHash)) throw new Error("Verified Trencher deployment is not configured");
  const read = (functionName: "cash"|"bridge"|"router"|"poolFactory") => client.readContract({address:scope.factory,abi:TRENCHER_FACTORY_ABI,functionName});
  const [cash,bridge,router,poolFactory,predicted,code] = await Promise.all([
    read("cash"),read("bridge"),read("router"),read("poolFactory"),
    client.readContract({address:scope.factory,abi:TRENCHER_FACTORY_ABI,functionName:"vaultFor",args:[grant.smartAccount]}),
    client.getCode({address:scope.factory}),
  ]);
  if (!code || code === "0x" || cash.toLowerCase() !== CASH.USDG.toLowerCase() || bridge.toLowerCase() !== CASH.WETH.toLowerCase() ||
      router.toLowerCase() !== UNISWAP.swapRouter02.toLowerCase() || poolFactory.toLowerCase() !== UNISWAP.v3Factory.toLowerCase() || predicted.toLowerCase() !== scope.vault) {
    throw new Error("Trencher factory does not match the sealed account and configured venue");
  }
  if (keccak256(code).toLowerCase() !== trustedHash.toLowerCase()) throw new Error("Trencher factory bytecode does not match the verified deployment");
  const vaultCode = await client.getCode({address:scope.vault});
  if (vaultCode && vaultCode !== "0x") {
    const [owner,version] = await Promise.all([
      client.readContract({address:scope.vault,abi:TRENCHER_VAULT_ABI,functionName:"owner"}),
      client.readContract({address:scope.vault,abi:TRENCHER_VAULT_ABI,functionName:"VERSION"}),
    ]);
    if (owner.toLowerCase() !== grant.smartAccount.toLowerCase() || version !== 1n) throw new Error("Trencher custody owner/version mismatch");
  }
  return {...scope,deployed:!!vaultCode && vaultCode !== "0x"};
}

export function buildTrencherCalls(args: {
  grant: StoredGrant; deployed: boolean; quote: Quote; token: Address;
  side: "buy"|"sell"; amountIn: bigint; minOut: bigint; deadline: bigint;
}) {
  const scope = grantTrencher(args.grant);
  if (!scope) throw new Error("Missing signed autonomous permission");
  if (args.quote.v4) throw new Error("Trencher vault v1 supports verified v3 pools only");
  if (args.amountIn <= 0n || args.minOut <= 0n || args.deadline <= 0n) throw new Error("Invalid order bounds");
  if (args.side === "buy" && args.amountIn > 5_000_000n) throw new Error("Trencher entry exceeds 5 USDG");
  let fee1 = args.quote.fee; let fee2 = 0;
  if (args.quote.path) {
    const {tokens,fees} = args.quote.path;
    const expected = args.side === "buy" ? [CASH.USDG,CASH.WETH,args.token] : [args.token,CASH.WETH,CASH.USDG];
    if (tokens.length !== 3 || fees.length !== 2 || tokens.some((t,i)=>t.toLowerCase() !== expected[i]!.toLowerCase())) throw new Error("Unsealed bridge path");
    [fee1,fee2] = args.side === "buy" ? [fees[0]!,fees[1]!] : [fees[1]!,fees[0]!];
  }
  const calls: {to:Address;data:`0x${string}`;value:bigint}[] = [];
  if (!args.deployed) calls.push({to:scope.factory,value:0n,data:encodeFunctionData({abi:TRENCHER_FACTORY_ABI,functionName:"deploy",args:[args.grant.smartAccount]})});
  if (args.side === "buy") calls.push({to:CASH.USDG,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[scope.vault,args.amountIn]})});
  calls.push({to:scope.vault,value:0n,data:encodeFunctionData({abi:TRENCHER_VAULT_ABI,functionName:args.side,args:[args.token,fee1,fee2,args.amountIn,args.minOut,args.deadline]})});
  return calls;
}

/** Decode independently of the builder before the executor receives the batch. */
export function checkTrencherCalls(calls: readonly FenceCall[], expected: {
  grant: StoredGrant; deployed: boolean; token: Address; side: "buy"|"sell";
  amountIn: bigint; minOut: bigint; deadline: bigint;
}): FenceVerdict {
  const no = (detail: string): FenceVerdict => ({ok:false,rule:"build-integrity",detail});
  const same = (a:string,b:string) => a.toLowerCase()===b.toLowerCase();
  const scope=grantTrencher(expected.grant);
  if (!scope || calls.some(c=>c.value!==0n) || calls.length!==1+Number(!expected.deployed)+Number(expected.side==="buy")) return no("Unexpected Trencher batch");
  try {
    let i=0;
    if (!expected.deployed) {
      const c=calls[i++]!;
      const d=decodeFunctionData({abi:TRENCHER_FACTORY_ABI,data:c.data});
      if (!same(c.to,scope.factory)||d.functionName!=="deploy"||!same(d.args[0],expected.grant.smartAccount)) return no("Factory or owner changed");
    }
    if (expected.side==="buy") {
      const c=calls[i++]!;
      const d=decodeFunctionData({abi:erc20Abi,data:c.data});
      if (!same(c.to,CASH.USDG)||d.functionName!=="approve"||!same(d.args[0],scope.vault)||d.args[1]!==expected.amountIn) return no("Cash approval changed");
    }
    const c=calls[i]!;
    const d=decodeFunctionData({abi:TRENCHER_VAULT_ABI,data:c.data});
    if (!same(c.to,scope.vault)||(d.functionName!=="buy"&&d.functionName!=="sell")||d.functionName!==expected.side) return no("Vault operation changed");
    if (!same(d.args[0],expected.token)||d.args[3]!==expected.amountIn||d.args[4]!==expected.minOut||d.args[5]!==expected.deadline) return no("Token, amount, output floor or deadline changed");
    return {ok:true};
  } catch { return no("Undecodable Trencher batch"); }
}
