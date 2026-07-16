"use client";

/**
 * The permission wall — creating an agent account and granting it a scoped key.
 *
 * NO EXTERNAL WALLET. The account's owner key is generated in the browser, so
 * there's nothing to connect — you create the wallet, back up its owner key,
 * and fund the account address. The flow (all counterfactual — nothing is
 * deployed until the agent's first trade):
 *  1. A fresh OWNER keypair is generated → it's the Kernel account's sudo
 *     validator (ECDSA). The smart-account address derives from it.
 *  2. A fresh SESSION keypair is generated for the agent.
 *  3. The session key is wrapped in a permission validator whose policies are
 *     enforced BY THE ACCOUNT CONTRACT on every UserOp:
 *       - call policy: only approve(USDG→allowed targets) with capped amounts,
 *         only vault.deposit with capped assets, only the Rialto router
 *       - rate limit: bounded ops per day
 *       - timestamp: hard expiry
 *  4. The owner key signs the grant locally (no popup); the serialized grant is
 *     what the worker uses to act. Revocation = expiry (or nonce invalidation).
 *
 * TESTNET DEMO CAVEATS (labeled in the UI): both private keys are kept in
 * localStorage so you can inspect and back them up; production owner keys live
 * in a Turnkey TEE and never touch a browser. Whoever holds the owner key
 * controls the funds — the UI forces a backup before funding. Drawdown breaker
 * is worker-enforced until the breaker contract ships (Phase 2).
 */

import { createPublicClient, erc20Abi, http, parseAbi, type Address } from "viem";
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
  TRADEABLE_SYMBOLS,
  UNISWAP,
  UNISWAP_SWAP_ROUTER_ABI,
  chainForId,
  robinhoodTestnet,
  USDG_DECIMALS,
  type GrantCaps,
  type StoredGrant,
} from "@merrymen/core";

export type { GrantCaps, StoredGrant };

/** Testnet gas faucet — where users top up the account's native balance. */
export const FAUCET_URL = "https://faucet.testnet.chain.robinhood.com";

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

/**
 * Mint a grant for a given OWNER key: derive the Kernel account, generate a
 * fresh session key, wrap it in the policy validator, and seal the grant.
 *
 * The account address derives from the owner key alone (the sudo ECDSA
 * validator + factory + index) — the session/permission plugin is enabled at
 * UserOp time and does NOT affect the address. That's what makes restore work:
 * the same owner key always reproduces the same smart account, so an existing
 * funded wallet can be re-armed with a brand-new session key.
 */
async function mintGrant(
  ownerPrivateKey: `0x${string}`,
  caps: GrantCaps,
  onStatus: (status: string) => void,
  chainId: number,
): Promise<Grant> {
  // Testnet is the sandbox; mainnet (4663) is real funds — the UI gates that
  // choice behind an explicit consent step. Note: the call-policy addresses
  // below (UNISWAP/RIALTO/MORPHO/USDG) are MAINNET deployments — the wall is
  // real on mainnet and inert on testnet, where those contracts don't exist
  // and swaps no-route by design.
  const chain = chainForId(chainId);
  const publicClient = createPublicClient({ chain, transport: http() });

  const entryPoint = getEntryPoint("0.7");
  const kernelVersion = KERNEL_V3_3;

  const ownerAccount = privateKeyToAccount(ownerPrivateKey);
  const owner = ownerAccount.address;

  onStatus("deriving your smart account…");
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
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
        // approve the TRADEABLE stock tokens for SELLS, only to the allowed
        // routers. These match the v3-liquid set (tokens.ts) so a token the agent
        // can buy, it can also sell. No amount condition: share counts are 18dp and
        // not USDG-comparable — routers can only pull what's approved, and the USDG
        // cap above bounds what the agent could ever have bought in the first place.
        ...STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol)).map(
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
          // USDG transfer OUT of the wall — recipient free-form (chat /transfer,
          // user-confirmed) but the amount is hard-capped per call ON-CHAIN at
          // the per-trade cap. Daily budgets bound it further worker-side.
          target: CASH.USDG as Address,
          valueLimit: 0n,
          abi: erc20Abi,
          functionName: "transfer",
          args: [
            null,
            { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdgUnits(caps.perTradeUsdg) },
          ],
        },
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

  onStatus("sealing the permission grant…");
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
    grantFeatures: ["transfer"],
    demoSessionPrivateKey: sessionPrivateKey,
    demoOwnerPrivateKey: ownerPrivateKey,
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

/**
 * Create a BRAND-NEW agent wallet: a fresh owner key is generated in-browser
 * (this is the account's sudo signer and the root of fund custody — no external
 * wallet, nothing to connect), then a grant is sealed on it.
 */
export async function createAgentWallet(
  caps: GrantCaps,
  onStatus: (status: string) => void,
  chainId: number = robinhoodTestnet.id,
): Promise<Grant> {
  onStatus("minting your agent's owner key…");
  return mintGrant(generatePrivateKey(), caps, onStatus, chainId);
}

/**
 * RESTORE an existing agent wallet from its backed-up owner key — the way back
 * in after a kill switch, a discarded grant, or a new machine. The same owner
 * key re-derives the SAME smart account, so a wallet you already funded comes
 * back to life with a brand-new session key and whatever caps you pick now.
 * Nothing moves on-chain; no funds are touched.
 */
export async function restoreAgentWallet(
  ownerPrivateKey: `0x${string}`,
  caps: GrantCaps,
  onStatus: (status: string) => void,
  chainId: number = robinhoodTestnet.id,
): Promise<Grant> {
  onStatus("re-deriving your smart account from the owner key…");
  return mintGrant(ownerPrivateKey, caps, onStatus, chainId);
}

export interface OwnerPreview {
  /** The smart account this owner key controls — where your funds actually are. */
  smartAccount: Address;
  /** The owner key's own EOA — what MetaMask would show (usually empty). */
  owner: Address;
}

/**
 * Read-only: which smart account does this owner key control? Lets the restore
 * flow show the derived address (and its balances) so the user can confirm it's
 * the funded wallet they meant BEFORE anything is signed or armed.
 */
export async function previewOwnerAccount(
  ownerPrivateKey: `0x${string}`,
  chainId: number = robinhoodTestnet.id,
): Promise<OwnerPreview> {
  const chain = chainForId(chainId);
  const publicClient = createPublicClient({ chain, transport: http() });
  const ownerAccount = privateKeyToAccount(ownerPrivateKey);
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
    entryPoint: getEntryPoint("0.7"),
    kernelVersion: KERNEL_V3_3,
  });
  // sudo-only derivation — the permission plugin doesn't change the address.
  const account = await createKernelAccount(publicClient, {
    entryPoint: getEntryPoint("0.7"),
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator },
  });
  return { smartAccount: account.address, owner: ownerAccount.address };
}

/** Live on-chain balances of the account address — for the "fund it" step. */
export interface Funding {
  gasWei: bigint;
  usdgUnits: bigint;
  usdg: number;
}

export async function readFunding(smartAccount: Address, chainId: number = robinhoodTestnet.id): Promise<Funding> {
  const publicClient = createPublicClient({ chain: chainForId(chainId), transport: http() });
  const [gasWei, usdgUnits] = await Promise.all([
    publicClient.getBalance({ address: smartAccount }).catch(() => 0n),
    publicClient
      .readContract({
        address: CASH.USDG as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [smartAccount],
      })
      .then((v) => v as bigint)
      .catch(() => 0n),
  ]);
  return { gasWei, usdgUnits, usdg: Number(usdgUnits) / 10 ** USDG_DECIMALS };
}
