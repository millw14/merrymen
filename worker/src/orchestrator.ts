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
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { merrymenHome } from "./home";
import { getGrantStore } from "./grant-store";
import { getIdentityStore } from "./identity-store";
import { getSettingsStore } from "./settings-store";
import { acquireTenantLease, type TenantLease } from "./tenant-lease";
import { CASH, DEFAULT_BASKET_SYMBOLS, isHostedMode, STOCK_TOKENS, type MerrymenSettings } from "../../packages/core/src/index";
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
import { scanFleetCapital } from "./chain-capital";
import { getFollowStore, MAX_FOLLOWS } from "./follow-store";
import { MIRROR_STATE_DDL, mirrorTenant, openChildLedger } from "./ledger-mirror";
import { writePeersForChild } from "./peer-files";
import { writeResearchForChild } from "./research-files";
import { makeNewsDesk, type NewsDesk } from "./research-pass";
import { peerThesesForSlugs, readPeerTheses } from "./peer-theses";
import type { PublicThesis } from "./thesis-policy";
import { ACCOUNTING_FIXED_AT, applyLedgerSchema } from "./store";
import { dropCommandResult, drainCommandResults, writeCommand } from "./command-files";

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
  // Privy authenticates PEOPLE at the web edge. A worker child acts for an
  // agent that is already authorized by a signed grant; it has no login to
  // verify and no reason to hold the key that would verify one.
  "PRIVY_APP_SECRET",
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
/**
 * The advisory lease held for each tenant we are running, keyed by lowercased
 * tenant. Acquired in reconcile() BEFORE the first spawn and held across crash
 * restarts (never re-acquired per process — a restart must not open a window for
 * another replica). Released only when the tenant is no longer wanted (kill
 * switch), when its lease goes unhealthy, or on shutdown.
 */
const leases = new Map<string, TenantLease>();
let stopping = false;

function log(msg: string): void {
  console.log(`[orchestrator] ${msg}`);
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
  try {
    const hb = JSON.parse(readFileSync(path.join(childHome(tenant), "heartbeat.json"), "utf8")) as { at?: number };
    return typeof hb.at === "number" ? hb.at : null;
  } catch {
    return null;
  }
}

/** Write the tenant's session-key-only grant into its child's grant.json. */
async function writeGrantForChild(tenant: `0x${string}`): Promise<`0x${string}` | null> {
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
 */
async function refreshGrantForChild(tenant: `0x${string}`): Promise<void> {
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
    if (!settings) return null;
    if (seenBotTokens && settings.telegramBotToken && dedupeBotToken(settings, seenBotTokens)) {
      log(`${tenant}: telegram bot token already claimed by another tenant — telegram disabled for this child`);
    }
    const home = childHome(tenant);
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "settings.json"), JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
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
  const url = process.env.DATABASE_URL;
  if (!url) {
    // No shared database configured at all. That is a deployment fact, not a
    // fact about the tenant, and it is reported as such rather than as an
    // empty account.
    accounting = { kind: "unknown", why: "no DATABASE_URL on the orchestrator", observedAt: now };
  } else {
    try {
      accounting = await deriveBootstrapAccounting(shared ?? (await makePgDb(url)), smartAccount, now);
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

async function spawnChild(tenant: `0x${string}`, restarts = 0): Promise<void> {
  if (stopping) return;
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
  const tickSeconds = typeof settings?.tickSeconds === "number" ? settings.tickSeconds : envTickSeconds();
  const staleSec = staleThresholdSec(tickSeconds);
  const firstBeatSec = firstBeatGraceSec(tickSeconds);
  const proc = spawn(
    process.execPath,
    [`--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`, "--import", "tsx", WORKER_ENTRY],
    { cwd: ROOT, env: childEnv(tenant), stdio: ["ignore", "pipe", "pipe"] },
  );
  const child: Child = { proc, tenant, smartAccount, startedAt: Date.now(), restarts, staleSec, firstBeatSec };
  children.set(tenant, child);
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
    if (freshRestarts > MAX_RESTARTS) {
      log(`${tenant} keeps dying right after start — giving up until the next reconcile`);
      return;
    }
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(freshRestarts, 5));
    log(`${tenant} rallying again in ${Math.round(delay / 1000)}s (restart #${freshRestarts})`);
    setTimeout(() => {
      // Only respawn if the tenant is still meant to be running (not killed meanwhile).
      if (!stopping && !children.has(tenant)) void spawnChild(tenant, freshRestarts);
    }, delay);
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

/** Bring the running set in line with the store: spawn new tenants, stop killed ones. */
export async function reconcile(): Promise<void> {
  if (stopping) return;
  const store = getGrantStore();
  let tenants: `0x${string}`[];
  try {
    tenants = await store.listTenants();
  } catch (e) {
    log(`store unreadable, skipping this reconcile: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
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
    await spawnChild(lc);
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
      killChild(tenant);
      try {
        rmSync(childHome(tenant), { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
  // Release any lease we still hold for a tenant that is no longer wanted — both
  // the kill-switch case above and a lease left over from a child that has since
  // exited. Holding a lease for a tenant we won't arm would block another replica
  // (or a later re-arm) for no reason.
  for (const tenant of [...leases.keys()]) {
    if (!wanted.has(tenant)) await releaseLease(tenant);
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
    await ferryCommands(shared);
  } catch {
    /* shared db unavailable — the mirror logs that already */
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
 */
const ORDER_STALE_MS = 7 * 60_000;

async function ferryCommands(shared: Db): Promise<void> {
  for (const [tenant, child] of [...children.entries()]) {
    await ferryForChild(shared, { home: childHome(tenant), smartAccount: child.smartAccount, tag: tenant });
  }
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
    const tenant = tag;
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
      for (const r of rows) {
        // CLAIMED BEFORE THE FILE IS WRITTEN, and the write only happens if the
        // claim actually took.
        //
        // These are two writes to two systems and there is no transaction
        // across them, so one of the two orders has to be chosen. It used to
        // write first: a crash — or a thrown UPDATE, whose catch is a comment —
        // between the two re-wrote `<id>.json` into a home that had already
        // claimed, run and answered it. For a probe that is a second approve of
        // 0.000001 USDG. For a BUY it is a second position at a second price
        // with a second gas bill, and a ledger showing two fills for one
        // instruction — a claim about somebody's money they never made.
        //
        // So: at-most-once, deliberately, in the direction this codebase
        // already accepts. A lost command is a button pressed again
        // (command-files.ts says so about the unlink); a replayed order is not
        // recoverable by anyone.
        const claim = await shared
          .prepare("UPDATE agent_commands SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL")
          .run(Date.now(), r.id);
        if (claim.changes === 0) continue; // another replica took it
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
    } catch {
      /* a child that misses a command this pass gets it next pass */
    }
    // ── up: results become rows ──
    //
    // ONE TRY PER RESULT, AND THE FILE IS DELETED ONLY AFTER ITS ROW LANDS.
    // This was a single try around the whole loop, over a drain that unlinked
    // every file as it read it — so one connection blip on the first result
    // discarded every other tenant-visible receipt in the batch, permanently.
    // For an order that loses the record of a trade that really happened, and
    // an unanswered row is now what refuses the owner their next order.
    for (const r of drainCommandResults(home)) {
      try {
        await shared
          .prepare("UPDATE agent_commands SET done_at = ?, result = ? WHERE id = ?")
          .run(Date.now(), r.line.slice(0, 500), r.id);
        dropCommandResult(home, r.id);
        log(`command ${r.id.slice(0, 8)} ← ${tenant.slice(0, 8)}: ${r.ok ? "ok" : "failed"}`);
      } catch {
        // Left on disk on purpose: the next pass retries it. A receipt that
        // survives is worth more than a tidy directory.
      }
    }

    // ── and a row nothing will ever answer is closed, not left running ──
    //
    // An order whose child was SIGKILLed mid-trade — the watchdog does that in
    // bulk on this fleet — leaves `done_at` NULL forever, and the owner's poll
    // shows an eternal spinner while the one-at-a-time rule refuses them any
    // new order. Past its expiry it can no longer legally run, so it is closed
    // with a sentence saying so rather than left to look like it is working.
    try {
      const stale = Date.now() - ORDER_STALE_MS;
      await shared
        .prepare(
          `UPDATE agent_commands SET done_at = ?, result = ?
            WHERE agent_id = ? AND kind = 'trade' AND done_at IS NULL AND created_at < ?`,
        )
        .run(
          Date.now(),
          "never ran — this order sat past its five-minute window and I will not fill it into a different market. Ask again if you still want it.",
          smartAccount,
          stale,
        );
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
    try {
      const modes = (await shared
        .prepare("SELECT COALESCE(mode, 'unknown') AS mode, COUNT(*) AS n FROM agents GROUP BY mode")
        .all()) as { mode: string; n: number | string }[];
      if (modes.length) {
        const line = modes.map((m) => `${m.mode} ${Number(m.n)}`).join(", ");
        log(`fleet| rails — ${line}`);
      }
    } catch {
      // The column may predate this deploy on a database mid-migration. A
      // missing breakdown is not a fleet that is down.
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
        });
      } catch (e) {
        log(`news: ${tenant} write failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    log(`news: pass failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function mirrorLedgers(): Promise<void> {
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
  } catch (e) {
    log(`ledger mirror: shared db unavailable — ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  for (const tenant of [...children.keys()]) {
    // CLOSED IN THE finally BELOW. One descriptor per tenant per pass, on a
    // fifteen-second clock, is twenty-two leaked handles a quarter-minute for
    // as long as the service runs.
    const handle = openChildLedger(childHome(tenant));
    if (!handle) continue;
    try {
      const r = await mirrorTenant({ tenant, child: handle.db, shared });
      // Read while the handle is open, on the mirror's clock. The news desk
      // asks about what the fleet holds before what it merely may buy, and this
      // is the only place the orchestrator can see the difference.
      tenantHeldSymbols.set(tenant.toLowerCase(), await heldEquitySymbols(handle.db));
      const n = Object.values(r.copied).reduce((a, b) => a + b, 0);
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
      if (n > 0) {
        const detail = Object.entries(r.copied)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ");
        log(`ledger mirror: ${tenant} +${n} rows (${detail})`);
      } else if (!r.failed) {
        // Says "read, nothing new" rather than saying nothing at all, so the
        // absence of this line means the pass itself did not run.
        log(`ledger mirror: ${tenant} idle`);
      }
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
      if (!stopping) void spawnChild(tenant as `0x${string}`, restarts + 1);
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

  const stop = () => {
    stopping = true;
    log("stopping — calling the whole fleet home");
    for (const child of children.values()) child.proc.kill("SIGTERM");
    // Release every advisory lease so a restarting replica can take over at once
    // rather than waiting for our dropped connections to time out server-side.
    // Best-effort and unawaited — we exit in a second regardless.
    for (const tenant of [...leases.keys()]) void releaseLease(tenant);
    setTimeout(() => process.exit(0), 1_000);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

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
      await reconcile();
      watchdog();
      await mirrorLedgers();
      // AFTER the mirror, because the mirror is what tells the desk which
      // symbols the fleet actually holds. Its own TTL decides whether this
      // costs a vendor request; most passes it costs a file write.
      await runNewsPass();
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
