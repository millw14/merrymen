/** Separate public Telegram listener. This entry never runs an orchestrator or worker. */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { requireDek } from "./store-crypto";
import { PgTenantLeaseFleet, type TenantLease } from "./tenant-lease";
import { proveRecoveryReplyRoot, recoveryReplyRefused, type RecoveryReplyRootProof } from "./recovery-reply-proof";
import { RECOVERY_REPLY_SCHEMA, type ReplyPrivacyOp } from "./recovery-reply-state";
import { assertReplySnapshot, advanceReplyOffset, bindReplyOffset, readReplyRoster, readReplySnapshot, type ReplyQuery, type ReplySnapshot, type ReplyGrant } from "./recovery-reply-store";
import { RecoveryReplyBotLeases, type ReplyLease } from "./recovery-reply-lease";
import { getMe, getUpdates, sendMessage, sendPhotoBytes, esc, answerCallbackQuery, type TgMessage, type TgCallback, type TelegramOpts } from "./telegram/api";
import { createRecoveryPublicReply, RECOVERY_PUBLIC_HELP, RECOVERY_PUBLIC_HELD, RECOVERY_PUBLIC_UNAVAILABLE, RECOVERY_PUBLIC_BUSY, RECOVERY_PUBLIC_BUTTON_HELD, isRecoveryPublicRequest, parseRecoveryPublicAsk } from "./telegram/recovery-public-reply";
import { createRecoveryPublicLook } from "./telegram/recovery-public-transport";
interface ReplyConnection extends ReplyQuery {
    release(error?: Error): void;
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
    /** Trusted local-test bounded invocation. Never enabled by environment. */
    onePass?: true;
    /** Trusted shutdown input; cannot enable a mode or relax any proof. */
    stopSignal?: AbortSignal;
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
    const client = await bounded(() => pool.connect(), Math.min(1500, deadline - now()), undefined, c => c.release(new ReplyDeadline()));
    let began = false, broken = false;
    const db: ReplyQuery = { query: async (sql, values) => {
            check();
            try {
                const result = await bounded(() => client.query(sql, values), Math.min(1500, deadline - now()));
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
        await db.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='1000ms'");
        const result = await fn(db);
        check();
        await db.query("COMMIT");
        began = false;
        check();
        return result;
    }
    catch (e) {
        if (began && !broken)
            await bounded(() => client.query("ROLLBACK"), 1500).catch(() => {
                broken = true;
            });
        throw e;
    }
    finally {
        client.release(broken ? recoveryReplyRefused() : undefined);
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
export async function runRecoveryReplies(options: RecoveryReplyOptions = {}): Promise<void> {
    const env = options.env ?? process.env, root: RecoveryReplyRootProof = proveRecoveryReplyRoot(env, options.readMountInfo);
    const groupsOn = () => env.MERRYMEN_TG_GROUPS === undefined || ["1", "true"].includes(env.MERRYMEN_TG_GROUPS.trim().toLowerCase());
    const dek = options.dek ?? requireDek();
    if (dek.length !== 32)
        throw recoveryReplyRefused();
    const controller = new AbortController(), now = options.now ?? Date.now;
    let pool = options.pool, botLeases: RecoveryReplyBotLeases | null = null;
    const ownedClients: (import("./recovery-reply-lease").ReplyLeaseClient & {
        connect(): Promise<void>;
    })[] = [];
    const tenantLeases: TenantLease[] = [], botHolds: ReplyLease[] = [];
    const stop = () => controller.abort();
    const guard = () => {
        root.assert();
        if (controller.signal.aborted || tenantLeases.some(l => l.backend !== "postgres" || !l.healthy()) || botHolds.some(l => !l.healthy()))
            throw recoveryReplyRefused();
    };
    const checked = async <T>(fn: () => Promise<T>, deadline = now() + 5000): Promise<T> => {
        guard();
        if (now() >= deadline)
            throw new ReplyDeadline();
        const result = await bounded(fn, deadline - now(), controller.signal);
        guard();
        if (now() >= deadline)
            throw new ReplyDeadline();
        return result;
    };
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
            pool = new Pool({ connectionString: env.DATABASE_URL, max: 16, connectionTimeoutMillis: 1500, query_timeout: 1500, statement_timeout: 1000 });
        }
        const shared: ReplyPool = { connect: () => pool!.connect(), end: () => pool!.end(), query: (sql, values) => checked(() => pool!.query(sql, values), now() + 1500) }, roster = await checked(() => readReplyRoster(shared)), rosterReceipt = JSON.stringify(roster);
        // Legacy pollers have no bot-id mutex. Holding the complete current roster's
        // tenant leases prevents coexistence with its ordinary workers/holders.
        // Provider-verified removal of old/removed-tenant deployments is still an
        // explicit rollout prerequisite; a local flag cannot prove remote absence.
        let acquireTenant = options.acquireTenant;
        if (!acquireTenant) {
            const driver = "pg", module = await import(driver), Client = (module.default as unknown as {
                Client: new (o: unknown) => import("./recovery-reply-lease").ReplyLeaseClient & {
                    connect(): Promise<void>;
                };
            }).Client;
            const fleet = new PgTenantLeaseFleet(async () => {
                const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 1500, query_timeout: 1500, statement_timeout: 1000 });
                ownedClients.push(client);
                return client;
            }, stop);
            acquireTenant = tenant => fleet.acquire(tenant);
        }
        for (const grant of roster) {
            const lease = await checked(() => acquireTenant(grant.tenant));
            if (!lease || lease.tenant !== grant.tenant || lease.backend !== "postgres" || !lease.healthy())
                throw recoveryReplyRefused();
            tenantLeases.push(lease);
        }
        let acquireBot = options.acquireBot;
        if (!acquireBot) {
            const driver = "pg", module = await import(driver), Client = (module.default as unknown as {
                Client: new (o: unknown) => {
                    connect(): Promise<void>;
                } & import("./recovery-reply-lease").ReplyLeaseClient;
            }).Client;
            const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 1500, query_timeout: 1500, statement_timeout: 1000 });
            ownedClients.push(client);
            await checked(() => client.connect());
            botLeases = new RecoveryReplyBotLeases(client, stop);
            acquireBot = id => botLeases!.acquire(id);
        }
        const snapshots: ReplySnapshot[] = [];
        for (const grant of roster) {
            const s = await checked(() => readReplySnapshot(shared, grant, dek));
            if (!s)
                continue;
            const hold = await checked(() => acquireBot!(s.botId));
            if (!hold || !hold.healthy())
                throw recoveryReplyRefused();
            botHolds.push(hold);
            snapshots.push(s);
        }
        if (!snapshots.length)
            return;
        await transaction(shared, guard, async (db) => {
            await db.query(RECOVERY_REPLY_SCHEMA);
        });
        const transport = options.transport ?? { getMe, getUpdates, sendMessage, sendPhotoBytes, answerCallbackQuery };
        const reply = options.reply ?? createRecoveryPublicReply({ look: createRecoveryPublicLook(), now });
        const authority = async (db: ReplyQuery, s: ReplySnapshot, lock = false) => {
            guard();
            if (JSON.stringify(await checked(() => readReplyRoster(db))) !== rosterReceipt)
                throw recoveryReplyRefused();
            await checked(() => assertReplySnapshot(db, s, dek, lock));
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
        };
        let publicWork = 0, responseWork = 0;
        const actor = async (s: ReplySnapshot) => {
            let me: Awaited<ReturnType<typeof getMe>>;
            do {
                await authority(shared, s);
                try {
                    me = await checked(() => transport.getMe(opts(s, now() + 5000)));
                }
                catch (e) {
                    if (!(e instanceof ReplyDeadline))
                        throw e;
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
                    break;
                }
                if (me.errorCode === 401 || me.errorCode === 404) {
                    await quarantineProvider(s);
                    return;
                }
                if (me.errorCode === 409)
                    throw recoveryReplyRefused();
                if (options.onePass)
                    return;
                await wait(2000, controller.signal);
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
                    if (!(e instanceof ReplyDeadline))
                        throw e;
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
                    if (polled.errorCode === 409)
                        throw recoveryReplyRefused();
                    if (options.onePass)
                        return;
                    await wait(Math.min(60000, Math.max(2000, (polled.retryAfter ?? 2) * 1000)), controller.signal);
                    continue;
                }
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
                if (results.some(r => r.status === "rejected" && !(r.reason instanceof ReplyDeadline)))
                    throw recoveryReplyRefused();
                if (options.onePass)
                    return;
                if (!actionable.length && polled.nextOffset > previousOffset)
                    continue;
                await wait(500, controller.signal);
            } while (!controller.signal.aborted);
        };
        const actors = snapshots.map(s => actor(s).catch(e => {
            stop();
            throw e;
        }));
        const outcomes = await Promise.allSettled(actors);
        if (outcomes.some(r => r.status === "rejected"))
            throw recoveryReplyRefused();
    }
    finally {
        stop();
        options.stopSignal?.removeEventListener("abort", stop);
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        for (const lease of botHolds)
            await bounded(() => lease.release(), 1500).catch(() => {
            });
        if (botLeases)
            await bounded(() => botLeases!.close(), 1500).catch(() => {
            });
        for (const lease of tenantLeases)
            await bounded(() => lease.release(), 1500).catch(() => {
            });
        for (const client of ownedClients)
            await bounded(() => client.end(), 1500).catch(() => {
            });
        if (pool && !options.pool)
            await bounded(() => pool!.end(), 1500).catch(() => {
            });
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runRecoveryReplies().catch(() => {
        console.error("Reply-only listener stopped or refused; trading and original-source holds remain intact.");
        process.exitCode = 1;
    });
}
