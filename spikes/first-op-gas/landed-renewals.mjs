/**
 * METHOD B, THIRD ORACLE — REAL LANDED OPS. No simulation at all.
 *
 * A landed operation beats any estimate. This finds UserOperations on chain 4663
 * whose nonce carries mode 0x01 (ENABLE) + vType 0x02 (PERMISSION) and whose
 * sender ALREADY HAD CODE at that block, then reads their ACTUAL gas used.
 *
 * Independence: the nonce is read straight out of the UserOperationEvent's data
 * field (nonce is a non-indexed parameter), so no handleOps calldata decoding and
 * no reliance on any earlier scan. "Already deployed" is established by comparing
 * against the sender's own AccountDeployed log block — eth_getLogs reads to
 * genesis on this RPC, unlike eth_getStorageAt which is not archival here.
 *
 * READ-ONLY: eth_getLogs, eth_getTransactionByHash, eth_blockNumber only.
 * Run: node spikes/first-op-gas/landed-renewals.mjs
 */
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const T_USEROP = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const T_DEPLOY = "0xd51a9c61267aa6196961883ecf5ff2da6619c37dac0fa92122513fb32c032d2d";

let unreadRanges = 0;
async function rpc(m, p, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      const j = await r.json();
      if (!j.error) return j;
      if (!/Too Many Requests|rate|timeout|exceeds limit/i.test(String(j.error.message))) return j;
      if (/exceeds limit|timed out/i.test(String(j.error.message))) return j; // caller halves
    } catch {}
    await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
  }
  return { error: { message: "exhausted retries" } };
}

async function logsChunked(from, to, topics, depth = 0) {
  const j = await rpc("eth_getLogs", [{ address: EP, topics, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
  if (!j.error) return j.result;
  if (to - from < 100n || depth > 24) { unreadRanges++; console.log(`  !! UNREAD range ${from}..${to}: ${j.error.message}`); return []; }
  const mid = from + (to - from) / 2n;
  return [...(await logsChunked(from, mid, topics, depth + 1)), ...(await logsChunked(mid + 1n, to, topics, depth + 1))];
}

const word = (data, i) => BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64));

const head = BigInt((await rpc("eth_blockNumber", [])).result);
// A recent window, chosen without reference to any earlier scan's output.
const FROM = head - 2_500_000n;
console.log(`chain 4663 head ${head} · scanning UserOperationEvent in blocks ${FROM}..${head}`);

const ops = await logsChunked(FROM, head, [T_USEROP]);
console.log(`UserOperationEvents read: ${ops.length} · unreadable sub-ranges: ${unreadRanges}`);

const enables = [];
for (const l of ops) {
  const nonce = word(l.data, 0);
  const mode = nonce >> 248n, vType = (nonce >> 240n) & 0xffn;
  if (mode !== 1n || vType !== 2n) continue;
  enables.push({
    sender: "0x" + l.topics[2].slice(26),
    block: BigInt(l.blockNumber),
    tx: l.transactionHash,
    permissionId: "0x" + ((nonce >> 128n) & ((1n << 32n) - 1n) << 0n).toString(16).padStart(8, "0"),
    success: word(l.data, 1) === 1n,
    actualGasCost: word(l.data, 2),
    actualGasUsed: word(l.data, 3),
  });
}
console.log(`permission-validator ENABLE ops in window: ${enables.length}`);

// Deploy block per sender, from that sender's own AccountDeployed log (topic2 = sender).
const senders = [...new Set(enables.map((e) => e.sender))];
console.log(`distinct senders: ${senders.length} — reading each one's AccountDeployed block`);
const deployBlock = new Map();
let unreadSenders = 0;
for (const s of senders) {
  const j = await rpc("eth_getLogs", [{ address: EP, topics: [T_DEPLOY, null, "0x" + s.slice(2).padStart(64, "0")], fromBlock: "0x0", toBlock: "0x" + head.toString(16) }]);
  if (j.error) { unreadSenders++; deployBlock.set(s, null); continue; }
  deployBlock.set(s, j.result.length ? BigInt(j.result[0].blockNumber) : undefined);
}
console.log(`senders whose deploy block was UNREAD: ${unreadSenders} (not counted either way)`);

const renewals = enables.filter((e) => {
  const d = deployBlock.get(e.sender);
  return d !== null && d !== undefined && e.block > d;
});
const firstOps = enables.filter((e) => {
  const d = deployBlock.get(e.sender);
  return d !== null && d !== undefined && e.block === d;
});
console.log(`\nENABLE ops on an ALREADY-DEPLOYED sender (real renewals): ${renewals.length}`);
console.log(`ENABLE ops in the SAME block as the deploy (first ops):    ${firstOps.length}`);
console.log(`distinct already-deployed senders: ${new Set(renewals.map((r) => r.sender)).size}`);
console.log(`succeeded: ${renewals.filter((r) => r.success).length} / ${renewals.length}`);

renewals.sort((a, b) => Number(b.actualGasUsed - a.actualGasUsed));
const f = (n) => Number(n).toLocaleString("en-US");
console.log(`\ntop 15 already-deployed ENABLE ops by ACTUAL gas used:`);
for (const r of renewals.slice(0, 15))
  console.log(`  ${r.sender} deployed@${r.block > 0n ? deployBlock.get(r.sender) : "?"} enable@${r.block}  actualGasUsed ${f(r.actualGasUsed).padStart(11)}  ok=${r.success}  ${r.tx}`);

const over3M = renewals.filter((r) => r.actualGasUsed > 3_000_000n);
console.log(`\nalready-deployed enables whose ACTUAL gas used alone exceeds 3,000,000: ${over3M.length} / ${renewals.length}`);
if (renewals.length) {
  const used = renewals.map((r) => r.actualGasUsed).sort((a, b) => Number(a - b));
  console.log(`  actualGasUsed  min ${f(used[0])} · median ${f(used[Math.floor(used.length / 2)])} · max ${f(used[used.length - 1])}`);
}

// Signed limits for the biggest ones, straight from handleOps calldata.
console.log(`\nSIGNED limits for the 6 largest (decoded from the tx's own calldata):`);
for (const r of renewals.slice(0, 6)) {
  const tx = await rpc("eth_getTransactionByHash", [r.tx]);
  if (tx.error || !tx.result) { console.log(`  ${r.tx} UNREAD`); continue; }
  const d = tx.result.input.slice(10);
  // Locate this sender's op inside the PackedUserOperation[] by its sender word.
  const target = r.sender.slice(2).padStart(64, "0");
  let at = -1;
  for (let i = 0; i + 64 <= d.length; i += 64) if (d.slice(i, i + 64) === target) { at = i; break; }
  if (at < 0) { console.log(`  ${r.tx} sender word not found in calldata — UNDECODED, not absent`); continue; }
  const W = (k) => BigInt("0x" + d.slice(at + k * 64, at + (k + 1) * 64));
  const initCodeOff = W(2); // relative offset within the struct
  const agl = d.slice(at + 4 * 64, at + 5 * 64); // accountGasLimits: verif(16B) || call(16B)
  const verif = BigInt("0x" + agl.slice(0, 32)), call = BigInt("0x" + agl.slice(32));
  const preV = W(5);
  console.log(`  ${r.tx}`);
  console.log(`     sender ${r.sender} · signed verif ${f(verif)} · call ${f(call)} · preVerif ${f(preV)} · TOTAL ${f(verif + call + preV)} · actual used ${f(r.actualGasUsed)} · initCodeOff ${initCodeOff}`);
}
console.log(`\nunreadable log sub-ranges overall: ${unreadRanges} (each is UNREAD, not empty)`);
