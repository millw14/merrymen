import { readFileSync } from "node:fs";
import path from "node:path";
import type { StoredGrant } from "@merrymen/core";

/** Reads the dev-mode grant handoff written by web's /api/grants. */
export function loadGrantFile(): StoredGrant | null {
  const file =
    process.env.MERRYMEN_GRANT_FILE ??
    path.join(process.cwd(), "..", ".data", "grant.json");
  try {
    const grant = JSON.parse(readFileSync(file, "utf8")) as StoredGrant;
    if (!grant.serialized || !grant.smartAccount) return null;
    return grant;
  } catch {
    return null;
  }
}
