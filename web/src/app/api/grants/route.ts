/**
 * Dev-mode grant handoff + agent status.
 * POST: browser saves a signed grant → .data/grant.json (worker picks it up).
 * GET: full agent status — grant, live balances from the grant chain, worker heartbeat.
 * DELETE: discard the grant file (localStorage cleared client-side).
 * Replaced by Supabase (encrypted, per-user) once persistence lands.
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { homePaths, merrymenHome } from "@/lib/home";
import { createPublicClient, http, parseAbi } from "viem";
import { CASH, MORPHO, chainForId, type StoredGrant } from "@merrymen/core";

const DATA_DIR = merrymenHome();
const GRANT_FILE = homePaths.grant();
const HEARTBEAT_FILE = homePaths.heartbeat();
const ARCHIVE_DIR = homePaths.grantsArchive();

const BALANCE_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** A well-formed 0x EVM address — the ONLY thing we ever build an archive filename
 * from. Rejecting anything else keeps `smartAccount` from smuggling path separators
 * (../, absolute paths) into archiveCurrentGrant's `${addr}.json`. */
const isAddr = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Copy whatever grant.json currently holds into the archive, keyed by its smart
 * account, BEFORE we overwrite or delete it.
 *
 * grant.json is a single slot: creating a second wallet (or hitting the kill
 * switch) used to destroy the previous grant — and with it the ONLY on-disk copy
 * of that wallet's owner key, permanently stranding any funds still in it. This
 * is the safety net. Best-effort: archiving must never block arming a grant.
 */
async function archiveCurrentGrant(): Promise<void> {
  try {
    const raw = await readFile(GRANT_FILE, "utf8");
    const prev = JSON.parse(raw) as StoredGrant;
    if (!isAddr(prev?.smartAccount)) return; // never derive a path from a malformed address
    await mkdir(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
    // One file per wallet, named by its address. Re-arming the same wallet just
    // refreshes its archive copy; a different wallet gets its own file.
    const dst = path.join(ARCHIVE_DIR, `${prev.smartAccount.toLowerCase()}.json`);
    await writeFile(dst, raw, { encoding: "utf8", mode: 0o600 });
    // This file holds a plaintext OWNER KEY — keep it owner-only (0600), not the
    // default world-readable 0644. chmod covers the file-already-existed case.
    await chmod(dst, 0o600).catch(() => {});
  } catch {
    // no grant.json yet, or it's unreadable — nothing worth keeping
  }
}

export interface AgentStatus {
  exists: boolean;
  grant?: Omit<StoredGrant, "serialized" | "demoSessionPrivateKey" | "demoOwnerPrivateKey">;
  balances?: { ethWei: string; cashUsdg: string; vaultUsdg: string };
  workerAliveAt?: number | null;
  /** "paper" (simulated fills), "live" (signing), or "idle" — from the heartbeat. */
  mode?: "paper" | "live" | "idle" | null;
}

export async function POST(req: Request) {
  const grant = (await req.json()) as StoredGrant;
  if (!grant?.serialized || !isAddr(grant?.smartAccount)) {
    return NextResponse.json({ error: "not a grant" }, { status: 400 });
  }
  await mkdir(DATA_DIR, { recursive: true });
  // Keep the outgoing wallet (and its owner key) before this one replaces it.
  await archiveCurrentGrant();
  // grant.json holds the owner + session PRIVATE KEYS — owner-only perms (0600).
  await writeFile(GRANT_FILE, JSON.stringify(grant, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(GRANT_FILE, 0o600).catch(() => {});
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  // The kill switch destroys the session key, NOT the wallet — archive it so the
  // owner key survives and the funds stay reachable.
  await archiveCurrentGrant();
  await rm(GRANT_FILE, { force: true });
  return NextResponse.json({ ok: true });
}

export async function GET() {
  let grant: StoredGrant;
  try {
    grant = JSON.parse(await readFile(GRANT_FILE, "utf8")) as StoredGrant;
  } catch {
    return NextResponse.json({ exists: false } satisfies AgentStatus);
  }

  const chain = chainForId(grant.chainId);
  const client = createPublicClient({ chain, transport: http() });

  const [ethWei, tokenReads] = await Promise.all([
    client.getBalance({ address: grant.smartAccount }).catch(() => 0n),
    client
      .multicall({
        contracts: [
          { address: CASH.USDG as `0x${string}`, abi: BALANCE_ABI, functionName: "balanceOf", args: [grant.smartAccount] },
          { address: MORPHO.steakhouseUsdgVault as `0x${string}`, abi: BALANCE_ABI, functionName: "balanceOf", args: [grant.smartAccount] },
        ],
      })
      .catch(() => null),
  ]);

  let workerAliveAt: number | null = null;
  let mode: AgentStatus["mode"] = null;
  try {
    const hb = JSON.parse(await readFile(HEARTBEAT_FILE, "utf8")) as { at: number; mode?: AgentStatus["mode"] };
    workerAliveAt = hb.at;
    mode = hb.mode ?? null;
  } catch {
    // no heartbeat file — worker never ran
  }

  // Never echo key material to the browser: the serialized session account, the
  // session key, AND the generated owner key (which custodies the funds).
  const { serialized: _s, demoSessionPrivateKey: _k, demoOwnerPrivateKey: _o, ...publicGrant } = grant;

  const status: AgentStatus = {
    exists: true,
    grant: publicGrant,
    balances: {
      ethWei: ethWei.toString(),
      cashUsdg: (tokenReads?.[0]?.status === "success" ? (tokenReads[0].result as bigint) : 0n).toString(),
      vaultUsdg: (tokenReads?.[1]?.status === "success" ? (tokenReads[1].result as bigint) : 0n).toString(),
    },
    workerAliveAt,
    mode,
  };
  return NextResponse.json(status);
}
