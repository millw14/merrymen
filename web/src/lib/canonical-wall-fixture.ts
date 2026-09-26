/**
 * TEST SUPPORT ONLY — imported by tests, never by application code.
 *
 * Grants built by the REAL packages over a stubbed chain, so the canonical-wall
 * tests exercise genuine ZeroDev serialization rather than a hand-assembled
 * blob that merely resembles it.
 *
 *   signerGrant  runs web/src/lib/session.ts prepareAgentGrant — the same
 *                prepareGrantCore the dashboard, the iOS engine and
 *                sdk/browser.ts sign through — with the chain answered here.
 *   sealWall     is what a tenant holding the owner key could do instead:
 *                build ANY policy set, have the owner enable it, serialize it.
 *                The chain would accept that permission; only the server's
 *                refusal stands between it and the worker.
 *
 * The stub answers exactly the reads a signer makes — the EntryPoint's
 * getSenderAddress (answered by revert, which is how the real one answers),
 * the class-vault factory, the Trencher factory — and refuses anything else, so
 * a new read in the signer fails loudly here instead of being guessed at.
 */
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { serializePermissionAccount, toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  CASH,
  PONS_CLASS_VAULT_FACTORY,
  PONS_CLASS_VAULT_FACTORY_ABI,
  TRENCHER_FACTORY_ABI,
  UNISWAP,
  WALL_POLICY_FLAG,
  assertDerivedAccount,
  buildWallPolicies,
  grantWallOptions,
  robinhoodChain,
  type StoredGrant,
} from "@merrymen/core";

const ENTRY_POINT = getEntryPoint("0.7");
const SENDER_ADDRESS_RESULT = [
  { inputs: [{ name: "sender", type: "address" }], name: "SenderAddressResult", type: "error" },
] as const;

/** The mainnet class-vault factory every signer seals by default. */
export const CLASS_FACTORY = (PONS_CLASS_VAULT_FACTORY[robinhoodChain.id] ?? "").toLowerCase() as Address;
export const CLASS_VAULT = "0x00000000000000000000000000000000000c1a55" as Address;
export const TRENCHER_FACTORY = "0x000000000000000000000000000000000000f4c7" as Address;
export const TRENCHER_VAULT = "0x000000000000000000000000000000000000fa17" as Address;
const TRENCHER_CODE = "0x60006000fd" as Hex;

// trencher-permission.ts reads the trusted bytecode hash once, when it loads.
// session.ts is imported lazily below, so this is set before that happens.
process.env.NEXT_PUBLIC_TRENCHER_FACTORY_CODE_HASH = keccak256(TRENCHER_CODE);

type RpcAnswer = { result: unknown } | { error: { code: number; message: string; data?: Hex } };
const reverted = (data?: Hex): RpcAnswer => ({ error: { code: 3, message: "execution reverted", ...(data ? { data } : {}) } });

/** One JSON-RPC answer from a chain whose Kernel factory deploys to `account`. */
function answer(account: Address, method: string, params: unknown[]): RpcAnswer {
  if (method === "eth_chainId") return { result: toHex(robinhoodChain.id) };
  if (method === "eth_getCode") {
    return { result: String(params[0]).toLowerCase() === TRENCHER_FACTORY ? TRENCHER_CODE : "0x" };
  }
  if (method === "eth_call") {
    const { to, data } = params[0] as { to: string; data: Hex };
    const target = to.toLowerCase();
    if (target === ENTRY_POINT.address.toLowerCase()) {
      return reverted(encodeErrorResult({ abi: SENDER_ADDRESS_RESULT, errorName: "SenderAddressResult", args: [account] }));
    }
    if (target === CLASS_FACTORY) {
      // A v1 factory declares no FACTORY_VERSION, so that read reverts — which
      // is exactly how probeClassFactory recognises v1.
      try {
        const call = decodeFunctionData({ abi: PONS_CLASS_VAULT_FACTORY_ABI, data });
        if (call.functionName === "vaultFor") return { result: encodeAbiParameters([{ type: "address" }], [CLASS_VAULT]) };
      } catch {
        /* not vaultFor */
      }
      return reverted();
    }
    if (target === TRENCHER_FACTORY) {
      const call = decodeFunctionData({ abi: TRENCHER_FACTORY_ABI, data });
      const answers: Record<string, Address> = {
        cash: CASH.USDG as Address,
        bridge: CASH.WETH as Address,
        router: UNISWAP.swapRouter02 as Address,
        poolFactory: UNISWAP.v3Factory as Address,
        vaultFor: TRENCHER_VAULT,
      };
      const value = answers[call.functionName];
      if (value) return { result: encodeAbiParameters([{ type: "address" }], [value]) };
    }
    // Kernel's currentNonce on an undeployed account, among others: a revert,
    // which ZeroDev reads as "not deployed yet".
    return reverted();
  }
  throw new Error(`the stub chain was asked for ${method}, which these tests did not anticipate`);
}

/** Run `fn` with global fetch answering JSON-RPC as that chain, and only then. */
async function withStubChain<T>(account: Address, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const request = JSON.parse(String(init?.body)) as
      | { id: number; method: string; params?: unknown[] }
      | { id: number; method: string; params?: unknown[] }[];
    const one = (r: { id: number; method: string; params?: unknown[] }) => ({
      jsonrpc: "2.0",
      id: r.id,
      ...answer(account, r.method, r.params ?? []),
    });
    const body = Array.isArray(request) ? request.map(one) : one(request);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

export const TEST_CAPS = { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 20, maxOpsPerDay: 20 };

/** What prepareAgentGrant accepts beyond the owner, all optional. */
export interface SignerOptions {
  account: Address;
  owner?: LocalAccount;
  caps?: StoredGrant["caps"];
  extraTokens?: { symbol: string; address: `0x${string}`; decimals: number }[];
  v4AdapterAddress?: `0x${string}`;
  ponsAdapterAddress?: `0x${string}`;
  trencher?: boolean;
}

/** A grant exactly as the real signer mints it. */
export async function signerGrant(o: SignerOptions): Promise<{ grant: StoredGrant; owner: LocalAccount }> {
  const owner = o.owner ?? privateKeyToAccount(generatePrivateKey());
  const { prepareAgentGrant } = await import("./session");
  const grant = await withStubChain(o.account, () =>
    prepareAgentGrant(owner, {
      caps: o.caps ?? TEST_CAPS,
      onStatus: () => {},
      chainId: robinhoodChain.id,
      extraTokens: o.extraTokens,
      v4AdapterAddress: o.v4AdapterAddress,
      ponsAdapterAddress: o.ponsAdapterAddress,
      trencherFactory: o.trencher ? TRENCHER_FACTORY : undefined,
    }),
  );
  return { grant, owner };
}

/**
 * Seal an ARBITRARY policy set the way a signer seals the wall: the owner
 * enables it, the session key is wrapped, and the account is serialized. The
 * result is a permission the account contract would install.
 */
export async function sealWall(args: {
  owner: LocalAccount;
  account: Address;
  policies: unknown[];
  sessionKey?: Hex;
}): Promise<{ serialized: string; sessionKey: Hex }> {
  const sessionKey = args.sessionKey ?? generatePrivateKey();
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const a = answer(args.account, method, params ?? []);
        if ("result" in a) return a.result;
        throw Object.assign(new Error(a.error.message), a.error);
      },
    }),
  });
  const sudo = await signerToEcdsaValidator(client, { signer: args.owner, entryPoint: ENTRY_POINT, kernelVersion: KERNEL_V3_3 });
  const regular = await toPermissionValidator(client, {
    signer: await toECDSASigner({ signer: privateKeyToAccount(sessionKey) }),
    policies: args.policies,
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_V3_3,
    flag: WALL_POLICY_FLAG,
  } as never);
  const account = await createKernelAccount(client, { entryPoint: ENTRY_POINT, kernelVersion: KERNEL_V3_3, plugins: { sudo, regular } });
  assertDerivedAccount(account.address, "the stub chain could not derive the account");
  if (account.address.toLowerCase() !== args.account.toLowerCase()) throw new Error("the stub chain derived a different account");
  return { serialized: await serializePermissionAccount(account, sessionKey), sessionKey };
}

/** The wall inputs a grant's signer used, so an attack below changes exactly one thing. */
function wallArgs(g: StoredGrant) {
  return {
    caps: g.caps,
    smartAccount: g.smartAccount,
    now: g.grantedAt,
    ...grantWallOptions(g),
    v4AdapterAddress: g.v4AdapterAddress as `0x${string}` | undefined,
    ponsAdapterAddress: g.ponsAdapterAddress as `0x${string}` | undefined,
    ponsClassVaultAddress: g.ponsClassVaultAddress,
    ponsClassVaultFactoryAddress: g.ponsClassVaultFactoryAddress,
    trencherVaultAddress: g.trencherVaultAddress,
    trencherFactoryAddress: g.trencherFactoryAddress,
  };
}

/** The same grant, re-sealed by its own owner over a different wall. */
export async function resealed(
  g: StoredGrant,
  owner: LocalAccount,
  change: Partial<Parameters<typeof buildWallPolicies>[0]> = {},
  withSessionKey?: Hex,
) {
  const built = buildWallPolicies({ ...wallArgs(g), ...change });
  const { serialized, sessionKey } = await sealWall({ owner, account: g.smartAccount, policies: built.policies, sessionKey: withSessionKey });
  return {
    ...g,
    serialized,
    grantedAt: built.now,
    expiresAt: built.expiresAt,
    demoSessionPrivateKey: sessionKey,
    sessionKeyAddress: privateKeyToAccount(sessionKey).address,
  } as StoredGrant;
}
