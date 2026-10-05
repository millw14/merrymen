/** Existing-table authority reads and reply metadata only; no grant-store bootstrap. */
import { createHash } from "node:crypto";
import { openSecret } from "./store-crypto";
import { addReplyPrivacy, emptyRecoveryReplyState, eraseLegacyReplyMemory, openRecoveryReplyState, sealRecoveryReplyState, type RecoveryReplyState, type ReplyPrivacyOp, type ReplyTurn } from "./recovery-reply-state";
import { recoveryReplyRefused } from "./recovery-reply-proof";
export interface ReplyQuery {
    query(sql: string, values?: unknown[]): Promise<{
        rows: Record<string, unknown>[];
        rowCount?: number | null;
    }>;
}
export interface ReplyGrant {
    tenant: `0x${string}`;
    account: string;
    chainId: number;
    receipt: string;
}
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const integer = (v: unknown): number => {
    if (!((typeof v === "number" || (typeof v === "string" && /^(?:0|[1-9][0-9]{0,15})$/.test(v))) && Number.isSafeInteger(Number(v))))
        throw recoveryReplyRefused();
    return Number(v);
};
const GRANTS = `SELECT tenant,chain_id,updated_at,grant_json->>'smartAccount' AS account,
 grant_json->>'owner' AS owner,grant_json->>'sessionKeyAddress' AS session,
 grant_json->>'chainId' AS grant_chain,grant_json->>'grantedAt' AS granted,grant_json->>'expiresAt' AS expires,
 grant_json#>>'{replacementStop,sessionKeyAddress}' AS stop_session,grant_json#>>'{replacementStop,stoppedAt}' AS stop_at,
 COALESCE(grant_json#>>'{replacementStop,sessionKeyHash}' ~ '^[0-9a-f]{64}$',false) AS stop_hash_valid,
 xmin::text||':'||ctid::text||':'||encode(sha256(convert_to(grant_json::text,'UTF8')),'hex') AS incarnation FROM grants`;
export async function readReplyRoster(db: ReplyQuery): Promise<ReplyGrant[]> {
    const { rows } = await db.query(`${GRANTS} ORDER BY tenant LIMIT 257`);
    if (rows.length > 256)
        throw recoveryReplyRefused();
    const tenants = new Set<string>(), accounts = new Set<string>();
    return rows.map(r => {
        const chainId = integer(r.chain_id), granted = integer(r.granted), expires = integer(r.expires);
        if (typeof r.tenant !== "string" || !ADDRESS.test(r.tenant) || r.tenant !== r.tenant.toLowerCase()
            || typeof r.account !== "string" || !ADDRESS.test(r.account) || typeof r.owner !== "string" || !ADDRESS.test(r.owner)
            || typeof r.session !== "string" || !ADDRESS.test(r.session) || chainId <= 0 || chainId > 2147483647
            || integer(r.grant_chain) !== chainId || granted <= 0 || integer(r.updated_at) <= 0 || (expires !== 0 && expires <= granted)
            || (expires === 0 && (typeof r.stop_session !== "string" || !ADDRESS.test(r.stop_session) || integer(r.stop_at) <= 0 || r.stop_hash_valid !== true))
            || typeof r.incarnation !== "string" || !/^[0-9]+:\([0-9]+,[0-9]+\):[0-9a-f]{64}$/.test(r.incarnation))
            throw recoveryReplyRefused();
        const account = r.account.toLowerCase();
        if (tenants.has(r.tenant) || accounts.has(account))
            throw recoveryReplyRefused();
        tenants.add(r.tenant);
        accounts.add(account);
        return { tenant: r.tenant as `0x${string}`, account, chainId, receipt: JSON.stringify(r) };
    });
}
export interface ReplySnapshot {
    grant: ReplyGrant;
    botId: string;
    token: string;
    tokenTag: string;
    ownerId: number;
    allowlist: number[];
    claimStamp: number;
    botUsername?: string;
    rooms: number[];
    groupCoinsEnabled: boolean;
    /** Preserve file > operator environment > shared default control semantics. */
    telegramControlEnabled?: boolean;
    receipt: string;
}
/** Returns null for explicitly unavailable scope. Corrupt/unknown reads refuse. */
export async function readReplySnapshot(db: ReplyQuery, grant: ReplyGrant, dek: Buffer, lock = false): Promise<ReplySnapshot | null> {
    const suffix = lock ? " FOR SHARE NOWAIT" : "";
    const current = await db.query(`${GRANTS} WHERE tenant=$1${suffix}`, [grant.tenant]);
    if (current.rows.length !== 1 || JSON.stringify(current.rows[0]) !== grant.receipt)
        throw recoveryReplyRefused();
    const settings = await db.query(`SELECT sealed,xmin::text||':'||ctid::text AS incarnation FROM tenant_settings WHERE tenant=$1${suffix}`, [grant.tenant]);
    if (!settings.rows.length)
        return null;
    if (settings.rows.length !== 1 || typeof settings.rows[0]!.sealed !== "string" || settings.rows[0]!.sealed.length > 1024 * 1024)
        throw recoveryReplyRefused();
    let cfg: Record<string, unknown>;
    try {
        const v: unknown = JSON.parse(openSecret(settings.rows[0]!.sealed, dek));
        if (!v || typeof v !== "object" || Array.isArray(v))
            throw recoveryReplyRefused();
        cfg = v as typeof cfg;
    }
    catch {
        throw recoveryReplyRefused();
    }
    if (cfg.telegramEnabled !== true || typeof cfg.telegramBotToken !== "string")
        return null;
    if (cfg.telegramAllowlist === undefined)
        return null;
    const match = /^0*([1-9][0-9]{0,15}):[A-Za-z0-9_-]+$/.exec(cfg.telegramBotToken);
    if (!match)
        throw recoveryReplyRefused();
    if (!Array.isArray(cfg.telegramAllowlist) || cfg.telegramAllowlist.length > 100 || cfg.telegramAllowlist.some(v => typeof v !== "number" || !Number.isSafeInteger(v) || v === 0))
        throw recoveryReplyRefused();
    for (const name of ["telegramGroupsEnabled", "telegramGroupCoinsEnabled", "telegramControlEnabled"]) {
        if (cfg[name] !== undefined && typeof cfg[name] !== "boolean")
            throw recoveryReplyRefused();
    }
    const groupsEnabled = cfg.telegramGroupsEnabled !== false, groupCoinsEnabled = cfg.telegramGroupCoinsEnabled !== false;
    const botId = match[1]!, token = cfg.telegramBotToken, tokenTag = hash(token).slice(0, 16), allowlist = cfg.telegramAllowlist as number[];
    const claims = await db.query(`SELECT tenant,claimed_at,xmin::text||':'||ctid::text AS incarnation FROM telegram_bot_claims WHERE bot_id=$1${suffix}`, [botId]);
    if (!claims.rows.length)
        return null;
    if (claims.rows.length !== 1)
        throw recoveryReplyRefused();
    const claim = claims.rows[0]!;
    if (claim.tenant !== grant.tenant)
        return null;
    const claimStamp = integer(claim.claimed_at);
    if (claimStamp <= 0)
        throw recoveryReplyRefused();
    const links = await db.query(`SELECT owner_id,linked_at,bot_id FROM tenant_telegram WHERE tenant=$1${suffix}`, [grant.tenant]);
    if (!links.rows.length)
        return null;
    if (links.rows.length !== 1)
        throw recoveryReplyRefused();
    const link = links.rows[0]!;
    if (link.owner_id === null || link.linked_at === null || link.bot_id !== botId)
        return null;
    const ownerId = integer(link.owner_id);
    if (ownerId <= 0 || integer(link.linked_at) <= 0 || !allowlist.includes(ownerId))
        return null;
    const health = await db.query(`SELECT held,cause,checked_at,xmin::text||':'||ctid::text AS incarnation FROM fleet_recovery_health WHERE tenant=$1 AND smart_account=$2 AND chain_id=$3${suffix}`, [grant.tenant, grant.account, grant.chainId]);
    if (health.rows.length !== 1)
        return null;
    const held = health.rows[0]!;
    if (integer(held.held) !== 1 || integer(held.checked_at) <= 0 || !["persistent-source", "source-barrier", "source-continuity"].includes(String(held.cause)))
        return null;
    // Never read old group conversation. Approval control projection alone is
    // decrypted, then discarded; no old lines enter a reply prompt or state.
    const group = await db.query(`SELECT sealed,xmin::text||':'||ctid::text AS incarnation FROM tenant_tg_groups WHERE tenant=$1${suffix}`, [grant.tenant]);
    if (group.rows.length > 1)
        throw recoveryReplyRefused();
    let rooms: number[] = [];
    if (groupsEnabled && group.rows.length) {
        try {
            const raw = group.rows[0]!.sealed;
            if (typeof raw !== "string" || raw.length > 1600000)
                throw recoveryReplyRefused();
            const plain = openSecret(raw, dek), head = `tg-groups/v1 ${grant.tenant}\n`;
            if (!plain.startsWith(head) || Buffer.byteLength(plain) > 1024 * 1024 + 128)
                throw recoveryReplyRefused();
            const v: unknown = JSON.parse(plain.slice(head.length));
            if (!v || typeof v !== "object" || Array.isArray(v))
                throw recoveryReplyRefused();
            const state = v as Record<string, unknown>;
            if (state.version !== 1 || !state.rooms || typeof state.rooms !== "object" || Array.isArray(state.rooms))
                throw recoveryReplyRefused();
            const values = Object.values(state.rooms);
            if (values.length > 30)
                throw recoveryReplyRefused();
            rooms = values.filter(v => !!v && typeof v === "object" && (v as Record<string, unknown>).status === "approved").map(v => {
                const id = (v as Record<string, unknown>).chatId;
                if (typeof id !== "number" || !Number.isSafeInteger(id) || id >= 0)
                    throw recoveryReplyRefused();
                return id;
            });
        }
        catch {
            throw recoveryReplyRefused();
        }
    }
    const receipt = JSON.stringify([grant.receipt, settings.rows[0]!.incarnation, hash(settings.rows[0]!.sealed), claim, link, held, rooms]);
    return { grant, botId, token, tokenTag, ownerId, allowlist, claimStamp, rooms, groupCoinsEnabled, receipt,
        ...(typeof cfg.telegramControlEnabled === "boolean" ? { telegramControlEnabled: cfg.telegramControlEnabled } : {}) };
}
export async function assertReplySnapshot(db: ReplyQuery, snapshot: ReplySnapshot, dek: Buffer, lock = false): Promise<void> {
    const current = await readReplySnapshot(db, snapshot.grant, dek, lock);
    if (!current || current.receipt !== snapshot.receipt)
        throw recoveryReplyRefused();
}
export interface ReplyOffsetState {
    offset: number;
    armedAt: number;
}
export async function bindReplyOffset(db: ReplyQuery, s: ReplySnapshot, atMs: number): Promise<ReplyOffsetState> {
    const row = (await db.query("SELECT * FROM recovery_reply_offsets WHERE bot_id=$1 FOR UPDATE", [s.botId])).rows[0];
    const now = Math.floor(atMs / 1000);
    if (!Number.isSafeInteger(now) || now <= 0)
        throw recoveryReplyRefused();
    if (row) {
        const offset = integer(row.offset_id), armedAt = integer(row.armed_at);
        if (armedAt <= 0 || typeof row.tenant !== "string" || !ADDRESS.test(row.tenant) || typeof row.smart_account !== "string" || !ADDRESS.test(row.smart_account)
            || integer(row.chain_id) <= 0 || typeof row.token_tag !== "string" || !/^[0-9a-f]{16}$/.test(row.token_tag) || integer(row.claim_stamp) <= 0)
            throw recoveryReplyRefused();
        if (row.tenant !== s.grant.tenant || row.smart_account !== s.grant.account || integer(row.chain_id) !== s.grant.chainId
            || row.token_tag !== s.tokenTag || integer(row.claim_stamp) !== s.claimStamp) {
            // Only the exclusive caller with fresh getMe/current row proof may rebind.
            // A bot stream's high-water mark survives every authority incarnation.
            await db.query("UPDATE recovery_reply_offsets SET tenant=$1,smart_account=$2,chain_id=$3,token_tag=$4,claim_stamp=$5,armed_at=$6,updated_at_ms=$7 WHERE bot_id=$8", [s.grant.tenant, s.grant.account, s.grant.chainId, s.tokenTag, s.claimStamp, now, atMs, s.botId]);
            return { offset, armedAt: now };
        }
        return { offset, armedAt };
    }
    await db.query("INSERT INTO recovery_reply_offsets(bot_id,tenant,smart_account,chain_id,token_tag,claim_stamp,offset_id,armed_at,updated_at_ms) VALUES($1,$2,$3,$4,$5,$6,0,$7,$8)", [s.botId, s.grant.tenant, s.grant.account, s.grant.chainId, s.tokenTag, s.claimStamp, now, atMs]);
    return { offset: 0, armedAt: now };
}
/** Transaction caller pins grant/settings/claim/link and root/leases through commit. */
export async function advanceReplyOffset(db: ReplyQuery, s: ReplySnapshot, dek: Buffer, next: number, atMs: number, turns: ReplyTurn[] = [], privacy?: ReplyPrivacyOp): Promise<void> {
    // The initial public code floor does not retain new conversation payloads.
    if (turns.length)
        throw recoveryReplyRefused();
    if (!Number.isSafeInteger(next) || next < 0 || !Number.isSafeInteger(atMs) || atMs < 0)
        throw recoveryReplyRefused();
    const changed = await db.query(`UPDATE recovery_reply_offsets SET offset_id=$1,updated_at_ms=$2 WHERE bot_id=$3 AND tenant=$4 AND smart_account=$5 AND chain_id=$6 AND token_tag=$7 AND claim_stamp=$8 AND offset_id<$1 RETURNING offset_id`, [next, atMs, s.botId, s.grant.tenant, s.grant.account, s.grant.chainId, s.tokenTag, s.claimStamp]);
    if (changed.rows.length !== 1)
        throw recoveryReplyRefused();
    if (!turns.length && !privacy)
        return;
    const rows = (await db.query("SELECT sealed FROM tenant_recovery_reply_state WHERE tenant=$1 FOR UPDATE", [s.grant.tenant])).rows;
    if (rows.length > 1)
        throw recoveryReplyRefused();
    let state: RecoveryReplyState = rows.length ? openRecoveryReplyState(s.grant.tenant, rows[0]!.sealed, dek) : emptyRecoveryReplyState();
    if (privacy) {
        const previous = state.privacy.find(op => op.kind === privacy!.kind && op.chatId === privacy!.chatId && op.userId === privacy!.userId);
        if (previous)
            privacy = { ...privacy, atMs: Math.max(privacy.atMs, previous.atMs + 1) };
        state = addReplyPrivacy(state, privacy);
        for (const [kind, table] of [["personal", "tenant_personal_memory"], ["group", "tenant_tg_groups"]] as const) {
            if (kind === "personal" ? (privacy.kind !== "personal-chat" && privacy.kind !== "personal-owner") : (privacy.kind !== "group" && privacy.kind !== "person"))
                continue;
            const old = (await db.query(`SELECT sealed FROM ${table} WHERE tenant=$1 FOR UPDATE`, [s.grant.tenant])).rows;
            if (old.length > 1)
                throw recoveryReplyRefused();
            if (!old.length)
                continue;
            const row = eraseLegacyReplyMemory(kind, s.grant.tenant, String(old[0]!.sealed), dek, [privacy]);
            const erased = await db.query(`UPDATE ${table} SET sealed=$1,bytes=$2,updated_at_ms=$3 WHERE tenant=$4 AND sealed=$5 RETURNING tenant`, [row.sealed, row.bytes, atMs, s.grant.tenant, old[0]!.sealed]);
            if (erased.rows.length !== 1)
                throw recoveryReplyRefused();
        }
    }
    state = { ...state, turns: [...state.turns, ...turns].slice(-160) };
    const sealed = sealRecoveryReplyState(s.grant.tenant, state, dek);
    await db.query("INSERT INTO tenant_recovery_reply_state(tenant,sealed,bytes,updated_at_ms) VALUES($1,$2,$3,$4) ON CONFLICT(tenant) DO UPDATE SET sealed=excluded.sealed,bytes=excluded.bytes,updated_at_ms=excluded.updated_at_ms", [s.grant.tenant, sealed.sealed, sealed.bytes, atMs]);
}
