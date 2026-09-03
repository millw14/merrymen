import assert from "node:assert/strict";
import test from "node:test";
import type { Hex } from "viem";
import {
  HASH_TOPIC_MAX,
  REORG_OVERLAP_SEC,
  canonicalHashes,
  canonicalSenders,
  fetchByHashes,
  fetchKey,
  fetchSharedBySender,
  planArmReconcile,
  planSharedScan,
  reorgOverlapBlocks,
  runSharedPass,
  splitByMode,
  type FetchProgressStore,
  type OutstandingOp,
} from "./reconcile-modes";
import { addressTopic, type RawLog, type ReconcileChain } from "./inflight-reconcile";

/**
 * The measured facts these tests encode, so a future edit that contradicts one
 * fails here rather than in production:
 *
 *   topic1 accepts an OR-list, order-insensitive, capped at EXACTLY 1000 per
 *   position; a shared sender scan costs the same chunk count as a single-sender
 *   one; and the hosted child ledger is ephemeral, so an empty local ledger is
 *   the COMMON case at arm rather than the exceptional one.
 */

const TOPIC0 = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f" as Hex;
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const C = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const hash = (n: number) => (`0x${n.toString(16).padStart(64, "0")}`) as Hex;

function logFor(sender: `0x${string}`, h: Hex, block = 100n): RawLog {
  return {
    topics: [TOPIC0, h, addressTopic(sender), addressTopic(A)],
    data: "0x",
    transactionHash: (`0x${"11".repeat(32)}`) as Hex,
    blockNumber: (`0x${block.toString(16)}`) as Hex,
    logIndex: "0x0",
  };
}

/** A chain that answers from a fixture and records exactly what it was asked. */
function fakeChain(logs: RawLog[], opts?: { failNth?: number; failUntil?: number; head?: bigint }) {
  const calls: { from: bigint; to: bigint; topics: (Hex | Hex[] | null)[] }[] = [];
  let n = 0;
  const chain: ReconcileChain = {
    async getBlockNumber() {
      return opts?.head ?? 1000n;
    },
    async getLogs(args) {
      n += 1;
      calls.push({ from: args.fromBlock, to: args.toBlock, topics: args.topics });
      if (opts?.failNth === n || (opts?.failUntil !== undefined && n <= opts.failUntil)) {
        throw Object.assign(new Error("Rate Limit Hit, limit will reset in 6s"), { code: -32029 });
      }
      const t1 = args.topics[1];
      const t2 = args.topics[2];
      return logs.filter((l) => {
        // RESPECT THE RANGE. A fake that returns every log for every chunk makes
        // a chunked scan look like it found each log once per chunk.
        const b = BigInt(l.blockNumber ?? "0x0");
        if (b < args.fromBlock || b > args.toBlock) return false;
        if (t1) {
          const want = Array.isArray(t1) ? t1 : [t1];
          if (!want.includes(l.topics[1] as Hex)) return false;
        }
        if (t2) {
          const want = Array.isArray(t2) ? t2 : [t2];
          if (!want.includes(l.topics[2] as Hex)) return false;
        }
        return true;
      });
    },
    async getReceiptLogs() {
      return null;
    },
  };
  return { chain, calls: () => calls, requests: () => n };
}

function memoryProgress(initial: Map<number, bigint> = new Map()): FetchProgressStore & { get(c: number): bigint | null } {
  const m = new Map(initial);
  return {
    async read(chainId) {
      return m.get(chainId) ?? null;
    },
    async commit(chainId, through) {
      m.set(chainId, through);
    },
    get: (c) => m.get(c) ?? null,
  };
}

// ── 1. zero outstanding hashes → zero steady-state eth_getLogs ──────────────

test("ZERO OUTSTANDING HASHES MEANS ZERO REQUESTS — the largest steady-state saving", async () => {
  const f = fakeChain([logFor(A, hash(1))]);
  const r = await fetchByHashes(f.chain, { hashes: [], fromBlock: 0n, toBlock: 1000n });
  assert.equal(r.requests, 0, "a fleet with nothing outstanding must ask the provider nothing");
  assert.equal(f.requests(), 0, "and the chain must not be touched at all");
  assert.deepEqual(r.logs, []);
  // Complete is TRUE, and that is correct rather than convenient: a question
  // with no subjects was answered in full.
  assert.equal(r.complete, true);
});

// ── 2. one and many known hashes ────────────────────────────────────────────

test("one known hash, and many, return exactly their own events", async () => {
  const all = [logFor(A, hash(1)), logFor(A, hash(2)), logFor(B, hash(3))];
  const f = fakeChain(all);

  const one = await fetchByHashes(f.chain, { hashes: [hash(2)], fromBlock: 0n, toBlock: 1000n });
  assert.equal(one.requests, 1);
  assert.deepEqual(one.logs.map((l) => l.topics[1]), [hash(2)]);

  const many = await fetchByHashes(f.chain, { hashes: [hash(1), hash(3)], fromBlock: 0n, toBlock: 1000n });
  assert.equal(many.requests, 1, "many hashes still cost ONE request");
  assert.deepEqual(many.logs.map((l) => l.topics[1]).sort(), [hash(1), hash(3)].sort());
});

// ── 3. 1000 hashes correctly chunked ────────────────────────────────────────

test("THE 1000 CAP IS THE MEASURED ONE, and chunking respects it exactly", async () => {
  assert.equal(HASH_TOPIC_MAX, 1000, "1001 is refused by the provider: 'exceed max topics'");
  const f = fakeChain([]);

  await fetchByHashes(f.chain, { hashes: Array.from({ length: 1000 }, (_, i) => hash(i + 1)), fromBlock: 0n, toBlock: 10n });
  assert.equal(f.requests(), 1, "exactly 1000 fits in one request");

  const f2 = fakeChain([]);
  const r = await fetchByHashes(f2.chain, {
    hashes: Array.from({ length: 2001 }, (_, i) => hash(i + 1)),
    fromBlock: 0n,
    toBlock: 10n,
  });
  assert.equal(r.requests, 3, "2001 hashes → 1000 + 1000 + 1");
  for (const c of f2.calls()) {
    const t1 = c.topics[1] as Hex[];
    assert.ok(t1.length <= HASH_TOPIC_MAX, `a batch of ${t1.length} would be refused`);
  }
});

// ── 4. reversed ordering produces the same canonical request ────────────────

test("ORDER AND CASE CANNOT PRODUCE TWO DIFFERENT FETCHES", async () => {
  const forward = [hash(3), hash(1), hash(2)];
  const reversed = [...forward].reverse();
  const uppercased = forward.map((h) => h.toUpperCase().replace("0X", "0x")) as Hex[];

  assert.deepEqual(canonicalHashes(forward), canonicalHashes(reversed));
  assert.deepEqual(canonicalHashes(forward), canonicalHashes(uppercased));
  assert.deepEqual(canonicalHashes([...forward, hash(1), hash(1)]), canonicalHashes(forward), "deduplicated");
  // The provider was MEASURED to be order-insensitive, which is what makes
  // sorting a normalisation rather than a change of question.
  assert.deepEqual(
    fetchKey(4663, 0n, 10n, canonicalHashes(forward)),
    fetchKey(4663, 0n, 10n, canonicalHashes(reversed)),
    "two equivalent sets must not generate separate shared fetches",
  );
  // And the same for senders.
  assert.deepEqual(canonicalSenders([B, A, A]), canonicalSenders([A, B]));
  assert.deepEqual(canonicalSenders([A.toUpperCase().replace("0X", "0x")]), [A]);
});

// ── 5. accepted !== userOpHash falls back to sender recovery ────────────────

test("AN UNCERTAIN HASH IDENTITY GOES TO SENDER RECOVERY, and says why", () => {
  const ops: OutstandingOp[] = [
    { identity: { kind: "known", userOpHash: hash(1) }, recoveryFromBlock: 500n },
    {
      // The one window hash mode provably cannot cover: the bundler indexed the
      // operation under a hash we never computed.
      identity: { kind: "uncertain", signedHash: hash(2), acceptedHash: hash(9), why: "bundler returned a different hash" },
      recoveryFromBlock: 400n,
    },
  ];
  const split = splitByMode(ops);
  assert.deepEqual(split.hashes, [hash(1)], "only the known hash is queryable");
  assert.equal(split.needsSenderRecovery.length, 1);

  const plan = planArmReconcile({ sender: A, localOutstanding: ops, recoveryFromBlock: 900n });
  assert.deepEqual(plan.hashes, [hash(1)]);
  assert.equal(plan.senderRequests.length, 1, "the uncertain one drives a sender scan");
  assert.equal(plan.senderRequests[0]!.fromBlock, 400n, "from ITS OWN lower bound, not the fleet's");
  assert.match(plan.reasons.join(" "), /bundler returned a different hash/, "the reason survives into the log");
});

// ── 6 & 7. one shared scan serves many tenants, partitioned correctly ───────

test("ONE SHARED FETCH SERVES MANY TENANTS, and each gets only its own events", async () => {
  const all = [logFor(A, hash(1)), logFor(B, hash(2)), logFor(A, hash(3)), logFor(C, hash(4))];
  const f = fakeChain(all);

  const r = await fetchSharedBySender(f.chain, { senders: [A, B], fromBlock: 0n, toBlock: 1000n });
  assert.equal(r.requests, 1, "one request for the cohort, not one per sender");
  assert.deepEqual(r.bySender.get(A)!.map((l) => l.topics[1]), [hash(1), hash(3)]);
  assert.deepEqual(r.bySender.get(B)!.map((l) => l.topics[1]), [hash(2)]);
  assert.equal(r.bySender.has(C), false, "a sender nobody asked about is never delivered");
});

test("A TENANT WITH NO IN-FLIGHT OPERATIONS IS STILL DELIVERED TO, with nothing", async () => {
  // "Nothing happened" and "you were not asked" are different answers, and a
  // consumer must be able to tell them apart.
  const f = fakeChain([logFor(A, hash(1))]);
  const r = await fetchSharedBySender(f.chain, { senders: [A, B], fromBlock: 0n, toBlock: 10n });
  assert.deepEqual(r.bySender.get(B), [], "present and empty, not absent");
});

test("AN EVENT BELONGING TO ANOTHER TENANT IS NEVER APPLIED TO THE WRONG LEDGER", async () => {
  // The provider is trusted to filter, but not blindly: a log whose topic2 is
  // nobody we asked about is discarded and counted, never handed to whoever
  // happens to be first in the map.
  const stray = logFor(C, hash(7));
  const f = {
    chain: {
      async getBlockNumber() {
        return 1000n;
      },
      async getLogs() {
        return [logFor(A, hash(1)), stray];
      },
      async getReceiptLogs() {
        return null;
      },
    } as ReconcileChain,
  };
  const r = await fetchSharedBySender(f.chain, { senders: [A, B], fromBlock: 0n, toBlock: 10n });
  assert.equal(r.unattributed, 1, "the stray is counted");
  assert.deepEqual(r.bySender.get(A)!.length, 1);
  assert.deepEqual(r.bySender.get(B), [], "and it did NOT land on the other tenant");
  for (const [, logs] of r.bySender) {
    for (const l of logs) assert.notEqual(l.topics[1], hash(7), "C's event reached nobody");
  }
});

// ── 8. duplicate delivery is idempotent ─────────────────────────────────────

test("THE SAME EVENT DELIVERED TWICE PRODUCES ONE LEDGER EFFECT", async () => {
  // Re-reading the overlap is only safe BECAUSE application is idempotent. This
  // pins the contract on the consumer side, since the fetcher cannot enforce it.
  const applied = new Set<string>();
  let effects = 0;
  const apply = (logs: RawLog[]) => {
    for (const l of logs) {
      const h = String(l.topics[1]).toLowerCase();
      if (applied.has(h)) continue; // the idempotence rule
      applied.add(h);
      effects += 1;
    }
  };

  // Block 5 sits inside the range both passes read — which is the point: the
  // second pass is the overlap re-read, and it MUST return the log again.
  const f = fakeChain([logFor(A, hash(1), 5n)]);
  const first = await fetchSharedBySender(f.chain, { senders: [A], fromBlock: 0n, toBlock: 10n });
  apply(first.bySender.get(A)!);
  const second = await fetchSharedBySender(f.chain, { senders: [A], fromBlock: 0n, toBlock: 10n });
  apply(second.bySender.get(A)!);

  assert.equal(second.bySender.get(A)!.length, 1, "the overlap DID re-deliver the log");
  assert.equal(effects, 1, "and the ledger moved once");
});

// ── 9. processing failure must not advance durable progress ─────────────────

test("A CONSUMER THAT THROWS LEAVES THE RANGE UNCLAIMED", async () => {
  const f = fakeChain([logFor(A, hash(1)), logFor(B, hash(2))]);
  const progress = memoryProgress();
  const plan = planSharedScan({ head: 1000n, chainFetchProgress: null, requests: [{ sender: A, fromBlock: 0n }, { sender: B, fromBlock: 0n }], overlapBlocks: 100n });

  await assert.rejects(() =>
    runSharedPass({
      chain: f.chain,
      chainId: 4663,
      plan,
      progress,
      async deliver(sender) {
        if (sender === B) throw new Error("ledger write failed");
      },
    }),
  );
  assert.equal(progress.get(4663), null, "progress must NOT move when accounting failed");
});

test("INCOMPLETE COVERAGE ALSO WITHHOLDS THE COMMIT", async () => {
  // Fail every attempt, so the retries are EXHAUSTED and coverage genuinely
  // falls short. Failing once would only prove the retry works, which is test 16.
  const f = fakeChain([], { failUntil: 99 });
  const progress = memoryProgress();
  const plan = planSharedScan({ head: 1000n, chainFetchProgress: null, requests: [{ sender: A, fromBlock: 0n }], overlapBlocks: 100n });
  const r = await runSharedPass({ chain: f.chain, chainId: 4663, plan, progress, async deliver() {} });
  assert.equal(r.committed, false);
  assert.equal(r.reason, "incomplete-coverage");
  assert.equal(progress.get(4663), null);
});

test("a fully covered, fully delivered pass DOES commit", async () => {
  const f = fakeChain([logFor(A, hash(1))]);
  const progress = memoryProgress();
  const plan = planSharedScan({ head: 500n, chainFetchProgress: null, requests: [{ sender: A, fromBlock: 0n }], overlapBlocks: 100n });
  const r = await runSharedPass({ chain: f.chain, chainId: 4663, plan, progress, async deliver() {} });
  assert.equal(r.committed, true);
  assert.equal(progress.get(4663), 500n);
});

// ── 10. cold start with an empty local ledger ───────────────────────────────

test("AN EMPTY LOCAL LEDGER IS ABSENCE OF EVIDENCE, NOT EVIDENCE OF ABSENCE", () => {
  // Hosted, this is the COMMON case, not the exceptional one: the child's sqlite
  // is on ephemeral container disk and a redeploy wipes it, so every cold arm
  // starts here.
  const plan = planArmReconcile({ sender: A, localOutstanding: [], recoveryFromBlock: 300n });
  assert.deepEqual(plan.hashes, [], "nothing known");
  assert.equal(plan.senderRequests.length, 1, "so it must SEARCH, not conclude");
  assert.equal(plan.senderRequests[0]!.fromBlock, 300n);
  assert.match(plan.reasons.join(" "), /empty ledger|no local outstanding/i);
});

// ── 11. a new tenant joining after the cursor advanced ──────────────────────

test("THE FLEET CURSOR CAN ONLY WIDEN A SCAN, NEVER NARROW ONE", () => {
  // The failure this prevents: progress reaches 50,000,000, a tenant arms
  // needing an event from 49,800,000, and a single global cursor says history is
  // already covered. It is covered for the senders that were IN the fetch.
  const plan = planSharedScan({
    head: 50_000_100n,
    chainFetchProgress: 50_000_000n,
    requests: [
      { sender: A, fromBlock: 50_000_000n }, // caught up
      { sender: B, fromBlock: 49_800_000n }, // newly armed, needs history
    ],
    overlapBlocks: 17_700n,
  });
  assert.equal(plan.fromBlock, 49_800_000n, "the newcomer's lower bound wins");
  assert.equal(plan.drivenBy, B);
  assert.equal(plan.incremental, false);
  assert.deepEqual(plan.senders, canonicalSenders([A, B]));

  // And when everyone is caught up, the overlap still pulls the scan back below
  // committed progress rather than starting at it.
  const steady = planSharedScan({
    head: 50_000_100n,
    chainFetchProgress: 50_000_000n,
    requests: [{ sender: A, fromBlock: 50_000_000n }],
    overlapBlocks: 17_700n,
  });
  assert.equal(steady.fromBlock, 50_000_000n - 17_700n, "the reorg overlap is re-read");
  assert.equal(steady.drivenBy, "overlap");
  assert.equal(steady.incremental, true);
});

test("the reorg overlap is an ENGINEERING CHOICE, expressed in time", () => {
  // Not derived from "we observed no reorgs" — that observation was not looking
  // for them, and no finality bound for this chain was established.
  assert.equal(REORG_OVERLAP_SEC, 1800, "30 minutes of chain history");
  assert.equal(reorgOverlapBlocks(0.1015), 17_734n, "at the measured 4663 block time");
  assert.equal(reorgOverlapBlocks(0.17), 10_589n, "and it follows a slower chain");
  assert.equal(reorgOverlapBlocks(0), 20_000n, "an unknown block time gets the generous answer");
  assert.equal(reorgOverlapBlocks(Number.NaN), 20_000n);
});

// ── 12. a 429 midway through a multi-chunk range ───────────────────────────

test("A 429 MIDWAY RETRIES THE SAME SPAN AND NEVER SKIPS BLOCKS", async () => {
  // getLogsAdaptive retries a rate limit on the SAME span rather than halving or
  // advancing — the Stage A fix. What this pins is that the shared fetcher
  // inherits it, and that a rate limit cannot silently shorten coverage.
  const logs = [logFor(A, hash(1), 5n), logFor(A, hash(2), 15_000n)];
  const f = fakeChain(logs, { failNth: 2 });
  const r = await fetchSharedBySender(f.chain, { senders: [A], fromBlock: 0n, toBlock: 20_000n, maxSpan: 10_000n });

  assert.equal(r.complete, true, "the sweep recovered and covered the whole range");
  assert.equal(r.bySender.get(A)!.length, 2, "both logs found, including the one after the 429");
  const spans = f.calls().map((c) => `${c.from}-${c.to}`);
  // The retried span appears twice and the cursor never jumped over it.
  assert.ok(spans.length > 2, `expected a retry, got ${spans.join(" ")}`);
  const covered = new Set(spans);
  assert.ok(covered.size >= 2, "more than one span was scanned");
  for (const c of f.calls()) assert.ok(c.to >= c.from, "no inverted span");
});

// ── the snapshot interface, which does not exist yet ───────────────────────

test("A FUTURE SNAPSHOT CAN ONLY ADD SEARCHES, NEVER SUBTRACT THEM", () => {
  // The transport does not exist. The shape does, so adding it later needs no
  // redesign — and the asymmetry is the safety property: a hint below its own
  // staleness horizon becomes a REASON TO SEARCH, not permission to skip.
  const plan = planArmReconcile({
    sender: A,
    localOutstanding: [],
    recoveryFromBlock: 100n,
    knownOutstandingOps: {
      tenant: A,
      staleAsOfBlock: 1000n,
      ops: [
        { identity: { kind: "known", userOpHash: hash(1) }, recoveryFromBlock: 1200n }, // above horizon → trusted
        { identity: { kind: "known", userOpHash: hash(2) }, recoveryFromBlock: 900n }, // below → distrusted
      ],
    },
  });
  assert.deepEqual(plan.hashes, [hash(1)], "only the op above the horizon stays a hash");
  assert.equal(plan.senderRequests.length, 1, "the stale one became a search");
  assert.match(plan.reasons.join(" "), /older than snapshot horizon/);
});
