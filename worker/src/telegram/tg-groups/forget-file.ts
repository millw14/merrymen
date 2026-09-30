/**
 * Telegram groups — the forget requests, `<MERRYMEN_HOME>/tg-groups-forget.json`.
 * Contract: docs/tg-groups.md, "Memory" and "Storage and the ferry".
 *
 * APART FROM THE STORE, so a process that must not hold group memory can
 * still write a request down. The hold process (telegram/hold.ts) answers the
 * owner's bot while trading is held; it keeps no memory and imports no store
 * (restore-hold.test.ts pins that), but a /forgetme typed in a group during a
 * hold that lasts days must not be lost. It appends here, and whoever holds
 * the memory applies it: the orchestrator to the stored copy on its mirror
 * clock (tg-groups-ferry.ts), the store when the child that ends the hold
 * opens it (store.ts applyForgets). The file format and the append are this
 * module's; what a request erases is the store's.
 *
 * node:fs and node:path only: nothing here opens the memory, a database or
 * the network.
 */

import {
  closeSync,
  constants as fsc,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Newest `max` by `at`, in ascending order, stable for ties (the store's own rule). */
function keepNewest<T>(items: T[], max: number, at: (x: T) => number): T[] {
  const sorted = items
    .map((x, i) => ({ x, i }))
    .sort((a, b) => at(a.x) - at(b.x) || a.i - b.i)
    .map((e) => e.x);
  return sorted.length > max ? sorted.slice(sorted.length - max) : sorted;
}

/** Best effort: not every platform lets a directory be opened for fsync. */
function syncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* the file itself is already synced */
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Beside tg-groups.json: every `/forget` and `/forgetme`, one JSON record per
 * line, appended and fsynced before the agent says "done".
 *
 * WHY A SECOND FILE. The memory file is not always the memory. Hosted, a
 * child whose memory could not be brought back at spawn runs with its groups
 * held off (docs/tg-groups.md "Storage and the ferry"): its store starts
 * empty, nothing it writes is published, and the sealed copy its next spawn
 * restores still holds everything. A forget done on that empty store erases
 * nothing, and the restore would hand the person's lines back. This file
 * keeps the request itself, so whoever holds the real memory can apply it:
 * the ferry to the sealed copy (tg-groups-ferry.ts), the restore before it
 * writes the file back, and the store when it opens.
 *
 * APPEND-ONLY, BECAUSE IT HAS TWO WRITERS. The child appends (or, while
 * trading is held, the hold process in its place: the orchestrator never runs
 * both in one home). The ferry takes
 * the file away once a publish shows the child's own memory reflects it, and
 * appends back whatever arrived meanwhile. Appends never overwrite each
 * other, so neither side can lose the other's record. Each record sits
 * between newlines, so one torn by a crash never swallows the next.
 */
export const TG_GROUPS_FORGET_FILE = "tg-groups-forget.json";

/**
 * Past `fileBytes`, the next record compacts the file first: one record per
 * chat and person (the latest), at most `ops`, newest kept. A record is under
 * 100 bytes, so a compacted file is well under `fileBytes`. A file past
 * `readBytes` was not written by this store or the ferry.
 */
export const TG_FORGET_LIMITS = { ops: 500, fileBytes: 64 * 1024, readBytes: 256 * 1024 } as const;

/**
 * One forget request. `userId` "*" is the owner's `/forget` (the chat's whole
 * memory); a number is that person's `/forgetme`. `atMs` is when it was asked,
 * on the store's clock. Only what the chat remembered by then is erased, so
 * applying the request again later never erases what was said after it.
 */
export interface TgForgetOp {
  chatId: number;
  userId: number | "*";
  atMs: number;
}

export function cleanForget(v: unknown): TgForgetOp | null {
  if (!isObj(v) || !isInt(v.chatId) || !isNum(v.atMs)) return null;
  const userId = v.userId === "*" ? "*" : isInt(v.userId) ? v.userId : null;
  if (userId === null) return null;
  return { chatId: v.chatId, userId, atMs: v.atMs };
}

/**
 * One request per chat and person, the latest: erasing up to a later moment
 * erases everything an earlier request for the same person would have. At
 * most TG_FORGET_LIMITS.ops, newest kept, oldest first.
 */
export function compactForgets(ops: readonly TgForgetOp[]): TgForgetOp[] {
  const byKey = new Map<string, TgForgetOp>();
  for (const op of ops) {
    const key = `${op.chatId}:${op.userId}`;
    const prev = byKey.get(key);
    if (!prev || op.atMs > prev.atMs) byKey.set(key, op);
  }
  return keepNewest([...byKey.values()], TG_FORGET_LIMITS.ops, (o) => o.atMs);
}

/** The forget requests in a forget file's text: well-formed records only, compacted. Never throws. */
export function parseTgForgets(text: string): TgForgetOp[] {
  const ops: TgForgetOp[] = [];
  for (const row of String(text ?? "").split("\n")) {
    const t = row.trim();
    if (!t) continue;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      continue; // a record torn by a crash, or not ours
    }
    const op = cleanForget(v);
    if (op) ops.push(op);
  }
  return compactForgets(ops);
}

/** One record as it is written: between newlines (see TG_GROUPS_FORGET_FILE). */
const forgetRecord = (op: TgForgetOp): string => `\n${JSON.stringify({ chatId: op.chatId, userId: op.userId, atMs: op.atMs })}\n`;

/** The last `max` bytes of a file (all of it when smaller). A partial first record is dropped by the parser. */
function readTail(file: string, max: number): string {
  const fd = openSync(file, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return "";
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, st.size - len + got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The forget requests in `home`, or none. Never throws. */
export function readForgetFile(home: string): TgForgetOp[] {
  try {
    return parseTgForgets(readTail(path.join(home, TG_GROUPS_FORGET_FILE), TG_FORGET_LIMITS.readBytes));
  } catch {
    return [];
  }
}

/** Write all of `data` at the end of an open file: a short write is a failed one, never half a record left unsaid. */
function writeAll(fd: number, data: Buffer): void {
  let off = 0;
  while (off < data.length) {
    const n = writeSync(fd, data, off, data.length - off);
    if (n <= 0) throw new Error("short write");
    off += n;
  }
}

/**
 * Append one record to `home`'s forget file, synchronously and durably. The
 * ferry may take the file away between our open and our write (it renames a
 * file it has finished with aside, then deletes it); a record written into
 * the taken file could go with it, so when the name no longer points at the
 * file just written, the record is written again where it does. A second copy
 * is harmless: requests are compacted when read.
 */
export function appendForget(home: string, op: TgForgetOp): void {
  const file = path.join(home, TG_GROUPS_FORGET_FILE);
  mkdirSync(home, { recursive: true });
  let size = 0;
  try {
    size = lstatSync(file).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (size >= TG_FORGET_LIMITS.fileBytes) {
    // Compacted by temp file and rename. Only a flood of requests nobody
    // cleared gets here; everything it held is in what replaces it.
    const body = Buffer.from(compactForgets([...readForgetFile(home), op]).map(forgetRecord).join(""), "utf8");
    const tmp = `${file}.tmp`;
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeAll(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    syncDir(home);
    return;
  }
  const record = Buffer.from(forgetRecord(op), "utf8");
  for (let attempt = 0; attempt < 5; attempt++) {
    const fd = openSync(file, fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | (fsc.O_NOFOLLOW ?? 0), 0o600);
    let ino: number;
    try {
      writeAll(fd, record);
      fsyncSync(fd);
      ino = fstatSync(fd).ino;
    } finally {
      closeSync(fd);
    }
    syncDir(home);
    let now: number | null = null;
    try {
      now = lstatSync(file).ino;
    } catch {
      now = null;
    }
    if (now === ino) return;
  }
  throw new Error("the forget file kept being taken away");
}
