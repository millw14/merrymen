/**
 * CAN WE RECONCILE BY userOpHash INSTEAD OF BY SENDER?
 *
 * `UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, ...)`
 * indexes the hash in topic1 and the sender in topic2. The shared-sweep work
 * already proved this provider honours an OR-list in topic2. If it honours one
 * in topic1 too, then an agent that KNOWS its outstanding hashes can ask a
 * question that matches at most one event per hash — instead of scanning every
 * operation a sender ever made.
 *
 * WHAT THIS MEASURES: request count, response size, latency, behaviour with many
 * hashes, the practical maximum OR-list size, and correctness against the
 * EntryPoint actually deployed on 4663.
 *
 * READ-ONLY. eth_getLogs and eth_blockNumber only. Nothing signed, nothing sent,
 * no funds moved. Hard request budget, enforced by throwing.
 *
 * Run: node spikes/stage-b/hash-topic.mjs
 */
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const ENTRYPOINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const TOPIC0 = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";

const BUDGET = 120;
let spent = 0;
let bytes = 0;

async function rpc(method, params) {
  if (++spent > BUDGET) throw new Error(`request budget of ${BUDGET} exhausted`);
  const t0 = Date.now();
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: spent, method, params }),
  });
  const text = await r.text();
  bytes += text.length;
  const ms = Date.now() - t0;
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { error: `unparseable body (${r.status})`, ms, size: text.length };
  }
  if (j.error) return { error: j.error.message ?? JSON.stringify(j.error), ms, size: text.length, status: r.status };
  return { result: j.result, ms, size: text.length, status: r.status };
}

const getLogs = (from, to, topics) =>
  rpc("eth_getLogs", [
    { address: ENTRYPOINT, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics },
  ]);

async function main() {
  const head = BigInt((await rpc("eth_blockNumber", [])).result);
  console.log(`head ${head}\n`);

  // ── 0. Harvest real hashes, so every later query is against genuine events ──
  const WINDOW = 3000n;
  const from = head - WINDOW;
  const seed = await getLogs(from, head, [TOPIC0]);
  if (seed.error) {
    console.log(`COULD NOT SEED: ${seed.error} — everything below is unmeasured, not negative.`);
    return;
  }
  const logs = seed.result;
  console.log(
    `(0) SEED — all UserOperationEvent over ${WINDOW} blocks: ${logs.length} logs · ` +
      `${seed.ms}ms · ${(seed.size / 1024).toFixed(1)} KiB`,
  );
  const hashes = [...new Set(logs.map((l) => l.topics[1]))];
  const senders = [...new Set(logs.map((l) => "0x" + l.topics[2].slice(26)))];
  console.log(`    ${hashes.length} distinct userOpHash · ${senders.length} distinct sender\n`);
  if (hashes.length < 8) {
    console.log("too few events in this window to sweep — widen WINDOW and re-run.");
    return;
  }

  // ── 1. Correctness: does topic1 filtering work at all, and exactly? ─────────
  const one = hashes[0];
  const single = await getLogs(from, head, [TOPIC0, one]);
  const expectSingle = logs.filter((l) => l.topics[1] === one);
  console.log(
    `(1) SINGLE HASH in topic1 → ${single.error ? `ERROR ${single.error}` : `${single.result.length} logs`} ` +
      `(expected ${expectSingle.length}) · ${single.ms}ms · ${single.size} B` +
      `${!single.error && single.result.length === expectSingle.length ? "  ✓ EXACT" : "  ✗"}`,
  );

  // A hash that exists nowhere must return nothing, not everything — the failure
  // mode that would silently make this filter a no-op.
  const bogus = "0x" + "de".repeat(32);
  const none = await getLogs(from, head, [TOPIC0, bogus]);
  console.log(
    `    CONTROL, hash that does not exist → ${none.error ? `ERROR ${none.error}` : `${none.result.length} logs`}` +
      `${!none.error && none.result.length === 0 ? "  ✓ filter is real" : "  ✗ FILTER IGNORED"}\n`,
  );

  // ── 2. Does it honour an OR-LIST in topic1? ────────────────────────────────
  const three = hashes.slice(0, 3);
  const orList = await getLogs(from, head, [TOPIC0, three]);
  const expectOr = logs.filter((l) => three.includes(l.topics[1]));
  console.log(
    `(2) OR-LIST of 3 hashes → ${orList.error ? `ERROR ${orList.error}` : `${orList.result.length} logs`} ` +
      `(union of singles = ${expectOr.length}) · ${orList.ms}ms · ${orList.size} B` +
      `${!orList.error && orList.result.length === expectOr.length ? "  ✓ UNION EXACT" : "  ✗"}`,
  );

  // Order must not matter — the canonicalisation rule depends on it.
  const reversed = await getLogs(from, head, [TOPIC0, [...three].reverse()]);
  console.log(
    `    SAME LIST REVERSED → ${reversed.error ? `ERROR ${reversed.error}` : `${reversed.result.length} logs`}` +
      `${!reversed.error && !orList.error && reversed.result.length === orList.result.length ? "  ✓ order-insensitive" : "  ✗"}\n`,
  );

  // ── 3. How large can the OR-list be, in practice? ─────────────────────────
  console.log("(3) OR-LIST SIZE SWEEP — stops at the first refusal");
  const synthetic = (n) =>
    Array.from({ length: n }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0"));
  let maxOk = 0;
  for (const n of [1, 8, 32, 128, 512, 1024, 2048]) {
    // Real hashes first, padded with synthetic ones so the list is the right
    // SIZE without needing thousands of real events.
    const list = [...hashes.slice(0, Math.min(n, hashes.length))];
    while (list.length < n) list.push(synthetic(n)[list.length]);
    const r = await getLogs(from, head, [TOPIC0, list.slice(0, n)]);
    const got = r.error ? `ERROR ${String(r.error).slice(0, 70)}` : `${r.result.length} logs, ${r.size} B`;
    console.log(`    ${String(n).padStart(4)} hashes → ${got} · ${r.ms}ms`);
    if (r.error) break;
    maxOk = n;
  }
  console.log(`    largest accepted OR-list tested: ${maxOk}\n`);

  // ── 4. Hash-mode vs sender-mode over the SAME range, side by side ─────────
  const s = senders.slice(0, 11).map((a) => "0x" + a.slice(2).padStart(64, "0"));
  const bySender = await getLogs(from, head, [TOPIC0, null, s]);
  const theirHashes = [
    ...new Set(logs.filter((l) => s.includes("0x" + l.topics[2].slice(26).padStart(64, "0"))).map((l) => l.topics[1])),
  ];
  const byHash = await getLogs(from, head, [TOPIC0, theirHashes.slice(0, 128)]);
  console.log("(4) SAME RANGE, TWO QUESTIONS — 11 senders");
  console.log(
    `    by SENDER (11-address OR-list) → ${bySender.error ? bySender.error : `${bySender.result.length} logs`} · ` +
      `${bySender.ms}ms · ${(bySender.size / 1024).toFixed(1)} KiB`,
  );
  console.log(
    `    by HASH   (${Math.min(theirHashes.length, 128)}-hash OR-list) → ${byHash.error ? byHash.error : `${byHash.result.length} logs`} · ` +
      `${byHash.ms}ms · ${(byHash.size / 1024).toFixed(1)} KiB`,
  );
  console.log(
    `    NOTE: by-hash is bounded by what we are LOOKING FOR; by-sender is bounded\n` +
      `    by what the senders DID. That is the whole difference — an agent with two\n` +
      `    outstanding ops asks for two hashes however busy its account has been.\n`,
  );

  console.log(`budget: ${spent}/${BUDGET} requests · ${(bytes / 1024).toFixed(1)} KiB received`);
}

main().catch((e) => {
  console.error(String(e).slice(0, 300));
  process.exit(1);
});
