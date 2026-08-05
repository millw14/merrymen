import { readFile } from "node:fs/promises";
import type { StoredGrant } from "@merrymen/core";
import { homePaths } from "./home";

/** Read the local signed grant without ever returning its serialized keys to a client. */
export async function readStoredGrant(): Promise<StoredGrant | null> {
  try {
    const grant = JSON.parse(await readFile(homePaths.grant(), "utf8")) as StoredGrant;
    return grant.smartAccount && grant.serialized ? grant : null;
  } catch {
    return null;
  }
}
