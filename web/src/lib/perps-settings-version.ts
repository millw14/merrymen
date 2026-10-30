import { createHash } from "node:crypto";

/** An opaque revision; never return the stored text, which may contain credentials. */
export function perpsSettingsVersion(version: string | null, owner: string | null): string {
  return createHash("sha256").update(JSON.stringify(["perps-settings-v1", owner?.toLowerCase() ?? null, version])).digest("hex");
}
