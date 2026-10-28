/** Ordinary poll handoff only after its caller's original source/grant/lease gates. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "./atomic-write";
import type { Db } from "./db";
import { readRecoveryReplyOffset, readReplyPrivacy, eraseLegacyReplyMemory } from "./recovery-reply-state";
import { openSecret, sealSecret } from "./store-crypto";
import { botIdOf } from "./telegram/state";
/**
 * WHICH CHECK REFUSED, as a short fixed code on the error and never a value.
 * The spawn path's alert prints an error's class and code and nothing else
 * (orchestrator.ts errorKind), and every refusal here used to be one plain
 * Error: six tenants held on "recovery reply offset not handed over (Error)"
 * said nothing of which of a dozen checks it was. The text stays the same for
 * every one, so nothing private can ride in it.
 */
export type HandoffRefusal =
    /** The caller's writer proof (lease, late refusal, source barrier) failed. */
    | "HANDOFF_WRITER"
    /** The token is not `<digits>:<secret>`. */
    | "HANDOFF_TOKEN"
    /** The listener's offset row could not be read, or names another tenant, account or chain. */
    | "HANDOFF_ROW"
    /** The home is not this user's own plain directory at its real path. */
    | "HANDOFF_HOME"
    /** telegram.json is a symlink. */
    | "HANDOFF_SYMLINK"
    /** telegram.json could not be opened. */
    | "HANDOFF_OPEN"
    /** telegram.json is not a regular file. */
    | "HANDOFF_NOT_FILE"
    /** telegram.json has another name somewhere. */
    | "HANDOFF_LINKS"
    /** telegram.json belongs to someone other than the home's owner. */
    | "HANDOFF_OWNER"
    /** telegram.json is larger than any state the child writes. */
    | "HANDOFF_SIZE"
    /** telegram.json is readable or writable by anyone but its owner. */
    | "HANDOFF_MODE"
    /** telegram.json could not be read. */
    | "HANDOFF_READ"
    /** telegram.json is not JSON. */
    | "HANDOFF_PARSE"
    /** telegram.json changed while it was read, or before the merge was written. */
    | "HANDOFF_CHANGED"
    /** telegram.json is not a JSON object. */
    | "HANDOFF_SHAPE"
    /** Its `offset` is missing or not a non-negative safe integer. */
    | "HANDOFF_OFFSET"
    /** Its `botId` is not a digit string. */
    | "HANDOFF_BOT"
    /** Its `priorBots` is not a list of distinct digit-string bots with offsets. */
    | "HANDOFF_PRIOR_BOTS"
    /** A telegram.json appeared where there was none. */
    | "HANDOFF_APPEARED"
    /** The home was replaced during the handoff. */
    | "HANDOFF_HOME_MOVED";
/** The privacy proof's refusals, the same way. */
export type PrivacyRefusal = "PRIVACY_READER" | "PRIVACY_JOURNAL" | "PRIVACY_OPEN" | "PRIVACY_FILE" | "PRIVACY_CHANGED";
const refused = (code: HandoffRefusal | PrivacyRefusal) => Object.assign(new Error("Reply poll handoff refused; original holds remain intact."), { code });
const isRefusal = (e: unknown): boolean => typeof (e as { code?: unknown } | null)?.code === "string" && /^(HANDOFF|PRIVACY)_[A-Z_]+$/.test((e as { code: string }).code);
/** No offset is reset on a token rotation or when a different bot was last local. */
export function mergeRecoveryReplyOffset(value: unknown, botId: string, offset: number): Record<string, unknown> {
    if (!Number.isSafeInteger(offset) || offset < 0)
        throw refused("HANDOFF_ROW");
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw refused("HANDOFF_SHAPE");
    const state = { ...value as Record<string, unknown> };
    if (!Number.isSafeInteger(state.offset) || Number(state.offset) < 0)
        throw refused("HANDOFF_OFFSET");
    if (state.botId !== undefined && state.botId !== null && (typeof state.botId !== "string" || !/^\d+$/.test(state.botId)))
        throw refused("HANDOFF_BOT");
    if (state.botId === undefined || state.botId === null || state.botId === botId) {
        state.offset = Math.max(Number(state.offset), offset);
        return state;
    }
    if (state.priorBots !== undefined && !Array.isArray(state.priorBots))
        throw refused("HANDOFF_PRIOR_BOTS");
    const prior = (state.priorBots ?? []) as unknown[];
    if (prior.length > 100)
        throw refused("HANDOFF_PRIOR_BOTS");
    const ids = new Set<string>();
    let old = 0;
    for (const entry of prior) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw refused("HANDOFF_PRIOR_BOTS");
        const item = entry as Record<string, unknown>;
        if (typeof item.botId !== "string" || !/^\d+$/.test(item.botId) || ids.has(item.botId) || !Number.isSafeInteger(item.offset) || Number(item.offset) < 0)
            throw refused("HANDOFF_PRIOR_BOTS");
        ids.add(item.botId);
        if (item.botId === botId)
            old = Number(item.offset);
    }
    // Put the arriving bot first so ordinary switchBot's bounded retention cannot
    // discard the witnessed high-water mark before its first getUpdates.
    state.priorBots = [{ botId, offset: Math.max(old, offset) }, ...prior.filter(p => (p as Record<string, unknown>).botId !== botId)];
    return state;
}
export async function handoffRecoveryReplyOffset(o: {
    tenant: string;
    smartAccount: string;
    chainId: number;
    token: string;
    home: string;
    shared: Db;
    mayWrite: () => boolean;
}): Promise<void> {
    const guard = () => {
        if (!o.mayWrite())
            throw refused("HANDOFF_WRITER");
    };
    guard();
    const botId = botIdOf(o.token);
    if (!botId)
        throw refused("HANDOFF_TOKEN");
    let row: Awaited<ReturnType<typeof readRecoveryReplyOffset>>;
    try {
        row = await readRecoveryReplyOffset(o.shared, o, botId);
    }
    catch {
        // Its own refusal says nothing more than this: the row could not be
        // read, or does not name this tenant, account and chain.
        throw refused("HANDOFF_ROW");
    }
    guard();
    if (!row)
        return;
    const home = path.resolve(o.home), st = lstatSync(home);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || realpathSync(home) !== home)
        throw refused("HANDOFF_HOME");
    const file = path.join(home, "telegram.json");
    let value: unknown, fd: number | undefined, source: {
        ino: number;
        dev: number;
        size: number;
        mtimeMs: number;
        ctimeMs: number;
    } | null = null;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ELOOP")
            throw refused("HANDOFF_SYMLINK");
        if (code !== "ENOENT")
            throw refused("HANDOFF_OPEN");
        value = { offset: 0, botId: null, priorBots: [] };
    }
    if (fd !== undefined) {
        try {
            const before = fstatSync(fd);
            if (!before.isFile())
                throw refused("HANDOFF_NOT_FILE");
            if (before.nlink !== 1)
                throw refused("HANDOFF_LINKS");
            if (before.uid !== st.uid)
                throw refused("HANDOFF_OWNER");
            if (before.size > 256 * 1024)
                throw refused("HANDOFF_SIZE");
            if ((before.mode & 0o077) !== 0)
                throw refused("HANDOFF_MODE");
            const text = readFileSync(fd, "utf8");
            try {
                value = JSON.parse(text);
            }
            catch {
                throw refused("HANDOFF_PARSE");
            }
            const after = fstatSync(fd), current = lstatSync(file);
            if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.dev !== before.dev)
                throw refused("HANDOFF_CHANGED");
            source = before;
        }
        catch (e) {
            throw isRefusal(e) ? e : refused("HANDOFF_READ");
        }
        finally {
            closeSync(fd);
        }
    }
    const next = mergeRecoveryReplyOffset(value, botId, row.offset);
    guard();
    if (lstatSync(home).ino !== st.ino || lstatSync(home).dev !== st.dev)
        throw refused("HANDOFF_HOME_MOVED");
    if (source) {
        const current = lstatSync(file);
        if (current.ino !== source.ino || current.dev !== source.dev || current.size !== source.size || current.mtimeMs !== source.mtimeMs || current.ctimeMs !== source.ctimeMs)
            throw refused("HANDOFF_CHANGED");
    }
    else {
        let appeared = true;
        try {
            lstatSync(file);
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT")
                throw refused("HANDOFF_APPEARED");
            appeared = false;
        }
        if (appeared)
            throw refused("HANDOFF_APPEARED");
    }
    writeFileAtomicSync(file, JSON.stringify(next, null, 2), 0o600);
    guard();
}
/** Group-off suppresses answers but index still loads the store. Refuse that
 * fork until an existing local file proves every durable recovery erasure. */
export async function recoveryReplyPrivacyAllowsFork(o: {
    tenant: string;
    home: string;
    shared: Db;
    dek: Buffer;
    mayRead: () => boolean;
}): Promise<boolean> {
    const guard = () => {
        if (!o.mayRead())
            throw refused("PRIVACY_READER");
    };
    guard();
    let ops: Awaited<ReturnType<typeof readReplyPrivacy>>;
    try {
        ops = await readReplyPrivacy(o.shared, o.tenant, o.dek);
    }
    catch {
        throw refused("PRIVACY_JOURNAL");
    }
    guard();
    if (!ops.some(op => op.kind === "group" || op.kind === "person"))
        return true;
    const file = path.join(o.home, "tg-groups.json");
    let fd: number;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
            return true;
        throw refused("PRIVACY_OPEN");
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.size > 1024 * 1024)
            throw refused("PRIVACY_FILE");
        const text = readFileSync(fd, "utf8");
        const after = fstatSync(fd), current = lstatSync(file);
        if (st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs || st.ino !== current.ino || st.dev !== current.dev)
            throw refused("PRIVACY_CHANGED");
        const head = `tg-groups/v1 ${o.tenant}\n`, row = eraseLegacyReplyMemory("group", o.tenant, sealSecret(head + text, o.dek), o.dek, ops);
        const filtered = openSecret(row.sealed, o.dek);
        guard();
        return JSON.stringify(JSON.parse(filtered.slice(head.length))) === JSON.stringify(JSON.parse(text));
    }
    finally {
        closeSync(fd);
    }
}
