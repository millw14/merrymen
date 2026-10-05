/** Reply-only state is separate from original books and historical memory. */
import { openSecret, sealSecret } from "./store-crypto";
import type { Db } from "./db";
export const RECOVERY_REPLY_SCHEMA = `CREATE TABLE IF NOT EXISTS recovery_reply_offsets (
 bot_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, smart_account TEXT NOT NULL, chain_id BIGINT NOT NULL,
 token_tag TEXT NOT NULL, claim_stamp BIGINT NOT NULL, offset_id BIGINT NOT NULL,
 armed_at BIGINT NOT NULL, updated_at_ms BIGINT NOT NULL
); CREATE TABLE IF NOT EXISTS tenant_recovery_reply_state (
 tenant TEXT PRIMARY KEY, sealed TEXT NOT NULL, bytes BIGINT NOT NULL, updated_at_ms BIGINT NOT NULL
);`;
export const REPLY_STATE_MAX_BYTES = 256 * 1024;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface ReplyPrivacyOp {
    id: string;
    atMs: number;
    kind: "personal-chat" | "personal-owner" | "group" | "person";
    chatId?: number;
    userId?: number;
}
export interface ReplyTurn {
    chatId: number;
    atMs: number;
    role: "user" | "assistant";
    text: string;
}
export interface RecoveryReplyState {
    version: 1;
    privacy: ReplyPrivacyOp[];
    turns: ReplyTurn[];
}
export const emptyRecoveryReplyState = (): RecoveryReplyState => ({ version: 1, privacy: [], turns: [] });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const fail = () => new Error("Reply-only state refused; private memory remains held.");
export function privacyScope(op: ReplyPrivacyOp): string {
    return op.kind === "personal-owner" ? op.kind : `${op.kind}:${op.chatId}:${op.userId ?? "*"}`;
}
export function parseRecoveryReplyState(v: unknown): RecoveryReplyState {
    if (!object(v) || v.version !== 1 || !Array.isArray(v.privacy) || v.privacy.length > 500
        || !Array.isArray(v.turns) || v.turns.length > 160 || Object.keys(v).some(k => !["version", "privacy", "turns"].includes(k)))
        throw fail();
    const scopes = new Set<string>(), ids = new Set<string>();
    const privacy = v.privacy.map(p => {
        if (!object(p) || typeof p.id !== "string" || !UUID.test(p.id) || !integer(p.atMs) || p.atMs < 0
            || !["personal-chat", "personal-owner", "group", "person"].includes(String(p.kind))
            || Object.keys(p).some(k => !["id", "atMs", "kind", "chatId", "userId"].includes(k)))
            throw fail();
        const op = p as unknown as ReplyPrivacyOp;
        if (op.kind === "personal-owner") {
            if (op.chatId !== undefined || op.userId !== undefined)
                throw fail();
        }
        else if (!integer(op.chatId) || op.chatId === 0 || (op.kind === "personal-chat" && op.chatId < 0)
            || ((op.kind === "group" || op.kind === "person") && op.chatId > 0)
            || (op.kind === "person" ? !integer(op.userId) || op.userId <= 0 : op.userId !== undefined))
            throw fail();
        const scope = privacyScope(op);
        if (scopes.has(scope) || ids.has(op.id))
            throw fail();
        scopes.add(scope);
        ids.add(op.id);
        return { ...op };
    });
    const turns = v.turns.map(t => {
        if (!object(t) || !integer(t.chatId) || t.chatId === 0 || !integer(t.atMs) || t.atMs < 0
            || (t.role !== "user" && t.role !== "assistant") || typeof t.text !== "string" || t.text.length > 2000
            || Object.keys(t).some(k => !["chatId", "atMs", "role", "text"].includes(k)))
            throw fail();
        return { chatId: t.chatId, atMs: t.atMs, role: t.role, text: t.text } as ReplyTurn;
    });
    const result: RecoveryReplyState = { version: 1, privacy, turns };
    if (Buffer.byteLength(JSON.stringify(result)) > REPLY_STATE_MAX_BYTES)
        throw fail();
    return result;
}
export function openRecoveryReplyState(tenant: string, sealed: unknown, dek: Buffer): RecoveryReplyState {
    if (!ADDRESS.test(tenant) || typeof sealed !== "string" || sealed.length > REPLY_STATE_MAX_BYTES * 1.5 + 512)
        throw fail();
    try {
        const head = `recovery-reply/v1 ${tenant}\n`, text = openSecret(sealed, dek);
        if (!text.startsWith(head) || Buffer.byteLength(text) > REPLY_STATE_MAX_BYTES + head.length)
            throw fail();
        return parseRecoveryReplyState(JSON.parse(text.slice(head.length)));
    }
    catch {
        throw fail();
    }
}
export function sealRecoveryReplyState(tenant: string, state: RecoveryReplyState, dek: Buffer): {
    sealed: string;
    bytes: number;
} {
    if (!ADDRESS.test(tenant))
        throw fail();
    const text = JSON.stringify(parseRecoveryReplyState(state));
    return { sealed: sealSecret(`recovery-reply/v1 ${tenant}\n${text}`, dek), bytes: Buffer.byteLength(text) };
}
export function addReplyPrivacy(state: RecoveryReplyState, op: ReplyPrivacyOp): RecoveryReplyState {
    const old = parseRecoveryReplyState(state), scope = privacyScope(op);
    const sameId = old.privacy.find(p => p.id === op.id);
    if (sameId && JSON.stringify(sameId) !== JSON.stringify(op))
        throw fail();
    const previous = old.privacy.find(p => privacyScope(p) === scope);
    if (previous && (op.atMs < previous.atMs || (op.atMs === previous.atMs && op.id !== previous.id)))
        throw fail();
    if (previous?.id === op.id && previous.atMs === op.atMs)
        return old;
    return parseRecoveryReplyState({ ...old, privacy: [...old.privacy.filter(p => privacyScope(p) !== scope), op],
        turns: old.turns.filter(t => t.atMs > op.atMs || (op.kind !== "personal-owner" && t.chatId !== op.chatId)) });
}
/** Missing optional tables are tested without aborting a PostgreSQL transaction. */
async function replyTablePresent(db: Pick<Db, "prepare">, table: "tenant_recovery_reply_state" | "recovery_reply_offsets"): Promise<boolean> {
    try {
        const row = await db.prepare(`SELECT to_regclass('${table}') AS table_name`).get() as {
            table_name?: unknown;
        };
        if (!row || !("table_name" in row))
            throw fail();
        if (row.table_name === null)
            return false;
        if (typeof row.table_name !== "string" || !row.table_name)
            throw fail();
        return true;
    }
    catch (e) {
        if (!/no such function: to_regclass/.test((e as Error).message ?? ""))
            throw fail();
        return !!await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    }
}
export async function readReplyPrivacy(db: Pick<Db, "prepare">, tenant: string, dek: Buffer): Promise<ReplyPrivacyOp[]> {
    if (!await replyTablePresent(db, "tenant_recovery_reply_state"))
        return [];
    let row: {
        sealed?: unknown;
    } | undefined;
    try {
        row = await db.prepare("SELECT sealed FROM tenant_recovery_reply_state WHERE tenant=?").get(tenant) as typeof row;
    }
    catch (e) {
        throw fail();
    }
    return row ? openRecoveryReplyState(tenant, row.sealed, dek).privacy : [];
}
/** Pure erasure. This never interprets financial data or initializes a book. */
export function eraseLegacyReplyMemory(kind: "personal" | "group", tenant: string, sealed: string, dek: Buffer, ops: readonly ReplyPrivacyOp[]): {
    sealed: string;
    bytes: number;
} {
    parseRecoveryReplyState({ version: 1, privacy: ops, turns: [] });
    const head = `${kind === "personal" ? "personal-memory/v1" : "tg-groups/v1"} ${tenant}\n`;
    const plain = openSecret(sealed, dek);
    if (!ADDRESS.test(tenant) || !plain.startsWith(head) || Buffer.byteLength(plain) > 1024 * 1024 + 128)
        throw fail();
    const value: unknown = JSON.parse(plain.slice(head.length));
    if (!object(value) || value.version !== 1)
        throw fail();
    if (kind === "personal") {
        if (!object(value.soul) || !Array.isArray(value.chats) || !Array.isArray(value.forgets) || !object(value.applied))
            throw fail();
        if (value.chats.length > 64 || value.forgets.length > 500 || Object.entries(value.soul).some(([name, text]) => !["IDENTITY.md", "OWNER.md", "NOTES.md", "JOURNAL.md", "ARCHIVE.md"].includes(name) || typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024))
            throw fail();
        const chats = new Set<number>();
        for (const chat of value.chats) {
            if (!object(chat) || !integer(chat.chatId) || chat.chatId <= 0 || chats.has(chat.chatId) || !Array.isArray(chat.turns) || chat.turns.length > 40)
                throw fail();
            chats.add(chat.chatId);
            for (const turn of chat.turns)
                if (!object(turn) || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.content !== "string" || Buffer.byteLength(turn.content) > 16384 || !integer(turn.at) || turn.at < 0
                    || (turn.memoryIds !== undefined && (!Array.isArray(turn.memoryIds) || turn.memoryIds.length > 64 || turn.memoryIds.some(id => typeof id !== "string" || id.length > 256))))
                    throw fail();
        }
        const forgetScopes = new Set<string>();
        for (const op of value.forgets) {
            if (!object(op) || typeof op.id !== "string" || !UUID.test(op.id) || !integer(op.atMs) || op.atMs < 0 || typeof op.completed !== "boolean"
                || (op.kind !== "owner" && (op.kind !== "chat" || !integer(op.chatId) || op.chatId <= 0)))
                throw fail();
            const scope = op.kind === "owner" ? "owner" : `chat:${op.chatId}`;
            if (forgetScopes.has(scope))
                throw fail();
            forgetScopes.add(scope);
        }
        for (const [scope, id] of Object.entries(value.applied))
            if (!value.forgets.some(op => object(op) && op.id === id && (op.kind === "owner" ? "owner" : `chat:${op.chatId}`) === scope))
                throw fail();
        for (const op of ops.filter(p => p.kind === "personal-chat" || p.kind === "personal-owner")) {
            const scope = op.kind === "personal-owner" ? "owner" : `chat:${op.chatId}`;
            const old = (value.forgets as unknown[]).find(p => object(p) && (p.kind === "owner" ? "owner" : `chat:${p.chatId}`) === scope);
            if (object(old)) {
                if (typeof old.id !== "string" || !UUID.test(old.id) || !integer(old.atMs) || old.atMs < 0)
                    throw fail();
                // An applied erasure is a receipt, not a standing instruction to erase
                // valid new conversation each time the older journal is replayed.
                if (old.id === op.id && old.atMs !== op.atMs)
                    throw fail();
                if (old.id === op.id && value.applied[scope] === op.id)
                    continue;
                if (old.atMs >= op.atMs && old.id !== op.id) {
                    if (value.applied[scope] !== old.id)
                        throw fail();
                    continue;
                }
            }
            if (op.kind === "personal-owner") {
                value.soul["OWNER.md"] = "";
                value.soul["ARCHIVE.md"] = "";
            }
            else
                value.chats = (value.chats as unknown[]).filter(c => object(c) && c.chatId !== op.chatId);
            value.forgets = [...(value.forgets as unknown[]).filter(p => object(p) && (p.kind === "owner" ? "owner" : `chat:${p.chatId}`) !== scope),
                { id: op.id, atMs: op.atMs, kind: op.kind === "personal-owner" ? "owner" : "chat", ...(op.chatId ? { chatId: op.chatId } : {}), completed: true }];
            value.applied[scope] = op.id;
            if ((value.forgets as unknown[]).length > 500)
                throw fail();
        }
    }
    else {
        if (!object(value.rooms))
            throw fail();
        for (const op of ops.filter(p => p.kind === "group" || p.kind === "person")) {
            const room = value.rooms[String(op.chatId)];
            if (room === undefined)
                continue;
            if (!object(room) || !Array.isArray(room.lines) || !Array.isArray(room.people) || !Array.isArray(room.coins))
                throw fail();
            if (room.lines.length > 60 || room.people.length > 40 || room.coins.length > 60 || typeof room.summary !== "string"
                || (room.lastSummaryAtMs !== undefined && (!integer(room.lastSummaryAtMs) || room.lastSummaryAtMs < 0))
                || (room.sinceSummary !== undefined && (!integer(room.sinceSummary) || room.sinceSummary < 0)))
                throw fail();
            for (const line of room.lines)
                if (!object(line) || !integer(line.atMs) || line.atMs < 0 || !integer(line.fromId) || line.fromId === 0 || typeof line.text !== "string")
                    throw fail();
            for (const person of room.people)
                if (!object(person) || !integer(person.id) || person.id === 0 || !integer(person.lastSeenMs) || person.lastSeenMs < 0 || typeof person.name !== "string")
                    throw fail();
            for (const coin of room.coins)
                if (!object(coin) || !integer(coin.atMs) || coin.atMs < 0 || !integer(coin.byId) || coin.byId < 0 || typeof coin.byName !== "string" || typeof coin.address !== "string" || !/^0x[0-9a-f]{40}$/i.test(coin.address))
                    throw fail();
            const keep = (v: unknown, time: string) => object(v) && typeof v[time] === "number" && (v[time] as number) > op.atMs;
            const before = room.lines.length;
            room.lines = room.lines.filter(l => op.kind === "group" ? keep(l, "atMs") : object(l) && (l.fromId !== op.userId || keep(l, "atMs")));
            room.people = room.people.filter(p => op.kind === "group" ? keep(p, "lastSeenMs") : object(p) && (p.id !== op.userId || keep(p, "lastSeenMs")));
            room.coins = op.kind === "group" ? room.coins.filter(c => keep(c, "atMs")) : room.coins.map(c => object(c) && c.byId === op.userId && !keep(c, "atMs") ? { ...c, byId: 0, byName: "" } : c);
            if (typeof room.lastSummaryAtMs !== "number" || room.lastSummaryAtMs <= op.atMs) {
                room.summary = "";
                delete room.lastSummaryAtMs;
            }
            const lines = room.lines as unknown[];
            if (op.kind === "group" && before !== lines.length && typeof room.sinceSummary === "number")
                room.sinceSummary = Math.min(room.sinceSummary, lines.filter(l => object(l) && l.own !== true).length);
        }
    }
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 1024 * 1024)
        throw fail();
    return { sealed: sealSecret(`${head}${text}`, dek), bytes: Buffer.byteLength(text) };
}
export interface ReplyOffset {
    botId: string;
    tokenTag: string;
    offset: number;
    armedAt: number;
}
export async function readRecoveryReplyOffset(db: Pick<Db, "prepare">, scope: {
    tenant: string;
    smartAccount: string;
    chainId: number;
}, botId: string): Promise<ReplyOffset | null> {
    if (!await replyTablePresent(db, "recovery_reply_offsets"))
        return null;
    let row: Record<string, unknown> | undefined;
    try {
        row = await db.prepare("SELECT tenant,smart_account,chain_id,token_tag,offset_id,armed_at FROM recovery_reply_offsets WHERE bot_id=?").get(botId) as typeof row;
    }
    catch (e) {
        throw fail();
    }
    if (!row)
        return null;
    const numeric = (v: unknown) => typeof v === "number" ? Number.isSafeInteger(v) : typeof v === "string" && /^(?:0|[1-9][0-9]{0,15})$/.test(v) && Number.isSafeInteger(Number(v));
    if (!numeric(row.offset_id) || !numeric(row.armed_at) || !numeric(row.chain_id))
        throw fail();
    const offset = Number(row.offset_id), armedAt = Number(row.armed_at);
    if (row.tenant !== scope.tenant || row.smart_account !== scope.smartAccount.toLowerCase() || Number(row.chain_id) !== scope.chainId
        || typeof row.token_tag !== "string" || !/^[0-9a-f]{16}$/.test(row.token_tag) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(armedAt) || armedAt <= 0)
        throw fail();
    return { botId, tokenTag: row.token_tag, offset, armedAt };
}
