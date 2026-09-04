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
import { CASH, isHostedMode, type MerrymenSettings } from "../../packages/core/src/index";
import { makePgDb, translateSchema, type Db } from "./db";
import { BOOTSTRAP_FILE, BOOTSTRAP_SCHEMA_VERSION, type TenantBootstrapState } from "./bootstrap-state";
import { deriveBootstrapAccounting } from "./bootstrap-source";
import { diagnoseAccounting, diagnosisLines } from "./accounting-diagnosis";
import { planReconstruction, reconstructionLines } from "./accounting-reconstruction";
import type { AccountPlan } from "./accounting-reconstruction";
import { accountPreviewLines, parsePreviewRequest, rosterLines, runPreview } from "./accounting-preview";
import { scanFleetCapital } from "./chain-capital";
import { getFollowStore, MAX_FOLLOWS } from "./follow-store";
import { MIRROR_STATE_DDL, mirrorTenant, openChildLedger } from "./ledger-mirror";
import { writePeersForChild } from "./peer-files";
import { peerThesesForSlugs } from "./peer-theses";
import { applyLedgerSchema } from "./store";
import { drainCommandResults, writeCommand } from "./command-files";

/** How often to re-read the store for tenants added or killed. */
const RECONCILE_MS = 15_000;
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
const CHILD_SECRET_STRIP = ["MERRYMEN_STORE_DEK", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const;

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
    if (!settings) return null;
    if (seenBotTokens && settings.telegramBotToken && dedupeBotToken(settings, seenBotTokens)) {
      log(`${tenant}: telegram bot token already claimed by another tenant — telegram disabled for this child`);
    }
    const home = childHome(tenant);
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "settings.json"), JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
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
  const proc = spawn(
    process.execPath,
    [`--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`, "--import", "tsx", WORKER_ENTRY],
    { cwd: ROOT, env: childEnv(tenant), stdio: ["ignore", "pipe", "pipe"] },
  );
  const child: Child = { proc, tenant, startedAt: Date.now(), restarts, staleSec };
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

async function ferryCommands(shared: Db): Promise<void> {
  for (const tenant of [...children.keys()]) {
    const home = childHome(tenant);
    // ── down: unclaimed commands become files ──
    try {
      const rows = (await shared
        .prepare(
          `SELECT id, kind, created_at FROM agent_commands
            WHERE agent_id = ? AND claimed_at IS NULL ORDER BY created_at ASC LIMIT 5`,
        )
        .all(tenant)) as { id: string; kind: string; created_at: number }[];
      for (const r of rows) {
        writeCommand(home, { id: String(r.id), kind: String(r.kind), at: Number(r.created_at) });
        // Marked claimed the moment it is DELIVERED, not when it completes.
        // Otherwise the next pass ferries it again and the child runs it
        // twice — and this one spends gas.
        await shared
          .prepare("UPDATE agent_commands SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL")
          .run(Date.now(), r.id);
        log(`command ${String(r.id).slice(0, 8)} → ${tenant.slice(0, 8)} (${r.kind})`);
      }
    } catch {
      /* a child that misses a command this pass gets it next pass */
    }
    // ── up: results become rows ──
    try {
      for (const r of drainCommandResults(home)) {
        await shared
          .prepare("UPDATE agent_commands SET done_at = ?, result = ? WHERE id = ?")
          .run(Date.now(), r.line.slice(0, 500), r.id);
        log(`command ${r.id.slice(0, 8)} ← ${tenant.slice(0, 8)}: ${r.ok ? "ok" : "failed"}`);
      }
    } catch {
      /* the result file is already gone; the event feed still carries it */
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

    const accounts = agents.map((a) => String(a.smart_account)).filter((a) => a.startsWith("0x"));
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
    log(`recon| scanning ${accounts.length} account(s) to block ${head}`);
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
    for (const line of reconstructionLines(plans)) log(`recon| ${line}`);

    runPreviewIfAsked(plans);
  } catch (e) {
    log(`reconstruction dry run failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The preview, gated behind its own variable and read-only in the strongest
 * sense available: the module it calls is never handed a database.
 *
 * Deliberately downstream of the plan rather than a separate entry point, so the
 * preview is always of a plan just derived from the live database in this
 * process — a stale preview is worse than none.
 */
function runPreviewIfAsked(plans: readonly AccountPlan[]): void {
  // The clock is passed IN because parsePreviewRequest is pure and may not read
  // one. Its default of 0 exists for the tests; leaving it to default here stamped
  // every production run `run-1970-01-01T00-00-00-000Z`, which is precisely the
  // property the id exists to provide.
  const req = parsePreviewRequest(process.env, Date.now());
  if (!req) return;
  if (req.kind === "refused") {
    log(`preview| REFUSED — ${req.why}`);
    return;
  }

  log(`preview| run ${req.runId} · account ${req.account ?? "ALL"} · READ-ONLY (this build has no mutation path)`);
  const previews = runPreview(plans, req);

  // The selected account first and in full; then every tenant on one line, so
  // the report can be read as "all N are accounted for".
  for (const p of previews) {
    if (!p.selected) continue;
    const plan = plans.find((x) => x.smartAccount === p.account)!;
    for (const line of accountPreviewLines(plan, p)) log(`preview| ${line}`);
  }
  for (const line of rosterLines(previews)) log(`preview| ${line}`);
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
    writePeersForChild(childHome(tenant), { at: Math.floor(Date.now() / 1000), theses });
    if (theses.length > 0) log(`wire: ${tenant} +${theses.length} peer thesis/theses from ${edges.length} follow(s)`);
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
    const stale = beat === null || nowSec - beat > child.staleSec;
    if (stale) {
      log(
        `${tenant} heartbeat stale (${beat === null ? "never beat" : `${nowSec - beat}s`} > ${child.staleSec}s) — SIGKILL + restart`,
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
