/**
 * ~/.merrymen — the user's home for everything that is THEIRS: settings,
 * grant, ledger, heartbeat, and their strategies. The install location
 * (npm global dir or a checkout) is disposable; upgrades and reinstalls
 * never touch user data. Override with MERRYMEN_HOME for tests/multi-agent.
 *
 * Legacy migration: early versions kept data in <repo>/.data. If that exists
 * and the home file doesn't, files are copied over once, so nothing is lost.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function merrymenHome(): string {
  return process.env.MERRYMEN_HOME ?? path.join(os.homedir(), ".merrymen");
}

export const homePaths = {
  settings: () => path.join(merrymenHome(), "settings.json"),
  grant: () => path.join(merrymenHome(), "grant.json"),
  heartbeat: () => path.join(merrymenHome(), "heartbeat.json"),
  db: () => path.join(merrymenHome(), "merrymen.db"),
  strategies: () => path.join(merrymenHome(), "strategies"),
  /** Telegram runtime state: update offset, link code, owner id. */
  telegram: () => path.join(merrymenHome(), "telegram.json"),
  /** Pause marker — present = trading halted (toggled from Telegram/dashboard). */
  paused: () => path.join(merrymenHome(), "paused"),
  /** Scratch dir for transient PC-control artifacts (screenshots, voice notes). */
  scratch: () => path.join(merrymenHome(), "scratch"),
};

let ensured = false;

/** Create the home tree and migrate legacy <repo>/.data files once. */
export function ensureHome(): string {
  const home = merrymenHome();
  if (ensured) return home;
  mkdirSync(home, { recursive: true });
  mkdirSync(homePaths.strategies(), { recursive: true });
  mkdirSync(homePaths.scratch(), { recursive: true });

  // Legacy checkout layouts: worker ran with cwd=worker/ (../.data) or cwd=root (.data).
  for (const legacyDir of [path.join(process.cwd(), "..", ".data"), path.join(process.cwd(), ".data")]) {
    if (!existsSync(legacyDir)) continue;
    for (const name of ["settings.json", "grant.json", "merrymen.db", "heartbeat.json"]) {
      const from = path.join(legacyDir, name);
      const to = path.join(home, name);
      if (existsSync(from) && !existsSync(to)) {
        try {
          copyFileSync(from, to);
          console.log(`[home] migrated legacy ${name} → ${to}`);
        } catch {
          // best-effort; the worst case is starting fresh
        }
      }
    }
  }
  ensured = true;
  return home;
}
