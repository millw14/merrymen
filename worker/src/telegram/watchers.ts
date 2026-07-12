/**
 * Pure parsing + formatting for reminders and watchers (tested directly).
 * The notifier evaluates the conditions; this module just turns user text into
 * typed records and back into chat-friendly strings.
 */

import { esc } from "./api";
import type { Reminder, Watcher } from "./state";

/** Parse a relative delay ("20m", "2h", "90s", "1d", "in 30 min") → seconds, or null. */
export function parseWhenSec(when: string): number | null {
  const w = when.trim().toLowerCase().replace(/^in\s+/, "");
  const m = w.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (!m || !m[1] || !m[2]) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2][0]; // s | m | h | d
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  const sec = Math.round(n * mult);
  return sec > 0 && sec <= 31 * 86400 ? sec : null; // cap at ~a month
}

export type WatchSpec = { kind: "cpu"; threshold: number } | { kind: "file"; arg: string } | { kind: "proc"; arg: string };

/** Parse "cpu>80", "cpu 80", "file <path>", "proc <name>" → a typed watch spec, or null. */
export function parseWatchSpec(spec: string): WatchSpec | null {
  const s = spec.trim();
  const cpu = s.match(/^cpu\s*(?:[>=]|over|above)?\s*(\d{1,3})\s*%?$/i);
  if (cpu && cpu[1]) {
    const t = Number(cpu[1]);
    return t >= 1 && t <= 100 ? { kind: "cpu", threshold: t } : null;
  }
  const file = s.match(/^file\s+(.+)$/i);
  if (file && file[1]) return { kind: "file", arg: file[1].trim() };
  const proc = s.match(/^proc(?:ess)?\s+(.+)$/i);
  if (proc && proc[1]) return { kind: "proc", arg: proc[1].trim() };
  return null;
}

export function reminderLine(r: Reminder, nowSec: number): string {
  const left = Math.max(0, r.fireAt - nowSec);
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const when = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${left}s`;
  return `#${r.id} in ${when} — ${esc(r.text)}`;
}

export function watcherLine(w: Watcher): string {
  const desc =
    w.kind === "cpu" ? `cpu > ${w.threshold}%` : w.kind === "file" ? `file ${esc(w.arg)}` : `process ${esc(w.arg)}`;
  return `#${w.id} ${desc}`;
}

export function fmtReminders(reminders: Reminder[], nowSec: number): string {
  if (!reminders.length) return "⏰ no reminders set. Try /remind 20m stretch.";
  return "⏰ <b>reminders</b>\n" + reminders.map((r) => reminderLine(r, nowSec)).join("\n");
}

export function fmtWatchers(watchers: Watcher[]): string {
  if (!watchers.length) return "👀 no watchers set. Try /watch cpu>80 or /watch file C:\\path\\build.log.";
  return "👀 <b>watchers</b>\n" + watchers.map(watcherLine).join("\n");
}
