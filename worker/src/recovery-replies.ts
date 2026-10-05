/**
 * Separate public Telegram listener. This entry never runs an orchestrator or worker.
 *
 * ONE SUPERVISOR, ONE ACTOR PER SERVING TENANT, AND ONE TENANT'S PROBLEM STOPS
 * ONE TENANT. The listener used to compare the WHOLE roster's receipt before
 * every operation, check EVERY lease in every guard and exit on the first
 * error anywhere, so one user signing a grant (any tenant's grants row) or one
 * slow settings read stopped every bot at once (2026-10-05: ten exits in a day,
 * then Railway's retry cap). Now:
 *
 *   - THE SUPERVISOR re-reads the roster every REPLY_SUPERVISOR_EVERY_MS. It
 *     holds the tenant lease of every roster tenant (the FENCE, malformed row
 *     or not), admits an actor for each tenant whose stored public scope is
 *     available (tenant lease + bot stream lease + a fresh snapshot), stops
 *     the actor of a tenant that left or changed, and re-admits it when it is
 *     still eligible. A malformed row is skipped with a redacted [alert].
 *   - EACH ACTOR re-proves only its own scope: its own grant row against its
 *     own roster receipt, then the rest of its snapshot (assertReplySnapshot),
 *     its own tenant lease, its own bot lease, plus the fleet-wide root proof.
 *     Another tenant's write never reaches it; its own write stops only it.
 *   - FLEET-WIDE REFUSAL is kept for fleet-wide conditions only: the root
 *     proof (FLEET_HALT, the mount, the frozen environment), an invalid DEK,
 *     a roster over its cap or unreadable at startup for a reason that is not
 *     database weather (weather is retried in place), and a supervisor fault.
 *     SIGTERM is a clean stop, not a refusal.
 *   - THE MULTI-BOT 409 ALARM PAUSES; IT DOES NOT EXIT. Most serving bots
 *     meeting a new non-webhook 409 at once (recovery-reply-isolation.ts)
 *     stops every actor for a while but keeps every lease, so the fence is
 *     never handed to whatever else is polling, and no restart is spent.
 *   - A DROPPED DATABASE CONNECTION IS ONE ACTOR'S WEATHER. Every pool client
 *     has an 'error' listener, checked out or idle, so a terminated backend
 *     fails that actor's next statement (db-transient back-off) instead of
 *     being an uncaught exception that ends the process.
 *
 * WHAT DOES NOT CHANGE. The listener never trades, never holds a financial
 * port and never writes a financial table; it never runs beside the ordinary
 * workers of a tenant it fences (the tenant lease); it never polls one bot
 * twice (the bot stream lease, and at most one actor per seat); privacy is
 * durable before acknowledgement; a refused provider stays quarantined.
 *
 * THE ADMISSION WINDOW. A tenant whose grant row first appears while the
 * listener runs is fenced on the supervisor's next pass, so for up to one
 * period (30s) plus its lease acquisition, that brand-new tenant is not yet
 * leased by this process. That is the same exposure as any grant created
 * between two passes of the ordinary orchestrator's own reconcile, and the
 * rollout prerequisite still applies: no ordinary orchestrator or worker
 * deployment runs beside this one (docs/recovery-replies.md).
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { requireDek } from "./store-crypto";
import { PgTenantLeaseFleet, type TenantLease } from "./tenant-lease";
import { proveRecoveryReplyRoot, recoveryReplyRefused, type RecoveryReplyRootProof } from "./recovery-reply-proof";
import { CONFLICT_PAUSE_MS, isTransientReplyDbError, isWebhookConflict, recoveryReplyExitLine, replyBackoffMs, ReplyActorStop, ReplyConflictAlarm, RecoveryReplyFleetRefusal, tenantTag, type ReplyBackoffKind, type ReplyFleetReason, type ReplyStopReason } from "./recovery-reply-isolation";
import { pollFailure } from "./telegram/poll-rules";
import { RECOVERY_REPLY_SCHEMA, type ReplyPrivacyOp } from "./recovery-reply-state";
import { assertReplySnapshot, advanceReplyOffset, bindReplyOffset, readReplyRoster, readReplySnapshot, scanReplyRoster, ReplyGrantChanged, ReplyRosterCapExceeded, type ReplyQuery, type ReplySnapshot, type ReplyGrant, type ReplyRosterScan } from "./recovery-reply-store";
import { RecoveryReplyBotLeases, type ReplyLease, type ReplyLeaseClient } from "./recovery-reply-lease";
import { getMe, getUpdates, sendMessage, sendPhotoBytes, esc, answerCallbackQuery, type TgMessage, type TgCallback, type TelegramOpts } from "./telegram/api";
import { createRecoveryPublicReply, RECOVERY_PUBLIC_HELP, RECOVERY_PUBLIC_HELD, RECOVERY_PUBLIC_UNAVAILABLE, RECOVERY_PUBLIC_BUSY, RECOVERY_PUBLIC_BUTTON_HELD, isRecoveryPublicRequest, parseRecoveryPublicAsk } from "./telegram/recovery-public-reply";
import { createRecoveryPublicLook } from "./telegram/recovery-public-transport";
interface ReplyConnection extends ReplyQuery {
    release(error?: Error): void;
    /**
     * A pg client is an EventEmitter. pg-pool takes its own idle 'error'
     * listener off a client it hands out, so while a transaction holds it, a
     * terminated backend or a reset socket emits 'error' with nobody
     * listening: an uncaught exception that ends the whole process. The
     * transaction attaches its own listener for exactly as long as it holds
     * the client. Optional so a test pool that is not an emitter still fits.
     */
    on?(event: "error", fn: (error: Error) => void): unknown;
    removeListener?(event: "error", fn: (error: Error) => void): unknown;
}
export interface ReplyPool extends ReplyQuery {
    connect(): Promise<ReplyConnection>;
    end(): Promise<unknown>;
}
export interface RecoveryReplyOptions {
    env?: NodeJS.ProcessEnv;
    readMountInfo?: () => string;
    pool?: ReplyPool;
    dek?: Buffer;
    acquireTenant?: (tenant: `0x${string}`) => Promise<TenantLease | null>;
    acquireBot?: (botId: string) => Promise<ReplyLease | null>;
    transport?: {
        getMe: typeof getMe;
        getUpdates: typeof getUpdates;
        sendMessage: typeof sendMessage;
        sendPhotoBytes: typeof sendPhotoBytes;
        answerCallbackQuery: typeof answerCallbackQuery;
    };
    reply?: ReturnType<typeof createRecoveryPublicReply>;
    now?: () => number;
    /**
     * Trusted local-test bounded invocation. Never enabled by environment.
     * One supervisor pass admits every eligible tenant, each actor runs one
     * iteration, and the entry returns once they have all ended.
     */
    onePass?: true;
    /** Trusted shutdown input; cannot enable a mode or relax any proof. */
    stopSignal?: AbortSignal;
    /** Trusted test seam: the supervisor's period. Production uses REPLY_SUPERVISOR_EVERY_MS. */
    supervisorEveryMs?: number;
    /** Trusted test seam: how long the multi-bot 409 alarm pauses polling. Production uses CONFLICT_PAUSE_MS. */
    conflictPauseMs?: number;
    /**
     * Trusted test seam: where each line goes. Production writes stdout, and
     * stderr for an [alert]. Every line is built from fixed reason codes,
     * counts and eight-character tenant prefixes only.
     */
    log?: (stream: "out" | "err", line: string) => void;
}
/**
 * How often the supervisor re-reads the roster. Thirty seconds bounds three
 * things: how long a brand-new roster tenant is unfenced (see the header), how
 * soon an actor stopped by its own change is re-admitted, and how often a
 * quarantined or unavailable tenant's stored scope is re-read (a handful of
 * indexed single-row reads each).
 */
export const REPLY_SUPERVISOR_EVERY_MS = 30_000;
/** The counts-only `stats` line. */
export const REPLY_STATS_EVERY_MS = 300_000;
/**
 * DATABASE TIMEOUTS. They were 1000ms per statement on the server and 1500ms
 * on the client, and on 2026-10-05 a one-row settings read hit the 1000ms
 * statement timeout and (then) stopped every bot. A shared hosted PostgreSQL
 * stalls past a second now and then (checkpoints, autovacuum, a noisy
 * neighbour); a 2.5s statement allowance absorbs that instead of failing the
 * read. The client waits a little longer than the server's own timeout, so the
 * server's clean 57014 normally answers first and the connection stays usable.
 *
 * These bound ONE statement. Every transaction keeps its own overall deadline
 * (8s, and less when the reply deadline is nearer), every reply keeps its
 * original thirty seconds, and lock waits keep their 500ms lock_timeout. The
 * deadline is checked between statements, and the client stops waiting for a
 * statement at the deadline, but PostgreSQL does not notice a client that
 * stopped waiting: a statement that STARTED just before the deadline can run
 * on the server up to STATEMENT_TIMEOUT_MS past it, keeping the share locks
 * its transaction took (FOR SHARE NOWAIT on this tenant's grant, settings,
 * claim and link rows) until it ends. The worst case is therefore about 1.5s
 * longer than with the old 1s limit, and it can delay the web's write to that
 * one tenant's row by as much; it never touches another tenant's rows. A
 * timeout that still fires is one actor's back-off (db-transient), never a
 * fleet stop.
 */
const STATEMENT_TIMEOUT_MS = 2_500;
const QUERY_WAIT_MS = 3_000;
const CONNECT_WAIT_MS = 3_000;
/**
 * ONE TENANT'S PLACE IN THE FLEET. The supervisor owns every field; an actor
 * only reads its leases (through the ones it was started with) and bumps
 * `progress` when a poll commits.
 */
interface ReplySeat {
    tenant: `0x${string}`;
    /** The fence: held for every roster tenant, admitted or not. */
    lease: TenantLease | null;
    /** The bot stream mutex, kept across actor restarts while the bot is the same. */
    bot: { id: string; lease: ReplyLease } | null;
    actor: ReplyActorRun | null;
    /** The snapshot receipt Telegram refused (401/404/wrong bot). Re-admitted only when the stored scope changes. */
    quarantined: string | null;
    /** The stored scope is explicitly unavailable (no enabled token, link, claim or held status). Fenced, not served. */
    unavailable: boolean;
    /** Not before this Date.now(): the admission back-off. */
    retryAt: number;
    /** Consecutive admission failures, for the back-off. */
    streak: number;
    /**
     * Polls whose drain COMMITTED. Bumped only after the cursor moved, never
     * on a clean getUpdates alone, so a drain that fails every time is one
     * repeated failure whose in-place back-off keeps doubling.
     */
    progress: number;
    /** Leaving the roster: release everything once the actor has ended. */
    retiring: boolean;
}
interface ReplyActorRun {
    controller: AbortController;
    /** The roster receipt this actor was admitted with. */
    receipt: string;
    done: Promise<void>;
    /** Set by the supervisor when it stops the actor, so the stop line names its reason. */
    stopReason?: ReplyStopReason;
}
const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    if (signal.aborted) {
        resolve();
        return;
    }
    const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
});
const safeId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v !== 0;
function privacyOf(msg: TgMessage, s: ReplySnapshot, username: string, atMs: number): ReplyPrivacyOp | undefined {
    if (msg.fromIsBot === true || msg.senderChatId !== undefined || !safeId(msg.fromId) || msg.fromId <= 0)
        return;
    const m = /^\/(forgetme|forget)(?:@([A-Za-z0-9_]+))?(?:\s+(owner))?\s*$/i.exec(msg.text);
    if (!m || (m[2] && m[2].toLowerCase() !== username.toLowerCase()))
        return;
    if (msg.chatId < 0) {
        if (m[3])
            return;
        if (m[1]!.toLowerCase() === "forgetme")
            return { id: randomUUID(), atMs, kind: "person", chatId: msg.chatId, userId: msg.fromId };
        if (msg.fromId === s.ownerId)
            return { id: randomUUID(), atMs, kind: "group", chatId: msg.chatId };
    }
    else if (msg.chatId === msg.fromId && s.allowlist.includes(msg.fromId) && m[1]!.toLowerCase() === "forget") {
        if (m[3])
            return msg.fromId === s.ownerId ? { id: randomUUID(), atMs, kind: "personal-owner" } : undefined;
        return { id: randomUUID(), atMs, kind: "personal-chat", chatId: msg.chatId };
    }
}
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function publicText(msg: TgMessage, s: ReplySnapshot, username: string, firstName?: string): string | null {
    if (!safeId(msg.chatId) || !safeId(msg.fromId) || msg.fromId <= 0 || msg.fromIsBot === true || msg.senderChatId !== undefined)
        return null;
    let text = msg.text.replace(new RegExp(`@${escapeRe(username)}\\b`, "ig"), "").trim();
    if (msg.chatId > 0)
        return msg.chatId === msg.fromId && s.allowlist.includes(msg.fromId) ? text : null;
    if (!s.rooms.includes(msg.chatId))
        return null;
    const names = [username, ...(firstName && /^[A-Za-z][A-Za-z0-9 _-]{0,39}$/.test(firstName) ? [firstName] : [])];
    let named = false;
    for (const name of names) {
        const re = new RegExp(`^${escapeRe(name)}(?:[,:]?[ \t]+)`, "i");
        if (re.test(text)) {
            text = text.replace(re, "");
            named = true;
            break;
        }
    }
    const explicit = new RegExp(`@${escapeRe(username)}\\b`, "i").test(msg.text) || String(msg.replyTo?.fromId) === s.botId || named;
    const parsed = parseRecoveryPublicAsk(text);
    if (!s.groupCoinsEnabled && typeof parsed !== "string" && parsed.ask.kind === "coin")
        return null;
    return explicit || isRecoveryPublicRequest(text) ? text : null;
}
class ReplyDeadline extends Error {
    constructor() {
        super("Reply deadline expired.");
    }
}
/** The bot stream session was lost and cannot be replaced yet: an actor on it is still stopping. Not a failure. */
class ReplyBotSessionRenewing extends Error {
    constructor() {
        super(recoveryReplyRefused().message);
    }
}
async function bounded<T>(work: () => Promise<T>, ms: number, signal?: AbortSignal, onLate?: (value: T) => void): Promise<T> {
    if (ms <= 0)
        throw new ReplyDeadline();
    if (signal?.aborted)
        throw recoveryReplyRefused();
    let expired = false, timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const waiting = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            expired = true;
            reject(new ReplyDeadline());
        }, ms);
        abort = () => {
            expired = true;
            reject(recoveryReplyRefused());
        };
        signal?.addEventListener("abort", abort, { once: true });
    });
    const operation = Promise.resolve().then(work).then(value => {
        if (expired)
            onLate?.(value);
        return value;
    });
    try {
        return await Promise.race([operation, waiting]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        if (abort)
            signal?.removeEventListener("abort", abort);
    }
}
async function transaction<T>(pool: ReplyPool, guard: () => void, fn: (db: ReplyQuery) => Promise<T>, now: () => number = Date.now, deadline = now() + 8000): Promise<T> {
    const check = () => {
        guard();
        if (now() >= deadline)
            throw new ReplyDeadline();
    };
    check();
    const client = await bounded(() => pool.connect(), Math.min(CONNECT_WAIT_MS, deadline - now()), undefined, c => c.release(new ReplyDeadline()));
    let began = false, broken = false;
    // THE CONNECTION DIED WHILE WE HELD IT (a terminated backend, a failover,
    // a reset socket, often while the transaction waits on a Telegram send).
    // Mark it broken so it is discarded on release, and let the next
    // statement fail as itself ("Client has encountered a connection error",
    // 57P01, "Connection terminated"): db-transient weather for this actor.
    const lost = () => {
        broken = true;
    };
    client.on?.("error", lost);
    const db: ReplyQuery = { query: async (sql, values) => {
            check();
            try {
                const result = await bounded(() => client.query(sql, values), Math.min(QUERY_WAIT_MS, deadline - now()));
                check();
                return result;
            }
            catch (e) {
                broken = true;
                throw e;
            }
        } };
    try {
        check();
        await db.query("BEGIN");
        began = true;
        await db.query(`SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='${STATEMENT_TIMEOUT_MS}ms'`);
        const result = await fn(db);
        check();
        await db.query("COMMIT");
        began = false;
        check();
        return result;
    }
    catch (e) {
        if (began && !broken)
            await bounded(() => client.query("ROLLBACK"), QUERY_WAIT_MS).catch(() => {
                broken = true;
            });
        throw e;
    }
    finally {
        // Hand the client back first (pg-pool re-attaches its own idle
        // listener inside release, and destroys a broken client), and only
        // then stop listening: there is no moment with no listener at all.
        client.release(broken ? recoveryReplyRefused() : undefined);
        client.removeListener?.("error", lost);
    }
}
/** Metadata-only coverage; caller must already hold a pinned read-only RR snapshot. */
export async function recoveryReplyCoverage(db: ReplyQuery, dek: Buffer, knownAccount?: string): Promise<{
    rosterCount: number;
    candidates: number;
    knownExample: {
        present: boolean;
        candidate: boolean;
    };
    blocked: number;
}> {
    const { rows } = await db.query("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation");
    if (rows[0]?.readonly !== "on" || rows[0]?.isolation !== "repeatable read")
        throw recoveryReplyRefused();
    if (knownAccount !== undefined && !/^0x[0-9a-f]{40}$/i.test(knownAccount))
        throw recoveryReplyRefused();
    const roster = await readReplyRoster(db);
    let candidates = 0, known = false, knownCandidate = false;
    for (const grant of roster) {
        const snapshot = await readReplySnapshot(db, grant, dek);
        if (snapshot)
            candidates++;
        if (grant.account === knownAccount?.toLowerCase()) {
            known = true;
            knownCandidate = !!snapshot;
        }
    }
    // Candidate means stored public scope only: no live token/lease/poller proof.
    return { rosterCount: roster.length, candidates, knownExample: { present: known, candidate: knownCandidate }, blocked: roster.length - candidates };
}
export async function runRecoveryReplies(options: RecoveryReplyOptions = {}): Promise<"stopped" | "one-pass"> {
    const env = options.env ?? process.env;
    const log = options.log ?? ((stream: "out" | "err", line: string) => stream === "err" ? console.error(line) : console.log(line));
    // Every line below is a fixed reason code, a count, or tenantTag(): an
    // eight-character prefix of an address the roster already validated.
    const say = (line: string) => log("out", `[recovery-replies] ${line}`);
    const alert = (line: string) => log("err", `[recovery-replies] [alert] ${line}`);
    let root: RecoveryReplyRootProof;
    try {
        root = proveRecoveryReplyRoot(env, options.readMountInfo);
    }
    catch {
        throw new RecoveryReplyFleetRefusal("root-proof");
    }
    const groupsOn = () => env.MERRYMEN_TG_GROUPS === undefined || ["1", "true"].includes(env.MERRYMEN_TG_GROUPS.trim().toLowerCase());
    let dek: Buffer;
    try {
        dek = options.dek ?? requireDek();
    }
    catch {
        throw new RecoveryReplyFleetRefusal("dek-invalid");
    }
    if (dek.length !== 32)
        throw new RecoveryReplyFleetRefusal("dek-invalid");
    const fleet = new AbortController(), now = options.now ?? Date.now;
    // `signalled` is a clean stop (SIGTERM, SIGINT, the trusted stop signal);
    // `fatal` is a fleet-wide refusal. Once signalled, nothing that the
    // shutdown itself provokes (a proof read during teardown) becomes a refusal.
    let signalled = false, fatal: ReplyFleetReason | null = null;
    const stop = () => {
        signalled = true;
        fleet.abort();
    };
    const refuse = (reason: ReplyFleetReason): never => {
        if (!signalled && !fatal)
            fatal = reason;
        fleet.abort();
        throw new RecoveryReplyFleetRefusal(reason);
    };
    /** FLEET-WIDE: the root proof and the process-wide stop. Never a tenant's lease. */
    const fleetGuard = () => {
        if (fleet.signal.aborted)
            throw fatal ? new RecoveryReplyFleetRefusal(fatal) : recoveryReplyRefused();
        try {
            root.assert();
        }
        catch {
            refuse("root-proof");
        }
    };
    const checker = (guard: () => void, signal: AbortSignal) => async <T>(fn: () => Promise<T>, deadline = now() + 5000): Promise<T> => {
        guard();
        if (now() >= deadline)
            throw new ReplyDeadline();
        const result = await bounded(fn, deadline - now(), signal);
        guard();
        if (now() >= deadline)
            throw new ReplyDeadline();
        return result;
    };
    const checked = checker(fleetGuard, fleet.signal);
    type OwnedClient = ReplyLeaseClient & {
        connect(): Promise<void>;
    };
    let pool = options.pool, botLeases: { set: RecoveryReplyBotLeases; live: boolean; client: OwnedClient } | null = null;
    /** Sessions this entry opened itself, ended at shutdown. A session is removed once it has been discarded. */
    const ownedClients = new Set<OwnedClient>();
    const seats = new Map<`0x${string}`, ReplySeat>(), releasing = new Set<Promise<unknown>>();
    const alarm = new ReplyConflictAlarm();
    const track = (p: Promise<unknown>) => {
        releasing.add(p);
        void p.finally(() => releasing.delete(p)).catch(() => {
        });
    };
    /**
     * OUR OWN LEASE WORK STILL IN FLIGHT, by key (`tenant:0x…`, `bot:801`): an
     * acquisition whose answer arrived after we stopped waiting, or a release
     * whose unlock has not settled. While one is pending the lease managers
     * refuse a new acquisition of the same lease (a PostgreSQL session lock is
     * reentrant, so they must), and that refusal is OURS: it is reported as
     * `lease-settling`, never as `lease-busy`, which sends an operator looking
     * for another process holding the tenant.
     */
    const inFlight = new Map<string, number>();
    const own = <T>(key: string, work: Promise<T>): Promise<T> => {
        inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
        void work.finally(() => {
            const left = (inFlight.get(key) ?? 1) - 1;
            if (left > 0)
                inFlight.set(key, left);
            else
                inFlight.delete(key);
        }).catch(() => {
        });
        return work;
    };
    const dropBot = async (seat: ReplySeat) => {
        const bot = seat.bot;
        seat.bot = null;
        if (bot)
            await bounded(() => own(`bot:${bot.id}`, bot.lease.release()), 1500).catch(() => {
            });
    };
    const dropLease = async (seat: ReplySeat) => {
        const lease = seat.lease;
        seat.lease = null;
        if (lease)
            await bounded(() => own(`tenant:${seat.tenant}`, lease.release()), 1500).catch(() => {
            });
    };
    /** Bot stream first, then the fence: the reverse of acquisition. Only once the seat has no running actor. */
    const releaseSeat = async (seat: ReplySeat) => {
        if (seats.get(seat.tenant) === seat)
            seats.delete(seat.tenant);
        await dropBot(seat);
        await dropLease(seat);
    };
    // Ends the supervisor's sleep. Between sleeps (during a pass) it is only
    // remembered, so a lease loss or an actor's end that lands mid-pass still
    // gets its own pass straight after, not up to a whole period later.
    let wakePending = false;
    const idleWake = () => {
        wakePending = true;
    };
    let wake = idleWake;
    if (options.stopSignal?.aborted)
        stop();
    options.stopSignal?.addEventListener("abort", stop, { once: true });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
        if (!pool) {
            const driver = "pg", module = await import(driver), Pool = (module.default as unknown as {
                Pool: new (o: unknown) => ReplyPool;
            }).Pool;
            const owned = new Pool({ connectionString: env.DATABASE_URL, max: 16, connectionTimeoutMillis: CONNECT_WAIT_MS, query_timeout: QUERY_WAIT_MS, statement_timeout: STATEMENT_TIMEOUT_MS });
            // AN IDLE CONNECTION THAT DIES IS WEATHER, NOT A CRASH. pg-pool emits
            // 'error' for a client that fails while idle in the pool (a database
            // restart, an idle-connection reaper) and drops it; with no listener
            // that event is an uncaught exception that ends the whole process.
            // The next query simply takes a fresh connection.
            const emitter = owned as unknown as {
                on(event: "error", fn: () => void): void;
                on(event: "connect", fn: (client: { on(event: "error", fn: () => void): void }) => void): void;
            };
            emitter.on("error", () => say("backoff scope=pool reason=db-transient"));
            // AND ONE THAT DIES WHILE CHECKED OUT. pg-pool takes its idle
            // listener off a client it hands out, so every client gets a
            // permanent one of its own the moment the pool creates it. It only
            // absorbs the event: the transaction holding the client marks it
            // broken, its next statement fails as db-transient, and the pool
            // discards it on release. (transaction() attaches its own listener
            // too, which also covers an injected pool.)
            emitter.on("connect", client => client.on("error", () => {}));
            pool = owned;
        }
        const shared: ReplyPool = { connect: () => pool!.connect(), end: () => pool!.end(), query: (sql, values) => checked(() => pool!.query(sql, values), now() + QUERY_WAIT_MS) };
        // THE ONLY ROSTER READ THAT MAY REFUSE THE FLEET: at startup there is no
        // fence yet, so a roster that cannot be read leaves nothing to stand on.
        // Later reads that fail only skip that pass; every actor keeps proving
        // its own row meanwhile.
        //
        // DATABASE WEATHER AT STARTUP IS WAITED OUT, NOT A REFUSAL. A database
        // that is restarting or briefly overloaded (ECONNREFUSED, a pool
        // connect timeout, 57014) would otherwise fail every container start
        // at once and spend Railway's restart attempts until the deploy shows
        // crashed. Nothing is fenced, polled or served until the read
        // succeeds, so waiting here carries no risk, and SIGTERM still ends
        // the wait at once. A roster over its cap, or one that fails for any
        // other reason (a missing table), still refuses. A bounded one-pass
        // run never waits.
        let startRoster: ReplyRosterScan | null = null;
        for (let attempt = 1; !startRoster; attempt++) {
            try {
                startRoster = await checked(() => scanReplyRoster(shared));
            }
            catch (e) {
                if (e instanceof ReplyRosterCapExceeded)
                    refuse("roster-cap");
                if (e instanceof RecoveryReplyFleetRefusal || fleet.signal.aborted)
                    throw e;
                if (options.onePass || !(e instanceof ReplyDeadline || isTransientReplyDbError(e)))
                    return refuse("roster-unreadable");
                const waitMs = replyBackoffMs("db-transient", attempt);
                say(`backoff scope=roster reason=db-transient wait=${Math.round(waitMs / 1000)}s`);
                await wait(waitMs, fleet.signal);
                fleetGuard();
            }
        }
        // Legacy pollers have no bot-id mutex. Holding the complete current roster's
        // tenant leases prevents coexistence with its ordinary workers/holders.
        // Provider-verified removal of old/removed-tenant deployments is still an
        // explicit rollout prerequisite; a local flag cannot prove remote absence.
        //
        // A LOST LEASE SESSION WAKES THE SUPERVISOR; IT NO LONGER STOPS THE FLEET.
        // The lease fleet spreads tenants over eight sessions, so one dropped
        // socket makes only that shard's leases unhealthy. Each affected actor
        // sees its own lease fail in its next guard and stops; the supervisor
        // releases those leases (the manager keeps a lost entry until release)
        // and re-acquires them with back-off.
        let acquireTenant = options.acquireTenant;
        if (!acquireTenant) {
            const driver = "pg", module = await import(driver), Client = (module.default as unknown as {
                Client: new (o: unknown) => import("./recovery-reply-lease").ReplyLeaseClient & {
                    connect(): Promise<void>;
                };
            }).Client;
            const leaseFleet = new PgTenantLeaseFleet(async () => {
                const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: CONNECT_WAIT_MS, query_timeout: QUERY_WAIT_MS, statement_timeout: STATEMENT_TIMEOUT_MS });
                ownedClients.add(client);
                // The lease manager ends a session it discards (its own 'error'
                // and 'end' handlers); forget it then, so a long-lived listener
                // on a database that drops connections now and then does not
                // keep every replaced session until it exits.
                client.on("end", () => ownedClients.delete(client));
                return client;
            }, () => wake());
            acquireTenant = tenant => leaseFleet.acquire(tenant);
        }
        // THE BOT STREAM MUTEX SESSION is one connection. When it is lost every
        // bot lease on it goes unhealthy at once, and the process does not stop:
        //
        //   1. the loss wakes the supervisor, whose pass stops every actor
        //      holding a lease from that session AT ONCE (pass step 2). The
        //      abort also ends an actor sitting in a long in-place wait (a 409
        //      back-off of up to ten minutes, Telegram's retry_after), which
        //      otherwise kept its dead lease and so held up step 3 for every
        //      other bot until its wait ran out;
        //   2. each stopped actor's seat drops its dead lease as it ends, and
        //      wakes the supervisor again (launch);
        //   3. the next admission finds no RUNNING actor on the old session,
        //      drops the dead leases of idle seats (quarantined ones), ends the
        //      old session (which also frees any lock it may still hold when a
        //      failed query, not a dropped socket, marked it lost) and opens a
        //      fresh one.
        //
        // Until step 3 can run, admission waits under its own reason
        // (`bot-session-renewing`) with no back-off, never as db-transient.
        let acquireBot = options.acquireBot;
        if (!acquireBot) {
            const botSession = async (): Promise<RecoveryReplyBotLeases> => {
                if (botLeases?.live)
                    return botLeases.set;
                if (botLeases) {
                    // An actor whose stop is still in flight may be finishing a
                    // Telegram call under a lease of the old session: a new
                    // lease on that bot must not overlap it.
                    if ([...seats.values()].some(seat => seat.actor && seat.bot))
                        throw new ReplyBotSessionRenewing();
                    for (const seat of seats.values())
                        if (seat.bot)
                            await dropBot(seat);
                    const old = botLeases;
                    botLeases = null;
                    await bounded(() => old.set.close(), 1500).catch(() => {
                    });
                    ownedClients.delete(old.client);
                }
                const driver = "pg", module = await import(driver), Client = (module.default as unknown as {
                    Client: new (o: unknown) => OwnedClient;
                }).Client;
                const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: CONNECT_WAIT_MS, query_timeout: QUERY_WAIT_MS, statement_timeout: STATEMENT_TIMEOUT_MS });
                ownedClients.add(client);
                // Before connect, so a socket error while connecting cannot be an
                // uncaught 'error' event; the lease set attaches its own loss handler.
                client.on("error", () => {});
                try {
                    await checked(() => client.connect());
                }
                catch (e) {
                    ownedClients.delete(client);
                    void bounded(() => client.end(), 1500).catch(() => {
                    });
                    throw e;
                }
                const session = { set: null as unknown as RecoveryReplyBotLeases, live: true, client };
                session.set = new RecoveryReplyBotLeases(client, () => {
                    session.live = false;
                    wake();
                });
                botLeases = session;
                return session.set;
            };
            acquireBot = async id => (await botSession()).acquire(id);
        }
        // Created once, lazily, by the first admission that has a candidate; a
        // roster with no available public scope never creates reply tables.
        let schema: Promise<void> | null = null;
        const ensureSchema = () => schema ??= transaction(shared, fleetGuard, async (db) => {
            await db.query(RECOVERY_REPLY_SCHEMA);
        }).catch(e => {
            schema = null;
            throw e;
        });
        const transport = options.transport ?? { getMe, getUpdates, sendMessage, sendPhotoBytes, answerCallbackQuery };
        const reply = options.reply ?? createRecoveryPublicReply({ look: createRecoveryPublicLook(), now });
        let publicWork = 0, responseWork = 0;
        const actor = async (s: ReplySnapshot, seat: ReplySeat, run: ReplyActorRun, lease: TenantLease, bot: ReplyLease) => {
            // EVERYTHING FROM HERE TO THE END OF THE ACTOR IS ONE TENANT'S. guard,
            // checked, authority, opts and controller deliberately shadow the
            // fleet's names: the body below is the listener's reviewed drain and
            // response code, unchanged, and every call it makes now proves THIS
            // tenant's scope and stops only THIS actor.
            const controller = run.controller;
            /** Root proof and fleet stop (fleet-wide), then this actor's stop and its OWN two leases. */
            const guard = () => {
                fleetGuard();
                if (controller.signal.aborted)
                    throw new ReplyActorStop(run.stopReason ?? "stopped");
                if (lease.backend !== "postgres" || !lease.healthy() || !bot.healthy())
                    throw new ReplyActorStop("lease-lost");
            };
            const checked = checker(guard, controller.signal);
            /**
             * ONLY THIS TENANT'S AUTHORITY. assertReplySnapshot re-reads this
             * tenant's own grant row first and compares it with the receipt the
             * roster gave at admission (ReplyGrantChanged when it differs), then
             * its settings, claim, link, held status and rooms. The whole-roster
             * comparison that used to run here is gone: another tenant's grant
             * write is the supervisor's business, never this actor's.
             */
            const authority = async (db: ReplyQuery, s: ReplySnapshot, lock = false) => {
                guard();
                try {
                    await checked(() => assertReplySnapshot(db, s, dek, lock));
                }
                catch (e) {
                    if (controller.signal.aborted || fleet.signal.aborted || e instanceof ReplyActorStop || e instanceof RecoveryReplyFleetRefusal
                        || e instanceof ReplyDeadline || isTransientReplyDbError(e))
                        throw e;
                    throw new ReplyActorStop(e instanceof ReplyGrantChanged ? "roster-changed" : "snapshot-invalid");
                }
            };
            const opts = (s: ReplySnapshot, deadlineAtMs: number): TelegramOpts => ({ token: s.token, timeoutMs: 3000, deadlineAtMs,
                fetchFn: async (input, init) => {
                    guard();
                    return fetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), controller.signal]) });
                } });
            const quarantineProvider = async (s: ReplySnapshot) => {
                await transaction(shared, guard, async (db) => {
                    await authority(db, s, true);
                    await db.query("UPDATE tenant_telegram SET poll_ok_at=NULL,poll_err='getMe refused: reply listener unavailable',poll_err_at=$1,child_state='held:recovery-replies' WHERE tenant=$2 AND bot_id=$3 AND owner_id=$4", [Math.floor(now() / 1000), s.grant.tenant, s.botId, s.ownerId]);
                    await authority(db, s, true);
                }, now);
                // Held until the stored scope changes (a new token or claim); the
                // tenant and bot leases stay with the seat meanwhile.
                seat.quarantined = s.receipt;
            };
            /** What a transport call threw that is neither this actor's stop nor the fleet's: a network fault. */
            const transportFault = (e: unknown) => !(e instanceof ReplyActorStop) && !(e instanceof RecoveryReplyFleetRefusal)
                && !controller.signal.aborted && !fleet.signal.aborted;
            let conflicts = 0, failures = 0;
            /**
             * 409 CONFLICT: something else is reading THIS bot. Mark it on the
             * tenant's existing liveness columns in the poll-rules format the
             * dashboard already reads (`conflict: …`, fixed text, never
             * Telegram's prose: a webhook and another poller each get their
             * own wording), back off this bot alone, and feed the fleet's
             * multi-bot alarm. A webhook 409 is the owner's own setting on
             * their own bot, never a second poller fleet, so it is never fed
             * to the alarm. When the alarm trips, the fleet PAUSES (pauseFleet
             * below): every actor stops, every lease is kept, no exit.
             */
            const conflicted = async (s: ReplySnapshot, reason: string | undefined) => {
                conflicts++;
                const waitMs = replyBackoffMs("telegram-409", conflicts);
                alert(`backoff tenant=${tenantTag(s.grant.tenant)} reason=telegram-409 wait=${Math.round(waitMs / 1000)}s`);
                const serving = [...seats.values()].filter(seat => seat.actor).length;
                const tripped = !isWebhookConflict(reason) && alarm.conflict(s.botId, Date.now(), serving);
                try {
                    await transaction(shared, guard, async (db) => {
                        await authority(db, s, true);
                        await db.query("UPDATE tenant_telegram SET poll_ok_at=NULL,poll_err=$1,poll_err_at=$2,child_state='held:recovery-replies' WHERE tenant=$3 AND bot_id=$4 AND owner_id=$5", [pollFailure({ reason, errorCode: 409 }, conflicts).err, Math.floor(now() / 1000), s.grant.tenant, s.botId, s.ownerId]);
                        await authority(db, s, true);
                    }, now);
                }
                finally {
                    // After this bot's own mark (or its failure): the pause
                    // stops this actor too, and its mark should land first.
                    if (tripped)
                        pauseFleet(serving);
                }
                if (!options.onePass)
                    await wait(waitMs, controller.signal);
            };
            /** Any other failed transport call: this bot waits, 2s doubling to 60s, or Telegram's retry_after. */
            const failed = async (s: ReplySnapshot, retryAfter?: number, code?: number) => {
                failures++;
                const waitMs = replyBackoffMs("telegram-network", failures, retryAfter);
                say(`backoff tenant=${tenantTag(s.grant.tenant)} reason=telegram-network${Number.isSafeInteger(code) && code! > 0 && code! < 1000 ? ` code=${code}` : ""} wait=${Math.round(waitMs / 1000)}s`);
                if (!options.onePass)
                    await wait(waitMs, controller.signal);
            };
            /**
             * A clean poll ends both Telegram streaks and this bot's standing
             * 409. It is NOT yet progress: that waits for the drain to commit
             * (below), so a drain that keeps failing backs off longer each time.
             */
            const cleanPoll = (s: ReplySnapshot) => {
                conflicts = failures = 0;
                alarm.clear(s.botId);
            };
            let me: Awaited<ReturnType<typeof getMe>>;
            do {
                await authority(shared, s);
                try {
                    me = await checked(() => transport.getMe(opts(s, now() + 5000)));
                }
                catch (e) {
                    if (!(e instanceof ReplyDeadline)) {
                        if (!transportFault(e))
                            throw e;
                        await failed(s);
                        if (options.onePass)
                            return;
                        continue;
                    }
                    if (options.onePass)
                        return;
                    await wait(2000, controller.signal);
                    continue;
                }
                if (me.bot) {
                    if (String(me.bot.id) !== s.botId || !me.bot.username || !/^[A-Za-z0-9_]{1,64}$/.test(me.bot.username)) {
                        await quarantineProvider(s);
                        return;
                    }
                    failures = 0;
                    break;
                }
                if (me.errorCode === 401 || me.errorCode === 404) {
                    await quarantineProvider(s);
                    return;
                }
                if (me.errorCode === 409) {
                    await conflicted(s, me.reason);
                    if (options.onePass)
                        return;
                    continue;
                }
                await failed(s, undefined, me.errorCode);
                if (options.onePass)
                    return;
            } while (!controller.signal.aborted);
            if (!me!.bot)
                throw recoveryReplyRefused();
            const username = me!.bot.username, firstName = me!.bot.firstName;
            let state = await transaction(shared, guard, async (db) => {
                await authority(db, s, true);
                const result = await bindReplyOffset(db, s, now());
                await authority(db, s, true);
                return result;
            }, now);
            do {
                await authority(shared, s);
                const askedAt = now();
                let polled: Awaited<ReturnType<typeof getUpdates>>;
                try {
                    polled = await checked(() => transport.getUpdates(opts(s, askedAt + 8000), state.offset, 2), askedAt + 8000);
                }
                catch (e) {
                    if (!(e instanceof ReplyDeadline)) {
                        if (!transportFault(e))
                            throw e;
                        await failed(s);
                        if (options.onePass)
                            return;
                        continue;
                    }
                    if (options.onePass)
                        return;
                    await wait(500, controller.signal);
                    continue;
                }
                await authority(shared, s);
                if (polled.reason) {
                    if (polled.errorCode === 401 || polled.errorCode === 404) {
                        await quarantineProvider(s);
                        return;
                    }
                    if (polled.errorCode === 409) {
                        await conflicted(s, polled.reason);
                        if (options.onePass)
                            return;
                        continue;
                    }
                    await failed(s, polled.retryAfter, polled.errorCode);
                    if (options.onePass)
                        return;
                    continue;
                }
                cleanPoll(s);
                const units: {
                    id: number;
                    msg?: TgMessage;
                    cb?: TgCallback;
                    privacy?: ReplyPrivacyOp;
                }[] = [...polled.messages.map(msg => ({ id: msg.updateId, msg })), ...polled.callbacks.map(cb => ({ id: cb.updateId, cb })),
                    ...polled.members.map(u => ({ id: u.updateId })), ...polled.service.map(u => ({ id: u.updateId }))].sort((a, b) => a.id - b.id).filter(u => u.id >= state.offset);
                if (units.length > 100 || units.some((u, i) => !Number.isSafeInteger(u.id) || u.id < 0 || u.id >= Number.MAX_SAFE_INTEGER || (i > 0 && units[i - 1]!.id === u.id))
                    || !Number.isSafeInteger(polled.nextOffset) || polled.nextOffset < state.offset || units.some(u => u.id >= polled.nextOffset))
                    throw recoveryReplyRefused();
                for (const unit of units)
                    if (unit.msg)
                        unit.privacy = privacyOf(unit.msg, s, username, now());
                // Coalesce the drain into one bounded transaction. Privacy is durable before
                // any acknowledgement; ignored/raw updates advance the same stream cutoff.
                const previousOffset = state.offset;
                await transaction(shared, guard, async (db) => {
                    await authority(db, s, true);
                    let cutoff = state.offset;
                    for (const unit of units)
                        if (unit.privacy) {
                            await advanceReplyOffset(db, s, dek, unit.id + 1, now(), [], unit.privacy);
                            cutoff = unit.id + 1;
                        }
                    if (polled.nextOffset > cutoff)
                        await advanceReplyOffset(db, s, dek, polled.nextOffset, now());
                    await db.query("UPDATE tenant_telegram SET poll_ok_at=$1,poll_err=NULL,poll_err_at=NULL,child_state='held:recovery-replies' WHERE tenant=$2 AND bot_id=$3 AND owner_id=$4 AND linked_at IS NOT NULL", [Math.floor(now() / 1000), s.grant.tenant, s.botId, s.ownerId]);
                    await authority(db, s, true);
                }, now, Math.min(askedAt + 15000, now() + 8000));
                state = { ...state, offset: polled.nextOffset };
                // COMMITTED: the cursor moved. Only now does this count as
                // progress, ending serve()'s in-place streak and the seat's
                // admission streak.
                seat.progress++;
                seat.streak = 0;
                const jobs = units.map(unit => ({ unit, deadline: unit.msg && Number.isSafeInteger(unit.msg.date) && unit.msg.date > 0 ? Math.min(askedAt + 30000, unit.msg.date * 1000 + 30000) : askedAt + 30000 }))
                    .filter(({ unit, deadline }) => deadline > now() && (!unit.msg || unit.msg.date >= state.armedAt));
                const respond = async ({ unit, deadline }: typeof jobs[number], overload = false) => {
                    const msg = unit.msg;
                    let text: string | null = null, result: {
                        text: string;
                        photo?: Uint8Array;
                    } | undefined;
                    if (unit.privacy) {
                        text = "Your forget request was applied to retained shared memory. Historical local memory stays held until its privacy proof is reconciled.";
                    }
                    else if (unit.cb) {
                        const cb = unit.cb;
                        if (cb.chatId !== cb.fromId || !s.allowlist.includes(cb.fromId))
                            return;
                        await transaction(shared, guard, async (db) => {
                            await authority(db, s, true);
                            await checked(() => transport.answerCallbackQuery(opts(s, deadline), cb.id, RECOVERY_PUBLIC_BUTTON_HELD), deadline);
                            await authority(db, s, true);
                        }, now, Math.min(deadline, now() + 5000));
                        return;
                    }
                    else {
                        if (!msg)
                            return;
                        if (msg.chatId < 0 && !groupsOn())
                            return;
                        const question = publicText(msg, s, username, firstName);
                        if (question === null)
                            return;
                        const fixed = overload ? RECOVERY_PUBLIC_BUSY : /^\/(?:start|help|status)\s*$/i.test(question) ? RECOVERY_PUBLIC_HELP : question.startsWith("/") && !/^\/(?:chart|lore|market)\b/i.test(question) ? RECOVERY_PUBLIC_HELD : null;
                        if (fixed)
                            text = fixed;
                        else if (publicWork >= 8)
                            text = RECOVERY_PUBLIC_BUSY;
                        else {
                            publicWork++;
                            try {
                                await checked(() => authority(shared, s), Math.min(deadline - 5000, now() + 5000));
                                try {
                                    result = await checked(() => reply({ text: question, deadlineMs: deadline, signal: controller.signal }), Math.min(deadline - 5000, now() + 11000));
                                }
                                catch (e) {
                                    if (!(e instanceof ReplyDeadline))
                                        throw e;
                                    result = { text: RECOVERY_PUBLIC_UNAVAILABLE };
                                }
                            }
                            finally {
                                publicWork--;
                            }
                        }
                    }
                    if (now() >= deadline || !msg)
                        return;
                    result ??= { text: text! };
                    await transaction(shared, guard, async (db) => {
                        await authority(db, s, true);
                        let sent: Awaited<ReturnType<typeof sendMessage>>;
                        if (result!.photo) {
                            sent = await checked(() => transport.sendPhotoBytes(opts(s, deadline), msg.chatId, result!.photo!, esc(result!.text), { replyToMessageId: msg.messageId }), deadline);
                            if (!sent.ok && sent.noDelivery === true && now() < deadline) {
                                await authority(db, s, true);
                                sent = await checked(() => transport.sendMessage(opts(s, deadline), msg.chatId, esc(result!.text), { replyToMessageId: msg.messageId }), deadline);
                            }
                        }
                        else
                            sent = await checked(() => transport.sendMessage(opts(s, deadline), msg.chatId, esc(result!.text), { replyToMessageId: msg.messageId }), deadline);
                        if (!sent.ok)
                            console.warn(sent.noDelivery === true
                                ? "Reply-only Telegram send refused without delivery; update remains acknowledged."
                                : "Reply-only Telegram send delivery unconfirmed; update remains acknowledged.");
                        await authority(db, s, true);
                    }, now, Math.min(deadline, now() + 5000));
                };
                // No queue grows beyond a Telegram batch. Public jobs have eight slots;
                // one stalled lookup/send cannot consume the other bots' actors or clocks.
                const actionable = jobs.filter(({ unit }) => unit.privacy || unit.cb || (unit.msg && (unit.msg.chatId > 0 || groupsOn()) && publicText(unit.msg, s, username, firstName) !== null)).slice(0, 16);
                const results = await Promise.allSettled(actionable.map(async (job, i) => {
                    // No fleet-wide lookup/render/send queue. Privacy is already durable even
                    // when overload cannot admit another nonfinancial acknowledgement.
                    if (responseWork >= 32)
                        return;
                    responseWork++;
                    try {
                        await respond(job, i >= 8);
                    }
                    finally {
                        responseWork--;
                    }
                }));
                // The first real failure, as itself: an authority change found while
                // answering stops this actor under that change's own reason.
                const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected" && !(r.reason instanceof ReplyDeadline));
                if (rejected)
                    throw rejected.reason;
                if (options.onePass)
                    return;
                if (!actionable.length && polled.nextOffset > previousOffset)
                    continue;
                await wait(500, controller.signal);
            } while (!controller.signal.aborted);
        };
        /**
         * ONE ACTOR, RETRIED IN PLACE ON DATABASE WEATHER. A transient failure (a
         * statement timeout, NOWAIT meeting the web's write to this tenant's row,
         * a dropped connection) or one of this listener's own bounded waits
         * expiring outside a Telegram call restarts this actor's loop after a
         * back-off. It keeps its seat and both leases, and re-proves its scope,
         * the bot's identity and its stream offset from the start. Nothing is
         * replayed: the cursor only ever moves inside a committed drain, and an
         * update it had not committed is simply polled again. Anything else ends
         * the actor; the supervisor decides about re-admission.
         */
        const serve = async (s: ReplySnapshot, seat: ReplySeat, run: ReplyActorRun, lease: TenantLease, bot: ReplyLease): Promise<void> => {
            let streak = 0, seen = seat.progress;
            for (;;) {
                try {
                    return await actor(s, seat, run, lease, bot);
                }
                catch (e) {
                    const kind = e instanceof ReplyDeadline ? "deadline" : isTransientReplyDbError(e) ? "db-transient" : null;
                    if (!kind || options.onePass || run.controller.signal.aborted || fleet.signal.aborted)
                        throw e;
                    streak = seat.progress !== seen ? 1 : streak + 1;
                    seen = seat.progress;
                    const waitMs = replyBackoffMs(kind, streak);
                    say(`backoff tenant=${tenantTag(s.grant.tenant)} reason=${kind} wait=${Math.round(waitMs / 1000)}s`);
                    await wait(waitMs, run.controller.signal);
                    if (run.controller.signal.aborted)
                        return;
                }
            }
        };
        const stopActor = (seat: ReplySeat, reason: ReplyStopReason) => {
            if (seat.actor && !seat.actor.stopReason) {
                seat.actor.stopReason = reason;
                seat.actor.controller.abort();
            }
        };
        /**
         * THE MULTI-BOT 409 ALARM TRIPPED: most bots this listener serves met a
         * new conflict at once, the signature of a lease-less poller fleet
         * beside it. Stop polling EVERY bot for a while, loudly, in ONE line —
         * but keep every tenant lease (the fence) and every bot lease, and do
         * not exit: an exit would hand each fenced tenant to that other fleet
         * and spend a restart, and it would not stop the other poller anyway.
         * The supervisor admits nobody until the pause ends, then re-admits
         * everyone; the conflicts that tripped it are spent and cannot trip
         * it again while they stand, so after one pause each conflicted bot
         * is back to its own 409 back-off and alert lines.
         */
        let pausedUntil = 0;
        const pauseFleet = (serving: number) => {
            if (Date.now() < pausedUntil)
                return;
            const ms = Math.max(1, options.conflictPauseMs ?? CONFLICT_PAUSE_MS);
            pausedUntil = Date.now() + ms;
            alert(`fleet-pause reason=telegram-409-fleet bots=${alarm.size} serving=${serving} wait=${Math.round(ms / 1000)}s`);
            for (const seat of seats.values())
                stopActor(seat, "fleet-paused");
            wake();
        };
        /** Re-admission back-off, per seat. A change is re-admitted on the next pass; a failure waits. */
        const admitWait = (seat: ReplySeat, kind: ReplyBackoffKind, reason: ReplyStopReason, line = "admit-wait") => {
            seat.streak++;
            const ms = replyBackoffMs(kind, seat.streak);
            seat.retryAt = Date.now() + ms;
            alert(`${line} tenant=${tenantTag(seat.tenant)} reason=${reason} retry=${Math.round(ms / 1000)}s`);
        };
        const STOP_BACKOFF: Partial<Record<ReplyStopReason, ReplyBackoffKind>> = { "lease-lost": "admission", "db-transient": "db-transient", "actor-error": "actor-error" };
        const ROUTINE_STOP: ReadonlySet<ReplyStopReason> = new Set<ReplyStopReason>(["roster-changed", "roster-removed", "snapshot-invalid", "stopped"]);
        const launch = (seat: ReplySeat, s: ReplySnapshot, lease: TenantLease, bot: ReplyLease) => {
            const run: ReplyActorRun = { controller: new AbortController(), receipt: s.grant.receipt, done: Promise.resolve() };
            const follow = () => run.controller.abort();
            fleet.signal.addEventListener("abort", follow, { once: true });
            seat.actor = run;
            say(`actor-start tenant=${tenantTag(seat.tenant)}`);
            run.done = serve(s, seat, run, lease, bot).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error })).then(async outcome => {
                fleet.signal.removeEventListener("abort", follow);
                if (seat.actor === run)
                    seat.actor = null;
                // A shutdown or a fleet refusal is ONE line, from the entry, not one per actor.
                if (fleet.signal.aborted)
                    return;
                const reason: ReplyStopReason | null = run.stopReason ?? (outcome.ok
                    ? (seat.quarantined === s.receipt ? "telegram-refused" : null)
                    : outcome.error instanceof ReplyActorStop ? outcome.error.reason
                        : outcome.error instanceof ReplyDeadline || isTransientReplyDbError(outcome.error) ? "db-transient" : "actor-error");
                // null: a bounded one-pass iteration that simply finished.
                // fleet-paused: the pause printed the one fleet line already.
                if (reason !== null && reason !== "fleet-paused") {
                    const kind = STOP_BACKOFF[reason];
                    if (kind)
                        admitWait(seat, kind, reason, "actor-stop");
                    else
                        (ROUTINE_STOP.has(reason) ? say : alert)(`actor-stop tenant=${tenantTag(seat.tenant)} reason=${reason}`);
                }
                if (seat.retiring)
                    await releaseSeat(seat);
                else if (seat.bot && !seat.bot.lease.healthy()) {
                    // A lease from a lost bot stream session goes with its
                    // actor, at once: the session is replaced only when no
                    // running actor still holds one, and the seats waiting on
                    // that replacement are admitted by the pass this wakes.
                    await dropBot(seat);
                    wake();
                }
            }).catch(() => {
            });
        };
        /**
         * A lease acquisition bounded like every other call, whose LATE answer is
         * released rather than leaked: a lock granted after we stopped waiting
         * would otherwise sit on our session, untracked, fencing that tenant
         * against ourselves until the process ends.
         */
        const acquired = async <T extends { release(): Promise<void> }>(key: string, fn: () => Promise<T | null>): Promise<T | null> => {
            fleetGuard();
            // The acquisition and any release of a late or unwanted answer are
            // OUR lease work on `key` until they settle (inFlight above).
            const held = await bounded(() => own(key, fn()), CONNECT_WAIT_MS + QUERY_WAIT_MS, fleet.signal, late => {
                if (late)
                    track(bounded(() => own(key, late.release()), 1500).catch(() => {
                    }));
            });
            try {
                fleetGuard();
            }
            catch (e) {
                if (held)
                    track(bounded(() => own(key, held.release()), 1500).catch(() => {
                    }));
                throw e;
            }
            return held;
        };
        const passFailure = (e: unknown) => e instanceof RecoveryReplyFleetRefusal || fleet.signal.aborted;
        const fenceSeat = async (seat: ReplySeat) => {
            const key = `tenant:${seat.tenant}`;
            // Our own late acquisition or unsettled release of this very lease:
            // asking now would only meet ourselves.
            if (inFlight.has(key))
                return admitWait(seat, "admission", "lease-settling");
            let lease: TenantLease | null;
            try {
                lease = await acquired(key, () => acquireTenant!(seat.tenant));
            }
            catch (e) {
                if (passFailure(e))
                    throw e;
                return admitWait(seat, "admission", "db-transient");
            }
            if (!lease)
                return admitWait(seat, "admission", "lease-busy");
            if (lease.tenant !== seat.tenant || lease.backend !== "postgres" || !lease.healthy()) {
                await bounded(() => own(key, lease!.release()), 1500).catch(() => {
                });
                return admitWait(seat, "admission", "lease-lost");
            }
            seat.lease = lease;
            seat.streak = 0;
        };
        /**
         * ADMIT ONE TENANT: a fresh snapshot of its stored public scope, its bot
         * stream lease, the reply tables, then an actor. The tenant lease is
         * already held (the fence). Each failure costs this seat a back-off and
         * nothing else.
         */
        const admit = async (seat: ReplySeat, grant: ReplyGrant) => {
            let s: ReplySnapshot | null;
            try {
                s = await checked(() => readReplySnapshot(shared, grant, dek));
            }
            catch (e) {
                if (passFailure(e))
                    throw e;
                // Changed since this pass read the roster: the next pass reads it again.
                if (e instanceof ReplyGrantChanged)
                    return;
                if (e instanceof ReplyDeadline || isTransientReplyDbError(e))
                    return admitWait(seat, "db-transient", "db-transient");
                // Corrupt or unknown stored scope: this tenant is never served on a guess.
                return admitWait(seat, "actor-error", "snapshot-invalid");
            }
            if (!s) {
                // Explicitly unavailable scope: fenced, never served, and its bot
                // stream is not ours to hold.
                seat.unavailable = true;
                await dropBot(seat);
                return;
            }
            seat.unavailable = false;
            if (seat.quarantined !== s.receipt)
                seat.quarantined = null;
            if (seat.bot && (seat.bot.id !== s.botId || !seat.bot.lease.healthy()))
                await dropBot(seat);
            // The bot stream lease comes BEFORE the quarantine check: a
            // quarantined bot stays fenced, and after a lost bot stream session
            // its lease is taken again here like everyone else's.
            if (!seat.bot) {
                const botId = s.botId, key = `bot:${botId}`;
                // Never two of our own seats on one bot stream (a claim that moved
                // between tenants while the old actor still runs): one actor per bot.
                if ([...seats.values()].some(other => other !== seat && other.bot?.id === botId))
                    return admitWait(seat, "admission", "bot-busy");
                if (inFlight.has(key))
                    return admitWait(seat, "admission", "lease-settling");
                let hold: ReplyLease | null;
                try {
                    hold = await acquired(key, () => acquireBot!(botId));
                }
                catch (e) {
                    if (passFailure(e))
                        throw e;
                    // Not a failure: the lost session's last actors are still
                    // stopping. No back-off; the pass their end wakes retries.
                    if (e instanceof ReplyBotSessionRenewing) {
                        say(`admit-wait tenant=${tenantTag(seat.tenant)} reason=bot-session-renewing`);
                        return;
                    }
                    return admitWait(seat, "admission", "db-transient");
                }
                if (!hold)
                    return admitWait(seat, "admission", "bot-busy");
                if (!hold.healthy()) {
                    await bounded(() => own(key, hold!.release()), 1500).catch(() => {
                    });
                    return admitWait(seat, "admission", "lease-lost");
                }
                seat.bot = { id: botId, lease: hold };
            }
            if (seat.quarantined === s.receipt)
                return;
            try {
                await ensureSchema();
            }
            catch (e) {
                if (passFailure(e))
                    throw e;
                return admitWait(seat, "db-transient", "db-transient");
            }
            fleetGuard();
            if (!seat.lease?.healthy() || !seat.bot.lease.healthy() || seat.actor || seat.retiring)
                return;
            launch(seat, s, seat.lease, seat.bot.lease);
        };
        const skipAlerted = new Set<string>();
        let unnamedAlerted = 0, statsAt = 0;
        /** Counts only, every REPLY_STATS_EVERY_MS and after the first pass. */
        const stats = (scan: ReplyRosterScan) => {
            if (Date.now() - statsAt < REPLY_STATS_EVERY_MS)
                return;
            statsAt = Date.now();
            const all = [...seats.values()], count = (f: (seat: ReplySeat) => unknown) => all.filter(f).length;
            say(`stats roster=${scan.tenants.length} fenced=${count(x => x.lease?.healthy())} actors=${count(x => x.actor)} unavailable=${count(x => x.unavailable)} quarantined=${count(x => x.quarantined !== null)} waiting=${count(x => !x.actor && x.retryAt > Date.now())} skipped=${scan.skipped.length + scan.unnamed} conflicts=${alarm.size} paused=${Date.now() < pausedUntil ? 1 : 0}`);
        };
        /**
         * ONE SUPERVISOR PASS: read the roster row by row, release tenants that
         * left, hold the fence for every tenant present, stop actors whose own
         * row changed, and admit every eligible tenant without an actor. Only the
         * fleet-wide conditions throw out of a pass; everything else is one
         * seat's back-off or one line.
         */
        const pass = async (scan?: ReplyRosterScan) => {
            fleetGuard();
            if (!scan) {
                try {
                    scan = await checked(() => scanReplyRoster(shared));
                }
                catch (e) {
                    if (e instanceof ReplyRosterCapExceeded)
                        refuse("roster-cap");
                    if (passFailure(e))
                        throw e;
                    // Not a changed roster, an unreadable one: actors keep proving
                    // their own rows and the next pass reads again.
                    if (e instanceof ReplyDeadline || isTransientReplyDbError(e))
                        say("backoff scope=roster reason=db-transient");
                    else
                        alert("roster-unreadable scope=roster");
                    return;
                }
            }
            for (const t of scan.skipped)
                if (!skipAlerted.has(t)) {
                    skipAlerted.add(t);
                    alert(`roster-row-skipped tenant=${tenantTag(t)}`);
                }
            for (const t of skipAlerted)
                if (!scan.skipped.includes(t as `0x${string}`))
                    skipAlerted.delete(t);
            if (scan.unnamed !== unnamedAlerted) {
                unnamedAlerted = scan.unnamed;
                if (scan.unnamed)
                    alert(`roster-row-skipped tenant=? rows=${scan.unnamed}`);
            }
            const fence = new Set(scan.tenants), admissible = new Map(scan.grants.map(g => [g.tenant, g] as const));
            // 1. Tenants that left the roster: stop, then release once stopped.
            for (const seat of [...seats.values()])
                if (!fence.has(seat.tenant) && !seat.retiring) {
                    seat.retiring = true;
                    if (seat.actor)
                        stopActor(seat, "roster-removed");
                    else {
                        say(`release tenant=${tenantTag(seat.tenant)} reason=roster-removed`);
                        track(releaseSeat(seat));
                    }
                }
            // 2. The fence: every tenant present, malformed row or not.
            for (const tenant of scan.tenants) {
                fleetGuard();
                let seat = seats.get(tenant);
                if (!seat)
                    seats.set(tenant, seat = { tenant, lease: null, bot: null, actor: null, quarantined: null, unavailable: false, retryAt: 0, streak: 0, progress: 0, retiring: false });
                if (seat.retiring)
                    continue;
                const leaseLost = !!seat.lease && (seat.lease.backend !== "postgres" || !seat.lease.healthy());
                const botLost = !!seat.bot && !seat.bot.lease.healthy();
                // Either of an actor's two leases gone: stop it NOW. Its guard
                // would refuse its next step anyway, but an actor waiting out a
                // long back-off takes no step, and while it holds a lease of a
                // lost bot stream session no other bot can be re-admitted.
                if (seat.actor && (leaseLost || botLost)) {
                    stopActor(seat, "lease-lost");
                    continue;
                }
                if (leaseLost)
                    await dropLease(seat);
                if (botLost)
                    await dropBot(seat);
                if (!seat.lease && !seat.actor && Date.now() >= seat.retryAt)
                    await fenceSeat(seat);
            }
            // 3. An actor whose own row changed, went bad or became ambiguous.
            for (const seat of seats.values()) {
                const grant = admissible.get(seat.tenant);
                if (seat.actor && !seat.retiring && (!grant || grant.receipt !== seat.actor.receipt))
                    stopActor(seat, "roster-changed");
            }
            // 4. Admission, unless the multi-bot 409 alarm paused the fleet:
            //    the fence above is still held throughout a pause.
            for (const grant of Date.now() < pausedUntil ? [] : scan.grants) {
                fleetGuard();
                const seat = seats.get(grant.tenant);
                if (!seat || seat.retiring || seat.actor || !seat.lease?.healthy() || Date.now() < seat.retryAt)
                    continue;
                await admit(seat, grant);
            }
            stats(scan);
        };
        await pass(startRoster);
        if (options.onePass) {
            // Bounded: every admitted actor runs one iteration and returns.
            for (let running = [...seats.values()].flatMap(seat => seat.actor ? [seat.actor.done] : []); running.length;
                running = [...seats.values()].flatMap(seat => seat.actor ? [seat.actor.done] : []))
                await Promise.allSettled(running);
        }
        else {
            const every = Math.max(1, options.supervisorEveryMs ?? REPLY_SUPERVISOR_EVERY_MS);
            /**
             * HOW LONG TO SLEEP: the period, or less when something is due
             * sooner — a pause ending, or a waiting seat's admission back-off
             * (5s after a lost lease, 2s after database weather). Without this
             * every back-off shorter than the period was really the period: a
             * tenant whose lease dropped waited up to thirty seconds, not five.
             * Each early pass is one roster read; the soonest it can come is
             * the shortest back-off, two seconds.
             */
            const sleepMs = () => {
                const at = Date.now();
                let due = at + every;
                if (pausedUntil > at)
                    due = Math.min(due, pausedUntil + 1);
                else
                    for (const seat of seats.values())
                        if (!seat.actor && !seat.retiring && seat.retryAt > at)
                            due = Math.min(due, seat.retryAt + 1);
                return Math.max(1, due - at);
            };
            while (!fleet.signal.aborted) {
                await new Promise<void>(resolve => {
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    const done = () => {
                        clearTimeout(timer);
                        wake = idleWake;
                        fleet.signal.removeEventListener("abort", done);
                        resolve();
                    };
                    wake = done;
                    fleet.signal.addEventListener("abort", done, { once: true });
                    if (wakePending) {
                        wakePending = false;
                        done();
                        return;
                    }
                    timer = setTimeout(done, sleepMs());
                });
                if (fleet.signal.aborted)
                    break;
                try {
                    await pass();
                }
                catch (e) {
                    if (passFailure(e))
                        break;
                    refuse("supervisor-error");
                }
            }
        }
    }
    catch (e) {
        // A clean stop swallows whatever the stop itself interrupted.
        if (!signalled || fatal)
            throw fatal ? new RecoveryReplyFleetRefusal(fatal) : e;
    }
    finally {
        fleet.abort();
        options.stopSignal?.removeEventListener("abort", stop);
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        // Every actor ends before any lease goes: none may still be polling a
        // bot or touching a tenant whose fence is being released.
        const running = [...seats.values()].flatMap(seat => seat.actor ? [seat.actor.done] : []);
        await Promise.allSettled(running.map(done => bounded(() => done, 15_000)));
        await Promise.allSettled([...releasing]);
        // In parallel, each bounded: a fleet of seats on an unreachable database
        // must still finish well inside the platform's draining time (and
        // ending the sessions below releases every lock on them regardless).
        await Promise.allSettled([...seats.values()].map(releaseSeat));
        if (botLeases)
            await bounded(() => botLeases!.set.close(), 1500).catch(() => {
            });
        await Promise.allSettled([...ownedClients].map(client => bounded(() => client.end(), 1500)));
        if (pool && !options.pool)
            await bounded(() => pool!.end(), 1500).catch(() => {
            });
    }
    if (fatal)
        throw new RecoveryReplyFleetRefusal(fatal);
    return signalled ? "stopped" : "one-pass";
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    // ONE LAST LINE, by how it ended: a clean stop on SIGTERM exits 0 with its
    // own line; a refusal exits 1 and names its fleet reason. Railway restarts
    // only the second (ON_FAILURE), and the line says which one happened.
    runRecoveryReplies().then(() => recoveryReplyExitLine({ stopped: true }), (error: unknown) => recoveryReplyExitLine({ error })).then(({ line, code }) => {
        (code ? console.error : console.log)(line);
        process.exitCode = code;
        // The leases are released; nothing should keep the loop alive now. If
        // something does, it must not hold a stopped listener's process open.
        setTimeout(() => process.exit(code), 5_000).unref();
    });
}
