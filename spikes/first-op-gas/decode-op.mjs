/** READ-ONLY. Decode the signed gas limits of landed handleOps transactions. */
import { decodeFunctionData, parseAbi } from "viem";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
async function rpc(m, p) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      const j = await r.json();
      if (!j.error) return j;
    } catch {}
    await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
  }
  return { error: { message: "exhausted retries" } };
}
const abi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
]);
for (const tx of process.argv.slice(2)) {
  const t = (await rpc("eth_getTransactionByHash", [tx])).result;
  const r = (await rpc("eth_getTransactionReceipt", [tx])).result;
  if (!t) { console.log(`${tx}  UNREADABLE / not found`); continue; }
  console.log(`\n${tx}`);
  console.log(`  to ${t.to}  tx gas limit ${BigInt(t.gas)}  receipt gasUsed ${r ? BigInt(r.gasUsed) : "unread"}  block ${Number(BigInt(t.blockNumber))}`);
  let d;
  try { d = decodeFunctionData({ abi, data: t.input }); } catch (e) { console.log(`  not handleOps / decode failed: ${e.message.slice(0, 120)}`); continue; }
  for (const op of d.args[0]) {
    const agl = op.accountGasLimits;
    const ver = BigInt("0x" + agl.slice(2, 34)), call = BigInt("0x" + agl.slice(34));
    const gf = op.gasFees;
    const prio = BigInt("0x" + gf.slice(2, 34)), maxf = BigInt("0x" + gf.slice(34));
    const n = op.nonce, h = n.toString(16).padStart(64, "0");
    console.log(`  sender ${op.sender}`);
    console.log(`    nonce mode 0x${h.slice(0,2)} vType 0x${h.slice(2,4)} ident 0x${h.slice(4,44)} seq ${BigInt("0x"+h.slice(48,64))}`);
    console.log(`    SIGNED verificationGasLimit ${ver}  callGasLimit ${call}  preVerificationGas ${op.preVerificationGas}`);
    console.log(`    SIGNED TOTAL ${ver + call + op.preVerificationGas}`);
    console.log(`    maxPriorityFeePerGas ${prio}  maxFeePerGas ${maxf}`);
    console.log(`    initCode ${(op.initCode.length - 2) / 2} bytes  callData ${(op.callData.length - 2) / 2} bytes  signature ${(op.signature.length - 2) / 2} bytes`);
  }
}
