/**
 * Telegram runtime state, persisted at ~/.merrymen/telegram.json:
 *   - the getUpdates offset (so a restart doesn't replay old messages)
 *   - the link code (shown in the dashboard; consumed by /link) and its round —
 *     the round increments on every successful link so the code ROTATES and a
 *     used code can't link a second chat
 *   - the owner chat id (first successful /link) — also the notifier's recipient
 *   - notifier bookkeeping: last trade row pinged, per-condition alert dedupe,
 *     the last day a digest went out
 *   - user-set price alerts
 *
 * The allowlist itself lives in settings.json (dashboard-editable); this file
 * is worker-managed runtime bookkeeping.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { ensureHome, homePaths } from "../home";

export interface PriceAlert {
  id: number;
  symbol: string;
  op: ">" | "<";
  price: number;
  /** Last price seen for this symbol — crossing-edge detection. */
  lastPrice?: number;
}

export interface Reminder {
  id: number;
  fireAt: number; // unix seconds
  text: string;
}

export interface Watcher {
  id: number;
  kind: "cpu" | "file" | "proc";
  /** For cpu: threshold percent (in `threshold`); for file: a path; for proc: a name. */
  arg: string;
  threshold?: number;
  /** Last observed boolean condition (cpu-above / proc-running) — edge-triggered. */
  lastState?: boolean;
  /** Last observed numeric value (file mtime ms) — change-triggered. */
  lastValue?: number;
}

export interface TelegramState {
  offset: number;
  linkCode: string;
  /** Increments on each successful /link so the code rotates. */
  linkRound: number;
  ownerId: number | null;
  /** Unix seconds of the FIRST successful /link — the relationship's day zero. */
  linkedAt: number | null;
  /** Owner messages handled — feeds the relationship stage. */
  messageCount: number;
  /** Highest trades.id already pushed to the owner chat. -1 = not initialized. */
  lastNotifiedTradeId: number;
  /** Condition-episode dedupe: key → unix seconds last fired. */
  firedAlerts: Record<string, number>;
  /** YYYY-MM-DD of the last daily digest sent. */
  lastDigestDate: string;
  priceAlerts: PriceAlert[];
  reminders: Reminder[];
  watchers: Watcher[];
  /** Monotonic id source for reminders/watchers. */
  nextId: number;
}

const DEFAULT: TelegramState = {
  offset: 0,
  linkCode: "",
  linkRound: 0,
  ownerId: null,
  linkedAt: null,
  messageCount: 0,
  lastNotifiedTradeId: -1,
  firedAlerts: {},
  lastDigestDate: "",
  priceAlerts: [],
  reminders: [],
  watchers: [],
  nextId: 1,
};

export function loadTelegramState(): TelegramState {
  try {
    const raw = readFileSync(homePaths.telegram(), "utf8").replace(/^﻿/, "");
    const s = JSON.parse(raw) as Partial<TelegramState>;
    return {
      offset: typeof s.offset === "number" ? s.offset : 0,
      linkCode: typeof s.linkCode === "string" ? s.linkCode : "",
      linkRound: typeof s.linkRound === "number" ? s.linkRound : 0,
      ownerId: typeof s.ownerId === "number" ? s.ownerId : null,
      linkedAt: typeof s.linkedAt === "number" ? s.linkedAt : null,
      messageCount: typeof s.messageCount === "number" ? s.messageCount : 0,
      lastNotifiedTradeId: typeof s.lastNotifiedTradeId === "number" ? s.lastNotifiedTradeId : -1,
      firedAlerts: s.firedAlerts && typeof s.firedAlerts === "object" ? (s.firedAlerts as Record<string, number>) : {},
      lastDigestDate: typeof s.lastDigestDate === "string" ? s.lastDigestDate : "",
      priceAlerts: Array.isArray(s.priceAlerts)
        ? (s.priceAlerts as PriceAlert[]).filter(
            (a) =>
              a &&
              typeof a.id === "number" &&
              typeof a.symbol === "string" &&
              (a.op === ">" || a.op === "<") &&
              typeof a.price === "number",
          )
        : [],
      reminders: Array.isArray(s.reminders)
        ? (s.reminders as Reminder[]).filter((r) => r && typeof r.id === "number" && typeof r.fireAt === "number" && typeof r.text === "string")
        : [],
      watchers: Array.isArray(s.watchers)
        ? (s.watchers as Watcher[]).filter(
            (w) => w && typeof w.id === "number" && (w.kind === "cpu" || w.kind === "file" || w.kind === "proc") && typeof w.arg === "string",
          )
        : [],
      nextId: typeof s.nextId === "number" && s.nextId > 0 ? s.nextId : 1,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveTelegramState(state: TelegramState): void {
  try {
    ensureHome();
    writeFileSync(homePaths.telegram(), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // best-effort; worst case we replay a few messages after a restart
  }
}

/**
 * Ensure a link code exists (6-char, unambiguous alphabet). Deterministic input
 * is required — pass a seed so this stays pure/testable and avoids Math.random
 * (which is unavailable in some sandboxes and non-reproducible). The linkRound
 * is folded into the hash so consuming a code (round++) yields a fresh one.
 */
export function ensureLinkCode(state: TelegramState, seed: string): TelegramState {
  if (state.linkCode) return state;
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
  const input = `${seed}:${state.linkRound}`;
  let h = 2166136261 >>> 0;
  for (const ch of input) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[h % ALPHABET.length];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return { ...state, linkCode: code };
}

/** Consume the current link code: bump the round and clear it so the next
 * ensureLinkCode() mints a fresh one. Call after every successful /link. */
export function rotateLinkCode(state: TelegramState, seed: string): TelegramState {
  return ensureLinkCode({ ...state, linkCode: "", linkRound: state.linkRound + 1 }, seed);
}

/**
 * Shared mutable handle over the persisted state. The poll service and the
 * notifier both read AND write telegram.json; giving each its own in-memory
 * copy would lose writes (last save wins). One ref, every set() persists.
 */
export interface StateRef {
  get(): TelegramState;
  set(next: TelegramState): void;
}

export function createStateRef(): StateRef {
  let state = loadTelegramState();
  return {
    get: () => state,
    set: (next) => {
      state = next;
      saveTelegramState(next);
    },
  };
}
