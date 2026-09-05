/**
 * READ-ONLY. Scan EntryPoint 0.7 AccountDeployed logs on chain 4663.
 * Chunks the range, halves on failure, and NEVER silently skips: every range
 * that could not be read is recorded and printed at the end.
 */
import fs from "node:fs";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const ACCOUNT_DEPLOYED = "0xd51a9c61267aa6196961883ecf5ff2da6619c37dac0fa92122513fb32c032d2d";

let calls = 0;
async function rpc(method, params) {
  calls++;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }),
      });
      const j = await r.json();
      return j;
    } catch (e) {
      if (attempt === 3) return { error: { message: `network: ${String(e)}` } };
      await new Promise((s) => setTimeout(s, 500 * (attempt + 1)));
    }
  }
}

const hex = (n) => "0x" + n.toString(16);

const found = [];
const unread = [];

async function getLogs(from, to, depth = 0) {
  const res = await rpc("eth_getLogs", [
    { address: EP, topics: [ACCOUNT_DEPLOYED], fromBlock: hex(from), toBlock: hex(to) },
  ]);
  if (res.result) {
    for (const l of res.result) found.push(l);
    return true;
  }
  const msg = res.error?.message ?? "unknown";
  if (to - from <= 1n) {
    unread.push({ from: from.toString(), to: to.toString(), msg });
    return false;
  }
  if (depth > 24) {
    unread.push({ from: from.toString(), to: to.toString(), msg: `${msg} (depth cap)` });
    return false;
  }
  const mid = from + (to - from) / 2n;
  const a = await getLogs(from, mid, depth + 1);
  const b = await getLogs(mid + 1n, to, depth + 1);
  return a && b;
}

const head = BigInt((await rpc("eth_blockNumber", [])).result);
const START = BigInt(process.env.SCAN_FROM ?? "0");
const CHUNK = BigInt(process.env.SCAN_CHUNK ?? "250000");
console.log(`head=${head} scanning ${START}..${head} in chunks of ${CHUNK}`);

let cursor = START;
let done = 0;
while (cursor <= head) {
  const to = cursor + CHUNK - 1n > head ? head : cursor + CHUNK - 1n;
  await getLogs(cursor, to);
  done++;
  if (done % 20 === 0) console.log(`  ...at block ${to} (${found.length} AccountDeployed so far, ${unread.length} unreadable ranges, ${calls} rpc calls)`);
  cursor = to + 1n;
}

found.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)));
console.log(`\nTOTAL AccountDeployed: ${found.length}`);
console.log(`UNREADABLE RANGES: ${unread.length}`);
for (const u of unread) console.log(`  UNREAD ${u.from}..${u.to}: ${u.msg}`);

const rows = found.map((l) => ({
  block: Number(BigInt(l.blockNumber)),
  sender: "0x" + l.topics[2].slice(26),
  userOpHash: l.topics[1],
  factory: "0x" + l.data.slice(2 + 24, 2 + 64),
  paymaster: "0x" + l.data.slice(2 + 64 + 24, 2 + 128),
  tx: l.transactionHash,
}));
fs.writeFileSync(process.env.OUT ?? "scan-accounts.json", JSON.stringify({ head: head.toString(), start: START.toString(), rows, unread }, null, 2));
for (const r of rows.slice(0, 60)) console.log(`  block ${r.block}  sender ${r.sender}  factory ${r.factory}  tx ${r.tx}`);
console.log(`\nwrote ${process.env.OUT ?? "scan-accounts.json"} (${rows.length} rows)`);
