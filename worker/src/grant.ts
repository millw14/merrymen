import { readFileSync } from "node:fs";
import type { StoredGrant } from "../../packages/core/src/index";
import { homePaths } from "./home";

/** Reads the grant handoff written by web's /api/grants (~/.merrymen/grant.json). */
export function loadGrantFile(): StoredGrant | null {
  const file = process.env.MERRYMEN_GRANT_FILE ?? homePaths.grant();
  try {
    const grant = JSON.parse(readFileSync(file, "utf8")) as StoredGrant;
    if (!grant.serialized || !grant.smartAccount) return null;
    return grant;
  } catch {
    return null;
  }
}
