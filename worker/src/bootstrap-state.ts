/**
 * WHAT THE ORCHESTRATOR TELLS A CHILD ABOUT ITS OWN MONEY, BEFORE IT TRADES.
 *
 * THE BUG THIS EXISTS FOR. A hosted child's SQLite lives in an ephemeral
 * container directory. Every redeploy hands the worker an EMPTY database, and
 * the accounting code read that emptiness as a fact about the world:
 *
 *     if (equityUsdg > 0n && highWaterMarkUsdg === 0n) record(equityUsdg, "opening balance")
 *
 * "No high-water mark on record AND there is money here" was taken to mean
 * "this money just arrived". In self-hosted mode that inference is sound — the
 * database outlives the process, so an empty one really is a new agent. In
 * hosted mode it is false on every single redeploy, and the canary booked its
 * 10 USDG as a brand-new contribution three separate times. Nothing about the
 * account changed; only the container did.
 *
 * WHY IT WAS NOT MERELY A REPORTING ERROR. `record()` also calls
 * `adjustAgentHwm`, so each phantom contribution raised the high-water mark by
 * the same amount. The two errors cancelled, which is why no fee was wrongly
 * charged and why nobody noticed. That cancellation is also the trap: DELETING
 * the phantom contribution on its own would leave the restored HWM at zero, and
 * the next equity mark would hand the whole principal to `accrueAboveHwm` as
 * profit and take a performance fee on the owner's own capital. The two figures
 * have to be restored together or neither. That is why this file carries the
 * HWM beside the contributions rather than just the contributions.
 *
 * THE SHAPE OF THE FIX. The orchestrator holds `DATABASE_URL` and the child
 * never will (`CHILD_SECRET_STRIP`), so the durable accounting state is derived
 * from Postgres by the parent and delivered as a small private file in the
 * child's own home — the same model as `grant.json`, `settings.json` and
 * `peers.json`. It is a versioned bootstrap CONTRACT, not a one-off HWM dump:
 * other things the parent knows and the child cannot will want the same channel.
 *
 * AND IT FAILS CLOSED. Missing, malformed, stale, or written from a Postgres
 * that would not answer, the child does NOT fall back to the old inference. It
 * marks contribution truth UNKNOWN and books nothing. An agent that cannot say
 * what was contributed cannot say what it earned, and saying so is the whole
 * point — a fabricated contribution is worse than an absent one, because a
 * number nobody flags gets believed.
 *
 * ── THE CONTRACT, field by field ────────────────────────────────────────────
 *
 * EVERY FIELD HAS A CONSUMER. That is a rule, not an observation. A value that
 * is derived, transported, validated and then dropped is worse than an absent
 * one: it creates the impression that the bootstrap state restores more truth
 * than it does, and the strict validation makes the impression convincing. Four
 * fields failed that test on the first pass and were removed rather than kept
 * "for later" — `asOfBlock` (declared reserved, never written), `ownerAddress`
 * (written by the parent, structurally dropped by `classifyAnchor`),
 * `anchorNetContributionsUsdg` and `restartDriftUsdg` (both assigned in the
 * child and read by nothing).
 *
 *   field                        source → validation → consumer → effect
 *   ─────────────────────────────────────────────────────────────────────────
 *   schemaVersion                orchestrator → exact equality, BEFORE the
 *                                tenant check → classifyAnchor → an unknown
 *                                version refuses the whole file rather than
 *                                reading the fields it happens to recognise
 *   tenantId (= smart account)   orchestrator → case-insensitive equality →
 *                                classifyAnchor → a mismatch is MALFORMED, not
 *                                stale: applying another account's peak is the
 *                                worst thing this file could do
 *   generatedAt                  orchestrator → finite, and bounded in BOTH
 *                                directions → classifyAnchor → stale or
 *                                future-dated fails closed
 *   accounting.kind              deriveBootstrapAccounting → discriminant →
 *                                accountingLicence → decides whether an opening
 *                                balance may be booked at all
 *   highWaterMarkUsdg            durable agents row → micro-string shape →
 *                                restoreAnchoredHighWaterMark → setAgentHwm,
 *                                MAX() in SQL. The only durable write, and the
 *                                one that stops a fee landing on principal
 *   netContributionsUsdg         epoch-scoped flows sum → micro-string shape →
 *                                accountingLicence → compared against the
 *                                evidenced total; disagreement means unknown
 *   anchoredContributionsUsdg    the same sum over evidenced rows only → same →
 *                                accountingLicence → equality with the above,
 *                                plus zero unanchored rows, is what proves it
 *   unanchoredFlowCount          count of the difference → integer → same → any
 *                                non-zero value makes contributions unknown
 *   carryNote                    reconcileEpochCarry, when a bridge fails →
 *                                string → appended to the licence's `why` →
 *                                reaches the operator log and agents.
 *                                contributions_why, so a demoted carry is not
 *                                just an unexplained count
 *   lastObservedCashUsdg         newest durable equity row → micro-string or
 *                                null → planFirstObservation → the downtime
 *                                drift baseline; null means no reading, which
 *                                yields no drift claim rather than a zero one
 *   accountingEpoch              durable agents row → integer → setAgentEpoch,
 *                                MAX() → the child files its rows in the epoch
 *                                the rest of the system is reading
 *   observedAt                   newest durable row → finite → the licence's
 *                                `why` → says how old the EVIDENCE is, which is
 *                                a different question from how old the file is
 *   outstandingOps               NOT WRITTEN. Reserved so the orchestrator to
 *                                child hash push is not a schema break later;
 *                                pinned dead by accounting-truth.test.ts
 */

import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";

/**
 * Bump on any INCOMPATIBLE change. A child that does not recognise the version
 * refuses the file rather than reading the fields it happens to know: a partial
 * read of an accounting anchor is exactly the silent-wrong-number failure this
 * whole file exists to prevent.
 */
export const BOOTSTRAP_SCHEMA_VERSION = 1;

/** The file, in the child's own home. Private (0600) like every other one there. */
export const BOOTSTRAP_FILE = "bootstrap.json";

/**
 * How old an anchor may be before it stops counting as evidence.
 *
 * The parent writes it immediately before `spawn()`, and the child reads it
 * exactly once, at its first arm — so at the moment of the read the file is
 * seconds old. Anything materially older means this child did not get a file
 * written for it and is looking at a leftover from a previous deploy, which is
 * precisely the state that must not be trusted: the account may have moved.
 *
 * THE BOUND IS ONLY MEANINGFUL AGAINST A READ AT STARTUP. It said "refreshed on
 * every reconcile pass" while nothing refreshed it, and the child re-read it on
 * every re-arm — so a healthy child that simply stayed up for seven hours would
 * fail its own correct anchor closed. The read is memoised now (`anchorOnce`),
 * which is what makes this number mean what it says.
 */
export const BOOTSTRAP_MAX_AGE_SEC = 6 * 3600;

/**
 * Micro-USDG as a decimal integer string.
 *
 * NOT a number. The ledger stores USDG as SQLite REAL and the worker computes
 * in bigint micro-units; a JSON float in between would round the anchor and
 * every figure derived from it. A string crosses the boundary exactly.
 */
export type MicroUsdgString = string;

/**
 * What the parent can say about a tenant's durable accounting.
 *
 * A CLOSED UNION WITH A DISTINCT ARM FOR "I COULD NOT ASK". `unknown` is not a
 * degenerate `established` with zeroes in it — zeroes are a claim, and a
 * database that would not answer has made no claim. The three arms get three
 * different behaviours in the child, and collapsing any two of them
 * reintroduces the bug in a new shape.
 */
export type BootstrapAccounting =
  /** Durable history exists. Resume from these figures; book no opening balance. */
  | {
      kind: "established";
      /** The persisted peak, restored so the fee path cannot see principal as profit. */
      highWaterMarkUsdg: MicroUsdgString;
      /** Σ flows in − Σ flows out, signed, over EVERY row. */
      netContributionsUsdg: MicroUsdgString;
      /**
       * The same total counting only flows that name a transaction.
       *
       * A flow with a tx hash was read off a USDG Transfer log; one without was
       * inferred from a balance change. When the two totals agree, every
       * contribution is a receipt and the figure can be checked by anyone with
       * an RPC. When they disagree, some of the total rests on inference — and
       * inference is exactly what the mirror's cursor rewind duplicates, so the
       * difference is not a rounding detail but the shape of the corruption.
       *
       * Optional so an older anchor still parses; absent means "not computed",
       * which is treated as unproven rather than as agreement.
       */
      anchoredContributionsUsdg?: MicroUsdgString;
      /** How many flows this epoch are not evidenced. Zero is the only value that proves anything. */
      unanchoredFlowCount?: number;
      /**
       * Why an epoch-opening carry was NOT accepted as evidence, when one was
       * present and failed to reconcile against the prior epoch's closing mark.
       * Absent means either no carry, or a carry that checked out.
       */
      carryNote?: string;
      /** Cash at the newest durable observation — the baseline for a downtime delta. */
      lastObservedCashUsdg: MicroUsdgString | null;
      accountingEpoch: number;
      /** Unix seconds of the newest durable row this was derived from. */
      observedAt: number;
    }
  /**
   * Postgres answered and the tenant has NO accounting history at all: no
   * flows, no equity marks, no fee accruals, zero HWM.
   *
   * This is the ONLY thing that licenses an opening-balance contribution, and
   * it is an assertion by the one process that can actually see durable state.
   * The child cannot make this call — an empty child database is a statement
   * about the container, not about the account.
   */
  | { kind: "no-prior-accounting"; observedAt: number }
  /**
   * The parent could not establish the truth (Postgres unreachable, query
   * failed). Written deliberately rather than omitted, so the child can tell
   * "the parent tried and failed" from "no parent wrote here at all".
   */
  | { kind: "unknown"; why: string; observedAt: number };

/**
 * The orchestrator to child bootstrap contract.
 *
 * Deliberately extensible: this is the channel for anything the parent knows
 * and the child structurally cannot, and there will be more of it.
 */
export interface TenantBootstrapState {
  schemaVersion: number;
  /**
   * THE SMART ACCOUNT. Named `tenantId` for the file's shape, but the value is
   * the ERC-4337 wallet, because that is the key every ledger table is on and
   * therefore the only identity under which these figures mean anything.
   *
   * The owner address that signed the grant is a DIFFERENT string, carried
   * separately below. Confusing the two is not a naming nit: a lookup under the
   * owner address finds no rows for a funded account, and "no rows" is the arm
   * that licenses booking the whole balance as a new contribution.
   */
  tenantId: string;
  /** Unix seconds when this file was written. Staleness is measured from here. */
  generatedAt: number;
  accounting: BootstrapAccounting;
  /**
   * RESERVED — DECLARED, NOT IMPLEMENTED.
   *
   * The orchestrator-to-child outstanding-hash push (reconcile-modes.ts) is a
   * separate change and is explicitly out of scope here. The field exists so
   * that adding it later is not a schema break; nothing reads it, and
   * `accounting-truth.test.ts` pins that nothing does. An accounting-correctness
   * change is not the place to also alter which blocks get scanned.
   */
  outstandingOps?: readonly string[];
}

/**
 * Why an anchor is not usable. Each arm is a different operational problem and
 * a different log line; `absent` on a self-hosted worker is normal, `malformed`
 * on a hosted one is a bug in the parent.
 */
export type AnchorVerdict =
  | { kind: "valid"; state: TenantBootstrapState; accounting: BootstrapAccounting }
  | { kind: "absent"; why: string }
  | { kind: "malformed"; why: string }
  | { kind: "stale"; why: string; ageSec: number }
  | { kind: "unsupported-version"; why: string; found: unknown };

const isMicro = (v: unknown): v is MicroUsdgString => typeof v === "string" && /^-?\d{1,30}$/.test(v);

/** Parse a micro-USDG string. Safe only on values `isMicro` has accepted. */
export function microToBigint(v: MicroUsdgString): bigint {
  return BigInt(v);
}

/** Render a bigint micro-USDG figure for the file. */
export function bigintToMicro(v: bigint): MicroUsdgString {
  return v.toString();
}

function validAccounting(a: unknown): BootstrapAccounting | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const observedAt = typeof o.observedAt === "number" && Number.isFinite(o.observedAt) ? o.observedAt : null;
  if (observedAt === null) return null;

  if (o.kind === "no-prior-accounting") return { kind: "no-prior-accounting", observedAt };
  if (o.kind === "unknown") {
    return { kind: "unknown", why: typeof o.why === "string" ? o.why : "unspecified", observedAt };
  }
  if (o.kind !== "established") return null;

  // EVERY MONEY FIELD OR NONE. A partially-readable accounting anchor is
  // treated as malformed, not as the fields that happened to survive — half an
  // anchor restores half the invariant, which is the same as none of it.
  if (!isMicro(o.highWaterMarkUsdg)) return null;
  if (!isMicro(o.netContributionsUsdg)) return null;
  if (o.lastObservedCashUsdg !== null && !isMicro(o.lastObservedCashUsdg)) return null;
  if (typeof o.accountingEpoch !== "number" || !Number.isInteger(o.accountingEpoch)) return null;

  // The receipts-only fields are OPTIONAL — an anchor written before they
  // existed must still parse — but a malformed one is not silently dropped to
  // "absent", because "absent" and "present but unreadable" get the same
  // treatment only by accident. A bad value makes the whole anchor malformed.
  if (o.anchoredContributionsUsdg !== undefined && !isMicro(o.anchoredContributionsUsdg)) return null;
  if (o.unanchoredFlowCount !== undefined && !Number.isInteger(o.unanchoredFlowCount)) return null;
  if (o.carryNote !== undefined && typeof o.carryNote !== "string") return null;

  return {
    kind: "established",
    highWaterMarkUsdg: o.highWaterMarkUsdg,
    netContributionsUsdg: o.netContributionsUsdg,
    ...(o.anchoredContributionsUsdg === undefined
      ? {}
      : { anchoredContributionsUsdg: o.anchoredContributionsUsdg as MicroUsdgString }),
    ...(o.unanchoredFlowCount === undefined ? {} : { unanchoredFlowCount: o.unanchoredFlowCount as number }),
    ...(o.carryNote === undefined ? {} : { carryNote: o.carryNote as string }),
    lastObservedCashUsdg: (o.lastObservedCashUsdg as MicroUsdgString | null) ?? null,
    accountingEpoch: o.accountingEpoch,
    observedAt,
  };
}

/**
 * Judge an anchor's text. PURE — no filesystem, no clock, no environment.
 *
 * `nowSec` is a parameter because staleness is the one property here that a
 * test has to be able to drive, and a function that reads `Date.now()` cannot
 * be asked "what would you have said four hours from now".
 */
export function classifyAnchor(
  raw: string | null,
  args: { tenantId: string; nowSec: number; maxAgeSec?: number },
): AnchorVerdict {
  if (raw === null) return { kind: "absent", why: `no ${BOOTSTRAP_FILE} in the child's home` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: "malformed", why: `unparseable JSON — ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "malformed", why: "not a JSON object" };
  const o = parsed as Record<string, unknown>;

  // VERSION BEFORE ANYTHING ELSE, including the tenant check: an unrecognised
  // version means the field layout itself is not agreed on, so no other field
  // in the file can be read with confidence.
  if (o.schemaVersion !== BOOTSTRAP_SCHEMA_VERSION) {
    return {
      kind: "unsupported-version",
      why: `anchor is schemaVersion ${String(o.schemaVersion)}, this worker speaks ${BOOTSTRAP_SCHEMA_VERSION}`,
      found: o.schemaVersion,
    };
  }

  // WRONG TENANT IS MALFORMED, NOT STALE. Applying another account's high-water
  // mark would be the worst outcome this file can produce, so it is checked
  // explicitly rather than left to the caller to remember.
  const tenantId = typeof o.tenantId === "string" ? o.tenantId : "";
  if (tenantId.toLowerCase() !== args.tenantId.toLowerCase()) {
    return { kind: "malformed", why: `anchor names tenant ${tenantId || "(none)"}, this child is ${args.tenantId}` };
  }

  const generatedAt = typeof o.generatedAt === "number" && Number.isFinite(o.generatedAt) ? o.generatedAt : null;
  if (generatedAt === null) return { kind: "malformed", why: "no usable generatedAt" };

  const accounting = validAccounting(o.accounting);
  if (!accounting) return { kind: "malformed", why: "accounting block missing or incomplete" };

  // Staleness LAST, so a stale file still gets its structural problems reported
  // first — "stale" on a file that was also malformed would send an operator
  // looking at the writer's schedule instead of at the writer.
  const maxAge = args.maxAgeSec ?? BOOTSTRAP_MAX_AGE_SEC;
  const ageSec = args.nowSec - generatedAt;
  if (ageSec > maxAge) {
    return {
      kind: "stale",
      why: `anchor was written ${Math.round(ageSec / 60)} min ago, past the ${Math.round(maxAge / 60)} min bound`,
      ageSec,
    };
  }
  // A clock skew that puts the file in the future is not evidence either.
  if (ageSec < -maxAge) {
    return { kind: "malformed", why: `anchor is dated ${Math.round(-ageSec / 60)} min in the future` };
  }

  return {
    kind: "valid",
    state: {
      schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
      tenantId,
      generatedAt,
      accounting,
      ...(Array.isArray(o.outstandingOps) ? { outstandingOps: o.outstandingOps as readonly string[] } : {}),
    },
    accounting,
  };
}

/**
 * Read and judge the anchor in a child's home.
 *
 * The only impure function here, and it is a two-liner on purpose: everything
 * that decides anything lives in `classifyAnchor`, which a test can drive
 * without a filesystem. A missing file is `absent` rather than a throw, because
 * "no anchor" is a normal state for a self-hosted worker and an expected one
 * for the first hosted deploy after this ships.
 */
export function readAnchor(
  home: string,
  args: { tenantId: string; nowSec?: number; maxAgeSec?: number },
): AnchorVerdict {
  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000);
  let raw: string | null = null;
  try {
    raw = readFileSync(pathJoin(home, BOOTSTRAP_FILE), "utf8");
  } catch {
    raw = null;
  }
  return classifyAnchor(raw, { tenantId: args.tenantId, nowSec, maxAgeSec: args.maxAgeSec });
}

// ── what the anchor entitles a worker to claim ─────────────────────────────

/**
 * What this process may say about the owner's capital.
 *
 *   new-account        durable state was READ and is empty — book the opening balance
 *   resume             durable state exists — resume from it, book nothing
 *   none               durable state could not be established — book nothing, and
 *                      say contributions are unknown
 *   self-hosted-local  there is no parent; the local ledger IS the durable record
 *
 * The `none` arm is the one that did not exist before, and its absence is the
 * whole bug: with no way to express "I could not find out", the code had to pick
 * between the other two, and it picked the one that manufactures money.
 */
export type OpeningBalanceLicence = "new-account" | "resume" | "none" | "self-hosted-local";

export interface AccountingLicence {
  licence: OpeningBalanceLicence;
  contributionsKnown: boolean;
  /** The authoritative contribution total, when durable state supplied one. */
  netContributionsUsdg: bigint | null;
  /** The peak to restore into the local store, when durable state supplied one. */
  highWaterMarkUsdg: bigint | null;
  /** Cash at the newest durable observation — the downtime baseline. */
  lastObservedCashUsdg: bigint | null;
  /** The durable accounting epoch, adopted so this child files its rows in the right one. */
  accountingEpoch: number | null;
  why: string;
}

/**
 * Turn an anchor verdict into a licence. PURE.
 *
 * THE HOSTED/SELF-HOSTED SPLIT IS THE HINGE. Self-hosted, the worker's SQLite
 * lives on a real disk that outlives the process, so it IS the durable record
 * and an empty one really does mean a new agent — the original inference was
 * correct there and is kept. Hosted, the same directory is discarded on every
 * deploy, so emptiness means nothing at all and the only durable record is the
 * one the parent can see. Getting this boundary wrong in either direction is a
 * money bug, so it is drawn on one explicit flag rather than inferred.
 */
export function accountingLicence(verdict: AnchorVerdict, opts: { hosted: boolean }): AccountingLicence {
  const base: AccountingLicence = {
    licence: "none",
    contributionsKnown: false,
    netContributionsUsdg: null,
    highWaterMarkUsdg: null,
    lastObservedCashUsdg: null,
    accountingEpoch: null,
    why: "",
  };

  if (!opts.hosted) {
    return {
      ...base,
      licence: "self-hosted-local",
      contributionsKnown: true,
      why: "self-hosted — the local ledger is the durable record and survives a restart",
    };
  }
  if (verdict.kind !== "valid") {
    return { ...base, why: `anchor ${verdict.kind}: ${verdict.why}` };
  }

  const a = verdict.accounting;
  if (a.kind === "no-prior-accounting") {
    return {
      ...base,
      licence: "new-account",
      contributionsKnown: true,
      why: "durable state was read and is empty — this account is genuinely new",
    };
  }
  if (a.kind === "unknown") {
    return { ...base, why: `the orchestrator could not establish durable state (${a.why})` };
  }
  // RESUME ALWAYS, BUT "KNOWN" ONLY ON RECEIPTS.
  //
  // These two are deliberately separated, because they answer different
  // questions and the dangerous move is to tie them together:
  //
  //   the LICENCE says "do not book an opening balance" and carries the
  //   high-water mark back. That must happen whatever the contributions look
  //   like — an unrestored peak is how a fee gets charged on principal.
  //
  //   contributionsKnown says "the total is evidence". It is true only when
  //   every flow in it names a transaction, because a flow without one was
  //   inferred from a balance change, and inferred flows are precisely what the
  //   mirror's cursor rewind re-copies into the shared database on every
  //   redeploy. A total containing them cannot be checked, so it is not known.
  //
  // The consequence is honest and recoverable: an agent whose history is all
  // inferred resumes safely, books nothing, and reports P&L as unavailable
  // until the deposit scan gives its flows transaction hashes.
  // THE CARRY'S REJECTION REASON IS THE MOST USEFUL SENTENCE THIS FILE CARRIES,
  // and it was validated strictly and then dropped. Without it a demoted bridge
  // surfaces only as an unexplained non-zero `unanchoredFlowCount`, and an
  // operator has no way to tell "the epoch opened with a figure that does not
  // match what the last one closed at" from any other kind of unevidenced flow.
  const carry = a.carryNote ? ` (epoch carry rejected: ${a.carryNote})` : "";
  const total = microToBigint(a.netContributionsUsdg);
  const anchored = a.anchoredContributionsUsdg === undefined ? null : microToBigint(a.anchoredContributionsUsdg);
  const unanchored = a.unanchoredFlowCount;
  const provenContributions = anchored !== null && unanchored === 0 && anchored === total;
  const observed = new Date(a.observedAt * 1000).toISOString();
  return {
    licence: "resume",
    contributionsKnown: provenContributions,
    netContributionsUsdg: total,
    highWaterMarkUsdg: microToBigint(a.highWaterMarkUsdg),
    lastObservedCashUsdg: a.lastObservedCashUsdg === null ? null : microToBigint(a.lastObservedCashUsdg),
    accountingEpoch: a.accountingEpoch,
    why: provenContributions
      ? `resuming from durable state observed ${observed}; every flow is evidenced${carry}`
      : anchored === null
        ? `resuming from durable state observed ${observed}, but the anchor predates the receipts-only total, ` +
          `so the contribution figure is unproven${carry}`
        : `resuming from durable state observed ${observed}, but ${unanchored ?? "some"} flow(s) carry no ` +
          `transaction (receipts total ${anchored}, all rows total ${total} micro-USDG) — the contribution ` +
          `figure rests on inference and cannot be checked${carry}`,
  };
}

/**
 * What the process currently believes about its own contributions.
 *
 * Separate from the licence because a licence is what a FILE says and this is
 * what the process has CONCLUDED, and the two must not be able to overwrite one
 * another in both directions.
 */
export interface ContributionTruth {
  known: boolean;
  /** Once set, no licence may raise `known` again for the life of the process. */
  doubted: boolean;
  why: string;
}

export const INITIAL_CONTRIBUTION_TRUTH: ContributionTruth = {
  known: false,
  doubted: false,
  why: "not armed yet",
};

/**
 * Fold a licence into what the process believes. PURE.
 *
 * DOUBT IS STICKY, AND THAT ASYMMETRY IS THE WHOLE FUNCTION.
 *
 * The anchor is not read only at startup: the child re-enters `syncGrant` on any
 * re-arm, and a transient executor failure is enough to cause one. Meanwhile the
 * two places that can CLEAR the flag — a material restart drift, and standing
 * down with no usable anchor — sit behind a first-observation guard and can fire
 * at most once per process.
 *
 * One-way false against two-way true means the doubt always loses. And
 * `contributionsKnown` is the sole gate on the performance fee, so losing it
 * means the fee comes back at full rate on a book the code had already declared
 * unknowable — silently, because the one-shot warning has already been logged.
 *
 * Nothing a file says can lift a doubt raised by observing the account. Lifting
 * it needs evidence — a chain-scanned flow carrying a transaction — and that
 * recovery does not exist yet, so the honest behaviour is to keep reporting
 * unknown until the process restarts and re-derives from a fresh anchor.
 */
export function foldLicence(prev: ContributionTruth, l: AccountingLicence): ContributionTruth {
  if (prev.doubted) return { known: false, doubted: true, why: `${l.why} — but ${prev.why}` };
  return { known: l.contributionsKnown, doubted: false, why: l.why };
}

/** Raise a doubt that no later licence may lift. PURE. */
export function doubt(why: string): ContributionTruth {
  return { known: false, doubted: true, why };
}

/**
 * What to do on the FIRST balance observation of a process. PURE.
 *
 * This is the money decision, extracted so it can be tested directly rather
 * than inferred from the shape of the code around it. Every arm is a deliberate
 * answer to "is this money a contribution?", and only one of them says yes.
 */
export type FirstObservationPlan =
  /** Book the whole balance as the opening contribution. Licensed, not guessed. */
  | { action: "book-opening-balance"; amountUsdg: bigint }
  /** The legacy self-hosted path, where the local ledger can answer for itself. */
  | { action: "legacy-local" }
  /** A funded account coming back. Book nothing; contributions stay known. */
  | { action: "resume-clean" }
  /**
   * A funded account coming back with cash that moved while it was down, and
   * nothing that can say why. Book nothing and mark contributions unknown.
   */
  | { action: "resume-with-drift"; driftUsdg: bigint }
  /** No usable durable state. Book nothing, claim nothing. */
  | { action: "stand-down"; why: string };

/**
 * WHY A DOWNTIME DELTA IS NEVER BOOKED.
 *
 * The tempting move is to treat `cash − anchorCash` as a deposit, and the old
 * code did a weaker version of exactly that against the local store. It is not
 * safe. A balance delta across a downtime window cannot distinguish a deposit
 * from a withdrawal from an in-flight UserOperation that landed while the
 * worker was down — and that last one is separately booked by
 * inflight-reconcile, so inferring it here would double-count it with the wrong
 * sign. An inferred delta is not an actual capital-flow event.
 *
 * The mechanism that DOES book a real deposit made during downtime is the chain
 * scan, which reads USDG Transfer logs and gives every flow a transaction hash.
 * When it is off or did not cover the window, a material delta means
 * contributions are no longer fully known — recorded as a gap, not papered over.
 */
export function planFirstObservation(args: {
  licence: OpeningBalanceLicence;
  equityUsdg: bigint;
  cashUsdg: bigint;
  anchorCashUsdg: bigint | null;
  materialDriftUsdg: bigint;
  why?: string;
}): FirstObservationPlan {
  if (args.licence === "self-hosted-local") return { action: "legacy-local" };
  if (args.licence === "new-account") {
    return { action: "book-opening-balance", amountUsdg: args.equityUsdg };
  }
  if (args.licence === "resume") {
    const drift = args.anchorCashUsdg === null ? 0n : args.cashUsdg - args.anchorCashUsdg;
    if (drift > args.materialDriftUsdg || drift < -args.materialDriftUsdg) {
      return { action: "resume-with-drift", driftUsdg: drift };
    }
    return { action: "resume-clean" };
  }
  return { action: "stand-down", why: args.why ?? "no usable accounting anchor" };
}

/** The one line an operator reads to know which accounting mode a child armed in. */
export function anchorLine(tenantId: string, v: AnchorVerdict): string {
  const head = `[anchor] ${tenantId.slice(0, 10)}`;
  if (v.kind !== "valid") return `${head} ${v.kind.toUpperCase()} — ${v.why}`;
  const a = v.accounting;
  if (a.kind === "established") {
    return (
      `${head} ESTABLISHED — hwm ${a.highWaterMarkUsdg} contributions ${a.netContributionsUsdg} ` +
      `cash ${a.lastObservedCashUsdg ?? "unknown"} epoch ${a.accountingEpoch} (micro-USDG)`
    );
  }
  if (a.kind === "no-prior-accounting") {
    return `${head} NEW — no durable accounting history; an opening balance may be booked`;
  }
  return `${head} UNKNOWN — the parent could not establish durable state (${a.why})`;
}
