/**
 * Three facts the new ceiling gate rests on, checked directly rather than taken
 * on report. Plain RPC only — no SDK, no bundler, no key, nothing signed.
 *
 *   1. The permission id really is bytes 2..5 of the nonce, i.e. (n >> 208) & 0xffffffff.
 *   2. permissionConfig(pId) on the ACCOUNT distinguishes installed from absent,
 *      and answers EMPTY (not zero) for an address with no code.
 *   3. The EntryPoint's sequence for a landed enable key is 1, and 0 for one that
 *      never landed — so "sequence == 0" really does mean "never included".
 *
 * Run: node spikes/first-op-gas/verify-gate-facts.mjs
 */
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const ENTRYPOINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

let id = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const j = await r.json();
  if (j.error) return { error: j.error.message ?? JSON.stringify(j.error) };
  return { result: j.result };
}

const hex = (n, bytes) => n.toString(16).padStart(bytes * 2, "0");

/** key = mode(1) ‖ vType(1) ‖ identifier(20) ‖ nonceKey(2) — 24 bytes, uint192. */
function nonceKey(mode, vType, identifier20) {
  return BigInt(`0x${hex(mode, 1)}${hex(vType, 1)}${identifier20.replace(/^0x/, "")}0000`);
}

async function getNonce(sender, key) {
  // getNonce(address,uint192) -> 0x35567e1a
  const data = `0x35567e1a${sender.replace(/^0x/, "").toLowerCase().padStart(64, "0")}${hex(key, 32)}`;
  const { result, error } = await rpc("eth_call", [{ to: ENTRYPOINT, data }, "latest"]);
  return error ? { error } : { nonce: BigInt(result) };
}

async function permissionConfig(account, pId4) {
  // permissionConfig(bytes4) -> 0xc3e58978, bytes4 is LEFT-aligned in its word
  const data = `0xc3e58978${pId4.replace(/^0x/, "")}${"0".repeat(56)}`;
  const { result, error } = await rpc("eth_call", [{ to: account, data }, "latest"]);
  return error ? { error } : { raw: result };
}

const ACCOUNTS = {
  // merrymen's own live account: one UserOperation ever, a sudo deploy.
  merrymen: "0x032Da6A0Ccf866474e45854E7fDEF9afd1509036",
  // A live Kernel v3.3 account whose permission validator DID land.
  walled: "0xa48cE91e2F3237E69660C1543042c007B8D33e75",
  // No code at all.
  codeless: "0x000000000000000000000000000000000000c0de",
};
const LANDED_PID = "0x3ca1cec8"; // reported as installed on `walled`
const NEVER_PID = "0xdeadbeef";

async function main() {
  console.log("FACT 2 — permissionConfig(pId) is keyed by (account, permissionId)\n");
  for (const [who, addr] of Object.entries(ACCOUNTS)) {
    const { result: code } = await rpc("eth_getCode", [addr, "latest"]);
    for (const pid of [LANDED_PID, NEVER_PID]) {
      const r = await permissionConfig(addr, pid);
      const raw = r.raw ?? `ERROR ${r.error}`;
      // Struct is dynamic: word0 = offset, word1 = flag, word2 = signer.
      let read = "empty returndata";
      if (typeof raw === "string" && raw.length >= 2 + 64 * 3) {
        const flag = "0x" + raw.slice(2 + 64, 2 + 64 + 64).slice(0, 8);
        const signer = "0x" + raw.slice(2 + 128 + 24, 2 + 192);
        read =
          BigInt("0x" + raw.slice(2 + 128, 2 + 192)) === 0n
            ? "NOT installed (signer 0x0)"
            : `INSTALLED flag ${flag} signer ${signer}`;
      } else if (raw.startsWith("ERROR")) {
        read = raw;
      }
      console.log(
        `  ${who.padEnd(9)} code ${String((code ?? "0x").length / 2 - 1).padStart(3)}B · ${pid} -> ${read}`,
      );
    }
  }

  console.log("\nFACT 1 — the permission id is bytes 2..5 of the nonce\n");
  // Build the ENABLE key for a known pId and read the nonce back; then extract
  // the id from that nonce with the shift the gate will use and require a match.
  const ident = LANDED_PID.replace(/^0x/, "") + "0".repeat(32); // pId(4) + 16 zero bytes
  const key = nonceKey(0x01, 0x02, ident);
  const { nonce, error } = await getNonce(ACCOUNTS.walled, key);
  if (error) {
    console.log(`  COULD NOT READ: ${error}`);
  } else {
    const extracted = "0x" + (((nonce >> 208n) & 0xffffffffn).toString(16).padStart(8, "0"));
    const wrong = "0x" + (((nonce >> 224n) & 0xffffffffn).toString(16).padStart(8, "0"));
    console.log(`  nonce            0x${hex(nonce, 32)}`);
    console.log(`  >> 208 (correct) ${extracted}   ${extracted === LANDED_PID ? "MATCHES" : "MISMATCH"}`);
    console.log(`  >> 224 (the trap) ${wrong}   <- mode+vType glued to the id`);
    console.log(`  mode ${"0x" + hex((nonce >> 248n) & 0xffn, 1)} · vType ${"0x" + hex((nonce >> 240n) & 0xffn, 1)}`);
  }

  console.log("\nFACT 3 — sequence 0 means the enable was never included\n");
  const cases = [
    ["walled  · landed enable key", ACCOUNTS.walled, 0x01, 0x02, LANDED_PID],
    ["walled  · default key      ", ACCOUNTS.walled, 0x00, 0x02, LANDED_PID],
    ["walled  · never-used id    ", ACCOUNTS.walled, 0x01, 0x02, NEVER_PID],
    ["merrymen· same id, never   ", ACCOUNTS.merrymen, 0x01, 0x02, LANDED_PID],
  ];
  for (const [label, addr, mode, vType, pid] of cases) {
    const k = nonceKey(mode, vType, pid.replace(/^0x/, "") + "0".repeat(32));
    const { nonce: n, error: e } = await getNonce(addr, k);
    console.log(`  ${label} -> ${e ? `COULD NOT READ: ${e}` : `sequence ${n & 0xffffffffffffffffn}`}`);
  }
}

main().catch((e) => {
  console.error(String(e).slice(0, 400));
  process.exit(1);
});
