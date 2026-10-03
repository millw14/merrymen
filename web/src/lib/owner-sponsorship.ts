/** Server-side gates for house-paid owner operations. Never imported by a browser client. */
import { recoverMessageAddress, type Hex } from "viem";
import { formatUserOperation, getUserOperationHash, type RpcUserOperation } from "viem/account-abstraction";
import { ENTRYPOINT } from "@merrymen/core";
import { getIdentityStore, type PublicIdentity } from "@merrymen/identity-store";
import { GAS_BOUNDS } from "../../../worker/src/gas-limits";
import { PAYMASTER_GAS_MAX } from "../../../worker/src/paymaster";
import type { Ticket } from "./recovery-ticket";

export const OWNER_SPONSOR_MAX_FEE = 1_000_000_000n;
export const OWNER_SPONSOR_MAX_COST = 1_000_000_000_000_000n;
export const OWNER_SPONSOR_MAX_GAS = GAS_BOUNDS.absoluteMax;

export interface OwnerSponsorshipStatus {
  sponsorshipEnabled: boolean;
  gasSponsored: boolean;
  reason: string | null;
}

export async function ownerSponsorshipStatus(
  ticket: Ticket,
  identities: () => Promise<PublicIdentity[]> = () => getIdentityStore().all(),
): Promise<OwnerSponsorshipStatus> {
  const sponsorshipEnabled = /^(1|true)$/i.test(process.env.MERRYMEN_SPONSOR_GAS ?? "");
  const no = (reason: string): OwnerSponsorshipStatus => ({ sponsorshipEnabled, gasSponsored: false, reason });
  if (!sponsorshipEnabled) return no("Owner gas sponsorship is not enabled on this deployment.");
  if (!process.env.MERRYMEN_BUNDLER_API_KEY) return no("Owner gas sponsorship has no bundler configured.");
  if (!process.env.MERRYMEN_SPONSORSHIP_POLICY_ID?.trim()) return no("Owner gas sponsorship has no spending policy configured.");
  if (!ticket.sponsorship) return no("Sign a fresh recovery challenge to verify owner gas sponsorship.");
  try {
    const family = new Set(ticket.sponsorship.accounts.map((a) => a.toLowerCase()));
    const known = (await identities()).some((identity) => identity.accounts.some((a) => family.has(a.toLowerCase())));
    if (!known) return no("This owner's account has no verified Merrymen history for gas sponsorship.");
  } catch {
    return no("Merrymen could not verify this account's gas sponsorship history. Retry before continuing.");
  }
  return { sponsorshipEnabled, gasSponsored: true, reason: null };
}

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const QUANTITY = /^0x[0-9a-f]{1,64}$/i;
const numeric = ["nonce", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"] as const;
const fields = new Set<string>([...numeric, "sender", "factory", "factoryData", "callData", "paymaster", "paymasterData", "signature"]);

/** Reject unexamined RPC fields, including 7702 authorization and legacy initCode. */
export function ownerOperationProblem(op: Record<string, unknown>, final: boolean): string | null {
  if (Object.keys(op).some((key) => !fields.has(key))) return "unsupported user operation field";
  for (const key of ["sender", "factory", "paymaster"]) {
    if (op[key] !== undefined && (typeof op[key] !== "string" || !ADDRESS.test(op[key] as string))) return `malformed ${key}`;
  }
  for (const key of ["callData", "factoryData", "paymasterData", "signature"]) {
    if (op[key] !== undefined && (typeof op[key] !== "string" || !BYTES.test(op[key] as string))) return `malformed ${key}`;
  }
  for (const key of numeric) {
    if (op[key] !== undefined && (typeof op[key] !== "string" || !QUANTITY.test(op[key] as string))) return `malformed ${key}`;
  }
  if (typeof op.sender !== "string" || typeof op.callData !== "string" || op.nonce === undefined) return "incomplete user operation";
  if ((op.factory === undefined) !== (op.factoryData === undefined)) return "factory and factoryData must be supplied together";
  if (final && ["callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas"].some((key) => op[key] === undefined || BigInt(op[key] as string) <= 0n)) return "signed submissions need positive gas and fee limits";
  return null;
}

export function sponsoredOperationProblem(op: Record<string, unknown>, ticket: Ticket, final: boolean): string | null {
  const shape = ownerOperationProblem(op, final);
  if (shape) return shape;
  const proof = ticket.sponsorship;
  if (!proof) return "owner sponsorship requires a fresh recovery ticket";
  if (op.factory !== undefined && (
    String(op.factory).toLowerCase() !== proof.factory.toLowerCase() ||
    String(op.factoryData).toLowerCase() !== proof.factoryData.toLowerCase()
  )) return "only this owner's canonical Kernel deployment can be sponsored";
  const value = (key: string) => BigInt(op[key] as string ?? "0x0");
  // Kernel v3 sudo mode. Permission/plugin signatures are not owner authority.
  if (value("nonce") >> 240n) return "only the owner sudo nonce can be sponsored";
  const total = ["callGasLimit", "verificationGasLimit", "preVerificationGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"].reduce((n, key) => n + value(key), 0n);
  if (total > OWNER_SPONSOR_MAX_GAS) return "owner operation exceeds the house gas limit";
  if (["paymasterVerificationGasLimit", "paymasterPostOpGasLimit"].some((key) => value(key) > PAYMASTER_GAS_MAX)) return "paymaster exceeds the house gas limit";
  if (value("maxFeePerGas") > OWNER_SPONSOR_MAX_FEE || value("maxPriorityFeePerGas") > value("maxFeePerGas")) return "owner operation exceeds the house fee limit";
  if (total * value("maxFeePerGas") > OWNER_SPONSOR_MAX_COST) return "owner operation exceeds the house per-operation spending limit";
  return null;
}

/** The pinned Kernel v3 sudo SDK signs the v0.7 UserOp hash using EIP-191. */
export async function ownerSignatureValid(op: Record<string, unknown>, ticket: Ticket): Promise<boolean> {
  if (!ticket.sponsorship || typeof op.signature !== "string" || !/^0x[0-9a-f]{130}$/i.test(op.signature)) return false;
  try {
    const hash = getUserOperationHash({
      userOperation: formatUserOperation(op as RpcUserOperation),
      entryPointAddress: ENTRYPOINT.v07,
      entryPointVersion: "0.7",
      chainId: ticket.chainId,
    });
    const signer = await recoverMessageAddress({ message: { raw: hash }, signature: op.signature as Hex });
    return signer.toLowerCase() === ticket.sponsorship.owner.toLowerCase();
  } catch { return false; }
}

/** Provider output cannot replace the caller's operation or its bounded gas. */
export function paymasterResult(result: unknown, stub: boolean): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;
  if (typeof r.paymaster !== "string" || !ADDRESS.test(r.paymaster) || /^0x0{40}$/i.test(r.paymaster) ||
      typeof r.paymasterData !== "string" || !BYTES.test(r.paymasterData)) return null;
  const out: Record<string, unknown> = { paymaster: r.paymaster, paymasterData: r.paymasterData };
  for (const key of ["paymasterVerificationGasLimit", "paymasterPostOpGasLimit"]) {
    if (r[key] === undefined) continue;
    if (typeof r[key] !== "string" || !QUANTITY.test(r[key] as string) || BigInt(r[key] as string) > PAYMASTER_GAS_MAX) return null;
    out[key] = r[key];
  }
  // A stub is for estimation only: always obtain fresh final sponsorship data.
  if (stub) out.isFinal = false;
  return out;
}
