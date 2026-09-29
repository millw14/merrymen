/**
 * THE HOSTED CHILD'S LIGHTER KEY — opened by the orchestrator, written into
 * the child's home, never put anywhere else.
 *
 * docs/perps.md rule 5: "Hosted, the orchestrator decrypts the key and writes
 * perp-key.json (0600) into the tenant's child home beside grant.json; the
 * child never holds the DEK." This is that write, called from
 * writeGrantForChild (spawn) and refreshGrantForChild (a re-sign under a
 * running child) in orchestrator.ts.
 *
 * WHY A FILE AND NOT THE ENVIRONMENT. A child's env is visible to every
 * process it spawns and to anything that can read /proc/<pid>/environ as the
 * same user; it is also copied wholesale by childEnv. A 0600 file in the
 * child's own home is read once by keystore.loadPerpPrivateKey, checked
 * against the sealed public key, and is removed with the home on kill.
 *
 * THE FORMAT IS keystore.writePerpKeyFile's ({ v, publicKey, privateKey }),
 * because keystore.readKeyFile is the one reader and demands exactly that
 * pairing: a file whose public half is not the grant's sealed key is refused
 * there, so a stale or foreign file can never be signed with.
 *
 * WRITE KEY BEFORE GRANT, REMOVE KEY AFTER GRANT. The child re-arms when
 * grant.json changes; writing the key first means the new grant never arrives
 * in a home without its key. Removing a stale key only once the grant without a
 * perp block is in place means an armed child never loses its key mid-lane —
 * and the server has already proven the venue flat before accepting that grant
 * (rule 5's 409).
 *
 * ATOMIC AND 0600 FROM THE FIRST BYTE: a temp file created `wx` with mode 0600,
 * fsync'd, renamed over the target. The orchestrator is the only writer of
 * this path, so rename (not link) is right: a rotation must replace it. That
 * rename destroys the child's only copy of the old key, which is safe ONLY
 * because the server admits a key change on the same account, like a drop,
 * once the venue reads provably flat (perp-custody.ts dropsVenueKey, rule 5's
 * 409) — the registered key stays valid at the venue until a changePubKey for
 * the new one lands, and must never be the one thing holding open positions.
 *
 * NOTHING HERE LOGS KEY MATERIAL; outcomes are words.
 */

import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { grantPerp } from "../../../packages/core/src/index";
import { hostedPerpKeyFile } from "./keystore";
import { openPerpKey } from "./key-seal";

export type ChildPerpKeyOutcome =
  /** perp-key.json now holds the grant's key. */
  | "written"
  /** It already did; nothing was touched. */
  | "unchanged"
  /** The grant has no perp block and a stale perp-key.json was removed. */
  | "removed"
  /** No perp block and no file: nothing to do. */
  | "absent"
  /** A perp block with no sealed key (not a hosted grant): the file is left alone. */
  | "unsealed"
  /** No DEK in this process: nothing written, nothing removed. */
  | "no-dek"
  /** The blob does not open for this tenant/account/key: nothing written, nothing removed. */
  | "unopenable"
  /** The filesystem refused. */
  | "io-error";

/**
 * Bring `<home>/perp-key.json` in line with the grant about to be (or just)
 * written beside it. Call with phase "before-grant" before grant.json is
 * written (it writes, never removes) and "after-grant" after (it removes a
 * stale key, never writes) — or "both" when there is no grant write between.
 */
export function syncChildPerpKey(args: {
  home: string;
  tenant: `0x${string}`;
  grant: { smartAccount?: string; chainId: number; grantFeatures?: readonly string[]; perp?: unknown };
  dek: Buffer | null;
  phase: "before-grant" | "after-grant" | "both";
}): ChildPerpKeyOutcome {
  const file = hostedPerpKeyFile(args.home);
  const perp = grantPerp(args.grant);

  if (perp === null) {
    if (args.phase === "before-grant") return "absent";
    try {
      lstatSync(file);
    } catch {
      return "absent";
    }
    try {
      rmSync(file, { force: true });
      return "removed";
    } catch {
      return "io-error";
    }
  }

  if (args.phase === "after-grant") return "unchanged";
  if (perp.apiKeySealed === undefined) return "unsealed";
  if (!args.dek) return "no-dek";
  let privateKey: `0x${string}`;
  try {
    privateKey = openPerpKey(
      perp.apiKeySealed,
      { tenant: args.tenant, smartAccount: String(args.grant.smartAccount ?? ""), apiPublicKey: perp.apiPublicKey, apiKeyIndex: perp.apiKeyIndex },
      args.dek,
    );
  } catch {
    return "unopenable";
  }

  const body = `${JSON.stringify({ v: 1, publicKey: perp.apiPublicKey, privateKey }, null, 2)}\n`;
  try {
    // Unchanged only if it is ALSO still owner-only: keystore refuses a
    // group/world-readable key file, so a loosened mode is rewritten, not kept.
    const st = lstatSync(file);
    const privateMode = process.platform === "win32" || (st.mode & 0o077) === 0;
    if (st.isFile() && privateMode && readFileSync(file, "utf8") === body) return "unchanged";
  } catch {
    // No file yet (or unreadable): write it.
  }
  const tmp = path.join(args.home, `.perp-key.${process.pid}.${Date.now()}.tmp`);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
    return "io-error";
  }
  return "written";
}
