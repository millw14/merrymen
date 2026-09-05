/** READ-ONLY. Read the ERC-1967 impl slot for every ZeroDev-factory account. */
import fs from "node:fs";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const VAL_SLOT = "0x7bcaa2ced2a71450ed5a9a1b4848e8e5206dbc3f06011e595f7f55428cc6f84f";
const KNOWN = {
  "0xd6cedde84be40893d153be9d467cd6ad37875b28": "kernel v3.3",
  "0xd830d15d3dc0c269f3dbaa0f3e8626d33cfdabe1": "kernel v3.2",
  "0xbac849bb641841b44e965fb01a4bf5f074f84b4d": "kernel v3.1",
  "0x94f097e1ebeb4eca3aae54cabb08905b239a7d27": "kernel v3.0",
};
let id = 0;
async function batch(reqs) {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reqs) });
      const j = await r.json();
      if (Array.isArray(j)) return j;
      if (j?.error && /Too Many Requests|timed out/i.test(j.error.message ?? "")) { await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue; }
      return null;
    } catch { await new Promise((s) => setTimeout(s, 1500 * (i + 1))); }
  }
  return null;
}
const db = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const targets = db.rows.filter((r) => r.factory === "0xd703aae79538628d27099b8c4f621be4ccd142d5" || r.factory === "0x2577507b78c2008ff367261cb6285d44ba5ef2e9");
console.log(`sweeping ${targets.length} ZeroDev-factory accounts`);
const results = [];
const unread = [];
const SIZE = 20;
for (let i = 0; i < targets.length; i += SIZE) {
  const slice = targets.slice(i, i + SIZE);
  const reqs = [];
  for (const t of slice) {
    reqs.push({ jsonrpc: "2.0", id: ++id, method: "eth_getStorageAt", params: [t.sender, IMPL_SLOT, "latest"] });
    reqs.push({ jsonrpc: "2.0", id: ++id, method: "eth_getStorageAt", params: [t.sender, VAL_SLOT, "latest"] });
  }
  const res = await batch(reqs);
  if (!res) { for (const t of slice) unread.push({ sender: t.sender, msg: "batch failed after retries" }); process.stdout.write("X"); continue; }
  const byId = new Map(res.map((x) => [x.id, x]));
  for (let k = 0; k < slice.length; k++) {
    const t = slice[k];
    const a = byId.get(reqs[k * 2].id), b = byId.get(reqs[k * 2 + 1].id);
    if (!a?.result) { unread.push({ sender: t.sender, msg: JSON.stringify(a?.error ?? "missing") }); continue; }
    const impl = "0x" + a.result.slice(26);
    const vs = b?.result ?? null;
    results.push({ ...t, impl, kernel: KNOWN[impl] ?? "unknown", valSlot: vs, rootValidator: vs && vs !== "0x" + "0".repeat(64) ? "0x" + vs.slice(24) : null });
  }
  process.stdout.write(".");
  await new Promise((s) => setTimeout(s, 120));
}
console.log("");
const byKernel = {};
for (const r of results) byKernel[r.kernel] = (byKernel[r.kernel] ?? 0) + 1;
console.log("kernel versions:", byKernel);
console.log("unread:", unread.length);
for (const u of unread.slice(0, 20)) console.log("  UNREAD", u.sender, u.msg);
const v33 = results.filter((r) => r.kernel === "kernel v3.3");
console.log(`\nKERNEL v3.3 DEPLOYED ACCOUNTS: ${v33.length}`);
for (const r of v33) console.log(`  ${r.sender}  block ${r.block}  factory ${r.factory}  rootValidator ${r.rootValidator}  tx ${r.tx}`);
const vals = {};
for (const r of results) if (r.rootValidator) vals[r.rootValidator] = (vals[r.rootValidator] ?? 0) + 1;
console.log("\nroot validators across all zerodev accounts:");
Object.entries(vals).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(" ",k,v));
fs.writeFileSync("impl-sweep.json", JSON.stringify({ results, unread }, null, 2));
