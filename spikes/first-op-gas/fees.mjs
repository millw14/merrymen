import { createPublicClient, http, formatGwei } from "viem";
const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
const b = await client.getBlock();
const fees = await client.estimateFeesPerGas().catch((e) => ({ err: String(e).slice(0, 200) }));
const gp = await client.getGasPrice();
console.log("block                 ", b.number.toString());
console.log("baseFeePerGas         ", b.baseFeePerGas?.toString(), "wei =", formatGwei(b.baseFeePerGas ?? 0n), "gwei");
console.log("block gasLimit (hdr)  ", b.gasLimit.toString());
console.log("block gasUsed         ", b.gasUsed.toString());
console.log("getGasPrice()         ", gp.toString(), "wei =", formatGwei(gp), "gwei");
console.log("estimateFeesPerGas()  ", JSON.stringify(fees, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
if (fees.maxFeePerGas) {
  console.log("  maxFeePerGas        ", fees.maxFeePerGas.toString(), "wei =", formatGwei(fees.maxFeePerGas), "gwei");
  console.log("  maxPriorityFeePerGas", fees.maxPriorityFeePerGas.toString(), "wei =", formatGwei(fees.maxPriorityFeePerGas), "gwei");
  for (const g of [460797n, 3000000n, 7711654n, 12000000n, 32000000n]) {
    console.log(`  ${String(g).padStart(9)} gas x maxFeePerGas = ${(Number(g * fees.maxFeePerGas) / 1e18).toFixed(9)} ETH`);
  }
}
