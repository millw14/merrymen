/**
 * A fake Robinhood Chain JSON-RPC endpoint for billing tests: a real HTTP
 * server, so the payments code runs through a real viem client and its
 * formatters, and nothing ever reaches a real chain.
 *
 * Not a test itself (the gateway's glob is *.test.mjs). It answers the four
 * methods payment verification uses: eth_chainId, eth_blockNumber,
 * eth_getBlockByNumber and eth_getTransactionReceipt. Hashes are looked up
 * case-insensitively, as a node does.
 */
import { createServer } from "node:http";
import { TOKEN } from "./billing-plans.mjs";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const word = (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
const topic = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;

/** One ERC-20 Transfer log as a node returns it. `address` defaults to the token, checksum-cased to prove case does not matter. */
export function transferLog({ from, to, value, address = "0xA15CD06DD305269A0F48BEBEB30AA3588FBA7B32", logIndex = 0, topics, data, removed = false }) {
  return { address, topics: topics ?? [TRANSFER_TOPIC, topic(from), topic(to)], data: data ?? word(value), logIndex: hex(logIndex), removed };
}

export async function startFakeChain({ chainId = TOKEN.chainId, head = 5_000, time = Math.floor(Date.now() / 1000) } = {}) {
  const blocks = new Map(); // number -> { hash, timestamp }
  const receipts = new Map(); // lowercased tx hash -> receipt (without block fields)
  let seq = 1;
  const chain = {
    chainId,
    head: BigInt(head),
    /** Seconds; new blocks are stamped with it. */
    time,
    calls: [],
    /** When set, every call answers this JSON-RPC error (an RPC outage). */
    down: false,
    /** Milliseconds to wait before answering, to exercise timeouts. */
    delayMs: 0,
    block(n) {
      const k = Number(n);
      if (!blocks.has(k)) blocks.set(k, { hash: word(0xb10c000000n + BigInt(k) * 1000n + BigInt(seq++)), timestamp: chain.time });
      return blocks.get(k);
    },
    /** Include a transaction at `blockNumber` (default: the head). Returns its hash. */
    mine({ hash = word(0x7000000n + BigInt(seq++)), logs = [], status = "0x1", blockNumber = chain.head, from } = {}) {
      chain.block(blockNumber);
      receipts.set(hash.toLowerCase(), { hash: hash.toLowerCase(), logs, status, blockNumber: Number(blockNumber), from });
      if (BigInt(blockNumber) > chain.head) chain.head = BigInt(blockNumber);
      return hash.toLowerCase();
    },
    advance(blocksAhead = 1, seconds = 0) { chain.head += BigInt(blocksAhead); chain.time += seconds; },
    /** The block at `n` is replaced: same height, new hash. Receipts in it keep pointing at the old one unless moved. */
    reorgBlock(n) { blocks.set(Number(n), { hash: word(0xdead000000n + BigInt(seq++)), timestamp: chain.time }); },
    /** The transaction is re-included at another height (a new block, new log positions). */
    move(hash, blockNumber) {
      const r = receipts.get(hash.toLowerCase());
      chain.reorgBlock(r.blockNumber);
      r.blockNumber = Number(blockNumber);
      chain.block(blockNumber);
      if (BigInt(blockNumber) > chain.head) chain.head = BigInt(blockNumber);
    },
    drop(hash) { const r = receipts.get(hash.toLowerCase()); receipts.delete(hash.toLowerCase()); if (r) chain.reorgBlock(r.blockNumber); },
    /** The receipt keeps reporting the block hash it has now, whatever later happens at that height. */
    pin(hash) { const r = receipts.get(hash.toLowerCase()); r.pinnedBlockHash = chain.block(r.blockNumber).hash; },
  };

  function receiptJson(r) {
    const b = chain.block(r.blockNumber);
    const blockHash = r.pinnedBlockHash ?? b.hash;
    return {
      transactionHash: r.hash, transactionIndex: "0x0", blockHash, blockNumber: hex(r.blockNumber),
      from: r.from ?? `0x${"11".repeat(20)}`, to: TOKEN.address, cumulativeGasUsed: "0x5208", gasUsed: "0x5208",
      effectiveGasPrice: "0x1", contractAddress: null, logsBloom: `0x${"0".repeat(512)}`, status: r.status, type: "0x2",
      logs: r.logs.map((l) => ({ ...l, blockHash, blockNumber: hex(r.blockNumber), transactionHash: r.hash, transactionIndex: "0x0" })),
    };
  }

  function answer(method, params) {
    if (method === "eth_chainId") return hex(chain.chainId);
    if (method === "eth_blockNumber") return hex(chain.head);
    if (method === "eth_getBlockByNumber") {
      const n = Number(BigInt(params[0]));
      if (BigInt(n) > chain.head) return null;
      const b = chain.block(n);
      return { number: hex(n), hash: b.hash, parentHash: word(n - 1), timestamp: hex(b.timestamp), gasLimit: "0x1c9c380",
        gasUsed: "0x0", miner: `0x${"00".repeat(20)}`, extraData: "0x", nonce: "0x0000000000000000", transactions: [], uncles: [] };
    }
    if (method === "eth_getTransactionReceipt") {
      const r = receipts.get(String(params[0]).toLowerCase());
      return r ? receiptJson(r) : null;
    }
    throw Object.assign(new Error(`method ${method} not faked`), { code: -32601 });
  }

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      if (chain.delayMs) await new Promise((r) => setTimeout(r, chain.delayMs));
      let payload;
      try { payload = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      const one = (call) => {
        chain.calls.push(call.method);
        if (chain.down) return { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "upstream exploded at https://rpc.example/SECRET-KEY" } };
        try { return { jsonrpc: "2.0", id: call.id, result: answer(call.method, call.params ?? []) }; } catch (err) {
          return { jsonrpc: "2.0", id: call.id, error: { code: err.code ?? -32000, message: err.message } };
        }
      };
      const out = Array.isArray(payload) ? payload.map(one) : one(payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, chain, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}
