/**
 * WHAT THE HOLD PROCESS PASSES OVER IN TELEGRAM GROUPS, KEPT FOR THE CHILD.
 *
 * While a paper tenant's trading is held, the hold process (hold.ts) polls the
 * owner's bot in the child's place. It keeps no group memory and imports no
 * store (restore-hold.test.ts pins that), so everything it read about groups
 * used to be consumed and lost: the offset moved past it and the child that
 * ended the hold never heard of it. On a hold that lasts days that was:
 *
 * - a stranger's add, which then surfaced (if a line ever reached the bot) as
 *   a group nobody is known to have added it to: the owner asked the wrong
 *   question, and no 24-hour leave (docs/tg-groups.md "Which groups it talks
 *   in");
 * - a removal, which left the room approved, so its 30-day pruning never
 *   began;
 * - a group upgraded to a supergroup, whose memory stayed under the old id,
 *   using a room slot, while the new id started over as a stranger's room;
 * - a Stay, Leave or Forget the owner pressed in their DM, answered "expired"
 *   while a stranger's group ran out its 24 hours and was left for good.
 *
 * So the hold writes each one here, and the child that ends the hold takes the
 * file at its first good poll and hands the entries to the group handler in
 * order, before anything newer, as late updates (service.ts pollOnce):
 * recorded as any update is, and nothing said in a room.
 *
 * - Only what the handler acts on: the bot's own membership in a group, a
 *   migration, the bot's own removal, and a Stay, Leave or Forget pressed in
 *   the owner's DM. Not joins (a late join gets no welcome) and never a line.
 * - Tied to the bot: each entry carries the id its token names, and the child
 *   replays only its own bot's.
 * - Bounded: the newest HELD_GROUPS_MAX entries.
 * - At most once: the child removes the file before it replays anything, as
 *   the poll saves each update as seen before it runs. A crash part way loses
 *   the rest; it never repeats one.
 * - In the home, 0600, and gone once the child takes it. A redeploy that
 *   wipes the home during a hold loses it with the rest of the home. A Forget
 *   pressed there is also written to the forget file at once
 *   (tg-groups/forget-file.ts), which the orchestrator carries to the stored
 *   copy within one mirror pass.
 *
 * node:fs and node:path only, like forget-file.ts: the hold process imports it.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import type { TgCallback, TgMemberUpdate, TgServiceMessage } from "./api";

export const HELD_GROUPS_FILE = "telegram-held-groups.json";

/** The newest this many are kept. A hold sees few: the bot's own membership, migrations, presses. */
export const HELD_GROUPS_MAX = 100;

/** Past this the file was not written here, and is not read. */
const MAX_READ_BYTES = 256 * 1024;

/**
 * A Stay, Leave or Forget button: what it is for, and the group. The same
 * pattern as tg-groups/handler.ts CB_RE, which asks with these (a copy, since
 * tg-groups imports nothing from here; held-groups.test.ts holds them equal).
 */
export const GROUP_PRESS_RE = /^tgg:(stay|leave|forget):(-?\d{1,20})$/;

/** A press as kept: no query id, which is long gone by the time the child reads it. */
export type HeldGroupPress = Pick<TgCallback, "chatId" | "fromId" | "messageId" | "data" | "date">;

export type HeldGroupEntry =
  | { bot: string; kind: "member"; member: TgMemberUpdate }
  | { bot: string; kind: "service"; service: TgServiceMessage }
  | { bot: string; kind: "press"; press: HeldGroupPress };

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isGroupType = (v: unknown): v is "group" | "supergroup" => v === "group" || v === "supergroup";

/** Only what onMember reads: no names of whoever changed it. */
function cleanMember(v: unknown): TgMemberUpdate | null {
  if (!isObj(v) || !isInt(v.updateId) || !isInt(v.chatId) || !isGroupType(v.chatType) || !isInt(v.fromId)) return null;
  if (typeof v.oldStatus !== "string" || typeof v.newStatus !== "string" || !isNum(v.dateSec)) return null;
  return {
    updateId: v.updateId,
    chatId: v.chatId,
    chatType: v.chatType,
    ...(typeof v.chatTitle === "string" ? { chatTitle: v.chatTitle } : {}),
    ...(typeof v.isForum === "boolean" ? { isForum: v.isForum } : {}),
    fromId: v.fromId,
    oldStatus: v.oldStatus,
    newStatus: v.newStatus,
    ...(typeof v.newIsMember === "boolean" ? { newIsMember: v.newIsMember } : {}),
    dateSec: v.dateSec,
  };
}

/** A migration or a removal, and nothing else: no joins, no names. */
function cleanService(v: unknown): TgServiceMessage | null {
  if (!isObj(v) || !isInt(v.updateId) || !isInt(v.chatId) || !isGroupType(v.chatType) || !isInt(v.messageId) || !isNum(v.dateSec)) return null;
  const left = isObj(v.leftChatMember) && isInt(v.leftChatMember.id) ? { id: v.leftChatMember.id, isBot: v.leftChatMember.isBot === true } : undefined;
  const to = isInt(v.migrateToChatId) ? v.migrateToChatId : undefined;
  const from = isInt(v.migrateFromChatId) ? v.migrateFromChatId : undefined;
  if (left === undefined && to === undefined && from === undefined) return null;
  return {
    updateId: v.updateId,
    chatId: v.chatId,
    chatType: v.chatType,
    messageId: v.messageId,
    dateSec: v.dateSec,
    ...(left ? { leftChatMember: left } : {}),
    ...(to !== undefined ? { migrateToChatId: to } : {}),
    ...(from !== undefined ? { migrateFromChatId: from } : {}),
  };
}

function cleanPress(v: unknown): HeldGroupPress | null {
  if (!isObj(v) || !isInt(v.chatId) || !isInt(v.fromId) || !isInt(v.messageId) || !isNum(v.date)) return null;
  if (typeof v.data !== "string" || !GROUP_PRESS_RE.test(v.data)) return null;
  return { chatId: v.chatId, fromId: v.fromId, messageId: v.messageId, data: v.data, date: v.date };
}

function cleanEntry(v: unknown): HeldGroupEntry | null {
  if (!isObj(v) || typeof v.bot !== "string" || !/^\d{1,20}$/.test(v.bot)) return null;
  if (v.kind === "member") {
    const member = cleanMember(v.member);
    return member ? { bot: v.bot, kind: "member", member } : null;
  }
  if (v.kind === "service") {
    const service = cleanService(v.service);
    return service ? { bot: v.bot, kind: "service", service } : null;
  }
  if (v.kind === "press") {
    const press = cleanPress(v.press);
    return press ? { bot: v.bot, kind: "press", press } : null;
  }
  return null;
}

/** The entries in `home`'s file, well-formed ones only, oldest first. Never throws. */
function readHeld(home: string): HeldGroupEntry[] {
  try {
    const file = path.join(home, HELD_GROUPS_FILE);
    if (statSync(file).size > MAX_READ_BYTES) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isObj(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.map(cleanEntry).filter((e): e is HeldGroupEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * Keep one entry for the child (the hold process calls this). Written whole,
 * by temp file and rename, and synced: the hold is this file's only writer
 * while it runs. Only a group's updates and a `tgg:` press are kept, cleaned
 * to what the handler reads. True once it is on disk.
 */
export function keepHeldGroupUpdate(home: string, entry: HeldGroupEntry): boolean {
  const clean = cleanEntry(entry);
  if (!clean) return false;
  const entries = [...readHeld(home), clean].slice(-HELD_GROUPS_MAX);
  const file = path.join(home, HELD_GROUPS_FILE);
  const tmp = `${file}.tmp`;
  try {
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, "w", 0o600);
    try {
      const body = Buffer.from(JSON.stringify({ version: 1, entries }), "utf8");
      let off = 0;
      while (off < body.length) {
        const n = writeSync(fd, body, off, body.length - off);
        if (n <= 0) throw new Error("short write");
        off += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing more to do */
    }
    return false;
  }
}

/**
 * Take what a hold process kept (the child calls this, once). The file goes
 * first: an entry is replayed at most once, so one that cannot be removed is
 * not replayed at all. Oldest first. Never throws.
 */
export function takeHeldGroupUpdates(home: string): HeldGroupEntry[] {
  const file = path.join(home, HELD_GROUPS_FILE);
  const entries = readHeld(home);
  try {
    rmSync(file, { force: true });
  } catch {
    return [];
  }
  return entries;
}
