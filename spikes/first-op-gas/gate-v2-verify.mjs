/**
 * TWO CLAIMS THE GATE RESTS ON, CHECKED WITHOUT THE SDK.
 *
 * READ-ONLY: eth_call only (EntryPoint.getNonce and Kernel.permissionConfig).
 *
 * CLAIM 1 (C2's premise). After a permission enable LANDS, the EntryPoint's
 *   counter for that ENABLE key is 1 and never 0 again, while the DEFAULT key
 *   for the same permission id carries the ordinary traffic. If that holds,
 *   `sequence == 0` is a genuine once-per-inclusion bound and refuses only
 *   operations that would revert.
 *
 * CLAIM 2 (C4's premise). permissionConfig(pId) read straight off the account
 *   distinguishes installed from not-installed per (account, permissionId), and
 *   a codeless account answers with empty returndata rather than with zeros —
 *   which is why "no code" must be a separate branch and not a parse result.
 */
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const LIVE_WITH_PERM = "0xa48cE91e2F3237E69660C1543042c007B8D33e75";
const MERRYMEN = "0x032Da6A0Ccf866474e45854E7fDEF9afd1509036";
const INSTALLED_PID = "3ca1cec8";
const NEVER_PID = "deadbeef";
/** An address with no code, so the codeless branch is exercised on a real read. */
const CODELESS = "0x00000000000000000000000000000000000c0de5";

async function call(to, data) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    }).then((x) => x.json()).catch((e) => ({ error: { message: String(e) } }));
    if (r.error && /too many requests/i.test(r.error.message ?? "") && i < 3) {
      await new Promise((s) => setTimeout(s, 800 * 2 ** i)); continue;
    }
    return r;
  }
}
async function getCode(a) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [a, "latest"] }),
  }).then((x) => x.json());
  return r.result;
}

/** EntryPoint.getNonce(address sender, uint192 key) -> uint256 */
async function nonceFor(sender, key24Hex) {
  const data = "0x35567e1a" + sender.slice(2).toLowerCase().padStart(64, "0") + key24Hex.padStart(64, "0");
  const r = await call(EP, data);
  if (typeof r.result !== "string") return { seq: null, err: r.error?.message ?? "unread" };
  return { seq: BigInt(r.result) & 0xffff_ffff_ffff_ffffn, raw: r.result };
}

/** mode ‖ vType ‖ pId left-aligned in 20 bytes ‖ 2-byte nonce key = 24 bytes = uint192 */
const keyFor = (mode, vType, pid) => mode + vType + pid.padEnd(40, "0") + "0000";

async function permissionConfig(account, pid) {
  const r = await call(account, "0xc3e58978" + pid.padEnd(64, "0"));
  if (typeof r.result !== "string") return { state: "UNREAD", err: r.error?.message };
  if (r.result === "0x") return { state: "EMPTY RETURNDATA" };
  if (r.result.length < 2 + 3 * 64) return { state: `SHORT (${(r.result.length - 2) / 2} bytes)` };
  const signer = "0x" + r.result.slice(2 + 128 + 24, 2 + 192);
  const flag = "0x" + r.result.slice(2 + 64, 2 + 68); // bytes2 is LEFT-aligned in its word
  return { state: signer === "0x0000000000000000000000000000000000000000" ? "not installed" : "INSTALLED", signer, flag };
}

console.log("══ CLAIM 1 — the EntryPoint's own counters, read directly (no SDK) ══");
console.log(`  account ${LIVE_WITH_PERM}, permission id 0x${INSTALLED_PID} (its enable landed at block 51,847,124)`);
for (const [label, key] of [
  ["ENABLE  key (mode 0x01, vType 0x02)", keyFor("01", "02", INSTALLED_PID)],
  ["DEFAULT key (mode 0x00, vType 0x02)", keyFor("00", "02", INSTALLED_PID)],
]) {
  const n = await nonceFor(LIVE_WITH_PERM, key);
  console.log(`    ${label}  key 0x${key}`);
  console.log(`      -> sequence ${n.seq === null ? `UNREAD (${n.err})` : n.seq}`);
}
console.log(`  and a permission id that has NEVER been used on that account, as a control:`);
{
  const n = await nonceFor(LIVE_WITH_PERM, keyFor("01", "02", NEVER_PID));
  console.log(`    ENABLE key for 0x${NEVER_PID} -> sequence ${n.seq === null ? "UNREAD" : n.seq}`);
}
console.log(`  merrymen's own account, which has executed exactly one op ever (a sudo deploy):`);
{
  const sudo = await nonceFor(MERRYMEN, "0000845adb2c711129d4f3966735ed98a9f09fc4ce570000");
  const enable = await nonceFor(MERRYMEN, keyFor("01", "02", "12345678"));
  console.log(`    SUDO/DEFAULT key -> sequence ${sudo.seq === null ? "UNREAD" : sudo.seq}   (1 = the deploy landed)`);
  console.log(`    a never-used ENABLE key -> sequence ${enable.seq === null ? "UNREAD" : enable.seq}`);
}
console.log(`
  READING: an enable that LANDED leaves its enable key at 1 and moves the traffic
  to the default key. An enable that never landed leaves its key at 0. So C2's
  "sequence must be 0" refuses exactly the enable-shaped operations whose id has
  already been installed — operations that revert AA23 0xc48cf8ee if sent.
`);

console.log("══ CLAIM 2 — permissionConfig is per-(account, permissionId), and codeless is its own case ══");
for (const [acct, pid, note] of [
  [LIVE_WITH_PERM, INSTALLED_PID, "the id this account really installed"],
  [LIVE_WITH_PERM, NEVER_PID, "control: an id it never installed"],
  [MERRYMEN, INSTALLED_PID, "control: the SAME id, on a different live account"],
  [CODELESS, INSTALLED_PID, "control: an address with no code"],
]) {
  const code = await getCode(acct);
  const c = await permissionConfig(acct, pid);
  console.log(`  ${acct}  0x${pid}`);
  console.log(`    code ${code === undefined ? "UNREAD" : code === "0x" ? "NONE" : `${(code.length - 2) / 2} bytes`} · ${c.state}${c.signer ? ` signer ${c.signer} flag ${c.flag}` : ""}   (${note})`);
}
console.log(`
  READING: the same permission id reads INSTALLED on one live account and
  "not installed" on another, so the read is genuinely keyed by the pair. And a
  codeless address answers with EMPTY RETURNDATA, not with a zero signer — which
  is why permissionIdInstalled() must branch on getCode first: parsing that reply
  as "not installed" is correct only because the account cannot hold anything,
  and treating an unparseable reply from a CODED account the same way would hand
  the elevated ceiling to any truncated response.
`);
