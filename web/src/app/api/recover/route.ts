/**
 * Recover funds — the dashboard's "get my money out" endpoint.
 *
 * The funded address is a counterfactual ERC-4337 smart account; its owner key
 * controls it but derives a DIFFERENT address, and after a kill the session key
 * is gone. This rebuilds the account from the OWNER key (sudo) and sweeps every
 * balance to an address the user controls — the same engine `merrymen recover`
 * runs on the CLI (worker/src/recover.ts), reused here so there's one code path.
 *
 * Key handling: for an active grant the owner key is read from ~/.merrymen/
 * grant.json and NEVER leaves the server. For a killed/expired agent (no grant
 * file) the user pastes their backed-up key; it reaches only this localhost
 * route, is used to sign one op, and is never logged or echoed back. The bundler
 * key stays server-side in both cases. The dashboard binds to 127.0.0.1.
 *
 *   GET             → recovery context for the active grant (balances, bundler?)
 *   POST {mode:plan}→ rebuild from a key (stored or pasted) and read balances
 *   POST {mode:sweep, to} → sign + submit the sweep, return the tx hash
 */

import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { homePaths } from "@/lib/home";
import {
  chainForId,
  explorerFor,
  pimlicoBundlerUrl,
  robinhoodChain,
  type MerrymenSettings,
  type StoredGrant,
} from "@merrymen/core";
import { planRecovery, recoverFunds } from "@merrymen/recover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isKey = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const isAddr = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function readGrant(): Promise<StoredGrant | null> {
  try {
    return JSON.parse(await readFile(homePaths.grant(), "utf8")) as StoredGrant;
  } catch {
    return null;
  }
}

async function readSettings(): Promise<MerrymenSettings> {
  try {
    return JSON.parse((await readFile(homePaths.settings(), "utf8")).replace(/^﻿/, "")) as MerrymenSettings;
  } catch {
    return {};
  }
}

/** The effective bundler URL: explicit URL wins, else build Pimlico's from the key. */
function bundlerFor(settings: MerrymenSettings, chainId: number): string | undefined {
  if (settings.bundlerUrl) return settings.bundlerUrl;
  if (settings.bundlerApiKey) return pimlicoBundlerUrl(chainId, settings.bundlerApiKey);
  if (process.env.MERRYMEN_BUNDLER_URL) return process.env.MERRYMEN_BUNDLER_URL;
  if (process.env.MERRYMEN_BUNDLER_API_KEY) return pimlicoBundlerUrl(chainId, process.env.MERRYMEN_BUNDLER_API_KEY);
  return undefined;
}

function rpcFor(settings: MerrymenSettings, chainId: number): string | undefined {
  return chainId === robinhoodChain.id ? settings.rpcMainnet : settings.rpcTestnet;
}

/** Context for the active grant so the panel can render without asking for a key. */
export async function GET() {
  const [grant, settings] = await Promise.all([readGrant(), readSettings()]);

  if (!grant || !isKey(grant.demoOwnerPrivateKey)) {
    // Killed/expired (or externally-owned) — no stored key. The UI asks for the
    // backed-up owner key. hasBundler is a best-effort mainnet guess for the hint.
    return NextResponse.json({ hasStoredKey: false, hasBundler: !!bundlerFor(settings, robinhoodChain.id) });
  }

  const chainId = grant.chainId;
  const hasBundler = !!bundlerFor(settings, chainId);
  try {
    const plan = await planRecovery({
      chain: chainForId(chainId),
      ownerPrivateKey: grant.demoOwnerPrivateKey,
      rpcUrl: rpcFor(settings, chainId),
      expectedSmartAccount: grant.smartAccount,
    });
    return NextResponse.json({
      hasStoredKey: true,
      hasBundler,
      chainId,
      explorer: explorerFor(chainId),
      smartAccount: plan.smartAccount,
      ownerAddress: plan.ownerAddress,
      gasWei: plan.gasWei.toString(),
      balances: plan.balances.map((b) => ({ symbol: b.symbol, amount: b.amount })),
    });
  } catch (e) {
    return NextResponse.json({ hasStoredKey: true, hasBundler, chainId, error: msg(e) });
  }
}

export async function POST(req: Request) {
  let body: { mode?: string; to?: unknown; ownerKey?: unknown; chainId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }

  const [grant, settings] = await Promise.all([readGrant(), readSettings()]);
  const mode = body.mode === "sweep" ? "sweep" : "plan";

  // Prefer a pasted key (killed case); fall back to the active grant's stored key.
  const pasted = isKey(body.ownerKey);
  const ownerKey = pasted ? (body.ownerKey as `0x${string}`) : isKey(grant?.demoOwnerPrivateKey) ? grant!.demoOwnerPrivateKey! : undefined;
  if (!ownerKey) {
    return NextResponse.json({ error: "no owner key — paste the owner key you backed up" }, { status: 400 });
  }

  const chainId = Number.isInteger(body.chainId) ? Number(body.chainId) : grant?.chainId ?? robinhoodChain.id;
  // Only assert an expected account when signing with the grant's OWN stored key
  // (we know which account that is); a pasted key may be for a different wallet.
  const expected = pasted ? undefined : grant?.smartAccount;
  const rpcUrl = rpcFor(settings, chainId);

  try {
    if (mode === "plan") {
      const plan = await planRecovery({
        chain: chainForId(chainId),
        ownerPrivateKey: ownerKey,
        rpcUrl,
        expectedSmartAccount: expected,
      });
      return NextResponse.json({
        smartAccount: plan.smartAccount,
        ownerAddress: plan.ownerAddress,
        gasWei: plan.gasWei.toString(),
        explorer: explorerFor(chainId),
        chainId,
        balances: plan.balances.map((b) => ({ symbol: b.symbol, amount: b.amount })),
      });
    }

    // sweep
    if (!isAddr(body.to)) {
      return NextResponse.json({ error: "destination is not a valid address" }, { status: 400 });
    }
    const bundlerUrl = bundlerFor(settings, chainId);
    if (!bundlerUrl) {
      return NextResponse.json(
        { error: "recovery needs a bundler — add a free Pimlico key in Settings, then try again" },
        { status: 400 },
      );
    }
    const res = await recoverFunds({
      chain: chainForId(chainId),
      ownerPrivateKey: ownerKey,
      bundlerUrl,
      rpcUrl,
      to: body.to,
      expectedSmartAccount: expected,
    });
    return NextResponse.json({
      txHash: res.txHash,
      to: res.to,
      smartAccount: res.smartAccount,
      explorer: explorerFor(chainId),
      chainId,
      balances: res.balances.map((b) => ({ symbol: b.symbol, amount: b.amount })),
    });
  } catch (e) {
    return NextResponse.json({ error: msg(e) }, { status: 500 });
  }
}
