/**
 * Telegram runtime state, persisted at ~/.merrymen/telegram.json:
 *   - the getUpdates offset (so a restart doesn't replay old messages)
 *   - the one-time link code (shown in the dashboard; consumed by /link)
 *   - the owner chat id (first successful /link)
 *
 * The allowlist itself lives in settings.json (dashboard-editable); this file
 * is worker-managed runtime bookkeeping.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { ensureHome, homePaths } from "../home";

export interface TelegramState {
  offset: number;
  linkCode: string;
  ownerId: number | null;
}

const DEFAULT: TelegramState = { offset: 0, linkCode: "", ownerId: null };

export function loadTelegramState(): TelegramState {
  try {
    const raw = readFileSync(homePaths.telegram(), "utf8").replace(/^﻿/, "");
    const s = JSON.parse(raw) as Partial<TelegramState>;
    return {
      offset: typeof s.offset === "number" ? s.offset : 0,
      linkCode: typeof s.linkCode === "string" ? s.linkCode : "",
      ownerId: typeof s.ownerId === "number" ? s.ownerId : null,
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
 * (which is unavailable in some sandboxes and non-reproducible).
 */
export function ensureLinkCode(state: TelegramState, seed: string): TelegramState {
  if (state.linkCode) return state;
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
  let h = 2166136261 >>> 0;
  for (const ch of seed) {
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
