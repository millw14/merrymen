/** Ordinary poll handoff only after its caller's original source/grant/lease gates. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "./atomic-write";
import type { Db } from "./db";
import { readRecoveryReplyOffset, readReplyPrivacy, eraseLegacyReplyMemory } from "./recovery-reply-state";
import { openSecret, sealSecret } from "./store-crypto";
import { botIdOf } from "./telegram/state";
const refused = () => new Error("Reply poll handoff refused; original holds remain intact.");
/** No offset is reset on a token rotation or when a different bot was last local. */
export function mergeRecoveryReplyOffset(value: unknown, botId: string, offset: number): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isSafeInteger(offset) || offset < 0)
        throw refused();
    const state = { ...value as Record<string, unknown> };
    if (!Number.isSafeInteger(state.offset) || Number(state.offset) < 0 || (state.botId !== undefined && state.botId !== null && (typeof state.botId !== "string" || !/^\d+$/.test(state.botId))))
        throw refused();
    if (state.botId === undefined || state.botId === null || state.botId === botId) {
        state.offset = Math.max(Number(state.offset), offset);
        return state;
    }
    if (state.priorBots !== undefined && !Array.isArray(state.priorBots))
        throw refused();
    const prior = (state.priorBots ?? []) as unknown[];
    if (prior.length > 100)
        throw refused();
    const ids = new Set<string>();
    let old = 0;
    for (const entry of prior) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw refused();
        const item = entry as Record<string, unknown>;
        if (typeof item.botId !== "string" || !/^\d+$/.test(item.botId) || ids.has(item.botId) || !Number.isSafeInteger(item.offset) || Number(item.offset) < 0)
            throw refused();
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
            throw refused();
    };
    guard();
    const botId = botIdOf(o.token);
    if (!botId)
        throw refused();
    const row = await readRecoveryReplyOffset(o.shared, o, botId);
    guard();
    if (!row)
        return;
    const home = path.resolve(o.home), st = lstatSync(home);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || realpathSync(home) !== home)
        throw refused();
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
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
            throw refused();
        value = { offset: 0, botId: null, priorBots: [] };
    }
    if (fd !== undefined) {
        try {
            const before = fstatSync(fd);
            if (!before.isFile() || before.nlink !== 1 || before.uid !== st.uid || before.size > 256 * 1024 || (before.mode & 0o077) !== 0)
                throw refused();
            value = JSON.parse(readFileSync(fd, "utf8"));
            const after = fstatSync(fd), current = lstatSync(file);
            if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.dev !== before.dev)
                throw refused();
            source = before;
        }
        catch {
            throw refused();
        }
        finally {
            closeSync(fd);
        }
    }
    const next = mergeRecoveryReplyOffset(value, botId, row.offset);
    guard();
    if (lstatSync(home).ino !== st.ino || lstatSync(home).dev !== st.dev)
        throw refused();
    if (source) {
        const current = lstatSync(file);
        if (current.ino !== source.ino || current.dev !== source.dev || current.size !== source.size || current.mtimeMs !== source.mtimeMs || current.ctimeMs !== source.ctimeMs)
            throw refused();
    }
    else {
        try {
            lstatSync(file);
            throw refused();
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT")
                throw refused();
        }
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
            throw refused();
    };
    guard();
    const ops = await readReplyPrivacy(o.shared, o.tenant, o.dek);
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
        throw refused();
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.size > 1024 * 1024)
            throw refused();
        const text = readFileSync(fd, "utf8");
        const after = fstatSync(fd), current = lstatSync(file);
        if (st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs || st.ino !== current.ino || st.dev !== current.dev)
            throw refused();
        const head = `tg-groups/v1 ${o.tenant}\n`, row = eraseLegacyReplyMemory("group", o.tenant, sealSecret(head + text, o.dek), o.dek, ops);
        const filtered = openSecret(row.sealed, o.dek);
        guard();
        return JSON.stringify(JSON.parse(filtered.slice(head.length))) === JSON.stringify(JSON.parse(text));
    }
    finally {
        closeSync(fd);
    }
}
