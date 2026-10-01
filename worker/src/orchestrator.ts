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
import { makeXPoster, xpostSetup, type XPoster, type XPostSetup } from "./orchestrator-xpost";
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
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { merrymenHome } from "./home";
import { writeFileAtomicSync } from "./atomic-write";
import { getGrantStore } from "./grant-store";
import { KILL_DONE_TEXT, honourKillRequest, killRequested, type KillOutcome } from "./kill-request";
import { hostedRecipient, telegramSend } from "./mcp/notify";
import { getIdentityStore } from "./identity-store";
import { getSettingsStore } from "./settings-store";
import { CHAT_SETTABLE, promotedSettings, readChatSettings, type ChatSettings } from "./telegram/chat-settings";
import { acquireTenantLease, setTenantLeaseLossHandler, type TenantLease } from "./tenant-lease";
import { CASH, DEFAULT_BASKET_SYMBOLS, effectiveHolder, energyReserveTokens, isHostedMode, STOCK_TOKENS, type MerrymenSettings } from "../../packages/core/src/index";
import { backfillHolderClaims, childSettingsFor, lastWrittenHolder } from "./holder-claims";
import {
  botIdOf,
  botTokenOf,
  botWillPoll,
  claimBot,
  claimGate,
  ensureBotClaims,
  NO_ANSWER,
  ownerLinked,
  pollerKeyOf,
  readBotClaims,
  telegramDidNotAnswer,
  unclaimedBot,
  withoutBotToken,
} from "./telegram-claims";
import { getMe as telegramGetMe } from "./telegram/api";
import { parseLinkedChatAt, parsePollHealth, tokenTagOf, type PollHealth } from "./telegram/state";
import { conditionAlertTimes } from "./telegram/condition-alert-state";
import { linksToPromote } from "./telegram/link";
import { livenessAlertLine, telegramLivenessVerdict } from "./telegram-liveness";
import { makePgDb, translateSchema, type Db } from "./db";
import { BOOTSTRAP_FILE, BOOTSTRAP_SCHEMA_VERSION, type TenantBootstrapState } from "./bootstrap-state";
import { deriveBootstrapAccounting } from "./bootstrap-source";
import { diagnoseAccounting, diagnosisLines } from "./accounting-diagnosis";
import { planReconstruction, reconstructionLines } from "./accounting-reconstruction";
import type { AccountPlan } from "./accounting-reconstruction";
import { accountPreviewLines, previewRequested, rosterLines, runPreview } from "./accounting-preview";
import { parseRepairOptions, repairLines, runRepair } from "./accounting-repair";
import { accountingCommitRefusal, accountingHoldTenants, accountingTenantHeld, runAccountingReconstructionAtStartup } from "./accounting-maintenance";
import { decomposeGas, gasAuditLines, type GasOp } from "./gas-audit";
import { cohortLines, vetCandidate, type CandidateVerdictDetail } from "./cohort-vetting";
import { datasetLines, viewRun } from "./brain-dataset";
import { auditIdentity, type GrantClaimLite, type IdentityRowLite } from "./identity-audit";
import { replayLines, scoreDecision, type Observation, type PricedDecision } from "./replay";
import { custodyAddressesOf } from "./custody";
import { scanFleetCapital } from "./chain-capital";
import { getFollowStore, MAX_FOLLOWS } from "./follow-store";
import { MIRROR_STATE_DDL, mirrorCountsLine, mirrorTenant, openChildLedger } from "./ledger-mirror";
import {
  clearHoldNotified,
  ensureTelegramSchema,
  livenessFor,
  publishTelegramRuntime,
  publishTenantChildState,
  readTenantTelegram,
  readTenantConditionAlerts,
} from "./telegram-store";
import { UNCLASSIFIED_BLOCK, clearRestoreBlocked, isNamedBlock, readRestoreBlocked, restoreBlockClass, writeRestoreBlocked } from "./restore-block";
import { notifyHoldOnce, type HoldNoticeOutcome } from "./hold-notice";
import { applyHeldReset, resetsAsked, settingsRefuseHeldReset, type HeldResetOutcome } from "./held-reset";
import {
  deleteTgGroups,
  ensureTgGroupsSchema,
  forgetStoredTgGroups,
  forgetTgGroupsHome,
  forgetTgGroupsInHomes,
  forgetUnwantedTgGroups,
  publishTgGroups,
  restoreTgGroups,
  tgGroupsHeldOff,
  type TgGroupsRestore,
} from "./tg-groups-ferry";
import { storeDek } from "./store-crypto";
import { writePeersForChild } from "./peer-files";
import { writeResearchForChild } from "./research-files";
import { addressesOf, makeBuilderDesk, type BuilderDesk } from "./builder-pass";
import { makeNewsDesk, type NewsDesk } from "./research-pass";
import { peerThesesForSlugs, readPeerTheses } from "./peer-theses";
import type { PublicThesis } from "./thesis-policy";
import { ACCOUNTING_FIXED_AT, applyLedgerSchema } from "./store";
import { energyUnrestoredPending, seedEnergyDays } from "./energy-seed";
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
/** 48 Node children leave headroom under the hosted container's 1000 PID/thread limit. */
const MAX_LOCAL_CHILD_PROCESSES = 48;
/** Space process creation across the fleet instead of forking every tenant at boot. */
const SPAWN_SPACING_MS = 2_000;
/** Resource exhaustion affects the whole container, not just the tenant that hit it. */
const SPAWN_PRESSURE_FIRST_MS = 30_000;
const SPAWN_PRESSURE_MAX_MS = 2 * 60_000;
let spawnPacingForTest = false;
let spawnSpacingMs = SPAWN_SPACING_MS;
let spawnPressureFirstMs = SPAWN_PRESSURE_FIRST_MS;
let nextSpawnAt = 0;
let spawnPressureUntil = 0;
let spawnPressureFailures = 0;

function spawnErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "unknown";
}

function noteSpawnPressure(error: unknown): void {
  const code = spawnErrorCode(error);
  if (code !== "EAGAIN" && code !== "EMFILE" && code !== "ENFILE" && code !== "ENOMEM") return;
  spawnPressureFailures += 1;
  const delay = Math.min(SPAWN_PRESSURE_MAX_MS, spawnPressureFirstMs * 2 ** Math.min(spawnPressureFailures - 1, 3));
  spawnPressureUntil = Math.max(spawnPressureUntil, Date.now() + delay);
  log(`[alert] process creation refused (${code}); pausing all new children for ${Math.round(delay / 1000)}s`);
}

/**
 * Reserve a process-creation slot before the final lease/kill check. Restarts
 * and the normal roster pass share this clock. If a different child receives
 * EAGAIN while we wait, observe its new cooldown before trying to fork.
 */
async function waitForSpawnSlot(): Promise<void> {
  // Existing integration tests substitute fake processes and mock timers.
  // Exercise the real pacing only in its dedicated test.
  if (spawn !== nodeSpawn && !spawnPacingForTest) return;
  for (;;) {
    const at = Math.max(Date.now(), nextSpawnAt, spawnPressureUntil);
    nextSpawnAt = at + spawnSpacingMs;
    if (at > Date.now()) await new Promise<void>((resolve) => setTimeout(resolve, at - Date.now()));
    if (Date.now() >= spawnPressureUntil) return;
  }
}
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
 * TENANTS WITH A RESTART ALREADY SCHEDULED, and the timer that will make it.
 *
 * `reconcile()` spawns anything wanted that is not running, and a tenant whose
 * restart timer has not fired yet is not running — so the next pass spawned it
 * at restarts=0 and the timer, finding a child, stood aside. Any rung whose
 * delay outlasted the gap to that pass was unreachable: 16s and 30s lose to a
 * fifteen-second pass, so the ladder reset at about #4 or #5 and MAX_RESTARTS
 * (#9) was never hit, on the exit path or the watchdog's. A child that never
 * beat was SIGKILLed and cold-armed every couple of minutes for ever — the
 * loop `gaveUpUntil` exists to stop. The timer owns the restart it was
 * scheduled for, and reconcile steps round it.
 */
const restartPending = new Map<string, { restarts: number; timer: ReturnType<typeof setTimeout> }>();

/** Drop a tenant's scheduled restart, for a stand-down that wants none. */
function cancelRestart(tenant: string): void {
  const pending = restartPending.get(tenant);
  if (!pending) return;
  clearTimeout(pending.timer);
  restartPending.delete(tenant);
}

/**
 * How long a child must have stayed alive for its death to be a fresh
 * incident rather than the next rung of a crash loop.
 */
const HEALTHY_RUN_MS = 60_000;

/**
 * THE RUNG A CHILD'S RESTART GOES ON, decided by how long it stayed alive.
 *
 * A child that ran for a minute and then went down is a fresh incident, rung
 * 0: it says nothing about the one before it. One that went down inside that
 * minute is the same incident still going, one rung above the child it
 * replaced. The exit handler measures "alive" up to the exit. The watchdog
 * measures it up to the last heartbeat, because a wedged child is still a
 * running process and its age says nothing — it only ever kills a child older
 * than WATCHDOG_GRACE_SEC, which is already past this minute.
 */
function nextRung(child: Child, aliveUntilMs: number): number {
  return aliveUntilMs - child.startedAt > HEALTHY_RUN_MS ? 0 : child.restarts + 1;
}

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
function scheduleRestart(tenant: `0x${string}`, restarts: number, why: string): void {
  if (stopping) return;
  if (accountingTenantHeld(tenant)) return;
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
  const pending = {
    restarts,
    timer: setTimeout(() => {
      // Only the restart still scheduled: one a stand-down cancelled, or a
      // later one replaced, does nothing. Released just before spawnChild,
      // which claims `spawning` synchronously, so there is no moment at which
      // reconcile finds the tenant in neither and spawns it too.
      if (restartPending.get(tenant) !== pending) return;
      restartPending.delete(tenant);
      if (!stopping && !children.has(tenant) && !spawning.has(tenant) && !holders.has(tenant)) void spawnChild(tenant, restarts);
    }, delay),
  };
  restartPending.set(tenant, pending);
}

/** The worker entrypoint each child runs — the same main() the CLI supervises. */
const WORKER_ENTRY = path.join(fileURLToPath(new URL(".", import.meta.url)), "index.ts");
/** Repo root (…/worker/src → up two), the cwd children need to resolve tsx + deps. */
const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
/**
 * What a HELD tenant runs instead of a worker: the bot, answering, and nothing
 * else (telegram-hold.ts). See spawnHolder.
 */
const HOLD_ENTRY = path.join(fileURLToPath(new URL(".", import.meta.url)), "telegram-hold.ts");
/** A hold process polls one bot and reads two files; it needs a fraction of a worker's heap. */
const HOLDER_MAX_OLD_SPACE_MB = 128;

/**
 * Env vars the orchestrator holds that a CHILD must NEVER see. The house keys
 * (bundler/RPC/LLM) are deliberately NOT here — hosted mode WANTS them injected,
 * that is the whole point of house-keys-server-only. What a child has no business
 * holding is the material that decrypts OTHER tenants' stored session keys (the
 * DEK), forges any tenant's session (the signing secret), or reaches the shared
 * grant database (the URL). Strip those; forward everything else so the child
 * still has PATH and the OS essentials node needs to run.
 *
 * MERRYMEN_TG_GROUPS_LLM_KEY IS FORWARDED ON PURPOSE, unlike the room's and
 * X's model keys below. Those are stripped because their passes run in this
 * process; Telegram groups are polled inside the child, so the child is the
 * only process that can spend that key (docs/tg-groups.md "The model"). It is
 * a dedicated key so group chatter never draws on trading's house key.
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
   * AND THE EXISTING GUARD WOULD NOT CATCH IT. The bot claims (claimGate) are
   * judged on the tokens in tenants' SETTINGS, so tokens arriving by env are
   * invisible to them — the one collision they are built to prevent is the
   * one they cannot see.
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
  /**
   * THE X APP'S CLIENT SECRET, and the X writer's own model key
   * (docs/x-posting.md rule 5). The secret authenticates merrymen to X for
   * every owner's connection at once: with it and one leaked refresh token,
   * anybody could keep that owner's account posting. It is read in exactly one
   * file (xpost/client.ts) in the web and this process — the only two that
   * talk to X — and a child posts nothing, so it has no business holding it.
   * The model key is stripped for the room key's reason.
   */
  "MERRYMEN_X_CLIENT_SECRET",
  "MERRYMEN_XPOST_LLM_KEY",
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
 * WILL THE PROCESS THESE SETTINGS ARE WRITTEN FOR POLL THE BOT? Lives beside
 * the bot claims now (telegram-claims.ts), because only a tenant that will poll
 * claims a bot; re-exported for the callers and tests that knew it here.
 */
export { botWillPoll };

/**
 * A child's env: the orchestrator's env, minus the child-secret keys, plus this
 * tenant's home and the hosted flag. Inheriting (rather than allowlisting) keeps
 * the OS essentials and the injected house keys; the strip is what makes it safe.
 */
export function childEnv(tenant: string, opts: { tgGroupsOff?: boolean } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of CHILD_SECRET_STRIP) delete env[k];
  env.MERRYMEN_HOSTED = "1";
  env.MERRYMEN_HOME = childHome(tenant);
  // TELEGRAM GROUPS HELD OFF for a child whose group memory could not be put
  // back (tgGroupsHeldOff). The operator's own switch, set for this one child:
  // on an empty memory it would re-ask about the owner's groups, leave them,
  // and hand out a fresh day's allowances. Never set to "1": an operator's
  // fleet-wide 0 is inherited above and stays.
  if (opts.tgGroupsOff) env.MERRYMEN_TG_GROUPS = "0";
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

/** Count processes still alive, including ones that have been told to exit. */
function localChildProcessCount(): number {
  const processes = new Set<ChildProcess>();
  for (const child of children.values()) processes.add(child.proc);
  for (const held of holders.values()) {
    if (held.proc) processes.add(held.proc);
    if (held.leaving) processes.add(held.leaving);
  }
  for (const exiting of exitingChildren.values()) for (const proc of exiting) processes.add(proc);
  return processes.size;
}
export function localChildProcessCountForTest(): number {
  return localChildProcessCount();
}

/**
 * TENANTS WHOSE spawnChild IS STILL PREPARING — claimed before its first await.
 *
 * `children` only learns about a child at `spawn()`, and spawnChild awaits a
 * dozen times before that: the grant, the settings, the anchor, the paper
 * restore, the seeds. Every caller checked `children.has` first, so a
 * reconcile pass and a restart timer (or two timers) that arrived inside that
 * window both saw nothing running and both started a worker — two processes
 * on one home and one sqlite file, both trading, only one of them visible to
 * the watchdog. A tenant is in here from spawnChild's first line to its last,
 * whichever way it leaves, and reconcile and the restart timers step round it.
 *
 * WITH THE TIME IT WAS CLAIMED, because stepping round it is silent. A spawn
 * whose preparation never settles — a Postgres lock wait or a half-open socket
 * under the final mirror, the restore or the seeds, none of which carry a
 * timeout — holds its tenant here for good, and that tenant and its Telegram
 * bot go dark with nothing in the log. See flagStuckSpawn.
 */
const spawning = new Map<string, { since: number; flagged: boolean }>();

/** How long a spawn may stay preparing before reconcile says so. */
const SPAWN_STUCK_MS = 5 * 60_000;

/**
 * SAY ONCE THAT A TENANT IS DARK BECAUSE ITS SPAWN NEVER FINISHED.
 *
 * Only said, never undone: releasing the claim would let the next pass start
 * a second worker beside a spawn that may yet finish, which is the double
 * spawn `spawning` exists to prevent. A redeploy clears it; the alert is what
 * tells an operator one is needed.
 */
function flagStuckSpawn(tenant: string): void {
  const prep = spawning.get(tenant);
  if (!prep || prep.flagged || Date.now() - prep.since < SPAWN_STUCK_MS) return;
  prep.flagged = true;
  log(`[alert] spawn for ${tenant} still preparing since ${new Date(prep.since).toISOString()} — nothing else will start this tenant until it settles`);
}

/**
 * Test seam: count a child as running without spawning a worker, so a test
 * can drive the real reconcile() over it. A supplied lease lets a test drive
 * the immediate socket-loss path without a live database.
 */
export function adoptChildForTest(
  tenant: `0x${string}`,
  smartAccount: `0x${string}`,
  proc: Pick<ChildProcess, "kill">,
  lease?: TenantLease,
): void {
  const lc = tenant.toLowerCase() as `0x${string}`;
  children.set(lc, { proc: proc as ChildProcess, tenant: lc, smartAccount, startedAt: Date.now(), restarts: 0, staleSec: 600, firstBeatSec: 600 });
  if (lease) leases.set(lc, lease);
}

/**
 * What starts a child's worker process: node's own `spawn`, unless a test has
 * swapped in a fake. adoptChildForTest stops short of spawnChild, so it cannot
 * reach the exit handler or the spawn guards; this lets a test drive the real
 * reconcile → spawnChild → exit path without starting a worker.
 */
let spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess = nodeSpawn;

/** Test seam: start children with `fn` instead of node's `spawn`. */
export function setSpawnForTest(fn: typeof spawn): void {
  spawn = fn;
}

/** Test seam: run the production spawn gate with short, real waits. */
export function setSpawnPacingForTest(spacingMs: number, pressureMs: number): void {
  spawnPacingForTest = true;
  spawnSpacingMs = spacingMs;
  spawnPressureFirstMs = pressureMs;
  nextSpawnAt = 0;
  spawnPressureUntil = 0;
  spawnPressureFailures = 0;
}

/**
 * A TENANT WHOSE TRADING IS HELD: its practice book could not be restored, so
 * no worker runs for it, and a hold process answers its bot instead
 * (telegram/hold.ts). See spawnHolder.
 */
interface Holder {
  tenant: `0x${string}`;
  /** The account the book is keyed on, which the restore is retried for. */
  smartAccount: `0x${string}`;
  /**
   * The hold process, or null: no bot to answer (Telegram off, no token), or
   * the process is being stopped for the handover (then it is `leaving`). A
   * held tenant is recorded either way, so reconcile stops trying to spawn it
   * every pass.
   */
  proc: ChildProcess | null;
  /** Resolves when `proc` has exited. */
  exited: Promise<void> | null;
  /**
   * THE HOLD PROCESS A HANDOVER OR A STAND-DOWN HAS TOLD TO STOP, until its
   * exit is seen (watchHolder clears it, and nothing else does). Until then it
   * may still be polling the owner's bot and writing telegram.json in the
   * home, so the tenant stays in `holders` and nothing starts beside it: not
   * the worker, not another hold process. See handHoldBack, standDownHolder.
   */
  leaving: ChildProcess | null;
  /** When `leaving` was sent SIGTERM, ms: its SIGKILL is due three seconds on, and its alert ten (pressLeaving). */
  leftAt: number;
  /**
   * The bot `leaving` was reading when it was told to stop, as the pass's
   * de-duplication keys it (homeBotKey), or null: counted as this tenant's in
   * every pass until the exit is seen (reconcile), since the home it read may
   * be wiped meanwhile.
   */
  leftBot: string | null;
  /** On its way to trading: the next pass after `leaving` has gone finishes the handover (handHoldBack). */
  handingBack: boolean;
  /**
   * Stood down, and waiting only for `leaving` to go. Nothing more is done
   * for it; it leaves `holders` when that process does (standDownHolder,
   * watchHolder).
   */
  stoodDown: boolean;
  /**
   * When the [alert] that `leaving` would not go was last said, ms, or null:
   * once, then again each LEAVE_REALERT_MS while it stays, not every pass.
   */
  leaveAlertedAt: number | null;
  /**
   * The restore's own error, and the class of it an owner may be told: the
   * last NAMED one once there has been one. A failure that names no rule of
   * the book's (a dropped connection) never replaces it. See UNCLASSIFIED_BLOCK.
   */
  reason: string;
  cls: string;
  /**
   * When the restore is tried again, ms, and the waits after the next named
   * and the next unclassified failure. See scheduleHoldRetry.
   */
  nextRetryAt: number;
  backoffMs: number;
  quickMs: number;
  /** A retry is running. Two passes must not both hand the tenant over. */
  retrying: boolean;
  /**
   * The newest practice reset its owner queued that a restore attempt has
   * already looked at, so one press is one early retry and not one every pass
   * (reconcile; held-reset.ts). Seeded by the spawn that held the tenant when
   * it looked at one, so the same pass does not look again.
   */
  resetSeen: string | null;
  /**
   * Whether the owner is offered the practice reset (restore-block.ts
   * holdText): their stored settings would let it be honoured. Recorded in
   * restore-blocked.json for the hold process, and kept in step with the
   * settings on reconcile's clock.
   */
  resettable: boolean;
}

/**
 * HELD TENANTS, AND NOWHERE ELSE: never in `children`.
 *
 * `children` is walked by everything that treats a tenant as trading: the
 * order and command ferries, the ledger mirror, the watchdog, the builder and
 * news desks, the group chat roster and the X poster. A held tenant must reach
 * none of them. Mirrored, its empty or unrestored book would overwrite the
 * paper checkpoint, positions and cost basis the shared ledger still holds; it
 * must receive no order or command; and it has no tick, so the watchdog would
 * kill it for a heartbeat it never writes. So it gets its own map, and is
 * added by name only where it belongs: reconcile's spawn loop (which steps
 * round it), the restore retry, the settings refresh, the Telegram half of the
 * mirror, and every stand-down.
 */
const holders = new Map<string, Holder>();

/** The first wait before a held tenant's restore is tried again, doubling to HOLD_RETRY_MAX_MS. */
const HOLD_RETRY_FIRST_MS = 2 * 60_000;
const HOLD_RETRY_MAX_MS = 30 * 60_000;
/** After a failure that names no rule of the book's, about a pass; doubling only to HOLD_RETRY_FIRST_MS. */
const HOLD_RETRY_QUICK_MS = 15_000;
/** A hold process that exits this many times inside HOLDER_CRASH_WINDOW_MS is stood down for GIVE_UP_COOLOFF_MS. */
const HOLDER_MAX_CRASHES = 3;
const HOLDER_CRASH_WINDOW_MS = 60_000;
/** When each tenant's hold process last exited on its own, inside the window. Outlives the entry, like gaveUpUntil. */
const holderCrashes = new Map<string, number[]>();

/**
 * Test seam: count a tenant as held without spawning anything, so a test can
 * drive the real reconcile() over it. `proc` needs `kill`, `once` and `on`,
 * and may be null, as for a tenant with no bot. The tenant's lease is taken
 * too, as spawnChild would have found it: a held tenant always has one.
 */
export async function adoptHolderForTest(
  tenant: `0x${string}`,
  smartAccount: `0x${string}`,
  proc: Pick<ChildProcess, "kill" | "once" | "on"> | null,
  reason = "paper fills are newer than the recoverable valuation",
): Promise<void> {
  const lc = tenant.toLowerCase() as `0x${string}`;
  if (!leases.has(lc)) {
    const lease = await acquireTenantLease(lc);
    if (lease) leases.set(lc, lease);
  }
  const held: Holder = {
    tenant: lc, smartAccount, proc: null, exited: null, leaving: null, leftAt: 0, leftBot: null, handingBack: false, stoodDown: false, leaveAlertedAt: null,
    reason, cls: restoreBlockClass(reason),
    nextRetryAt: 0, backoffMs: HOLD_RETRY_FIRST_MS, quickMs: HOLD_RETRY_QUICK_MS, retrying: false, resetSeen: null,
    resettable: false,
  };
  scheduleHoldRetry(held, held.cls);
  holders.set(lc, held);
  if (proc) watchHolder(held, proc as ChildProcess);
}

/** Is this tenant held? For tests, which cannot see the map. */
export function isHeldForTest(tenant: string): boolean {
  return holders.has(tenant.toLowerCase());
}

/**
 * Test seam: the tenant's lease reports its connection dropped, as a real one
 * does once Postgres has let the lock go. The no-op lease a test runs on never
 * does, so reconcile's lease-loss stand-down could not be driven without this.
 */
export function loseLeaseForTest(tenant: string): void {
  const lc = tenant.toLowerCase();
  const lease = leases.get(lc);
  if (lease) leases.set(lc, { ...lease, healthy: () => false });
}

/** Does this replica hold the tenant's lease? For tests, which cannot see the map. */
export function hasLeaseForTest(tenant: string): boolean {
  return leases.has(tenant.toLowerCase());
}

/**
 * The advisory lease held for each tenant we are running, keyed by lowercased
 * tenant. Acquired in reconcile() BEFORE the first spawn and held across crash
 * restarts (never re-acquired per process — a restart must not open a window for
 * another replica). Released only when the tenant is no longer wanted (kill
 * switch), when its lease goes unhealthy, or on shutdown.
 */
const leases = new Map<string, TenantLease>();
let stopping = false;
/** A lease-lost child must exit before THIS replica may arm the tenant again. */
const leaseLossDraining = new Set<string>();
/** An expired grant's process must exit and its final ledger must settle before re-sign can arm. */
const retiringExpired = new Map<string, { mirror: boolean; lease: TenantLease | null }>();
export function isRetiringExpiredForTest(tenant: string): boolean {
  return retiringExpired.has(tenant.toLowerCase());
}
let lastRosterLog: { active: number; expired: number; at: number } | null = null;
let lastCapacityLog: { deferred: number; at: number } | null = null;
/** Includes children already removed by the watchdog or another stand-down. */
const exitingChildren = new Map<string, Set<ChildProcess>>();

/** A repair must not act beside any local incarnation, including one still exiting. */
const accountingMaintenanceLocalState = (tenant: string) => ({
  processPresent: children.has(tenant) || holders.has(tenant) || spawning.has(tenant) ||
    restartPending.has(tenant) || exitingChildren.has(tenant) || retiringExpired.has(tenant) || leaseLossDraining.has(tenant),
  localHomePresent: existsSync(childHome(tenant)),
});

function log(msg: string): void {
  console.log(`[orchestrator] ${msg}`);
}

function trackExitingChild(tenant: string, proc: ChildProcess): void {
  // adoptChildForTest also accepts a kill-only fake for older integration
  // tests; real ChildProcess instances always emit exit.
  if (typeof proc.once !== "function") return;
  let pending = exitingChildren.get(tenant);
  if (!pending) {
    pending = new Set();
    exitingChildren.set(tenant, pending);
  }
  if (pending.has(proc)) return;
  pending.add(proc);
  const exited = () => {
    const current = exitingChildren.get(tenant);
    current?.delete(proc);
    if (current?.size === 0) {
      exitingChildren.delete(tenant);
      leaseLossDraining.delete(tenant);
    }
  };
  proc.once("exit", exited);
  // A child that never spawned can emit `error` without `exit`. Its failed
  // process cannot still be trading, so it must not hold the local barrier.
  proc.once("error", () => { if (proc.pid === undefined) exited(); });
}

/** Release and forget a tenant's lease. Best-effort; safe if none is held. */
async function releaseLease(tenant: string): Promise<void> {
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
function readChildTelegram(tenant: string, nowSec = Math.floor(Date.now() / 1000)): {
  linkCode: string | null;
  ownerId: number | null;
  linkedAt: number | null;
  firedAlerts: Record<string, number>;
  linkedChats: number[];
  /** When each of `linkedChats` last linked (telegram/state.ts linkedChatAt). */
  linkedChatAt: Record<string, number>;
  chatSettings: { at: number; patch: Record<string, unknown> } | null;
  /** The bot `linkCode` belongs to (telegram/state.ts botId); null before the child has bound one. */
  botId: string | null;
  /** How its polls went (telegram/state.ts PollHealth); null before the first. */
  poll: PollHealth | null;
} | null {
  try {
    const raw = readFileSync(path.join(childHome(tenant), "telegram.json"), "utf8").replace(/^﻿/, "");
    const t = JSON.parse(raw) as Record<string, unknown>;
    return {
      linkCode: typeof t.linkCode === "string" && t.linkCode ? t.linkCode : null,
      ownerId: typeof t.ownerId === "number" ? t.ownerId : null,
      linkedAt: typeof t.linkedAt === "number" ? t.linkedAt : null,
      firedAlerts: conditionAlertTimes(t.firedAlerts, nowSec),
      linkedChats: Array.isArray(t.linkedChats)
        ? (t.linkedChats as unknown[]).filter((c): c is number => typeof c === "number")
        : [],
      linkedChatAt: parseLinkedChatAt(t.linkedChatAt),
      chatSettings: readChatSettings(t.chatSettings),
      // Digits only, as the child's own loader insists: this is published.
      botId: typeof t.botId === "string" && /^\d+$/.test(t.botId) ? t.botId : null,
      // Cleaned as untrusted (state.ts parsePollHealth): its error goes into
      // this process's log lines and the shared database.
      poll: parsePollHealth(t.poll, nowSec),
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
 * seconds after a successful link, and never again.
 *
 * EACH LINK IS PROMOTED ONCE, so removing a chat on the dashboard sticks. The
 * child's `linkedChats` only grows, and this used to add back whatever of it
 * the stored allowlist lacked: a chat the owner had removed was restored on the
 * next pass, with its command authority, until a redeploy wiped the home. Now
 * the child records when each chat linked, and this process records, in
 * PROMOTED_LINKS_FILE beside telegram.json, which link of each chat it has
 * promoted (telegram/link.ts linksToPromote). A chat that links again, with a
 * code of its own, is a new link and is promoted again. The record lives and
 * dies with the file it describes: a redeploy wipes both, and
 * writeTelegramForChild never restores `linkedChats`.
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
 *
 * THE PUBLISHED CODE COMES BACK TOO, linked or not. Codes are random now
 * (state.ts), so a child that starts with no code mints a new one, and a tenant
 * who has not linked yet would find the code on the dashboard replaced by every
 * redeploy, perhaps while they were typing it. The code the mirror holds is the
 * one the dashboard shows. A link rotates it and the next pass publishes the
 * rotation, so it is an unused code unless a redeploy lands inside those
 * fifteen seconds. That window is accepted: without the restore, every
 * redeploy would void the code of every tenant who has not linked yet.
 *
 * A code from before random codes comes back like any other, and the child
 * retires it on start (state.ts retireLegacyCode): it was a hash of the token,
 * and was printed into these logs as it was minted. The random code that
 * replaces it is published by the next pass, and that is what later restores
 * bring back.
 */
export async function writeTelegramForChild(tenant: `0x${string}`, shared?: Db): Promise<void> {
  const file = path.join(childHome(tenant), "telegram.json");
  if (existsSync(file)) return;
  const url = process.env.DATABASE_URL;
  if (!url && !shared) return;
  try {
    const db = shared ?? (await makePgDb(url!));
    const tg = await readTenantTelegram(db, tenant);
    if (tg) tg.firedAlerts = await readTenantConditionAlerts(db, tenant, tg.ownerId);
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
    const restored = restoredTelegramFile(tg, ownerId);
    // Nothing to restore is the ordinary state of a tenant whose bot the child
    // has never run. An empty file would only mask a later genuine publish.
    if (!restored) return;
    mkdirSync(childHome(tenant), { recursive: true });
    writeFileAtomicSync(
      file,
      JSON.stringify(restored, null, 2),
      0o600,
    );
    // Never the code itself: it is a bearer credential, and this log is the
    // fleet's (index.ts, "link code ready").
    if (restored.ownerId) log(`${tenant}: telegram link restored — the owner keeps receiving alerts`);
    else log(`${tenant}: telegram link code restored (shown on the dashboard)`);
  } catch (e) {
    // Never fatal. A child with no telegram link still trades; it just cannot
    // tell anyone about it, which is the status quo this repairs.
    log(`${tenant}: could not restore telegram state — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * What a fresh child's telegram.json is seeded with: only what there is.
 *
 * `ownerId` is the recovered one, which may have come from the allowlist rather
 * than the mirror; with it goes the mirror's `linkedAt`, when it has one. The
 * link code is the published one, restored whether or not anyone has linked
 * (writeTelegramForChild says why). A field with nothing to restore is left
 * out, and the child fills it in as for a first run. Nothing at all is null,
 * and no file is written.
 *
 * NEVER `linkedChats`. It is the list the parent promotes into the stored
 * allowlist, and restoring it would put back every chat the owner has since
 * removed on the dashboard. Nor the offset: the date rule in service.ts is
 * what keeps a replayed backlog from running.
 */
export function restoredTelegramFile(
  tg: { linkCode: string | null; linkedAt: number | null; ownerId?: number | null; firedAlerts?: Record<string, number> } | null,
  ownerId: number | null,
): { linkCode?: string; ownerId?: number; linkedAt?: number; firedAlerts?: Record<string, number> } | null {
  const out: { linkCode?: string; ownerId?: number; linkedAt?: number; firedAlerts?: Record<string, number> } = {};
  if (tg?.linkCode) out.linkCode = tg.linkCode;
  if (ownerId) {
    out.ownerId = ownerId;
    if (typeof tg?.linkedAt === "number") out.linkedAt = tg.linkedAt;
    if (tg?.ownerId === ownerId) {
      const firedAlerts = conditionAlertTimes(tg.firedAlerts);
      if (Object.keys(firedAlerts).length) out.firedAlerts = firedAlerts;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function publishChildTelegram(tenant: `0x${string}`, shared: Db, childState: string): Promise<void> {
  const tg = readChildTelegram(tenant);
  if (!tg) {
    // NO FILE, NO CODE: publishing an empty one would erase a real one during
    // a restart. But whether the tenant trades is not about its bot, and an
    // owner held with no bot has nowhere else to hear it
    // (telegram-store.ts publishTenantChildState).
    try {
      await publishTenantChildState(shared, tenant, childState);
      livenessPublished(tenant, null);
    } catch (e) {
      livenessPublished(tenant, e);
    }
    return;
  }
  try {
    // The code and the owner, then how the bot's polls are going and whether
    // the tenant trades, for the dashboard (telegram-store.ts
    // TELEGRAM_LIVENESS_DDL says what each column means and why). The bot is
    // published only while this process is still handed its token: a tenant
    // whose bot went to another's claim keeps a code for it that will never
    // work (telegram-store.ts livenessFor).
    const handed = botTokenOf(readChildSettings(tenant));
    const liveness = livenessFor(tg, handed ? botIdOf(handed) : null, childState);
    const failed = await publishTelegramRuntime(
      shared,
      tenant,
      { linkCode: tg.linkCode, ownerId: tg.ownerId, linkedAt: tg.linkedAt, firedAlerts: tg.firedAlerts },
      liveness,
    );
    livenessPublished(tenant, failed);
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
    const promoted = readPromotedLinks(tenant);
    if (promoted === null) {
      // A record that will not read cannot say which links were promoted, and
      // guessing "none" would put back every chat the owner has removed. So
      // every link in the file is taken as promoted, which at worst loses one
      // made in the last pass: its owner links again.
      writePromotedLinks(tenant, linksToPromote(tg.linkedChats, tg.linkedChatAt, {}).record);
      log(`${tenant}: telegram link record unreadable — rewritten, and nothing promoted this pass`);
      return;
    }
    const { due, record } = linksToPromote(tg.linkedChats, tg.linkedChatAt, promoted);
    if (due.length === 0) return;
    const stored = (await getSettingsStore().get(tenant)) ?? {};
    const have = new Set(Array.isArray(stored.telegramAllowlist) ? stored.telegramAllowlist : []);
    const missing = due.filter((c) => !have.has(c));
    if (missing.length > 0) {
      for (const c of missing) have.add(c);
      await getSettingsStore().put(tenant, { ...stored, telegramAllowlist: [...have] });
      log(`${tenant}: telegram link promoted — ${missing.length} chat(s) added to the stored allowlist`);
    }
    // AFTER the put, and only once it has landed: a failed put leaves these
    // links due for the next pass. A crash between the two only means the next
    // pass finds them in the store already and records them.
    writePromotedLinks(tenant, record);
  } catch (e) {
    log(`${tenant}: could not promote telegram link — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * WHICH LINKS THIS PROCESS HAS PROMOTED for a tenant (telegram/link.ts
 * linksToPromote): chat id → the time of the link. Written by the
 * orchestrator alone, never by the child or the hold process, in the same
 * home as the telegram.json whose links it records.
 */
const PROMOTED_LINKS_FILE = "telegram-promoted.json";

/** The record, {} when there is none yet, or null when there is one that will not read. */
function readPromotedLinks(tenant: string): Record<string, number> | null {
  let raw: string;
  try {
    raw = readFileSync(path.join(childHome(tenant), PROMOTED_LINKS_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    return null;
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out: Record<string, number> = {};
    for (const [chat, at] of Object.entries(v as Record<string, unknown>)) {
      // 0 is a link from before link times were kept (linksToPromote).
      if (/^-?\d+$/.test(chat) && typeof at === "number" && Number.isFinite(at) && at >= 0) out[chat] = at;
    }
    return out;
  } catch {
    return null;
  }
}

/** Replace the record whole, through a rename, so a crash mid-write leaves the old one and never half of a new one. */
function writePromotedLinks(tenant: string, record: Record<string, number>): void {
  const file = path.join(childHome(tenant), PROMOTED_LINKS_FILE);
  writeFileAtomicSync(file, JSON.stringify(record), 0o600);
}

/** Test seam: one tenant's publish and promotion, as the mirror pass runs it. */
export function publishChildTelegramForTest(tenant: `0x${string}`, shared: Db, childState: string): Promise<void> {
  return publishChildTelegram(tenant, shared, childState);
}

/** A failing liveness publish is logged once until one succeeds, not once per tenant per pass. */
let livenessPublishFailing = false;

/** How the liveness half of a tenant's publish went: `failed` is its error, or null. */
function livenessPublished(tenant: string, failed: unknown): void {
  if (failed === null) {
    livenessPublishFailing = false;
    return;
  }
  if (livenessPublishFailing) return;
  livenessPublishFailing = true;
  log(`telegram runtime: could not publish (${tenant}) — ${failed instanceof Error ? failed.message : String(failed)}; said once until it works`);
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

/**
 * TELEGRAM GROUP MEMORY ACROSS A REDEPLOY (docs/tg-groups.md "Storage and the
 * ferry"; the mechanics are in tg-groups-ferry.ts).
 *
 * The child keeps its groups in `tg-groups.json` in a home the next redeploy
 * wipes. Up on the mirror's clock behind the lease (mirrorLedgers), down at
 * spawn before the child starts (spawnChild), gone with the grant, from the
 * row and from a home no child runs in: on the kill switch (reconcile), the
 * moment a /kill removes the grant (honourKill), and for every tenant the
 * grant store no longer lists (sweepTgGroups). Sealed under the store DEK,
 * which never leaves this process; self-hosted has no DATABASE_URL and the
 * file is the only store.
 *
 * Forget requests go up even when the file does not: while a child is held
 * (below) or its file could not be published, the mirror applies the
 * requests its home holds to the stored row (forgetStoredTgGroups), so a
 * /forgetme is never undone by the next restore.
 *
 * `tgGroupsSeen` is the last version of each tenant's file that landed, so an
 * unchanged file costs one lstat per pass.
 *
 * `tgGroupsHeld` is every tenant whose child runs with its groups held off,
 * because its spawn could not put the stored memory back (tgGroupsHeldOff).
 * Nothing is published for them, so the stored row outlives the empty memory
 * the child started with; only their forget requests reach it. Cleared by a
 * spawn that restores it, or with the grant.
 */
const tgGroupsSeen = new Map<string, string>();
const tgGroupsHeld = new Set<string>();
let tgGroupsNoDekLogged = false;

/** The store DEK, or null (said once) when this process has none: nothing is ferried in the clear. */
function tgGroupsDek(): Buffer | null {
  const dek = storeDek();
  if (!dek && !tgGroupsNoDekLogged) {
    tgGroupsNoDekLogged = true;
    log("tg-groups: MERRYMEN_STORE_DEK is not a 32-byte key — Telegram group memory is not carried across redeploys");
  }
  return dek;
}

/**
 * PUT THE CHILD'S TELEGRAM GROUPS BACK, before it starts — beside the link
 * restore and for its reason: a file restored once the child is polling would
 * land beside a fresh, empty memory the child has already written. Only when
 * the home has no file (restoreTgGroups decides). Never fatal: a child without
 * its groups still trades.
 *
 * A RESTORE THAT FAILS HOLDS THE CHILD'S GROUPS OFF (tgGroupsHeld): spawned
 * with the switch at 0 and never published, so a database blip at spawn can
 * no longer let an empty memory overwrite the stored one. The database is
 * opened only once the home is known to have no file, so a blip never holds
 * off a child whose own file survived.
 */
async function restoreTgGroupsForChild(tenant: `0x${string}`): Promise<void> {
  const lc = tenant.toLowerCase();
  const url = process.env.DATABASE_URL;
  const dek = url ? tgGroupsDek() : null;
  if (!url || !dek) {
    // Nothing is ferried either way, so there is no stored copy to protect.
    tgGroupsHeld.delete(lc);
    return;
  }
  const shared = async (): Promise<Db> => {
    const db = await makePgDb(url);
    await ensureTgGroupsSchema(db, "postgres");
    return db;
  };
  let r: TgGroupsRestore;
  try {
    r = await restoreTgGroups({ tenant, home: childHome(tenant), shared, dek, log });
  } catch (e) {
    // restoreTgGroups never throws; if it ever does, nothing is known to have been put back.
    log(`tg-groups: ${tenant} memory not restored — ${e instanceof Error ? e.message : String(e)}`);
    r = "failed";
  }
  if (r === "restored") log(`tg-groups: ${tenant} memory restored`);
  if (tgGroupsHeldOff(r, tgGroupsHeld.has(lc))) {
    tgGroupsHeld.add(lc);
    log(`tg-groups: ${tenant} memory not back (${r}) — this child runs with its groups off and publishes nothing until a spawn restores it`);
  } else {
    tgGroupsHeld.delete(lc);
  }
}

/**
 * THE KILL SWITCH'S HALF: an agent whose grant is gone leaves no group memory
 * behind, in shared Postgres or in its home here. Never fatal.
 *
 * THE HOME TOO, when no child of it runs here. Only reconcile's kill branch
 * removes a home, and only a running child's. A grant found gone during a
 * restart back-off, a crash-loop stand-down, a fleet halt or after a lost
 * lease (honourKill, spawnChild finding no grant) left tg-groups.json there,
 * and a re-grant by the same wallet found it "present" and published it
 * straight back. A running child is the file's writer and goes with its home
 * when the kill branch stands it down. Checked and removed synchronously,
 * before anything is awaited, so no spawn can start in between.
 */
async function forgetTgGroups(tenant: string): Promise<void> {
  const lc = tenant.toLowerCase();
  tgGroupsSeen.delete(lc);
  tgGroupsHeld.delete(lc);
  if (!children.has(lc)) forgetTgGroupsHome(childHome(tenant), log);
  const url = process.env.DATABASE_URL;
  if (!url) return;
  try {
    const shared = await makePgDb(url);
    await ensureTgGroupsSchema(shared, "postgres");
    await deleteTgGroups(tenant, shared, log);
  } catch (e) {
    log(`tg-groups: ${tenant} stored memory not deleted — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * THE KILL SWITCH, FOLLOWING THE GRANT STORE RATHER THAN THE CHILDREN.
 *
 * reconcile's kill branch forgets only a child running here at that moment. A
 * grant discarded during a redeploy, a restart back-off, a crash-loop
 * stand-down or a fleet halt never reached it, nor did a delete that failed
 * once, and a later grant by the same wallet restored the old memory, other
 * people's words included. So every pass, once the grant listing has been
 * read, the stored memory of every tenant it no longer lists is deleted
 * (forgetUnwantedTgGroups: bounded per pass, tried again on the next).
 * `listedAtMs` is when that listing was requested. Never fatal.
 *
 * AND FROM THE HOMES. The row sweep visits only tenants that still have a
 * row, and a home outlives its row, so the same pass removes the group files
 * from the home of every tenant that is neither wanted nor running here
 * (forgetTgGroupsInHomes, bounded per pass). Without a database too: the
 * file is the memory either way.
 */
async function sweepTgGroups(wanted: ReadonlySet<string>, listedAtMs: number): Promise<void> {
  // A tenant that comes back publishes afresh and is not held by a spawn of its old grant.
  for (const t of [...tgGroupsSeen.keys()]) if (!wanted.has(t)) tgGroupsSeen.delete(t);
  for (const t of [...tgGroupsHeld]) if (!wanted.has(t)) tgGroupsHeld.delete(t);
  forgetTgGroupsInHomes({
    childrenDir: path.join(merrymenHome(), "children"),
    keep: (t) => wanted.has(t) || children.has(t),
    before: listedAtMs,
    log,
  });
  const url = process.env.DATABASE_URL;
  if (!url) return;
  try {
    const shared = await makePgDb(url);
    await ensureTgGroupsSchema(shared, "postgres");
    await forgetUnwantedTgGroups({ shared, wanted, listedAtMs, log });
  } catch (e) {
    log(`tg-groups: stored memory of removed agents not swept this pass — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Write the tenant's session-key-only grant into its child's grant.json. */
async function writeGrantForChild(tenant: `0x${string}`): Promise<{ smartAccount: `0x${string}`; expiresAt: number } | null> {
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
  // so keep it owner-only. Replaced whole — see refreshGrantForChild for what a
  // child makes of half a grant.
  writeFileAtomicSync(path.join(home, "grant.json"), JSON.stringify(grant, null, 2), 0o600);
  // The SMART ACCOUNT, returned rather than discarded: it is the key every
  // ledger table is on, the caller needs it to derive the accounting anchor, and
  // the grant is the only place the orchestrator can learn it without a second
  // decrypting read.
  return { smartAccount: grant.smartAccount as `0x${string}`, expiresAt: grant.expiresAt };
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
  // ATOMIC, because this is the one grant write that lands under a RUNNING
  // child. It re-reads grant.json every tick, and loadGrantFile returns null for
  // a file that does not parse — which syncGrant cannot tell from a deleted
  // grant: an armed agent logged "KILL SWITCH — grant discarded", was marked
  // killed, and re-armed on the next tick, all because a re-sign was half
  // written when it looked.
  writeFileAtomicSync(file, next, 0o600);
  // AND THE ACCOUNT WITH IT. A re-sign under a new owner key derives a new
  // smart account, and that is the address the shared tables are keyed on — so
  // a child left holding the old one would be looked up under an account that
  // no longer trades. Same reason the file is rewritten: the wall moved.
  const child = children.get(tenant);
  if (child && grant.smartAccount) child.smartAccount = grant.smartAccount as `0x${string}`;
  // A held tenant's restore is retried for its account, which a re-sign may move.
  const held = holders.get(tenant);
  if (held && grant.smartAccount) held.smartAccount = grant.smartAccount as `0x${string}`;
  log(`${tenant}: grant changed on the store — handed the running child its new wall`);
}

/**
 * Hand the child the tenant's OWN settings.json from the store — their strategy,
 * basket, custom tokens, sizing, their Telegram bot. A tenant who has saved
 * nothing yet gets a file holding only `holderAddress`, or nothing at all when
 * no wallet counts for them (the child then runs the safe defaults, and still
 * knows whose $MERRYMEN counts — see below). Refreshed
 * every reconcile so a config change propagates: the worker re-reads
 * settings.json each tick, and mergeSettings strips house keys + forces the RCE
 * flags off, so what the tenant stored can only ever be their own legitimate
 * configuration.
 */
function writeChildSettings(tenant: `0x${string}`, forChild: MerrymenSettings): void {
  const home = childHome(tenant);
  mkdirSync(home, { recursive: true });
  const file = path.join(home, "settings.json");
  const next = JSON.stringify(forChild, null, 2);
  // UNCHANGED IS NOT REWRITTEN. Every write is now a temp file, an fsync and a
  // rename, and this runs for every child on every pass.
  try {
    if (readFileSync(file, "utf8") === next) return;
  } catch {
    // No file, or unreadable — writing it is the right answer either way.
  }
  // ATOMIC. The child re-reads this file every tick, and a plain writeFileSync
  // truncates before it writes: a read in between parsed as nothing, and the
  // child ran that tick on the defaults — paper, the default strategy, an
  // empty Telegram allowlist.
  writeFileAtomicSync(file, next, 0o600);
}

/** wallet → the account holding its claim; null when the claims could not be read. */
type HolderClaimsRead = ReadonlyMap<string, string> | null;

/**
 * EVERY HOLDER CLAIM, READ ONCE FOR THE WHOLE PASS — one query for the fleet
 * rather than one per tenant every fifteen seconds. Null when unreadable: an
 * unread claim is not "nobody claims it", so writeSettingsForChild then keeps
 * the holder wallet it wrote last rather than guess (lastWrittenHolder).
 */
async function readHolderClaims(): Promise<HolderClaimsRead> {
  try {
    return await getSettingsStore().holderClaims();
  } catch (e) {
    log(`holder claims unreadable — each child keeps the holder wallet last written: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** bot id → the account holding its claim; null when there are none to read. */
type BotClaimsRead = Map<string, string> | null;

/** Test seam: the database the bot claims are kept in, in place of DATABASE_URL's. */
let botClaimsDbForTest: Db | null = null;
export function setBotClaimsDbForTest(db: Db | null): void {
  botClaimsDbForTest = db;
}

/** The shared database holding the bot claims, with the table made; null with no shared database. */
async function botClaimsDb(): Promise<Db | null> {
  const url = process.env.DATABASE_URL;
  const db = botClaimsDbForTest ?? (url ? await makePgDb(url) : null);
  if (db) await ensureBotClaims(db);
  return db;
}

/**
 * EVERY BOT CLAIM, READ ONCE FOR THE WHOLE PASS, as the holder claims are
 * (readHolderClaims). Null when there is no shared database or it will not
 * answer, and claimGate then de-duplicates among the pass's own tenants only,
 * which is what the pass did before claims existed.
 */
async function readBotClaimsForPass(): Promise<BotClaimsRead> {
  try {
    const db = await botClaimsDb();
    return db ? await readBotClaims(db) : null;
  } catch (e) {
    log(`telegram bot claims unreadable — this pass keeps one poller per bot among its own tenants only: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** getMe's word on a token: its bot's id, null for a refusal, or NO_ANSWER when Telegram said nothing about it. */
type BotConfirmation = string | null | typeof NO_ANSWER;

/**
 * getMe: the id of the bot `token` belongs to, as Telegram says it; null when
 * Telegram refused it (revoked, mistyped, not a bot's) or it is no token at
 * all; NO_ANSWER when Telegram said nothing about it (telegramDidNotAnswer:
 * the request failed or timed out, or Telegram was down or throttling).
 * Bounded at TG_CALL_TIMEOUT_MS, and never throws (telegram/api.ts).
 *
 * WHAT A CLAIM RESTS ON, SO NOTHING ELSE MAY PASS FOR IT. Only a token of
 * Telegram's own shape is sent (botIdOf: one that could steer the URL could
 * make another method, on another bot, answer with the id it names), and
 * only an answer that says it is a bot counts (a chat's or a user's carries
 * an id too).
 *
 * NO ANSWER IS NOT A REFUSAL. Both used to be null, so one getMe that timed
 * out at a linked agent's spawn read as a revoked token: it was not asked
 * again for ten minutes, and the unlinked login on the same token claimed the
 * bot at the refresh that followed, for good (backfillBotClaim, gateBot).
 */
async function botIdFromTelegram(token: string): Promise<BotConfirmation> {
  if (botIdOf(token) === null) return null;
  const { bot, ...failure } = await telegramGetMe({ token });
  if (!bot && telegramDidNotAnswer(failure)) return NO_ANSWER;
  return bot?.isBot ? String(bot.id) : null;
}
let confirmBotId = botIdFromTelegram;
/** Test seam: what getMe answers, in place of Telegram; null puts Telegram back. */
export function setBotConfirmForTest(fn: ((token: string) => Promise<BotConfirmation>) | null): void {
  confirmBotId = fn ?? botIdFromTelegram;
}

/** How long a token Telegram refused is left before it is asked about again. */
const BOT_CONFIRM_RETRY_MS = 10 * 60_000;
/**
 * How long a token Telegram gave no answer for is left before it is asked
 * again. A blip is over in seconds; a minute keeps an outage from costing
 * every pass a getMe of up to TG_CALL_TIMEOUT_MS for each such tenant.
 */
const BOT_NO_ANSWER_RETRY_MS = 60_000;
/** Per tenant, the token (by fingerprint) Telegram last would not confirm, why, and until when it is not asked again. */
const botUnconfirmed = new Map<string, { tag: string; until: number; why: "refused" | "no answer" }>();

/**
 * THE LONGEST AN UNLINKED LOGIN IS KEPT OFF A BOT NOBODY HAS CLAIMED while
 * Telegram gives no answer for a linked agent's token for it (gateBot). Long
 * enough for the linked agent to be asked again several times
 * (BOT_NO_ANSWER_RETRY_MS). Bounded, because anyone can put a chat id on
 * their own allowlist, so "linked" proves nothing about the bot, and a token
 * that never gets an answer must not hold the bot from one Telegram confirms.
 */
const LINKED_CLAIM_WAIT_MS = 10 * 60_000;
/**
 * Per bot: the linked tenant Telegram gave no answer for, and until when an
 * unlinked login waits for its claim. Armed once per bot: a wait that has run
 * out is kept, so the bot is not waited for again, until a claim is made for
 * it or the tenant waited for is refused.
 */
const linkedClaimWait = new Map<string, { tenant: string; until: number }>();
/** The wait each unlinked tenant was last told it is under, so it is logged once. */
const botWaitLogged = new Map<string, number>();

/**
 * CLAIM A BOT NOBODY HAS CLAIMED YET FOR THIS TENANT — first one wins, and only
 * once Telegram confirms the token is that bot's (claimBot says why) — and say
 * who holds it now: this tenant, or one that got there first. Null when no
 * claim was made; the tenant is then judged without one this pass.
 *
 * A token Telegram refused is not asked about again for ten minutes: it is
 * revoked, mistyped, or not a token at all, and every pass would otherwise
 * spend a bot API call (and up to TG_CALL_TIMEOUT_MS, telegram/api.ts) on it.
 * Its process could not poll with it either, so going without a claim costs
 * nobody an answer.
 *
 * A token Telegram gave NO ANSWER for is neither: it is asked again in a
 * minute, and nothing is concluded from it. When its owner has linked a chat
 * (`linked`), an unlinked login on the same bot waits for it (linkedClaimWait,
 * gateBot) as it would at a spawn, LINKED_CLAIM_WAIT_MS at most. Meanwhile
 * its own process polls the bot as it would any unclaimed one (claimGate).
 */
async function backfillBotClaim(bot: string, tenant: `0x${string}`, token: string, linked: boolean): Promise<string | null> {
  const lc = tenant.toLowerCase();
  const tag = tokenTagOf(token);
  const refused = botUnconfirmed.get(lc);
  if (refused && refused.tag === tag && Date.now() < refused.until) return null;
  try {
    const db = await botClaimsDb();
    if (!db) return null;
    const confirmed = await confirmBotId(token);
    if (confirmed === NO_ANSWER) {
      botUnconfirmed.set(lc, { tag, until: Date.now() + BOT_NO_ANSWER_RETRY_MS, why: "no answer" });
      if (linked && !linkedClaimWait.has(bot)) linkedClaimWait.set(bot, { tenant: lc, until: Date.now() + LINKED_CLAIM_WAIT_MS });
      if (refused?.tag !== tag || refused.why !== "no answer") {
        const w = linkedClaimWait.get(bot);
        const wait = w?.tenant === lc && Date.now() < w.until ? `, and no unlinked login on it claims it meanwhile (until ${new Date(w.until).toISOString()})` : "";
        log(`${tenant}: Telegram did not answer for telegram bot ${bot}'s token — not claimed, not refused; asked again in ${BOT_NO_ANSWER_RETRY_MS / 1000}s${wait}`);
      }
      return null;
    }
    const claim = await claimBot(db, bot, tenant, confirmed, Date.now());
    if (!claim) {
      if (refused?.tag !== tag || refused.why !== "refused") {
        log(`${tenant}: Telegram refused the token for telegram bot ${bot} (revoked or mistyped?) — not claimed; asked again in ${BOT_CONFIRM_RETRY_MS / 60_000} min`);
      }
      botUnconfirmed.set(lc, { tag, until: Date.now() + BOT_CONFIRM_RETRY_MS, why: "refused" });
      // A refused token is no claim to wait for.
      if (linkedClaimWait.get(bot)?.tenant === lc) linkedClaimWait.delete(bot);
      return null;
    }
    botUnconfirmed.delete(lc);
    linkedClaimWait.delete(bot);
    return claim.holder;
  } catch (e) {
    log(`${tenant}: telegram bot claim could not be recorded, tried again next pass: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** The bot each tenant was last refused, so the refusal is logged once, not every pass. */
const botRefusedLogged = new Map<string, string>();

/**
 * THE SETTINGS THIS TENANT'S PROCESS MAY HAVE, AS FAR AS ITS BOT GOES — the
 * stored ones, or a copy without `telegramBotToken` when another tenant holds
 * the bot's claim or already polls the same token this pass (claimGate, which
 * says why each case is what it is).
 *
 * Asked on every path that writes a settings.json: a spawn (spawnChild, and
 * through it a hold's spawnHolder and handHoldBack) and the refresh of held
 * and trading tenants in reconcile. A spawn has no pass, so it reads the
 * claims for itself, and only when there is a bot to judge: most tenants have
 * none. A bot nobody has claimed yet — any token saved before claims existed,
 * or while Telegram could not confirm it to the web — is claimed here, first
 * one wins, for a tenant that polls it with a token Telegram confirms, and the
 * pass map learns the answer, so the rest of the pass is judged against the
 * same claim.
 *
 * AT A SPAWN, ONLY A TENANT WHOSE OWNER HAS LINKED A CHAT CLAIMS IT. After a
 * restart nothing is running, so every tenant comes through reconcile's spawn
 * loop, before any refresh, in listTenants order: `SELECT tenant FROM grants`,
 * with no ORDER BY. And on the first pass after the deploy that brought
 * claims, every bot is unclaimed. First one wins there is heap order: in the
 * incident's shape, the second login, with nobody linked to it, could take the
 * bot for good from the agent its owner had linked. So a spawning tenant whose
 * owner has linked nothing (ownerLinked) starts without an unclaimed bot and is
 * judged at the refresh that follows in the same pass, by which time a linked
 * tenant spawned in that pass holds it. When no linked tenant wants it, the
 * refresh claims it for the unlinked one as before, and its service picks the
 * token up from the rewritten file (a spawn the restart timer made waits for
 * the next pass). Between two linked tenants, or two unlinked ones, nothing
 * says which is the owner's, and the first confirmed token still wins.
 *
 * NO ANSWER FROM TELEGRAM IS WAITED OUT, NOT TAKEN FOR A REFUSAL. When getMe
 * gets no answer for a linked tenant's token (backfillBotClaim), an unlinked
 * login on the same bot goes without it, as it would at a spawn, until the
 * linked tenant has been asked again and answered: LINKED_CLAIM_WAIT_MS at
 * most. Before, one getMe that timed out on the deploy pass handed the bot to
 * the unlinked login at the refresh that followed, for good.
 *
 * THE TOKEN IS STRIPPED FROM THE CHILD'S FILE, NOT FROM THE STORE. The owner's
 * saved settings are theirs; the web tells them the bot is claimed (409
 * bot_claimed) and offers to move it, and a move is what gives it back.
 */
async function gateBot(
  tenant: `0x${string}`,
  settings: MerrymenSettings,
  seen: Map<string, string> | undefined,
  claimsRead: BotClaimsRead | undefined,
): Promise<MerrymenSettings> {
  const claims = claimsRead !== undefined ? claimsRead : botWillPoll(settings) ? await readBotClaimsForPass() : null;
  const lc = tenant.toLowerCase();
  const unclaimed = unclaimedBot(settings, claims);
  const spawn = claimsRead === undefined;
  const linked = ownerLinked(settings);
  if (unclaimed && spawn && !linked) {
    log(`${tenant}: telegram bot ${unclaimed} is not claimed yet and no chat is linked here — started without it; the refresh decides who claims it`);
    return withoutBotToken(settings);
  }
  // And after a spawn, while a linked agent on this bot waits on Telegram.
  const waiting = unclaimed && !linked ? linkedClaimWait.get(unclaimed) : undefined;
  if (waiting && waiting.tenant !== lc && Date.now() < waiting.until) {
    if (botWaitLogged.get(lc) !== waiting.until) {
      botWaitLogged.set(lc, waiting.until);
      log(`${tenant}: telegram bot ${unclaimed} is not claimed yet, and a linked agent on it is waiting on Telegram to confirm its token — this child goes without it meanwhile`);
    }
    return withoutBotToken(settings);
  }
  // A bot no claim names yet is claimed BEFORE it is judged, so the pass's own
  // record never decides a bot a confirmed claim could have: see claimGate.
  if (unclaimed && claims) {
    const holder = await backfillBotClaim(unclaimed, tenant, botTokenOf(settings)!, linked);
    if (holder) claims.set(unclaimed, holder);
  }
  const gate = claimGate(settings, tenant, claims, seen);
  const verdict = gate.verdict;
  if (verdict.kind === "strip") {
    if (botRefusedLogged.get(lc) !== verdict.bot) {
      botRefusedLogged.set(lc, verdict.bot);
      const why = verdict.by === "claim" ? "the bot's claim names another account" : "another tenant polls the same token this pass";
      log(`${tenant}: telegram bot token already claimed by another tenant — telegram disabled for this child (bot ${verdict.bot}: ${why})`);
    }
  } else {
    botRefusedLogged.delete(lc);
  }
  if (verdict.kind === "keep") seen?.set(pollerKeyOf(botTokenOf(settings)!)!, lc);
  return gate.settings;
}

async function writeSettingsForChild(
  tenant: `0x${string}`,
  seenBots?: Map<string, string>,
  claimsRead?: HolderClaimsRead,
  botClaimsRead?: BotClaimsRead,
): Promise<MerrymenSettings | null> {
  try {
    let settings = await getSettingsStore().get(tenant);
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
    /**
     * ONE $MERRYMEN WALLET POWERS ONE AGENT — the same rule, the same claims,
     * as every holder screen (web/src/lib/holder-wallet.ts), so a person is
     * never told one thing while their agent is throttled on another.
     *
     * effectiveHolder counts the linked proof only while its claim names this
     * tenant, the login wallet only while no other tenant claims it, and
     * otherwise nothing: one bag linked into many accounts powers one agent,
     * not all of them. The claims are read once per pass (reconcile), or here
     * for a spawn.
     *
     * UNREADABLE CLAIMS KEEP THE WALLET WRITTEN LAST, and the rest of the file
     * is still written: skipping the write would hand a freshly spawned child
     * the defaults, and the default is paper. The kept wallet was derived from
     * claims we could read; a fresh home has none, which is no wallet at all —
     * never a guess in the generous direction.
     */
    const claims = claimsRead === undefined ? await readHolderClaims() : claimsRead;
    const holder: `0x${string}` | null = claims
      ? (effectiveHolder(tenant, settings?.holderProof ?? null, (w) => claims.get(w))?.address ?? null)
      : lastWrittenHolder(path.join(childHome(tenant), "settings.json"));
    /**
     * A TENANT WHO NEVER SAVED SETTINGS STILL GETS A settings.json — holding
     * only the wallet whose $MERRYMEN counts, by the same rule as below, or
     * nothing at all when no wallet counts.
     *
     * This returned before writing anything, so the child saw no holder
     * address at all, and circle.ts reads "no address" as a KNOWABLE outsider:
     * a holder who never opened the settings screen was read as holding
     * nothing — the Circle tier lost and, with energy, the agent throttled to
     * a tenth of its day for tokens it holds. `{ holderAddress }` alone is the
     * safe defaults plus the address, because the child resolves file, then
     * env, then default, and MERRYMEN_HOLDER_ADDRESS is stripped from its env.
     * Written even when it is `{}`, so a file from an earlier pass that named
     * a wallet now claimed elsewhere does not outlive the claim.
     */
    if (!settings) writeChildSettings(tenant, childSettingsFor(null, holder));
    if (!settings) return null;
    // ONE BOT, ONE TENANT, before the file is written: on a spawn as on a
    // refresh, so a second login's child never starts with a bot it would
    // lose a pass later, having polled it in between. See gateBot.
    settings = await gateBot(tenant, settings, seenBots, botClaimsRead);
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
     *
     * AND CLAIMED, since one wallet powers one agent: `holder` above is
     * effectiveHolder's answer, and when it is null — the proof and the login
     * wallet both claimed by other tenants — childSettingsFor DELETES
     * `holderAddress` rather than leave the typed-in value standing. The
     * child then counts its own agent account alone.
     */
    const forChild: MerrymenSettings = childSettingsFor(settings, holder);
    writeChildSettings(tenant, forChild);
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
 * GIVE A REBUILT CHILD BACK TODAY'S ENERGY BEFORE IT ARMS.
 *
 * A redeploy empties the child's sqlite, and with it `energy_days`: today's
 * used reviews and new trades, the day's notice stamp and the last balance
 * reading that decided the level. Without this every deploy would hand a
 * low-energy agent a fresh day's allowance, re-send the day's notice, and — the
 * one that matters to a holder — forget that the balance read full, so a
 * restart during an RPC outage would throttle somebody who holds the tokens.
 *
 * The mirror carries the rows up (ledger-mirror.ts); energy-seed.ts carries
 * today's and yesterday's back, merged by the same statement. BEFORE spawn,
 * beside the cost-basis seed and for the same reason — the child reads them on
 * its first tick. This opens the two databases; seedEnergyDays decides.
 *
 * A FAILED SEED NO LONGER ARMS A CHILD WITH A FRESH DAY. The child still arms
 * — its exits, stops and the owner's orders must run — but with the days the
 * seed could not put back marked UNRESTORED, which its store reads as
 * unreadable, so an enforcing gate opens nothing new for a low-energy agent
 * until retryEnergySeed (every reconcile pass) or the next spawn restores them.
 * A full-energy agent, and an observe or off fleet, are untouched.
 *
 * `when` is "retry" for a running child: it writes beside the live agent, so
 * it waits only briefly for the child's write lock (this is synchronous, and
 * blocks the fleet loop while it waits) and a failure leaves the marker as it
 * is. True when the days are restored (or there is nothing to restore).
 */
const energySeedFailing = new Map<string, string>();
async function seedEnergyForChild(tenant: `0x${string}`, smartAccount: string, when: "spawn" | "retry" = "spawn"): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) return true; // self-hosted: the child's own sqlite is the only copy, and it is never wiped
  const home = childHome(tenant);
  const opened: DatabaseSync[] = [];
  try {
    const r = await seedEnergyDays({
      home,
      agent: smartAccount,
      nowSec: Math.floor(Date.now() / 1000),
      when,
      local: () => {
        const raw = new DatabaseSync(path.join(home, "merrymen.db"));
        opened.push(raw);
        raw.exec("PRAGMA busy_timeout = 250");
        return wrapSqlite(raw);
      },
      shared: () => makePgDb(url),
    });
    if (r.ok) {
      const was = energySeedFailing.delete(tenant);
      if (r.restored || was) log(`energy seed: ${tenant} — ${r.restored} day(s) restored${was ? " on retry; today's energy is readable again" : ""}`);
      return true;
    }
    // Once per distinct failure, not once per fifteen-second pass.
    if (when === "spawn" || energySeedFailing.get(tenant) !== r.why) {
      log(
        `energy seed: ${tenant} FAILED — ${r.why} ` +
          (r.marked
            ? `(the child arms with ${r.marked.join(", ")} UNRESTORED: a low-energy agent under an enforcing gate opens nothing new until a later pass restores them; exits, stops and the owner's orders run)`
            : when === "retry"
              ? "(still unrestored; tried again next pass)"
              : "(and NO marker: the child arms without its energy history)"),
      );
    }
    energySeedFailing.set(tenant, r.why);
    return false;
  } finally {
    for (const raw of opened) {
      try {
        raw.close();
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * A RUNNING CHILD WHOSE ENERGY HISTORY IS STILL MISSING, tried again.
 *
 * Only while its home holds the unrestored marker a failed seed left
 * (energy-seed.ts), so a healthy fleet pays one missing-file read per child per
 * pass. On success the child's next tick reads the restored counters.
 */
async function retryEnergySeed(tenant: `0x${string}`): Promise<void> {
  const child = children.get(tenant);
  if (!child || !process.env.DATABASE_URL || !energyUnrestoredPending(childHome(tenant))) return;
  await seedEnergyForChild(tenant, child.smartAccount, "retry");
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


/**
 * ONE MIRROR PASS PER TENANT AT A TIME.
 *
 * mirrorTenant's exactly-once rests on its watermark, read before the copy and
 * moved inside it — so two passes over one tenant at once both read the same
 * watermark and both copy the rows above it. For most tables that is a
 * duplicate on the tape; for `flows` it is contributions counted twice. The
 * mirror loop is serial, but the spawn path mirrors a dead child's ledger one
 * last time (finalMirrorBeforeAnchor), and a loop pass that took its tenant
 * list before that child exited can reach the same tenant at the same moment.
 * Both go through here, so the second waits and then finds nothing new.
 */
const mirrorTails = new Map<string, Promise<void>>();
function mirrorSerially<T>(tenant: string, pass: () => Promise<T>): Promise<T> {
  const key = tenant.toLowerCase();
  const run = (mirrorTails.get(key) ?? Promise.resolve()).then(pass);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  mirrorTails.set(key, tail);
  void tail.then(() => {
    if (mirrorTails.get(key) === tail) mirrorTails.delete(key);
  });
  return run;
}

/**
 * COPY WHAT THE LAST CHILD BOOKED BEFORE THE ANCHOR IS DERIVED FROM IT.
 *
 * The anchor's contributions come from the shared database alone, and the
 * child adds only the flows it books at or after the anchor's `generatedAt`
 * (net-contributions.ts). The mirror runs every RECONCILE_MS, so a child that
 * booked a flow — an energy purchase, a deposit — and died inside that window
 * left it in its sqlite and nowhere else. After a crash or a watchdog restart
 * that sqlite is still on disk, the restart spawns within a second or two, and
 * the flow was in NEITHER half: dated before the anchor, absent from the shared
 * sum. The new child's contributions were off by that flow for its whole life
 * (R2-MONEY6) — a purchase read as a loss by the Brain, a gate one purchase
 * loose, a missed deposit refusing a buy it should allow.
 *
 * So the dead child's ledger is mirrored one last time first, under the same
 * per-tenant serialisation as the loop. Only reached from spawnChild, which
 * runs only when this replica holds the lease and no child of the tenant is
 * running. A redeploy leaves no file — nothing to copy, and nothing the anchor
 * could have missed from THIS container. A failure is logged and the anchor is
 * derived regardless: it is no worse than before.
 */
export async function finalMirrorBeforeAnchor(tenant: string, shared: Db, home = childHome(tenant)): Promise<boolean> {
  const handle = openChildLedger(home);
  if (!handle) return false;
  try {
    const r = await mirrorSerially(tenant, () => mirrorTenant({ tenant, child: handle.db, shared }));
    if (r.failed) {
      log(`${tenant}: final mirror before the anchor STALLED — ${Object.entries(r.failed).map(([k, v]) => `${k}: ${v}`).join(" | ")}`);
    }
    const counts = mirrorCountsLine(tenant, r);
    if (counts) log(`${counts} (final pass before the anchor)`);
    return true;
  } catch (e) {
    log(`${tenant}: final mirror before the anchor failed — ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    handle.close();
  }
}

export async function writeBootstrapForChild(
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
  let now = Math.floor(Date.now() / 1000);
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
      // What the last child booked and the mirror had not yet copied — then
      // the anchor's time, AFTER that copy: every flow it carried up is dated
      // before `generatedAt`, so the new child never counts it a second time.
      await finalMirrorBeforeAnchor(tenant, db);
      now = Math.floor(Date.now() / 1000);
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

  const home = childHome(tenant);
  const file = path.join(home, BOOTSTRAP_FILE);
  try {
    mkdirSync(home, { recursive: true });
    // Whole or not at all. No child is reading yet (this runs before spawn, and
    // the child reads its anchor once), so this is about what a failure leaves.
    writeFileAtomicSync(file, JSON.stringify(state, null, 2), 0o600);
    if (accounting.kind === "unknown") {
      log(`${tenant}: accounting anchor UNKNOWN — ${accounting.why} (child will not book contributions)`);
    }
  } catch (e) {
    // A FAILED WRITE MUST NOT LEAVE THE LAST SPAWN'S ANCHOR BEHIND. The atomic
    // replace leaves the old file intact when it fails, and after a crash-restart
    // in this container that file is the previous spawn's: derived before
    // whatever the dead child booked, yet well inside BOOTSTRAP_MAX_AGE_SEC, so
    // classifyAnchor would take it as current — at worst a
    // `no-prior-accounting` anchor, which licenses booking an opening balance.
    // An absent anchor fails closed (bootstrap-state.ts): book nothing, and say
    // contributions are unknown.
    let removed = true;
    try {
      rmSync(file, { force: true });
    } catch {
      removed = false;
    }
    log(
      `${tenant}: could not write ${BOOTSTRAP_FILE} — ${e instanceof Error ? e.message : String(e)}` +
        (removed ? " (no anchor: the child will not book contributions)" : " — AND could not remove the previous one; refusing to start the child"),
    );
    if (!removed) throw new Error(`${tenant}: unsafe bootstrap anchor remains; refusing to start the child`);
  }
}

/**
 * WHY A SPAWN THAT HAS FINISHED PREPARING MUST STILL NOT START, or null.
 *
 * spawnChild checks its preconditions on the way in and then awaits a dozen
 * times — the grant, the settings, the anchor and its final mirror, the paper
 * restore, the seeds — and the world does not wait with it. A shutdown, a
 * FLEET_HALT, a lease dropped or released, or a Telegram kill that landed in
 * that window was invisible to the checks at the top, and the child started
 * anyway: holding no lock, under a halt, or over a kill the owner had just
 * asked for. So they are asked again after the last await, where nothing can
 * change between the answer and `spawn()`.
 *
 * THE SAME LEASE, not merely a healthy one. A released lease leaves `leases`
 * but the object can go on answering healthy — the no-op lease always does —
 * so only its presence in the map says this replica still holds the tenant.
 */
function lateSpawnRefusal(tenant: `0x${string}`, lease: TenantLease): string | null {
  if (stopping) return "the fleet is being called home";
  if (accountingTenantHeld(tenant)) return "operator accounting maintenance holds this tenant";
  if (haltRequested()) return "FLEET_HALT is present";
  if (retiringExpired.has(tenant)) return "the expired grant's previous process is still retiring";
  if (leaseLossDraining.has(tenant)) return "the previous child is still exiting after lease loss";
  if (exitingChildren.has(tenant)) return "the previous child is still exiting";
  if (leases.get(tenant) !== lease || !lease.healthy()) return "its lease was lost";
  if (killRequested(childHome(tenant))) return "a Telegram kill is pending";
  if (children.has(tenant)) return "a child is already running";
  return null;
}

async function spawnChild(tenant: `0x${string}`, restarts = 0): Promise<void> {
  if (stopping) return;
  if (accountingTenantHeld(tenant)) return;
  if (retiringExpired.has(tenant)) return;
  // ONE SPAWN PER TENANT AT A TIME, claimed here, before the first await.
  // Checking `children` is not enough: this function awaits a dozen times
  // before the child exists, and a second caller arriving in that window saw
  // nothing running. See `spawning`. The finally releases it whichever way
  // this function leaves — every refusal below returns, and a throw is as
  // final as a return.
  if (spawning.has(tenant)) {
    log(`${tenant}: already being spawned — not starting a second`);
    return;
  }
  // A held tenant is handed back to trading by retryHold alone, which takes it
  // out of `holders` on the line that calls this. Anyone else arriving here
  // would start a worker beside its hold process, on a book that did not restore.
  if (holders.has(tenant)) {
    log(`${tenant}: trading is held — not spawning`);
    return;
  }
  spawning.set(tenant, { since: Date.now(), flagged: false });
  try {
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
    if (exitingChildren.has(tenant)) {
      log(`${tenant}: previous child still exiting — not spawning a second`);
      return;
    }
    // FLEET_HALT means spawn none, and a restart timer can fire in the pass
    // before the main loop gets round to releasing the leases.
    if (haltRequested()) {
      log(`${tenant}: FLEET_HALT is present — not spawning`);
      return;
    }
    // Checked here as well as in writeGrantForChild, so the log says why. A
    // crash-restart lands here without passing reconcile's kill check first.
    if (killRequested(childHome(tenant))) {
      log(`${tenant}: a Telegram kill is pending — not spawning`);
      return;
    }
    const grantForChild = await writeGrantForChild(tenant);
    if (!grantForChild) {
      log(`${tenant}: no usable signed grant in the store — not spawning`);
      // THE GRANT IS GONE, and its group memory goes with it now. A crash
      // restart lands here with no reconcile kill branch to do it, because the
      // tenant is no longer in `children`. The sweep would also catch it on the
      // next pass.
      await forgetTgGroups(tenant);
      return;
    }
    const { smartAccount } = grantForChild;
    if (!Number.isFinite(grantForChild.expiresAt) || grantForChild.expiresAt <= Math.floor(Date.now() / 1000)) {
      log(`${tenant}: signed grant expired or has no valid expiry — not starting a worker; re-sign required`);
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
    let restore = await tryPaperRestore(tenant, smartAccount);
    // A PRACTICE RESET ITS OWNER ASKED FOR, honoured here because no worker can
    // honour it: this is the book the gate below would hold. Most often the
    // owner pressed Start over on the web, which also discards the grant, so
    // this spawn is the one their re-signed grant brought. See
    // honourHeldPaperReset. What it looked at goes to spawnHolder when the
    // book is held after all, so the hold does not look again this pass.
    const honour =
      !restore.ok && settings?.paperTradingEnabled === true ? await honourHeldPaperReset(tenant, smartAccount, lease) : null;
    if (honour?.applied) {
      // The anchor above was read in the epoch the reset has just closed, and
      // the worker files every row under the anchor's epoch. Written again, or
      // its whole run would land in the old epoch, beside the fills that broke
      // the book, where nothing that reads the new one would ever see it.
      await writeBootstrapForChild(tenant, smartAccount);
      restore = await tryPaperRestore(tenant, smartAccount);
    }
    if (restore.ok) {
      if (restore.line) log(`paper restore: ${tenant} — ${restore.line}`);
      forgetHold(tenant);
    } else if (settings?.paperTradingEnabled === true) {
      // A practice book we cannot restore must not silently restart its cash,
      // so no worker starts. But the owner's bot must not go silent with it,
      // which is what returning here used to do, for days: HOLD the tenant
      // instead. Trading stays off, a hold process answers the bot, the
      // restore is tried again on a backoff, and the owner is told once.
      await spawnHolder(tenant, smartAccount, restore.reason, settings, lease, honour);
      return;
    } else {
      // Not a practice book (live, or the flag unset): nothing to restart
      // silently, and the worker starts as it always did.
      log(`paper restore: ${tenant} FAILED — ${restore.reason}`);
    }
    // AND THE BOOK'S OWN COST BASIS, which the redeploy that just happened wiped
    // out of the child's sqlite. Same placement and same reason as the anchor.
    await seedBasisForChild(tenant, smartAccount);
    // AND TODAY'S ENERGY — the counters, the notice stamp and the last good
    // balance reading the redeploy just emptied. Same placement, same reason.
    await seedEnergyForChild(tenant, smartAccount);
    // AFTER the anchor and BEFORE spawn, with the others: a link restored once the
    // child is already polling would be read from a file the child has by then
    // replaced with a fresh, unlinked default.
    await writeTelegramForChild(tenant);
    // AND ITS TELEGRAM GROUPS, in the same place for the same reason. See
    // restoreTgGroupsForChild.
    await restoreTgGroupsForChild(tenant);
    // This wait is shared by the roster and crash-restart paths. It also lets
    // a resource failure in another tenant pause forks across the container.
    await waitForSpawnSlot();
    if (grantForChild.expiresAt <= Math.floor(Date.now() / 1000)) {
      log(`${tenant}: signed grant expired during worker preparation — not spawning`);
      return;
    }
    // THE LAST AWAIT IS ABOVE THIS LINE, so what is true here is still true at
    // `spawn()`. See lateSpawnRefusal.
    const late = lateSpawnRefusal(tenant, lease);
    if (late) {
      log(`${tenant}: ${late} — not spawning (it changed while the child was being prepared)`);
      return;
    }
    if (localChildProcessCount() >= MAX_LOCAL_CHILD_PROCESSES) {
      log(`[alert] ${tenant}: worker deferred; local process cap ${MAX_LOCAL_CHILD_PROCESSES} reached`);
      await releaseLease(tenant);
      return;
    }
    void writeHistoryForChild(tenant, smartAccount);
    const tickSeconds = typeof settings?.tickSeconds === "number" ? settings.tickSeconds : envTickSeconds();
    const staleSec = staleThresholdSec(tickSeconds);
    const firstBeatSec = firstBeatGraceSec(tickSeconds);
    let proc: ChildProcess;
    try {
      proc = spawn(
        process.execPath,
        [`--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`, "--import", "tsx", WORKER_ENTRY],
        // Groups held off when the restore above could not put them back.
        { cwd: ROOT, env: childEnv(tenant, { tgGroupsOff: tgGroupsHeld.has(tenant.toLowerCase()) }), stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      noteSpawnPressure(error);
      log(`${tenant}: worker spawn threw (${spawnErrorCode(error)}) — ${error instanceof Error ? error.message : String(error)}`);
      scheduleRestart(tenant, restarts + 1, `spawn ${spawnErrorCode(error)}`);
      return;
    }
    const child: Child = { proc, tenant, smartAccount, startedAt: Date.now(), restarts, staleSec, firstBeatSec };
    children.set(tenant, child);
    let stopped = false;
    const childStopped = (reason: string, restartReason: string, stoodDownReason: string): void => {
      // A failed spawn emits `error`, and some ChildProcess implementations
      // also emit `exit`. Only the first event may release the entry or queue
      // a restart. Keep the identity guard for watchdog and stand-down races.
      if (stopped) return;
      stopped = true;
      const ours = children.get(tenant) === child;
      if (ours) children.delete(tenant);
      if (stopping) return;
      if (!ours) {
        log(`${tenant} stood-down child (pid ${proc.pid}) ${stoodDownReason} — no restart from its exit`);
        return;
      }
      log(`${tenant} ${reason}`);
      const freshRestarts = nextRung(child, Date.now());
      scheduleRestart(tenant, freshRestarts, restartReason);
    };
    proc.on("error", (error: Error) => {
      // `kill()` can also emit an error while a real process is still alive.
      // Never release that child's slot and start a second trader beside it.
      if (proc.pid !== undefined) {
        log(`[alert] ${tenant}: child process error with pid ${proc.pid} — ${error.message}; waiting for its exit`);
        return;
      }
      noteSpawnPressure(error);
      childStopped(`worker spawn failed (${spawnErrorCode(error)}): ${error.message}`, `spawn ${spawnErrorCode(error)}`, `failed to spawn (${spawnErrorCode(error)})`);
    });
    proc.on("exit", (code, signal) => childStopped(`exited (${code})`, `exit ${code}`, `exited with ${code ?? signal}`));
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

    log(`${tenant} spawn requested (pid ${proc.pid ?? "pending"}) — tick ${tickSeconds}s, watchdog ${staleSec}s`);
  } finally {
    spawning.delete(tenant);
  }
}

/** What a paper restore came to: the line to log (null when there was nothing to restore from), or why it failed. */
export type PaperRestore = { ok: true; line: string | null } | { ok: false; reason: string };

let paperRestoreForTest: ((tenant: `0x${string}`, smartAccount: `0x${string}`) => Promise<PaperRestore>) | null = null;

/** Test seam: answer every paper restore with `fn`, so a test needs no shared database to hold a tenant. */
export function setPaperRestoreForTest(fn: ((tenant: `0x${string}`, smartAccount: `0x${string}`) => Promise<PaperRestore>) | null): void {
  paperRestoreForTest = fn;
}

/**
 * PUT THE TENANT'S PRACTICE BOOK BACK INTO ITS HOME, or say why it cannot be.
 *
 * Lifted out of spawnChild, where it was inline, because a held tenant's
 * restore is retried from reconcile (retryHold) against the same home while the
 * hold process runs in it. The hold process never opens merrymen.db, so this is
 * the only writer there until a worker starts.
 *
 * Never throws. The book, the flag the dashboard reads (recordPaperRecoveryHealth)
 * and the outcome are all this does; whether a failure holds the tenant is the
 * caller's decision.
 */
async function tryPaperRestore(tenant: `0x${string}`, smartAccount: `0x${string}`): Promise<PaperRestore> {
  if (paperRestoreForTest) return paperRestoreForTest(tenant, smartAccount);
  const url = process.env.DATABASE_URL;
  // No shared database: the child's own sqlite is the only book there is.
  if (!url) return { ok: true, line: null };
  let raw: DatabaseSync | null = null;
  try {
    raw = new DatabaseSync(path.join(childHome(tenant), "merrymen.db"));
    const local = wrapSqlite(raw);
    await applyLedgerSchema(local);
    const shared = await makePgDb(url);
    const line = await restorePaperCheckpoint(local, shared, smartAccount);
    try { await recordPaperRecoveryHealth(shared, smartAccount, false); }
    catch { log(`paper restore: ${tenant} — restored, but recovery status could not be published`); }
    return { ok: true, line };
  } catch (e) {
    try {
      await recordPaperRecoveryHealth(await makePgDb(url), smartAccount, true);
    } catch { log(`paper restore: ${tenant} — recovery status could not be published`); }
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    raw?.close();
  }
}

let heldResetDbForTest: Db | null = null;

/**
 * Test seam: the shared ledger a held tenant's practice reset is read from and
 * written to, in place of DATABASE_URL's, so a test can drive the real claim
 * and reset (held-reset.ts) through the real reconcile() over sqlite.
 */
export function setHeldResetDbForTest(db: Db | null): void {
  heldResetDbForTest = db;
}

/** The shared ledger for held resets, or null when there is none (self-hosted: nothing is ever held). */
async function heldResetDb(): Promise<Db | null> {
  if (heldResetDbForTest) return heldResetDbForTest;
  const url = process.env.DATABASE_URL;
  return url ? makePgDb(url) : null;
}

/**
 * What each tenant's last unhonoured reset said, so a refusal, or a ledger that
 * will not answer, is logged once and not on every retry of a hold.
 */
const heldResetSaid = new Map<string, string>();
const sayResetOnce = (tenant: string, line: string): void => {
  if (heldResetSaid.get(tenant) === line) return;
  heldResetSaid.set(tenant, line);
  log(line);
};

/**
 * Is the owner's live-trading consent enforced on this deployment? settings.ts
 * enforceLiveIntent, as the tenant's worker would read it. With it stood down,
 * a setting that does not switch live trading on proves nothing (held-reset.ts).
 */
const liveConsentEnforced = (): boolean => (process.env.MERRYMEN_LIVE_INTENT_STAND_DOWN ?? "").trim() !== "1";

/** What honouring a held tenant's practice reset came to, for the hold's own bookkeeping. */
interface HeldHonour {
  /** The book was started over: the caller restores again. */
  applied: boolean;
  /** The queued reset it looked at, or null when none was waiting (or none could be read). */
  looked: string | null;
  /**
   * The answer was no only because something could not be read or written
   * just then (held-reset.ts HeldResetOutcome): the hold's next attempt comes
   * at the pace of a failure that names no cause, a pass or so, not at the end
   * of its backoff.
   */
  transient: boolean;
}

/**
 * HONOUR A PRACTICE RESET FOR A BOOK THAT WILL NOT RESTORE. `applied` when the
 * book was started over, and the caller then restores again, which finds
 * nothing to restore and lets a worker seed a fresh book.
 *
 * Called only where a restore has just failed for a tenant the gate holds:
 * spawnChild's paper branch and retryHold. Under the lease the caller holds,
 * asked again (with the rest of what would stop a spawn) after every read and
 * immediately before the one transaction that claims the owner's command and
 * resets the book. The conditions, the claim and the reset are held-reset.ts
 * and paper-checkpoint.ts resetBlockedPaperBook; this is the wiring and the log.
 *
 * Never throws: a reset that could not be read or written is logged, and the
 * next retry asks again. Nothing it failed to do was half done.
 */
async function honourHeldPaperReset(
  tenant: `0x${string}`,
  smartAccount: `0x${string}`,
  lease: TenantLease | undefined,
): Promise<HeldHonour> {
  let out: HeldResetOutcome;
  try {
    const db = await heldResetDb();
    if (!db) return { applied: false, looked: null, transient: false };
    out = await applyHeldReset(db, smartAccount, {
      now: Date.now(),
      readSettings: () => getSettingsStore().get(tenant),
      consentEnforced: liveConsentEnforced(),
      mayWrite: () => (lease ? lateSpawnRefusal(tenant, lease) : "it holds no lease"),
    });
  } catch (e) {
    sayResetOnce(tenant, `${tenant}: a practice reset could not be checked for or honoured — ${e instanceof Error ? e.message : String(e)}`);
    return { applied: false, looked: null, transient: true };
  }
  if (out.applied) {
    heldResetSaid.delete(tenant);
    log(
      `${tenant}: practice book started over at its owner's request (command ${out.id.slice(0, 8)}) — ` +
        `epoch ${out.from} closed and kept, epoch ${out.epoch} opens with no positions, no capital flow booked`,
    );
    return { applied: true, looked: out.id, transient: false };
  }
  // Nothing waiting is the ordinary case, and says nothing.
  if (out.id !== null) sayResetOnce(tenant, `${tenant}: practice reset ${out.id.slice(0, 8)} not honoured while held — ${out.why}`);
  return { applied: false, looked: out.id, transient: out.transient };
}

/**
 * The held accounts, of those given, whose owner has queued a practice reset
 * nobody has claimed yet, with the newest row's id. Empty when there is no
 * shared ledger or it will not answer: the retries then keep their own clock.
 */
async function heldResetsAsked(accounts: readonly string[]): Promise<Map<string, string>> {
  if (accounts.length === 0) return new Map();
  try {
    const db = await heldResetDb();
    return db ? await resetsAsked(db, accounts, Date.now()) : new Map();
  } catch {
    return new Map();
  }
}

/**
 * Would these stored settings have a bot for a hold process to answer? The
 * hold process's own rule (botWillPoll), and so also the rule for whether a
 * held tenant claims its bot (claimGate).
 */
function holderBotReady(settings: MerrymenSettings | null): boolean {
  return botWillPoll(settings);
}

/**
 * HOLD A TENANT WHOSE PRACTICE BOOK COULD NOT BE RESTORED, rather than leave it
 * dark.
 *
 * The gate in spawnChild is kept: a book we cannot restore must not silently
 * restart its cash, so no worker starts. What changes is everything else. The
 * worker was the only process that polled the owner's bot, so the gate's
 * `return` also took the bot down, and in the incident this came from it stayed
 * down for days: the owner sent /link into the silence, a second login took the
 * bot, a stale backlog locked the owner out, and nobody told them anything. The
 * gate also ran every pass, so the only trace was a FAILED line every 17
 * seconds.
 *
 * So instead, under the lease spawnChild already checked:
 * - `restore-blocked.json` in the home records why and since when, for the hold
 *   process to say (as a class, never the figures);
 * - the owner's link is put back, as for a child (writeTelegramForChild);
 * - the tenant is recorded in `holders`, never `children`, so nothing that
 *   trades, mirrors or ferries ever sees it, and reconcile stops spawning it;
 * - when the stored settings have a bot switched on, a hold process answers it
 *   (telegram-hold.ts) with this tenant's childEnv: no DATABASE_URL, none of the
 *   orchestrator's secrets, only its own token;
 * - an [alert] line goes to the log once per class, and the owner a message
 *   once per class that names a rule of the book's (noteHold).
 *
 * NOT the seeds (basis, energy) or the history files: those are for a worker,
 * and none is starting. The restore is retried from reconcile (retryHold); when
 * it takes, or the gate would no longer hold the tenant (practice switched
 * off), the hold process is stopped and a worker starts in the same home
 * (handHoldBack).
 *
 * `honour` is what spawnChild's own look at a practice reset came to, just
 * now, for this same failed restore. The reset it looked at counts as seen, so
 * reconcile's early retry later in this pass does not run the restore and the
 * reset again for it; and if the answer could not be had just then, the first
 * retry comes at the quick pace rather than after the backoff.
 */
async function spawnHolder(
  tenant: `0x${string}`,
  smartAccount: `0x${string}`,
  reason: string,
  settings: MerrymenSettings | null,
  lease: TenantLease,
  honour: HeldHonour | null,
): Promise<void> {
  if (accountingTenantHeld(tenant)) return;
  // BEFORE the hold process starts, like a child's: it reads this same
  // telegram.json, and a link restored after it is polling would be read from
  // a file it has already replaced with an unlinked default.
  await writeTelegramForChild(tenant);
  // THE LAST AWAIT IS ABOVE THIS LINE: asked again for the same reasons as
  // spawnChild's, and one more. A tenant already held is not held twice.
  const late = lateSpawnRefusal(tenant, lease) ?? (holders.has(tenant) ? "it is already held" : null);
  if (late) {
    log(`${tenant}: ${late} — not holding (it changed while the hold was being prepared)`);
    return;
  }
  const home = childHome(tenant);
  // Since the hold began, not since this attempt: a hold process that died and
  // was put back by the next pass is the same hold. And so is its cause: a
  // failure that names no rule of the book's does not replace one that did.
  const prev = readRestoreBlocked(home);
  const why = !isNamedBlock(restoreBlockClass(reason)) && prev && isNamedBlock(prev.class) ? prev.reason : reason;
  const cls = restoreBlockClass(why);
  const resettable = settingsRefuseHeldReset(settings, liveConsentEnforced()) === null;
  writeRestoreBlocked(home, { reason: why, class: cls, since: prev?.since ?? Math.floor(Date.now() / 1000), resettable });
  const held: Holder = {
    tenant, smartAccount, proc: null, exited: null, leaving: null, leftAt: 0, leftBot: null, handingBack: false, stoodDown: false, leaveAlertedAt: null,
    reason: why, cls,
    nextRetryAt: 0, backoffMs: HOLD_RETRY_FIRST_MS, quickMs: HOLD_RETRY_QUICK_MS, retrying: false,
    resetSeen: honour?.looked ?? null, resettable,
  };
  // Paced by what this restore said, not by the cause the hold keeps; and a
  // reset that could not be decided is asked about again soon.
  scheduleHoldRetry(held, honour?.transient ? UNCLASSIFIED_BLOCK : restoreBlockClass(reason));
  holders.set(tenant, held);
  noteHold(tenant, reason, cls, resettable);
  if (!holderBotReady(settings)) {
    log(`${tenant}: trading held, with no bot to answer (Telegram off or no token) — the restore is tried again in ${Math.round((held.nextRetryAt - Date.now()) / 1000)}s`);
    return;
  }
  await startHolderProcess(held);
}

/**
 * Keep a held tenant's offer of the practice reset in step with its owner's
 * stored settings: in the Holder, and in restore-blocked.json, which the hold
 * process reads for every reply. Only on a change.
 */
function keepResetOffer(held: Holder, settings: MerrymenSettings): void {
  const resettable = settingsRefuseHeldReset(settings, liveConsentEnforced()) === null;
  if (resettable === held.resettable) return;
  held.resettable = resettable;
  const home = childHome(held.tenant);
  const block = readRestoreBlocked(home);
  if (block) writeRestoreBlocked(home, { ...block, resettable });
}

/** Start the hold process for a held tenant, under the shared spawn pace. */
async function startHolderProcess(held: Holder): Promise<void> {
  const tenant = held.tenant;
  await waitForSpawnSlot();
  const lease = leases.get(tenant);
  if (holders.get(tenant) !== held || held.proc || held.leaving || held.stoodDown || !lease || lateSpawnRefusal(tenant, lease)) return;
  if (localChildProcessCount() >= MAX_LOCAL_CHILD_PROCESSES) {
    log(`[alert] ${tenant}: hold process deferred; local process cap ${MAX_LOCAL_CHILD_PROCESSES} reached`);
    return;
  }
  let holderProc: ChildProcess;
  try {
    holderProc = spawn(
      process.execPath,
      [`--max-old-space-size=${HOLDER_MAX_OLD_SPACE_MB}`, "--import", "tsx", HOLD_ENTRY],
      { cwd: ROOT, env: childEnv(tenant), stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    noteSpawnPressure(error);
    if (holders.get(tenant) === held) holders.delete(tenant);
    log(`${tenant}: hold process spawn threw (${spawnErrorCode(error)}) — ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  watchHolder(held, holderProc);
  const tag = `[${tenant.slice(0, 8)} hold]`;
  const pipe = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream) =>
    stream?.on("data", (c: Buffer) =>
      String(c)
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .forEach((l) => sink.write(`${tag} ${l}\n`)),
    );
  pipe(holderProc.stdout, process.stdout);
  pipe(holderProc.stderr, process.stderr);
  log(`${tenant} held (pid ${holderProc.pid ?? "pending"}) — trading stays off, the bot answers`);
}

/**
 * What a hold process's exit means. The child's rule (spawnChild's exit
 * handler): only an exit whose entry is still its own is news. A stood-down
 * hold process, or one being stopped for the handover to trading (its `proc`
 * already cleared), is said and nothing more. Except that the exit of the one
 * a handover or a stand-down is waiting on (`leaving`) is what it waits for:
 * it is cleared here, and a stood-down tenant leaves `holders` with it.
 *
 * One that died on its own is dropped from `holders`, and the next pass
 * starts over from spawnChild: the restore is tried again, and a failure holds
 * the tenant again with a fresh process. Three of those inside a minute is a
 * hold process that cannot stay up, and the tenant is stood down for the
 * restart policy's cool-off rather than put back every pass.
 */
function watchHolder(held: Holder, proc: ChildProcess): void {
  const tenant = held.tenant;
  held.proc = proc;
  let resolveExited!: () => void;
  held.exited = new Promise<void>((resolve) => { resolveExited = resolve; });
  let stopped = false;
  const holderStopped = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (stopped) return;
    stopped = true;
    resolveExited();
    const ours = holders.get(tenant) === held && held.proc === proc;
    if (ours) holders.delete(tenant);
    // Gone at last: nothing polls the bot for this tenant now. A stand-down
    // that found it still going is complete, and its tenant free for the next
    // pass to start over; a handover it held up goes ahead on the next pass.
    const left = held.leaving === proc;
    if (left) {
      held.leaving = null;
      if (held.stoodDown && holders.get(tenant) === held) {
        holders.delete(tenant);
        // And the lease kept for as long as it might poll (reconcile's last
        // loop, honourFleetHalt): a grant signed again takes it afresh, and a
        // lost lease is already gone.
        if (!retiringExpired.has(tenant)) void releaseLease(tenant);
      }
    }
    if (stopping) return;
    if (!ours) {
      const late = left && held.leaveAlertedAt !== null ? ` — ${held.handingBack ? "the next pass hands the bot back to trading" : "its stand-down is complete"}` : "";
      log(`${tenant} stood-down hold process (pid ${proc.pid}) exited with ${code ?? signal}${late}`);
      return;
    }
    const now = Date.now();
    const recent = [...(holderCrashes.get(tenant) ?? []), now].filter((t) => now - t < HOLDER_CRASH_WINDOW_MS);
    if (recent.length >= HOLDER_MAX_CRASHES) {
      holderCrashes.delete(tenant);
      gaveUpUntil.set(tenant, { until: now + GIVE_UP_COOLOFF_MS, restarts: 0 });
      log(
        `${tenant} hold process keeps dying (${recent.length} exits inside ${HOLDER_CRASH_WINDOW_MS / 1000}s, last ${code ?? signal}) — ` +
          `standing down for ${Math.round(GIVE_UP_COOLOFF_MS / 60_000)}m`,
      );
      return;
    }
    holderCrashes.set(tenant, recent);
    log(`${tenant} hold process exited (${code ?? signal}) — the next pass tries the restore again`);
  };
  proc.on("error", (error: Error) => {
    if (proc.pid !== undefined) {
      log(`[alert] ${tenant}: hold process error with pid ${proc.pid} — ${error.message}; waiting for its exit`);
      return;
    }
    noteSpawnPressure(error);
    log(`${tenant}: hold process spawn failed (${spawnErrorCode(error)}): ${error.message}`);
    holderStopped(null, null);
  });
  proc.on("exit", holderStopped);
}

/**
 * Stand a held tenant down: stop its process, SIGTERM then SIGKILL, as
 * killChild does, and forget the tenant once that process is seen to exit.
 * Whoever calls this decides what comes next.
 *
 * NOT FORGOTTEN BEFORE THEN. A hold process told to stop goes on polling the
 * owner's bot and writing telegram.json in the home until it has exited, and
 * one stopped and resumed, or stuck in the kernel, outlives SIGKILL. This used
 * to forget the tenant on SIGTERM, which left it free for the next spawn to
 * start beside that process: once a grant was signed again or a halt lifted,
 * and after a lost lease in the very same pass, whose spawn loop takes the
 * lease again straight after this. So the entry stays, marked stood down, with
 * its process as `leaving`, as a handover's does; reconcile sends SIGKILL
 * again once a pass and says so once (pressLeaving), watchHolder drops the
 * entry on the exit, and nothing else is done for it meanwhile. A tenant with
 * no process has nothing to wait for, and goes now. A handover that was
 * waiting on its process is off.
 */
function standDownHolder(tenant: string): void {
  const held = holders.get(tenant);
  if (!held) return;
  held.handingBack = false;
  held.stoodDown = true;
  const proc = held.proc;
  if (proc) {
    // Its exit is a stand-down's now, never a crash's (watchHolder).
    held.proc = null;
    held.leaving = proc;
    held.leftAt = Date.now();
    held.leftBot = homeBotKey(tenant);
    try {
      proc.kill("SIGTERM");
    } catch (error) {
      log(`${tenant}: hold SIGTERM failed — ${error instanceof Error ? error.message : String(error)}; retrying SIGKILL`);
      try { proc.kill("SIGKILL"); } catch { /* retried below and by pressLeaving */ }
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, LEAVE_KILL_MS);
  }
  if (!held.leaving) holders.delete(tenant);
}

/**
 * WHEN A HELD TENANT'S RESTORE IS TRIED NEXT, after a failure of class `cls`.
 *
 * A class the book's own rules produced backs off, 2 minutes doubling to 30: a
 * book that broke stays broken until somebody fixes it, and trying every pass
 * is what filled the log before. A failure that names no rule of the book's
 * (UNCLASSIFIED_BLOCK: a dropped connection, a statement timeout) is tried
 * again about a pass later, doubling only to the named ladder's first rung.
 * Before holds, a blip at spawn cost one pass; it should not now cost two
 * minutes of a healthy book held, and a real outage still backs off.
 */
function scheduleHoldRetry(held: Holder, cls: string): void {
  if (isNamedBlock(cls)) {
    held.nextRetryAt = Date.now() + held.backoffMs;
    held.backoffMs = Math.min(HOLD_RETRY_MAX_MS, held.backoffMs * 2);
    held.quickMs = HOLD_RETRY_QUICK_MS;
  } else {
    held.nextRetryAt = Date.now() + held.quickMs;
    held.quickMs = Math.min(HOLD_RETRY_FIRST_MS, held.quickMs * 2);
  }
}

/**
 * May a held tenant leave the hold now? spawnChild asks all of this again; it
 * is asked first so that a hold process is not stopped for a spawn that would
 * refuse, which would leave the bot unanswered until the next pass.
 */
function holdMayLeave(tenant: `0x${string}`): boolean {
  if (accountingTenantHeld(tenant)) return false;
  const lease = leases.get(tenant);
  return !stopping && !haltRequested() && !retiringExpired.has(tenant) && !!lease && lease.healthy() && !killRequested(childHome(tenant));
}

/**
 * TRY A HELD TENANT'S RESTORE AGAIN, and hand it back to trading if it takes.
 *
 * On reconcile's clock, once its wait is up (scheduleHoldRetry). The restore
 * runs against the home's merrymen.db while the hold process keeps answering
 * the bot; the hold process never opens that file.
 *
 * False when it did not try at all (holdMayLeave said no: a lease blip, a
 * pending kill, FLEET_HALT), so reconcile does not count an owner's press as
 * looked at by an attempt that never happened.
 */
async function retryHold(held: Holder): Promise<boolean> {
  const tenant = held.tenant;
  if (!holdMayLeave(tenant)) return false;
  held.retrying = true;
  let restore: PaperRestore;
  let unsure = false;
  try {
    restore = await tryPaperRestore(tenant, held.smartAccount);
    // A PRACTICE RESET ITS OWNER ASKED FOR, now that the book has failed to
    // restore once more. When it is honoured the restore is asked again and
    // finds nothing to restore, so the tenant is handed back below exactly as
    // a restore that took is: the hold process stopped and awaited, then one
    // worker, whose spawn writes its anchor in the new epoch.
    if (!restore.ok && holders.get(tenant) === held) {
      const honour = await honourHeldPaperReset(tenant, held.smartAccount, leases.get(tenant));
      unsure = honour.transient;
      if (honour.applied) restore = await tryPaperRestore(tenant, held.smartAccount);
    }
  } finally {
    held.retrying = false;
  }
  if (holders.get(tenant) !== held || held.stoodDown) return true; // stood down while it ran
  if (!restore.ok) {
    const cls = restoreBlockClass(restore.reason);
    // A reset that could not be decided just then (its settings unreadable,
    // the lease blinking, the ledger failing) is asked about again at the pace
    // of a failure that names no cause, not at the end of a backoff that may
    // be half an hour: the owner pressed it and is waiting.
    scheduleHoldRetry(held, unsure ? UNCLASSIFIED_BLOCK : cls);
    // A new NAMED cause is what the hold process says from now on. A failure
    // that names none keeps the one the hold has: an owner told "trades newer
    // than the last valuation" is not then told "restore error" because the
    // database dropped a connection on one retry.
    if (isNamedBlock(cls) && cls !== held.cls) {
      const home = childHome(tenant);
      held.cls = cls;
      held.reason = restore.reason;
      writeRestoreBlocked(home, {
        reason: restore.reason,
        class: cls,
        since: readRestoreBlocked(home)?.since ?? Math.floor(Date.now() / 1000),
        resettable: held.resettable,
      });
    }
    noteHold(tenant, restore.reason, held.cls, held.resettable);
    return true;
  }
  const since = readRestoreBlocked(childHome(tenant))?.since;
  const heldFor = since ? ` after ${Math.max(1, Math.round((Date.now() / 1000 - since) / 60))}m held` : "";
  log(`paper restore: ${tenant} — ${restore.line ?? "restored"}${heldFor}; handing the bot back to trading`);
  await handHoldBack(held);
  return true;
}

/**
 * HAND A HELD TENANT BACK TO TRADING: its restore took (retryHold), or the
 * gate that held it no longer would (practice mode switched off; reconcile).
 *
 * THE HANDOVER, IN ORDER. The hold process is stopped and its exit awaited
 * BEFORE the worker is spawned, so the two never poll the bot at once (they
 * would take its updates from each other, 409 against 409). The tenant stays in
 * `holders` through that wait, so no pass spawns it meanwhile, and leaves it
 * only on the line that calls spawnChild, which claims `spawning` before it
 * awaits anything. That spawn restores again: after a retry it finds the book
 * it just wrote, "local book retained"; with practice off, the gate lets the
 * worker start as it always did.
 *
 * AND ONLY ONCE THAT EXIT HAS BEEN SEEN. A hold process still there ten
 * seconds after SIGTERM, and SIGKILL at three, is not gone because we stopped
 * waiting: stopped and resumed later, or stuck in the kernel, it goes on
 * polling the same bot and writing the same telegram.json, and a worker
 * started beside it would lose updates to it, meet 409 after 409, and have
 * its offsets written over. This used to start trading anyway. Now the tenant
 * stays held with that process in `leaving`, an [alert] names it once,
 * reconcile kills it again once a pass, and the first pass after its exit is
 * seen calls this again, which finds nothing left to stop and hands over.
 * Every other reader of `holders` leaves such a tenant alone meanwhile, and a
 * stand-down keeps it counted until the process goes (standDownHolder).
 */
async function handHoldBack(held: Holder): Promise<void> {
  const tenant = held.tenant;
  // Stood down: waiting only for its process to go, and then forgotten.
  if (held.stoodDown) return;
  // Kept out of every other pass while this runs, and from here on its way to
  // trading: no restore retried, no hold process started (reconcile).
  held.retrying = true;
  held.handingBack = true;
  try {
    const proc = held.proc;
    const exited = held.exited;
    if (proc) {
      // Its exit is a stand-down now, not a crash, and the one this waits for
      // (watchHolder, which clears `leaving`).
      held.proc = null;
      held.leaving = proc;
      held.leftAt = Date.now();
      held.leftBot = homeBotKey(tenant);
      proc.kill("SIGTERM");
      const hard = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, LEAVE_KILL_MS);
      let bound: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited ?? Promise.resolve(), new Promise<void>((r) => (bound = setTimeout(r, LEAVE_WAIT_MS)))]);
      clearTimeout(hard);
      clearTimeout(bound);
    }
  } finally {
    held.retrying = false;
  }
  // Said even for a tenant stood down while it waited: it stays counted until
  // this process goes (standDownHolder), and an operator should know why.
  const leaving = held.leaving;
  if (leaving) {
    if (held.leaveAlertedAt === null) {
      held.leaveAlertedAt = Date.now();
      log(
        `[alert] ${tenant}: its hold process (pid ${leaving.pid}) has not exited 10s after SIGTERM and SIGKILL — ` +
          `trading stays held until it has, as a worker beside it would poll the same bot; SIGKILL is sent again each pass`,
      );
    }
    return;
  }
  if (holders.get(tenant) !== held || !held.handingBack) return; // stood down while it stopped
  holders.delete(tenant);
  forgetHold(tenant);
  await spawnChild(tenant);
}

/** SIGKILL, again, to a hold process told to stop that has not gone (Holder.leaving). */
function killLeaving(held: Holder): void {
  try {
    held.leaving?.kill("SIGKILL");
  } catch {
    /* gone after all: its exit clears `leaving` */
  }
}

/**
 * The bot a process in this tenant's home would poll, as the pass's
 * de-duplication keys it (pollerKeyOf), or null: what the settings.json there
 * says, which is what a hold process reads, for every message (hold.ts).
 */
function homeBotKey(tenant: string): string | null {
  const settings = readChildSettings(tenant);
  return botWillPoll(settings) ? pollerKeyOf(botTokenOf(settings)!) : null;
}

/** After SIGTERM, when a hold process told to stop is sent SIGKILL, as killChild does. */
const LEAVE_KILL_MS = 3_000;
/** And how long after SIGTERM its exit is waited for: by a handover, and before a stand-down says it has not come. */
const LEAVE_WAIT_MS = 10_000;
/** While it still has not gone, how often that is said again. */
const LEAVE_REALERT_MS = 60 * 60_000;

/**
 * A HOLD PROCESS TOLD TO STOP THAT HAS NOT GONE, once a pass (Holder.leaving):
 * SIGKILL again, once the first is due, so a stand-down's process has its
 * three seconds to exit cleanly as it always had; and an [alert], once, when
 * it has been waited for as long as a handover waits. A handover says its own
 * when its wait ends (handHoldBack), so this says a stand-down's. Without it a
 * stood-down tenant whose process would not go stayed dark for good with
 * nothing in the log: nothing starts for it here meanwhile.
 *
 * AND AGAIN, HOURLY, for as long as it stays. One line at the start of a stall
 * that lasts for days is one line lost in a day of logs, while the tenant it
 * holds up (its trading, or its re-arm) waits on an operator the whole time.
 */
function pressLeaving(held: Holder): void {
  const leaving = held.leaving;
  if (!leaving) return;
  const now = Date.now();
  const waited = now - held.leftAt;
  if (waited >= LEAVE_KILL_MS) killLeaving(held);
  if (waited < LEAVE_WAIT_MS) return;
  if (held.leaveAlertedAt !== null) {
    if (now - held.leaveAlertedAt < LEAVE_REALERT_MS) return;
    held.leaveAlertedAt = now;
    log(
      `[alert] ${held.tenant}: its hold process (pid ${leaving.pid}) still has not exited, ${Math.round(waited / 60_000)}m after SIGTERM — ` +
        `${held.handingBack ? "trading stays held until it has" : "nothing starts for this tenant here until it has"}; SIGKILL is sent again each pass`,
    );
    return;
  }
  held.leaveAlertedAt = now;
  const lease = leases.has(held.tenant)
    ? "its lease is kept, so no other replica starts one either"
    : "its lease is gone, so another replica may";
  log(
    `[alert] ${held.tenant}: its hold process (pid ${leaving.pid}) has not exited ${Math.round(waited / 1000)}s after it was stood down ` +
      `with SIGTERM and SIGKILL — nothing starts for this tenant here until it has, as anything beside it would poll the same bot, ` +
      `and ${lease}; SIGKILL is sent again each pass`,
  );
}

/** The classes each held tenant's [alert] has named during this hold: each is said once, not every pass or every flip. */
const holdAlerted = new Map<string, Set<string>>();
/** The classes each held tenant's owner is known to have been told about during this hold, in this process. */
const holdNoticed = new Map<string, Set<string>>();
/** Tenants whose owner notice is being sent. One at a time each. */
const holdNoticeInFlight = new Set<string>();

/**
 * SAY A HOLD ONCE: one [alert] line per tenant per reason class, and one
 * message to the owner per NAMED class.
 *
 * The gate's FAILED line used to repeat every pass, about every 17 seconds per
 * blocked tenant, which buried it; an alert said once per class is one an
 * operator can grep for and act on. Once per class per hold, not "when the
 * class changes": a hold whose retries alternate between a cause and a
 * dropped connection would otherwise alert, and message its owner, on every
 * flip.
 *
 * `reason` is what this restore said, for the alert; `tell` is the hold's own
 * class, for the owner (see Holder.cls). An unclassified one is never sent:
 * it is what a database blip looks like, and a message saying the book could
 * not be restored would be false. The owner's message is tried on every failed
 * restore until it lands, and its dedupe is durable (notifyHoldOnce), so a
 * redeploy does not repeat it.
 */
function noteHold(tenant: `0x${string}`, reason: string, tell: string, resettable: boolean): void {
  const cls = restoreBlockClass(reason);
  const alerted = holdAlerted.get(tenant) ?? new Set<string>();
  holdAlerted.set(tenant, alerted);
  if (!alerted.has(cls)) {
    alerted.add(cls);
    log(`[alert] paper restore blocked: ${tenant} — ${cls}`);
    // The figures are the operator's, and only ever here.
    const pace = isNamedBlock(cls)
      ? `retried from ${HOLD_RETRY_FIRST_MS / 60_000}m, backing off to ${HOLD_RETRY_MAX_MS / 60_000}m`
      : `no rule of the book's named, so retried from ${HOLD_RETRY_QUICK_MS / 1000}s and the owner is not messaged`;
    log(`paper restore: ${tenant} FAILED — ${reason} (trading held; ${pace})`);
  }
  if (!isNamedBlock(tell) || holdNoticed.get(tenant)?.has(tell) || holdNoticeInFlight.has(tenant)) return;
  holdNoticeInFlight.add(tenant);
  void sendHoldNotice(tenant, tell, resettable)
    .then((outcome) => {
      if (outcome !== "sent" && outcome !== "told") return;
      const told = holdNoticed.get(tenant) ?? new Set<string>();
      told.add(tell);
      holdNoticed.set(tenant, told);
    })
    .catch((e) => log(`${tenant}: trading held, but the owner could not be told — ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => holdNoticeInFlight.delete(tenant));
}

/**
 * Tell the owner, through their own bot: notifyHoldOnce's rules (hold-notice.ts)
 * over Postgres, hostedRecipient, the stored allowlist and telegramSend. Only
 * the replica holding the tenant's lease gets here, so two replicas do not
 * both send.
 */
let sendHoldNotice = async (tenant: `0x${string}`, cls: string, resettable: boolean): Promise<HoldNoticeOutcome> => {
  const url = process.env.DATABASE_URL;
  if (!url) return "no-owner";
  try {
    const shared = await makePgDb(url);
    // The mirror's own sequence (it may not have run yet on a fresh deploy).
    // An ALTER that failed leaves no hold_notified, and notifyHoldOnce then
    // answers "failed" without sending.
    await ensureTelegramSchema(shared);
    return await notifyHoldOnce(
      {
        db: shared,
        recipient: hostedRecipient(shared),
        allowlist: async (t) => {
          const stored = await getSettingsStore().get(t);
          return Array.isArray(stored?.telegramAllowlist) ? stored.telegramAllowlist : [];
        },
        send: telegramSend(),
        log,
      },
      tenant,
      cls,
      resettable,
    );
  } catch (e) {
    log(`${tenant}: trading held, but the owner notice failed — ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
};

/** Test seam: take the owner notice instead of sending it. */
export function setHoldNoticeForTest(fn: (tenant: `0x${string}`, cls: string, resettable: boolean) => Promise<HoldNoticeOutcome>): void {
  sendHoldNotice = fn;
}

/**
 * The book restored: whatever this process remembered about a hold is
 * forgotten, and so is the durable notice, so the next hold is news again.
 * Called on every restore that works, not only after a hold this process saw:
 * a redeploy is the commonest way out of one, and it starts with no memory.
 */
function forgetHold(tenant: `0x${string}`): void {
  holdAlerted.delete(tenant);
  holdNoticed.delete(tenant);
  heldResetSaid.delete(tenant);
  holderCrashes.delete(tenant);
  clearRestoreBlocked(childHome(tenant));
  const url = process.env.DATABASE_URL;
  if (!url) return;
  void makePgDb(url)
    .then((db) => clearHoldNotified(db, tenant))
    .catch(() => {
      /* the column is added on the mirror's clock; a missing one has nothing to clear */
    });
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
 * does mark the exit as intentional — and an intentional exit schedules
 * nothing. Whoever called this decides whether the tenant comes back. Until
 * the handler returned on an entry that was not its own, it still scheduled a
 * restart here, and that restart was refused only because `releaseLease`
 * happened to win the race against the handler's 1s timer.
 */
function killChild(tenant: string): void {
  const child = children.get(tenant);
  if (!child) return;
  trackExitingChild(tenant, child.proc);
  children.delete(tenant); // delete first so the exit handler treats it as intentional
  try {
    child.proc.kill("SIGTERM");
  } catch (error) {
    log(`${tenant}: child SIGTERM failed — ${error instanceof Error ? error.message : String(error)}; retrying SIGKILL`);
    try { child.proc.kill("SIGKILL"); } catch { /* retried below */ }
  }
  setTimeout(() => {
    try {
      child.proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, 3_000);
}

let retirementMirrorForTest: ((tenant: string) => Promise<boolean>) | null = null;

/** Test seam for a failed or delayed final mirror, without a production database. */
export function setRetirementMirrorForTest(fn: ((tenant: string) => Promise<boolean>) | null): void {
  retirementMirrorForTest = fn;
}

/** A stopped worker's local ledger must be durable before its expiry barrier can leave. */
async function mirrorRetiredWorker(tenant: string, lease: TenantLease): Promise<boolean> {
  if (retirementMirrorForTest) return retirementMirrorForTest(tenant);
  const file = path.join(childHome(tenant), "merrymen.db");
  if (!existsSync(file)) return true;
  const url = process.env.DATABASE_URL;
  // A file-only deployment keeps this home as its ledger. There is no shared
  // destination to copy to, and expiry never deletes the home.
  if (!url) return true;
  const handle = openChildLedger(childHome(tenant));
  if (!handle) {
    log(`[alert] ${tenant}: expired worker's ledger exists but cannot be opened; retaining its lease and home`);
    return false;
  }
  try {
    const shared = await makePgDb(url);
    await applyLedgerSchema(shared);
    await shared.exec(translateSchema(MIRROR_STATE_DDL));
    try { await shared.exec("ALTER TABLE mirror_state ADD COLUMN last_stamp INTEGER"); } catch { /* already present */ }
    if (leases.get(tenant) !== lease || !lease.healthy()) return false;
    const r = await mirrorSerially(tenant, () => mirrorTenant({ tenant, child: handle.db, shared }));
    if (r.failed) {
      log(`[alert] ${tenant}: expired worker's final mirror stalled — ${Object.entries(r.failed).map(([table, why]) => `${table}: ${why}`).join(" | ")}; retaining its lease and home`);
      return false;
    }
    if (r.hasMore) {
      log(`${tenant}: expired worker's final mirror has another source batch; retaining its lease for the next pass`);
      return false;
    }
    const counts = mirrorCountsLine(tenant, r);
    if (counts) log(`${counts} (expired worker's final pass)`);
    return true;
  } catch (error) {
    log(`[alert] ${tenant}: expired worker's final mirror failed — ${error instanceof Error ? error.message : String(error)}; retaining its lease and home`);
    return false;
  } finally {
    handle.close();
  }
}

/** Stop expired processes, then wait for exit and a complete final ledger copy. */
async function retireExpiredGrants(
  tenants: readonly `0x${string}`[],
  expiries: Map<string, number | null>,
  nowSec: number,
): Promise<void> {
  for (const tenant of tenants) {
    const lc = tenant.toLowerCase() as `0x${string}`;
    const expiry = expiries.get(lc);
    if (typeof expiry === "number" && Number.isFinite(expiry) && expiry > nowSec) continue;
    if (!children.has(lc) && !holders.has(lc) && !exitingChildren.has(lc) && !spawning.has(lc) && !restartPending.has(lc) && !leases.has(lc)) continue;
    // A re-sign may have landed since listTenantExpiries. Do not retire that
    // fresh grant just because the roster snapshot was old.
    try {
      const latest = (await getGrantStore().get(lc))?.expiresAt;
      if (typeof latest === "number" && Number.isFinite(latest) && latest > nowSec) {
        expiries.set(lc, latest);
        continue;
      }
    } catch (error) {
      log(`${lc}: expiry recheck failed — ${error instanceof Error ? error.message : String(error)}; standing down on the expired roster`);
    }
    if (!retiringExpired.has(lc)) {
      // A held practice book may leave a sqlite file from the worker that
      // preceded the hold. Its restore failed, so copying its snapshots here
      // could erase the durable book. The hold marker survives a bot crash.
      const wasHeld = holders.has(lc) || readRestoreBlocked(childHome(lc)) !== null;
      retiringExpired.set(lc, {
        mirror: children.has(lc) || exitingChildren.has(lc) || (!wasHeld && existsSync(path.join(childHome(lc), "merrymen.db"))),
        lease: leases.get(lc) ?? null,
      });
      log(`${lc}: signed grant expired — retiring its process before freeing capacity; grant and home remain stored`);
    }
    cancelRestart(lc);
    killChild(lc);
    standDownHolder(lc);
  }

  for (const [tenant, retirement] of [...retiringExpired]) {
    cancelRestart(tenant);
    // Even a re-sign in the middle of retirement cannot start in this home.
    // Wait for the old process and any preparing spawn to finish first.
    if (children.has(tenant)) killChild(tenant);
    if (holders.has(tenant)) standDownHolder(tenant);
    if (children.has(tenant) || exitingChildren.has(tenant) || spawning.has(tenant) || holders.has(tenant)) continue;
    const lease = leases.get(tenant);
    if (retirement.mirror) {
      if (!lease || lease !== retirement.lease || !lease.healthy()) {
        log(`[alert] ${tenant}: expired worker's lease unavailable before its final mirror; keeping the local re-arm barrier`);
        continue;
      }
      if (!(await mirrorRetiredWorker(tenant, lease))) continue;
      if (leases.get(tenant) !== lease || !lease.healthy()) continue;
    }
    if (lease && lease !== retirement.lease) continue;
    await releaseLease(tenant);
    retiringExpired.delete(tenant);
    log(`${tenant}: expired process exited and final mirror pass completed — capacity released; stored grant can be re-signed`);
  }
}

/**
 * A shard session losing its socket releases all its Postgres locks at once.
 * Signal every affected process in the same event turn, not up to one reconcile
 * interval later. A local child that has not exited remains a spawn barrier even
 * if a fresh DB session can already take a new lock. Another replica cannot see
 * that barrier; execution-side fencing is needed to eliminate that last gap.
 */
function standDownLostLeasesNow(): void {
  for (const [tenant, lease] of [...leases]) {
    if (lease.healthy()) continue;
    log(`${tenant}: lease lost (connection dropped) — standing the child down until it can be re-leased`);
    const child = children.get(tenant);
    if (child || exitingChildren.has(tenant)) leaseLossDraining.add(tenant);
    try {
      if (child) killChild(tenant);
      standDownHolder(tenant);
      cancelRestart(tenant);
      void releaseLease(tenant);
    } catch (error) {
      // One process refusing a signal must not leave the other tenants on this
      // lost shard running. Keep this lease unhealthy for reconcile to retry.
      log(`${tenant}: lease-loss stand-down failed — ${error instanceof Error ? error.message : String(error)}`);
      try { child?.proc.kill("SIGKILL"); } catch { /* retry on reconcile */ }
      try { holders.get(tenant)?.leaving?.kill("SIGKILL"); } catch { /* retry on reconcile */ }
    }
  }
}

/** Test seam for the same handler registered on the production lease socket. */
export { standDownLostLeasesNow as standDownLostLeasesForTest };

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
    // AND ITS STORED GROUP MEMORY, now rather than when a reconcile next
    // finds its child here: the kill may be carried out by the order ferry or
    // on shutdown, with no child here to stand down. Only the one call whose
    // DELETE removed the grant gets here. A row a still-running child
    // republishes before it is stood down goes on the next pass (sweepTgGroups).
    await forgetTgGroups(tenant);
  }
  if (k.outcome === "superseded") log(`${tenant}: a grant signed after the Telegram kill replaces it — arming that one`);
  if (k.outcome === "failed") log(`${tenant}: Telegram kill pending, could not remove the grant yet (${k.error}) — nothing arms meanwhile`);
  return k;
}

/** Every tenant with a home on this container's disk, whether or not its child is running. */
function childHomeTenants(): `0x${string}`[] {
  let names: string[];
  try {
    names = readdirSync(path.join(merrymenHome(), "children"));
  } catch {
    return [];
  }
  return names.filter((n): n is `0x${string}` => /^0x[0-9a-f]{40}$/.test(n));
}

/**
 * Every child home holding a pending request, whether or not its child is
 * running. Read from the disk rather than the children map, so a kill left
 * by a child that has since crashed is not missed.
 */
function pendingKillTenants(): `0x${string}`[] {
  return childHomeTenants().filter((n) => killRequested(childHome(n)));
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

/** Bring the running set in line with the store: spawn new tenants, stop killed ones. */
export async function reconcile(): Promise<void> {
  if (stopping) return;
  // The socket handler normally does this immediately. Its retry path must
  // also run before remote reads: a broken grant-store connection cannot keep
  // a child whose lease was lost alive indefinitely.
  standDownLostLeasesNow();
  const accountingHolds = accountingHoldTenants(process.env);
  const store = getGrantStore();
  let tenants: `0x${string}`[];
  let expiresAtByTenant: Map<string, number | null>;
  // Before the listing is asked for: the group-memory sweep below judges only
  // rows written before this, never one a newer grant's child has published.
  const listedAtMs = Date.now();
  try {
    const roster = store.listTenantExpiries
      ? await store.listTenantExpiries()
      : await Promise.all((await store.listTenants()).map(async (tenant) => ({
          tenant,
          expiresAt: (await store.get(tenant))?.expiresAt ?? null,
        })));
    tenants = roster.map((entry) => entry.tenant);
    expiresAtByTenant = new Map(roster.map((entry) => [entry.tenant.toLowerCase(), entry.expiresAt]));
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
  // Remain wanted: a maintenance hold must not revoke the grant or wipe its
  // home. A fresh held deployment starts no process for these tenants. Also
  // stand down a local incarnation if a hold is introduced during a test or
  // by an in-process operator; its retained state will refuse repair commit.
  for (const tenant of accountingHolds) {
    cancelRestart(tenant);
    killChild(tenant);
    standDownHolder(tenant);
  }
  await retireExpiredGrants(tenants, expiresAtByTenant, nowSec);
  // A stored but expired key is still wanted for revocation, home and Telegram
  // memory cleanup. It cannot sign another operation, so it does not need an
  // OS worker. The worker enforces this same expiry when it arms; the fetched
  // grant is checked again in spawnChild after this roster snapshot.
  const eligibleToSpawn = tenants.filter((tenant) => {
    const expiry = expiresAtByTenant.get(tenant.toLowerCase());
    return typeof expiry === "number" && Number.isFinite(expiry) && expiry > nowSec;
  });
  const eligible = new Set(eligibleToSpawn.map((tenant) => tenant.toLowerCase()));
  const expiredCount = tenants.length - eligibleToSpawn.length;
  if (!lastRosterLog || lastRosterLog.active !== eligibleToSpawn.length || lastRosterLog.expired !== expiredCount || Date.now() - lastRosterLog.at > 5 * 60_000) {
    log(`grant roster: ${eligibleToSpawn.length} unexpired, ${expiredCount} expired or unreadable; only unexpired keys may consume worker processes`);
    lastRosterLog = { active: eligibleToSpawn.length, expired: expiredCount, at: Date.now() };
  }

  // A lease whose connection dropped no longer protects its tenant — Postgres
  // has released the lock and another replica may hold it. Stand the child down
  // and drop the lease; the acquire below will try to re-take it (or find the
  // other replica now owns it). This is what makes the lock a live guarantee and
  // not just a start-time check.
  standDownLostLeasesNow();

  // Spawn any wanted tenant that isn't running — but only behind a lease. Acquire
  // one first (unless we already hold it from a previous reconcile / across a
  // crash restart); if another replica holds it, skip this tenant and try again
  // next reconcile.
  let capacityDeferred = 0;
  for (const tenant of eligibleToSpawn) {
    const lc = tenant.toLowerCase() as `0x${string}`;
    if (accountingHolds.has(lc)) continue;
    if (retiringExpired.has(lc) || leaseLossDraining.has(lc) || exitingChildren.has(lc)) continue;
    // A spawn still preparing is a child about to be running, not one that
    // isn't: a restart timer, usually, got here first. See `spawning`. And a
    // restart already scheduled is the timer's to make, on its rung, not this
    // loop's at rung 0. See `restartPending`.
    flagStuckSpawn(lc);
    if (children.has(lc) || spawning.has(lc) || restartPending.has(lc)) continue;
    // A HELD TENANT IS NOT A TENANT THAT ISN'T RUNNING EITHER. Its restore
    // failed and its bot is being answered; spawning it here would only fail
    // the same restore every pass, which is what it used to do, every 17
    // seconds. Its restore is retried below, on a backoff, and a crashed hold
    // process leaves the map, so this loop picks it up again. See spawnHolder.
    // Nor is one whose hold process was told to stop and has not gone, handed
    // over or stood down: it may still be polling the bot (handHoldBack).
    if (holders.has(lc)) continue;
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
    if (localChildProcessCount() >= MAX_LOCAL_CHILD_PROCESSES) {
      capacityDeferred += 1;
      // A tenant that cannot run here must not keep a lease that would keep
      // another replica with free capacity from taking it.
      await releaseLease(lc);
      continue;
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
  if (capacityDeferred > 0 && (!lastCapacityLog || lastCapacityLog.deferred !== capacityDeferred || Date.now() - lastCapacityLog.at > 60_000)) {
    log(`[alert] local process cap ${MAX_LOCAL_CHILD_PROCESSES} reached: ${capacityDeferred} unexpired grants deferred; capacity review required`);
    lastCapacityLog = { deferred: capacityDeferred, at: Date.now() };
  } else if (capacityDeferred === 0) {
    lastCapacityLog = null;
  }
  // HELD TENANTS WHOSE RESTORE IS DUE AGAIN, and the handover to trading when
  // it takes. See retryHold.
  //
  // AND ANY WHOSE OWNER HAS JUST ASKED FOR A PRACTICE RESET, whatever its
  // backoff says. The hold's own reply tells the owner to press it, and a
  // book that has been broken for days waits thirty minutes between retries:
  // the press would sit that long before retryHold honoured it. Each queued
  // row brings one retry forward, once (`resetSeen`), so a reset that is
  // refused does not put the restore back on every pass. Counted only once
  // the retry has really run: one that holdMayLeave turned away looked at
  // nothing, and the press is still owed its early look on the next pass.
  const asked = await heldResetsAsked([...holders.values()].filter((h) => eligible.has(h.tenant) && !retiringExpired.has(h.tenant)).map((h) => h.smartAccount));
  for (const held of [...holders.values()]) {
    if (accountingHolds.has(held.tenant)) { pressLeaving(held); continue; }
    // A HOLD PROCESS TOLD TO STOP THAT HAS NOT GONE, by a handover or a
    // stand-down: killed again, once a pass, and nothing else done for its
    // tenant, stood down or not, until its exit is seen.
    if (held.leaving) {
      pressLeaving(held);
      continue;
    }
    // AND ONCE IT HAS, THE HANDOVER IT HELD UP. Decided already: the restore
    // took, or the gate let the tenant go, and spawnChild asks both again.
    if (held.handingBack) {
      if (!eligible.has(held.tenant) || retiringExpired.has(held.tenant) || held.retrying || !holdMayLeave(held.tenant)) continue;
      log(`${held.tenant}: its hold process has gone — handing the bot back to trading`);
      await handHoldBack(held);
      continue;
    }
    const ask = asked.get(held.smartAccount);
    const early = ask !== undefined && ask !== held.resetSeen;
    if (!eligible.has(held.tenant) || retiringExpired.has(held.tenant) || held.retrying || (!early && Date.now() < held.nextRetryAt)) continue;
    if ((await retryHold(held)) && early) held.resetSeen = ask;
  }
  // Refresh every running child's settings.json so a tenant's config change
  // reaches it (the worker re-reads settings.json each tick). Cheap: one small
  // file per tenant, replaced atomically only when it changed. Each bot goes
  // to the tenant its claim names, and the pass's own seenBots map (the token's
  // fingerprint → the tenant polling it) keeps a bot no claim names to one
  // poller per token (see gateBot in writeSettingsForChild, and claimGate).
  const seenBots = new Map<string, string>();
  // Every holder claim in one read for the whole fleet, not one per tenant.
  const holderClaims = await readHolderClaims();
  // And every bot claim, the same way.
  const botClaims = await readBotClaimsForPass();
  // A HOLD PROCESS THIS PASS DOES NOT REFRESH MAY STILL BE POLLING ITS BOT:
  // one told to stop that has not exited (`leaving`), stood down or signed
  // again meanwhile, and one stood down below this pass because its grant is
  // gone. Neither is written a settings.json here, so neither entered this
  // record, and another tenant on the same token was handed it beside a
  // process that may poll on. Each counts, for its own tenant, until its exit
  // is seen. A claim still decides first (claimGate): this is the guard for a
  // bot no claim names, and the only one while the claims cannot be read.
  for (const [tenant, held] of holders) {
    const bot = held.leaving ? held.leftBot : held.proc && !wanted.has(tenant) ? homeBotKey(tenant) : null;
    if (bot && !seenBots.has(bot)) seenBots.set(bot, tenant);
  }
  // HELD TENANTS FIRST, and with the same refresh: a chat the owner removes on
  // the dashboard, or a token they change, must reach the hold process as it
  // would a worker, and a held tenant's bot token is as much in use as a
  // trading one's, so the claims must be asked about it.
  // (A held tenant with Telegram off claims nothing: see claimGate.)
  //
  // WHO CLAIMS A BOT NOBODY HAS CLAIMED IS MOSTLY DECIDED BEFORE THIS. After a
  // restart or a deploy nothing is running and no hold exists: every tenant,
  // held ones included, comes through the spawn loop above, in listTenants
  // order, and a spawn claims such a bot only for a tenant whose owner has
  // linked a chat (gateBot). The rest meet it here. Holders going first only
  // orders the tenants judged here: two unlinked tenants on one bot, a linked
  // one whose token Telegram refused at its spawn, or a bot first saved while
  // a hold was running. (A linked one Telegram gave no answer for is waited
  // for, up to LINKED_CLAIM_WAIT_MS: see gateBot.) So the operator's step
  // before the deploy that brings claims stays: claim each bot two tenants
  // share for its owner's tenant by hand. It is the only answer when both are
  // linked, or when Telegram gives no answer for longer than that wait.
  const released: Holder[] = [];
  for (const [tenant, held] of [...holders]) {
    // NOT WANTED ANY MORE, and stood down below, this pass: its settings are
    // not refreshed, its token claims no bot beyond what its process may
    // still be polling (counted above), and no hold process is started only
    // to be killed a few lines later in a home that is about to be wiped.
    if (!eligible.has(tenant) || retiringExpired.has(tenant)) continue;
    // STOOD DOWN, waiting only for a process that would not go: its lease is
    // gone, the fleet halted or its grant removed, so nothing is ours to write
    // or claim for it beyond the bot that process reads (counted above).
    if (held.stoodDown) continue;
    const stored = await writeSettingsForChild(tenant as `0x${string}`, seenBots, holderClaims, botClaims);
    await refreshGrantForChild(tenant as `0x${string}`);
    // On its way to trading, and still counted for its bot above: the process
    // that answered it may be polling yet, and the worker will. Not released
    // twice, and never given a second hold process (handHoldBack).
    if (holders.get(tenant) !== held || held.retrying || held.handingBack) continue;
    /**
     * THE GATE, ASKED AGAIN. spawnChild holds a tenant only while its stored
     * settings say practice (`paperTradingEnabled === true`), and before holds
     * it asked that every pass: an owner who switched practice off had a
     * worker on the next one. A hold must not outlive its reason, or whether a
     * now-live owner can trade would depend on how long this process has been
     * up, and their bot would go on saying their practice book is broken.
     * Handed back below, after the children's refresh. Unreadable settings
     * (null) keep the hold: holding trades nothing, and the next pass asks again.
     */
    if (stored && stored.paperTradingEnabled !== true) {
      released.push(held);
      continue;
    }
    // AND WHETHER THE PRACTICE RESET IS OFFERED, which the same settings
    // decide: an owner who switches live trading off beside practice is told
    // of the way out from their next message, and one who switches it on is
    // no longer sent towards a reset that would be refused. See keepResetOffer.
    if (stored) keepResetOffer(held, stored);
    // Held with no bot, and now there is one: the owner has just switched
    // Telegram on, or its spawn left a bot nobody had claimed to this refresh
    // (gateBot). Answer it from this pass, not from the next failed restore.
    const lease = leases.get(tenant);
    if (held.proc || !lease || !holderBotReady(stored)) continue;
    const late = lateSpawnRefusal(tenant as `0x${string}`, lease);
    if (late) continue;
    await startHolderProcess(held);
  }
  for (const tenant of children.keys()) {
    await writeSettingsForChild(tenant as `0x${string}`, seenBots, holderClaims, botClaims);
    // AND THEIR GRANT, for the same reason and on the same clock. Settings
    // reached a live agent in fifteen seconds while a new SIGNATURE reached it
    // only on a restart — so an owner who re-signed to cover a token watched
    // their agent keep refusing it. See refreshGrantForChild.
    await refreshGrantForChild(tenant as `0x${string}`);
    // AND ITS ENERGY HISTORY, if the seed before it armed could not put it
    // back: until then its store reads those days as unreadable.
    await retryEnergySeed(tenant as `0x${string}`);
  }
  // HELD TENANTS THE GATE NO LONGER HOLDS, handed back to trading. After the
  // children's refresh and not inside the holders' loop, so the worker each
  // one becomes is judged for its bot once, at its own spawn (gateBot), against
  // the claim its hold made. (This once also kept its own hold's entry in the
  // pass's de-duplication from reading its token as taken; seenBots names the
  // tenant polling each token now, so a tenant is never stripped by itself.)
  for (const held of released) {
    if (holders.get(held.tenant) !== held || held.retrying || !holdMayLeave(held.tenant)) continue;
    log(`${held.tenant}: practice mode is off, so trading is no longer held — handing the bot back to trading`);
    await handHoldBack(held);
  }
  // Stop (and forget) any running child whose grant is gone — the kill switch.
  for (const tenant of [...children.keys()]) {
    if (!wanted.has(tenant)) {
      log(`${tenant} grant removed — standing it down`);
      killChild(tenant);
      try {
        rmSync(childHome(tenant), { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
      // AND THE SEALED COPY OF ITS TELEGRAM GROUPS, which would otherwise
      // outlive the home it came from. See forgetTgGroups.
      await forgetTgGroups(tenant);
    }
  }
  // AND ANY HELD TENANT'S, the same way: its hold process stopped and its home
  // wiped. A Telegram /kill sent to a hold process lands here too, once the
  // order ferry has carried it to the store. Never mirrored first: a held
  // book is exactly the one the mirror must not copy (see `holders`).
  for (const [tenant, held] of [...holders]) {
    if (wanted.has(tenant)) continue;
    // Stood down on an earlier pass, and still counted only until the process
    // it could not stop has gone (standDownHolder): done already, home and all
    // when it was this. A lease or halt stand-down's home is wiped below.
    if (held.stoodDown) continue;
    log(`${tenant} grant removed — standing its hold down`);
    standDownHolder(tenant);
    holdAlerted.delete(tenant);
    holdNoticed.delete(tenant);
    try {
      rmSync(childHome(tenant), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    // AND ITS TELEGRAM GROUPS, sealed copy and all, as for a child: a hold
    // keeps the group memory (it is never published or restored while held),
    // but the grant going takes it. See forgetTgGroups.
    await forgetTgGroups(tenant);
  }
  /**
   * AND EVERY OTHER HOME OF A TENANT NO LONGER WANTED, running or not.
   *
   * The loop above reaches only a child in `children`, and a tenant can be
   * stood down with a home but no entry. A kill or a DELETE /api/grants that
   * lands while spawnChild is preparing is refused at the last moment
   * (lateSpawnRefusal) — after grant.json, settings.json with the bot token,
   * the anchor and the restored book have been written. A child that crashed
   * and was waiting on its restart timer, or was stood down by the restart
   * policy, is not in `children` either. Those homes kept the revoked session
   * key and the kill request until the container was replaced, and a grant
   * signed later armed on top of them rather than on a fresh home —
   * kill-request.ts promises that "the reconcile that follows wipes the whole
   * home". A spawn still preparing is left alone: it is about to find the
   * grant or the lease gone and refuse, and the next pass wipes what it wrote.
   *
   * ITS LEDGER GOES UP FIRST, when this replica still holds the tenant. No
   * child is running on it, so its sqlite is still — but a child that crashed
   * after the last mirror pass left rows in it that are nowhere else, and the
   * spawn that would have carried them up (finalMirrorBeforeAnchor) is not
   * coming. Without the lease it is not ours to write: another replica may
   * have run the tenant since. A failed copy is logged and the home is wiped
   * regardless, as the spawn path derives its anchor regardless.
   */
  for (const tenant of childHomeTenants()) {
    if (wanted.has(tenant) || children.has(tenant) || spawning.has(tenant) || retiringExpired.has(tenant) || exitingChildren.has(tenant) || holders.has(tenant)) continue;
    // Before the await, so no restart timer can start a spawn in this home
    // while its ledger is being read.
    cancelRestart(tenant);
    const url = process.env.DATABASE_URL;
    // Never a held book (see `holders`): a stood-down one whose process has
    // not exited still has the lease it kept, and its home may reach here.
    if (url && leases.get(tenant)?.healthy() && !holders.has(tenant)) {
      try {
        await finalMirrorBeforeAnchor(tenant, await makePgDb(url));
      } catch (e) {
        log(`${tenant}: last mirror before wiping its home failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (children.has(tenant) || spawning.has(tenant) || retiringExpired.has(tenant) || exitingChildren.has(tenant) || holders.has(tenant)) continue;
    log(`${tenant} grant removed — wiping the home it left with no child running`);
    try {
      rmSync(childHome(tenant), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  // AND EVERY OTHER TENANT'S WHOSE GRANT IS GONE, running here or not: the
  // branch above reaches only a child running on this replica right now. The
  // listing succeeded (an unreadable store returned above), so `wanted` is
  // the fleet's. See sweepTgGroups.
  await sweepTgGroups(wanted, listedAtMs);
  // Release any lease we still hold for a tenant that is no longer wanted — both
  // the kill-switch case above and a lease left over from a child that has since
  // exited. Holding a lease for a tenant we won't arm would block another replica
  // (or a later re-arm) for no reason.
  //
  // EXCEPT WHILE ITS HOLD PROCESS HAS NOT EXITED. That process may still poll
  // the bot, and this replica starts nothing beside it (standDownHolder); the
  // lease is what stops another replica, in a deploy overlap say, from arming
  // a grant signed again beside it. It goes when the exit does (watchHolder).
  for (const tenant of [...leases.keys()]) {
    if (!wanted.has(tenant) && !retiringExpired.has(tenant) && !exitingChildren.has(tenant) && !holders.get(tenant)?.leaving) await releaseLease(tenant);
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
export const AUTONOMY_TRADE_FUNNEL_SQL = `SELECT status, COALESCE(reject_rule, '') AS rule, COUNT(*) AS n
  FROM trades WHERE created_at >= ? GROUP BY status, rule`;

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
        .prepare(AUTONOMY_TRADE_FUNNEL_SQL)
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
 * THREE KEYS, DELIBERATELY. `MERRYMEN_ANNOUNCE_ID` arms a DRY RUN, which resolves
 * every recipient, builds every message and contacts Telegram zero times.
 * Sending additionally requires `MERRYMEN_ANNOUNCE_CONFIRM` to equal that same
 * id AND `MERRYMEN_ANNOUNCE_BODY_SHA256` to equal the dry-run payload digest.
 * A changed file cannot turn an earlier approval into a different message.
 *
 * SAFE TO LEAVE SET. This runs on the reconcile loop and Railway restarts
 * services freely. `runAnnouncement` claims each recipient durably before
 * sending, so a redeploy cannot replay a send whose result was uncertain.
 * The body ships in the repo because there is no other way to hand this
 * process a file.
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
      // The energy reserve, so an agent's energy purchase reads `reserve-out`
      // (capital that left the book, which the worker lowered the peak for)
      // rather than a trade — otherwise the derived peak is too high by every
      // purchase and this repair is a no-op exactly when one went unbooked.
      reserveTokens: energyReserveTokens(Number(process.env.MERRYMEN_CHAIN_ID ?? 4663)),
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
      let reservePurchases = 0;
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
        reservePurchases += Number(BigInt(c.totals.grossReservePurchasesRaw)) / 1e6;
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
        reservePurchasesUsdg: reservePurchases,
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

/**
 * CLAIM THE PROOFS LINKED BEFORE CLAIMS EXISTED — once EVER, not once per process.
 *
 * effectiveHolder counts no unclaimed proof, so until this runs every holder
 * who linked a wallet reads their login wallet instead. It runs BEFORE
 * reconcile() on the first pass, so the first settings.json each child is
 * handed already counts the right wallet. Earliest proof wins a shared wallet
 * (planHolderBackfill); collisions are logged by name.
 *
 * ONCE EVER, BY A RECORD IN THE CLAIMS STORE (backfillHolderClaims). Re-run
 * at every start, it handed a wallet released on purpose back to a stale
 * collision loser at the next deploy. After a start that read every tenant
 * this is a no-op for good; `holderClaimsBackfilled` only spares later passes
 * of this process the store read.
 *
 * RETRIED ONLY WHILE TENANTS WERE UNREADABLE, and then only those tenants,
 * every HOLDER_BACKFILL_RETRY_MS — not every pass, or one blob that never
 * decrypts would re-log itself every 15 s for ever. A failed run (the store
 * or the lease unreachable) is retried next pass, as before.
 *
 * BEHIND A LEASE, the tenant-lease advisory lock on a fixed key that is not an
 * address, so it can never be a tenant's: one replica backfills at a time. A
 * replica that finds the lease taken simply tries again next pass and finds
 * the record written. A failure is loud; it never blocks the fleet from arming.
 */
let holderClaimsBackfilled = false;
let holderBackfillRetryAt = 0;
const HOLDER_BACKFILL_RETRY_MS = 10 * 60_000;
const HOLDER_BACKFILL_LEASE = "0xholder-claims-backfill" as const;

async function runHolderClaimsBackfill(): Promise<void> {
  if (holderClaimsBackfilled || Date.now() < holderBackfillRetryAt) return;
  let lease: TenantLease | null;
  try {
    lease = await acquireTenantLease(HOLDER_BACKFILL_LEASE);
  } catch (e) {
    log(`holder claims backfill: lease attempt failed, trying again next pass — ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!lease) {
    log("holder claims backfill: another replica holds its lease — trying again next pass");
    return;
  }
  try {
    const out = await backfillHolderClaims(getSettingsStore(), log);
    if (out.done) holderClaimsBackfilled = true;
    else holderBackfillRetryAt = Date.now() + HOLDER_BACKFILL_RETRY_MS;
    if (!out.alreadyDone) {
      log(
        `holder claims backfill: ${out.claimed} claimed, ${out.held} already held, ` +
          `${out.collisions.length} collision(s), ${out.unreadable.length} tenant(s) unreadable` +
          (out.done ? " — done for good" : " — only those are read again, in 10 min"),
      );
    }
  } catch (e) {
    log(`holder claims backfill: FAILED, trying again next pass — ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await lease.release();
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
    const { announcementConfirmation, illegalTags, RECOVERY_ANNOUNCE_ID, runAnnouncement } = await import("./announce");
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
      const payload = perAgent ? JSON.stringify(Object.entries(bodies).sort(([a], [b]) => a.localeCompare(b))) : body;
      const { confirmed, bodySha256 } = announcementConfirmation(
        id, payload, (process.env.MERRYMEN_ANNOUNCE_CONFIRM ?? "").trim(),
        (process.env.MERRYMEN_ANNOUNCE_BODY_SHA256 ?? "").trim(),
      );
      log(`announcement ${id}: payload SHA-256 ${bodySha256} — confirm this exact digest before sending`);
      const out = await runAnnouncement({
        client,
        announceId: id,
        body,
        confirmed,
        appendPersonalLine: id !== RECOVERY_ANNOUNCE_ID,
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
          `${out.skippedNotAllowed} no longer linked, ${out.skippedNoClaim} bot unclaimed/moved, ` +
          `${out.skippedAlreadySent} already delivered, ${out.skippedAlreadyAttempted} already attempted, ${out.skippedChanged} changed before send · ${out.failed.length} failed`,
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
      if (out.dryRun) log(`announcement ${id}: to send, set MERRYMEN_ANNOUNCE_CONFIRM=${id} and MERRYMEN_ANNOUNCE_BODY_SHA256=${bodySha256}`);
    } finally {
      await client.end();
    }
  } catch (e) {
    // The message only. A pg or fetch error object can carry request context,
    // and in this process that context can include a bot token.
    log(`announcement ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** One Shogun-approved Merrymen room, dry-run unless campaign and exact chat id are confirmed. */
async function runTgGroupRecoveryNoticeIfAsked(): Promise<void> {
  const id = (process.env.MERRYMEN_TG_RECOVERY_ID ?? "").trim();
  if (!id) return;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    log("tg recovery notice: invalid campaign id — refusing");
    return;
  }
  if (!process.env.DATABASE_URL || !process.env.MERRYMEN_STORE_DEK) {
    log("tg recovery notice: hosted database or store key missing — refusing");
    return;
  }
  const rawChatId = (process.env.MERRYMEN_TG_RECOVERY_CHAT_ID ?? "").trim();
  if (rawChatId && !/^-\d+$/.test(rawChatId)) {
    log("tg recovery notice: chat id is not an exact negative number — refusing");
    return;
  }
  const chatId = rawChatId ? Number(rawChatId) : null;
  if (chatId !== null && !Number.isSafeInteger(chatId)) {
    log("tg recovery notice: chat id is outside the safe integer range — refusing");
    return;
  }
  try {
    const { readFileSync } = await import("node:fs");
    const { runTgGroupRecoveryNotice } = await import("./tg-group-recovery-notice");
    const body = readFileSync(path.resolve(ROOT, "docs/announcements", `tg-group-${id}.html`), "utf8");
    // @ts-expect-error pg is runtime-only here, as in announce-cli.ts
    const pg = (await import("pg")) as unknown as {
      Client: new (c: { connectionString: string }) => {
        query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
        connect(): Promise<void>;
        end(): Promise<void>;
      };
    };
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const out = await runTgGroupRecoveryNotice({
        client, campaignId: id, body, selectedChatId: chatId,
        confirmCampaignId: (process.env.MERRYMEN_TG_RECOVERY_CONFIRM ?? "").trim(),
        confirmBodySha256: (process.env.MERRYMEN_TG_RECOVERY_BODY_SHA256 ?? "").trim(),
      });
      // Approved metadata only: the sealed state also holds private chat
      // history, which the notice path never returns or logs.
      log(`tg recovery notice ${id}: ${out.status}${out.dryRun ? " (DRY RUN — nothing sent)" : ""} · ${out.rooms.length} approved Merrymen room(s)`);
      log(`tg recovery notice ${id}: prepared body SHA-256 ${out.bodySha256}`);
      for (const room of out.rooms) log(`tg recovery notice ${id}: candidate chat ${room.chatId} · ${room.title} · ${room.kind}${room.isForum ? " · forum" : ""}`);
      if (out.reason) log(`tg recovery notice ${id}: ${out.reason}`);
      if (out.dryRun) {
        for (const line of out.body.split("\n")) log(`tg recovery notice ${id}: prepared | ${line}`);
        log(`tg recovery notice ${id}: to send, set MERRYMEN_TG_RECOVERY_CHAT_ID to exactly one candidate id, MERRYMEN_TG_RECOVERY_CONFIRM=${id}, and MERRYMEN_TG_RECOVERY_BODY_SHA256=${out.bodySha256}`);
      }
    } finally {
      await client.end();
    }
  } catch {
    // pg/fetch exceptions can embed URLs and tokens. The status alone is safe
    // for deployment logs; troubleshoot inside the service without printing it.
    log(`tg recovery notice ${id}: failed; nothing sent unless an at-most-once claim was recorded`);
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
    const ambiguousAccounts = new Set<string>();
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
        const previousTenant = tenantByAccount.get(acct.toLowerCase());
        if (previousTenant && previousTenant.toLowerCase() !== tenant.toLowerCase()) ambiguousAccounts.add(acct.toLowerCase());
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
    const repairOptions = parseRepairOptions(process.env);
    if (repairOptions?.mode === "commit") {
      const refusal = !rosterRead ? "grant roster unreadable" :
        repairOptions.accounts.some((account) => ambiguousAccounts.has(account)) ? "selected account resolves to multiple tenants" : accountingCommitRefusal({
        ...repairOptions,
        plans: agents.map((agent) => ({
          smartAccount: String(agent.smart_account),
          tenant: tenantByAccount.get(String(agent.smart_account).toLowerCase()) ?? null,
        })),
        env: process.env,
        localState: accountingMaintenanceLocalState,
      });
      if (refusal) { log(`repair| refusing commit before reconstruction: ${refusal}`); return; }
    }
    const flows = (await shared
      .prepare("SELECT id, agent_id, epoch, direction, amount_usdg, source, tx_hash, chain_id, block_number, log_index, at FROM flows")
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
      includeCapitalTimestamps: true,
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
      // The energy reserve, so an energy purchase is proposed as the
      // 'energy-buy' capital-out the worker books (and collides with it by
      // identity) rather than dropped as a trade. See accounting-reconstruction.
      reserveTokens: energyReserveTokens(Number(process.env.MERRYMEN_CHAIN_ID ?? 4663)),
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

  const maintenanceRefusal = accountingCommitRefusal({
    ...opts, plans, env: process.env, localState: accountingMaintenanceLocalState,
  });
  if (maintenanceRefusal) {
    log(`repair| refusing commit: ${maintenanceRefusal}`);
    return;
  }
  if (opts.mode === "commit" && (stopping || haltRequested())) {
    log("repair| refusing commit: orchestrator is stopping or FLEET_HALT is present");
    return;
  }

  const chainId = Number(process.env.MERRYMEN_CHAIN_ID ?? 4663);
  const results = await runRepair(shared, plans, opts, chainId,
    (r) => log(`repair| ${r.account.slice(0, 10)} ${r.stage} — ${r.why}`),
    () => stopping || haltRequested() ? "orchestrator is stopping or FLEET_HALT is present" : null,
  );
  for (const line of repairLines(opts.runId, opts.mode, results)) log(`repair| ${line}`);
}

/** Test seam: exercise the actual operator entry point with an isolated ledger. */
export { runRepairIfAsked as runAccountingRepairForTest };


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

/** The rewind each tenant last reported, so a standing one is said once. */
const lastRewindLogged = new Map<string, string>();

async function mirrorLedgers(): Promise<void> {
  const url = process.env.DATABASE_URL;
  // Held tenants count: their Telegram is published below, and a fleet whose
  // only tenants are held would otherwise never show their link codes, or
  // promote a chat linked through a hold process.
  if (!url || (children.size === 0 && holders.size === 0)) return;
  let shared;
  // Null unless the group-memory schema is in place and the DEK is present.
  let tgGroupsDekThisPass: Buffer | null = null;
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
    // needing DDL run by hand. The table, then which hold the owner was told
    // about (sendHoldNotice), then whether the bot is heard and whether the
    // tenant trades (publishChildTelegram), with TELEGRAM_LIVENESS_DDL's
    // columns. Every pass, like the ALTER above: exec runs them through
    // translateSchema, so on Postgres each is ADD COLUMN IF NOT EXISTS and
    // costs nothing once the column is there. A failed ALTER is not thrown
    // (ensureTelegramSchema), as mirror_state's is not.
    await ensureTelegramSchema(shared);
    // The command receipt, on the same clock and for the same reason: this
    // process writes it (landResults), so this process creates it.
    try {
      await shared.exec(COMMAND_RECEIPT_DDL);
    } catch {
      /* already there */
    }
    // Telegram group memory, on the same clock for the same reason. Its own
    // try: a failure here skips only the group ferry this pass, never the
    // ledger mirror.
    try {
      await ensureTgGroupsSchema(shared, "postgres");
      tgGroupsDekThisPass = tgGroupsDek();
    } catch (e) {
      log(`tg-groups: schema unavailable, not ferried this pass — ${e instanceof Error ? e.message : String(e)}`);
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
      const r = await mirrorSerially(tenant, () => mirrorTenant({ tenant, child: handle.db, shared }));
      // The link code and any chat the owner just linked. Not part of the
      // ledger — it is a file, not a table — but it needs the same ferry and
      // the same lease: only the replica that owns this child may speak for it.
      await publishChildTelegram(tenant as `0x${string}`, shared, "trading");
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
      //
      // ONCE PER REWIND, NOT ONCE PER PASS. A rebuilt child whose table is
      // still EMPTY leaves the watermark where it was (there is no row to move
      // it to), so the same rewind is detected again on every 15s pass until the
      // child writes that many rows — a paper agent idle over a weekend never
      // does. Measured 2026-09-27 03:00: 61+ tenants each printing this every
      // pass, burying the one line that says rows were lost. The detection and
      // what it guards (a rebuilt child must not delete the shared cost basis
      // it has merely forgotten) are unchanged; only the repetition goes.
      const rewind = r.restarted
        ? Object.entries(r.restarted).map(([k, v]) => `${k} (was ${v.was})`).join(", ")
        : null;
      if (rewind && lastRewindLogged.get(tenant) !== rewind) {
        log(`ledger mirror: ${tenant} CURSOR REWOUND — the child ledger was rebuilt beneath it: ${rewind}`);
      }
      if (rewind) lastRewindLogged.set(tenant, rewind);
      else lastRewindLogged.delete(tenant);
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
    // THE CHILD'S TELEGRAM GROUPS, beside the telegram link and under the same
    // lease: only the replica that owns this child may speak for it, and a
    // stale home left here by a child now running elsewhere must never
    // overwrite the live copy. Outside the mirror's try, like the wire below:
    // a stalled ledger is no reason to let group memory fall behind. Read
    // only; sealed; skipped when the file has not changed. Never for a child
    // whose groups are held off: its file is not its memory, and the stored
    // row is what its next spawn will restore (tgGroupsHeld).
    //
    // FORGET REQUESTS REACH THE ROW EITHER WAY. A publish applies them to what
    // it seals. When nothing is published (held, or a file that is absent,
    // refused or failed), the requests in the home are applied to the stored
    // row itself, under the same lease, so a /forgetme made while the child's
    // groups are held off is not undone by the restore that ends the hold.
    if (tgGroupsDekThisPass && !tgGroupsHeld.has(tenant.toLowerCase())) {
      const published = await publishTgGroups({ tenant, home: childHome(tenant), shared, dek: tgGroupsDekThisPass, seen: tgGroupsSeen, log });
      if (published !== "published" && published !== "unchanged") {
        await forgetStoredTgGroups({ tenant, home: childHome(tenant), shared, dek: tgGroupsDekThisPass, seen: tgGroupsSeen, log });
      }
    } else if (tgGroupsDekThisPass) {
      await forgetStoredTgGroups({ tenant, home: childHome(tenant), shared, dek: tgGroupsDekThisPass, seen: tgGroupsSeen, log });
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

  // HELD TENANTS: THEIR TELEGRAM, AND NOTHING ELSE. The link code the hold
  // process minted or rotated, and any chat linked through it, promoted into
  // the stored allowlist, as for a child. Never the ledger: no openChildLedger,
  // no mirrorTenant. A held book is empty or unrestored, and the mirror's
  // snapshot tables would copy that emptiness over the checkpoint, positions
  // and cost basis the shared ledger still holds. Under the same lease rule as
  // the loop above: only the replica holding the tenant speaks for it.
  for (const [tenant, held] of [...holders]) {
    const lease = leases.get(tenant.toLowerCase());
    if (!lease || !lease.healthy()) continue;
    // Stood down, and counted only until its process has gone: its grant is
    // gone, or the fleet is halted, and the lease is kept only so nothing
    // starts beside that process. Not a tenant to speak for: published, it
    // would put a revoked tenant's row back.
    if (held.stoodDown) continue;
    // Held, and why in the words its owner is told (restore-block.ts): the
    // dashboard says trading is held rather than "connected".
    await publishChildTelegram(tenant as `0x${string}`, shared, `held:${held.cls}`);
    // ITS TELEGRAM GROUPS ARE NEVER PUBLISHED WHILE IT IS HELD. The hold
    // process keeps no group memory (it answers nothing in groups), so
    // whatever file the home holds is the last child's, and the stored row is
    // what the spawn that ends the hold restores (restoreTgGroupsForChild)
    // when the home has none. Only the forget requests in the home reach the
    // row, as for a child whose groups are held off: the last child's, and
    // every /forgetme typed in a group during the hold, which the hold process
    // writes there (telegram/hold.ts). So no /forgetme is lost to a hold or
    // undone by the restore that ends it.
    if (tgGroupsDekThisPass) {
      await forgetStoredTgGroups({ tenant, home: childHome(tenant), shared, dek: tgGroupsDekThisPass, seen: tgGroupsSeen, log });
    }
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

// ── POSTING ON X ────────────────────────────────────────────────────────────
//
// docs/x-posting.md. The whole of it lives in orchestrator-xpost.ts and
// worker/src/xpost/; this is the latch, the roster and the log, built exactly
// like the room's: NOT AWAITED (a slow X or model is a missed post, never a
// late reconcile or a late watchdog), only for tenants whose lease this
// replica holds healthily, and silenced by FLEET_HALT because it is started
// inside the not-halted branch. It writes only xpost_* rows, which nothing on
// a trading path reads (xpost/boundary.test.ts).

let xPoster: XPoster | null = null;
let xPostInFlight = false;
/** Decided once, on the first pass, and said once: the environment does not change under a running process. */
let xPostBoot: XPostSetup | null = null;
let xPostLastFailure: { text: string; at: number } | null = null;

function startXPostPass(): void {
  if (xPostInFlight || stopping) return;
  if (!xPostBoot) {
    xPostBoot = xpostSetup();
    for (const line of xPostBoot.lines) log(line);
  }
  if (xPostBoot.off || !xPostBoot.app || !xPostBoot.dek || children.size === 0) return;
  xPostInFlight = true;
  void runXPostPass(xPostBoot).finally(() => {
    xPostInFlight = false;
  });
}

async function runXPostPass(boot: XPostSetup): Promise<void> {
  try {
    if (!xPoster) {
      xPoster = makeXPoster({ creds: boot.creds, knobs: boot.knobs, app: boot.app!, dek: boot.dek! });
      log(xPoster.plan().why);
    }
    const shared = await makePgDb(process.env.DATABASE_URL!);
    // THE SAME ROSTER AS THE ROOM'S: only who this replica speaks for.
    const roster: RosterMember[] = [];
    for (const [tenant, child] of children) {
      const key = tenant.toLowerCase();
      const held = leases.get(key);
      if (!held || !held.healthy()) continue;
      roster.push({ tenant: key, agentId: child.smartAccount.toLowerCase() });
    }
    const r = await xPoster.step(shared, roster, tenantChatProfile, Date.now());
    if (r.log) log(r.log);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    const now = Date.now();
    if (!xPostLastFailure || xPostLastFailure.text !== text || now - xPostLastFailure.at > 20 * 60_000) {
      xPostLastFailure = { text, at: now };
      log(`xpost: pass failed — ${text}`);
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
      // A FRESH INCIDENT OR THE NEXT RUNG, by the same rule as an exit, with
      // "alive" read up to the last beat of THIS child. A beat older than its
      // start is the file its predecessor left, and counts as none.
      //
      // Decided here now, and it never used to be. The corpse's exit handler
      // scheduled a restart of its own at rung 0 and one second, which always
      // beat this one, so the count this line passed never took effect. With
      // that gone, `child.restarts + 1` alone would carry a rung from one
      // incident into the next: a child that wedged once a week would restart
      // a little slower each time, and nine weeks on be stood down as "keeps
      // dying right after start".
      const rung = nextRung(child, beat === null ? child.startedAt : beat * 1000);
      trackExitingChild(tenant, child.proc);
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
      scheduleRestart(tenant as `0x${string}`, rung, "heartbeat stale");
    }
  }
}

/**
 * THE BOT OF EVERY TENANT THIS REPLICA HOLDS, WATCHED FOR SILENCE: which bot,
 * when this replica began watching it, and which alerts this incident has
 * had. An incident ends when the bot is heard again, or nothing should be
 * polling it any more.
 *
 * KEYED ON THE TENANT, NOT ON ITS PROCESS. Keyed on the process, each new one
 * started a new watch with a fresh clock, and a tenant with no process was
 * not watched at all. So a child killed and restarted every few minutes, a
 * hold process that kept crashing, or a tenant sitting out a crash cool-off
 * (gaveUpUntil) could leave its bot deaf for hours and never be said: no
 * single process lived ten minutes unheard. That is the shape of the incident
 * this exists for, no process polling the bot. The clock starts again only
 * for another bot, or after the lease is lost.
 */
const livenessWatch = new Map<string, { bot: string; since: number; told: Set<"not-polling" | "revoked"> }>();

/** What a child's settings.json in its home says, as the child reads it; null when there is none. */
function readChildSettings(tenant: string): MerrymenSettings | null {
  try {
    return JSON.parse(readFileSync(path.join(childHome(tenant), "settings.json"), "utf8")) as MerrymenSettings;
  } catch {
    return null;
  }
}

/**
 * SAY WHEN A TENANT'S BOT HAS GONE DEAF, AND DO NOTHING ELSE (telegram-liveness.ts).
 *
 * For each tenant this replica holds a healthy lease for, whether or not a
 * worker or hold process is running for it this minute, with Telegram
 * switched on and a token in the settings its process is handed (after the
 * bot claim, so a tenant whose token went to another is not expected to
 * poll): the poll record in its telegram.json, for that token's bot. Not heard
 * for LIVENESS_STALE_SEC since the later of its last good poll and the start
 * of this watch is one `[alert] telegram not polling` line per incident, and
 * a token Telegram refuses is one line of its own. The next good poll closes
 * the incident with a plain line.
 *
 * IT KILLS NOTHING, AND NOTHING KILLS ON ITS WORD. A deaf bot beside a
 * trading worker is still a trading worker, and a revoked token or a second
 * program on the bot is not something a restart fixes. The watchdog does not
 * read the poll record at all (telegram-liveness.test.ts pins both).
 */
export function telegramLiveness(nowSec = Math.floor(Date.now() / 1000)): void {
  if (stopping) return;
  // Only while the lease is ours: only the holder's home has the record, and
  // a replica that has lost the tenant must not speak for it.
  for (const tenant of [...livenessWatch.keys()]) {
    const lease = leases.get(tenant);
    if (!lease || !lease.healthy()) livenessWatch.delete(tenant);
  }
  for (const [tenant, lease] of leases) {
    if (!lease.healthy()) continue;
    const settings = readChildSettings(tenant);
    const token = botTokenOf(settings);
    const bot = token ? botIdOf(token) : null;
    const enabled = bot !== null && botWillPoll(settings);
    if (!enabled) {
      // Nothing should be polling: switched off, no token, or the bot went
      // to another tenant's claim. Any incident ends with it.
      livenessWatch.delete(tenant);
      continue;
    }
    let watch = livenessWatch.get(tenant);
    if (!watch || watch.bot !== bot) {
      watch = { bot, since: nowSec, told: new Set() };
      livenessWatch.set(tenant, watch);
    }
    const tg = readChildTelegram(tenant, nowSec);
    const poll = tg?.poll && tg.poll.botId === bot ? tg.poll : null;
    const p = { okAt: poll?.okAt ?? null, err: poll?.err ?? null, errAt: poll?.errAt ?? null };
    const verdict = telegramLivenessVerdict({ enabled, ...p, since: watch.since, now: nowSec });
    if (verdict === "live" || verdict === "off") {
      if (verdict === "live" && watch.told.size > 0) log(`telegram polling again: ${tenant}`);
      watch.told.clear();
      continue;
    }
    const kind = verdict === "revoked" ? "revoked" : "not-polling";
    if (watch.told.has(kind)) continue;
    watch.told.add(kind);
    const line = livenessAlertLine(tenant, verdict, { okAt: p.okAt, err: p.err, since: watch.since });
    if (line) log(line);
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
 * ONE LOOP OF FLEET_HALT: every process this replica runs for a tenant stood
 * down, and every lease released. The main loop calls this, instead of
 * reconcile, for as long as the halt file is there.
 *
 * SAID AND DONE ONCE, NOT EVERY LOOP. A stood-down hold process that has not
 * exited keeps its tenant in `holders` until it has (standDownHolder), so a
 * guard that counted `holders` logged "standing every child down" and stood
 * it down again every RECONCILE_MS for as long as that process lived. What is
 * left once the halt has done its work is only waited for: killed again each
 * loop, as a pass would, and alerted once (pressLeaving).
 */
export async function honourFleetHalt(): Promise<void> {
  // A lease kept for a hold process that has not exited (below) is waited
  // for, like its process, and not a reason to say all this again.
  const kept = (t: string) => !!holders.get(t)?.leaving || retiringExpired.has(t);
  if (children.size > 0 || [...holders.values()].some((h) => !h.stoodDown) || [...leases.keys()].some((t) => !kept(t))) {
    log("FLEET_HALT present — standing every child down and releasing leases");
    for (const t of [...children.keys()]) killChild(t);
    // Held tenants' hold processes too: a halt stands down every process
    // this replica runs for a tenant, and the leases go below.
    for (const t of [...holders.keys()]) standDownHolder(t);
    // Release leases too: if only THIS replica is halted, another may take
    // the tenants over; if the whole fleet is halted, releasing is harmless.
    // BUT NOT ONE WHOSE HOLD PROCESS HAS NOT EXITED: the replica taking it
    // over would start beside a process that may still poll the bot. Kept
    // until the exit is seen, which lets it go (watchHolder); the alert says
    // so. Holding it trades nothing: the tenant was held, not trading.
    for (const t of [...leases.keys()]) if (!kept(t)) await releaseLease(t);
  }
  for (const held of holders.values()) pressLeaving(held);
}

export async function runOrchestrator(): Promise<void> {
  if (!isHostedMode()) {
    log("MERRYMEN_HOSTED is not set — the orchestrator only runs in hosted mode. Refusing to start.");
    process.exit(1);
  }
  // Validate the complete operator list before any diagnosis, mutation or
  // child starts. A malformed entry must never silently drop from a hold.
  const accountingHolds = accountingHoldTenants(process.env);
  if (accountingHolds.size) log(`accounting maintenance holds ${accountingHolds.size} named tenant(s); grants and ledger remain stored; old deployment removal must be verified separately before commit`);
  setTenantLeaseLossHandler(standDownLostLeasesNow);
  log(`starting — home ${merrymenHome()}, worker ${WORKER_ENTRY}`);
  await runAccountingDiagnosisIfAsked();
  await runGasAuditIfAsked();
  // The cohort report is NOT here. It reads `positions`, which the mirror
  // empties and refills per agent, so at startup it would be reading a table
  // this very deploy just cleared. It runs from the loop instead — see
  // COHORT_VET_AFTER_PASSES.

  const stop = () => {
    stopping = true;
    log("stopping — calling the whole fleet home");
    for (const child of children.values()) child.proc.kill("SIGTERM");
    for (const held of holders.values()) held.proc?.kill("SIGTERM");
    // And any a handover or stand-down is still waiting on.
    for (const held of holders.values()) killLeaving(held);
    // Release every advisory lease so a restarting replica can take over at once
    // rather than waiting for our dropped connections to time out server-side.
    // Best-effort and unawaited — we exit in a second regardless.
    const release = () => {
      for (const tenant of [...leases.keys()]) void releaseLease(tenant);
    };
    // A TELEGRAM KILL STILL WAITING IN A HOME goes to the store before the
    // leases do, so the replica taking over never arms that grant. The home
    // does not survive this container (kill-request.ts). Bounded, and it
    // changes nothing when no kill is pending. It only helps if Railway gives
    // the old deployment draining time. The default is none.
    if (pendingKillTenants().length === 0) {
      release();
      setTimeout(() => process.exit(0), 1_000);
      return;
    }
    void Promise.race([honourPendingKills(), new Promise((r) => setTimeout(r, 3_000))]).finally(release);
    setTimeout(() => process.exit(0), 4_000);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // A held target has no child here. Its potentially long historical scan
  // must not delay unrelated tenants. Install shutdown handling first, and
  // recheck shutdown/hold/fresh-state at the commit boundary inside the job.
  await runAccountingReconstructionAtStartup({
    heldTenants: accountingHolds,
    reconstruct: runReconstructionDryRunIfAsked,
    onError: (error) => log(`accounting reconstruction failed — ${error instanceof Error ? error.message : String(error)}`),
  });
  if (stopping) return;

  // ORDERS ON THEIR OWN CLOCK, beside the reconcile loop below rather than
  // inside it: that loop's pass is only as fast as its slowest step.
  void orderFerryLoop();

  // The main loop: honour a fleet-halt, else reconcile + watchdog every tick.
  for (;;) {
    if (stopping) return;
    if (haltRequested()) {
      await honourFleetHalt();
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
      // Before reconcile, so the first settings.json a child is handed
      // already counts the wallet its holder claim names.
      await runHolderClaimsBackfill();
      await reconcile();
      watchdog();
      // Beside the watchdog, and nothing like it: this one only speaks.
      telegramLiveness();
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
      // POSTING ON X, the same way and for the same reasons: after the mirror,
      // silenced by FLEET_HALT, never awaited. See startXPostPass.
      startXPostPass();
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
      if (cohortPasses === 1) await runTgGroupRecoveryNoticeIfAsked();
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
