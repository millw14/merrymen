/** READ-ONLY. Targeted impl+owner read for a list of accounts. */
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const VAL  = "0x7bcaa2ced2a71450ed5a9a1b4848e8e5206dbc3f06011e595f7f55428cc6f84f";
const KNOWN = {
  "0xd6cedde84be40893d153be9d467cd6ad37875b28": "kernel v3.3",
  "0xd830d15d3dc0c269f3dbaa0f3e8626d33cfdabe1": "kernel v3.2",
  "0xbac849bb641841b44e965fb01a4bf5f074f84b4d": "kernel v3.1",
  "0x94f097e1ebeb4eca3aae54cabb08905b239a7d27": "kernel v3.0",
};
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
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
import fs from "node:fs";
const db = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const list = db.rows.filter((r) => (r.factory === "0xd703aae79538628d27099b8c4f621be4ccd142d5" || r.factory === "0x2577507b78c2008ff367261cb6285d44ba5ef2e9") && r.block > Number(process.env.FROM ?? 50000000));
console.log(`targeted: ${list.length} accounts (block > ${process.env.FROM ?? 50000000})`);
const unread = [];
const rows = [];
for (let i = 0; i < list.length; i += 10) {
  const s = list.slice(i, i + 10);
  const reqs = [];
  for (const t of s) {
    reqs.push({ jsonrpc: "2.0", id: ++id, method: "eth_getStorageAt", params: [t.sender, IMPL, "latest"] });
    reqs.push({ jsonrpc: "2.0", id: ++id, method: "eth_getStorageAt", params: [t.sender, VAL, "latest"] });
    reqs.push({ jsonrpc: "2.0", id: ++id, method: "eth_getBalance", params: [t.sender, "latest"] });
    reqs.push({ jsonrpc: "2.0", id: ++id, method: "eth_call", params: [{ to: EP, data: "0x35567e1a" + t.sender.slice(2).padStart(64, "0") + "0".repeat(64) }, "latest"] }); // getNonce(sender,key=0)
  }
  const res = await batch(reqs);
  if (!res) { for (const t of s) unread.push(t.sender); process.stdout.write("X"); continue; }
  const m = new Map(res.map((x) => [x.id, x]));
  for (let k = 0; k < s.length; k++) {
    const t = s[k];
    const a = m.get(reqs[k * 4].id), b = m.get(reqs[k * 4 + 1].id), c = m.get(reqs[k * 4 + 2].id), d = m.get(reqs[k * 4 + 3].id);
    if (!a?.result) { unread.push(t.sender); continue; }
    const impl = "0x" + a.result.slice(26);
    rows.push({
      ...t, impl, kernel: KNOWN[impl] ?? "unknown",
      valSlot: b?.result ?? null,
      rootValidator: b?.result && b.result !== "0x" + "0".repeat(64) ? "0x" + b.result.slice(24) : null,
      balanceWei: c?.result ? BigInt(c.result).toString() : "unread",
      nonceKey0: d?.result ? BigInt(d.result).toString() : "unread",
    });
  }
  process.stdout.write(".");
  await new Promise((s) => setTimeout(s, 300));
}
console.log("");
const v33 = rows.filter((r) => r.kernel === "kernel v3.3");
console.log(`KERNEL v3.3 among these: ${v33.length}`);
for (const r of v33) console.log(`  ${r.sender} block ${r.block} rootValidator ${r.rootValidator} bal ${r.balanceWei} wei  nonce(key=0) ${r.nonceKey0}  tx ${r.tx}`);
const byK = {}; for (const r of rows) byK[r.kernel] = (byK[r.kernel] ?? 0) + 1;
console.log("kernel mix:", byK, "unread:", unread.length, unread);
fs.writeFileSync("v33-find.json", JSON.stringify({ rows, unread }, null, 2));
