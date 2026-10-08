import { grantPurpose, type GrantPurpose, type MerrymenSettings } from "../../packages/core/src/index";

// This is authority separation in the handoff, runtime and accounting. Workers
// still share the host UID; separate homes are not a filesystem sandbox against
// a compromised process. Deployments needing that boundary must isolate UIDs or
// containers as well, without sharing each other's credential volumes.

/** An execution slot is not an authentication identity or a wallet address. */
export type WorkerPurpose = GrantPurpose;
export type WorkerExecutionKey = `0x${string}`;

export function workerExecutionKey(owner: string, purpose: WorkerPurpose = "spot"): WorkerExecutionKey {
  if (!/^0x[0-9a-f]{40}$/i.test(owner)) throw new RangeError("worker owner must be an address");
  return `${owner.toLowerCase()}${purpose === "perps" ? ":perps" : ""}` as WorkerExecutionKey;
}

export function workerPurpose(key: string): WorkerPurpose {
  return key.endsWith(":perps") ? "perps" : "spot";
}

export function workerOwner(key: string): `0x${string}` {
  const owner = workerPurpose(key) === "perps" ? key.slice(0, -6) : key;
  if (!/^0x[0-9a-f]{40}$/i.test(owner)) throw new RangeError("worker owner must be an address");
  return owner.toLowerCase() as `0x${string}`;
}

/** Never materialize the other wallet's session authority in this slot. */
export function grantMatchesWorkerExecution(key: string, grant: { purpose?: unknown }): boolean {
  try { return grantPurpose(grant) === workerPurpose(key); }
  catch { return false; }
}

/** The dedicated wallet cannot acquire Spot producers or its Telegram bot. */
export function perpsWorkerSettings(settings: MerrymenSettings | null): MerrymenSettings {
  const out: MerrymenSettings = { ...settings, strategy: "perps-only" };
  delete out.telegramBotToken;
  delete out.telegramAllowlist;
  // Holder claims currently entitle one agent. Never duplicate Spot's claim.
  delete out.holderAddress;
  delete out.holderProof;
  return out;
}
