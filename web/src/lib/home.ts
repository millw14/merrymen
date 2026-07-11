/**
 * ~/.merrymen — where all user data lives (settings, grant, ledger,
 * strategies). Shared convention with the worker and CLI; override with
 * MERRYMEN_HOME. The web app never writes anywhere else.
 */

import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function merrymenHome(): string {
  const home = process.env.MERRYMEN_HOME ?? path.join(os.homedir(), ".merrymen");
  try {
    mkdirSync(home, { recursive: true });
  } catch {
    // reads on a missing dir fail gracefully downstream
  }
  return home;
}

export const homePaths = {
  settings: () => path.join(merrymenHome(), "settings.json"),
  grant: () => path.join(merrymenHome(), "grant.json"),
  heartbeat: () => path.join(merrymenHome(), "heartbeat.json"),
  db: () => path.join(merrymenHome(), "merrymen.db"),
  strategies: () => path.join(merrymenHome(), "strategies"),
};
