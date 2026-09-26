/**
 * The hosted supervisor — one worker child per tenant.
 *
 * merrymen's worker keeps ~35 pieces of per-agent state (the `active` handle, the
 * money counters, the price/HWM caches, the discovery cursors) as locals INSIDE
 * main()'s closure, and only four true module globals (the sqlite handle, the
 * mainnet client, the grant-store cache, the ensureHome latch) — all per-process.
 * So a fresh PROCESS per tenant makes every one of them tenant-correct by
 * construction, with no in-process multiplexing to get wrong. That is the whole
 * tenancy model: this file fans main() out, one OS process at a time.
 *
 * WHAT IT DOES
 *  - reconcile: read the grant store, spawn a child for every tenant that has a
 *    grant and isn't running, stop the child of any tenant whose grant is gone
 *    (the kill switch);
 *  - each child gets its OWN MERRYMEN_HOME (…/children/<tenant>) with the tenant's
 *    session-key-only grant written to grant.json, and a curated env that carries
 *    the platform's house keys (bundler/RPC/LLM) but NOT the orchestrator-only
 *    secrets (the store DEK, the session secret, the database URL);
 *  - watchdog: a child whose heartbeat goes stale past a generous threshold is
 *    SIGKILLed and restarted — a JS timeout can't reclaim a spinning tick, only
 *    the OS can;
 *  - crash backoff, and a fleet-halt file that stands the whole band down.
 *
 * MULTI-REPLICA SAFETY. Before arming a tenant this takes a per-tenant Postgres
 * advisory lease (tenant-lease.ts) and holds it for the child's whole life, so a
 * second orchestrator replica can never also arm the same tenant and double its
 * daily spend. Without a shared database the lease is a no-op hold (one process
 * by construction). A lease that goes unhealthy — its connection dropped, so
 * Postgres released the lock — stands the child down rather than let it trade
 * unprotected.
 *
 * NOT YET (Phase B, before real funds): in-flight-UserOp reconciliation on
 * restart, so a SIGKILL between submit and ledger-write doesn't under-count
 * spend. That lives in the WORKER's arm path (it needs the chain client and the
 * ledger, which the child already has), and runs before the child seeds its
 * budget counters — noted at store.ts's fail-closed write and at the arm site.
 */
import { readRiskPeriod, RISK_PERIOD_SCHEMA } from "./risk-period";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "./db";
import { restorePaperCheckpoint, recordPaperRecoveryHealth } from "./paper-checkpoint";
import { repairHistoricalFills } from "./history-fill-repair";
import { makeConductor, type Conductor, type RosterMember } from "./groupchat/conductor";
import { chatProfileOf, type ChatProfile } from "./groupchat/facts";
import { describeCreds, groupChatCreds } from "./groupchat/voice";
// The fleet's default trading model, so the room can say when its own model is
// the same one (see groupChatModelWarning).
import { SETTINGS_DEFAULTS as GROUPCHAT_FLEET_DEFAULTS } from "../../packages/core/src/index";

let historyRepairStarted = false;
function startHistoryRepair(): void {
  if (historyRepairStarted || !process.env.DATABASE_URL) return;
  historyRepairStarted = true;
  void (async () => {
    const db = await makePgDb(process.env.DATABASE_URL!);
    await applyLedgerSchema(db);
    const result = await repairHistoricalFills(db, process.env.MERRYMEN_RPC_MAINNET ?? "https://rpc.mainnet.chain.robinhood.com");
    log(`historical fills: ${result.repaired} receipt-backed rows recovered; ${result.pnlRecovered} sale P&Ls recovered; ${result.unavailable} unavailable or ambiguous; reasons ${JSON.stringify(result.reasons)}`);
    // The chat's history files were read at spawn, before this ran. See refreshHistoryForLiveChildren.
    if (result.repaired + result.pnlRecovered > 0) await refreshHistoryForLiveChildren();
  })().catch(e=>log(`historical fills: FAILED — ${e instanceof Error ? e.message : String(e)}`));
}
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { merrymenHome } from "./home";
import { getGrantStore } from "./grant-store";
import { KILL_DONE_TEXT, honourKillRequest, killRequested, type KillOutcome } from "./kill-request";
import { hostedRecipient, telegramSend } from "./mcp/notify";
import { getIdentityStore } from "./identity-store";
import { getSettingsStore } from "./settings-store";
import { CHAT_SETTABLE, promotedSettings, readChatSettings, type ChatSettings } from "./telegram/chat-settings";
import { acquireTenantLease, type TenantLease } from "./tenant-lease";
import { CASH, DEFAULT_BASKET_SYMBOLS, isHolderProof, isHostedMode, STOCK_TOKENS, type MerrymenSettings } from "../../packages/core/src/index";
import { makePgDb, translateSchema, type Db } from "./db";
import { BOOTSTRAP_FILE, BOOTSTRAP_SCHEMA_VERSION, type TenantBootstrapState } from "./bootstrap-state";
import { deriveBootstrapAccounting } from "./bootstrap-source";
import { diagnoseAccounting, diagnosisLines } from "./accounting-diagnosis";
import { planReconstruction, reconstructionLines } from "./accounting-reconstruction";
import type { AccountPlan } from "./accounting-reconstruction";
import { accountPreviewLines, previewRequested, rosterLines, runPreview } from "./accounting-preview";
import { parseRepairOptions, repairLines, runRepair } from "./accounting-repair";
import { decomposeGas, gasAuditLines, type GasOp } from "./gas-audit";
import { cohortLines, vetCandidate, type CandidateVerdictDetail } from "./cohort-vetting";
import { datasetLines, viewRun } from "./brain-dataset";
import { auditIdentity, type GrantClaimLite, type IdentityRowLite } from "./identity-audit";
import { replayLines, scoreDecision, type Observation, type PricedDecision } from "./replay";
import { custodyAddressesOf } from "./custody";
import { scanFleetCapital } from "./chain-capital";
import { getFollowStore, MAX_FOLLOWS } from "./follow-store";
import { MIRROR_STATE_DDL, mirrorCountsLine, mirrorTenant, openChildLedger } from "./ledger-mirror";
import { lastRunOnDisk, recordStandDown } from "./stand-down";
import { TELEGRAM_STATE_DDL, publishTenantTelegram, readTenantTelegram } from "./telegram-store";
import { writePeersForChild } from "./peer-files";
import { writeResearchForChild } from "./research-files";
import { addressesOf, makeBuilderDesk, type BuilderDesk } from "./builder-pass";
import { makeNewsDesk, type NewsDesk } from "./research-pass";
import { peerThesesForSlugs, readPeerTheses } from "./peer-theses";
import type { PublicThesis } from "./thesis-policy";
import { ACCOUNTING_FIXED_AT, applyLedgerSchema } from "./store";
import { ORDER_IN_FLIGHT_MS, commandWhereabouts, dropCommandResult, drainCommandResults, writeCommand, type FileCommandResult } from "./command-files";
import { expiredOrderReceipt, type OrderReceipt } from "./order-receipt";
import { makeMcpBackground } from "./mcp/background";

/** How often to re-read the store for tenants added or killed. */
const RECONCILE_MS = 15_000;
/**
 * Mirror passes to wait before the cohort report runs.
 *
 * A child restarted by this deploy needs one tick (240s) to repopulate its
 * positions and one mirror cycle to push them up. At 15s a pass this is a
 * little over five minutes, comfortably past both.
 */
const COHORT_VET_AFTER_PASSES = 20;
/**
 * Earlier than the cohort report, and deliberately not the same pass.
 *
 * Eight passes of separation is about two minutes — long enough that the
 * audit is never queued behind the dataset's several hundred lines, and still
 * late enough that the ledger mirror has settled.
 */
const IDENTITY_AUDIT_AFTER_PASSES = 12;
let cohortPasses = 0;
/**
 * FLOOR for the staleness threshold. The real one is DERIVED per child — see
 * `staleThresholdSec`.
 *
 * A CONSTANT HERE WAS A BUG, AND IT WAS ARITHMETIC RATHER THAN A RACE. The
 * heartbeat is written once per tick, so the minimum possible gap between two
 * beats is the tick period. With `MERRYMEN_TICK_SECONDS=240` on the hosted
 * fleet and this fixed at 180, every child was SIGKILLed at ~185s — before its
 * SECOND TICK EVER RAN. Measured: all 71 observed `heartbeat stale` events
 * landed in a 181-196s band, which is exactly 180 plus one 15s poll interval.
 *
 * That killed the fleet in a loop: kill → re-arm → a 200,000-block getLogs
 * sweep → rate limits → a tick that dies before writing its beat → kill again.
 * Nothing about it required a slow RPC; the numbers alone guaranteed it.
 *
 * So the threshold is now computed from the tick this child actually runs, and
 * this value is only the lower bound for a fast one.
 */
const WATCHDOG_STALE_FLOOR_SEC = 180;
/** Don't watchdog a child until it's had a chance to write its first beat. */
const WATCHDOG_GRACE_SEC = 90;

/**
 * How long a child may take to write its FIRST beat, specifically.
 *
 * A SEPARATE NUMBER FROM `staleThresholdSec`, because a missing beat and a
 * stale one are judged differently and one of them used to be judged by
 * nothing at all: `beat === null` short-circuits the age comparison below, so
 * the derived 570-second threshold never applied to a child that had not
 * beaten yet — only the 90-second grace did.
 *
 * That was survivable while a child beat almost immediately. It stopped being
 * survivable when the worker started STAGGERING its first tick across a whole
 * tick period to spread the boot burst: every child whose derived slot landed
 * past 90 seconds was SIGKILLed before its first tick ran, and since the slot
 * is derived from the tenant it took the same slot on every restart and was
 * killed again, permanently. Measured on the hosted fleet: 18 kills in one
 * log window, all "never beat".
 *
 * The worker now beats at startup, before its staggered wait, which is the
 * real fix. This is the second half of it: the supervisor's patience for a
 * first beat is derived from the same tick the stagger is bounded by, so the
 * two cannot disagree again if either side changes.
 */
export function firstBeatGraceSec(tickSeconds: number): number {
  return WATCHDOG_GRACE_SEC + Math.max(0, Math.ceil(tickSeconds));
}
/** Cap a child's heap well below the container so an OOM kills the offender, not the box. */
const CHILD_MAX_OLD_SPACE_MB = 384;
/** Give up restarting a child that keeps dying right after start. */
const MAX_RESTARTS = 8;

/**
 * HOW LONG A GIVEN-UP TENANT STAYS GIVEN UP.
 *
 * `reconcile()` runs every 15 seconds and respawns anything in the roster that
 * is not currently running — with `restarts` defaulting to 0. So the exit
 * handler's ladder and its MAX_RESTARTS ceiling were both undone on a
 * fifteen-second timer: a tenant that "kept dying right after start" was
 * restarted a quarter of a minute later with a clean slate, climbed the ladder
 * again, gave up again, and was picked up again. Roughly nine restarts every
 * two minutes, for ever.
 *
 * That is expensive in exactly the currency the fleet is short of. Each restart
 * re-pays a cold arm — 28 sequential reads including a twenty-one-span,
 * 200,000-block getLogs walk — and throws away the in-process caches that exist
 * to stop million-block sweeps repeating.
 *
 * FIVE MINUTES, NOT FOR EVER. A tenant whose child cannot stay up is a real
 * problem that a human has to see, and a supervisor that stops trying entirely
 * turns a crash loop into a silent outage for that owner. The cool-off makes
 * the loop cheap; it does not make it permanent.
 */
const GIVE_UP_COOLOFF_MS = 5 * 60_000;

/**
 * Tenants the exit handler has given up on, and when they may be tried again.
 *
 * Deliberately NOT keyed to a child: the point is that it survives the child's
 * death, which is the only reason `reconcile` could see a clean slate.
 */
const gaveUpUntil = new Map<string, { until: number; restarts: number }>();

/**
 * ONE RESTART POLICY, because there were two and only one of them had a brake.
 *
 * The exit handler backed off and capped. The watchdog — the path a
 * rate-limited child actually takes, because a tick stuck retrying stops
 * beating — called `spawnChild` on the same line as the SIGKILL, with no delay
 * and no ceiling. So the failure mode the fleet is in is the one that got the
 * un-braked restart, and every one of those restarts is another cold arm
 * against the endpoint that caused it.
 */
function scheduleRestart(tenant: `0x${string}`, restarts: number, why: string, epoch: number): void {
  if (stopping) return;
  // The kill switch ended the run this restart belongs to. See `killEpoch`.
  if (epoch !== epochOf(tenant)) return;
  if (restarts > MAX_RESTARTS) {
    gaveUpUntil.set(tenant, { until: Date.now() + GIVE_UP_COOLOFF_MS, restarts });
    log(
      `${tenant} keeps dying right after start (${why}) — standing down for ` +
        `${Math.round(GIVE_UP_COOLOFF_MS / 60_000)}m rather than letting reconcile pick it straight back up`,
    );
    return;
  }
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(restarts, 5));
  log(`${tenant} rallying again in ${Math.round(delay / 1000)}s (restart #${restarts}, ${why})`);
  setTimeout(() => {
    if (epoch !== epochOf(tenant)) return;
    if (!stopping && !children.has(tenant)) void spawnChild(tenant, restarts);
  }, delay);
}

/**
 * How many times the kill switch has stood each tenant down. A run records
 * the count it was spawned under, and its restarts carry it.
 *
 * A RESTART BELONGS TO THE RUN THAT DIED, and a stand-down ends that run. The
 * stood-down child's own exit schedules a restart like any other exit. So
 * does a crash just before the kill. Either can fire after the stand-down,
 * up to 30 s later. If the owner re-signed meanwhile, it lands on the new
 * run: skipping its backoff, or spawning a second child beside the one
 * reconcile is spawning. And an exit at the top of the ladder set a
 * five-minute give-up that held the re-sign back. Bumping the count at the
 * stand-down makes every such restart a no-op, however late it fires.
 */
const killEpoch = new Map<string, number>();

function epochOf(tenant: string): number {
  return killEpoch.get(tenant) ?? 0;
}

/** The worker entrypoint each child runs — the same main() the CLI supervises. */
const WORKER_ENTRY = path.join(fileURLToPath(new URL(".", import.meta.url)), "index.ts");
/** Repo root (…/worker/src → up two), the cwd children need to resolve tsx + deps. */
const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/**
 * Env vars the orchestrator holds that a CHILD must NEVER see. The house keys
 * (bundler/RPC/LLM) are deliberately NOT here — hosted mode WANTS them injected,
 * that is the whole point of house-keys-server-only. What a child has no business
 * holding is the material that decrypts OTHER tenants' stored session keys (the
 * DEK), forges any tenant's session (the signing secret), or reaches the shared
 * grant database (the URL). Strip those; forward everything else so the child
 * still has PATH and the OS essentials node needs to run.
 */
const CHILD_SECRET_STRIP = [
  "MERRYMEN_STORE_DEK",
  "MERRYMEN_SESSION_SECRET",
  "DATABASE_URL",
  // THE NEWS PROVIDER TOKEN. A fourth kind of secret and it belongs here for a
  // fourth reason: it is not what a child could misuse, it is what a child
  // could LEAK. The whole point of fetching in the orchestrator is that the
  // credential lives on one process that talks to one vendor; a child holding
  // it could put it in a prompt, a decision row, a log line or a thesis, and
  // any of those is a published key. Stripping it makes "the Brain service
  // never sees this token" a fact about the process boundary rather than a
  // claim about our own carefulness. See research-files.ts.
  "MERRYMEN_MARKETAUX_API_KEY",
  // THE BUILDER DIRECTORY TOKEN, for the same reason and one extra.
  //
  // The same reason: a child holding it could put it in a prompt, a decision
  // row, a log line or a thesis, and any of those is a published key.
  //
  // The extra one is worth stating because it cuts the other way and could
  // otherwise be used to argue this entry is unnecessary. That directory
  // answers UNAUTHENTICATED at a lower rate limit, so a child stripped of the
  // key is not a child that cannot ask — research/hey.ts makes the request
  // either way. Which means the strip costs nothing and buys the boundary
  // outright, and there is no "but then the fetch fails" pressure to ever
  // remove it. See research/hey.ts.
  "MERRYMEN_HEY_API_KEY",
  // Privy authenticates PEOPLE at the web edge. A worker child acts for an
  // agent that is already authorized by a signed grant; it has no login to
  // verify and no reason to hold the key that would verify one.
  "PRIVY_APP_SECRET",
  /**
   * THE TELEGRAM BOT TOKEN, which is both kinds of entry on this list at once.
   *
   * A secret a child could leak, and an answer to a question about somebody
   * else. settings.ts:443 resolves it `str(file.telegramBotToken, env...)` —
   * file first, env as the FALLBACK — so an orchestrator environment that
   * ever carried this would hand the house bot to every tenant who has not
   * set one of their own. They would all long-poll the same bot, and a /link
   * from any chat would bind to whichever child answered first: control of
   * one stranger's agent handed to another.
   *
   * AND THE EXISTING GUARD WOULD NOT CATCH IT. `dedupeBotToken` compares the
   * tokens in tenants' SETTINGS, so tokens arriving by env are invisible to
   * it — the one collision it is built to prevent is the one it cannot see.
   *
   * Latent today: the variable is set nowhere in this repo and is absent from
   * the deployed environment. Stripped anyway, because the cost is one line
   * and the failure is silent, cross-tenant and indistinguishable from the
   * product working.
   */
  "MERRYMEN_TELEGRAM_BOT_TOKEN",
  /**
   * NOT A SECRET — AN ANSWER TO A QUESTION ABOUT SOMEBODY ELSE, which is why it
   * belongs on this list even though nothing here could leak or misuse it.
   *
   * Every path below writes `holderAddress` into the child's settings.json, and
   * settings.ts:235 reads `str(file.holderAddress, env.MERRYMEN_HOLDER_ADDRESS)`
   * — file first, env as the fallback. So the overwrite is authoritative for
   * every child that GETS a settings file, and silently inverted for every
   * child that does not: `writeChildSettings` returns early when a tenant's
   * settings are unreadable and again from its catch, and the child then spawns
   * with defaults and inherits the OPERATOR'S holder wallet from this process's
   * env. That child resolves the operator's balance as its own — Circle
   * strategies unlocked, performance fee discounted — for a tenant who may hold
   * nothing, and it happens on exactly the pass where something already went
   * wrong. It is the one holder path that fails OPEN.
   *
   * Stripped, the fallback has nothing to fall back to: no settings file means
   * no holder wallet, circle.ts reads that as the outsider floor, and the
   * failure mode is a tenant briefly missing perks they own rather than a
   * tenant silently granted perks they never bought. Self-hosted keeps its
   * variable — there is no orchestrator there, and no other tenant for one
   * operator's own wallet to be wrong about.
   */
  "MERRYMEN_HOLDER_ADDRESS",
  // THE GROUP CHAT'S OWN MODEL KEY. It exists so the room never spends the
  // fleet key trading shares; a child holding it could spend it on anything.
  "MERRYMEN_GROUPCHAT_LLM_KEY",
] as const;

/** Where a tenant's child keeps its own ~/.merrymen — isolated from every other. */
export function childHome(tenant: string): string {
  return path.join(merrymenHome(), "children", tenant.toLowerCase());
}

/** The fleet-halt marker: present = stop every child and spawn none. Operator-only. */
export function fleetHaltFile(): string {
  return path.join(merrymenHome(), "FLEET_HALT");
}

/**
 * TELEGRAM BOT COLLISION GUARD. A Telegram bot accepts exactly ONE long-poll
 * getUpdates loop per token — two children polling the same token would steal
 * each other's updates, and one tenant's bot could surface another's replies.
 * Each hosted tenant brings their OWN bot; if two ever share a token, only the
 * first (by the caller's iteration order) keeps it and the rest get Telegram
 * stripped rather than clobbering. Mutates `settings` and returns true when it
 * stripped a duplicate.
 */
export function dedupeBotToken(settings: MerrymenSettings, seen: Set<string>): boolean {
  const token = settings.telegramBotToken;
  if (!token) return false;
  if (seen.has(token)) {
    delete settings.telegramBotToken;
    return true;
  }
  seen.add(token);
  return false;
}

/**
 * A child's env: the orchestrator's env, minus the child-secret keys, plus this
 * tenant's home and the hosted flag. Inheriting (rather than allowlisting) keeps
 * the OS essentials and the injected house keys; the strip is what makes it safe.
 */
export function childEnv(tenant: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of CHILD_SECRET_STRIP) delete env[k];
  env.MERRYMEN_HOSTED = "1";
  env.MERRYMEN_HOME = childHome(tenant);
  /**
   * WHERE THE CHILDREN AGREE WITH EACH OTHER.
   *
   * MERRYMEN_HOME above is deliberately private per tenant — that isolation is
   * the point of it. But the RPC circuit breaker is a fact about the ENDPOINT,
   * not about a tenant: every child in this container reads one endpoint
   * through one egress IP, so a refusal one of them earns is true for all
   * fifteen. Held per-process it would be fifteen breakers that can each only
   * learn by being refused, and each of those refusals is load — which is the
   * thing causing the refusals.
   *
   * Passed explicitly rather than derived by walking up from MERRYMEN_HOME: a
   * child that computed the wrong parent would get a private file, a breaker
   * that silently coordinated with nobody, and no way to tell from the outside.
   */
  env.MERRYMEN_FLEET_HOME = merrymenHome();
  return env;
}

interface Child {
  proc: ChildProcess;
  tenant: `0x${string}`;
  /**
   * The SMART ACCOUNT this child trades from.
   *
   * KEPT BESIDE THE TENANT BECAUSE THEY ARE NOT THE SAME ADDRESS, and one
   * seam in this file had already forgotten it. `agent_id` in every shared
   * table is the ERC-4337 account (`ensureAgent` writes `grant.smartAccount`);
   * `children` is keyed by the SIWE wallet. grant-store.ts:69-82 says the two
   * "can never be equal" — the owner key is generated in the browser — and
   * agent-for.ts was written because a route that compared them "matched zero
   * rows for every hosted user" and failed closed, looking like a quiet agent.
   *
   * Held here rather than re-read per pass: `writeGrantForChild` already
   * returns it at spawn, and the alternative is a decrypting store read every
   * fifteen seconds for an address that changes only on a re-sign.
   */
  smartAccount: `0x${string}`;
  startedAt: number;
  restarts: number;
  /** The tenant's kill-switch count when this child was spawned. Its restarts carry it. See `killEpoch`. */
  epoch: number;
  /**
   * Seconds without a heartbeat before this child is considered wedged.
   *
   * Per child rather than global, because `tickSeconds` is per tenant: the
   * settings file the orchestrator writes for a child can override the fleet
   * env var (settings.ts resolves file BEFORE env), so one global number cannot
   * be correct for every child at once.
   */
  staleSec: number;
  /**
   * Seconds this child may take to write its FIRST beat.
   *
   * Derived alongside `staleSec` and from the same tick, because the worker
   * staggers its first tick across one whole tick period — see
   * `firstBeatGraceSec`.
   */
  firstBeatSec: number;
}

/**
 * How long to wait for a beat from a child whose tick is `tickSeconds`.
 *
 * TWO TICKS PLUS THE GRACE PERIOD. One tick is the floor by definition — a beat
 * cannot arrive sooner — so one tick of margin allows a single slow or failed
 * pass without declaring the process dead, and the grace absorbs the watchdog's
 * own 15s polling granularity. Below that, a healthy agent on a slow RPC is
 * indistinguishable from a wedged one.
 *
 * Exported for the test that pins the invariant this replaced.
 */
export function staleThresholdSec(tickSeconds: number): number {
  return Math.max(WATCHDOG_STALE_FLOOR_SEC, Math.ceil(tickSeconds) * 2 + WATCHDOG_GRACE_SEC);
}

const children = new Map<string, Child>();

/**
 * Test seam: count a child as running without spawning a worker, so a test
 * can drive the real reconcile() over it. The fake needs only `kill`.
 */
export function adoptChildForTest(
  tenant: `0x${string}`,
  smartAccount: `0x${string}`,
  proc: Pick<ChildProcess, "kill">,
): void {
  const lc = tenant.toLowerCase() as `0x${string}`;
  children.set(lc, { proc: proc as ChildProcess, tenant: lc, smartAccount, startedAt: Date.now(), restarts: 0, epoch: epochOf(lc), staleSec: 600, firstBeatSec: 600 });
}
/**
 * The advisory lease held for each tenant we are running, keyed by lowercased
 * tenant. Acquired in reconcile() BEFORE the first spawn and held across crash
 * restarts (never re-acquired per process — a restart must not open a window for
 * another replica). Released only when the tenant is no longer wanted (kill
 * switch), when its lease goes unhealthy, or on shutdown.
 */
const leases = new Map<string, TenantLease>();

/**
 * Tenants whose home this replica has held the lease over ever since a child
 * of ours last wrote to it. Set when a child is spawned. Cleared whenever
 * the lease is let go: released, lost, or dropped by a fleet halt.
 *
 * A held lease alone does not say this. reconcile() takes one before a spawn,
 * and the spawn can stop short, e.g. when the grant is deleted between the
 * tenant list and the grant read. The lease is then held over a home an
 * earlier run left, perhaps before a halt, and perhaps before another
 * replica ran the tenant. Only a home in this set may be mirrored with no
 * child running: `positions` and `cost_basis` mirror as delete-then-insert
 * snapshots, so a stale copy would overwrite the live rows.
 */
const ledgerOwned = new Set<string>();
let stopping = false;

function log(msg: string): void {
  console.log(`[orchestrator] ${msg}`);
}

/** Release and forget a tenant's lease. Best-effort; safe if none is held. */
async function releaseLease(tenant: string): Promise<void> {
  ledgerOwned.delete(tenant);
  const lease = leases.get(tenant);
  if (!lease) return;
  leases.delete(tenant);
  try {
    await lease.release();
  } catch {
    /* best-effort — a dropped connection has already released the lock */
  }
}

/** Read a child's heartbeat `at` (unix seconds), or null if it hasn't beaten yet. */
function heartbeatAt(tenant: string): number | null {
  return heartbeatAtIn(childHome(tenant));
}

/**
 * The watchdog's read of the heartbeat file in one home — exported so a test
 * can read what the child's clock wrote exactly the way the watchdog will.
 */
export function heartbeatAtIn(home: string): number | null {
  try {
    const hb = JSON.parse(readFileSync(path.join(home, "heartbeat.json"), "utf8")) as { at?: number };
    return typeof hb.at === "number" ? hb.at : null;
  } catch {
    return null;
  }
}

/**
 * A CHILD’S TELEGRAM RUNTIME STATE, WHICH ONLY THIS PROCESS CAN SEE.

 * The child mints its link code on boot and writes it into its own home. The
 * dashboard read `merrymenHome()/telegram.json` on the WEB container, where
 * nothing has ever written one — so `linkCode` was null for every hosted tenant
 * and the Telegram panel rendered a placeholder where a six-character code
 * should be. Two testers stopped there: "I’m stuck at this point, no code from
 * /link".
 *
 * The orchestrator is the only process that can see both a child’s home and the
 * shared database — children have DATABASE_URL stripped on purpose — so it
 * ferries, exactly as it does for the ledger and for command results.
 */
function readChildTelegram(tenant: string): {
  linkCode: string | null;
  ownerId: number | null;
  linkedAt: number | null;
  linkedChats: number[];
  chatSettings: { at: number; patch: Record<string, unknown> } | null;
} | null {
  try {
    const raw = readFileSync(path.join(childHome(tenant), "telegram.json"), "utf8").replace(/^﻿/, "");
    const t = JSON.parse(raw) as Record<string, unknown>;
    return {
      linkCode: typeof t.linkCode === "string" && t.linkCode ? t.linkCode : null,
      ownerId: typeof t.ownerId === "number" ? t.ownerId : null,
      linkedAt: typeof t.linkedAt === "number" ? t.linkedAt : null,
      linkedChats: Array.isArray(t.linkedChats)
        ? (t.linkedChats as unknown[]).filter((c): c is number => typeof c === "number")
        : [],
      chatSettings: readChatSettings(t.chatSettings),
    };
  } catch {
    // No file yet (no bot token set, or the child has not booted) is not an
    // error and must not be published as an empty code — that would overwrite a
    // real one during a restart. The caller skips instead.
    return null;
  }
}

/**
 * Publish the code, and PROMOTE ANY CHAT THE OWNER LINKED into their stored
 * allowlist.
 *
 * The second half is what makes a hosted /link stick. The child authorizes the
 * chat by patching its OWN settings.json — and `writeSettingsForChild` replaces
 * that file wholesale from the tenant store on the next pass, fifteen seconds
 * later, with the link code already spent by the rotation. So the tester linked,
 * it worked, and it stopped working before they could use it.
 *
 * A READ-MODIFY-WRITE, AND ONLY WHEN SOMETHING IS ACTUALLY NEW. `put` replaces
 * the whole sealed blob and the web is its other writer, so an unconditional
 * write on a 15-second loop would race a tenant typing on the settings page and
 * silently discard their save. Guarded this way the write happens once, in the
 * seconds after a successful link, and never again — and removing a chat from
 * the dashboard still works, because the child only ever reports chats it has
 * just linked, and a code cannot be reused once it has rotated.
 */
/**
 * PUT THE TENANT'S TELEGRAM LINK BACK, before the child starts.
 *
 * The counterpart to `publishChildTelegram`, and its absence was a real defect
 * rather than an omission of convenience. `childHome()` is ephemeral — the
 * orchestrator runs with no volume — so every redeploy destroyed
 * `telegram.json`, and `ownerId` is the ONLY recipient the notifier will send
 * to (`state.ownerId === null` returns early). Grant, settings and bootstrap
 * were all seeded back on spawn; the telegram link was not, and it is the one
 * that decides whether an owner ever hears from their agent again.
 *
 * The symptom was silent and easy to misread: the bot still answered /status,
 * because a reply goes to whoever sent the message, while every ping, alert and
 * daily report stopped. The link code had rotated too, so the owner's old one
 * no longer worked and re-linking meant a trip to the dashboard nobody
 * suggested.
 *
 * ONLY WHEN THE CHILD HAS NO FILE. A running child is the authority on its own
 * link — it may have just been re-linked to a different chat — and this must
 * restore a lost link, never overwrite a live one.
 */
async function writeTelegramForChild(tenant: `0x${string}`, shared?: Db): Promise<void> {
  const file = path.join(childHome(tenant), "telegram.json");
  if (existsSync(file)) return;
  const url = process.env.DATABASE_URL;
  if (!url && !shared) return;
  try {
    const tg = await readTenantTelegram(shared ?? (await makePgDb(url!)), tenant);
    let ownerId = tg?.ownerId ?? null;

    // THE MIRROR IS USUALLY EMPTY TOO, so fall back to the allowlist.
    //
    // `tenant_telegram.owner_id` is only ever written while a child HAS a
    // telegram.json — and the file is destroyed by the same redeploy that this
    // function exists to repair. Measured on the fleet: 4 tenants hold a bot
    // token, 2 completed a link, and 0 had a live owner_id. The mirror had
    // nothing to give back.
    //
    // `telegramAllowlist` is in the SEALED SETTINGS and survives. It is
    // populated by `publishChildTelegram` promoting every chat that ran /link,
    // so a positive id in it is a person who explicitly linked their own DM —
    // Telegram gives users positive ids and groups negative ones, and restoring
    // a group as the owner would start sending an agent's private reports to a
    // room. The lowest positive id is the earliest linker, which is the same
    // chat `/link` would have made the owner.
    //
    // A heuristic, and logged as one, because it recovers a recipient rather
    // than reading one.
    if (!ownerId) {
      const stored = await getSettingsStore().get(tenant);
      const list = Array.isArray(stored?.telegramAllowlist) ? stored.telegramAllowlist : [];
      const dm = list.filter((c) => typeof c === "number" && c > 0).sort((a, b) => a - b)[0];
      if (dm !== undefined) {
        ownerId = dm;
        log(`${tenant}: telegram owner recovered from the stored allowlist — no mirrored link survived`);
      }
    }
    // Nothing to restore is the ordinary state of a tenant who never linked.
    // An empty file would only mask a later genuine publish.
    if (!ownerId) return;
    mkdirSync(childHome(tenant), { recursive: true });
    writeFileSync(
      file,
      // `ownerId` is the recovered one, which may have come from the allowlist
      // rather than the mirror. The link CODE is not recovered — it rotates on
      // every link and a stale one would be worse than none, so the child mints
      // a fresh code and the dashboard shows it.
      JSON.stringify({ linkCode: tg?.linkCode ?? "", ownerId, linkedAt: tg?.linkedAt ?? 0 }, null, 2),
    );
    log(`${tenant}: telegram link restored — the owner keeps receiving alerts`);
  } catch (e) {
    // Never fatal. A child with no telegram link still trades; it just cannot
    // tell anyone about it, which is the status quo this repairs.
    log(`${tenant}: could not restore telegram state — ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function publishChildTelegram(tenant: `0x${string}`, shared: Db): Promise<void> {
  const tg = readChildTelegram(tenant);
  if (!tg) return;
  try {
    await publishTenantTelegram(shared, tenant, {
      linkCode: tg.linkCode,
      ownerId: tg.ownerId,
      linkedAt: tg.linkedAt,
    });
  } catch (e) {
    log(`${tenant}: could not publish telegram state — ${e instanceof Error ? e.message : String(e)}`);
  }
  // EVERY PASS, AND BEFORE THE EARLY RETURNS BELOW. This call used to sit at
  // the end of the function, after `return`s that fire whenever there is no
  // newly linked chat to add — which is every steady-state pass, and every
  // pass after a redeploy (telegram.json is rewritten without linkedChats). So
  // a setting changed from chat was promoted only in the one pass that also
  // added a chat to the allowlist, and otherwise reverted fifteen seconds
  // later. It does its own read-modify-write, so running it first is safe.
  await promoteChatSettings(tenant, tg.chatSettings);
  if (tg.linkedChats.length === 0) return;
  try {
    const stored = (await getSettingsStore().get(tenant)) ?? {};
    const have = new Set(Array.isArray(stored.telegramAllowlist) ? stored.telegramAllowlist : []);
    const missing = tg.linkedChats.filter((c) => !have.has(c));
    if (missing.length === 0) return;
    for (const c of missing) have.add(c);
    await getSettingsStore().put(tenant, { ...stored, telegramAllowlist: [...have] });
    log(`${tenant}: telegram link promoted — ${missing.length} chat(s) added to the stored allowlist`);
  } catch (e) {
    log(`${tenant}: could not promote telegram link — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * PUT A CHANGE THE OWNER MADE FROM CHAT INTO THE SETTINGS THAT SURVIVE.
 *
 * /strategy and /cap wrote the child's settings.json and nothing else, and
 * `writeSettingsForChild` replaces that file wholesale from the tenant store
 * every fifteen seconds. Hosted, the bot answered "strategy → dip-hunter", the
 * owner watched it revert, and nothing anywhere said why. Self-hosted there is
 * no orchestrator, so both always worked — which is how it survived this long.
 *
 * The allowlist, the `at` guard and the race they leave are all in
 * telegram/chat-settings.ts, where a test can execute them — this function is
 * the store round-trip around that decision and nothing else.
 */
async function promoteChatSettings(tenant: `0x${string}`, chat: ChatSettings | null): Promise<void> {
  if (!chat) return;
  try {
    const stored = (await getSettingsStore().get(tenant)) ?? {};
    const next = promotedSettings(stored, chat);
    if (!next) return;
    await getSettingsStore().put(tenant, next);
    const names = Object.keys(chat.patch).filter((k) => CHAT_SETTABLE.has(k));
    log(
      names.length
        ? `${tenant}: telegram settings promoted — ${names.join(", ")}`
        : `${tenant}: telegram settings change carried nothing this build accepts`,
    );
  } catch (e) {
    log(`${tenant}: could not promote telegram settings — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Write the tenant's session-key-only grant into its child's grant.json. */
async function writeGrantForChild(tenant: `0x${string}`): Promise<`0x${string}` | null> {
  // A TELEGRAM KILL IS PENDING: hand this home no key. See kill-request.ts.
  if (killRequested(childHome(tenant))) return null;
  const grant = await getGrantStore().get(tenant);
  if (!grant) return null;

  // BACKFILL THE PUBLIC ID.
  //
  // POST /api/grants mints one on SIGNATURE, and nothing re-signs — so every
  // agent granted before the identity store existed has no row, and its posts
  // render unlinked for ever. ensure() is idempotent and never changes an
  // existing slug, so this is a no-op after the first pass.
  //
  // HERE AND NOT ELSEWHERE. The grant is already in hand, so this costs no
  // extra read of a store that decrypts. Every tenant passes through here on
  // spawn, so one deploy covers the fleet. It cannot live in a CHILD:
  // CHILD_SECRET_STRIP removes DATABASE_URL and getIdentityStore() picks its
  // backend on exactly that variable, so a child would silently write a file
  // the web tier never reads. And it must not live in the public read path —
  // those routes are cached and unauthenticated, and an anonymous GET that
  // mints identities is a write nobody asked for.
  //
  // Best effort: an identity hiccup must never stop a tenant being armed.
  try {
    await getIdentityStore().ensure(tenant, grant.smartAccount as `0x${string}`);
  } catch (e) {
    log(`${tenant}: could not mint a public id — ${e instanceof Error ? e.message : String(e)}`);
  }

  const home = childHome(tenant);
  mkdirSync(home, { recursive: true });
  // grant.json holds the SESSION key (the store already refused any owner key),
  // so keep it owner-only. chmod is a POSIX no-op that throws on Windows — the
  // container is Linux, and self-hosted never runs the orchestrator.
  writeFileSync(path.join(home, "grant.json"), JSON.stringify(grant, null, 2), { encoding: "utf8", mode: 0o600 });
  // The SMART ACCOUNT, returned rather than discarded: it is the key every
  // ledger table is on, the caller needs it to derive the accounting anchor, and
  // the grant is the only place the orchestrator can learn it without a second
  // decrypting read.
  return grant.smartAccount as `0x${string}`;
}

/**
 * HAND A RUNNING CHILD A GRANT THAT WAS RE-SIGNED UNDER IT.
 *
 * THE BUG THIS CLOSES. `writeGrantForChild` is called from `spawnChild` and
 * nowhere else, while the reconcile below refreshes `settings.json` for every
 * running child on every pass. So a config change reached a live agent in
 * fifteen seconds and A NEW SIGNATURE NEVER REACHED IT AT ALL.
 *
 * That is not a theoretical gap. `restoreAgentWallet`'s own doc calls itself
 * "the RE-SIGN path for widening the tradable set: adding a token in settings
 * can't reach into an already-signed key, so covering it means minting a new
 * grant over the same account." An owner does exactly that — adds a token,
 * re-signs, watches the server accept it, sees the new grant on /grant — and
 * their agent goes on refusing the token with `asset-allowlist` until something
 * unrelated restarts the child. The wall it is enforcing is the OLD one,
 * because the old one is the only file it has.
 *
 * The child is already willing: it re-reads `grant.json` every tick and re-arms
 * when `smartAccount` or `grantedAt` changes (index.ts:2620-2623). It was never
 * given the new file.
 *
 * WRITE ONLY ON CHANGE, and compare the WHOLE serialized grant rather than a
 * key. `grantedAt` is whole seconds — index.ts:2566-2568 makes that point about
 * its own dedup — so a key comparison here could miss a re-sign, and the cost
 * of being wrong is an agent enforcing a wall its owner has replaced. A string
 * compare cannot miss one. (The child's own re-arm still keys on `grantedAt`,
 * so two re-signs inside one second remain its edge, not ours.)
 *
 * NOT `writeGrantForChild`. That one also mints a public identity, which is
 * spawn-time work: idempotent, but a store write, and running it for every
 * tenant every fifteen seconds would be pure waste.
 *
 * NEVER INTO A HOME WITH A PENDING KILL. The "no file, write it" rule below
 * is how a hosted Telegram /kill used to come undone: the child deleted its
 * copy, and this function put it back from the store within a pass. Until
 * reconcile has removed the stored grant, the missing file is the kill.
 */
async function refreshGrantForChild(tenant: `0x${string}`): Promise<void> {
  if (killRequested(childHome(tenant))) return;
  let grant;
  try {
    grant = await getGrantStore().get(tenant);
  } catch {
    // An unreadable store is not a revoked grant. Leave the child with the wall
    // it has; the kill switch below is what stands an agent down.
    return;
  }
  if (!grant) return;

  const file = path.join(childHome(tenant), "grant.json");
  const next = JSON.stringify(grant, null, 2);
  try {
    if (readFileSync(file, "utf8") === next) return;
  } catch {
    // No file, or unreadable — writing it is the right answer either way.
  }
  writeFileSync(file, next, { encoding: "utf8", mode: 0o600 });
  // AND THE ACCOUNT WITH IT. A re-sign under a new owner key derives a new
  // smart account, and that is the address the shared tables are keyed on — so
  // a child left holding the old one would be looked up under an account that
  // no longer trades. Same reason the file is rewritten: the wall moved.
  const child = children.get(tenant);
  if (child && grant.smartAccount) child.smartAccount = grant.smartAccount as `0x${string}`;
  log(`${tenant}: grant changed on the store — handed the running child its new wall`);
}

/**
 * Hand the child the tenant's OWN settings.json from the store — their strategy,
 * basket, custom tokens, sizing, their Telegram bot. No-op if the tenant has
 * saved nothing yet (the child then runs the safe defaults). Refreshed every
 * reconcile so a config change propagates: the worker re-reads settings.json each
 * tick, and mergeSettings strips house keys + forces the RCE flags off, so what
 * the tenant stored can only ever be their own legitimate configuration.
 */
async function writeSettingsForChild(
  tenant: `0x${string}`,
  seenBotTokens?: Set<string>,
): Promise<MerrymenSettings | null> {
  try {
    const settings = await getSettingsStore().get(tenant);
    // THE UNIVERSE IS RECORDED EVEN WHEN NOTHING WAS SAVED, and that is the fix.
    //
    // This used to be set below, AFTER the early return — so a tenant who never
    // opened the settings screen was recorded as having an empty universe,
    // while the CHILD falls back to DEFAULT_BASKET_SYMBOLS and reasons about
    // those symbols all day (settings.ts:262). The desk's per-tenant filter
    // then matched nothing, the child's research file arrived with an empty
    // `asked` list, and the news lens reported `not-fetched` for every symbol
    // the agent actually holds — "nobody ever asked" — even on ticks where the
    // fetch had succeeded and stories were sitting in the file.
    //
    // Resolved the SAME WAY THE CHILD RESOLVES IT, so the orchestrator's
    // picture of a tenant's universe matches what that tenant actually trades.
    // This narrows nothing and widens nothing: it is the same list either way.
    tenantWatchSymbols.set(
      tenant.toLowerCase(),
      equitySymbols(settings?.basketSymbols ?? [...DEFAULT_BASKET_SYMBOLS]),
    );
    // THE GROUP CHAT'S PUBLIC PROFILE, projected here because this is the one
    // place the sealed settings are already open every pass — a second read
    // would double the decrypting SELECTs. chatProfileOf keeps a publishable
    // strategy name and trait words and nothing else; the blob goes no further.
    tenantChatProfile.set(tenant.toLowerCase(), chatProfileOf(settings));
    if (!settings) return null;
    if (seenBotTokens && settings.telegramBotToken && dedupeBotToken(settings, seenBotTokens)) {
      log(`${tenant}: telegram bot token already claimed by another tenant — telegram disabled for this child`);
    }
    /**
     * WHOSE $MERRYMEN BALANCE DECIDES THE CIRCLE TIER — settled here, by the
     * only process that knows the answer.
     *
     * TWO FAULTS, ONE LINE. `cfg.holderAddress` is what the child reads to
     * resolve its tier (index.ts, readHolderStatus), and the tier is what gates
     * `even-keel` and `dip-hunter` at the top of the tick. Hosted, NO SCREEN IN
     * THE PRODUCT EVER WRITES THAT FIELD — it exists in the settings PUT
     * handler and in /api/circle, which has no caller — so it is undefined for
     * every tenant, circle.ts returns OUTSIDER on the spot, and half the
     * create-time strategy picker has been inert for the whole beta no matter
     * how much of the token anybody holds. A tester reported it as the agent
     * "hasn't bought automatically a single stock token during all day".
     *
     * And it was SELF-DECLARED. The field is tenant-settable, shape-validated
     * and nothing more, so anyone could have named a whale's address and
     * claimed the tier. /api/alpha refuses to use this field for exactly that
     * reason, in as many words: "fine for a fee discount an owner claims for
     * themselves, never an authorisation input."
     *
     * The orchestrator holds the one address that is neither missing nor
     * self-declared: the tenant is the wallet the session was verified against.
     * Writing it here makes the gate satisfiable AND authoritative in the same
     * move — a holder gets what they paid for, and naming someone else's
     * wallet stops working, because this overwrite is unconditional.
     *
     * SELF-HOSTED IS UNTOUCHED. There is no orchestrator there, so a single
     * operator's own `holderAddress` (or MERRYMEN_HOLDER_ADDRESS) stays exactly
     * as it was — there is no other tenant for it to be wrong about.
     */
    /**
     * A PROVEN WALLET OUTRANKS THE LOGIN ONE — and only a proven one does.
     *
     * Writing the tenant here made the tier earnable and authoritative, and it
     * shut out the case a tester raised: "you don't own tokens in your privy
     * based wallet and you have them somewhere else… the app should have the
     * possibility to define the holder address."
     *
     * `holderProof` is that possibility, and it is a different KIND of value
     * from `holderAddress` beside it. `holderAddress` is typed in — anyone can
     * name a whale's wallet — so it is still overwritten and still not trusted.
     * `holderProof` is written by /api/holder and by nothing else, after
     * recovering a signature over a message naming BOTH the wallet and this
     * account. The settings PUT handler has no branch for it, so a tenant
     * cannot forge one through the API they do have.
     *
     * Shape-checked before use, because a settings blob is data: a malformed
     * proof falls back to the tenant rather than reaching `balanceOf` as
     * whatever it happens to be.
     */
    const proven = isHolderProof(settings.holderProof) ? settings.holderProof.address : null;
    const forChild: MerrymenSettings = {
      ...settings,
      holderAddress: (proven ?? tenant) as `0x${string}`,
    };
    const home = childHome(tenant);
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "settings.json"), JSON.stringify(forChild, null, 2), { encoding: "utf8", mode: 0o600 });
    // The universe this tenant may trade, kept for the news desk. Recorded here
    // because this is the one place the orchestrator reads a tenant's settings,
    // and it runs on every reconcile — so an owner who changes their basket
    // changes what the desk asks about within a pass.
    // (recorded above, before the early return — see the comment there)
    // Returned so the caller can size the watchdog to the tick THIS child will
    // read. Nothing else about the write changes.
    return settings;
  } catch {
    /* best-effort — the child falls back to defaults */
    return null;
  }
}

/**
 * Write the tenant's accounting anchor into its child's home.
 *
 * WHY THIS RUNS EVEN WHEN IT FAILS. The child's home survives a child restart
 * but not a deploy, so a file left over from a previous pass can be both
 * present and wrong. Writing the `unknown` arm on failure REPLACES that
 * leftover with an explicit "the parent could not establish this", which the
 * child fails closed on. Skipping the write on failure would leave the stale
 * file in place and let a child resume from figures nobody re-verified — the
 * strictly less safe of the two options, so the write is unconditional.
 *
 * Best-effort in the sense that it never throws and never blocks a spawn: an
 * agent that cannot get an anchor still arms, still runs its risk controls and
 * still reconciles. What it does not do is book contributions.
 */

/**
 * GIVE A REBUILT CHILD BACK ITS COST BASIS BEFORE IT ARMS.
 *
 * A child's ledger is in its container's own sqlite with no volume, so every
 * redeploy destroys `cost_basis`. The mirror carries it UP and nothing carries
 * it back, so a position bought before the redeploy sells with no basis and its
 * realised P&L is dropped — `applyFill` reports `basisUnknown`, correctly, for
 * a sell with nothing on the books.
 *
 * `restoreClassCostBasis` already solves this for CLASS positions off the
 * vault's own ClassBuy events. An ordinary swap has no such event: the cost was
 * only ever known to the ledger, so the ledger is where it comes back from.
 *
 * BEFORE spawn, with the grant and the anchor, and for the same reason — the
 * child reads its book while arming, and a basis that landed a moment later
 * would be read as absent.
 */
async function seedBasisForChild(tenant: `0x${string}`, smartAccount: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return; // self-hosted: the child's own sqlite is the only copy
  const raw = new DatabaseSync(path.join(childHome(tenant), "merrymen.db"));
  const handle = {db:wrapSqlite(raw),close:()=>raw.close()};
  try {
    const { planBasisSeed, basisSeedLine } = await import("./basis-seed");
    const shared = await makePgDb(url);
    const have = (await handle.db
      .prepare("SELECT COUNT(*) AS n FROM cost_basis WHERE mode = 'live'")
      .get()) as { n: number } | undefined;
    const rows = (await shared
      .prepare("SELECT mode, symbol, qty_raw, cost_usdg FROM cost_basis WHERE lower(agent_id) = lower($1) AND mode = 'live'")
      .all(smartAccount)) as unknown as Record<string, unknown>[];
    // WHAT THE BOOK STILL SAYS IS HELD. The shared cost_basis copy goes stale
    // in one way — the mirror skips its DELETE while the child reads rebuilt —
    // so without this the seed would restore the cost of a position already
    // sold. See planBasisSeed.
    const heldRows = (await shared
      .prepare("SELECT symbol FROM positions WHERE lower(agent_id) = lower($1) AND raw_balance <> '0'")
      .all(smartAccount)) as unknown as Record<string, unknown>[];
    const plan = planBasisSeed({
      childRowCount: Number(have?.n ?? 0),
      heldSymbols: heldRows.map((r) => String(r.symbol ?? "")),
      shared: rows.map((r) => ({
        mode: String(r.mode ?? "live"),
        symbol: String(r.symbol ?? ""),
        qtyRaw: String(r.qty_raw ?? "0"),
        costUsdg: String(r.cost_usdg ?? "0"),
      })),
    });
    log(basisSeedLine(tenant, plan));
    for (const r of plan.rows) {
      await handle.db
        .prepare(
          `INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at)
           VALUES (?, ?, ?, ?, ?, unixepoch())
           ON CONFLICT(agent_id, mode, symbol) DO NOTHING`,
        )
        .run(smartAccount, r.mode, r.symbol, r.qtyRaw, r.costUsdg);
    }
  } catch (e) {
    // Loud, because a silent failure here is a book that sells with no cost and
    // reports no P&L — the exact defect this exists to close.
    log(`basis seed: ${tenant} FAILED — ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    handle.close();
  }
}

/**
 * When a child's own ledger began: its earliest account-value mark, flow,
 * trade row or decision (a book that cannot be valued writes decisions and
 * nothing else), or null when it holds none (a home a redeploy just wiped, or
 * a ledger that cannot be read — the caller then takes the spawn time).
 * Read-only and synchronous; the child may be writing to it.
 *
 * One orchestrator replica is assumed: a ledger kept while ANOTHER replica ran
 * the tenant would have a hole this start cannot see, and that run's trades
 * would be neither carried nor in the ledger.
 */
function ledgerStartOf(tenant: string): number | null {
  const file = path.join(childHome(tenant), "merrymen.db");
  if (!existsSync(file)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const r = db
      .prepare("SELECT MIN(t) AS t FROM (SELECT MIN(at) AS t FROM equity UNION ALL SELECT MIN(at) FROM flows UNION ALL SELECT MIN(created_at) FROM trades UNION ALL SELECT MIN(at) FROM decisions)")
      .get() as { t: number | null } | undefined;
    return typeof r?.t === "number" ? r.t : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Per tenant, the newest history read — so an older one never lands last. */
const historyRuns = new Map<string, number>();

/**
 * THE TRADES FROM BEFORE THE REDEPLOY, for the child's Telegram chat to answer
 * from (history-files.ts). The child cannot read the shared database, and its
 * own ledger just started empty, so without this "what did you buy yesterday"
 * is answered from a tape that begins at the restart.
 *
 * NOT awaited by spawn, unlike the seeds above: nothing reads this file while
 * arming — the chat reads it when asked — so a slow shared database must never
 * hold a trading agent back for it. Nothing that trades or accounts reads it.
 */
async function writeHistoryForChild(tenant: `0x${string}`, smartAccount: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return; // self-hosted: the child's own ledger is never wiped
  // WHERE THIS CHILD'S OWN LEDGER BEGINS — BEFORE ANY AWAIT, and so before a
  // spawn's child exists. Carried rows and account-value marks are all older
  // than this, the child's own all at or after it, and the chat joins the two
  // only on that condition (history-files.ts HistoryAccount). A redeploy wipes
  // the home, so after one the ledger begins now; a crash, watchdog or lease
  // restart keeps it, and it began at its first row — the spawn time would put
  // the old run's rows on both sides, and a deposit in both.
  const nowSec = Math.floor(Date.now() / 1000);
  const until = Math.min(nowSec, ledgerStartOf(tenant) ?? nowSec);
  // Two spawns can overlap (a crash restart while the last read is still
  // running), and the older read must not land last — after a re-sign it would
  // be for the old account, and the chat would refuse it until the next spawn.
  const run = (historyRuns.get(tenant) ?? 0) + 1;
  historyRuns.set(tenant, run);
  try {
    const { loadHistoryFromShared, writeHistoryFile } = await import("./history-files");
    const file = await loadHistoryFromShared(await makePgDb(url), smartAccount, nowSec, { until });
    if (historyRuns.get(tenant) !== run) return;
    // False when the home is gone: the tenant was removed while this was read.
    if (!writeHistoryFile(childHome(tenant), file)) return;
    log(`history: ${tenant} — ${file.trades.length} trades, ${file.decisions.length} decisions carried for the chat`);
  } catch (e) {
    log(`history: ${tenant} FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * READ THE HISTORY AGAIN AFTER THE STARTUP REPAIR. Spawn reads each child's
 * history before startHistoryRepair begins, so what the repair recovers — a
 * coin's name, a fill side, a sale's P&L — would otherwise reach the chat only
 * at the next redeploy. Once per orchestrator start, one child at a time,
 * behind the lease, with each child's CURRENT account (a re-sign updates it in
 * place). A child replaced meanwhile read the repaired rows at its own spawn.
 */
async function refreshHistoryForLiveChildren(): Promise<void> {
  for (const [tenant, child] of [...children]) {
    if (stopping) return;
    const held = leases.get(tenant);
    if (!held || !held.healthy()) continue;
    if (children.get(tenant) !== child) continue;
    await writeHistoryForChild(tenant as `0x${string}`, child.smartAccount);
  }
}


async function writeBootstrapForChild(
  tenant: `0x${string}`,
  /**
   * The tenant's SMART ACCOUNT — the key every ledger table is actually on, and
   * the identity the child checks the file against. The tenant address names
   * WHOSE anchor this is; the smart account names WHICH BOOK it describes, and
   * they are not the same string.
   */
  smartAccount: `0x${string}`,
  shared?: Db,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let accounting: TenantBootstrapState["accounting"];
  let riskPeriod: TenantBootstrapState["riskPeriod"];
  const url = process.env.DATABASE_URL;
  if (!url) {
    // No shared database configured at all. That is a deployment fact, not a
    // fact about the tenant, and it is reported as such rather than as an
    // empty account.
    accounting = { kind: "unknown", why: "no DATABASE_URL on the orchestrator", observedAt: now };
  } else {
    try {
      const db = shared ?? (await makePgDb(url));
      await db.exec(RISK_PERIOD_SCHEMA);
      riskPeriod = (await readRiskPeriod(db, smartAccount)) ?? undefined;
      accounting = await deriveBootstrapAccounting(db, smartAccount, now);
    } catch (e) {
      accounting = { kind: "unknown", why: e instanceof Error ? e.message : String(e), observedAt: now };
    }
  }

  const state: TenantBootstrapState = {
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    // THE SMART ACCOUNT IS THE IDENTITY THE CHILD CHECKS, because it is the key
    // the figures below were read under. Stamping the tenant here while the
    // child compares against its smart account made every hosted anchor read as
    // malformed — the mechanism was inert, and inert in the safe direction only
    // by luck. The owner address rides along for provenance.
    tenantId: smartAccount.toLowerCase(),
    generatedAt: now,
    accounting,
    ...(riskPeriod ? { riskPeriod } : {}),
    // `outstandingOps` is deliberately NOT written. The field is reserved in
    // the schema so adding it later is not a break; populating it here would
    // change which blocks a child scans, which is a different change.
  };

  try {
    const home = childHome(tenant);
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, BOOTSTRAP_FILE), JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    if (accounting.kind === "unknown") {
      log(`${tenant}: accounting anchor UNKNOWN — ${accounting.why} (child will not book contributions)`);
    }
  } catch (e) {
    log(`${tenant}: could not write ${BOOTSTRAP_FILE} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Start a tenant's worker process. A test swaps it for a fake (setSpawnForTest). */
let startWorker = (tenant: `0x${string}`): ChildProcess =>
  spawn(
    process.execPath,
    [`--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`, "--import", "tsx", WORKER_ENTRY],
    { cwd: ROOT, env: childEnv(tenant), stdio: ["ignore", "pipe", "pipe"] },
  );

/**
 * Test seam: start `fn`'s process in place of a worker. Everything else in
 * spawnChild runs as it does in production, including the exit handler and
 * the restart it schedules.
 */
export function setSpawnForTest(fn: (tenant: `0x${string}`) => ChildProcess): void {
  startWorker = fn;
}

async function spawnChild(tenant: `0x${string}`, restarts = 0): Promise<void> {
  if (stopping) return;
  // The exit handler's restart timer, firing into a home the kill switch is
  // about to delete. See `standingDown`.
  if (standingDown.has(tenant)) {
    log(`${tenant}: being stood down by the kill switch — not spawning`);
    return;
  }
  // The advisory lease is a precondition, taken by reconcile() before the FIRST
  // spawn and held across restarts — so this path (including the crash-restart
  // that re-enters here) never re-acquires it, which would open a window for
  // another replica. Refuse to arm without a healthy lease: a restart that finds
  // the lease gone must not trade unprotected.
  const lease = leases.get(tenant);
  if (!lease || !lease.healthy()) {
    log(`${tenant}: no healthy lease — not spawning (another replica may hold it)`);
    return;
  }
  // Checked here as well as in writeGrantForChild, so the log says why. A
  // crash-restart lands here without passing reconcile's kill check first.
  if (killRequested(childHome(tenant))) {
    log(`${tenant}: a Telegram kill is pending — not spawning`);
    return;
  }
  const epoch = epochOf(tenant);
  const smartAccount = await writeGrantForChild(tenant);
  if (!smartAccount) {
    log(`${tenant}: no grant in the store — not spawning`);
    return;
  }
  // The settings the child will actually read, so the watchdog can size its
  // patience to the tick that child will actually run. `tickSeconds` resolves
  // file-before-env (settings.ts), and the file is what we just wrote.
  const settings = await writeSettingsForChild(tenant);
  // BEFORE spawn(), not after. The child reads its anchor while arming, and an
  // anchor that lands a moment later would be read as absent — which fails
  // closed, so the agent would run with contributions marked unknown for no
  // reason other than a race.
  await writeBootstrapForChild(tenant, smartAccount);
  if (process.env.DATABASE_URL) {
    const raw = new DatabaseSync(path.join(childHome(tenant), "merrymen.db"));
    try {
      const local = wrapSqlite(raw);
      await applyLedgerSchema(local);
      const shared = await makePgDb(process.env.DATABASE_URL);
      log(`paper restore: ${tenant} — ${await restorePaperCheckpoint(local, shared, smartAccount)}`);
      try { await recordPaperRecoveryHealth(shared, smartAccount, false); }
      catch { log(`paper restore: ${tenant} — restored, but recovery status could not be published`); }
    } catch (e) {
      log(`paper restore: ${tenant} FAILED — ${e instanceof Error ? e.message : String(e)}`);
      try {
        await recordPaperRecoveryHealth(await makePgDb(process.env.DATABASE_URL!), smartAccount, true);
      } catch { log(`paper restore: ${tenant} — recovery status could not be published`); }
      // A practice book we cannot restore must not silently restart its cash.
      if (settings?.paperTradingEnabled === true) return;
    } finally { raw.close(); }
  }
  // AND THE BOOK'S OWN COST BASIS, which the redeploy that just happened wiped
  // out of the child's sqlite. Same placement and same reason as the anchor.
  await seedBasisForChild(tenant, smartAccount);
  // AFTER the anchor and BEFORE spawn, with the others: a link restored once the
  // child is already polling would be read from a file the child has by then
  // replaced with a fresh, unlinked default.
  await writeTelegramForChild(tenant);
  void writeHistoryForChild(tenant, smartAccount);
  const tickSeconds = typeof settings?.tickSeconds === "number" ? settings.tickSeconds : envTickSeconds();
  const staleSec = staleThresholdSec(tickSeconds);
  const firstBeatSec = firstBeatGraceSec(tickSeconds);
  // The kill switch stood this tenant down while the files above were written.
  if (epochOf(tenant) !== epoch) {
    log(`${tenant}: stood down by the kill switch while spawning — not spawning`);
    return;
  }
  const proc = startWorker(tenant);
  const child: Child = { proc, tenant, smartAccount, startedAt: Date.now(), restarts, epoch, staleSec, firstBeatSec };
  children.set(tenant, child);
  // Under the lease spawnChild checked above, which reconcile has held since.
  ledgerOwned.add(tenant);
  const tag = `[${tenant.slice(0, 8)}]`;
  const pipe = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream) =>
    stream?.on("data", (c: Buffer) =>
      String(c)
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .forEach((l) => sink.write(`${tag} ${l}\n`)),
    );
  pipe(proc.stdout, process.stdout);
  pipe(proc.stderr, process.stderr);

  proc.on("exit", (code) => {
    // ONLY IF THIS ENTRY IS STILL OURS.
    //
    // `children.delete(tenant)` unconditionally was a double-spawn generator.
    // The watchdog deletes, SIGKILLs, and spawns a replacement which installs a
    // NEW entry under the same key — and then this handler, running for the
    // corpse, deleted the replacement. A second later the `!children.has`
    // guard below was true and a SECOND child spawned. The first replacement
    // was orphaned: still ticking, still hitting the RPC, invisible to the
    // watchdog, never mirrored, sharing one home and one sqlite file with its
    // own replacement. Measured: 105 spawns against 61 exits in one window.
    if (children.get(tenant) === child) children.delete(tenant);
    if (stopping) return;
    log(`${tenant} exited (${code})`);
    // A long healthy run that then dies is a fresh incident, not a crash loop.
    const freshRestarts = Date.now() - child.startedAt > 60_000 ? 0 : restarts + 1;
    scheduleRestart(tenant, freshRestarts, `exit ${code}`, child.epoch);
  });
  log(`${tenant} spawned (pid ${proc.pid}) — tick ${tickSeconds}s, watchdog ${staleSec}s`);
}

/** The fleet-wide tick, for a tenant whose own settings do not name one. */
function envTickSeconds(): number {
  const raw = Number(process.env.MERRYMEN_TICK_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
}

/**
 * Stop a child hard. SIGTERM first for a clean exit, then SIGKILL — a wedged
 * tick only the OS can reclaim.
 *
 * The delete below is now load-bearing in the way this function always claimed:
 * the exit handler compares identity, so removing our entry first genuinely
 * does mark the exit as intentional. Before that comparison existed, this
 * survived only because `releaseLease` happened to win a race against the
 * handler's 1s respawn timer.
 */
function killChild(tenant: string): void {
  const child = children.get(tenant);
  if (!child) return;
  children.delete(tenant); // delete first so the exit handler treats it as intentional
  child.proc.kill("SIGTERM");
  setTimeout(() => {
    try {
      child.proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, 3_000);
}

/**
 * Tell the owner a Telegram kill is DONE: the stored grant is deleted. Sent
 * from here, not from the child, because only this process knows the DELETE
 * succeeded (see kill-request.ts). It goes through the owner's own bot to the
 * chat that proved the /link code, like the MCP alerts. It ignores the alert
 * switch, because this is the answer to a command the owner just gave.
 * Best effort: a confirmation that fails to send is logged. The owner was
 * told what to do if none arrives.
 */
let confirmKillDone = async (tenant: `0x${string}`): Promise<void> => {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  try {
    const to = await hostedRecipient(await makePgDb(url))(tenant);
    if (!to) {
      log(`${tenant}: Telegram kill done, but there is no linked owner chat to confirm it to`);
      return;
    }
    const sent = await telegramSend()(to.botToken, to.chatId, KILL_DONE_TEXT);
    if (!sent.ok) log(`${tenant}: Telegram kill done, but the confirmation did not send — ${sent.reason ?? "unknown"}`);
  } catch (e) {
    log(`${tenant}: Telegram kill done, but the confirmation did not send — ${e instanceof Error ? e.message : String(e)}`);
  }
};

/** Test seam: capture the confirmation instead of sending it. */
export function setKillConfirmForTest(fn: (tenant: `0x${string}`) => Promise<void>): void {
  confirmKillDone = fn;
}

/**
 * Carry out one tenant's pending Telegram kill, if it has one. Called from
 * reconcile, from the three-second order ferry and on shutdown. They can
 * overlap, which is safe: the DELETE is conditional and atomic, so exactly
 * one call sees `removed` and confirms to the owner.
 */
async function honourKill(tenant: `0x${string}`, nowSec: number): Promise<KillOutcome> {
  const k = await honourKillRequest(getGrantStore(), tenant, childHome(tenant), nowSec);
  if (k.outcome === "revoked" && k.removed) {
    log(`${tenant}: Telegram kill honoured — grant removed from the store`);
    void confirmKillDone(tenant);
  }
  if (k.outcome === "superseded") log(`${tenant}: a grant signed after the Telegram kill replaces it — arming that one`);
  if (k.outcome === "failed") log(`${tenant}: Telegram kill pending, could not remove the grant yet (${k.error}) — nothing arms meanwhile`);
  return k;
}

/**
 * Every child home holding a pending request, whether or not its child is
 * running. Read from the disk rather than the children map, so a kill left
 * by a child that has since crashed is not missed.
 */
function pendingKillTenants(): `0x${string}`[] {
  return homesOnDisk().filter((t) => killRequested(childHome(t)));
}

/** Every tenant with a child home on this container's disk, running or not. */
function homesOnDisk(): `0x${string}`[] {
  let names: string[];
  try {
    names = readdirSync(path.join(merrymenHome(), "children"));
  } catch {
    return [];
  }
  return names.filter((n): n is `0x${string}` => /^0x[0-9a-f]{40}$/.test(n));
}

/**
 * Tenants whose grant is gone and that this replica still holds something
 * of, with no child running: a lease, or a home with a session key or a kill
 * request in it. Read from the disk as well as the lease map, so a home the
 * lease map has forgotten (a fleet halt released every lease) is found too.
 */
function killedWithNoChild(wanted: Set<string>): string[] {
  const found = new Set<string>(leases.keys());
  for (const tenant of homesOnDisk()) {
    const home = childHome(tenant);
    if (existsSync(path.join(home, "grant.json")) || killRequested(home)) found.add(tenant);
  }
  return [...found].filter((t) => !wanted.has(t) && !children.has(t) && !standingDown.has(t));
}

/**
 * Carry out every pending kill now. This is what keeps a kill from waiting a
 * whole reconcile pass (fifteen seconds plus the pass itself) in a home that a
 * redeploy would discard. Never throws: the order ferry calls it.
 */
export async function honourPendingKills(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const tenant of pendingKillTenants()) {
    try {
      await honourKill(tenant, nowSec);
    } catch (e) {
      log(`${tenant}: Telegram kill could not be honoured this time — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * The passes in flight that write for a tenant under its lease: reconcile(),
 * through its kill switch, and mirrorLedgers(). stopFleet waits for them
 * before it releases any lease.
 *
 * A reconcile pass checks `stopping` once, on entry, and then awaits the
 * store, the lease server and the settings files before it reaches the
 * kill-switch branch. A SIGTERM in that gap must not release a lease the pass
 * is about to stand down under, because that lease is what gates its last
 * mirror. And a mirror pass part-way through a tenant is a write that must
 * not outlive its lease, like the stand-down's.
 */
const leaseWork = new Set<Promise<unknown>>();

function underLease<T>(work: Promise<T>): Promise<T> {
  leaseWork.add(work);
  const done = () => leaseWork.delete(work);
  work.then(done, done);
  return work;
}

/** Bring the running set in line with the store: spawn new tenants, stop killed ones. */
export function reconcile(): Promise<void> {
  return underLease(reconcilePass());
}

async function reconcilePass(): Promise<void> {
  if (stopping) return;
  const store = getGrantStore();
  let tenants: `0x${string}`[];
  try {
    tenants = await store.listTenants();
  } catch (e) {
    log(`store unreadable, skipping this reconcile: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  // A TELEGRAM KILL, CARRIED OUT HERE. It must happen before `wanted` is built.
  // A tenant whose stored grant this removes is dropped from the list. It is
  // then not wanted, and the kill-switch branch at the bottom stands its child
  // down and wipes its home, the same as for a web DELETE /api/grants. The
  // order ferry usually got there first (honourPendingKills). Then this
  // finds the grant already absent, which is also `revoked`.
  // See kill-request.ts.
  const nowSec = Math.floor(Date.now() / 1000);
  const kept: `0x${string}`[] = [];
  for (const tenant of tenants) {
    const lc = tenant.toLowerCase() as `0x${string}`;
    if ((await honourKill(lc, nowSec)).outcome === "revoked") continue;
    kept.push(tenant);
  }
  tenants = kept;
  const wanted = new Set(tenants.map((t) => t.toLowerCase()));

  // A lease whose connection dropped no longer protects its tenant — Postgres
  // has released the lock and another replica may hold it. Stand the child down
  // and drop the lease; the acquire below will try to re-take it (or find the
  // other replica now owns it). This is what makes the lock a live guarantee and
  // not just a start-time check.
  for (const [tenant, lease] of [...leases]) {
    if (!lease.healthy()) {
      log(`${tenant}: lease lost (connection dropped) — standing the child down until it can be re-leased`);
      if (children.has(tenant)) killChild(tenant);
      await releaseLease(tenant);
    }
  }

  // Spawn any wanted tenant that isn't running — but only behind a lease. Acquire
  // one first (unless we already hold it from a previous reconcile / across a
  // crash restart); if another replica holds it, skip this tenant and try again
  // next reconcile.
  for (const tenant of tenants) {
    const lc = tenant.toLowerCase() as `0x${string}`;
    if (children.has(lc)) continue;
    /**
     * A TENANT THE RESTART POLICY GAVE UP ON IS NOT A TENANT THAT ISN'T RUNNING.
     *
     * This loop's job is "spawn anything wanted that is not running", and a
     * crash-looping child is not running — so every fifteen seconds it was
     * respawned here with `restarts` defaulting to 0, wiping the ladder and the
     * MAX_RESTARTS ceiling the exit handler had just reached. The measured
     * result is roughly nine restarts every two minutes, indefinitely, each one
     * a fresh 28-call cold arm including a 200,000-block getLogs walk.
     *
     * The cool-off expires, and when it does the tenant is retried with the
     * restart count it had — not with a clean slate, which is what made the
     * ceiling unreachable in the first place.
     */
    const cool = gaveUpUntil.get(lc);
    if (cool && Date.now() < cool.until) continue;
    if (cool) {
      gaveUpUntil.delete(lc);
      log(`${lc}: stand-down over — trying once more`);
    }
    if (!leases.has(lc)) {
      let lease: TenantLease | null;
      try {
        lease = await acquireTenantLease(lc);
      } catch (e) {
        log(`${lc}: lease attempt failed, skipping this reconcile: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (!lease) {
        log(`${lc}: leased by another replica — not arming here`);
        continue;
      }
      leases.set(lc, lease);
    }
    await spawnChild(lc, cool?.restarts ?? 0);
  }
  // Refresh every running child's settings.json so a tenant's config change
  // reaches it (the worker re-reads settings.json each tick). Cheap: one small
  // file per tenant, and unchanged content is a harmless rewrite. The shared
  // seenBotTokens set de-duplicates Telegram bots across the fleet (see the guard
  // in writeSettingsForChild).
  const seenBotTokens = new Set<string>();
  for (const tenant of children.keys()) {
    await writeSettingsForChild(tenant as `0x${string}`, seenBotTokens);
    // AND THEIR GRANT, for the same reason and on the same clock. Settings
    // reached a live agent in fifteen seconds while a new SIGNATURE reached it
    // only on a restart — so an owner who re-signed to cover a token watched
    // their agent keep refusing it. See refreshGrantForChild.
    await refreshGrantForChild(tenant as `0x${string}`);
  }
  // Stop (and forget) any running child whose grant is gone — the kill switch.
  for (const tenant of [...children.keys()]) {
    if (!wanted.has(tenant)) {
      log(`${tenant} grant removed — standing it down`);
      await standDownKilled(tenant);
    }
  }
  // AND ANY KILLED TENANT WITH NO CHILD RUNNING: crashed and waiting on its
  // restart, or in the give-up cool-off. The loop above never sees it, since
  // it is not in `children`, and releasing its lease below used to be all it
  // got. Its home stayed on disk until the container went, grant.json and the
  // session key in it included. Its last rows were never mirrored and nothing
  // recorded the kill. A crash-looping agent is the one an owner kills.
  for (const tenant of killedWithNoChild(wanted)) {
    log(`${tenant} grant removed while no child was running — standing its home down`);
    await standDownKilled(tenant);
  }
  // Release any lease we still hold for a tenant that is no longer wanted.
  // Every stand-down above releases its own, so this is the backstop. Holding
  // a lease for a tenant we won't arm would block another replica (or a later
  // re-arm) for no reason.
  for (const tenant of [...leases.keys()]) {
    if (!wanted.has(tenant)) await releaseLease(tenant);
  }
}

/**
 * Tenants between the kill switch's SIGTERM and their released lease, each
 * with a promise that settles once its lease has been let go.
 *
 * spawnChild refuses them. The exit handler treats a stood-down child like
 * any other exit and schedules a restart one second later. The stand-down
 * now takes at least that long, because it carries the child's ledger up
 * first, and the lease is held throughout. If the owner re-signed in that
 * window, the store has a grant again, so the restart would spawn a new child
 * into the home that is about to be deleted, under the lease that is about to
 * be released.
 *
 * A tenant killed with no child running is in here too, while its home is
 * mirrored and deleted. The restarts themselves are voided by `killEpoch`,
 * which also covers the ones that fire after the stand-down.
 *
 * stopFleet waits for them, and for the reconcile pass that starts them,
 * before it releases any lease or exits. See standDownKilled for why the
 * lease must outlive the write.
 */
const standingDown = new Map<string, Promise<void>>();

/** How long a stood-down child gets to exit before its ledger is read anyway. killChild SIGKILLs at 3 s. */
const STAND_DOWN_EXIT_MS = 4_000;

/** Resolves once `proc` has exited, or after `ms`, whichever comes first. */
function exitOf(proc: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, ms);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Test seam: the shared ledger a stand-down records into, in place of DATABASE_URL. */
let sharedForTest: Db | null = null;

async function sharedLedger(): Promise<Db | null> {
  if (sharedForTest) return sharedForTest;
  const url = process.env.DATABASE_URL;
  return url ? makePgDb(url) : null;
}

/** Test seam: set the shared ledger a stand-down records into, for a child spawned through setSpawnForTest. */
export function setSharedLedgerForTest(shared: Db | null): void {
  sharedForTest = shared;
}

/**
 * Test seam: a running child with a healthy lease, and the shared ledger its
 * stand-down records into. A test can then drive the real reconcile() kill
 * switch with no worker process and no Postgres.
 */
export function adoptLeasedChildForTest(args: {
  tenant: `0x${string}`;
  smartAccount: `0x${string}`;
  /** What the stand-down uses of a ChildProcess. */
  proc: {
    kill(signal?: NodeJS.Signals | number): boolean;
    once(event: "exit", listener: () => void): unknown;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  shared: Db | null;
  /** Called when reconcile releases the lease. */
  onLeaseRelease?: () => void;
}): void {
  const lc = args.tenant.toLowerCase() as `0x${string}`;
  children.set(lc, { proc: args.proc as unknown as ChildProcess, tenant: lc, smartAccount: args.smartAccount, startedAt: Date.now(), restarts: 0, epoch: epochOf(lc), staleSec: 600, firstBeatSec: 600 });
  leases.set(lc, { tenant: lc, backend: "none", healthy: () => true, release: async () => args.onLeaseRelease?.() });
  ledgerOwned.add(lc);
  sharedForTest = args.shared;
}

/**
 * THE KILL SWITCH, CARRIED OUT: stop the child, record what it did, then
 * delete its home.
 *
 * THE ORDER IS THE FIX. This used to SIGTERM and delete the home in the same
 * breath. mirrorLedgers() runs after reconcile(), so everything the child had
 * written since the previous pass went with the home, including, for a
 * Telegram /kill, its own record of the kill. See stand-down.ts.
 *
 * SIGTERM still comes first, so stopping the agent never waits on a database.
 * The recording is best-effort: the home is deleted and the lease released
 * whether or not it succeeds.
 *
 * BUT ONLY ONCE IT HAS SETTLED, and deliberately with no timeout. A timeout
 * can stop the waiting, not the write. The mirror would carry on after the
 * lease was gone, and its snapshot replace (delete-then-insert of positions
 * and cost basis) could land on top of whichever child holds the lease next,
 * here after a re-sign or on another replica. Holding the lease until the
 * write lands is what keeps that impossible. It costs nothing new: a shared
 * database that hangs already holds this loop in mirrorLedgers(), which has
 * never had a timeout either.
 *
 * WITH NO CHILD RUNNING, the same minus the SIGTERM. The kill landed between
 * a crash and its restart, or in the give-up cool-off, and the home is still
 * on disk. The account and the run's start come from the home
 * (lastRunOnDisk), since there is no Child to read them from.
 */
async function standDownKilled(tenant: string): Promise<void> {
  if (standingDown.has(tenant)) return;
  let settled!: () => void;
  standingDown.set(tenant, new Promise<void>((resolve) => (settled = resolve)));
  // The run ends here: no restart it scheduled, or that its exit below
  // schedules, fires.
  killEpoch.set(tenant, epochOf(tenant) + 1);
  // A re-sign arms at once. It does not wait out a cool-off the killed
  // grant's crash loop earned, nor start from that loop's restart count.
  gaveUpUntil.delete(tenant);
  try {
    const child = children.get(tenant);
    const home = childHome(tenant);
    // Not "a lease is held": that lease may have been taken for a spawn that
    // never happened, over a home an earlier run left behind. See ledgerOwned.
    const owned = leases.has(tenant) && ledgerOwned.has(tenant);
    let run: KilledRun | null = null;
    if (child) {
      const exited = exitOf(child.proc, STAND_DOWN_EXIT_MS);
      killChild(tenant);
      // Read the ledger once nothing can write to it any more.
      await exited;
      run = { smartAccount: child.smartAccount, since: Math.floor(child.startedAt / 1000), lastMirror: true };
    } else if (existsSync(home)) {
      if (!leases.has(tenant) && !(await leaseToStandDown(tenant))) return;
      run = { ...lastRunOnDisk(home, Math.floor(Date.now() / 1000)), lastMirror: owned };
    }
    if (run) {
      try {
        await recordKill(tenant, run);
      } catch (e) {
        log(`${tenant}: recording the kill failed — ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    await releaseLease(tenant);
  } finally {
    standingDown.delete(tenant);
    settled();
  }
}

/**
 * Take the lease of a killed tenant whose home this replica holds no lease
 * for, e.g. after a fleet halt released them all. The lease means only one
 * replica ever records the kill and deletes the home. False when another
 * replica holds it: its own stand-down releases it, and the next pass here
 * tries again.
 */
async function leaseToStandDown(tenant: string): Promise<boolean> {
  let lease: TenantLease | null;
  try {
    lease = await acquireTenantLease(tenant as `0x${string}`);
  } catch (e) {
    log(`${tenant}: could not take the lease to clear its home, next pass — ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  if (!lease) {
    log(`${tenant}: another replica holds its lease — leaving its home here until it lets go`);
    return false;
  }
  leases.set(tenant, lease);
  return true;
}

/** What a stand-down records a kill against. */
interface KilledRun {
  /** Null when nothing names it: the kill is then logged as not recorded. */
  smartAccount: string | null;
  /** Unix seconds. A KILL SWITCH the child wrote at or after this is this kill's. */
  since: number;
  /** False unless this replica has held the lease over the home since its child last wrote it (ledgerOwned). See recordStandDown. */
  lastMirror: boolean;
}

/** The last mirror and the kill record, for the stood-down tenant. Never throws. */
async function recordKill(tenant: string, run: KilledRun): Promise<void> {
  // The mirror's own rule: only the replica holding the lease may write for
  // this tenant (see the note in mirrorLedgers).
  const lease = leases.get(tenant);
  if (!lease || !lease.healthy()) {
    log(`${tenant}: stood down without a last mirror — this replica no longer holds its lease`);
    return;
  }
  let shared: Db | null;
  try {
    shared = await sharedLedger();
  } catch (e) {
    log(`${tenant}: stood down without a last mirror — shared db unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!shared) return;
  const r = await recordStandDown({
    tenant,
    home: childHome(tenant),
    smartAccount: run.smartAccount,
    since: run.since,
    shared,
    lastMirror: run.lastMirror,
  });
  if (r.mirror) {
    if (r.mirror.failed) {
      const why = Object.entries(r.mirror.failed).map(([k, v]) => `${k}: ${v}`).join(" | ");
      log(`ledger mirror: ${tenant} STALLED on its last pass — ${why}`);
    }
    const counts = mirrorCountsLine(tenant, r.mirror);
    if (counts) log(`${counts} · last pass (${r.mirror.rounds} round${r.mirror.rounds === 1 ? "" : "s"}) before the kill switch deletes its home`);
    // Loud, because these rows go with the home. The home cannot be kept for
    // them: it holds the session key the kill switch exists to destroy.
    if (r.mirror.behind.length) log(`ledger mirror: ${tenant} LEFT BEHIND on its last pass, deleted with the home — ${r.mirror.behind.join(", ")}`);
  } else if (!run.lastMirror) {
    log(`${tenant}: no last mirror — no child of this replica has written the home under its current lease, so the copy may be stale`);
  } else {
    log(`${tenant}: no last mirror — ${r.mirrorError ?? "no ledger on disk"}`);
  }
  if (r.event === "failed") {
    log(`${tenant}: kill NOT recorded in the shared db — ${r.recordError}`);
  } else {
    log(
      `${tenant}: kill recorded — agents row set to killed (${r.marked} row${r.marked === 1 ? "" : "s"}), ` +
        (r.event === "written" ? "KILL SWITCH event written" : "the child's own KILL SWITCH event was already there"),
    );
  }
}


/**
 * Carry every running child's ledger up to the shared database.
 *
 * The orchestrator is the only process that can: it holds DATABASE_URL (which
 * children deliberately do not) and it knows where each child's home is. See
 * ledger-mirror.ts for why this exists at all — without it the hosted dashboard
 * shows no tape, no positions and no reasoning, whatever the fleet is doing.
 *
 * Best-effort by design. A tenant whose ledger is mid-write or unreadable is a
 * tenant whose dashboard lags a tick; it is never a reason to stop supervising
 * the fleet, which is this process's actual job.
 */
/**
 * CARRY COMMANDS TO CHILDREN, AND THEIR ANSWERS BACK.
 *
 * The dashboard writes into the shared database; a child cannot read it,
 * because CHILD_SECRET_STRIP removes DATABASE_URL on purpose — a child holding
 * the fleet's connection string is the isolation this file exists to keep. So
 * the orchestrator, the one process that holds both the shared database and
 * every child's home, ferries between them. Exactly what writeGrantForChild
 * and writeSettingsForChild already do for grants and settings.
 *
 * The first attempt skipped this and had the child poll the table directly.
 * It would never have claimed a single command: the row was in Postgres and
 * the query ran against the child's private sqlite. Caught in review, before
 * anybody pressed the button and watched nothing happen.
 *
 * Best-effort on both legs. A command that does not arrive is a button the
 * owner presses again; taking the fleet loop down to deliver one is not a
 * trade worth making.
 */
async function ferryCommands2(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || children.size === 0) return;
  try {
    const shared = await makePgDb(url);
    await oneFerryAtATime(() => ferryCommands(shared));
  } catch {
    /* shared db unavailable — the mirror logs that already */
  }
}

/**
 * HOW OFTEN AN ORDER CROSSES, in each direction.
 *
 * The reconcile pass ferries everything, but only after the reconcile, the
 * mirror, the builder desk and the news desk have each had their turn, and then
 * it sleeps fifteen seconds — so an owner's order could sit in the table for
 * most of a minute before its file reached the child, and its answer sat on
 * disk just as long on the way back. Orders get their own short clock. The
 * cost is one indexed query per interval for the whole fleet, not one per
 * tenant, and a directory listing per child for the answers.
 */
export const ORDER_FERRY_MS = 3_000;

/**
 * ONE FERRY AT A TIME, whichever clock started it.
 *
 * The claim is what makes a delivery at-most-once and it holds without this —
 * `claimed_at IS NULL` on the UPDATE lets exactly one caller win. But two
 * up-legs draining the same answer both write the row and both drop the file,
 * and a pass that overlaps another is load nobody asked for.
 *
 * SKIPPED, NOT QUEUED. The reconcile loop awaits its ferry, and that loop is
 * also the watchdog and the respawn; chaining it behind a short-loop pass that
 * hung on the database would stall the whole fleet's supervision on an order
 * ferry. A pass that finds another running simply comes back on its own clock —
 * three seconds for orders, one reconcile pass for the rest — and a short-loop
 * pass takes milliseconds, so the reconcile pass is almost never the one that
 * waits.
 */
let ferrying = false;
async function oneFerryAtATime(pass: () => Promise<void>): Promise<void> {
  if (ferrying) return;
  ferrying = true;
  try {
    await pass();
  } finally {
    ferrying = false;
  }
}

/** The short loop's pass: every live child, orders only, both directions. */
async function ferryOrdersNow(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || children.size === 0) return;
  try {
    const shared = await makePgDb(url);
    const targets = [...children.entries()].map(([tenant, child]) => ({
      home: childHome(tenant),
      smartAccount: child.smartAccount,
      tag: tenant,
    }));
    await oneFerryAtATime(() => ferryOrders(shared, targets));
  } catch {
    /* shared db unavailable — the reconcile pass logs that already */
  }
}

/**
 * The short loop itself. Its own clock, so an order never waits on the mirror
 * or a vendor pass; it stands down with the fleet on a halt or a stop.
 */
async function orderFerryLoop(): Promise<void> {
  for (;;) {
    if (stopping) return;
    // Telegram kills ride this clock, not reconcile's: a request sits in a
    // home a redeploy discards, so it is carried to the store within seconds
    // (kill-request.ts). Before the halt check on purpose. A fleet halt stops
    // trading, and a kill makes the stop outlive the halt.
    await honourPendingKills();
    if (!haltRequested()) await ferryOrdersNow();
    await new Promise((r) => setTimeout(r, ORDER_FERRY_MS));
  }
}

/**
 * The `args` column, turned back into a flat object of scalars.
 *
 * THE ORCHESTRATOR IS NOT THE VALIDATOR AND MUST NOT BECOME ONE. It is the one
 * process that can see every tenant's home, so the less it believes about a
 * payload the better: this drops anything that is not a scalar and hands the
 * rest on unexamined. What an order MEANS is decided twice — once in the route
 * before the row is written, once in the child before an intent is built — and
 * neither of those gates lives here. Same principle chat-commands.ts states for
 * settings: two independent gates, neither relying on the other.
 *
 * Unparseable args become `{}` rather than an exception: a command that arrives
 * with nothing is refused by name at the dispatch, which is a sentence somebody
 * can read. A throw here would stall the whole ferry for every tenant.
 */
function parseArgs(raw: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    }
  } catch {
    /* a malformed payload is a refusal at the dispatch, not a stalled ferry */
  }
  return out;
}

/**
 * How old a trade command must be before the ferry declares it never ran.
 *
 * The route stamps a five-minute expiry and the child enforces it at the claim;
 * this is the same deadline plus room for a ferry pass and a slow tick, after
 * which the row is closed with a reason. Kept here rather than imported from
 * the web tier because the two processes share no module — and stated in both
 * places so a change to one is visibly a change to the other.
 *
 * NOW ONLY THE FLOOR, and the fallback for a row that carries no deadline. The
 * route stopped stamping five minutes when the window became two ticks of the
 * tenant's own cadence — 8m15s at the hosted 240 s tick — and this constant did
 * not follow. So a row was closed as "never ran" at seven minutes while the
 * child was still entitled to fill it, and closing it freed the one-at-a-time
 * slot early enough to admit a second order beside the first. Each row is now
 * judged against its own `expiresAt` plus ORDER_GRACE_MS below.
 */
const ORDER_STALE_MS = 7 * 60_000;

/**
 * How long past its own deadline an unanswered order keeps its row open.
 *
 * The route's ORDER_STALE_GRACE_MS (web/src/lib/order-state.ts), for the same reason:
 * the child enforces the deadline at the claim, so a row can be a ferry pass and
 * a tick behind it while genuinely being decided. The route holds the owner's
 * one-at-a-time slot for exactly this long, and the two must agree — a row this
 * closes early is a slot the route hands out while the first order can still run.
 */
const ORDER_GRACE_MS = 2 * 60_000;

/**
 * When an unanswered trade row may be closed: its own deadline plus the grace,
 * or — for a row that carries none — the old fixed age.
 */
function orderClosesAt(r: { args: string | null; created_at: number }): number {
  const expiresAt = r.args ? parseArgs(r.args).expiresAt : undefined;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt)
    ? expiresAt + ORDER_GRACE_MS
    : Number(r.created_at) + ORDER_STALE_MS;
}

async function ferryCommands(shared: Db): Promise<void> {
  for (const [tenant, child] of [...children.entries()]) {
    await ferryForChild(shared, { home: childHome(tenant), smartAccount: child.smartAccount, tag: tenant });
  }
}

/**
 * One command row, handed to its child.
 *
 * CLAIMED BEFORE THE FILE IS WRITTEN, and the write only happens if the claim
 * actually took.
 *
 * These are two writes to two systems and there is no transaction across them,
 * so one of the two orders has to be chosen. It used to write first: a crash —
 * or a thrown UPDATE, whose catch is a comment — between the two re-wrote
 * `<id>.json` into a home that had already claimed, run and answered it. For a
 * probe that is a second approve of 0.000001 USDG. For a BUY it is a second
 * position at a second price with a second gas bill, and a ledger showing two
 * fills for one instruction — a claim about somebody's money they never made.
 *
 * So: at-most-once, deliberately, in the direction this codebase already
 * accepts. A lost command is a button pressed again (command-files.ts says so
 * about the unlink); a replayed order is not recoverable by anyone. The short
 * order loop and the reconcile pass both deliver through here, so they share
 * the one claim and cannot both hand the same order over.
 */
async function deliverCommand(
  shared: Db,
  home: string,
  tenant: string,
  r: { id: string; kind: string; args: string | null; created_at: number },
): Promise<void> {
  const claim = await shared
    .prepare("UPDATE agent_commands SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL")
    .run(Date.now(), r.id);
  if (claim.changes === 0) return; // another replica — or the other loop — took it
  // `expiresAt` rides in the same payload and is LIFTED OUT here rather
  // than given a column of its own. It is not part of what the order
  // means — it is how long the order is willing to wait — and the worker
  // checks it before it looks at a single argument.
  const args = r.args ? parseArgs(r.args) : {};
  const expiresAt = typeof args.expiresAt === "number" ? args.expiresAt : undefined;
  delete args.expiresAt;
  writeCommand(home, {
    id: String(r.id),
    kind: String(r.kind),
    at: Number(r.created_at),
    ...(Object.keys(args).length ? { args } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  });
  log(`command ${String(r.id).slice(0, 8)} → ${tenant.slice(0, 8)} (${r.kind})`);
}

/**
 * THE RECEIPT'S COLUMN on the shared table: the C3 receipt as JSON, beside the
 * `result` line it never replaces.
 *
 * Nullable with no default, the house rule: a row answered before this existed
 * has no receipt, which is a different fact from an empty one. Added by this
 * process because it is the one that writes it — the same reasoning the mirror
 * gives for `last_stamp` — and every reader treats it as optional, because web
 * and orchestrator deploy at the same moment and either may run first.
 */
export const COMMAND_RECEIPT_DDL = "ALTER TABLE agent_commands ADD COLUMN receipt TEXT";

/**
 * A receipt as the column holds it, or null. Re-serialised from the parsed
 * result rather than copied as text, so nothing but the object the child wrote
 * reaches the table, and bounded like every other status column here.
 */
function receiptJson(r: FileCommandResult): string | null {
  return receiptColumn(r.receipt);
}

/**
 * IS THIS THE ERROR A TABLE WITHOUT THE RECEIPT COLUMN GIVES — AND ONLY THAT?
 *
 * The one question both receipt-less fallbacks exist to answer. Anything else —
 * a dropped connection, a lock, a timeout, some OTHER column's absence — is a
 * failed write, and the fallback would turn it into a permanent one: the row is
 * closed (done_at set, the result file dropped) with a NULL receipt, and no
 * later pass revisits it. The same rule ledger-mirror.ts missingMarkColumn
 * holds for its fallback.
 *
 * SQLite says `no such column: receipt`; Postgres raises undefined_column
 * (42703) and names the column. The name is required in both.
 */
export function missingReceiptColumn(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (!/\breceipt\b/.test(e.message)) return false;
  return /no such column/i.test(e.message) || (e as { code?: unknown }).code === "42703";
}

/** Any receipt as the column holds it, or null — the one serialisation both writers use. */
function receiptColumn(receipt: OrderReceipt | undefined): string | null {
  if (!receipt || typeof receipt !== "object") return null;
  const json = JSON.stringify(receipt);
  return json.length <= 1_000 ? json : null;
}

/**
 * Close a row with its sentence AND its receipt, or — on a table that has not
 * grown the column yet — with the sentence alone, exactly as landResults does:
 * the receipt waits, the answer does not. `where` is the row's own guard and is
 * the same on both writes, so the fallback can never close a row the first
 * write would have left alone.
 *
 * ONLY ON THE MISSING COLUMN. Any other failure is thrown, so the row stays
 * open and the next pass retries both writes (missingReceiptColumn).
 */
async function closeWithReceipt(
  shared: Db,
  set: { sql: string; args: unknown[] },
  receipt: OrderReceipt,
  where: { sql: string; args: unknown[] },
): Promise<void> {
  try {
    await shared
      .prepare(`UPDATE agent_commands SET ${set.sql}, receipt = ? WHERE ${where.sql}`)
      .run(...set.args, receiptColumn(receipt), ...where.args);
  } catch (e) {
    if (!missingReceiptColumn(e)) throw e;
    await shared.prepare(`UPDATE agent_commands SET ${set.sql} WHERE ${where.sql}`).run(...set.args, ...where.args);
  }
}

/**
 * One child's answers, written back as rows.
 *
 * ONE TRY PER RESULT, AND THE FILE IS DELETED ONLY AFTER ITS ROW LANDS.
 * This was a single try around the whole loop, over a drain that unlinked
 * every file as it read it — so one connection blip on the first result
 * discarded every other tenant-visible receipt in the batch, permanently.
 * For an order that loses the record of a trade that really happened, and
 * an unanswered row is now what refuses the owner their next order.
 *
 * THE RECEIPT NEVER COSTS THE ANSWER. The write with the receipt is tried
 * first; a table that has not grown the column yet refuses it, and the answer
 * is written the way it always was. The owner then reads the line — which every
 * surface already renders — rather than an order that never stops spinning.
 */
async function landResults(shared: Db, home: string, tenant: string): Promise<void> {
  for (const r of drainCommandResults(home)) {
    try {
      const now = Date.now();
      const line = r.line.slice(0, 500);
      try {
        await shared
          .prepare("UPDATE agent_commands SET done_at = ?, result = ?, receipt = ? WHERE id = ?")
          .run(now, line, receiptJson(r), r.id);
      } catch (e) {
        // Only the missing column: a blip here used to land the answer without
        // its receipt and drop the file, losing the receipt for good.
        if (!missingReceiptColumn(e)) throw e;
        await shared.prepare("UPDATE agent_commands SET done_at = ?, result = ? WHERE id = ?").run(now, line, r.id);
      }
      dropCommandResult(home, r.id);
      log(`command ${r.id.slice(0, 8)} ← ${tenant.slice(0, 8)}: ${r.ok ? "ok" : "failed"}`);
    } catch {
      // Left on disk on purpose: the next pass retries it. A receipt that
      // survives is worth more than a tidy directory.
    }
  }
}

/**
 * THE SHORT LOOP'S PASS: orders down, answers up, for every child at once.
 * EXPORTED SO THE SEAM CAN BE TESTED, for the reason ferryForChild is.
 *
 * TRADE ROWS ONLY on the way down. A probe or a paper reset waits for the
 * reconcile pass exactly as it always has; what an owner sits watching is an
 * order. One query for the whole fleet, bound to each child's SMART ACCOUNT —
 * the identity `agent_id` means everywhere in this schema, and the join the
 * reconcile pass once got wrong — and only for the children this replica
 * runs, so an order for somebody else's agent is never claimed here.
 *
 * Every answer on disk goes back up, whatever its kind: the up-leg only moves
 * finished results, so carrying a probe's result early costs nothing and
 * saves it waiting on a slower clock.
 */
export async function ferryOrders(
  shared: Db,
  targets: readonly { home: string; smartAccount: string; tag: string }[],
): Promise<void> {
  if (targets.length === 0) return;
  const byAccount = new Map(targets.map((t) => [t.smartAccount, t]));
  try {
    const accounts = [...byAccount.keys()];
    const rows = (await shared
      .prepare(
        // ORDER BY (created_at, id) for the reason the reconcile pass gives:
        // two orders really do land in the same millisecond.
        `SELECT id, agent_id, kind, args, created_at FROM agent_commands
          WHERE kind = 'trade' AND claimed_at IS NULL AND agent_id IN (${accounts.map(() => "?").join(", ")})
          ORDER BY created_at ASC, id ASC LIMIT 50`,
      )
      .all(...accounts)) as { id: string; agent_id: string; kind: string; args: string | null; created_at: number }[];
    for (const r of rows) {
      const t = byAccount.get(String(r.agent_id));
      if (!t) continue;
      try {
        await deliverCommand(shared, t.home, t.tag, r);
      } catch {
        /* this order waits for the next pass; the others still cross */
      }
    }
  } catch {
    /* the table did not answer — every order waits for the next pass */
  }
  for (const t of targets) await landResults(shared, t.home, t.tag);
}

/**
 * One child's two legs. EXPORTED SO THE SEAM CAN BE TESTED.
 *
 * The hosted half of this channel had no test at all — `agent-commands.
 * integration.test.ts` exercises the queue helpers in store.ts, which have no
 * production caller, while the live path was three hand-written statements
 * across two files. That is how the identity mismatch below survived: the
 * tested code used one constant for both sides of a join whose whole difficulty
 * is that the two sides are DIFFERENT ADDRESSES.
 *
 * So the account and the home arrive as arguments rather than being looked up
 * from module state, and the test passes a real tenant→account pair that does
 * not match — because a test that uses one address for both proves nothing
 * about this function.
 */
export async function ferryForChild(
  shared: Db,
  { home, smartAccount, tag }: { home: string; smartAccount: string; tag: string },
): Promise<void> {
  {
    // ── down: unclaimed commands become files ──
    try {
      const rows = (await shared
        .prepare(
          // BOUND TO THE SMART ACCOUNT, NOT THE TENANT. `agent_id` is the
          // ERC-4337 account everywhere in this schema, and the web enqueues
          // under exactly that (agent-for.ts). Binding the SIWE wallet here
          // matched zero rows for every hosted tenant, always — so a queued
          // command sat with claimed_at NULL forever while the dashboard said
          // "queued", which its own comment reads as a worker that is not
          // draining. The same mismatch agent-for.ts exists to prevent, one
          // hop over, on the leg nothing tested.
          //
          // ORDER BY (created_at, id), never time alone: two commands really
          // do land in the same millisecond, and neither backend has a
          // portable insertion-order tiebreak. store.ts:1757 argues this at
          // length for the queue nobody calls; the live path needs it more,
          // because for two ORDERS "which one first" is a question about
          // somebody's money.
          `SELECT id, kind, args, created_at FROM agent_commands
            WHERE agent_id = ? AND claimed_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 5`,
        )
        .all(smartAccount)) as { id: string; kind: string; args: string | null; created_at: number }[];
      for (const r of rows) await deliverCommand(shared, home, tag, r);
    } catch {
      /* a child that misses a command this pass gets it next pass */
    }
    // ── up: results become rows ──
    await landResults(shared, home, tag);

    // ── and a row nothing will ever answer is closed, not left running ──
    //
    // An order whose child was SIGKILLed mid-trade — the watchdog does that in
    // bulk on this fleet — leaves `done_at` NULL forever, and the owner's poll
    // shows an eternal spinner while the one-at-a-time rule refuses them any
    // new order. Past its expiry it can no longer legally run, so it is closed
    // with a sentence saying so rather than left to look like it is working.
    //
    // THE FLOOR SELECTS, THE ROW'S OWN DEADLINE DECIDES. No window is shorter
    // than the floor, so nothing younger can qualify; past it, each row is held
    // to the `expiresAt` it was placed with. `done_at IS NULL` is repeated on
    // the write so a result the up-leg landed in between is never overwritten.
    //
    // "NEVER RAN" ONLY WHERE IT IS TRUE, WHICH MEANS LOOKING IN THE CHILD'S HOME
    // FIRST. It used to be written onto every unanswered row once deadline and
    // grace had passed — including rows the child had already CLAIMED and
    // might be filling that minute, because a live fill waits on its receipt
    // for up to three reads of two minutes each and a child that claims near
    // its deadline is still waiting when the grace runs out. The owner's card
    // repeats `done` word for word, and the closed row freed the one-at-a-time
    // slot: "nothing happened, ask again", with the first order on chain.
    //
    //   - never delivered: nobody has it, and the row is claimed HERE so the
    //     down-leg — which does not look at done_at — can never hand it over.
    //   - the file still queued, with a deadline: the child never took it, and
    //     from here on it refuses it at the claim (isExpired). Nothing went out.
    //   - a `.running` marker, or the file gone with no answer: the child took
    //     it. Left OPEN — so the route goes on holding the slot — until the
    //     in-flight bound has passed as well, and then closed with a sentence
    //     that does not claim to know. A late answer still replaces it.
    //   - an answer on disk: the up-leg's to land, never ours to overwrite.
    try {
      const now = Date.now();
      const candidates = (await shared
        .prepare(
          `SELECT id, args, created_at, claimed_at FROM agent_commands
            WHERE agent_id = ? AND kind = 'trade' AND done_at IS NULL AND created_at < ?`,
        )
        .all(smartAccount, now - ORDER_STALE_MS)) as {
        id: string;
        args: string | null;
        created_at: number;
        claimed_at: number | string | null;
      }[];
      const neverRan =
        "never ran — this order sat in my queue past its window without being picked up, and I will not fill it into a different market, so nothing was sent. Ask again if you still want it.";
      // Says only what is known: no answer came. Not "took it" — a delivery
      // whose file write failed after the row was claimed lands here too.
      const unanswered =
        "I never heard back from my worker about this order, so I cannot tell you whether it filled — it may have. Check your trades before asking again.";
      for (const r of candidates) {
        // ONE ROW AT A TIME: a write that failed leaves its own row open for
        // the next pass, and does not cost every row after it this one.
        try {
          const closesAt = orderClosesAt(r);
          if (now <= closesAt) continue;
          const id = String(r.id);
          const where = commandWhereabouts(home, id);
          if (where === "answered") continue;
          const args = r.args ? parseArgs(r.args) : undefined;
          // "NEVER RAN" IS C3's `expired`, whichever process noticed it: the
          // child answers an order that expired in its queue with this same
          // receipt, and the chat must not render one fact two ways depending on
          // who got there first. Only here, where nothing went out — the
          // "may have filled" closure below knows nothing, so templates nothing.
          const expired = expiredOrderReceipt(args);
          if (r.claimed_at === null || r.claimed_at === undefined) {
            // Undelivered, so no file can exist yet; a replica that delivers it
            // in the meantime wins the `claimed_at IS NULL` race and we stand down.
            if (where !== "gone") continue;
            await closeWithReceipt(
              shared,
              { sql: "done_at = ?, claimed_at = ?, result = ?", args: [now, now, neverRan] },
              expired,
              { sql: "id = ? AND done_at IS NULL AND claimed_at IS NULL", args: [id] },
            );
            continue;
          }
          const expiresAt = args?.expiresAt;
          if (where === "queued" && typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
            await closeWithReceipt(
              shared,
              { sql: "done_at = ?, result = ?", args: [now, neverRan] },
              expired,
              { sql: "id = ? AND done_at IS NULL", args: [id] },
            );
            continue;
          }
          // Taken, or a deadline-less file the child would still run: either
          // way it may go out, so nothing is said until it no longer can.
          if (now <= closesAt + ORDER_IN_FLIGHT_MS) continue;
          await shared
            .prepare("UPDATE agent_commands SET done_at = ?, result = ? WHERE id = ? AND done_at IS NULL")
            .run(now, unanswered, id);
        } catch {
          /* left open (done_at NULL): the next pass retries this row whole */
        }
      }
    } catch {
      /* best effort; the age bound in the route is the other half of this */
    }
  }
}
/**
 * ONE LINE THAT SAYS WHETHER THE FLEET IS ALL RIGHT.
 *
 * Nothing aggregated. Per-tenant state existed — a status column, a heartbeat,
 * an event feed — and every one of them had to be looked up by somebody who
 * already suspected a problem. So when ten agents stopped arming, the signal
 * was ten identical stack traces interleaved with normal chatter in a log
 * nobody tails, and it stayed that way for hours.
 *
 * Printed every reconcile, unconditionally, so its ABSENCE is also a signal.
 * A summary that only appears when something is wrong teaches an operator to
 * read silence as health, and silence is exactly what a wedged process emits.
 *
 * Cheap and best-effort: one grouped count against a table the mirror has just
 * written, and a failure here must never take the fleet loop down.
 */
async function fleetHealth(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  try {
    const shared = await makePgDb(url);
    const rows = (await shared
      .prepare("SELECT status, COUNT(*) AS n FROM agents GROUP BY status")
      .all()) as { status: string; n: number | string }[];
    const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
    const total = [...by.values()].reduce((a, b) => a + b, 0);
    const broken = by.get("error") ?? 0;
    const parts = [...by.entries()].map(([k, v]) => `${k} ${v}`).join(", ");
    // The word BROKEN is in the line only when it is true, so grepping for it
    // is a working alert with no extra infrastructure.
    log(`fleet: ${total} agent(s) — ${parts}${broken > 0 ? ` — BROKEN ${broken}` : ""}`);

    // ── AND WHICH ONES, AND WHY ─────────────────────────────────────────
    //
    // The line above is the alert this function was written to be, and on its
    // own it is the same shape as the incident it was written about: it said
    // BROKEN 12 for hours and named nobody, so finding out which twelve meant
    // reading container logs by hand — exactly what the header promises this
    // replaced. A count tells an operator that something is wrong; only the
    // names tell them whether it is their canary or twelve strangers, and only
    // the reason tells them whether to act.
    //
    // Bounded, read-only and best-effort, like the count. Twelve rows and one
    // event each is nothing beside the mirror's own writes, and the cap means a
    // fleet that is wholly broken reports a readable summary rather than
    // several hundred lines that push everything else out of the log window.
    // ── AND HOW MANY ARE ACTUALLY TRADING FOR REAL ──────────────────────
    //
    // `status` says whether an agent could start; `mode` says what it is doing.
    // A fleet can be 32-of-32 armed and simulating every fill, which is exactly
    // what a tester found by hand and reported as "I can't see an option to
    // switch to real trading". Counted here so nobody has to find that out one
    // agent at a time.
    // Carried out of the block below so the funnel can tell an IDLE fleet from
    // an unreadable one. Null means the read failed, which is not zero.
    let liveAgents: number | null = null;
    try {
      const modes = (await shared
        .prepare("SELECT COALESCE(mode, 'unknown') AS mode, COUNT(*) AS n FROM agents GROUP BY mode")
        .all()) as { mode: string; n: number | string }[];
      if (modes.length) {
        const line = modes.map((m) => `${m.mode} ${Number(m.n)}`).join(", ");
        log(`fleet| rails — ${line}`);
      }
      liveAgents = modes
        .filter((m) => String(m.mode) === "live")
        .reduce((s, m) => s + Number(m.n), 0);
    } catch {
      // The column may predate this deploy on a database mid-migration. A
      // missing breakdown is not a fleet that is down.
    }

    // ── IS AUTONOMY STILL HEALTHY? ONE LINE, FROM THE LEDGER ────────────
    //
    // Everything below was previously answerable only by reading raw container
    // logs, which is how a fleet that had not landed a single autonomous fill
    // in weeks went unnoticed. The funnel is the shape that matters: a hundred
    // proposals and zero fills is a completely different fault from zero
    // proposals, and a count of "trades" tells you neither.
    //
    // ONE HOUR, because the question is "is it working NOW". A lifetime total
    // keeps reading healthy for days after execution breaks — the canary's six
    // fills would mask a fleet that stopped this morning.
    //
    // Read-only, bounded, and wrapped like the block above: a missing column on
    // a database mid-migration is not a fleet that is down, and this must never
    // be the thing that stops a mirror pass.
    try {
      const since = Math.floor(Date.now() / 1000) - 3600;
      const t = (await shared
        .prepare(
          `SELECT status, COALESCE(reject_rule, '') AS rule, COUNT(*) AS n
             FROM trades WHERE at >= ? GROUP BY status, rule`,
        )
        .all(since)) as { status: string; rule: string; n: number | string }[];
      const h = (await shared
        .prepare(
          `SELECT COALESCE(hold_kind, 'unreported') AS kind, COUNT(*) AS n
             FROM decisions WHERE at >= ? AND action = 'hold' GROUP BY kind`,
        )
        .all(since)) as { kind: string; n: number | string }[];

      const n = (f: (r: { status: string; rule: string }) => boolean) =>
        t.filter(f).reduce((s, r) => s + Number(r.n), 0);
      const proposals = t.reduce((s, r) => s + Number(r.n), 0);
      const rejected = n((r) => r.status === "rejected");
      const landed = n((r) => r.status === "landed");
      const failed = n((r) => r.status === "reverted");
      const submitted = n((r) => r.status === "submitted") + landed + failed;
      const tooWide = n((r) => r.rule === "grant-too-wide");

      // SILENT ONLY WHEN NOBODY IS LIVE — because silence means two things and
      // this is a health metric.
      //
      // It used to be silent on any idle hour. But "no agent is trading for
      // real" and "every agent is live and proposed nothing for an hour" are
      // opposite facts, and the second is the one worth waking up for: it is
      // precisely the state that went unnoticed for weeks. Rendered identically
      // as an absent line, an operator reads the alarming case as the boring
      // one — the same empty-versus-unavailable mistake this codebase refuses
      // everywhere it prints a number.
      //
      // `liveAgents === null` is a FAILED READ and stays silent, because
      // claiming "0 live" off a query that did not answer would be the same
      // error pointing the other way.
      if (proposals > 0 || h.length > 0 || (liveAgents !== null && liveAgents > 0)) {
        log(
          `autonomy| 1h — ${liveAgents ?? "?"} live · proposals ${proposals} · ` +
            `policy-passed ${proposals - rejected} · ` +
            `userops ${submitted} · LANDED ${landed} · failed ${failed} · ` +
            `grant-too-wide ${tooWide} · holds ${autonomyHolds(h)}`,
        );
        // The refusals, largest first, so a new one announces itself rather
        // than hiding inside a total. Bounded — a fleet refusing in twenty ways
        // should report the five that matter, not push the log window out.
        const why = t
          .filter((r) => r.status === "rejected" && r.rule)
          .sort((a, b) => Number(b.n) - Number(a.n))
          .slice(0, 5)
          .map((r) => `${r.rule} ${Number(r.n)}`)
          .join(" · ");
        if (why) log(`autonomy| 1h refusals — ${why}`);
      }
    } catch {
      // `hold_kind` predates this deploy on a database mid-migration, and the
      // funnel is a report rather than a guarantee.
    }

    if (broken > 0) {
      const worst = (await shared
        .prepare(
          `SELECT smart_account, name FROM agents WHERE status = 'error' ORDER BY name LIMIT 12`,
        )
        .all()) as { smart_account: string; name: string }[];
      for (const a of worst) {
        const why = (await shared
          .prepare(
            `SELECT message FROM events
              WHERE LOWER(agent_id) = ? AND level = 'err'
              ORDER BY created_at DESC LIMIT 1`,
          )
          .get(String(a.smart_account ?? "").toLowerCase())) as { message?: string } | undefined;
        // "no recorded reason" is a DIFFERENT fact from a reason we can quote,
        // and it points somewhere else: an agent marked broken with nothing
        // written beside it was marked by something that did not say why.
        log(
          `fleet| BROKEN ${String(a.smart_account ?? "?").slice(0, 10)}… ${String(a.name ?? "?").slice(0, 16).padEnd(16)} ` +
            `${why?.message ? why.message.slice(0, 160) : "no recorded reason — nothing wrote an err event for this agent"}`,
        );
      }
      if (broken > worst.length) log(`fleet| …and ${broken - worst.length} more not listed`);
    }
  } catch {
    // A health read that fails is not a fleet that is down. Say nothing rather
    // than raise a false alarm, and never take the loop with it.
  }
}

/** The kinds the autonomy line names, in the order it names them. */
const HOLD_BUCKETS: readonly (readonly [kind: string, label: string])[] = [
  ["MODEL_HOLD", "model"],
  ["GATE_FORCED_HOLD", "gate-forced"],
  ["STALE_MARK_HOLD", "stale-mark"],
  ["unreported", "unreported"],
];

/**
 * THE HOLDS CLAUSE OF THE AUTONOMY LINE, and every hold the query read is in it.
 *
 * It named three kinds and summed only those. When the writer started stamping
 * a hold on a stale price as STALE_MARK_HOLD — which had counted as a model
 * hold until then — those holds fell out of the line entirely, and a fleet
 * holding on dead feeds read as a fleet holding less. So the named buckets are
 * always printed (a kind the query found none of is a measured zero), and any
 * kind this list does not know is printed under its own name rather than
 * dropped. A new kind at the writer then shows up here the first hour it
 * happens, instead of being noticed as a gap in a total.
 */
export function autonomyHolds(rows: readonly { kind: string; n: number | string }[]): string {
  const count = (k: string) => rows.filter((r) => r.kind === k).reduce((s, r) => s + Number(r.n), 0);
  const named = new Set(HOLD_BUCKETS.map(([k]) => k));
  const unknown = [...new Set(rows.map((r) => r.kind).filter((k) => !named.has(k)))].sort();
  return [
    ...HOLD_BUCKETS.map(([k, label]) => `${count(k)} ${label}`),
    ...unknown.map((k) => `${count(k)} ${k}`),
  ].join(", ");
}

/**
 * Dump the accounting diagnosis to the log, once, at boot, when asked.
 *
 * OFF BY DEFAULT and read-only. It exists because the shared Postgres is
 * reachable only from inside Railway's private network — `DATABASE_URL` names
 * `postgres.railway.internal` and there is no public proxy — so the spike script
 * beside it cannot run from a laptop. This process is already in there.
 *
 * A fleet-wide financial dump is not something a routine boot should emit, hence
 * the flag; and it must never be able to stop the fleet arming, hence the catch.
 */
async function runAccountingDiagnosisIfAsked(): Promise<void> {
  if ((process.env.MERRYMEN_ACCOUNTING_DIAGNOSE ?? "").trim() !== "1") return;
  const url = process.env.DATABASE_URL;
  if (!url) {
    log("accounting diagnosis asked for, but there is no DATABASE_URL");
    return;
  }
  try {
    const shared = await makePgDb(url);
    const all = await diagnoseAccounting(shared);
    for (const line of diagnosisLines(all)) log(`diag| ${line}`);
  } catch (e) {
    log(`accounting diagnosis failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The DRY RUN: chain truth joined to the ledger, and the exact mutation it
 * implies. Read-only, off by default, and it writes nothing anywhere.
 *
 * It lives here rather than in the spike beside it for the same reason the
 * diagnosis does — the shared Postgres answers only from inside Railway's
 * private network — and because this half additionally needs the RPC, which the
 * orchestrator already has configured.
 */
/**
 * WHERE THE GAS WENT, for one or more named accounts. READ ONLY.
 *
 * `MERRYMEN_GAS_AUDIT=0xabc,0xdef` (or `all`). Only SELECTs, and the module it
 * calls has no database handle at all — it is handed rows and returns strings,
 * which is the same shape `accounting-preview` uses and for the same reason:
 * a reporting path that cannot write cannot be argued with.
 *
 * Named accounts rather than a fleet default because this prints per-operation
 * evidence, and `railway logs` is a 503-line snapshot shared with a mirror that
 * writes ~200 lines a minute. A report that does not fit is not a report.
 */
async function runGasAuditIfAsked(): Promise<void> {
  const want = (process.env.MERRYMEN_GAS_AUDIT ?? "").trim();
  if (!want) return;
  const url = process.env.DATABASE_URL;
  if (!url) {
    log("gas audit asked for, but there is no DATABASE_URL");
    return;
  }
  try {
    const shared = await makePgDb(url);
    const wanted = want
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const all = wanted.includes("all");

    const agents = (await shared
      .prepare("SELECT smart_account, COALESCE(epoch, 1) AS epoch FROM agents")
      .all()) as unknown as { smart_account: string; epoch: number }[];

    for (const a of agents) {
      const account = String(a.smart_account ?? "");
      const key = account.toLowerCase();
      if (!all && !wanted.some((w) => key.startsWith(w))) continue;
      const epoch = Number(a.epoch ?? 1);

      // OLDEST FIRST, and that ordering is load-bearing: "the first landed op"
      // is where any account-deployment cost lands, and a descending sort would
      // attribute it to the most recent trade instead.
      const rows = (await shared
        .prepare(
          `SELECT id, kind, target, amount_usdg, status, user_op_hash, tx_hash,
                  gas_wei, sponsored_gas_wei, gas_usdg, gas_units, epoch, created_at
             FROM trades
            WHERE LOWER(agent_id) = ? AND epoch = ?
            ORDER BY created_at ASC, id ASC`,
        )
        .all(key, epoch)) as unknown as Record<string, unknown>[];

      const ops: GasOp[] = rows.map((r) => ({
        id: Number(r.id ?? 0),
        kind: String(r.kind ?? ""),
        target: String(r.target ?? ""),
        amountUsdg: Number(r.amount_usdg ?? 0),
        status: String(r.status ?? ""),
        userOpHash: r.user_op_hash === null || r.user_op_hash === undefined ? null : String(r.user_op_hash),
        txHash: r.tx_hash === null || r.tx_hash === undefined ? null : String(r.tx_hash),
        gasWei: r.gas_wei === null || r.gas_wei === undefined ? null : String(r.gas_wei),
        gasUnits: r.gas_units === null || r.gas_units === undefined ? null : String(r.gas_units),
        sponsoredGasWei:
          r.sponsored_gas_wei === null || r.sponsored_gas_wei === undefined ? null : String(r.sponsored_gas_wei),
        gasUsdg: r.gas_usdg === null || r.gas_usdg === undefined ? null : Number(r.gas_usdg),
        epoch: Number(r.epoch ?? 1),
        createdAt: Number(r.created_at ?? 0),
      }));

      if (ops.length === 0) {
        log(`gas| ${account} epoch ${epoch} — no operations recorded`);
        continue;
      }
      for (const line of gasAuditLines(decomposeGas(account, epoch, ops))) log(`gas| ${line}`);
    }
  } catch (e) {
    log(`gas audit failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * WHICH AGENTS ARE WORTH SHADOWING. READ ONLY.
 *
 * `MERRYMEN_COHORT_VET=1`. Prints one block per agent so a cohort is chosen
 * from evidence rather than from balances — see cohort-vetting.ts for why the
 * balance is the wrong signal.
 */
async function runCohortVettingIfAsked(): Promise<void> {
  if ((process.env.MERRYMEN_COHORT_VET ?? "").trim() !== "1") return;
  const url = process.env.DATABASE_URL;
  if (!url) {
    log("cohort vetting asked for, but there is no DATABASE_URL");
    return;
  }
  try {
    const shared = await makePgDb(url);
    const nowSec = Math.floor(Date.now() / 1000);
    const agents = (await shared
      .prepare(
        `SELECT smart_account, name, COALESCE(epoch, 1) AS epoch, mode, beat_at, contributions_known
           FROM agents WHERE smart_account NOT LIKE 'rh:%'`,
      )
      .all()) as unknown as Record<string, unknown>[];

    const verdicts: CandidateVerdictDetail[] = [];
    for (const a of agents) {
      const account = String(a.smart_account ?? "");
      const key = account.toLowerCase();
      const epoch = Number(a.epoch ?? 1);

      const flows = (await shared
        .prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
             FROM flows WHERE LOWER(agent_id) = ? AND epoch = ?`,
        )
        .get(key, epoch)) as { n: number; net: number } | undefined;

      // The same evidence `legacyRowsInEpoch` uses, asked of the shared copy.
      const legacy = (await shared
        .prepare(
          `SELECT (SELECT COUNT(*) FROM trades WHERE LOWER(agent_id) = ? AND epoch = ? AND created_at < ?)
                + (SELECT COUNT(*) FROM equity WHERE LOWER(agent_id) = ? AND epoch = ? AND at < ?) AS n`,
        )
        .get(key, epoch, ACCOUNTING_FIXED_AT, key, epoch, ACCOUNTING_FIXED_AT)) as { n: number } | undefined;

      const pos = (await shared
        .prepare(
          `SELECT symbol, token, value_usdg, price_stale, price_source, updated_at
             FROM positions WHERE LOWER(agent_id) = ?`,
        )
        .all(key)) as unknown as Record<string, unknown>[];

      // The newest equity row still carries the positions total, so an empty
      // book can be told from one the mirror has not repopulated yet.
      const eq = (await shared
        .prepare(`SELECT positions_usdg FROM equity WHERE LOWER(agent_id) = ? ORDER BY at DESC LIMIT 1`)
        .get(key)) as { positions_usdg: number } | undefined;

      const fills = (await shared
        .prepare(`SELECT COUNT(*) AS n FROM trades WHERE LOWER(agent_id) = ? AND status = 'landed'`)
        .get(key)) as { n: number } | undefined;
      const decisions = (await shared
        .prepare(`SELECT COUNT(*) AS n FROM decisions WHERE LOWER(agent_id) = ?`)
        .get(key)) as { n: number } | undefined;

      verdicts.push(
        vetCandidate(
          {
            account,
            name: String(a.name ?? ""),
            epoch,
            mode: a.mode === null || a.mode === undefined ? null : String(a.mode),
            beatAt: a.beat_at === null || a.beat_at === undefined ? null : Number(a.beat_at),
            // NO ROWS IS ZERO; NO ANSWER IS NULL. An agent nobody funded has
            // contributed nothing, which is knowledge. A query that came back
            // with nothing at all is a question we failed to ask, and the two
            // must not collapse — one blocks the candidate, the other says we
            // do not know whether to.
            netContributionsUsdg: flows === undefined ? null : Number(flows.net ?? 0),
            legacyRows: Number(legacy?.n ?? 0),
            positions: pos.map((p) => ({
              symbol: String(p.symbol ?? ""),
              token: String(p.token ?? ""),
              valueUsdg: Number(p.value_usdg ?? 0),
              // Postgres gives a boolean, sqlite an integer. Both are truthy the
              // same way, and neither may be read as "fresh" by accident.
              priceStale: p.price_stale === true || Number(p.price_stale ?? 0) === 1,
              priceSource: String(p.price_source ?? "unknown"),
              updatedAt: Number(p.updated_at ?? 0),
            })),
            lastEquityPositionsUsdg: eq === undefined ? null : Number(eq.positions_usdg ?? 0),
            landedTrades: Number(fills?.n ?? 0),
            decisions: Number(decisions?.n ?? 0),
          },
          nowSec,
        ),
      );
    }

    // Best candidates first, so the top of the report is the answer.
    const rank: Record<string, number> = {
      READY: 0,
      "READY-WHEN-MARKET-OPENS": 1,
      "READY-CANDIDATE-ONLY": 2,
    };
    verdicts.sort((x, y) => (rank[x.verdict] ?? 9) - (rank[y.verdict] ?? 9) || y.equityUsdg - x.equityUsdg);
    for (const line of cohortLines(verdicts)) log(`cohort| ${line}`);
  } catch (e) {
    log(`cohort vetting failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * THE SHADOW DATASET. READ ONLY. `MERRYMEN_BRAIN_DATASET=1`.
 *
 * Every field is already persisted; this is the only way to read it back.
 * Shared Postgres is private-network-only and `railway logs` is a 503-line
 * snapshot a 24-child fleet fills in about a minute, so a cohort collected over
 * an afternoon is durable in the database and invisible to anyone looking.
 */
async function runBrainDatasetIfAsked(): Promise<void> {
  if ((process.env.MERRYMEN_BRAIN_DATASET ?? "").trim() !== "1") return;
  const url = process.env.DATABASE_URL;
  if (!url) {
    log("brain dataset asked for, but there is no DATABASE_URL");
    return;
  }
  try {
    const shared = await makePgDb(url);
    const rows = (await shared
      .prepare(
        `SELECT d.agent_id, COALESCE(a.name, '') AS name, d.at, d.symbol, d.action, d.size_usdg,
                d.id, d.reason, d.signals_json
           FROM decisions d
           LEFT JOIN agents a ON a.smart_account = d.agent_id
          WHERE d.source = 'brain-shadow'
          ORDER BY d.at ASC`,
      )
      .all()) as unknown as Record<string, unknown>[];

    const views = rows.map((r) => {
      let signals: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(r.signals_json ?? "{}")) as unknown;
        if (parsed && typeof parsed === "object") signals = parsed as Record<string, unknown>;
      } catch {
        // A row whose blob will not parse is still a decision that happened.
        // Dropping it would quietly shrink the denominator of every rate below.
      }
      return viewRun({
        agentId: String(r.agent_id ?? ""),
        agentName: String(r.name ?? ""),
        at: Number(r.at ?? 0),
        symbol: r.symbol === null || r.symbol === undefined ? null : String(r.symbol),
        action: r.action === null || r.action === undefined ? null : String(r.action),
        sizeUsdg: r.size_usdg === null || r.size_usdg === undefined ? null : Number(r.size_usdg),
        thesis: r.reason === null || r.reason === undefined ? null : String(r.reason),
        signals,
      });
    });
    for (const line of datasetLines(views)) log(`data| ${line}`);
  } catch (e) {
    log(`brain dataset failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * THE IDENTITY AUDIT. READ ONLY. `MERRYMEN_IDENTITY_AUDIT=1`.
 *
 * Runs before any uniqueness constraint is added, because a UNIQUE index over a
 * table that already violates it fails inside the store's lazy bootstrap — and
 * every public read awaits that bootstrap, so the failure presents as the site
 * going dark rather than as a migration error. Nothing here writes, and nothing
 * here deduplicates: two rows claiming one account is a question about which
 * person owns an agent.
 */
/**
 * THE ONE-OFF PLATFORM ANNOUNCEMENT, FIREABLE WITHOUT A TERMINAL.
 *
 * `announce-cli.ts` is the same job for someone with a shell on this service.
 * This exists because an operator away from their machine has no shell — and
 * Railway's own dashboard, which sets these variables, works from a phone.
 *
 * TWO KEYS, DELIBERATELY. `MERRYMEN_ANNOUNCE_ID` arms a DRY RUN, which resolves
 * every recipient, builds every message and contacts Telegram zero times.
 * Sending additionally requires `MERRYMEN_ANNOUNCE_CONFIRM` to equal that same
 * id, so the difference between a rehearsal and messaging every beta tester is
 * never one variable set by muscle memory.
 *
 * SAFE TO LEAVE SET. This runs on the reconcile loop and Railway restarts
 * services freely, so it must be harmless to re-enter: `runAnnouncement` skips
 * anyone already recorded in `announcements`, per recipient, so a redeploy
 * re-runs and sends nothing new. The body ships in the repo because there is no
 * other way to hand this process a file.
 */
/**
 * GRANT LIVE INTENT TO THE PEOPLE WHO ALREADY HAD IT, ONCE, BEFORE ENFORCEMENT.
 *
 * `liveTradingEnabled` defaults FALSE and `worker/src/settings.ts` resolves an
 * absent field to the default, so the deploy that enforces the consent gate
 * would otherwise move every agent in the fleet to paper — including the ones
 * whose owners are watching them trade real funds. See backfill-live-intent.ts
 * for what counts as consent already given, and what deliberately does not.
 *
 * TWO STEPS, OPERATOR-DRIVEN, because this writes settings on other people's
 * agents and the report is the only chance to notice it is wrong:
 *
 *   MERRYMEN_BACKFILL_LIVE_INTENT=report   read, decide, print, write nothing
 *   MERRYMEN_BACKFILL_LIVE_INTENT=apply    the same, then write the grants
 *
 * Idempotent either way: once applied, every tenant it touched carries the
 * field explicitly and the next plan is empty.
 */
let liveIntentBackfillRan = false;
let tenantInspectRan = false;
let hwmRepairRan = false;

/**
 * WHAT THE FLEET'S HIGH-WATER MARKS SHOULD BE, AND WHY. REPORT ONLY.
 *
 * `MERRYMEN_REPAIR_HWM=report` prints one plan per tenant and writes nothing.
 * There is deliberately no apply path in this commit: the figures it proposes
 * are what the drawdown breaker divides by and what the performance fee is
 * measured against, and a tool that could write them the moment it was armed is
 * one typo away from halting a fleet or charging owners on their own principal.
 *
 * It derives rather than assumes — see `hwm-repair.ts` for the rule and the two
 * clamps. What lives HERE is only the gathering: the roster from the grant
 * store, the durable figures from Postgres, and the capital totals from a
 * full-history chain sweep classified by `classifyUsdgMovement`.
 *
 * THE MANAGED SYSTEM IS THE ACCOUNT *AND* ITS CLASS VAULT. Both are scanned and
 * their capital totals summed, because money can enter custody without ever
 * touching the account — Shogun's vault was paid 5.785344 USDG directly by a
 * DOGGOS-linked contract, which no account-scoped scan can see. Movements
 * BETWEEN the two are classified `internal` or as trade legs and contribute
 * nothing, so summing cannot double-count them.
 */
async function runHwmRepairIfAsked(): Promise<void> {
  const mode = (process.env.MERRYMEN_REPAIR_HWM ?? "").trim().toLowerCase();
  if (!mode) return;
  if (hwmRepairRan) return;
  hwmRepairRan = true;

  if (mode !== "report" && mode !== "apply") {
    // NAMED, NOT ASSUMED. A typo must be told plainly rather than read as
    // `report` — or worse, as `apply`.
    log(`hwm| MERRYMEN_REPAIR_HWM=${mode} is not a mode. Use "report" or "apply"; nothing was done.`);
    return;
  }
  const applying = mode === "apply";
  // A FLEET-WIDE APPLY IS NOT A THING. Every write here moves the figure the
  // drawdown breaker divides by and the performance fee is measured against, so
  // it happens to tenants somebody named, one at a time, having read their
  // numbers. `report` may sweep the fleet; `apply` may not.
  if (applying && !(process.env.MERRYMEN_REPAIR_HWM_ONLY ?? "").trim()) {
    log("hwm| REFUSING to apply without MERRYMEN_REPAIR_HWM_ONLY — name the tenants explicitly");
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    log("hwm| asked for, but there is no DATABASE_URL");
    return;
  }

  try {
    const { hwmWriteTargets, planHwmRepair, repairLines } = await import("./hwm-repair");
    const shared = await makePgDb(url);
    // THE SCHEMA FIRST, because this pass runs BEFORE `mirrorLedgers`, and the
    // mirror is the only thing that applies the ledger DDL to the shared
    // database. On the first boot after a migration this read asked for
    // `hwm_withdrawn_usdg` a few seconds before anything created it, failed, and
    // — because the once-per-process guard had already fired — never retried.
    // Idempotent, and it makes the tool independent of what else ran first.
    await applyLedgerSchema(shared);

    const agentRows = (await shared
      .prepare(
        "SELECT smart_account, name, hwm_usdg, hwm_withdrawn_usdg FROM agents",
      )
      .all()) as unknown as Record<string, unknown>[];
    const agentBy = new Map(agentRows.map((a) => [String(a.smart_account).toLowerCase(), a]));

    const equityRows = (await shared
      .prepare("SELECT agent_id, equity_usdg FROM equity ORDER BY agent_id, at DESC, id DESC")
      .all()) as unknown as Record<string, unknown>[];
    const equityBy = new Map<string, number>();
    // THE BEST MARK THIS BOOK EVER HAD, which is what bounds a claim about
    // profit: a peak is a peak OF EQUITY, so profit genuinely earned had to be
    // marked at the time.
    const maxEquityBy = new Map<string, number>();
    for (const e of equityRows) {
      const k = String(e.agent_id).toLowerCase();
      const v = Number(e.equity_usdg);
      if (!equityBy.has(k)) equityBy.set(k, v);
      if (!maxEquityBy.has(k) || v > (maxEquityBy.get(k) as number)) maxEquityBy.set(k, v);
    }

    // THE PEAK'S PERFORMANCE COMPONENT. `fee_accruals` is the only durable
    // record of the mark being raised by profit rather than by capital, so it
    // is what keeps a genuine earner's peak from being cut down to their
    // deposits — which would re-charge them for profit already paid on.
    const feeRows = (await shared
      .prepare("SELECT agent_id, SUM(profit_usdg) AS profit FROM fee_accruals GROUP BY agent_id")
      .all()) as unknown as Record<string, unknown>[];
    const profitBy = new Map(feeRows.map((r) => [String(r.agent_id).toLowerCase(), Number(r.profit ?? 0)]));

    // Class positions the owner swept home. Non-USDG capital leaving custody,
    // which no USDG log names — valued at COST, never at a curve mark.
    const classRows = (await shared
      .prepare("SELECT agent_id, token, state, cost_usdg FROM class_positions")
      .all()) as unknown as Record<string, unknown>[];
    const sweptCostBy = new Map<string, number>();
    const sweptUnknownBy = new Map<string, number>();
    const cashToken = String(CASH.USDG).toLowerCase();
    for (const c of classRows) {
      if (String(c.state ?? "") !== "swept") continue;
      // A QUOTE-TOKEN ROW IS NOT A POSITION, and counting it here would both
      // double-count and block the whole tenant.
      //
      // This adjustment exists for capital the USDG scanner is BLIND to —
      // memecoins leaving the vault as tokens, in transactions no USDG log
      // mentions. USDG stranded in a vault is not blind to it: it goes
      // vault→account→owner as USDG and the chain sweep already counts it as a
      // withdrawal. Shogun has exactly such a row, enumerated by the recovery
      // planner with no cost basis, and it alone made the tenant unproposable.
      if (String(c.token ?? "").toLowerCase() === cashToken) continue;
      const k = String(c.agent_id).toLowerCase();
      const raw = c.cost_usdg === null || c.cost_usdg === undefined ? null : String(c.cost_usdg);
      if (raw === null) {
        sweptUnknownBy.set(k, (sweptUnknownBy.get(k) ?? 0) + 1);
        continue;
      }
      sweptCostBy.set(k, (sweptCostBy.get(k) ?? 0) + Number(raw) / 1e6);
    }

    // ── the roster, from the grant store ─────────────────────────────────
    const roster: { tenant: string; account: string; vaults: readonly string[]; capBps: number | null }[] = [];
    const gs = getGrantStore();
    for (const tenant of await gs.listTenants()) {
      const g = await gs.get(tenant);
      const acct = g?.smartAccount ? String(g.smartAccount) : null;
      if (!acct) {
        log(`hwm| tenant ${tenant} holds a grant with no smart account — skipped`);
        continue;
      }
      const caps = (g as unknown as { caps?: Record<string, unknown> })?.caps ?? null;
      const pct = caps && typeof caps.maxDrawdownPct === "number" ? caps.maxDrawdownPct : null;
      roster.push({ tenant, account: acct, vaults: custodyAddressesOf(g), capBps: pct === null ? null : pct * 100 });
    }
    log(`hwm| roster: ${roster.length} tenant(s) with a grant`);

    // SCOPE, because `railway logs` is a ~500-line snapshot rather than a
    // stream and the ledger mirror alone writes a couple of hundred lines a
    // minute. A 45-tenant report is ~450 lines and pushes its own head out of
    // the window before it can be read — a report that cannot be retrieved is
    // not a report. Names TENANTS, not accounts, because that is what an
    // operator has in front of them.
    const only = new Set(
      (process.env.MERRYMEN_REPAIR_HWM_ONLY ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.startsWith("0x")),
    );
    const scoped = only.size ? roster.filter((r) => only.has(r.tenant.toLowerCase())) : roster;
    if (only.size && scoped.length !== only.size) {
      // LOUD. A named tenant that is not in the roster silently does nothing,
      // and "2 examined" after naming 3 gives an operator no way to tell which.
      log(`hwm| WARNING: ${only.size} tenant(s) named but ${scoped.length} found in the roster`);
    }
    roster.length = 0;
    roster.push(...scoped);

    // ── the chain, full history, accounts AND their vaults ───────────────
    const rpcUrl = process.env.MERRYMEN_RPC_MAINNET ?? "https://rpc.mainnet.chain.robinhood.com";
    let rpcId = 1;
    const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
      const r = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      });
      const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
      if (j.error) throw new Error(j.error.message ?? "rpc error");
      return j.result ?? null;
    };
    const head = BigInt((await rpc("eth_blockNumber", [])) as string);
    const custodyOf = new Map<string, readonly string[]>();
    for (const r of roster) if (r.vaults.length) custodyOf.set(r.account.toLowerCase(), r.vaults);
    const scanTargets = [...new Set(roster.flatMap((r) => [r.account, ...r.vaults]))];
    log(`hwm| scanning ${scanTargets.length} address(es) to block ${head} (accounts and their class vaults)`);

    const chain = await scanFleetCapital(rpc, {
      accounts: scanTargets,
      usdgToken: String(CASH.USDG),
      fromBlock: 0n,
      toBlock: head,
      custodyAddressesFor: (a) => custodyOf.get(a.toLowerCase()),
      log: (m) => log(`hwm| ${m}`),
    });

    // AN OPERATOR JUDGEMENT, PER NAMED TENANT. Not a rule and not a heuristic:
    // a tenant appears here because somebody read its numbers and concluded its
    // recorded fee-history profit is legacy residue. Shogun is the case it
    // exists for — 24.915968 of recorded profit against a book never marked
    // above 25.000000 and a chain lifetime result of 0.000000.
    const phantomProfit = new Set(
      (process.env.MERRYMEN_REPAIR_HWM_PHANTOM_PROFIT ?? "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.startsWith("0x")),
    );
    if (phantomProfit.size) {
      log(
        `hwm| operator declares the fee history phantom for ${phantomProfit.size} named tenant(s): ` +
          [...phantomProfit].join(", "),
      );
    }

    const plans = roster.map((r) => {
      const key = r.account.toLowerCase();
      const a = agentBy.get(key);
      const gross = a?.hwm_usdg === undefined || a?.hwm_usdg === null ? null : Number(a.hwm_usdg);
      const withdrawn = a?.hwm_withdrawn_usdg === undefined || a?.hwm_withdrawn_usdg === null ? 0 : Number(a.hwm_withdrawn_usdg);

      // SUMMED ACROSS THE ACCOUNT AND ITS VAULT, which together are the
      // managed system. `complete` is AND-ed: one unread window anywhere in
      // custody makes the whole derivation for this tenant unsafe.
      let deposits: number | null = 0;
      let withdrawals: number | null = 0;
      let internalMoves = 0;
      let tradeLegs = 0;
      let ambiguousMoves = 0;
      let complete = true;
      const notes: string[] = [];
      for (const addr of [r.account, ...r.vaults]) {
        const c = chain.get(addr.toLowerCase());
        if (!c) {
          complete = false;
          notes.push(`no scan result for ${addr}`);
          continue;
        }
        if (!c.complete) complete = false;
        deposits = deposits === null ? null : deposits + Number(BigInt(c.totals.grossContributionsRaw)) / 1e6;
        withdrawals = withdrawals === null ? null : withdrawals + Number(BigInt(c.totals.grossWithdrawalsRaw)) / 1e6;
        internalMoves += c.totals.internal;
        tradeLegs += c.totals.tradeLegs;
        ambiguousMoves += c.totals.ambiguous;
        notes.push(...c.notes);
      }

      return planHwmRepair({
        tenant: r.tenant,
        smartAccount: r.account,
        name: a?.name === undefined || a?.name === null ? null : String(a.name),
        equityUsdg: equityBy.get(key) ?? null,
        currentHwmUsdg: gross === null ? null : Math.max(0, gross - withdrawn),
        maxDrawdownBps: r.capBps,
        depositsUsdg: deposits,
        withdrawalsUsdg: withdrawals,
        internalMoves,
        tradeLegs,
        ambiguousMoves,
        sweptAtCostUsdg: sweptCostBy.get(key) ?? 0,
        sweptUnpriceable: sweptUnknownBy.get(key) ?? 0,
        ratchetedProfitUsdg: profitBy.get(key) ?? 0,
        maxEquityUsdg: maxEquityBy.get(key) ?? null,
        scanComplete: complete,
        scanNote: notes.length ? notes.slice(0, 2).join("; ") : null,
      }, { treatProfitAsPhantom: phantomProfit.has(r.tenant.toLowerCase()) });
    });

    for (const line of repairLines(plans)) log(`hwm| ${line}`);

    if (!applying) {
      log("hwm| REPORT ONLY — nothing was written. Remove MERRYMEN_REPAIR_HWM now.");
      return;
    }

    // ── the apply ────────────────────────────────────────────────────────
    //
    // EXPRESSED ENTIRELY AS RAISES. The effective peak is
    // `hwm_usdg − hwm_withdrawn_usdg` and both halves are one-way ratchets, so
    // lowering a peak means raising the second faster than the first. Nothing
    // here gains the ability to write a peak DOWN, which matters because such a
    // door would then be available to every future caller — including a rebuilt
    // child reporting its schema defaults.
    for (const plan of plans) {
      const acct = plan.facts.smartAccount;
      const a = agentBy.get(acct.toLowerCase());
      const current = {
        grossUsdg: a?.hwm_usdg === null || a?.hwm_usdg === undefined ? 0 : Number(a.hwm_usdg),
        withdrawnUsdg:
          a?.hwm_withdrawn_usdg === null || a?.hwm_withdrawn_usdg === undefined
            ? 0
            : Number(a.hwm_withdrawn_usdg),
      };
      const t = hwmWriteTargets(plan, current);
      if ("refused" in t) {
        log(`hwm| ${plan.facts.tenant} NOT APPLIED — ${t.refused}`);
        continue;
      }
      const alreadyRight =
        t.grossUsdg === current.grossUsdg && t.withdrawnUsdg === current.withdrawnUsdg;

      // THE EVIDENCE GOES IN FIRST, and on the AGENT'S OWN event log rather than
      // only into this process's stdout. A repair whose only record is a log
      // line in a 500-line rolling window is a repair nobody can audit later —
      // and this figure is one an owner is entitled to see explained.
      //
      // WRITTEN EVEN WHEN NOTHING NEEDS CHANGING, because the point of an
      // operator-approved repair is the RECORD, not the mutation. "This peak is
      // 25.487111 because the chain shows these deposits and these withdrawals"
      // is worth exactly as much when the figure already agrees — more, in fact,
      // since the alternative is a durable number whose only explanation is that
      // several bugs happened to cancel.
      await shared
        .prepare("INSERT INTO events (agent_id, level, message) VALUES (?, ?, ?)")
        .run(
          acct,
          "ok",
          alreadyRight ? `${t.evidence} (verified: the durable figures already match)` : t.evidence,
        );

      if (alreadyRight) {
        log(
          `hwm| ${plan.facts.tenant} VERIFIED — the durable figures already equal the derivation ` +
            `(gross ${t.grossUsdg.toFixed(6)}, withdrawn ${t.withdrawnUsdg.toFixed(6)}, ` +
            `effective peak ${t.effectiveUsdg.toFixed(6)} USDG). Evidence recorded; nothing written.`,
        );
        log(`hwm| ${plan.facts.tenant} evidence: ${t.evidence}`);
        continue;
      }

      await shared
        .prepare(
          `UPDATE agents
              SET hwm_usdg = CASE WHEN ? > hwm_usdg THEN ? ELSE hwm_usdg END,
                  hwm_withdrawn_usdg = CASE WHEN ? > hwm_withdrawn_usdg
                                            THEN ? ELSE hwm_withdrawn_usdg END
            WHERE lower(smart_account) = lower(?)`,
        )
        .run(t.grossUsdg, t.grossUsdg, t.withdrawnUsdg, t.withdrawnUsdg, acct);

      // READ IT BACK. A write that reported success and changed nothing is the
      // failure this whole milestone keeps running into.
      const after = (await shared
        .prepare("SELECT hwm_usdg, hwm_withdrawn_usdg FROM agents WHERE lower(smart_account) = lower(?)")
        .get(acct)) as { hwm_usdg: number; hwm_withdrawn_usdg: number } | undefined;
      const gotGross = after === undefined ? null : Number(after.hwm_usdg);
      const gotWithdrawn = after === undefined ? null : Number(after.hwm_withdrawn_usdg);
      const effective =
        gotGross === null || gotWithdrawn === null ? null : Math.max(0, gotGross - gotWithdrawn);
      const ok =
        effective !== null && Math.abs(effective - t.effectiveUsdg) < 0.000001;
      log(
        ok
          ? `hwm| ${plan.facts.tenant} APPLIED — gross ${current.grossUsdg.toFixed(6)} → ` +
            `${(gotGross ?? 0).toFixed(6)}, withdrawn ${current.withdrawnUsdg.toFixed(6)} → ` +
            `${(gotWithdrawn ?? 0).toFixed(6)}, effective peak ${effective.toFixed(6)} USDG`
          : `hwm| ${plan.facts.tenant} *** VERIFY FAILED — read back ` +
            `gross ${gotGross} withdrawn ${gotWithdrawn}, wanted effective ${t.effectiveUsdg.toFixed(6)} ***`,
      );
      log(`hwm| ${plan.facts.tenant} evidence: ${t.evidence}`);
    }
    log("hwm| APPLY COMPLETE. Remove MERRYMEN_REPAIR_HWM now.");
  } catch (e) {
    log(`hwm| FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }
}
let enableClassRan = false;
let haltClassEntriesRan = false;
let resumeClassEntriesRan = false;

/**
 * TURN NEW CLASS ENTRIES BACK ON FOR ONE TENANT. One field, the inverse of the
 * halt, and the same read-back on both halves — that entries actually resumed,
 * and that nothing an exit depends on moved while they did.
 */
async function runResumeClassEntriesIfAsked(): Promise<void> {
  const want = (process.env.MERRYMEN_RESUME_CLASS_ENTRIES_FOR ?? "").trim().toLowerCase();
  if (!want) return;
  if (resumeClassEntriesRan) return;
  resumeClassEntriesRan = true;
  if (!/^0x[0-9a-f]{40}$/.test(want)) {
    log("resume-entries: MERRYMEN_RESUME_CLASS_ENTRIES_FOR is not an address — refusing to guess");
    return;
  }
  try {
    const { HALT_MUST_PRESERVE, mergeResumeEntries } = await import("./enable-class");
    const { getSettingsStore } = await import("./settings-store");
    const store = getSettingsStore();
    const current = (await store.get(want as `0x${string}`)) as unknown as Record<string, unknown> | null;
    const before = Object.fromEntries(HALT_MUST_PRESERVE.map((k) => [k, current?.[k]]));
    log(`resume-entries: classSnipeEnabled ${JSON.stringify(current?.classSnipeEnabled)} -> true for ${want}`);
    await store.put(want as `0x${string}`, mergeResumeEntries(current) as never);
    const after = (await store.get(want as `0x${string}`)) as unknown as Record<string, unknown> | null;
    const moved = HALT_MUST_PRESERVE.filter((k) => JSON.stringify(after?.[k]) !== JSON.stringify(before[k]));
    log(
      after?.classSnipeEnabled === true
        ? "resume-entries: WROTE and verified classSnipeEnabled=true"
        : "resume-entries: *** VERIFY FAILED — classSnipeEnabled did not stick ***",
    );
    log(
      moved.length === 0
        ? `resume-entries: every exit setting preserved (${HALT_MUST_PRESERVE.join(", ")})`
        : `resume-entries: *** ${moved.join(", ")} CHANGED ***`,
    );
    log("resume-entries: remove MERRYMEN_RESUME_CLASS_ENTRIES_FOR now.");
  } catch (e) {
    log(`resume-entries: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }
}

let classPnlRepairRan = false;
/** Once per process, like every other repair pass here. */
let cashRowRepairRan = false;

/**
 * BOOK THE RESULT OF CLASS ROUND TRIPS THAT COMPLETED WITHOUT ONE.
 *
 * `MERRYMEN_REPAIR_CLASS_PNL=report` prints and writes nothing; `apply` writes,
 * and refuses without `MERRYMEN_REPAIR_CLASS_PNL_ONLY` naming the tenants. Same
 * shape as the high-water-mark repair beside it, for the same reason: every
 * write here lands on a figure an owner reads as their result.
 *
 * THE EVIDENCE IS THE CHAIN. For each closed class position the vault's own
 * `ClassBuy`/`ClassSell` events are re-read and folded — the same
 * `foldClassEvents` the worker uses, so the repair and the engine cannot reach
 * different numbers from the same tape. A balance is never consulted: the vault
 * also holds unrelated reward USDG, and a balance would turn Shogun's 1.77 loss
 * into a gain.
 *
 * IDEMPOTENT ON CHAIN IDENTITY. The write lands on the `curve-trade` row the
 * EXIT TRANSACTION identifies, and only where that row has no realised figure
 * yet. Running twice is a no-op; running after the live path has booked the same
 * trip is refused by the planner rather than doubled. The `swap` row the
 * orphan-receipt reconciler writes for the same transaction is execution
 * evidence and is never touched — a result on both rows is the double count this
 * exists to avoid, which is why the planner refuses unless exactly one
 * `curve-trade` row carries that hash.
 */
async function runClassPnlRepairIfAsked(): Promise<void> {
  const mode = (process.env.MERRYMEN_REPAIR_CLASS_PNL ?? "").trim().toLowerCase();
  if (!mode) return;
  if (classPnlRepairRan) return;
  classPnlRepairRan = true;

  if (mode !== "report" && mode !== "apply") {
    log(`class-pnl| MERRYMEN_REPAIR_CLASS_PNL=${mode} is not a mode. Use "report" or "apply".`);
    return;
  }
  const applying = mode === "apply";
  const only = new Set(
    (process.env.MERRYMEN_REPAIR_CLASS_PNL_ONLY ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.startsWith("0x")),
  );
  if (applying && only.size === 0) {
    log("class-pnl| REFUSING to apply without MERRYMEN_REPAIR_CLASS_PNL_ONLY — name the tenants");
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    log("class-pnl| asked for, but there is no DATABASE_URL");
    return;
  }

  try {
    const { planClassPnlRepair, classPnlRepairLines } = await import("./class-pnl-repair");
    const { foldClassEvents, parseClassLogs } = await import("./venues/class-log");
    const shared = await makePgDb(url);
    await applyLedgerSchema(shared);

    const rpcUrl = process.env.MERRYMEN_RPC_MAINNET ?? "https://rpc.mainnet.chain.robinhood.com";
    let rpcId = 1;
    const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
      const r = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      });
      const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
      if (j.error) throw new Error(j.error.message ?? "rpc error");
      return j.result ?? null;
    };

    const gs = getGrantStore();
    const plans: Awaited<ReturnType<typeof planClassPnlRepair>>[] = [];
    const targets: { plan: (typeof plans)[number]; account: string }[] = [];

    for (const tenant of await gs.listTenants()) {
      if (only.size && !only.has(tenant.toLowerCase())) continue;
      const g = await gs.get(tenant);
      const acct = g?.smartAccount ? String(g.smartAccount) : null;
      const vault = custodyAddressesOf(g)[0] ?? null;
      if (!acct || !vault) continue;

      const rows = (await shared
        .prepare(
          `SELECT token, symbol, state, entry_tx, exit_tx
             FROM class_positions WHERE lower(agent_id) = lower($1)`,
        )
        .all(acct)) as unknown as Record<string, unknown>[];
      if (rows.length === 0) continue;

      // THE WHOLE TAPE, ONCE. Folded by the same function the worker uses, so
      // the repair cannot reach a different number from the same evidence.
      type Entry = { costRaw: bigint; proceedsRaw: bigint; soldRaw: bigint; sweptRaw: bigint };
      let folded: Map<string, Entry> | null = null;
      try {
        const head = BigInt((await rpc("eth_blockNumber", [])) as string);
        const logs = (await rpc("eth_getLogs", [
          { address: vault, fromBlock: "0x0", toBlock: "0x" + head.toString(16) },
        ])) as { topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }[];
        const events = parseClassLogs(
          logs.map((l) => ({
            topics: l.topics,
            data: l.data,
            blockNumber: BigInt(l.blockNumber),
            transactionHash: l.transactionHash,
            logIndex: Number(l.logIndex),
          })),
        );
        folded = foldClassEvents(events) as unknown as Map<string, Entry>;
      } catch (e) {
        log(`class-pnl| ${tenant}: vault log unreadable — ${e instanceof Error ? e.message.slice(0, 90) : e}`);
      }

      for (const r of rows) {
        const token = String(r.token).toLowerCase();
        const entry = folded?.get(token) ?? null;
        const exitTx = r.exit_tx === null || r.exit_tx === undefined ? null : String(r.exit_tx);

        // THE ROW THE RESULT WOULD LAND ON, identified by the EXIT TRANSACTION.
        let intentRows = 0;
        let recorded: number | null = null;
        if (exitTx) {
          const t = (await shared
            .prepare(
              `SELECT id, realized_pnl_usdg FROM trades
                WHERE lower(agent_id) = lower($1) AND lower(tx_hash) = lower($2) AND kind = 'curve-trade'`,
            )
            .all(acct, exitTx)) as unknown as Record<string, unknown>[];
          intentRows = t.length;
          const v = t[0]?.realized_pnl_usdg;
          recorded = v === null || v === undefined ? null : Number(v);
        }
        const b = (await shared
          .prepare(
            `SELECT qty_raw, cost_usdg FROM cost_basis
              WHERE lower(agent_id) = lower($1) AND mode = 'live' AND symbol = $2`,
          )
          .get(acct, String(r.symbol ?? ""))) as { cost_usdg: string } | undefined;

        const plan = planClassPnlRepair({
          tenant,
          smartAccount: acct,
          token,
          symbol: String(r.symbol ?? token),
          entryTx: r.entry_tx === null || r.entry_tx === undefined ? null : String(r.entry_tx),
          exitTx,
          costRaw: entry ? entry.costRaw : null,
          proceedsRaw: entry ? entry.proceedsRaw : null,
          qtySoldRaw: entry ? entry.soldRaw : null,
          sweptRaw: entry ? entry.sweptRaw : null,
          state: String(r.state ?? "?"),
          exitIntentRows: intentRows,
          recordedRealizedUsdg: recorded,
          basisRemainingRaw: b === undefined ? 0n : BigInt(b.cost_usdg || "0"),
          scanComplete: folded !== null,
        });
        plans.push(plan);
        targets.push({ plan, account: acct });
      }
    }

    if (plans.length === 0) {
      log("class-pnl| no class round trips found for the named tenant(s)");
      return;
    }
    for (const line of classPnlRepairLines(plans)) log(`class-pnl| ${line}`);

    if (!applying) {
      log("class-pnl| REPORT ONLY — nothing was written. Remove MERRYMEN_REPAIR_CLASS_PNL now.");
      return;
    }

    for (const { plan, account } of targets) {
      const x = plan.facts;

      // ── THE STALE SHARED BASIS, CLEARED FIRST AND ON ITS OWN TERMS ──────
      //
      // BEFORE the `ambiguous` guard, deliberately. A position whose result is
      // already booked still has this row to clean up, and gating the cleanup on
      // "did the P&L need writing" means the very run that books a result is the
      // only run that can ever clear it — so the second attempt, after the first
      // one's SQL failed, would skip it forever.
      //
      // The child holds NO cost_basis row: `setBasis` deletes at zero rather
      // than zeroing, and the mirror reports `cost_basis 0` for this tenant on
      // every pass. But the mirror skips its own `DELETE FROM cost_basis`
      // whenever the child is flagged `rebuilt` — it cannot tell "I closed this"
      // from "I have forgotten everything" — so the deletion had nothing to
      // upsert over and the shared row sits there indefinitely, reading as a
      // position still carrying cost that closed hours ago.
      //
      // Safe outright, and it stays deleted: there is no child row to re-push
      // and the mirror's upsert only writes rows the child has. Idempotent — a
      // DELETE of a row that is not there is a no-op.
      if (x.state === "closed" || x.state === "swept") {
        await shared
          .prepare(
            `DELETE FROM cost_basis
              WHERE lower(agent_id) = lower($1) AND mode = 'live' AND symbol = $2`,
          )
          .run(account, x.symbol);
        log(`class-pnl| ${x.symbol} stale shared cost basis cleared (${x.state}; the child holds none)`);
      }

      if (plan.ambiguous || plan.realizedRaw === null) continue;
      const realized = Number(plan.realizedRaw) / 1e6;

      // THE GUARD IS IN THE WRITE ITSELF, not only in the planner. The predicate
      // is the chain's own identity for this trip — its exit transaction — plus
      // the requirement that no result is there yet, so a concurrent booking by
      // the live path cannot be overwritten and a second run changes nothing.
      const res = (await shared
        .prepare(
          `UPDATE trades
              SET realized_pnl_usdg = $1, fill_side = 'sell', fill_qty_raw = $2,
                  fill_cash_usdg = $3, basis_source = 'receipt'
            WHERE lower(agent_id) = lower($4) AND lower(tx_hash) = lower($5)
              AND kind = 'curve-trade' AND realized_pnl_usdg IS NULL`,
        )
        .run(
          realized,
          x.qtySoldRaw === null ? null : x.qtySoldRaw.toString(),
          x.proceedsRaw === null ? null : Number(x.proceedsRaw) / 1e6,
          account,
          x.exitTx,
        )) as unknown;
      void res;

      const after = (await shared
        .prepare(
          `SELECT realized_pnl_usdg, fill_side FROM trades
            WHERE lower(agent_id) = lower($1) AND lower(tx_hash) = lower($2) AND kind = 'curve-trade'`,
        )
        .all(account, x.exitTx)) as unknown as Record<string, unknown>[];
      const got = after[0]?.realized_pnl_usdg;
      const ok = after.length === 1 && got !== null && got !== undefined && Math.abs(Number(got) - realized) < 1e-9;


      await shared
        .prepare("INSERT INTO events (agent_id, level, message) VALUES (?, ?, ?)")
        .run(
          account,
          "ok",
          `class P&L repair: ${x.symbol} booked ${realized.toFixed(6)} USDG realised on exit ${x.exitTx}. ` +
            `${plan.reason}. Derived from the vault's own events, never from a balance — this vault also ` +
            `holds unrelated reward USDG.`,
        );

      log(
        ok
          ? `class-pnl| ${x.tenant} ${x.symbol} APPLIED — realised ${realized.toFixed(6)} USDG on ${x.exitTx}`
          : `class-pnl| ${x.tenant} ${x.symbol} *** VERIFY FAILED — read back ${String(got)} across ` +
            `${after.length} row(s), wanted ${realized.toFixed(6)} ***`,
      );
    }
    log("class-pnl| APPLY COMPLETE. Remove MERRYMEN_REPAIR_CLASS_PNL now.");
  } catch (e) {
    log(`class-pnl| FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }
}


/**
 * TURN THE CLASS ROUTE ON FOR ONE NAMED TENANT.
 *
 * Same shape as the consent migration and the tenant inspector: one tenant named
 * explicitly, once per process, reported in full. The settings store is in a
 * Postgres reachable only from inside Railway, so there is no other way to set
 * these.
 *
 * MERGES. `put` writes the whole blob, so a naive write erases every setting the
 * owner chose. Remove the variable as soon as the write is confirmed.
 */
async function runEnableClassIfAsked(): Promise<void> {
  const want = (process.env.MERRYMEN_ENABLE_CLASS_FOR ?? "").trim().toLowerCase();
  if (!want) return;
  if (enableClassRan) return;
  enableClassRan = true;

  if (!/^0x[0-9a-f]{40}$/.test(want)) {
    log("enable-class: MERRYMEN_ENABLE_CLASS_FOR is not an address — refusing to guess");
    return;
  }
  try {
    const { CANARY, DAVE_CLASS, classEnableBlockers, describeCanaryChange, mergeCanary } =
      await import("./enable-class");
    const { getSettingsStore } = await import("./settings-store");
    const {
      grantPonsClassVault,
      grantPonsClassVaultFactory,
      PONS_CLASS_VAULT_FACTORY,
      PONS_CLASS_VAULT_FACTORY_V2,
      PONS_CLASS_VAULT_FACTORY_ABI,
    } = await import("../../packages/core/src/index");
    const store = getSettingsStore();

    // WHICH CONFIGURATION. Named per tenant rather than one set for everyone:
    // the numbers were agreed per owner, and `scoutBudgetUsdg` differs between
    // them for a reason a shared constant would quietly erase.
    const preset = (process.env.MERRYMEN_ENABLE_CLASS_PRESET ?? "canary").trim().toLowerCase();
    if (preset !== "canary" && preset !== "dave") {
      log(`enable-class: MERRYMEN_ENABLE_CLASS_PRESET=${preset} is not a preset. Use "canary" or "dave".`);
      return;
    }
    const values = preset === "dave" ? DAVE_CLASS : CANARY;
    log(`enable-class: preset ${preset}`);

    // ── THE GRANT MUST BE ABLE TO EXECUTE WHAT THIS SWITCHES ON ─────────
    //
    // Enabling the route without a sealed vault is not merely inert: the agent
    // scouts, scores, qualifies and builds entry intents its own key can never
    // sign, every tick, forever. The owner sees an agent working and no trades,
    // which is the most expensive failure shape this product has.
    //
    // Read through the SAME accessors the executor and the policy use, so the
    // vault this check approves and the vault the wall pins cannot be two
    // different addresses.
    const url0 = process.env.DATABASE_URL;
    if (!url0) {
      log("enable-class: no DATABASE_URL — cannot read the grant to check it can execute this");
      return;
    }
    let sealedVault: string | null = null;
    let derivedVault: string | null = null;
    try {
      const g = await getGrantStore().get(want as `0x${string}`);
      sealedVault = (grantPonsClassVault(g as never) as string | null) ?? null;
      const acct = g && g.smartAccount ? String(g.smartAccount) : null;
      const chainId = Number(g && g.chainId ? g.chainId : 4663);
      /**
       * ── DERIVE FROM THE FACTORY THE GRANT ITSELF SEALED ──────────────────
       *
       * This read the v1 constant and nothing else, so for a grant sealed
       * against a v2 factory the mismatch below is the CORRECT state — and
       * classEnableBlockers would refuse with "the wall would pin a vault the
       * executor never uses". A false blocker wearing a real safety refusal's
       * clothes, and the reason a correctly signed v2 grant could not be put
       * into service at all.
       *
       * The fix is the derivation, never the check. Relaxing the mismatch rule
       * would remove a guard that catches a genuinely mispinned wall, which is
       * a far worse failure than the one being fixed.
       *
       * GRANT FIRST, then both constants. The signature is the authority: it is
       * what the wall was built from and what the executor will use. The
       * constants are only a fallback for a grant that sealed no factory, and
       * v2 is tried before v1 because a fresh grant is the one likelier to want
       * it — but either way the answer is checked against what was SEALED.
       */
      const candidates = [
        grantPonsClassVaultFactory(g as never) as string | null,
        PONS_CLASS_VAULT_FACTORY_V2[chainId],
        PONS_CLASS_VAULT_FACTORY[chainId],
      ].filter((f): f is string => typeof f === "string" && /^0x[0-9a-fA-F]{40}$/.test(f));
      if (acct && candidates.length > 0) {
        const { createPublicClient, http } = await import("viem");
        const rpcUrl = process.env.MERRYMEN_RPC_MAINNET ?? "https://rpc.mainnet.chain.robinhood.com";
        const c = createPublicClient({ transport: http(rpcUrl) });
        for (const factory of candidates) {
          let answered: string;
          try {
            answered = String(
              await c.readContract({
                // The SHARED abi, not an inline literal. Two copies of one
                // selector is how a pinned call and an encoded call drift apart,
                // which is the whole reason this constant exists.
                address: factory as `0x${string}`,
                abi: PONS_CLASS_VAULT_FACTORY_ABI,
                functionName: "vaultFor",
                args: [acct as `0x${string}`],
              }),
            );
          } catch {
            continue; // a factory that will not answer is not evidence either way
          }
          derivedVault = answered;
          // A factory whose answer MATCHES what the grant sealed is the one the
          // grant was signed against. Stop there rather than letting a later
          // candidate overwrite the agreement with a disagreement.
          if (sealedVault && answered.toLowerCase() === sealedVault.toLowerCase()) break;
        }
      }
    } catch (e) {
      log(`enable-class: could not read the grant (${e instanceof Error ? e.message.slice(0, 90) : e})`);
      return;
    }
    const blockers = classEnableBlockers({ sealedVault, derivedVault });
    if (blockers.length > 0) {
      for (const b of blockers) log(`enable-class: REFUSING — ${b}`);
      log("enable-class: nothing was written.");
      return;
    }
    log(`enable-class: grant seals ${sealedVault} and it matches this account's vault`);

    const current = (await store.get(want as `0x${string}`)) as unknown as Record<
      string,
      unknown
    > | null;
    for (const line of describeCanaryChange(current, values)) log(`enable-class: ${line}`);

    const next = mergeCanary(current, values);
    await store.put(want as `0x${string}`, next as never);

    // READ IT BACK. A write that reported success and changed nothing is the
    // failure this whole milestone keeps running into.
    const after = (await store.get(want as `0x${string}`)) as unknown as Record<
      string,
      unknown
    > | null;
    const wrong = Object.entries(values).filter(([k, v]) => after?.[k] !== v);
    log(
      wrong.length === 0
        ? `enable-class: WROTE and verified all ${Object.keys(values).length} fields for ${want}`
        : `enable-class: *** VERIFY FAILED — ${wrong.map(([k]) => k).join(", ")} did not stick ***`,
    );
    log("enable-class: remove MERRYMEN_ENABLE_CLASS_FOR now.");
  } catch (e) {
    log(`enable-class: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * SWITCH OFF NEW CLASS ENTRIES FOR ONE TENANT, AND NOTHING ELSE.
 *
 * The case this exists for: an agent holding a live class position that needs to
 * stop opening new ones while it keeps managing the one it has. Those are
 * different switches, and conflating them strands money in a book that can no
 * longer close it.
 *
 * `classSnipeEnabled` gates `proposeClassEntries` and nothing else. The exit
 * path reads `classMaxHoldSec` and `classExitAtGraduationPct` and never consults
 * it, so an agent with entries off still sells on the clock and still sells at
 * the graduation cliff. That asymmetry is verified, not assumed — it is why one
 * field is the right lever and why `HALT_MUST_PRESERVE` names the exit triggers
 * so a test can prove they were untouched.
 *
 * MERGE, NEVER REPLACE, for the reason `enable-class.ts` gives at length: `put`
 * writes the whole blob, so a naive write erases every setting the owner chose.
 */
async function runHaltClassEntriesIfAsked(): Promise<void> {
  const want = (process.env.MERRYMEN_HALT_CLASS_ENTRIES_FOR ?? "").trim().toLowerCase();
  if (!want) return;
  if (haltClassEntriesRan) return;
  haltClassEntriesRan = true;

  if (!/^0x[0-9a-f]{40}$/.test(want)) {
    log("halt-entries: MERRYMEN_HALT_CLASS_ENTRIES_FOR is not an address — refusing to guess");
    return;
  }
  try {
    const { HALT_ENTRIES, HALT_MUST_PRESERVE, mergeHaltEntries } = await import("./enable-class");
    const { getSettingsStore } = await import("./settings-store");
    const store = getSettingsStore();

    const current = (await store.get(want as `0x${string}`)) as unknown as Record<
      string,
      unknown
    > | null;
    const before = Object.fromEntries(HALT_MUST_PRESERVE.map((k) => [k, current?.[k]]));
    log(
      `halt-entries: classSnipeEnabled ${JSON.stringify(current?.classSnipeEnabled)} -> false ` +
        `for ${want}`,
    );

    await store.put(want as `0x${string}`, mergeHaltEntries(current) as never);

    // READ IT BACK, and check BOTH halves: that entries actually stopped, and
    // that nothing an exit depends on moved. A halt that silently took the exit
    // with it would look identical in the log to one that did not.
    const after = (await store.get(want as `0x${string}`)) as unknown as Record<
      string,
      unknown
    > | null;
    const stuck = after?.classSnipeEnabled === false;
    const moved = HALT_MUST_PRESERVE.filter((k) => JSON.stringify(after?.[k]) !== JSON.stringify(before[k]));
    log(
      stuck
        ? `halt-entries: WROTE and verified classSnipeEnabled=false (${Object.keys(HALT_ENTRIES).length} field)`
        : `halt-entries: *** VERIFY FAILED — classSnipeEnabled did not stick ***`,
    );
    log(
      moved.length === 0
        ? `halt-entries: every exit setting preserved (${HALT_MUST_PRESERVE.join(", ")})`
        : `halt-entries: *** ${moved.join(", ")} CHANGED — the exit path may be affected ***`,
    );
    log("halt-entries: remove MERRYMEN_HALT_CLASS_ENTRIES_FOR now.");
  } catch (e) {
    log(`halt-entries: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * PRINT ONE TENANT'S CLASS-ROUTE CONFIGURATION, ONCE, AND WRITE NOTHING.
 *
 * The grant and settings live in a Postgres reachable only from inside Railway,
 * so this is the only way to answer "does this owner's signed wall carry a class
 * vault?" without guessing. It reads through the SAME stores the worker uses —
 * no second decoder to drift.
 *
 * ONCE PER PROCESS and named explicitly: the variable carries a single tenant
 * address, there is no "all" mode, and the guard below stops it reprinting every
 * fifteen seconds. It still prints on every RESTART while the variable is set,
 * which is why the runbook says to remove it as soon as the answer is captured.
 *
 * It cannot leak: `describeTenant` is handed a flat record of the thirteen
 * fields asked for, never the settings object, so nothing else is in scope where
 * the strings are built.
 */

/**
 * DELETE A `class_positions` ROW THAT WAS NEVER A POSITION.
 *
 * The producer is fixed and the child's copy went with its sqlite, but the
 * ledger mirror skips `DELETE FROM class_positions` while the child reads
 * `rebuilt` — which it does after every redeploy — so the SHARED copy of a
 * phantom cash row would stand indefinitely. This removes it.
 *
 * Report first, apply only when a tenant is named. See class-cash-row-repair.ts
 * for the four clauses and why each one is required.
 */
async function runCashRowRepairIfAsked(): Promise<void> {
  const mode = (process.env.MERRYMEN_REPAIR_CLASS_CASH_ROW ?? "").trim().toLowerCase();
  if (!mode) return;
  if (cashRowRepairRan) return;
  cashRowRepairRan = true;

  if (mode !== "report" && mode !== "apply") {
    log(`class-cash-row: MERRYMEN_REPAIR_CLASS_CASH_ROW=${mode} is not a mode. Use "report" or "apply".`);
    return;
  }
  const applying = mode === "apply";
  const only = new Set(
    (process.env.MERRYMEN_REPAIR_CLASS_CASH_ROW_ONLY ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.startsWith("0x")),
  );
  // NO FLEET APPLY. A tool that can delete rows for every owner at once is a
  // different and much larger thing to leave armed by accident.
  if (applying && only.size === 0) {
    log("class-cash-row: REFUSING to apply without MERRYMEN_REPAIR_CLASS_CASH_ROW_ONLY — name the tenant");
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    log("class-cash-row: asked for, but there is no DATABASE_URL");
    return;
  }

  try {
    const { planCashRowRepair, cashRowRepairLines } = await import("./class-cash-row-repair");
    const { CASH } = await import("../../packages/core/src/index");
    const shared = await makePgDb(url);
    // TENANT -> SMART ACCOUNT. `class_positions.agent_id` IS the smart account
    // and knows nothing about tenants; `grants` is the only bridge.
    const grants = (await shared
      // The account lives INSIDE the grant blob; there is no `smart_account`
      // column and asking for one fails the whole pass. Same projection the
      // other repair passes use.
      .prepare(`SELECT tenant, grant_json->>'smartAccount' AS smart_account FROM grants`)
      .all()) as unknown as Record<string, unknown>[];
    for (const g of grants) {
      const tenant = String(g.tenant ?? "").toLowerCase();
      const acct = g.smart_account === null || g.smart_account === undefined ? null : String(g.smart_account);
      if (!tenant || !acct) continue;
      if (only.size > 0 && !only.has(tenant)) continue;

      const rows = (await shared
        .prepare(
          "SELECT agent_id, token, symbol, quote_token, state, curve, entry_tx, cost_usdg " +
            "FROM class_positions WHERE lower(agent_id) = lower(?)",
        )
        .all(acct)) as unknown as Record<string, unknown>[];
      const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
      const plan = planCashRowRepair(
        tenant,
        rows.map((r) => ({
          agentId: String(r.agent_id ?? ""),
          token: String(r.token ?? ""),
          symbol: str(r.symbol),
          quoteToken: str(r.quote_token),
          state: str(r.state),
          curve: str(r.curve),
          entryTx: str(r.entry_tx),
          costUsdg: str(r.cost_usdg),
        })),
        CASH.USDG,
      );
      if (plan.deletable.length === 0 && plan.refused.length === 0) continue;
      for (const line of cashRowRepairLines(plan, applying ? "apply" : "report")) log(line);

      if (!applying) continue;
      for (const v of plan.deletable) {
        // Keyed on the exact row, and re-stating every clause in the WHERE so
        // the delete cannot widen even if the plan were wrong about a row.
        await shared
          .prepare(
            "DELETE FROM class_positions WHERE lower(agent_id) = lower(?) AND lower(token) = lower(?) " +
              "AND curve IS NULL AND entry_tx IS NULL AND cost_usdg IS NULL",
          )
          .run(v.row.agentId, v.row.token);
      }
      const left = (await shared
        .prepare(
          "SELECT COUNT(*) AS n FROM class_positions WHERE lower(agent_id) = lower(?) AND lower(token) = lower(?)",
        )
        .all(acct, plan.deletable[0]!.row.token)) as unknown as Record<string, unknown>[];
      const n = Number(left[0]?.n ?? -1);
      log(
        n === 0
          ? `class-cash-row: VERIFIED — the row is gone for ${tenant}`
          : `class-cash-row: *** VERIFY FAILED — ${n} row(s) still present for ${tenant} ***`,
      );
    }
  } catch (e) {
    log(`class-cash-row: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runTenantInspectIfAsked(): Promise<void> {
  const want = (process.env.MERRYMEN_INSPECT_TENANT ?? "").trim().toLowerCase();
  if (!want) return;
  if (tenantInspectRan) return;
  tenantInspectRan = true;

  if (!/^0x[0-9a-f]{40}$/.test(want)) {
    log(`inspect: MERRYMEN_INSPECT_TENANT is not an address — refusing to guess`);
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    log("inspect: asked for, but there is no DATABASE_URL");
    return;
  }

  try {
    const { describeTenant, describeAccounting, describeLedger, describeMovements, type: _t } = (await import(
      "./inspect-tenant"
    )) as never as {
      describeTenant: (f: Record<string, unknown>) => string[];
      describeAccounting: (f: Record<string, unknown>) => string[];
      describeLedger: (f: Record<string, unknown>) => string[];
      describeMovements: (f: Record<string, unknown>) => string[];
      type?: never;
    };
    void _t;
    const {
      grantPonsClassVault,
      grantPonsClassVaultFactory,
      PONS_CLASS_VAULT_FACTORY,
      PONS_CLASS_VAULT_FACTORY_V2,
      PONS_CLASS_VAULT_FACTORY_ABI,
    } = await import(
      "../../packages/core/src/index"
    );
    const { getSettingsStore } = await import("./settings-store");

    // @ts-expect-error pg is runtime-only here, as everywhere else in this repo
    const pg = (await import("pg")) as unknown as {
      Client: new (c: { connectionString: string }) => {
        query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
        connect(): Promise<void>;
        end(): Promise<void>;
      };
    };
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    let grant: Record<string, unknown> | null = null;
    // THE ACCOUNTING HALF, read from the same connection. Everything the
    // drawdown breaker divides by lives in this database and nowhere an
    // operator can reach, which is the whole reason for the round trip.
    const acct: {
      durableHwmUsdg: number | null;
      durableHwmGrossUsdg: number | null;
      durableHwmWithdrawnUsdg: number | null;
      durableAccruedFeeUsdg: number | null;
      durableEpoch: number | null;
      equityUsdg: number | null;
      flows:
        | {
            direction: string;
            amountUsdg: number;
            source: string;
            txHash: string | null;
            blockNumber: number | null;
          }[]
        | null;
      trades: number | null;
      error: string | null;
    } = {
      durableHwmUsdg: null,
      durableHwmGrossUsdg: null,
      durableHwmWithdrawnUsdg: null,
      durableAccruedFeeUsdg: null,
      durableEpoch: null,
      equityUsdg: null,
      flows: null,
      trades: null,
      error: null,
    };
    const ledger: {
      tradesByStatus: Record<string, number> | null;
      openPositions: { symbol: string; custody: string; qty: string }[] | null;
      classPositions:
        | { symbol: string; state: string; costUsdg: string | null; proceedsUsdg: string | null }[]
        | null;
      error: string | null;
    } = { tradesByStatus: null, openPositions: null, classPositions: null, error: null };
    /**
     * THE CEILING'S OWN ROWS, READ WHILE THE CONNECTION IS STILL OPEN.
     *
     * Declared out here and filled inside the `try` below, because the section
     * that PRINTS them belongs further down with the rest of the report. The
     * first version did the query where it printed — after `client.end()` — and
     * its production run said `class positions COULD NOT BE READ — Client was
     * closed and is not queryable`. It reported the failure instead of showing
     * an empty ceiling, which is the only reason it was noticed rather than
     * believed.
     */
    let positionRows: { token: string; symbol: string | null; quoteToken: string | null; state: string | null }[] =
      [];
    let positionsError: string | null = null;

    const moves: {
      landed:
        | { kind: string; target: string; amountUsdg: number; status: string; txHash: string | null }[]
        | null;
      classRows:
        | {
            token: string;
            symbol: string | null;
            state: string;
            costUsdg: string | null;
            proceedsUsdg: string | null;
            qtyRaw: string | null;
            entryTx: string | null;
            exitTx: string | null;
          }[]
        | null;
      error: string | null;
    } = { landed: null, classRows: null, error: null };
    try {
      const { rows } = await client.query(
        "SELECT grant_json FROM grants WHERE lower(tenant) = lower($1)",
        [want],
      );
      const raw = rows[0]?.grant_json;
      grant =
        typeof raw === "string"
          ? (JSON.parse(raw) as Record<string, unknown>)
          : ((raw as Record<string, unknown>) ?? null);

      const acctAddr = typeof grant?.smartAccount === "string" ? grant.smartAccount : null;
      if (acctAddr) {
        try {
          const a = await client.query(
            "SELECT hwm_usdg, hwm_withdrawn_usdg, accrued_fee_usdg, epoch FROM agents WHERE lower(smart_account) = lower($1)",
            [acctAddr],
          );
          const r = a.rows[0];
          if (r) {
            // THE EFFECTIVE PEAK, which is what the breaker actually divides
            // by — gross minus what withdrawals have taken out of it. Reading
            // the raw column here printed "5470bps — REFUSING every buy" about
            // an account the engine was reading at 0bps, which is precisely the
            // confidently-wrong number this module exists to stop.
            acct.durableHwmUsdg = Math.max(
              0,
              Number(r.hwm_usdg) - Number(r.hwm_withdrawn_usdg ?? 0),
            );
            acct.durableHwmGrossUsdg = Number(r.hwm_usdg);
            acct.durableHwmWithdrawnUsdg = Number(r.hwm_withdrawn_usdg ?? 0);
            acct.durableAccruedFeeUsdg = Number(r.accrued_fee_usdg);
            acct.durableEpoch = Number(r.epoch);
          }
          const e = await client.query(
            "SELECT equity_usdg FROM equity WHERE lower(agent_id) = lower($1) ORDER BY at DESC LIMIT 1",
            [acctAddr],
          );
          if (e.rows[0]) acct.equityUsdg = Number(e.rows[0].equity_usdg);
          const fl = await client.query(
            `SELECT direction, amount_usdg, source, tx_hash, block_number
               FROM flows WHERE lower(agent_id) = lower($1) ORDER BY at ASC, id ASC`,
            [acctAddr],
          );
          acct.flows = fl.rows.map((x) => ({
            direction: String(x.direction),
            amountUsdg: Number(x.amount_usdg),
            source: String(x.source),
            txHash: x.tx_hash === null ? null : String(x.tx_hash),
            blockNumber: x.block_number === null ? null : Number(x.block_number),
          }));
          const t = await client.query(
            "SELECT count(*)::int AS n FROM trades WHERE lower(agent_id) = lower($1)",
            [acctAddr],
          );
          acct.trades = Number(t.rows[0]?.n ?? 0);
        } catch (e) {
          // UNREADABLE, not empty. A failed count must never render as zero
          // trades, because zero trades is the premise of the verdict below.
          acct.error = e instanceof Error ? e.message : String(e);
        }

        // ITS OWN TRY, deliberately. Folded into the block above, one bad
        // column name in the ledger half reported the ACCOUNTING half as
        // unreadable too — after it had already read correctly. A later failure
        // must not retract an earlier fact.
        try {
          const ts = await client.query(
            "SELECT status, count(*)::int AS n FROM trades WHERE lower(agent_id) = lower($1) GROUP BY status",
            [acctAddr],
          );
          ledger.tradesByStatus = Object.fromEntries(
            ts.rows.map((x) => [String(x.status), Number(x.n)]),
          );
          const ps = await client.query(
            "SELECT symbol, custody, value_usdg FROM positions WHERE lower(agent_id) = lower($1)",
            [acctAddr],
          );
          ledger.openPositions = ps.rows.map((x) => ({
            symbol: String(x.symbol),
            custody: String(x.custody ?? "account"),
            qty: `${Number(x.value_usdg).toFixed(6)} USDG`,
          }));
          const cp = await client.query(
            "SELECT symbol, state, cost_usdg, proceeds_usdg FROM class_positions WHERE lower(agent_id) = lower($1)",
            [acctAddr],
          );
          ledger.classPositions = cp.rows.map((x) => ({
            symbol: String(x.symbol ?? "?"),
            state: String(x.state ?? "?"),
            costUsdg: x.cost_usdg === null ? null : String(x.cost_usdg),
            proceedsUsdg: x.proceeds_usdg === null ? null : String(x.proceeds_usdg),
          }));
        } catch (e) {
          ledger.error = e instanceof Error ? e.message : String(e);
        }

        try {
          const lt = await client.query(
            `SELECT kind, target, amount_usdg, status, tx_hash, realized_pnl_usdg, fill_side, basis_source FROM trades
              WHERE lower(agent_id) = lower($1) AND status <> 'rejected'
              ORDER BY created_at ASC`,
            [acctAddr],
          );
          moves.landed = lt.rows.map((x) => ({
            kind: String(x.kind),
            target: String(x.target),
            amountUsdg: Number(x.amount_usdg),
            status: String(x.status),
            txHash: x.tx_hash === null ? null : String(x.tx_hash),
            realizedPnlUsdg:
              x.realized_pnl_usdg === null || x.realized_pnl_usdg === undefined
                ? null
                : Number(x.realized_pnl_usdg),
            fillSide: x.fill_side === null || x.fill_side === undefined ? null : String(x.fill_side),
            basisSource:
              x.basis_source === null || x.basis_source === undefined ? null : String(x.basis_source),
          }));
          const cr = await client.query(
            `SELECT token, symbol, state, cost_usdg, proceeds_usdg, qty_raw, opened_at_block, first_seen, curve, quote_token, entry_tx, exit_tx
               FROM class_positions WHERE lower(agent_id) = lower($1)`,
            [acctAddr],
          );
          moves.classRows = cr.rows.map((x) => ({
            token: String(x.token),
            symbol: x.symbol === null ? null : String(x.symbol),
            state: String(x.state ?? "?"),
            costUsdg: x.cost_usdg === null ? null : String(x.cost_usdg),
            proceedsUsdg: x.proceeds_usdg === null ? null : String(x.proceeds_usdg),
            qtyRaw: x.qty_raw === null ? null : String(x.qty_raw),
            // `?? null` as well as the null check: a column absent from the
            // result set arrives as UNDEFINED, and String(undefined) prints the
            // word "undefined" as though it were a value. That is exactly the
            // unknown-rendered-as-something this module exists to prevent, and it
            // is what this line printed on its first run.
            openedAtBlock:
              x.opened_at_block === null || x.opened_at_block === undefined
                ? null
                : String(x.opened_at_block),
            firstSeen:
              x.first_seen === null || x.first_seen === undefined ? null : Number(x.first_seen),
            curve: x.curve === null || x.curve === undefined ? null : String(x.curve),
            quoteToken:
              x.quote_token === null || x.quote_token === undefined ? null : String(x.quote_token),
            entryTx: x.entry_tx === null ? null : String(x.entry_tx),
            exitTx: x.exit_tx === null ? null : String(x.exit_tx),
          }));
        } catch (e) {
          moves.error = e instanceof Error ? e.message : String(e);
        }
      }

      // Keyed by SMART ACCOUNT, like every other row in `class_positions` —
      // `agent_id` is the smart account, and joining on the tenant would
      // silently return nothing at all.
      // `acctAddr` rather than `smartAccount`: the latter is declared below
      // this try block, and the same fact is already in scope here.
      if (acctAddr) {
        try {
          const pos = await client.query(
            `SELECT token, symbol, quote_token, state FROM class_positions WHERE agent_id = $1`,
            [acctAddr],
          );
          const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
          positionRows = pos.rows.map((r) => ({
            token: String(r.token ?? ""),
            symbol: str(r.symbol),
            quoteToken: str(r.quote_token),
            state: str(r.state),
          }));
        } catch (e) {
          positionsError = e instanceof Error ? e.message : String(e);
        }
      }
    } finally {
      await client.end();
    }

    if (!grant) {
      log(`inspect: no grant row for ${want}`);
      return;
    }

    const smartAccount = typeof grant.smartAccount === "string" ? grant.smartAccount : null;
    const chainId = Number(grant.chainId);
    const grantClassVault = (grantPonsClassVault(grant as never) as string | null) ?? null;

    // The DERIVED vault, which exists as an address whether or not it was
    // sealed — so a NO on sealing can still say which vault is being discussed.
    let derivedClassVault: string | null = null;
    let vaultDeployed: boolean | null = null;
    /**
     * THE FACTORY THE GRANT SEALED, then v2, then v1.
     *
     * This read the v1 constant alone, so a tenant sealed against a v2 factory
     * was reported as pinning a vault other than "this account's own" — sending
     * an operator to look for a bug that is not there. A diagnostic that prints
     * one derived address while the grant seals another is worse than printing
     * nothing, because it looks like evidence.
     */
    const factory =
      (grantPonsClassVaultFactory(grant as never) as string | null) ??
      PONS_CLASS_VAULT_FACTORY_V2[chainId] ??
      PONS_CLASS_VAULT_FACTORY[chainId];
    if (factory && smartAccount) {
      try {
        const { createPublicClient, http } = await import("viem");
        // The same default the announcement pass uses, so one operator
        // variable governs every read this process makes.
        const rpcUrl =
          (chainId === 4663
            ? process.env.MERRYMEN_RPC_MAINNET
            : process.env.MERRYMEN_RPC_TESTNET) ?? "https://rpc.mainnet.chain.robinhood.com";
        const client2 = createPublicClient({ transport: http(rpcUrl) });
        derivedClassVault = (await client2.readContract({
          // The shared ABI rather than an inline literal, so the selector a
          // diagnostic reads with and the selector the wall pins cannot drift.
          address: factory as `0x${string}`,
          abi: PONS_CLASS_VAULT_FACTORY_ABI,
          functionName: "vaultFor",
          args: [smartAccount as `0x${string}`],
        })) as string;
        const target = (grantClassVault ?? derivedClassVault) as `0x${string}`;
        const code = await client2.getBytecode({ address: target });
        vaultDeployed = code !== undefined && code !== "0x";
      } catch {
        // UNKNOWN, not false. The whole point of this module is that somebody
        // was about to act on the difference.
        vaultDeployed = null;
      }
    }

    let settingsMissing = false;
    let settingsError: string | null = null;
    let s: Record<string, unknown> = {};
    try {
      const got = (await getSettingsStore().get(want as `0x${string}`)) as unknown as Record<
        string,
        unknown
      > | null;
      if (got === null) settingsMissing = true;
      else s = got;
    } catch (e) {
      settingsError = e instanceof Error ? e.message : String(e);
    }

    // ONE FIELD AT A TIME, BY NAME. This is the line that makes a leak
    // impossible: the report never receives `s`.
    const pick = <T>(k: string): T | null => (s[k] === undefined ? null : (s[k] as T));
    const facts = {
      tenant: want,
      smartAccount,
      grantClassVault,
      derivedClassVault,
      derivedFromFactory: factory ?? null,
      vaultDeployed,
      assetMode: pick("assetMode"),
      liveTradingEnabled: pick("liveTradingEnabled"),
      discoveryEnabled: pick("discoveryEnabled"),
      classSnipeEnabled: pick("classSnipeEnabled"),
      classPerEntryUsdg: pick("classPerEntryUsdg"),
      classMaxPositions: pick("classMaxPositions"),
      scoutEnabled: pick("scoutEnabled"),
      scoutBudgetUsdg: pick("scoutBudgetUsdg"),
      scoutPerTokenUsdg: pick("scoutPerTokenUsdg"),
      classMinDepthUsdg: pick("classMinDepthUsdg"),
      maxImpactBps: pick("maxImpactBps"),
      slippageBps: pick("slippageBps"),
      classMaxHoldSec: pick("classMaxHoldSec"),
      classExitAtGraduationPct: pick("classExitAtGraduationPct"),
      settingsMissing,
      settingsError,
    };

    for (const line of describeTenant(facts)) log(`inspect: ${line}`);

    // The signed ceiling, read off the grant's own caps — the same derivation
    // limits.ts makes, so the number printed is the one the breaker compares
    // against rather than a default that resembles it.
    const caps = (grant.caps ?? null) as Record<string, unknown> | null;
    const pct = caps && typeof caps.maxDrawdownPct === "number" ? caps.maxDrawdownPct : null;
    for (const line of describeAccounting({
      smartAccount,
      durableHwmUsdg: acct.durableHwmUsdg,
      durableHwmGrossUsdg: acct.durableHwmGrossUsdg,
      durableHwmWithdrawnUsdg: acct.durableHwmWithdrawnUsdg,
      durableAccruedFeeUsdg: acct.durableAccruedFeeUsdg,
      durableEpoch: acct.durableEpoch,
      equityUsdg: acct.equityUsdg,
      maxDrawdownBps: pct === null ? null : pct * 100,
      flows: acct.flows,
      trades: acct.trades,
      error: acct.error,
    }))
      log(`inspect: ${line}`);
    for (const line of describeLedger(ledger)) log(`inspect: ${line}`);
    for (const line of describeMovements(moves)) log(`inspect: ${line}`);

    // THE CEILING'S OWN ARITHMETIC, formatted from the rows read above.
    //
    // IMPORTED FOR ITS REAL TYPE, NOT THROUGH A CAST. This read
    // `as never as { describeClassPositions: (c: { states: … }) => string[] }`,
    // and a hand-written structural type over `as never` erases the module's
    // own signature — so widening the census from states to whole rows
    // type-checked perfectly and would have thrown at runtime, on the one code
    // path that only ever runs when somebody is already mid-incident. The other
    // casts in this file are for `pg`, which is genuinely runtime-only; this
    // module is ours and has types.
    if (positionsError !== null) {
      // Said out loud. An unreadable position table is not an empty one, and
      // "the ceiling is fine" is exactly the wrong thing to infer from a failed
      // read on the gate that shuts the route silently.
      log(`inspect: class positions COULD NOT BE READ — ${positionsError}`);
    } else if (smartAccount) {
      const { describeClassPositions } = await import("./inspect-tenant");
      const ceiling = facts.classMaxPositions;
      for (const line of describeClassPositions({
        rows: positionRows,
        ceiling: typeof ceiling === "number" ? ceiling : null,
      }))
        log(`inspect: ${line}`);
    }
    log("inspect: READ ONLY — nothing was written. Remove MERRYMEN_INSPECT_TENANT now.");
  } catch (e) {
    log(`inspect: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runLiveIntentBackfillIfAsked(): Promise<void> {
  const mode = (process.env.MERRYMEN_BACKFILL_LIVE_INTENT ?? "").trim();
  if (mode !== "report" && mode !== "apply") return;
  // ONCE PER PROCESS. It moved ahead of `reconcile()` so the apply lands before
  // any child reads settings, and that put it on every pass rather than the
  // first — which in report mode would re-print the whole fleet every fifteen
  // seconds, and this repo already carries the incident where 1,242 identical
  // rows told nobody anything.
  if (liveIntentBackfillRan) return;
  liveIntentBackfillRan = true;
  const url = process.env.DATABASE_URL;
  if (!url) {
    log("live-intent backfill asked for, but there is no DATABASE_URL");
    return;
  }
  try {
    const { applyLiveIntentBackfill, describeBackfill, planLiveIntentBackfill } = await import(
      "./backfill-live-intent"
    );
    const { getSettingsStore } = await import("./settings-store");
    // @ts-expect-error pg is runtime-only here, as everywhere else in this repo
    const pg = (await import("pg")) as unknown as {
      Client: new (c: { connectionString: string }) => {
        query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
        connect(): Promise<void>;
        end(): Promise<void>;
      };
    };
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      /**
       * TENANT → SMART ACCOUNT, the same index announce.ts uses and for the same
       * reason: `trades` is keyed by `agent_id`, which is the smart account, and
       * nothing in it knows what a tenant is. `grants` is keyed by tenant and
       * carries the account, so it is the only bridge.
       *
       * Deliberately NOT `agents.owner_address` — that is a browser-generated
       * key for every hosted tenant, so the join would return zero rows and the
       * whole fleet would read as "never traded for real".
       */
      const ids = new Map<string, string>();
      const { rows } = await client.query(
        `SELECT tenant, grant_json->>'smartAccount' AS smart_account FROM grants`,
      );
      for (const r of rows) {
        if (typeof r.smart_account === "string") {
          ids.set(String(r.tenant).toLowerCase(), r.smart_account);
        }
      }
      log(`live-intent backfill: ${ids.size} tenant(s) have a grant with an account`);

      const store = getSettingsStore();
      const plan = await planLiveIntentBackfill({
        settings: store as never,
        db: client,
        agentIdOf: (t) => ids.get(t.toLowerCase()) ?? null,
        // The union — see planLiveIntentBackfill. The first report showed 46
        // tenants with a grant against 39 covered by the settings store alone.
        grantTenants: [...ids.keys()] as `0x${string}`[],
      });
      for (const line of describeBackfill(plan).split("\n")) log(`live-intent backfill: ${line}`);

      if (mode !== "apply") {
        log("live-intent backfill: REPORT ONLY — nothing written. Set =apply to write these grants.");
        return;
      }
      const out = await applyLiveIntentBackfill(plan, store as never);
      log(`live-intent backfill: APPLIED — ${out.written.length} granted, ${out.skipped.length} skipped`);
      for (const s of out.skipped) log(`live-intent backfill:   SKIP ${s.tenant} — ${s.why}`);
    } finally {
      await client.end();
    }
  } catch (e) {
    // Loud, and never silently "done". A backfill that failed and said nothing
    // is indistinguishable from one that found nothing to do — and the second
    // is a green light to deploy enforcement.
    log(`live-intent backfill: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runAnnouncementIfAsked(): Promise<void> {
  const id = (process.env.MERRYMEN_ANNOUNCE_ID ?? "").trim();
  if (!id) return;
  const url = process.env.DATABASE_URL;
  if (!url) {
    log("announcement asked for, but there is no DATABASE_URL");
    return;
  }
  if (!process.env.MERRYMEN_STORE_DEK) {
    log("announcement asked for, but there is no MERRYMEN_STORE_DEK — bot tokens are sealed");
    return;
  }
  try {
    const { readFileSync, existsSync, readdirSync } = await import("node:fs");
    const { illegalTags, runAnnouncement } = await import("./announce");
    // ── A PER-AGENT CAMPAIGN IS A DIRECTORY, A BROADCAST IS A FILE ─────────
    //
    // `docs/announcements/<id>.html`            one body for everyone
    // `docs/announcements/<id>/<tenant>.html`   one body per named owner
    //
    // The directory form makes the recipient list and the prepared-text list
    // THE SAME LIST, so it is structurally impossible to select somebody whose
    // message was never written — the failure that would mail one owner another
    // owner's circumstances.
    const dir = path.resolve(ROOT, "docs/announcements", id);
    const perAgent = existsSync(dir);
    const bodies: Record<string, string> = {};
    let body = "";
    if (perAgent) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".html")) continue;
        bodies[f.slice(0, -5).toLowerCase()] = readFileSync(path.join(dir, f), "utf8").trim();
      }
      if (Object.keys(bodies).length === 0) {
        log(`announcement ${id}: ${dir} has no .html bodies — refusing`);
        return;
      }
    } else {
      body = readFileSync(path.resolve(ROOT, "docs/announcements", `${id}.html`), "utf8").trim();
    }
    // Every body is checked, not just the first: one bad tag anywhere would be
    // silently flattened to plain text by telegram/api.ts and reported as a
    // clean delivery.
    for (const [who, text] of perAgent ? Object.entries(bodies) : [["all", body] as const]) {
      const bad = illegalTags(text);
      if (bad.length > 0) {
        log(`announcement ${id}: ${who} uses tags Telegram rejects (${bad.join(", ")}) — refusing`);
        return;
      }
      if (text.length > 3600) {
        log(`announcement ${id}: ${who} is ${text.length} chars, over the 3600 budget — refusing`);
        return;
      }
    }
    // @ts-expect-error pg is runtime-only here, as everywhere else in this repo
    const pg = (await import("pg")) as unknown as {
      Client: new (c: { connectionString: string }) => {
        query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
        connect(): Promise<void>;
        end(): Promise<void>;
      };
    };
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const confirmed = (process.env.MERRYMEN_ANNOUNCE_CONFIRM ?? "").trim() === id;
      const out = await runAnnouncement({
        client,
        announceId: id,
        body,
        confirmed,
        ...(perAgent ? { bodies, tenants: Object.keys(bodies) } : {}),
      });
      // THE DRY RUN HAS TO SHOW THE TEXT, not a count. An operator approving a
      // per-agent campaign is approving three different claims about three
      // different people's money; "3 would receive" is not something anybody
      // can check. No token is printed — the chat is its last four digits.
      for (const p of out.preview) {
        log(
          `announcement ${id}:   ${p.tenant} · ${p.name ?? "(no name)"} · chat ${p.chatRedacted} · ` +
            `${p.blocker ?? "no blocker"} · ${p.chars} chars`,
        );
        for (const line of p.body.split("\n")) log(`announcement ${id}:     | ${line}`);
      }
      log(
        `announcement ${id}: ${out.dryRun ? "DRY RUN, nothing sent" : "SENT"} — ` +
          `${out.considered} tenants, ${out.eligible} eligible, ${out.sent} ${out.dryRun ? "would receive" : "delivered"}, ` +
          `${out.personalised} with their own reason · ` +
          `${out.withAllowlist} have linked at some point, ${out.withBotToken} hold a bot token · ` +
          `skipped: ${out.skippedNoChat} no chat, ${out.skippedNoToken} no bot, ${out.skippedDisabled} tg off, ${out.skippedNotifyOff} pushes off, ` +
          `${out.skippedAlreadySent} already had it · ${out.failed.length} failed`,
      );
      // "Nobody is blocked" and "the join broke" are the same empty map and
      // opposite facts. Only one of them is safe to send on.
      if (out.blockerJoinError) {
        log(`announcement ${id}: !! per-agent blocker lookup FAILED (${out.blockerJoinError}) — every message would be generic`);
      }
      const tally = new Map<string, number>();
      for (const f of out.failed) tally.set(f.reason, (tally.get(f.reason) ?? 0) + 1);
      // Reasons without recipients: enough to act on, never enough to identify
      // anyone or reconstruct a credential.
      for (const [reason, n] of tally) log(`announcement ${id}:   ${n}× ${reason}`);
      if (out.dryRun) log(`announcement ${id}: to send, set MERRYMEN_ANNOUNCE_CONFIRM=${id}`);
    } finally {
      await client.end();
    }
  } catch (e) {
    // The message only. A pg or fetch error object can carry request context,
    // and in this process that context can include a bot token.
    log(`announcement ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runIdentityAuditIfAsked(): Promise<void> {
  if ((process.env.MERRYMEN_IDENTITY_AUDIT ?? "").trim() !== "1") return;
  const url = process.env.DATABASE_URL;
  if (!url) {
    log("identity audit asked for, but there is no DATABASE_URL");
    return;
  }
  try {
    const shared = await makePgDb(url);
    const idRows = (await shared
      .prepare("SELECT tenant, slug, accounts, privy_did, provider, subject FROM agent_identity")
      .all()) as unknown as Record<string, unknown>[];
    const grantRows = (await shared
      // `owner` is read for the residue questions only — was an account ever
      // sealed at 0x0, and is any owner key also its own login wallet. It is an
      // ADDRESS, never key material; the grant store refuses to hold a key at
      // all (packages/core hosted.ts, and a 422 at the intake).
      .prepare(
        "SELECT tenant, grant_json->>'smartAccount' AS smart_account, " +
          "grant_json->>'owner' AS owner, " +
          "grant_json->'binding'->>'version' AS binding_version FROM grants",
      )
      .all()) as unknown as Record<string, unknown>[];

    const rows: IdentityRowLite[] = idRows.map((r) => {
      let accounts: string[] = [];
      const raw = r.accounts;
      if (Array.isArray(raw)) accounts = raw.map((a) => String(a));
      else if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) accounts = parsed.map((a) => String(a));
        } catch {
          // An unreadable accounts blob is a row we cannot vouch for. Leave it
          // empty rather than guessing — it shows up as store disagreement.
        }
      }
      return {
        tenant: String(r.tenant ?? ""),
        slug: String(r.slug ?? ""),
        accounts,
        privyDid: r.privy_did === null || r.privy_did === undefined ? null : String(r.privy_did),
        provider: r.provider === null || r.provider === undefined ? null : String(r.provider),
        subject: r.subject === null || r.subject === undefined ? null : String(r.subject),
      };
    });
    // NULL means the key is absent from the JSON; an empty string means it is
    // present and empty, which a UNIQUE index treats as an ordinary value. Only
    // the first is dropped — the second is exactly the row that would break a
    // constraint the audit had blessed.
    const claims: GrantClaimLite[] = grantRows
      .filter((r) => r.smart_account !== null && r.smart_account !== undefined)
      .map((r) => ({
        tenant: String(r.tenant ?? ""),
        smartAccount: String(r.smart_account),
        owner: r.owner === null || r.owner === undefined ? null : String(r.owner),
        bindingVersion:
          r.binding_version === null || r.binding_version === undefined ? null : String(r.binding_version),
      }));

    const audit = auditIdentity(rows, claims);
    // THE SUMMARY FIRST, AND ON ITS OWN. Twenty-two children fill this stream
    // fast enough that a multi-line burst is partially dropped, and a report
    // that arrives in pieces reads as a clean result. One record carries every
    // count the decision needs; the detail lines below are a convenience.
    log(`identity| SUMMARY ${audit.summary}`);
    for (const line of audit.lines) log(`identity| ${line}`);
  } catch (e) {
    log(`identity audit failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runReconstructionDryRunIfAsked(): Promise<void> {
  if ((process.env.MERRYMEN_ACCOUNTING_RECONSTRUCT ?? "").trim() !== "1") return;
  const url = process.env.DATABASE_URL;
  if (!url) {
    log("reconstruction dry run asked for, but there is no DATABASE_URL");
    return;
  }
  try {
    const shared = await makePgDb(url);
    const ledgerAgents = (await shared
      .prepare("SELECT smart_account, owner_address, epoch, mode, hwm_usdg, contributions_known FROM agents")
      .all()) as unknown as Record<string, unknown>[];

    // THE ROSTER IS THE GRANT STORE, NOT THE LEDGER.
    //
    // The first dry run covered 22 of 24 tenants and could not say what happened
    // to the other two, because it enumerated `agents` — a table a tenant only
    // reaches once its child has armed AND mirrored. A tenant missing from the
    // report is indistinguishable from a tenant the repair found nothing to do
    // for, and "not in the mutation list" must never be read as "safe".
    //
    // So every tenant with a grant gets a plan row. One with no ledger row is
    // synthesised from its grant and comes out of the planner as exactly what it
    // is — no chain history, no rows to remove, nothing to do — recorded rather
    // than absent.
    const tenantByAccount = new Map<string, string>();
    const byAccount = new Map<string, Record<string, unknown>>();
    /** account → the class vault holding its assets, for the classifier. */
    const custodyVaults = new Map<string, readonly string[]>();
    for (const a of ledgerAgents) byAccount.set(String(a.smart_account ?? "").toLowerCase(), a);

    let rosterOnly = 0;
    let rosterRead = true;
    try {
      const gs = getGrantStore();
      for (const tenant of await gs.listTenants()) {
        const g = await gs.get(tenant);
        const acct = g?.smartAccount ? String(g.smartAccount) : null;
        if (!acct) {
          log(`recon| tenant ${tenant} holds a grant with no smart account — it cannot be planned`);
          continue;
        }
        tenantByAccount.set(acct.toLowerCase(), tenant);
        // FROM THE GRANT, which is the only place a class vault can honestly
        // come from: it is CREATE2-salted with one smart account, so there is no
        // fleet-wide list, and a settings-sourced value would point one owner's
        // reader at another owner's vault (custody.ts).
        const vaults = custodyAddressesOf(g);
        if (vaults.length > 0) custodyVaults.set(acct.toLowerCase(), vaults);
        if (byAccount.has(acct.toLowerCase())) continue;
        rosterOnly += 1;
        byAccount.set(acct.toLowerCase(), {
          smart_account: acct,
          owner_address: g?.owner ?? null,
          epoch: 1,
          mode: null,
          hwm_usdg: 0,
          contributions_known: null,
        });
      }
    } catch (e) {
      // LOUD, and the run continues on the ledger roster alone — but the count
      // below will then not add up to the fleet, which is the point of printing
      // both halves rather than just the total.
      rosterRead = false;
      log(`recon| GRANT ROSTER UNREADABLE (${e instanceof Error ? e.message : String(e)}) — tenants may be missing`);
    }
    const agents = [...byAccount.values()];
    log(
      `recon| roster: ${agents.length} account(s) — ${ledgerAgents.length} from the ledger, ` +
        `${rosterOnly} from the grant store with no ledger row · grant store read ${rosterRead}`,
    );
    const flows = (await shared
      .prepare("SELECT id, agent_id, epoch, direction, amount_usdg, source, tx_hash, at FROM flows")
      .all()) as unknown as Record<string, unknown>[];
    const equityRows = (await shared
      .prepare("SELECT agent_id, epoch, equity_usdg, at FROM equity ORDER BY agent_id, epoch, at DESC, id DESC")
      .all()) as unknown as Record<string, unknown>[];
    const equityByAccountEpoch = new Map<string, number>();
    for (const e of equityRows) {
      const k = `${String(e.agent_id).toLowerCase()}#${Number(e.epoch ?? 1)}`;
      if (!equityByAccountEpoch.has(k)) equityByAccountEpoch.set(k, Number(e.equity_usdg ?? 0));
    }

    // SCAN ONLY WHAT IS BEING REPAIRED.
    //
    // A scoped run — MERRYMEN_REPAIR_ACCOUNT naming one account — was still
    // sweeping the chain for all 24, which is both pointless and actively
    // harmful: the sweep shares an RPC with 24 live children, and the extra
    // load is what earns the rate limits that mark coverage short. The canary's
    // first commit attempt fail-closed for exactly that reason — the repair
    // refused to write because a window it did not need had gone unread.
    //
    // Narrowing the scan is not a shortcut around the completeness rule. It
    // makes the rule easier to satisfy honestly: one account is two getLogs
    // calls rather than a fleet sweep, so the answer for the account under
    // repair no longer depends on windows belonging to accounts nobody asked
    // about. The ROSTER still enumerates every tenant from the plan, so a
    // scoped run still reports 24/24 — the accounts outside the scope simply
    // carry no chain evidence and say so.
    const scopeTo = new Set(
      (process.env.MERRYMEN_REPAIR_ACCOUNT ?? "")
        .split(",")
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.startsWith("0x")),
    );
    const allAccounts = agents.map((a) => String(a.smart_account)).filter((a) => a.startsWith("0x"));
    const accounts = scopeTo.size ? allAccounts.filter((a) => scopeTo.has(a.toLowerCase())) : allAccounts;
    if (scopeTo.size && accounts.length === 0) {
      log("recon| MERRYMEN_REPAIR_ACCOUNT matches no account in the roster — nothing to scan");
    }
    if (scopeTo.size > accounts.length) {
      // LOUD. A named account that is not in the roster will silently do
      // nothing, and an operator reading "repaired 5" after naming 6 has no
      // way to tell which one never existed.
      log(
        `recon| WARNING: ${scopeTo.size} account(s) named but only ${accounts.length} found in the roster`,
      );
    }
    const rpcUrl = process.env.MERRYMEN_RPC_MAINNET ?? "https://rpc.mainnet.chain.robinhood.com";
    let rpcId = 1;
    const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
      const r = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      });
      const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
      if (j.error) throw new Error(j.error.message ?? "rpc error");
      return j.result ?? null;
    };

    const usdgToken = String(CASH.USDG);
    const head = BigInt((await rpc("eth_blockNumber", [])) as string);
    log(
      `recon| scanning ${accounts.length} of ${allAccounts.length} account(s) to block ${head}` +
        (scopeTo.size ? ` — scoped to ${accounts.length} named account(s)` : ""),
    );
    const chain = await scanFleetCapital(rpc, {
      accounts,
      usdgToken,
      fromBlock: 0n,
      toBlock: head,
      // WITHOUT THIS EVERY CLASS BUY READS AS A WITHDRAWAL.
      //
      // A class buy moves USDG account→vault and the token curve→vault, so the
      // token never touches the account at all. `classifyUsdgMovement`'s primary
      // rule looks for a paired token moving the other way into somewhere that
      // is OURS, and without the vault in that set nothing pairs: the leg falls
      // through to `no-pair-external` and is booked `capital-out` — the owner's
      // own money recorded as having left.
      //
      // `chain-capital.ts` says exactly this about omitting it ("the fleet-scale
      // version of the same bug deposit-log carries per agent") and the argument
      // was simply never passed. It matters here and now because this scan feeds
      // a repair: a trade counted as a withdrawal moves the peak the drawdown
      // breaker divides by, in the direction that halts a healthy account.
      custodyAddressesFor: (a) => custodyVaults.get(a.toLowerCase()),
      log: (m) => log(`recon| ${m}`),
    });

    // Current on-chain cash, one call each — the figure a NAV is built from.
    const onchainCash = new Map<string, number>();
    for (const a of accounts) {
      try {
        const hex = (await rpc("eth_call", [
          { to: usdgToken, data: "0x70a08231" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0") },
          "latest",
        ])) as string;
        onchainCash.set(a.toLowerCase(), Number(BigInt(hex)) / 1e6);
      } catch {
        /* left absent, which renders as unknown rather than as zero */
      }
    }

    const plans = planReconstruction({ agents, flows, equityByAccountEpoch, chain, onchainCash, tenantByAccount });

    // ONE REPORT, NOT TWO — AND IT HAS TO FIT IN THE WINDOW YOU CAN READ IT IN.
    //
    // `railway logs` is a 503-line snapshot rather than a stream (measured: it
    // returns 503 lines and does not grow), and the ledger mirror alone writes
    // ~200 lines a minute. The old dump was ~12 lines per account unconditionally
    // — 288 for this fleet — and the preview then added its own on top, so the
    // combined burst pushed itself out of the window and nobody could read
    // either. A report that cannot be retrieved is not a report.
    //
    // So when a preview is asked for, IT is the report: one roster line per
    // tenant plus the four-part block for the account under examination. The
    // older per-account dump stays for a bare reconstruction with no preview,
    // which is the only caller that still wants it.
    if (!previewRequested(process.env)) {
      for (const line of reconstructionLines(plans)) log(`recon| ${line}`);
    }
    await runRepairIfAsked(shared, plans);
  } catch (e) {
    log(`reconstruction dry run failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The preview, and — only when explicitly asked — the mutation.
 *
 * Deliberately downstream of the plan rather than a separate entry point, so
 * whatever runs is acting on a plan just derived from the live database in this
 * process. A stale preview is worse than none, and the repair's "the table
 * changed since the plan was built" check needs an honest comparison.
 */
async function runRepairIfAsked(shared: Db, plans: readonly AccountPlan[]): Promise<void> {
  const opts = parseRepairOptions(process.env);
  if (!opts) return;

  // THE PREVIEW IS ALWAYS PRINTED, in every mode. An operator reading a commit
  // run's output should not have to go and find the dry run it corresponds to.
  const previews = runPreview(plans, { accounts: opts.accounts });
  log(
    `preview| run ${opts.runId} · mode ${opts.mode} · ` +
      `accounts ${opts.accounts.length ? opts.accounts.length : "ALL"} · resume ${opts.resume}`,
  );
  for (const p of previews) {
    if (!p.selected) continue;
    const plan = plans.find((x) => x.smartAccount === p.account)!;
    for (const line of accountPreviewLines(plan, p)) log(`preview| ${line}`);
  }
  for (const line of rosterLines(previews)) log(`preview| ${line}`);

  if (opts.mode === "dry-run") {
    log("preview| dry run — nothing was written");
    return;
  }
  if (opts.mode === "commit" && opts.accounts.length === 0) {
    // The accounts being mutated are always named. runRepair refuses this too;
    // saying it here as well means the log shows WHY nothing happened rather
    // than just showing nothing happening.
    log("repair| refusing a commit with no named accounts — set MERRYMEN_REPAIR_ACCOUNT");
    return;
  }

  const chainId = Number(process.env.MERRYMEN_CHAIN_ID ?? 4663);
  const results = await runRepair(shared, plans, opts, chainId, (r) =>
    log(`repair| ${r.account.slice(0, 10)} ${r.stage} — ${r.why}`),
  );
  for (const line of repairLines(opts.runId, opts.mode, results)) log(`repair| ${line}`);
}


// ── THE NEWS DESK ──────────────────────────────────────────────────────────
//
// ONE DESK FOR THE WHOLE FLEET, living here rather than in the children, for
// the reasons written out in research-files.ts. The short version is that the
// worker is one process per tenant, so a cache in a child is a cache for one
// agent, and the vendor allowance is measured in requests per day.

/** Equity symbols each tenant is allowed to trade. Refreshed on every reconcile. */
const tenantWatchSymbols = new Map<string, string[]>();
/** Equity symbols each tenant actually holds. Read off the child ledger. */
const tenantHeldSymbols = new Map<string, string[]>();
/**
 * Symbols the fleet reasoned about in the last day, newest first.
 *
 * Refreshed by the mirror pass, which already holds a shared connection — one
 * query on its clock rather than a second connection on the news desk's.
 */
let fleetReasonedSymbols: string[] = [];
/** Built on first use so a deployment with no token still logs why. */
let fleetNewsDesk: NewsDesk | null = null;

/**
 * Coin CONTRACTS each tenant cares about, held first. Refreshed on the mirror.
 *
 * ADDRESSES RATHER THAN SYMBOLS, and that is forced rather than chosen. The
 * builder directory is keyed on a deployed contract, which is the whole reason
 * it is worth asking: a coin's symbol is text its deployer picked and can
 * change, and one calling itself after a real project would resolve to that
 * project's page if we looked names up. An address cannot be borrowed.
 *
 * It is also why this list cannot come from the same place the news desk's
 * does. `tenantWatchSymbols` holds equity tickers from settings; a Trencher's
 * universe is discovered per tick inside the child and exists only in the
 * child's own sqlite, which the mirror already opens.
 */
const tenantCoinAddresses = new Map<string, string[]>();
/**
 * The agent's own candidate window, restated because it cannot be imported.
 *
 * `CLASS_WINDOW_SEC` and `CLASS_LIMIT` are index.ts's, and `CLASS_LIMIT` is a
 * const inside `proposeClassEntries` — a closure in another process. Copying
 * the numbers is the only option; a test greps both files and fails when they
 * part, which is the half that makes the copy safe.
 */
const CLASS_CANDIDATE_WINDOW_SEC = 6 * 3600;
const CLASS_CANDIDATE_LIMIT = 40;
/** Built on first use, like the news desk, so a deployment logs its cadence. */
let fleetBuilderDesk: BuilderDesk | null = null;

/**
 * The equities among a list of symbols, deduped, order preserved.
 *
 * A MEMECOIN IS FILTERED OUT HERE AND THAT IS DELIBERATE. A news desk asked
 * about a launchpad token returns either nothing or stories about an unrelated
 * ticker that happens to collide, and both are worse than an honest absence.
 * Instrument-specific desks are the rule; this is the rule's first enforcement
 * point, before a request is spent rather than after.
 */
function equitySymbols(list: readonly unknown[] | undefined): string[] {
  const known = new Set(STOCK_TOKENS.map((t) => t.symbol.toUpperCase()));
  const out = new Set<string>();
  for (const raw of list ?? []) {
    const s = String(raw ?? "").trim().toUpperCase();
    if (s && known.has(s)) out.add(s);
  }
  return [...out];
}

/**
 * Symbols the fleet has actually been REASONING about lately, newest first.
 *
 * The held list alone is not enough, and the first live fetch proved it: a
 * deploy rebuilds every child's sqlite, so `positions` is empty for a few
 * minutes and `heldEquitySymbols` returns nothing. With no held names to put
 * first, the desk fell through to the watch universe — twenty-five listed
 * tokens, capped at three per request — and rotated onto AAPL, MU and SPCX
 * while the whole shadow cohort was thinking about TSLA and NVDA.
 *
 * A decision row names the instrument its agent looked at, which is precisely
 * the question the desk should be answering. It comes from shared Postgres, so
 * it survives the redeploy that empties the thing above it — the same reason
 * the accounting anchor and the peer wire read from here rather than from a
 * child.
 *
 * Best-effort: an unreadable table means the held and watch tiers decide, which
 * is the behaviour that existed before this.
 */
async function recentlyReasonedSymbols(shared: Db): Promise<string[]> {
  try {
    const rows = (await shared
      .prepare(
        // DISTINCT SYMBOLS BY RECENCY, NOT ROWS BY RECENCY.
        //
        // Rows are written per decision, and a deterministic agent writes
        // thousands where a shadow agent writes one an hour — Gary alone has
        // 4,441. Taking the most recent 200 ROWS therefore returns whatever the
        // noisiest agents last touched, and the cohort this list exists to
        // serve is crowded out of its own query. Production showed it: the desk
        // asked about MU, SPCX and USAR while three agents were reasoning about
        // TSLA and NVDA.
        `SELECT symbol, MAX(at) AS last_at FROM decisions
          WHERE symbol IS NOT NULL AND at > ?
          GROUP BY symbol
          ORDER BY last_at DESC LIMIT 50`,
      )
      .all(Math.floor(Date.now() / 1000) - 86_400)) as { symbol?: unknown }[];
    return equitySymbols(rows.map((r) => r.symbol));
  } catch {
    return [];
  }
}

/** What this tenant holds, biggest position first. Best-effort and never throws. */
async function heldEquitySymbols(db: Db): Promise<string[]> {
  try {
    const rows = (await db
      .prepare("SELECT symbol FROM positions WHERE value_usdg > 0 ORDER BY value_usdg DESC")
      .all()) as { symbol?: unknown }[];
    return equitySymbols(rows.map((r) => r.symbol));
  } catch {
    // A child whose ledger predates the table, or is mid-rebuild. Its watch
    // list still reaches the desk; only the held-first ordering is lost.
    return [];
  }
}

/**
 * The coin contracts this tenant is actually thinking about, held first.
 *
 * THREE SOURCES, IN THE ORDER THEIR QUESTIONS MATTER.
 *
 *   positions        what the agent owns. "Should I trim this" is a live
 *                    question with money already behind it.
 *   class_positions  the class book, which holds coins the ordinary positions
 *                    table may not carry between a rebuild and the next arm.
 *   discovered_pools what the discovery pass found. "Is this worth opening" is
 *                    one of twenty candidates — and it is also the decision the
 *                    builder lens is most useful for, which is why candidates
 *                    are here at all rather than only holdings.
 *
 * EQUITIES AND CASH ARE FILTERED OUT, the mirror image of `equitySymbols`. A
 * tokenised equity on this chain is a wrapper; asking a builder directory who
 * ships Apple would spend a lookup to be told nothing, or worse, be answered.
 *
 * Best-effort and never throws. A child whose ledger predates a table simply
 * contributes fewer addresses, and the lens is absent for the rest — which is
 * the same outcome as never having asked, and is honest.
 */
async function coinAddressesFor(db: Db): Promise<string[]> {
  const notCoins = new Set<string>([
    ...STOCK_TOKENS.map((t) => t.address.toLowerCase()),
    ...Object.values(CASH).map((a) => String(a).toLowerCase()),
  ]);
  const pull = async (sql: string, column: string): Promise<string[]> => {
    try {
      const rows = (await db.prepare(sql).all()) as Record<string, unknown>[];
      return rows.map((r) => String(r[column] ?? ""));
    } catch {
      return [];
    }
  };
  const held = await pull(
    "SELECT token FROM positions WHERE value_usdg > 0 ORDER BY value_usdg DESC",
    "token",
  );
  const classHeld = await pull(
    "SELECT token FROM class_positions ORDER BY first_seen DESC LIMIT 50",
    "token",
  );
  // THE SAME WINDOW AND THE SAME CEILING THE AGENT ITSELF USES, and the first
  // version of this was neither.
  //
  // It read the newest 25 rows with no time bound, which was a number chosen
  // for how it sounded. The agent's own candidate set is
  // `recentCandidates(CLASS_WINDOW_SEC, CLASS_LIMIT)` — the newest FORTY rows
  // inside SIX HOURS — so the desk looked up a strict subset and the fifteen
  // oldest candidates of every tick were never asked about at all.
  //
  // WHY THAT WAS WORSE THAN A COVERAGE GAP. A contract nobody looked up and a
  // contract the directory has no page for produce the same thing downstream:
  // no record, no block, NO DATA AVAILABLE. So the shortfall was invisible —
  // it could not show up as an error, only as a lens that seemed to have less
  // to say than it does. That is exactly the confusion `builder.ts` is built
  // to keep out, arriving through the back door of a scheduling constant.
  //
  // The six-hour bound matters in its own right, and not only for parity: a
  // pool from yesterday cannot become a class entry, so a lookup spent on one
  // is a lookup not spent on a coin the agent may actually buy.
  //
  // PINNED BY A TEST rather than by this comment. The two constants live in a
  // different process — `CLASS_LIMIT` is a function-local in index.ts — so
  // they cannot be imported, and a copied number with no check is a number
  // that drifts. See research-boundary.test.ts.
  const candidates = await pull(
    `SELECT address FROM discovered_pools
      WHERE first_seen > unixepoch() - ${CLASS_CANDIDATE_WINDOW_SEC}
      ORDER BY first_seen DESC LIMIT ${CLASS_CANDIDATE_LIMIT}`,
    "address",
  );
  return addressesOf([...held, ...classHeld, ...candidates]).filter((a) => !notCoins.has(a));
}

/**
 * Refresh the fleet's builder records. WRITES NOTHING.
 *
 * SPLIT FROM THE WRITE ON PURPOSE, and it is the one structural thing to know
 * about this pass: `runNewsPass` is the single writer of research.json, and two
 * passes writing the same file on the same clock would take turns clobbering
 * each other's half. So this refreshes a fleet-wide cache and the news pass
 * materialises both halves in one atomic rename. It runs immediately before it.
 *
 * NEVER FATAL AND NEVER BLOCKING, the same contract every outside source here
 * holds: a directory outage must leave the fleet trading exactly as it did
 * before the feature existed.
 */
async function runBuilderPass(): Promise<void> {
  if (children.size === 0) return;
  try {
    if (!fleetBuilderDesk) {
      fleetBuilderDesk = makeBuilderDesk({
        // Read here and nowhere else. CHILD_SECRET_STRIP removes it from every
        // child's environment, so this process is the only one that holds it —
        // and unlike the news token, an absent one is not a disabled desk.
        apiKey: process.env.MERRYMEN_HEY_API_KEY || undefined,
        ttlSec: Number(process.env.MERRYMEN_BUILDER_TTL_SEC) || undefined,
        perPass: Number(process.env.MERRYMEN_BUILDER_PER_PASS) || undefined,
      });
      log(fleetBuilderDesk.plan().why);
    }
    // HELD BEFORE CANDIDATES ACROSS THE WHOLE FLEET, not per tenant: the budget
    // is fleet-wide, so one agent's twenty-five candidates must not be asked
    // about before another agent's open position.
    const held: string[] = [];
    const rest: string[] = [];
    for (const tenant of children.keys()) {
      const mine = tenantCoinAddresses.get(tenant.toLowerCase()) ?? [];
      // `coinAddressesFor` already returns held-first, and the first few are
      // the positions; splitting on a count would be guesswork, so the whole
      // list keeps its order and the fleets interleave by tenant.
      if (mine.length) held.push(mine[0]!);
      rest.push(...mine.slice(1));
    }
    const r = await fleetBuilderDesk.refresh([...held, ...rest], Math.floor(Date.now() / 1000));
    if (r.log) log(r.log);
  } catch (e) {
    log(`builder: pass failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Refresh the fleet's news, then materialise each child's slice of it.
 *
 * NEVER FATAL AND NEVER BLOCKING. External research is additional evidence: a
 * provider outage must leave the fleet trading exactly as it did before the
 * feature existed, which is the same contract `writePeersFor` holds.
 *
 * The write happens on EVERY pass, not only when a fetch did. A child restarted
 * by a deploy comes up with no research file at all, and the desk it would then
 * report is "not-fetched" for everything — which is the honest answer to a
 * question nobody asked, but the wrong one when the orchestrator has the answer
 * sitting in memory.
 */
async function runNewsPass(): Promise<void> {
  if (children.size === 0) return;
  try {
    if (!fleetNewsDesk) {
      fleetNewsDesk = makeNewsDesk({
        // Read here and nowhere else. CHILD_SECRET_STRIP removes it from every
        // child's environment, so this process is the only one that holds it.
        apiKey: process.env.MERRYMEN_MARKETAUX_API_KEY ?? "",
        dailyLimit: Number(process.env.MERRYMEN_MARKETAUX_DAILY_LIMIT) || undefined,
        articlesPerRequest: Number(process.env.MERRYMEN_MARKETAUX_LIMIT) || undefined,
        // Unset by default: the derived window is chosen so the allowance lasts
        // a whole day, and overriding it is how an operator on a paid tier buys
        // a fresher desk — or how one on a shared key exhausts it.
        windowSec: Number(process.env.MERRYMEN_MARKETAUX_WINDOW_SEC) || undefined,
      });
      log(`news: ${fleetNewsDesk.plan().why}`);
    }

    // HELD BEFORE WATCHED. "Should I trim what I own" is a question with a
    // position behind it; "is this worth opening" is one of twenty-five
    // candidates. When the allowance cannot cover both, the first wins.
    const held: string[] = [];
    const watch: string[] = [];
    for (const tenant of children.keys()) {
      const key = tenant.toLowerCase();
      held.push(...(tenantHeldSymbols.get(key) ?? []));
      watch.push(...(tenantWatchSymbols.get(key) ?? []));
    }
    // THINKING ABOUT IT BEATS MERELY BEING ALLOWED TO TRADE IT. Held names
    // first because a position is a live question; then the instruments the
    // fleet has actually reasoned about in the last day, which is what a
    // shadow cohort spends its time on and what survives a redeploy; then the
    // rest of the watch universe, which is only a list of what is permitted.
    const reasoned = fleetReasonedSymbols;
    const now = Math.floor(Date.now() / 1000);
    // HELD NAMES ARE PASSED TWICE, ON PURPOSE. Once in the priority list and
    // once as the set that keeps its slots: the rotation is anchored on the
    // clock, so before this the "held before watched" ordering above survived
    // only while everything fitted. The fleet held TSLA and the desk asked
    // about GOOGL, AMZN and NVDA.
    const r = await fleetNewsDesk.refresh([...held, ...reasoned, ...watch], now, held);
    if (r.log) log(r.log);

    const state = fleetNewsDesk.state();
    for (const tenant of children.keys()) {
      const key = tenant.toLowerCase();
      const mine = new Set([...(tenantHeldSymbols.get(key) ?? []), ...(tenantWatchSymbols.get(key) ?? [])]);
      try {
        writeResearchForChild(childHome(tenant), {
          at: now,
          news: {
            // FILTERED TO THIS TENANT'S OWN UNIVERSE. A symbol this agent
            // cannot trade is not evidence for it, and `asked` is filtered with
            // the items so the desk's not-fetched/quiet distinction stays true
            // per tenant rather than only fleet-wide.
            asked: state.asked.filter((s) => mine.has(s)),
            fetchedAt: state.fetchedAt,
            failure: state.failure,
            items: state.items.filter((it) => it.symbols.some((s) => mine.has(s))),
          },
          // THE OTHER HALF, WRITTEN IN THE SAME RENAME. `runBuilderPass` ran
          // immediately before this and left its answers in a fleet-wide
          // cache; this is the only writer of the file, which is what keeps
          // the two desks from clobbering each other. Filtered to this
          // tenant's own contracts for the same reason the news is filtered to
          // its own symbols: a coin this agent cannot trade is not evidence
          // for it.
          builders: fleetBuilderDesk
            ? fleetBuilderDesk.recordsFor(tenantCoinAddresses.get(key) ?? [], now)
            : [],
        });
      } catch (e) {
        log(`news: ${tenant} write failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    log(`news: pass failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

function mirrorLedgers(): Promise<void> {
  return underLease(mirrorLedgersPass());
}

async function mirrorLedgersPass(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || children.size === 0) return;
  let shared;
  try {
    shared = await makePgDb(url);
    // The full ledger schema, not just the cursor table. Nothing else applies
    // it to the shared database — children have DATABASE_URL stripped, so their
    // initStore() opens sqlite — which meant every migration that landed in the
    // child schema silently broke the mirror's INSERT for that table until
    // somebody ran the DDL by hand. Idempotent, and it runs on the mirror's own
    // clock, so a fresh deploy heals itself.
    await applyLedgerSchema(shared);
    await shared.exec(translateSchema(MIRROR_STATE_DDL));
    // `CREATE TABLE IF NOT EXISTS` adds no column to a table that already
    // exists, and every live deployment already has this one — so without the
    // ALTER the new witness column would exist only on a database nobody has.
    // Swallowed the way every other migration here is: it throws on the second
    // pass and on every pass after it.
    try {
      await shared.exec(`ALTER TABLE mirror_state ADD COLUMN last_stamp INTEGER`);
    } catch {
      /* already there */
    }
    // Same clock, same reasoning: the one process that can reach this database
    // creates what it writes, so a fresh deploy heals itself rather than
    // needing DDL run by hand.
    await shared.exec(translateSchema(TELEGRAM_STATE_DDL));
    // The command receipt, on the same clock and for the same reason: this
    // process writes it (landResults), so this process creates it.
    try {
      await shared.exec(COMMAND_RECEIPT_DDL);
    } catch {
      /* already there */
    }
  } catch (e) {
    log(`ledger mirror: shared db unavailable — ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  for (const tenant of [...children.keys()]) {
    // ONLY THE REPLICA THAT HOLDS THE LEASE MAY MIRROR, and this is not a
    // tidiness rule — it is the difference between copying a ledger and
    // destroying one.
    //
    // `children` keeps its entry after the lease moves: the child was spawned
    // here, the lease went to another replica on a later reconcile, and the
    // sqlite left behind in this container is whatever it was when this replica
    // stopped writing it. The mirror then copied THAT up. `positions` and
    // `cost_basis` are snapshots — delete-then-insert, because a closed position
    // must not linger — so a stale child with none of either DELETED the live
    // rows the owning replica had just written.
    //
    // Observed on a real book: positions emptying and refilling, entry prices
    // recovered from receipts and gone again minutes later, and a permanent
    // "CURSOR REWOUND" on a tenant whose child was healthy the whole time — the
    // rewind detector correctly reporting that THIS replica's copy had been
    // rebuilt beneath it, which it had, in another container.
    //
    // A lease we do not hold, or hold unhealthily, means the authoritative child
    // is elsewhere. Say nothing rather than say something wrong.
    const lease = leases.get(tenant.toLowerCase());
    if (!lease || !lease.healthy()) continue;
    // CLOSED IN THE finally BELOW. One descriptor per tenant per pass, on a
    // fifteen-second clock, is twenty-two leaked handles a quarter-minute for
    // as long as the service runs.
    const handle = openChildLedger(childHome(tenant));
    if (!handle) continue;
    try {
      const r = await mirrorTenant({ tenant, child: handle.db, shared });
      // The link code and any chat the owner just linked. Not part of the
      // ledger — it is a file, not a table — but it needs the same ferry and
      // the same lease: only the replica that owns this child may speak for it.
      await publishChildTelegram(tenant as `0x${string}`, shared);
      // Read while the handle is open, on the mirror's clock. The news desk
      // asks about what the fleet holds before what it merely may buy, and this
      // is the only place the orchestrator can see the difference.
      tenantHeldSymbols.set(tenant.toLowerCase(), await heldEquitySymbols(handle.db));
      // The coin side of the same reading, and the only place it is available:
      // a Trencher's universe is discovered inside the child and lives in this
      // sqlite, which nothing outside this loop opens.
      tenantCoinAddresses.set(tenant.toLowerCase(), await coinAddressesFor(handle.db));
      // A FAILED TABLE IS LOUDER THAN A QUIET ONE.
      //
      // This used to print only when n > 0, which made a stalled table and an
      // idle fleet look identical — and mirrorTenant's per-table catch means a
      // stall is permanent and silent. So the failures print unconditionally,
      // for the same reason fleetHealth prints unconditionally: an operator who
      // learns to read silence as health cannot see a wedged mirror.
      // A REWIND MEANS ROWS WERE LOST BEFORE IT. Printed separately from the
      // counts because it is not routine: it says this tenant's child ledger
      // was rebuilt under a watermark that outlived it, and everything the
      // append-only tables held before that point is gone with the old file.
      if (r.restarted) {
        const what = Object.entries(r.restarted)
          .map(([k, v]) => `${k} (was ${v.was})`)
          .join(", ");
        log(`ledger mirror: ${tenant} CURSOR REWOUND — the child ledger was rebuilt beneath it: ${what}`);
      }
      if (r.failed) {
        const why = Object.entries(r.failed)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" | ");
        log(`ledger mirror: ${tenant} STALLED — ${why}`);
      }
      // What arrived, and apart from it what was deliberately not copied; see
      // mirrorCountsLine for why the two are never summed.
      const counts = mirrorCountsLine(tenant, r);
      if (counts) log(counts);
    } catch (e) {
      log(`ledger mirror: ${tenant} failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      handle.close();
    }
    // ── THE WIRE ────────────────────────────────────────────────────────────
    //
    // Materialise the theses of the agents this owner follows into the child's
    // own home, beside grant.json and settings.json. Runs on the mirror's clock
    // rather than on its own, for two reasons: the shared handle is already open
    // here (one connection, not two), and the rows being read were written by
    // the pass immediately above, so a peer's newest thinking is at most one
    // cycle old rather than two.
    //
    // AFTER the mirror and outside its try, deliberately. A tenant whose mirror
    // stalled should still receive peers, and a peer write that fails must not
    // be mistaken for a mirror failure — they have different remedies and the
    // log lines say different things.
    // `children` is keyed by the grant store's own tenant list, which is
    // 0x-shaped by construction — the same cast writeSettingsForChild takes.
    await writePeersFor(tenant as `0x${string}`, shared);
  }

  // What the fleet has been thinking about, for the news desk to prioritise.
  // Read here because the shared handle is already open and because this table
  // is the one thing that survives the redeploy which empties every child's
  // positions — see recentlyReasonedSymbols.
  fleetReasonedSymbols = await recentlyReasonedSymbols(shared);
}

/**
 * Write one child's peers.json. Best-effort, and silent when there is nothing.
 *
 * An owner with no follows gets an EMPTY FILE rather than no file. The desk's
 * tool registration keys on whether peers exist, so "nobody wired in" and "the
 * orchestrator has not run yet" have to be distinguishable — and only one of
 * them should hide the tool.
 */
async function writePeersFor(tenant: `0x${string}`, shared: Db): Promise<void> {
  try {
    const edges = await getFollowStore().following(tenant);
    const theses = await peerThesesForSlugs(
      shared,
      edges.slice(0, MAX_FOLLOWS).map((e) => e.target),
    );

    // THE AGENT'S OWN THESES, from the durable copy.
    //
    // The child holds a `decisions` table and could read this itself. It must
    // not: that sqlite is wiped by every redeploy, so an agent reading its own
    // memory from it is permanently having its first thought. Shared Postgres
    // is the durable copy and the child cannot reach it — `CHILD_SECRET_STRIP`
    // removes `DATABASE_URL` on purpose — so it is materialised here, through
    // the same gate, the same file and the same atomic write as the peers.
    //
    // `readPeerTheses` is reused rather than re-queried: memory and publication
    // must not be able to disagree about what this agent said.
    let own: PublicThesis[] = [];
    try {
      const id = await getIdentityStore().get(tenant);
      if (id?.accounts.length) own = await readPeerTheses(shared, id.accounts);
    } catch {
      // An agent with no identity yet has no published theses to remember, and
      // a peer file is still worth writing without them.
    }

    writePeersForChild(childHome(tenant), { at: Math.floor(Date.now() / 1000), theses, own });
    if (theses.length > 0 || own.length > 0) {
      log(
        `wire: ${tenant} +${theses.length} peer thesis/theses from ${edges.length} follow(s), ` +
          `+${own.length} of its own`,
      );
    }
  } catch (e) {
    // Never fatal. The wire is additional evidence; a child with a stale or
    // absent peer file trades exactly as it did before the feature existed.
    log(`wire: ${tenant} failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── THE GROUP CHAT ─────────────────────────────────────────────────────────
//
// One public room where the fleet talks. The whole of it lives in
// worker/src/groupchat/ and docs/groupchat.md; this is glue.
//
// NOT AWAITED, AND THAT IS THE POINT. The loop above is serial: an awaited pass
// delays reconcile, which is what notices a lost lease and stands a child down.
// The room may call a model with no abort signal of its own, so it runs behind
// an in-flight latch and the loop never waits for it. A slow room is a quiet
// room; it is never a late watchdog.
//
// IT CANNOT REACH TRADING. It reads the ledger and writes only groupchat_*
// tables, which nothing on a trading path reads — groupchat/boundary.test.ts
// pins both directions. It never writes a child's settings, grant, peers or
// commands, so a sleeping agent keeps trading by construction.

/** Per tenant, the few settings words the room may use. Filled in writeSettingsForChild. */
const tenantChatProfile = new Map<string, ChatProfile>();
let groupChat: Conductor | null = null;
let groupChatInFlight = false;
/** The last failure logged, so a broken database is one line and not one every 15 s. */
let groupChatLastFailure: { text: string; at: number } | null = null;

/**
 * The room's knobs, read the way an operator means them.
 *
 * SET-BUT-EMPTY IS UNSET. A blank variable is how a dashboard "clears" one, and
 * Number("") is 0 — which switched the model off for an operator who had just
 * asked for the default back.
 *
 * ZERO LINES AN HOUR IS A SILENT ROOM. It used to fail a `> 0` check and run at
 * the default 240 — the opposite of what an operator turning it down meant.
 *
 * A VALUE THAT CANNOT BE READ IS SAID OUT LOUD, once. The model allowance then
 * fails CLOSED — the model is the one part of the room that can cost trading
 * anything (docs/groupchat.md rule 4) — while an unreadable line ceiling keeps
 * its default, because template lines cost nobody anything.
 */
export interface GroupChatEnv {
  /** The boot line saying why the room is off, or null when it runs. */
  off: string | null;
  perHour: number | undefined;
  llmPerDay: number | undefined;
  /** One boot line per value that was set and could not be honoured as written. */
  notes: string[];
}

export function groupChatEnv(env: Record<string, string | undefined> = process.env): GroupChatEnv {
  const shown = (raw: string) => JSON.stringify(raw.slice(0, 32));
  const none = { perHour: undefined, llmPerDay: undefined, notes: [] };
  if ((env.MERRYMEN_GROUPCHAT ?? "").trim() === "0") {
    return { ...none, off: "groupchat: off — MERRYMEN_GROUPCHAT=0, so this orchestrator writes no agent lines" };
  }
  const notes: string[] = [];
  let perHour: number | undefined;
  const hourRaw = env.MERRYMEN_GROUPCHAT_PER_HOUR?.trim();
  if (hourRaw) {
    const n = Number(hourRaw);
    if (!Number.isFinite(n) || n < 0) {
      notes.push(`groupchat: ignoring MERRYMEN_GROUPCHAT_PER_HOUR=${shown(hourRaw)} — not a count of lines; the room keeps its default ceiling`);
    } else if (Math.floor(n) === 0) {
      return { ...none, off: "groupchat: off — MERRYMEN_GROUPCHAT_PER_HOUR=0 allows no room lines" };
    } else {
      perHour = n;
    }
  }
  let llmPerDay: number | undefined;
  const dayRaw = env.MERRYMEN_GROUPCHAT_LLM_PER_DAY?.trim();
  if (dayRaw) {
    const n = Number(dayRaw);
    if (Number.isFinite(n) && n >= 0) {
      llmPerDay = n;
    } else {
      llmPerDay = 0;
      notes.push(`groupchat: MERRYMEN_GROUPCHAT_LLM_PER_DAY=${shown(dayRaw)} is not a count of calls — no model calls until it is; templates carry the room`);
    }
  }
  return { off: null, perHour, llmPerDay, notes };
}

/**
 * A ROOM KEY FROM THE HOUSE'S OWN GROQ ORGANIZATION STILL STARVES TRADING.
 *
 * groupChatCreds refuses a key that IS a fleet key, which is all a process can
 * see. Groq rations per ORGANIZATION and per MODEL, not per key: a second key
 * made in the house account is a different string, passes that check, and
 * spends the per-minute and per-day allowance the scout and every agent's
 * reasoning live inside — the 2026-08-31 exhaustion again. Which org a key
 * belongs to cannot be read from here, so this warns rather than refuses, and
 * it fires exactly when the room would run on the model trading runs on: the
 * case where a shared org means a shared allowance.
 */
export function groupChatModelWarning(
  creds: { model: string } | null,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!creds) return null;
  // Said in so many words already — describeCreds names the fleet key it shares.
  if (env.MERRYMEN_GROUPCHAT_SHARE_HOUSE_KEY === "1") return null;
  if (!env.GROQ_API_KEY?.trim()) return null;
  const fleetModel = env.MERRYMEN_GROQ_MODEL?.trim() || GROUPCHAT_FLEET_DEFAULTS.groqModel;
  if (creds.model.trim().toLowerCase() !== fleetModel.toLowerCase()) return null;
  return (
    `groupchat: WARNING — the room's model ${creds.model} is the fleet's trading model. Groq rate-limits per ` +
    `organization and per model, not per key, so MERRYMEN_GROUPCHAT_LLM_KEY must come from a SEPARATE Groq ` +
    `organization: a second key in the house org spends trading's per-minute and daily allowance. If it does ` +
    `not, set MERRYMEN_GROUPCHAT_MODEL to a model trading does not use, or MERRYMEN_GROUPCHAT_LLM_PER_DAY=0`
  );
}

/** The knobs, read once: the environment does not change under a running process. */
let groupChatKnobs: GroupChatEnv | null = null;

/** The MCP background tick, built on the first reconcile pass (worker/src/mcp/background.ts). */
let mcpBackground: (() => void) | null = null;

function startGroupChatPass(): void {
  if (groupChatInFlight || stopping) return;
  if (!groupChatKnobs) {
    groupChatKnobs = groupChatEnv();
    // Said once, on the first pass: an operator who flips a switch and
    // redeploys is watching for the line that says it took.
    if (groupChatKnobs.off) log(groupChatKnobs.off);
    for (const note of groupChatKnobs.notes) log(note);
  }
  if (groupChatKnobs.off) return;
  if (!process.env.DATABASE_URL || children.size === 0) return;
  groupChatInFlight = true;
  void runGroupChatPass().finally(() => {
    groupChatInFlight = false;
  });
}

async function runGroupChatPass(): Promise<void> {
  try {
    if (!groupChat) {
      const knobs = groupChatKnobs ?? groupChatEnv();
      // The room's OWN key or none: groupChatCreds refuses every fleet key.
      const creds = groupChatCreds();
      groupChat = makeConductor({ creds, perHour: knobs.perHour, llmPerDay: knobs.llmPerDay });
      // plan().why carries its own "groupchat:" prefix. describeCreds says WHY
      // the voice is what it is — a refused key is otherwise just "templates only".
      log(groupChat.plan().why);
      log(describeCreds(creds));
      const warning = groupChatModelWarning(creds);
      if (warning) log(warning);
    }
    const shared = await makePgDb(process.env.DATABASE_URL!);
    // ONLY WHO THIS REPLICA SPEAKS FOR. The same lease gate as the mirror: a
    // tenant whose lease is held elsewhere, or held unhealthily, is not ours to
    // voice. Keyed by the smart account every shared table uses, never the
    // tenant alone.
    const roster: RosterMember[] = [];
    for (const [tenant, child] of children) {
      const key = tenant.toLowerCase();
      const held = leases.get(key);
      if (!held || !held.healthy()) continue;
      roster.push({ tenant: key, agentId: child.smartAccount.toLowerCase() });
    }
    const r = await groupChat.step(shared, roster, tenantChatProfile, Date.now());
    if (r.log) log(r.log);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    const now = Date.now();
    if (!groupChatLastFailure || groupChatLastFailure.text !== text || now - groupChatLastFailure.at > 20 * 60_000) {
      groupChatLastFailure = { text, at: now };
      log(`groupchat: pass failed — ${text}`);
    }
  }
}

/** SIGKILL-and-restart any child whose heartbeat has gone stale past the threshold. */
export function watchdog(nowSec = Math.floor(Date.now() / 1000)): void {
  if (stopping) return;
  for (const [tenant, child] of children) {
    const ageSec = (Date.now() - child.startedAt) / 1000;
    if (ageSec < WATCHDOG_GRACE_SEC) continue; // give it time to write its first beat
    const beat = heartbeatAt(tenant);
    // TWO DIFFERENT QUESTIONS. A child that has beaten and gone quiet is judged
    // by the gap; a child that has never beaten is judged by how long it has
    // been alive, against a grace that covers its staggered first tick.
    const firstGrace = child.firstBeatSec;
    const stale = beat === null ? ageSec > firstGrace : nowSec - beat > child.staleSec;
    if (stale) {
      log(
        beat === null
          ? `${tenant} heartbeat stale (never beat in ${Math.round(ageSec)}s > ${firstGrace}s) — SIGKILL + restart`
          : `${tenant} heartbeat stale (${nowSec - beat}s > ${child.staleSec}s) — SIGKILL + restart`,
      );
      const restarts = child.restarts;
      children.delete(tenant);
      try {
        child.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      // THROUGH THE SAME POLICY AS AN EXIT. This line used to call spawnChild
      // directly — no delay, no ceiling — and it is the path a rate-limited
      // child takes, because a tick stuck retrying stops beating. The one
      // failure a rate limit actually produces was the one that got the
      // un-braked restart, and every restart is another cold arm against the
      // endpoint that caused it.
      scheduleRestart(tenant as `0x${string}`, restarts + 1, "heartbeat stale", child.epoch);
    }
  }
}

function haltRequested(): boolean {
  try {
    readFileSync(fleetHaltFile());
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM / SIGINT: call the whole fleet home, let go of the leases, exit.
 * Exported so a test can drive it with a stand-in for process.exit.
 */
export function stopFleet(exit: (code: number) => void = (code) => process.exit(code)): void {
  stopping = true;
  log("stopping — calling the whole fleet home");
  for (const child of children.values()) child.proc.kill("SIGTERM");
  // FIRST, LET THE WRITES UNDER A LEASE FINISH. A reconcile pass in flight
  // may be on its way to standing a tenant down, and a stand-down holds its
  // lease until its last mirror and kill record have settled
  // (standDownKilled). A mirror pass may be part-way through a tenant.
  // Letting a lease go sooner would skip that last mirror, or hand the tenant
  // to another replica while a write could still land on the next child's
  // snapshots. No new reconcile starts once `stopping` is set, and the main
  // loop starts no new mirror pass either.
  //
  // The wait has no limit on purpose. If the shared database never answers,
  // the platform's SIGKILL ends it, which drops the write and the lease
  // together, and Postgres rolls back whatever the write had not committed.
  const settled = async () => {
    for (;;) {
      const inFlight = [...leaseWork, ...standingDown.values()];
      if (!inFlight.length) return;
      await Promise.allSettled(inFlight);
    }
  };
  // THEN release every advisory lease so a restarting replica can take over
  // at once rather than waiting for our dropped connections to time out
  // server-side. Best-effort and unawaited. The exit follows a second after
  // the signal at the earliest, and never before the kill switch has settled.
  const release = () => {
    for (const tenant of [...leases.keys()]) void releaseLease(tenant);
  };
  const exitWhenSettled = (ms: number) => setTimeout(() => void settled().then(() => exit(0)), ms);
  // A TELEGRAM KILL STILL WAITING IN A HOME goes to the store before the
  // leases do, so the replica taking over never arms that grant. The home
  // does not survive this container (kill-request.ts). Bounded, and it
  // changes nothing when no kill is pending. It only helps if Railway gives
  // the old deployment draining time. The default is none.
  if (pendingKillTenants().length === 0) {
    void settled().then(release);
    exitWhenSettled(1_000);
    return;
  }
  void Promise.race([honourPendingKills(), new Promise((r) => setTimeout(r, 3_000))])
    .catch(() => {})
    .then(settled)
    .finally(release);
  exitWhenSettled(4_000);
}

export async function runOrchestrator(): Promise<void> {
  if (!isHostedMode()) {
    log("MERRYMEN_HOSTED is not set — the orchestrator only runs in hosted mode. Refusing to start.");
    process.exit(1);
  }
  log(`starting — home ${merrymenHome()}, worker ${WORKER_ENTRY}`);
  await runAccountingDiagnosisIfAsked();
  await runReconstructionDryRunIfAsked();
  await runGasAuditIfAsked();
  // The cohort report is NOT here. It reads `positions`, which the mirror
  // empties and refills per agent, so at startup it would be reading a table
  // this very deploy just cleared. It runs from the loop instead — see
  // COHORT_VET_AFTER_PASSES.

  const stop = () => stopFleet();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // ORDERS ON THEIR OWN CLOCK, beside the reconcile loop below rather than
  // inside it: that loop's pass is only as fast as its slowest step.
  void orderFerryLoop();

  // The main loop: honour a fleet-halt, else reconcile + watchdog every tick.
  for (;;) {
    if (stopping) return;
    if (haltRequested()) {
      if (children.size > 0 || leases.size > 0) {
        log("FLEET_HALT present — standing every child down and releasing leases");
        for (const t of [...children.keys()]) killChild(t);
        // Release leases too: if only THIS replica is halted, another may take
        // the tenants over; if the whole fleet is halted, releasing is harmless.
        for (const t of [...leases.keys()]) await releaseLease(t);
      }
    } else {
      /**
       * BEFORE `reconcile()`, AND THAT ORDERING IS THE WHOLE SAFETY OF IT.
       *
       * `reconcile()` spawns children and ferries them their settings. Run the
       * backfill after it and the first cohort starts with the consent flag
       * still absent — so every live agent drops to paper for a tick or two,
       * and a live agent on the paper rail loses its stop-loss and take-profit
       * as well, because holdings there come from the paper book.
       *
       * Ahead of it, the grants are written before any child reads settings and
       * the apply step has no window at all. It is idempotent and returns
       * immediately when the variable is unset, so it costs a healthy fleet one
       * comparison per pass.
       */
      await runLiveIntentBackfillIfAsked();
      await runTenantInspectIfAsked();
      await runHwmRepairIfAsked();
      await runEnableClassIfAsked();
      await runHaltClassEntriesIfAsked();
      await runResumeClassEntriesIfAsked();
      await runClassPnlRepairIfAsked();
      await runCashRowRepairIfAsked();
      await reconcile();
      watchdog();
      await mirrorLedgers();
      startHistoryRepair();
      // AFTER the mirror, because the mirror is what tells the desk which
      // symbols the fleet actually holds. Its own TTL decides whether this
      // costs a vendor request; most passes it costs a file write.
      //
      // The builder desk runs FIRST and writes nothing — see runBuilderPass.
      // Its answers are materialised by the news pass, which is the file's one
      // writer, so the order here is load-bearing rather than cosmetic.
      await runBuilderPass();
      await runNewsPass();
      // THE GROUP CHAT: after the mirror, so a fill that just landed is a call
      // the room can see, and inside this branch, so FLEET_HALT silences it
      // too. Started, never awaited — see startGroupChatPass.
      startGroupChatPass();
      // THE MCP SERVER'S BACKGROUND WORK (backtest jobs, alerts, retention).
      // Started, never awaited, like the room: nothing here is on the trading
      // path, and each pass has its own budget and in-flight guard.
      (mcpBackground ??= makeMcpBackground({ shared: () => makePgDb(process.env.DATABASE_URL!), log, rpcUrl: process.env.MERRYMEN_RPC_MAINNET }))();
      // AFTER THE MIRROR HAS SETTLED, NOT AT STARTUP, and once.
      //
      // The mirror REPLACES positions per agent, so between a child restarting
      // and its first tick the shared table is empty for an agent that plainly
      // has holdings. Run at startup — where this used to be — every reading
      // was of a table the mirror had just emptied, and the report announced
      // that the fleet held nothing. It is worth more late than wrong early.
      cohortPasses += 1;
      // ON ITS OWN PASS, EARLIER, AND ALONE.
      //
      // The identity audit first ran in the same pass as the cohort report and
      // the shadow dataset. The dataset alone is several hundred lines, and the
      // audit's lines sat at the tail of that burst: the first run lost eleven
      // of twelve, the second lost all twelve. Nothing errored — the log store
      // simply dropped them, and a report whose absence looks identical to a
      // clean fleet is not a report. A separate pass puts it in its own quiet
      // moment, where only the routine mirror lines share the stream.
      // Before the audits, and on the FIRST pass rather than a delayed one: an
      // operator who sets the variable and redeploys is watching the log now,
      // and a dry run that appears twenty minutes later reads as nothing having
      // happened. It is idempotent, so running early costs nothing.
      if (cohortPasses === 1) await runAnnouncementIfAsked();
      if (cohortPasses === IDENTITY_AUDIT_AFTER_PASSES) await runIdentityAuditIfAsked();
      if (cohortPasses === COHORT_VET_AFTER_PASSES) {
        await runCohortVettingIfAsked();
        await runBrainDatasetIfAsked();
      }
      await ferryCommands2();
      await fleetHealth();
    }
    await new Promise((r) => setTimeout(r, RECONCILE_MS));
  }
}

// Run when invoked directly (`tsx worker/src/orchestrator.ts`); importing it for
// tests does not trip this, so the pure helpers above stay unit-testable.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void runOrchestrator();
}
