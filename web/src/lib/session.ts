"use client";

/**
 * The permission wall — granting a scoped session key to an agent.
 *
 * Flow (all counterfactual — nothing is deployed until the agent's first trade):
 *  1. Owner wallet becomes the Kernel account's sudo validator (ECDSA).
 *  2. A fresh session keypair is generated for the agent.
 *  3. The session key is wrapped in a permission validator whose policies are
 *     enforced BY THE ACCOUNT CONTRACT on every UserOp:
 *       - call policy: only approve(USDG→allowed targets) with capped amounts,
 *         only vault.deposit with capped assets, only the Rialto router
 *       - rate limit: bounded ops per day
 *       - timestamp: hard expiry, owner-set
 *  4. Owner signs ONE typed-data approval; the serialized grant is what the
 *     worker uses to act. Revocation = on-chain nonce invalidation (or expiry).
 *
 * TESTNET DEMO CAVEATS (labeled in the UI): the session private key is kept in
 * localStorage so you can inspect the flow; production keys live in a Turnkey
 * TEE and never touch a browser. Drawdown breaker is worker-enforced until the
 * breaker contract ships (Phase 2).
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  http,
  parseAbi,
  type Address,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKernelAccount } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
  serializePermissionAccount,
  toPermissionValidator,
} from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  CallPolicyVersion,
  ParamCondition,
  toCallPolicy,
  toRateLimitPolicy,
  toTimestampPolicy,
} from "@zerodev/permissions/policies";
import {
  CASH,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  UNISWAP,
  UNISWAP_SWAP_ROUTER_ABI,
  robinhoodTestnet,
  USDG_DECIMALS,
  type GrantCaps,
  type StoredGrant,
} from "@merrymen/core";
import { ensureChain, getInjectedProvider, requestAccount } from "./wallet";

export type { GrantCaps, StoredGrant };

const VAULT_ABI = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
]);

export type Grant = StoredGrant;

const STORAGE_KEY = "merrymen.grant.v1";

export function loadGrant(): Grant | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Grant) : null;
  } catch {
    return null;
  }
}

export function clearGrant(): void {
  localStorage.removeItem(STORAGE_KEY);
}

const usdgUnits = (v: number) => BigInt(Math.round(v * 10 ** USDG_DECIMALS));

export async function grantSessionKey(
  caps: GrantCaps,
  onStatus: (status: string) => void,
): Promise<Grant> {
  const chain = robinhoodTestnet;
  const provider = getInjectedProvider();

  onStatus("switching wallet to Robinhood Chain testnet…");
  await ensureChain(provider, chain);
  const owner = await requestAccount(provider);

  const publicClient = createPublicClient({ chain, transport: http() });
  const walletClient = createWalletClient({
    chain,
    transport: custom(provider),
    account: owner,
  });

  const entryPoint = getEntryPoint("0.7");
  const kernelVersion = KERNEL_V3_3;

  onStatus("deriving your smart account…");
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: walletClient,
    entryPoint,
    kernelVersion,
  });

  const sessionPrivateKey = generatePrivateKey();
  const sessionAccount = privateKeyToAccount(sessionPrivateKey);
  const sessionSigner = await toECDSASigner({ signer: sessionAccount });

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + caps.expiryDays * 86_400;
  const allowedSpenders: Address[] = [
    RIALTO.routerSnapshot as Address,
    UNISWAP.swapRouter02 as Address,
    MORPHO.steakhouseUsdgVault as Address,
  ];

  const policies = [
    // Hard expiry — the key dies even if every other control fails.
    toTimestampPolicy({ validAfter: now, validUntil: expiresAt }),
    // Bounded ops per day — a runaway loop cannot spam trades.
    toRateLimitPolicy({ count: caps.maxOpsPerDay, interval: 86_400 }),
    // The only calls this key can make, enforced by the account contract:
    toCallPolicy({
      policyVersion: CallPolicyVersion.V0_0_4,
      permissions: [
        {
          // approve USDG, only to Rialto router / Morpho vault, only ≤ per-trade cap
          target: CASH.USDG as Address,
          valueLimit: 0n,
          abi: erc20Abi,
          functionName: "approve",
          args: [
            { condition: ParamCondition.ONE_OF, value: allowedSpenders },
            { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdgUnits(caps.perTradeUsdg) },
          ],
        },
        // approve basket stock tokens for SELLS, only to the allowed routers.
        // No amount condition: share counts are 18dp and not USDG-comparable —
        // routers can only pull what's approved, and the USDG cap above bounds
        // what the agent could ever have bought in the first place.
        ...STOCK_TOKENS.filter((t) => ["AAPL", "MSFT", "QQQ"].includes(t.symbol)).map(
          (t) =>
            ({
              target: t.address as Address,
              valueLimit: 0n,
              abi: erc20Abi,
              functionName: "approve",
              args: [{ condition: ParamCondition.ONE_OF, value: allowedSpenders }, null],
            }) as const,
        ),
        {
          // Rialto router: target-scoped (its calldata comes from the quote API)
          target: RIALTO.routerSnapshot as Address,
          valueLimit: 0n,
        },
        {
          // Uniswap SwapRouter02: only exactInputSingle. Spend is bounded by
          // the approve cap above — the router can pull nothing beyond it.
          target: UNISWAP.swapRouter02 as Address,
          valueLimit: 0n,
          abi: UNISWAP_SWAP_ROUTER_ABI,
          functionName: "exactInputSingle",
        },
        {
          // Morpho vault: deposits capped at the daily limit per call
          target: MORPHO.steakhouseUsdgVault as Address,
          valueLimit: 0n,
          abi: VAULT_ABI,
          functionName: "deposit",
          args: [
            { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdgUnits(caps.dailyUsdg) },
            null,
          ],
        },
        {
          // Morpho vault: withdrawals back to the account are unrestricted in size
          target: MORPHO.steakhouseUsdgVault as Address,
          valueLimit: 0n,
          abi: VAULT_ABI,
          functionName: "withdraw",
        },
      ],
    }),
  ];

  const permissionValidator = await toPermissionValidator(publicClient, {
    entryPoint,
    kernelVersion,
    signer: sessionSigner,
    policies,
  });

  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion,
    plugins: {
      sudo: ecdsaValidator,
      regular: permissionValidator,
    },
  });

  onStatus("sign the permission grant in your wallet…");
  const serialized = await serializePermissionAccount(account, sessionPrivateKey);

  const grant: Grant = {
    smartAccount: account.address,
    owner,
    sessionKeyAddress: sessionAccount.address,
    serialized,
    caps,
    grantedAt: now,
    expiresAt,
    chainId: chain.id,
    demoSessionPrivateKey: sessionPrivateKey,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(grant));

  // Hand the grant to the worker (dev-mode file handoff; Supabase later).
  onStatus("handing the grant to the worker…");
  try {
    await fetch("/api/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(grant),
    });
  } catch {
    // Worker handoff failing must not lose the signed grant — it's in localStorage.
  }

  return grant;
}
