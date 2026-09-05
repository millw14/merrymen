/**
 * TWO WAYS TO ASK THE CHAIN WHAT HAPPENED TO AN OPERATION, AND ONE FETCH SHARED
 * ACROSS THE FLEET.
 *
 * Every arm used to sweep 200,001 blocks of EntryPoint logs filtered to ONE
 * sender, per child, independently: 21 serial eth_getLogs × 22 children = 462
 * calls, in a 7-12 second burst that took 7.2% rate limiting. Measured, that
 * sweep found NOTHING on any of the 22 children, and 20 of the 22 accounts had
 * no code at all — so 420 of those 462 calls were answerable from an
 * eth_getCode the same arm had already made two seconds earlier.
 *
 * ── THE TWO MODES ────────────────────────────────────────────────────────────
 *
 * HASH MODE, for the steady state. `UserOperationEvent` indexes the userOpHash
 * in topic1, and merrymen persists that hash BEFORE it broadcasts — so an agent
 * usually knows exactly what it is looking for. Asking by hash is bounded by
 * what we are LOOKING FOR; asking by sender is bounded by what the sender DID.
 * An agent with two outstanding operations asks for two hashes however busy its
 * account has ever been, and AN AGENT WITH NONE ASKS NOTHING AT ALL.
 *
 * Measured against the live provider, 2026-09-03 (spikes/stage-b/hash-topic.mjs):
 *   single hash in topic1      exactly 1 log where 1 was expected
 *   control, a bogus hash      0 logs — the filter is real, not ignored
 *   OR-list of 3               union exact
 *   the same list reversed     identical, so ORDER DOES NOT MATTER
 *   max OR-list                EXACTLY 1000 per topic position; 1001 returns
 *                              "invalid argument 0: exceed max topics"
 *   is the cap global?         NO, per position: 600 in topic1 plus 600 in
 *                              topic3 is accepted
 *   latency                    flat ~300-320ms from 1 to 128 hashes
 *   response size              scales with MATCHES, not with list length
 *
 * SENDER MODE, for cold arm, redeploy and recovery — and for the one case hash
 * mode provably cannot cover. See `NeedsSenderRecovery`.
 *
 * ── THE PERSISTENCE GAP, WHICH IS WHY SENDER MODE IS NOT OPTIONAL ────────────
 *
 * HOSTED CHILD SQLITE IS EPHEMERAL. The only volume in the Railway project is
 * `postgres-volume`, attached to Postgres; the orchestrator service has none. A
 * child's ledger lives at `children/<tenant>/merrymen.db` on the container
 * filesystem, so A REDEPLOY WIPES EVERY CHILD LEDGER — including every
 * `status='submitted'` row and the `user_op_hash` on it. Shared Postgres DOES
 * preserve them (ledger-mirror carries `trades` upward), but a child cannot read
 * Postgres: `DATABASE_URL` is in CHILD_SECRET_STRIP, deliberately, for custody.
 *
 * So at cold arm — the one moment the expensive historical scan runs — a child
 * has ZERO known hashes, and hash mode is unavailable exactly when it would help
 * most. That is not a defect in this design; it is the reason the shared sender
 * scanner exists and must keep existing.
 *
 * A future optimisation could close it: the orchestrator holds DATABASE_URL and
 * already writes grant.json, settings.json and peers.json into each child's
 * home, so it could write the tenant's outstanding hashes down the same channel
 * at spawn. `OutstandingOpsSnapshot` below is the shape that would arrive, and
 * `planArmReconcile` already accepts it — so adding the transport later needs no
 * redesign here. IT WOULD BE A HINT, NEVER AUTHORITATIVE: a snapshot that is
 * stale, partial or absent must fall back to sender recovery, and this module is
 * written so that falling back is the default rather than a special case.
 *
 * ── SHARED FETCH, PRIVATE ACCOUNTING ─────────────────────────────────────────
 *
 * One chain-level fetch serves many senders — measured: an 11-sender OR-list
 * over 200,001 blocks costs the SAME 21 chunks as one sender, for +17% wall
 * clock. But the fetch is the only thing shared. Logs are partitioned by sender
 * and handed to each tenant's existing reconciliation logic untouched. No
 * accounting decision moves here, and nothing in this file decides what a log
 * MEANS for a ledger.
 */
import type { Hex } from "viem";
import { ENTRYPOINT } from "../../packages/core/src/index";
import { getLogsAdaptive, addressTopic, type RawLog, type ReconcileChain } from "./inflight-reconcile";

/** Topic0 of UserOperationEvent. Same constant inflight-reconcile.ts uses. */
const USEROP_EVENT_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";

/**
 * MEASURED, not guessed: 1000 entries per topic position, and the cap is
 * per-position rather than across the whole filter. 1001 is refused with
 * "invalid argument 0: exceed max topics".
 */
export const HASH_TOPIC_MAX = 1000;

// ── canonicalisation ────────────────────────────────────────────────────────

/**
 * ONE CANONICAL FORM, so two equivalent sets cannot produce two fetches.
 *
 * Lowercased, deduplicated, sorted. The provider was measured to be
 * order-insensitive for an OR-list, which is what makes sorting a free
 * normalisation rather than a change of question — if order had mattered,
 * canonicalising would have been unsafe and this comment would say so.
 */
export function canonicalHashes(hashes: Iterable<string>): Hex[] {
  const set = new Set<string>();
  for (const h of hashes) {
    const t = h.trim().toLowerCase();
    if (/^0x[0-9a-f]{64}$/.test(t)) set.add(t);
  }
  return [...set].sort() as Hex[];
}

/** Same rule for senders. Invalid entries are dropped rather than passed on. */
export function canonicalSenders(addrs: Iterable<string>): `0x${string}`[] {
  const set = new Set<string>();
  for (const a of addrs) {
    const t = a.trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(t)) set.add(t);
  }
  return [...set].sort() as `0x${string}`[];
}

/** The cache/dedupe key for one shared fetch. Canonical by construction. */
export function fetchKey(chainId: number, from: bigint, to: bigint, canonicalSet: readonly string[]): string {
  return `${chainId}:${from}:${to}:${canonicalSet.join(",")}`;
}

// ── hash mode ───────────────────────────────────────────────────────────────

export interface HashFetchResult {
  logs: RawLog[];
  /** eth_getLogs calls actually issued. ZERO when there is nothing outstanding. */
  requests: number;
  complete: boolean;
  scannedTo: bigint;
}

/**
 * Fetch the events for a known set of userOpHashes.
 *
 * ZERO HASHES MEANS ZERO REQUESTS, and that is the single largest saving in the
 * steady state: a fleet with nothing outstanding asks the provider nothing.
 * Returning `complete: true` for an empty set is correct rather than convenient
 * — a question with no subjects was answered in full.
 */
export async function fetchByHashes(
  chain: ReconcileChain,
  opts: {
    hashes: Iterable<string>;
    fromBlock: bigint;
    toBlock: bigint;
    maxSpan?: bigint;
    log?: (m: string) => void;
  },
): Promise<HashFetchResult> {
  const canonical = canonicalHashes(opts.hashes);
  if (canonical.length === 0) {
    return { logs: [], requests: 0, complete: true, scannedTo: opts.toBlock };
  }

  const logs: RawLog[] = [];
  let requests = 0;
  let complete = true;
  let scannedTo = opts.toBlock;

  // Chunked at the measured provider cap. A batch is a separate question, so a
  // short scan in one batch must not be reported as coverage of another.
  for (let i = 0; i < canonical.length; i += HASH_TOPIC_MAX) {
    const batch = canonical.slice(i, i + HASH_TOPIC_MAX);
    const r = await getLogsAdaptive(
      chain,
      {
        address: ENTRYPOINT.v07 as `0x${string}`,
        // topic1 IS the question here — the inverse of the sender sweep, which
        // leaves topic1 null precisely because it does not know the hashes.
        topics: [USEROP_EVENT_TOPIC, batch as Hex[]],
      },
      opts.fromBlock,
      opts.toBlock,
      opts.maxSpan ?? 10_000n,
      opts.log,
    );
    requests += 1;
    logs.push(...r.logs);
    if (!r.complete) {
      complete = false;
      if (r.scannedTo < scannedTo) scannedTo = r.scannedTo;
    }
  }
  return { logs, requests, complete, scannedTo };
}

/**
 * THE ONE CASE HASH MODE CANNOT COVER.
 *
 * executor.ts computes the userOpHash locally and persists it before the send,
 * so every crash window leaves a durable hash — except one. When the bundler
 * answers `sendUserOperation` with a DIFFERENT hash than the one the operation
 * was signed under, the operation is genuinely in flight and, in the executor's
 * own words, "which hash resolves it is now unknown". Querying topic1 for a hash
 * the chain will never index finds nothing, and finding nothing would look
 * exactly like success-with-no-event.
 *
 * So that operation is marked, and a marked operation goes to sender mode. This
 * is a type rather than a boolean so the reason survives into the logs.
 */
export type HashIdentity =
  | { kind: "known"; userOpHash: Hex }
  | { kind: "uncertain"; signedHash: Hex; acceptedHash?: Hex; why: string };

export interface OutstandingOp {
  identity: HashIdentity;
  /** Where a search for THIS operation must start. Never the fleet cursor. */
  recoveryFromBlock: bigint;
}

/** Split outstanding operations into the two modes. Pure. */
export function splitByMode(ops: readonly OutstandingOp[]): {
  hashes: Hex[];
  needsSenderRecovery: OutstandingOp[];
} {
  const known: string[] = [];
  const needsSenderRecovery: OutstandingOp[] = [];
  for (const op of ops) {
    if (op.identity.kind === "known") known.push(op.identity.userOpHash);
    else needsSenderRecovery.push(op);
  }
  return { hashes: canonicalHashes(known), needsSenderRecovery };
}

// ── the three cursor concepts, deliberately not one ─────────────────────────

/**
 * THREE DIFFERENT QUESTIONS, AND CONFLATING THEM IS THE BUG THIS PREVENTS.
 *
 *   chainFetchProgress   how far the SHARED fetcher has safely observed on this
 *                        chain. A performance fact about the fleet.
 *   tenant state         what each agent has actually accounted for. Lives in
 *                        that tenant's own ledger and is not represented here —
 *                        deliberately, because this module must not own it.
 *   recovery lower bound where a PARTICULAR unresolved operation or a newly
 *                        armed tenant must search from. A correctness fact
 *                        about one subject.
 *
 * A single fleet cursor used as proof of completeness produces exactly this
 * failure: progress reaches block 50,000,000, a tenant arms needing an event
 * from 49,800,000, and the cursor says history is already covered. It is not —
 * it is covered FOR THE SENDERS THAT WERE IN THE FETCH, which that tenant was
 * not. So progress never clamps a lower bound; see `planSharedScan`.
 */
export interface FetchProgressStore {
  read(chainId: number): Promise<bigint | null>;
  /** Called ONLY after every consumer has accepted the range. See commitAfter. */
  commit(chainId: number, throughBlock: bigint): Promise<void>;
}

/** What one tenant needs from a shared scan. */
export interface SenderScanRequest {
  sender: `0x${string}`;
  /** This tenant's own lower bound. Not derived from, and never clamped by, progress. */
  fromBlock: bigint;
}

/**
 * REORG OVERLAP — three separate things, kept separate on purpose.
 *
 * 1. MEASURED CHAIN BEHAVIOUR. I have not measured reorg depth on 4663, and the
 *    earlier fleet observation ("zero restarts, no halvings, no skipped blocks"
 *    over 9 hours) says nothing about it — it was not looking. Absence of
 *    observed reorgs is not evidence of finality, and treating it as such is the
 *    error this comment exists to refuse.
 *
 * 2. FUNDAMENTAL GUARANTEE. I could not establish an authoritative finality
 *    bound for Robinhood Chain from the repo or from the chain itself. It is an
 *    Arbitrum-stack L3, so its settlement inherits from the L2 beneath it and
 *    ultimately L1, but the depth at which a SEQUENCER pre-confirmation can be
 *    reordered is a property of that operator's configuration, not something a
 *    block header reveals. NO DEFENSIBLE BOUND IS CLAIMED HERE.
 *
 * 3. THE ENGINEERING MARGIN WE CHOOSE, which is therefore the whole basis for
 *    this number. Expressed in SECONDS and converted, so it survives a block
 *    time change: 30 minutes of chain history. At the measured 0.1015 s/block on
 *    4663 that is ~17,700 blocks, or two 10,000-block chunks per pass.
 *
 * The cost of being generous here is two extra requests; the cost of being tight
 * is an operation whose outcome is permanently invisible. And re-reading is only
 * safe at all BECAUSE LEDGER APPLICATION IS IDEMPOTENT — the same event
 * delivered twice must produce one effect. That is a requirement on the
 * consumer, not a property of this module, and it is tested.
 */
export const REORG_OVERLAP_SEC = 1800;

/** Blocks of overlap for a chain whose observed block time is `secPerBlock`. */
export function reorgOverlapBlocks(secPerBlock: number): bigint {
  if (!Number.isFinite(secPerBlock) || secPerBlock <= 0) return 20_000n; // unknown → generous
  return BigInt(Math.ceil(REORG_OVERLAP_SEC / secPerBlock));
}

export interface SharedScanPlan {
  fromBlock: bigint;
  toBlock: bigint;
  senders: `0x${string}`[];
  /** Which request drove `fromBlock` — so a wide scan can be explained. */
  drivenBy: `0x${string}` | "overlap" | "none";
  /** True when no tenant needed history below the overlap window. */
  incremental: boolean;
}

/**
 * Decide the range for one shared pass.
 *
 * `fromBlock` is the LOWEST of every tenant's own lower bound and the re-read
 * overlap below committed progress. Progress can only ever WIDEN the scan (by
 * pulling the overlap in); it can never narrow it, which is what keeps a newly
 * armed tenant's history reachable after the fleet cursor has moved on.
 */
export function planSharedScan(args: {
  head: bigint;
  chainFetchProgress: bigint | null;
  requests: readonly SenderScanRequest[];
  overlapBlocks: bigint;
}): SharedScanPlan {
  const senders = canonicalSenders(args.requests.map((r) => r.sender));
  if (args.requests.length === 0) {
    return { fromBlock: args.head, toBlock: args.head, senders: [], drivenBy: "none", incremental: true };
  }

  let lowest = args.requests[0]!;
  for (const r of args.requests) if (r.fromBlock < lowest.fromBlock) lowest = r;

  const overlapFloor =
    args.chainFetchProgress === null
      ? null
      : args.chainFetchProgress > args.overlapBlocks
        ? args.chainFetchProgress - args.overlapBlocks
        : 0n;

  let fromBlock = lowest.fromBlock;
  let drivenBy: SharedScanPlan["drivenBy"] = lowest.sender;
  if (overlapFloor !== null && overlapFloor < fromBlock) {
    fromBlock = overlapFloor;
    drivenBy = "overlap";
  }
  return {
    fromBlock,
    toBlock: args.head,
    senders,
    drivenBy,
    incremental: overlapFloor !== null && lowest.fromBlock >= overlapFloor,
  };
}

// ── the shared fetcher ──────────────────────────────────────────────────────

export interface SharedFetchResult {
  /** Lowercased sender → that sender's logs, and nobody else's. */
  bySender: Map<string, RawLog[]>;
  /** eth_getLogs calls issued. One chunked scan, not one per sender. */
  requests: number;
  complete: boolean;
  scannedTo: bigint;
  /** Logs whose topic2 matched no requested sender. Should always be zero. */
  unattributed: number;
}

/**
 * One fetch, many senders, then partitioned.
 *
 * `deliver` is called once per REQUESTED sender — including senders with no logs,
 * so a consumer can tell "nothing happened" from "you were not asked". Progress
 * is committed only if every delivery resolved AND coverage was complete: a
 * consumer that threw leaves the range unclaimed, and the next pass re-reads it.
 */
export async function fetchSharedBySender(
  chain: ReconcileChain,
  opts: {
    senders: readonly string[];
    fromBlock: bigint;
    toBlock: bigint;
    maxSpan?: bigint;
    log?: (m: string) => void;
  },
): Promise<SharedFetchResult> {
  const senders = canonicalSenders(opts.senders);
  const bySender = new Map<string, RawLog[]>();
  for (const s of senders) bySender.set(s, []);
  if (senders.length === 0) {
    return { bySender, requests: 0, complete: true, scannedTo: opts.toBlock, unattributed: 0 };
  }

  let requests = 0;
  let complete = true;
  let scannedTo = opts.toBlock;
  let unattributed = 0;

  // One chunked scan for the whole cohort. Measured: the chunk count is set by
  // the RANGE, not the cohort — an 11-sender list costs the same 21 chunks as one.
  for (let i = 0; i < senders.length; i += HASH_TOPIC_MAX) {
    const slice = senders.slice(i, i + HASH_TOPIC_MAX);
    const r = await getLogsAdaptive(
      chain,
      {
        address: ENTRYPOINT.v07 as `0x${string}`,
        // topic1 left null on purpose: the sweep does not know the hashes —
        // that is the whole reason it is scanning by sender.
        topics: [USEROP_EVENT_TOPIC as Hex, null, slice.map((s) => addressTopic(s)) as Hex[]],
      },
      opts.fromBlock,
      opts.toBlock,
      opts.maxSpan ?? 10_000n,
      opts.log,
    );
    requests += 1;
    if (!r.complete) {
      complete = false;
      if (r.scannedTo < scannedTo) scannedTo = r.scannedTo;
    }
    for (const raw of r.logs) {
      // PARTITION BY topic2, which is the indexed sender. A log is handed to
      // exactly one tenant, and to that tenant only.
      const t2 = raw.topics[2];
      const sender = typeof t2 === "string" ? `0x${t2.slice(26).toLowerCase()}` : "";
      const bucket = bySender.get(sender);
      // COUNTED, NOT ASSERTED. A log matching no requested sender means the
      // filter did something we did not expect — worth a number in a log line
      // rather than a crash, and worth never silently applying to somebody.
      if (bucket) bucket.push(raw);
      else unattributed += 1;
    }
  }

  if (unattributed > 0) {
    opts.log?.(`shared scan: ${unattributed} log(s) matched no requested sender and were DISCARDED, not applied`);
  }
  return { bySender, requests, complete, scannedTo, unattributed };
}

/**
 * Run a shared pass and commit progress ONLY if the whole range was covered and
 * every consumer accepted its own logs.
 *
 * The ordering is the guarantee: fetch, deliver to every consumer, and only then
 * persist. A consumer that throws means the range was fetched but not accounted
 * for, so progress must not move — the next pass re-reads it, and idempotent
 * application makes that harmless.
 */
export async function runSharedPass(args: {
  chain: ReconcileChain;
  chainId: number;
  plan: SharedScanPlan;
  progress: FetchProgressStore;
  deliver(sender: `0x${string}`, logs: RawLog[]): Promise<void>;
  maxSpan?: bigint;
  log?: (m: string) => void;
}): Promise<{ result: SharedFetchResult; committed: boolean; reason?: string }> {
  const result = await fetchSharedBySender(args.chain, {
    senders: args.plan.senders,
    fromBlock: args.plan.fromBlock,
    toBlock: args.plan.toBlock,
    maxSpan: args.maxSpan,
    log: args.log,
  });

  let delivered = 0;
  for (const sender of args.plan.senders) {
    // Sequential on purpose: a consumer is somebody's ledger, and 22 concurrent
    // writers to 22 sqlite files is a different change with different risks.
    await args.deliver(sender, result.bySender.get(sender) ?? []);
    delivered += 1;
  }

  if (!result.complete) {
    args.log?.(
      `shared scan covered only ${args.plan.fromBlock}..${result.scannedTo} of ` +
        `${args.plan.fromBlock}..${args.plan.toBlock} — progress NOT advanced`,
    );
    return { result, committed: false, reason: "incomplete-coverage" };
  }
  if (delivered !== args.plan.senders.length) {
    return { result, committed: false, reason: "undelivered" };
  }
  await args.progress.commit(args.chainId, args.plan.toBlock);
  return { result, committed: true };
}

// ── the arm-time entry point, with room for a future snapshot ───────────────

/**
 * A snapshot of a tenant's outstanding operations, supplied from OUTSIDE the
 * child. Not produced today — the transport does not exist — and the shape is
 * here so adding it later needs no redesign.
 *
 * A HINT, NEVER AUTHORITATIVE. `staleAsOfBlock` is what makes that enforceable:
 * anything the snapshot does not cover still goes to sender recovery, and an
 * absent snapshot is simply the case where nothing is covered.
 */
export interface OutstandingOpsSnapshot {
  tenant: `0x${string}`;
  ops: readonly OutstandingOp[];
  /** The block the snapshot was accurate as of. Below this, trust nothing. */
  staleAsOfBlock: bigint;
}

export interface ArmReconcilePlan {
  /** Hash-mode query, empty when nothing is known outstanding. */
  hashes: Hex[];
  /** Senders needing the shared historical scan, with their own lower bounds. */
  senderRequests: SenderScanRequest[];
  /** Why sender mode was needed, for the log line. */
  reasons: string[];
}

/**
 * What an arming tenant should ask, given what it knows.
 *
 * The local ledger is the authority. A snapshot, when one ever arrives, can only
 * ADD hashes it is confident about — and every operation it does not cover, or
 * covers only below its own staleness horizon, falls to sender recovery. That
 * asymmetry is the whole safety property: the optimisation can never subtract a
 * search.
 */
export function planArmReconcile(args: {
  sender: `0x${string}`;
  /** From the tenant's OWN ledger. Empty after a redeploy — see the header. */
  localOutstanding: readonly OutstandingOp[];
  /** Not implemented yet; accepted so the interface does not change later. */
  knownOutstandingOps?: OutstandingOpsSnapshot;
  /** Where this tenant must search from if sender mode is needed. */
  recoveryFromBlock: bigint;
}): ArmReconcilePlan {
  const reasons: string[] = [];
  const merged: OutstandingOp[] = [...args.localOutstanding];

  if (args.knownOutstandingOps) {
    for (const op of args.knownOutstandingOps.ops) {
      // A hinted op below the snapshot's own horizon is not trustworthy as a
      // hash; it becomes a reason to search, not a reason to skip searching.
      if (op.recoveryFromBlock < args.knownOutstandingOps.staleAsOfBlock) {
        merged.push({ ...op, identity: { kind: "uncertain", signedHash: hashOf(op), why: "hint older than snapshot horizon" } });
      } else {
        merged.push(op);
      }
    }
  }

  const { hashes, needsSenderRecovery } = splitByMode(merged);
  const senderRequests: SenderScanRequest[] = [];

  if (args.localOutstanding.length === 0 && !args.knownOutstandingOps) {
    // The cold-arm case, and the common one hosted: an empty ledger is not
    // evidence of nothing outstanding, it is absence of evidence. Search.
    reasons.push("no local outstanding-op knowledge (empty ledger or first arm)");
    senderRequests.push({ sender: args.sender, fromBlock: args.recoveryFromBlock });
  }
  for (const op of needsSenderRecovery) {
    reasons.push(
      op.identity.kind === "uncertain"
        ? `uncertain hash identity: ${op.identity.why}`
        : "unclassified outstanding op",
    );
    senderRequests.push({ sender: args.sender, fromBlock: op.recoveryFromBlock });
  }

  return { hashes, senderRequests, reasons };
}

function hashOf(op: OutstandingOp): Hex {
  return op.identity.kind === "known" ? op.identity.userOpHash : op.identity.signedHash;
}
