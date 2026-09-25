// Headless computation only. SwiftUI owns all screens and confirmations; the
// native host owns networking, wallet signatures, randomness and Keychain storage.
// Reuse the exact web permission builder instead of porting the financial wall.
import { toAccount } from "viem/accounts";
import { createPrivyOwnedWallet, prepareAgentGrant, setPrivyTokenSource, type MintOptions } from "../../web/src/lib/session";
import { bindingMessage, CASH, TRENCHER_VAULT_ABI } from "../../packages/core/src/index";
import { verifiedAdapter } from "../../web/src/lib/verified-adapter";
import { isValidCustomToken } from "../../packages/core/src/tokens";
import { TRENCHER_FACTORY, resolveTrencherPermission } from "../../web/src/lib/trencher-permission";
import type { Address, Hex, TypedDataDomain } from "viem";
import { stringToHex, bytesToHex, getTypesForEIP712Domain, recoverMessageAddress, createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import { ownerFromSigner, planRecovery } from "../../worker/src/recover";
import { robinhoodChain } from "../../packages/core/src/chain";
import { planFromBrowser, sweepFromBrowser, getRecoveryTicket, relayUrl, type BrowserWallet } from "../../web/src/lib/recover-client";

declare const nativeCall: (operation: string, args: unknown) => Promise<any>;

function signer(address: Address) {
  return toAccount({
    address,
    async signMessage({ message }) {
      const hex = typeof message === "string" ? stringToHex(message) : typeof message.raw === "string" ? message.raw : bytesToHex(message.raw);
      return nativeCall("signMessage", { address, hex }) as Promise<Hex>;
    },
    async signTypedData(typedData) {
      return nativeCall("signTypedData", { address, typedData: { ...typedData, types: { EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain as TypedDataDomain | undefined }), ...typedData.types } } }) as Promise<Hex>;
    },
    async signTransaction() { throw new Error("Raw transaction signing is not exposed by the grant builder."); },
  });
}

export function capabilities() { return { version: 1, engine: "shared-permission-builder", nativeScreens: true }; }

export async function recoverIdentity(input: { message: string; signature: Hex }) {
  if (input.message.length > 8192 || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) throw new Error("Invalid ownership proof.");
  return { address: await recoverMessageAddress({ message: input.message, signature: input.signature }) };
}

export async function create(input: {
  owner: Address; tenant: Address; did: string;
  caps: MintOptions["caps"]; expectAccount?: Address;
  extraTokens: unknown[]; v4AdapterAddress?: Address; ponsAdapterAddress?: Address;
  ponsClassVaultFactory?: Address; autonomousTrencher?: boolean; priorTrencherFactory?: Address;
}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.owner) || input.owner.toLowerCase() !== input.tenant.toLowerCase()) {
    throw new Error("The embedded wallet does not own this account.");
  }
  if (!input.did.startsWith("did:privy:")) throw new Error("Missing verified Privy identity.");
  if (input.priorTrencherFactory && (!input.autonomousTrencher || input.priorTrencherFactory.toLowerCase() !== TRENCHER_FACTORY?.toLowerCase())) throw new Error("This renewal would change existing Trencher custody. Recover or close that vault before changing its permission.");
  for (const value of Object.values(input.caps)) if (!Number.isFinite(value) || value <= 0) throw new Error("Every cap must be positive.");
  if (input.caps.perTradeUsdg > input.caps.dailyUsdg) throw new Error("The per-trade cap exceeds the daily cap.");
  if (!input.extraTokens.every(isValidCustomToken)) throw new Error("A custom token is invalid.");
  const onStatus = (message: string) => { void nativeCall("status", { message }); };
  const pons = await verifiedAdapter(input.ponsAdapterAddress, 4663, onStatus);
  setPrivyTokenSource(() => nativeCall("accessToken", {}));
  const result = await createPrivyOwnedWallet(signer(input.owner), input.did, {
    caps: input.caps, onStatus, chainId: 4663, hostedAs: input.tenant,
    expectAccount: input.expectAccount, extraTokens: input.extraTokens.filter(isValidCustomToken),
    v4AdapterAddress: input.v4AdapterAddress, ponsAdapterAddress: pons,
    ponsClassVaultFactory: input.ponsClassVaultFactory,
    trencherFactory: input.autonomousTrencher ? TRENCHER_FACTORY as Address : undefined,
  });
  return { smartAccount: result.grant.smartAccount, caps: result.grant.caps, handoff: result.handoff };
}

function recoveryWallet(input: { owner: Address; smartAccount: Address; grantTokens?: string[] }): BrowserWallet {
  if (![input.owner, input.smartAccount].every(a => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a))) throw new Error("Invalid recovery account.");
  return { ownerAccount: signer(input.owner), smartAccount: input.smartAccount, chainId: 4663, grantTokens: input.grantTokens ?? [] };
}
// Restore the same legacy account using the canonical permission builder. The
// owner key remains in the native host. Both signatures use the server's nonce.
export async function restore(input: Parameters<typeof create>[0]) {
  if (![input.owner, input.tenant, input.expectAccount].every(a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a))) throw new Error('A verified owner, login and recovery account are required.');
  for (const value of Object.values(input.caps)) if (!Number.isFinite(value) || value <= 0) throw new Error('Every cap must be positive.');
  if (input.caps.perTradeUsdg > input.caps.dailyUsdg) throw new Error('The per-trade cap exceeds the daily cap.');
  if (!input.extraTokens.every(isValidCustomToken)) throw new Error('A custom token is invalid.');
  if (input.priorTrencherFactory && (!input.autonomousTrencher || input.priorTrencherFactory.toLowerCase() !== TRENCHER_FACTORY?.toLowerCase())) throw new Error('This renewal would change existing Trencher custody.');
  const custody = await trencherState(input.expectAccount!);
  if (custody.state === 'unread') throw new Error('Existing Trencher custody could not be checked. No permission was signed.');
  if (custody.funded && !input.autonomousTrencher) throw new Error('This account has funds in its Trencher vault. Keep that permission enabled while restoring.');
  const onStatus = (message: string) => { void nativeCall('status', { message }); };
  const pons = await verifiedAdapter(input.ponsAdapterAddress, 4663, onStatus);
  const grant = await prepareAgentGrant(signer(input.owner), {
    caps: input.caps, onStatus, chainId: 4663, expectAccount: input.expectAccount,
    extraTokens: input.extraTokens.filter(isValidCustomToken), v4AdapterAddress: input.v4AdapterAddress,
    ponsAdapterAddress: pons, ponsClassVaultFactory: input.ponsClassVaultFactory,
    trencherFactory: input.autonomousTrencher ? TRENCHER_FACTORY as Address : undefined,
  });
  const response = await fetch('/api/auth/challenge', { cache: 'no-store' });
  if (!response.ok) throw new Error('The account-link challenge could not be read.');
  const challenge = await response.json() as { origin: string; nonce: string };
  const message = bindingMessage({ origin: challenge.origin, nonce: challenge.nonce, owner: input.owner, smartAccount: grant.smartAccount, chainId: 4663 });
  const ownerSignature = await signer(input.owner).signMessage({ message });
  const walletSignature = await nativeCall('signTenant', { message, address: input.tenant });
  grant.binding = { version: 'legacy-wallet-owner-v1', nonce: challenge.nonce, ownerSignature, walletSignature };
  localStorage.setItem('merrymen.grant.v1', JSON.stringify(grant));
  let handoff: { ok: boolean; error?: string };
  try {
    const delivered = await fetch('/api/grants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(grant) });
    const body = await delivered.json() as { error?: string };
    handoff = delivered.ok ? { ok: true } : { ok: false, error: body.error ?? 'Activation was not confirmed.' };
  } catch { handoff = { ok: false, error: 'The service did not confirm activation. The signed grant is saved on this device.' }; }
  return { smartAccount: grant.smartAccount, caps: grant.caps, handoff };
}
export async function plan(input: Parameters<typeof recoveryWallet>[0]) {
  const plan = await planFromBrowser(recoveryWallet(input));
  return { ...plan, trencher: await trencherState(input.smartAccount) };
}
export async function preview(input: { owner: Address; grantTokens?: string[] }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.owner) || /^0x0{40}$/.test(input.owner)) throw new Error("Invalid owner.");
  const plan = await planRecovery({ chain: robinhoodChain, owner: ownerFromSigner(signer(input.owner)), extraTokens: (input.grantTokens ?? []).map(address => ({ address, symbol: '', decimals: 18 })) });
  return { ...plan, needsGas: plan.gasWei === 0n, trencher: await trencherState(plan.smartAccount) };
}
async function trencherState(account: Address): Promise<{ state: string; funded?: boolean; vault?: string; factory?: string; balances?: { token: string; amount: string; symbol: string }[] }> {
  if (!TRENCHER_FACTORY) return { state: 'not-configured' };
  try {
    const client = createPublicClient({ chain: robinhoodChain, transport: http() });
    const resolved = await resolveTrencherPermission(client, TRENCHER_FACTORY as Address, account);
    const vault = resolved.trencherVaultAddress as Address;
    const code = await client.getCode({ address: vault });
    if (!code || code === '0x') return { state: 'not-deployed', vault, factory: TRENCHER_FACTORY, funded: false };
    const owner = await client.readContract({ address: vault, abi: TRENCHER_VAULT_ABI, functionName: 'owner' });
    if (owner.toLowerCase() !== account.toLowerCase()) throw new Error('Owner mismatch');
    const held = await client.readContract({ address: vault, abi: TRENCHER_VAULT_ABI, functionName: 'tokens' });
    if (held.length > 1000) throw new Error('Token list too large');
    const tokens = [...new Set([CASH.USDG, CASH.WETH, ...held].map(a => a.toLowerCase() as Address))];
    let funded = false;
    const balances = [];
    for (const token of tokens) {
      const amount = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [vault] });
      if (amount === 0n) continue;
      funded = true;
      const symbol = await client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => token);
      const decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }).catch(() => null);
      balances.push({ token, symbol, amount: decimals === null ? amount.toString() + ' raw units' : formatUnits(amount, decimals) });
    }
    return { state: 'read', vault, factory: TRENCHER_FACTORY, funded, balances };
  } catch { return { state: 'unread' }; }
}
export async function withdraw(input: Parameters<typeof recoveryWallet>[0] & { to: Address; approvedClass?: { vault: Address; tokens: Address[] } }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.to) || /^0x0{40}$/.test(input.to) || input.to.toLowerCase() === input.smartAccount.toLowerCase()) throw new Error("Choose a valid recipient other than this smart account.");
  return sweepFromBrowser(recoveryWallet(input), input.to, input.approvedClass);
}
export async function reconcile(input: Parameters<typeof recoveryWallet>[0] & { hashes: Hex[] }) {
  await getRecoveryTicket(recoveryWallet(input));
  const receipts = [];
  for (const hash of input.hashes) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Invalid operation hash.");
    const response = await fetch(relayUrl(4663), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getUserOperationReceipt", params: [hash] }) });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error("The withdrawal receipt could not be checked. No transaction was resubmitted.");
    receipts.push({ hash, receipt: body.result });
  }
  return { receipts };
}

// Compute the canonical operation hash BEFORE transport. The native host records
// it durably so a lost HTTP response still has a receipt that can be looked up.
export function rpcMetadata(body: string | null) {
  if (!body) return null;
  let rpc: any; try { rpc = JSON.parse(body); } catch { return null; }
  if (rpc.method !== "eth_sendUserOperation") return null;
  const [raw, entryPoint] = rpc.params;
  if (entryPoint?.toLowerCase() !== "0x0000000071727de22e5e9d8baf0edac6f37da032") throw new Error("Unexpected entry point.");
  const userOperation = { ...raw };
  for (const field of ["nonce", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"]) {
    if (userOperation[field] !== undefined) userOperation[field] = BigInt(userOperation[field]);
  }
  return { hash: getUserOperationHash({ userOperation, chainId: 4663, entryPointAddress: entryPoint, entryPointVersion: "0.7" }), sender: raw.sender };
}
