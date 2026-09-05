/**
 * READ-ONLY. For every ENABLE that ran on an ALREADY-DEPLOYED account,
 * decode the SIGNED gas limits and the enable-blob size from the landed
 * handleOps calldata. Relates enable-blob bytes -> verificationGasLimit,
 * which is what a merrymen renewal estimate has to be compared against.
 */
import fs from "node:fs";
import { decodeFunctionData, parseAbi } from "viem";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const abi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
]);
let id = 0;
async function batch(reqs) {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reqs) });
      const j = await r.json();
      if (Array.isArray(j)) return j;
    } catch {}
    await new Promise((s) => setTimeout(s, 2000 * (i + 1)));
  }
  return null;
}
const j = JSON.parse(fs.readFileSync("perm-ops.json", "utf8"));
const late = j.ops.filter((o) => o.vType === "0x02" && o.mode === "0x01" && o.block > o.deployBlock);
const N = Number(process.env.N ?? 60);
const pick = late.sort((a, b) => Number(BigInt(b.actualGasUsed) - BigInt(a.actualGasUsed))).slice(0, N);
console.log(`decoding ${pick.length} of ${late.length} already-deployed ENABLEs (largest by actualGasUsed)`);
const rows = [], unread = [];
for (let i = 0; i < pick.length; i += 6) {
  const s = pick.slice(i, i + 6);
  const reqs = s.map((o) => ({ jsonrpc: "2.0", id: ++id, method: "eth_getTransactionByHash", params: [o.tx] }));
  const res = await batch(reqs);
  if (!res) { for (const o of s) unread.push(o.tx); continue; }
  const m = new Map(res.map((x) => [x.id, x]));
  for (let k = 0; k < s.length; k++) {
    const o = s[k], t = m.get(reqs[k].id)?.result;
    if (!t) { unread.push(o.tx); continue; }
    let d; try { d = decodeFunctionData({ abi, data: t.input }); } catch { unread.push(o.tx + " (not handleOps)"); continue; }
    const op = d.args[0].find((x) => x.sender.toLowerCase() === o.sender.toLowerCase() && x.nonce.toString(16).padStart(64, "0").slice(0, 4) === "0102");
    if (!op) { unread.push(o.tx + " (op not located in bundle)"); continue; }
    const agl = op.accountGasLimits;
    rows.push({
      sender: o.sender, kernel: o.kernel, block: o.block, deployBlock: o.deployBlock,
      initCodeBytes: (op.initCode.length - 2) / 2,
      sigBytes: (op.signature.length - 2) / 2,
      callDataBytes: (op.callData.length - 2) / 2,
      ver: BigInt("0x" + agl.slice(2, 34)), call: BigInt("0x" + agl.slice(34)), pre: op.preVerificationGas,
      actualGasUsed: BigInt(o.actualGasUsed), tx: o.tx,
    });
  }
  process.stdout.write(".");
  await new Promise((s) => setTimeout(s, 250));
}
console.log("");
rows.sort((a, b) => Number((b.ver + b.call + b.pre) - (a.ver + a.call + a.pre)));
console.log(`${"sender".padEnd(44)} ${"kernel".padEnd(11)} initCode  sigB  verifGas   callGas   preVerif   SIGNED TOTAL  used`);
for (const r of rows) {
  const tot = r.ver + r.call + r.pre;
  console.log(`${r.sender} ${r.kernel.padEnd(11)} ${String(r.initCodeBytes).padStart(8)} ${String(r.sigBytes).padStart(5)} ${String(r.ver).padStart(9)} ${String(r.call).padStart(9)} ${String(r.pre).padStart(9)} ${String(tot).padStart(13)}  ${r.actualGasUsed}${tot > 3000000n ? "   <<< OVER the 3,000,000 GAS_BOUNDS ceiling" : ""}`);
}
const over = rows.filter((r) => r.ver + r.call + r.pre > 3000000n);
console.log(`\nof ${rows.length} decoded, ${over.length} signed MORE than 3,000,000 total while the account was ALREADY DEPLOYED`);
console.log(`largest enable-blob signature seen on an already-deployed enable: ${rows.reduce((a, r) => (r.sigBytes > a ? r.sigBytes : a), 0)} bytes`);
console.log(`unread/undecodable: ${unread.length}`);
for (const u of unread) console.log("  UNREAD", u);
