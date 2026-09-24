// Headless computation only. SwiftUI owns all screens and confirmations; the
// native host owns networking, wallet signatures, randomness and Keychain storage.
// Reuse the exact web permission builder instead of porting the financial wall.
import { toAccount } from "viem/accounts";
import { createPrivyOwnedWallet, setPrivyTokenSource, type MintOptions } from "../../web/src/lib/session";
import { verifiedAdapter } from "../../web/src/lib/verified-adapter";
import { isValidCustomToken } from "../../packages/core/src/tokens";
import { TRENCHER_FACTORY } from "../../web/src/lib/trencher-permission";
import type { Address, Hex, TypedDataDomain } from "viem";
import { stringToHex, bytesToHex, getTypesForEIP712Domain, recoverMessageAddress } from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
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
export async function plan(input: Parameters<typeof recoveryWallet>[0]) { return planFromBrowser(recoveryWallet(input)); }
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
