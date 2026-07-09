/**
 * Dev-mode grant handoff + agent status.
 * POST: browser saves a signed grant → .data/grant.json (worker picks it up).
 * GET: full agent status — grant, live balances from the grant chain, worker heartbeat.
 * DELETE: discard the grant file (localStorage cleared client-side).
 * Replaced by Supabase (encrypted, per-user) once persistence lands.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbi } from "viem";
import {
  CASH,
  MORPHO,
  robinhoodChain,
  robinhoodTestnet,
  type StoredGrant,
} from "@merrymen/core";

const DATA_DIR = path.join(process.cwd(), "..", ".data");
const GRANT_FILE = path.join(DATA_DIR, "grant.json");
const HEARTBEAT_FILE = path.join(DATA_DIR, "heartbeat.json");

const BALANCE_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export interface AgentStatus {
  exists: boolean;
  grant?: Omit<StoredGrant, "serialized" | "demoSessionPrivateKey">;
  balances?: { ethWei: string; cashUsdg: string; vaultUsdg: string };
  workerAliveAt?: number | null;
}

export async function POST(req: Request) {
  const grant = (await req.json()) as StoredGrant;
  if (!grant?.serialized || !grant?.smartAccount) {
    return NextResponse.json({ error: "not a grant" }, { status: 400 });
  }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(GRANT_FILE, JSON.stringify(grant, null, 2), "utf8");
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
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

  const chain = grant.chainId === robinhoodTestnet.id ? robinhoodTestnet : robinhoodChain;
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
  try {
    const hb = JSON.parse(await readFile(HEARTBEAT_FILE, "utf8")) as { at: number };
    workerAliveAt = hb.at;
  } catch {
    // no heartbeat file — worker never ran
  }

  const { serialized: _s, demoSessionPrivateKey: _k, ...publicGrant } = grant;

  const status: AgentStatus = {
    exists: true,
    grant: publicGrant,
    balances: {
      ethWei: ethWei.toString(),
      cashUsdg: (tokenReads?.[0]?.status === "success" ? (tokenReads[0].result as bigint) : 0n).toString(),
      vaultUsdg: (tokenReads?.[1]?.status === "success" ? (tokenReads[1].result as bigint) : 0n).toString(),
    },
    workerAliveAt,
  };
  return NextResponse.json(status);
}
