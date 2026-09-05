/** READ-ONLY. Sample non-ZeroDev factories to check none of them also deploys a Kernel v3.x. */
import fs from "node:fs";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
async function rpc(m, p) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      const j = await r.json();
      if (!j.error) return j;
    } catch {}
    await new Promise((s) => setTimeout(s, 1000 * (i + 1)));
  }
  return { error: { message: "exhausted retries" } };
}
const db = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const byF = {};
for (const r of db.rows) (byF[r.factory] ??= []).push(r);
for (const [f, rows] of Object.entries(byF).sort((a, b) => b[1].length - a[1].length)) {
  if (f === "0xd703aae79538628d27099b8c4f621be4ccd142d5" || f === "0x2577507b78c2008ff367261cb6285d44ba5ef2e9") continue;
  const picks = [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]].filter(Boolean);
  const seen = [];
  for (const p of picks) {
    const s = await rpc("eth_getStorageAt", [p.sender, IMPL, "latest"]);
    const a = await rpc("eth_call", [{ to: p.sender, data: "0x9cfd7cff" }, "latest"]); // accountId()
    let aid = "";
    try { if (a.result && a.result.length > 130) { const len = parseInt(a.result.slice(66, 130), 16); aid = Buffer.from(a.result.slice(130, 130 + len * 2), "hex").toString(); } } catch {}
    seen.push(`${p.sender.slice(0, 10)} impl ${s.result ? "0x" + s.result.slice(26) : "UNREAD"} accountId="${aid}"`);
  }
  console.log(`factory ${f}  (${rows.length} accounts)`);
  for (const s of seen) console.log(`    ${s}`);
}
