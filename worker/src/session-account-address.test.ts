import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, custom, encodeErrorResult, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { serializePermissionAccount, toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { toTimestampPolicy } from "@zerodev/permissions/policies";
import { robinhoodChain, WALL_POLICY_FLAG } from "../../packages/core/src/index";
import { AccountAddressMismatch, deserializeFlaggedPermissionAccount } from "./session-account";

/**
 * THE CHECK THAT COMPARED A VALUE WITH ITSELF.
 *
 * session-account.ts has always carried two checks. The first rebuilds the
 * permission id WITHOUT passing the stored one, with a comment explaining that
 * passing it would make getIdentifier() echo the input and the comparison
 * tautological. The second — "SECOND, INDEPENDENT CHECK" — then built the
 * account WITH `address: params.accountParams.accountAddress` and compared
 * `account.address` against that same value.
 *
 * createKernelAccount.ts:263 is `accountAddress = address ?? (…derive…)`, so
 * supplying the address skips derivation entirely and the comparison could
 * never fail. A guard that reads as one and is not one is worse than no guard,
 * because it stops anyone writing the real one.
 *
 * These tests drive the REAL function over a REAL serialized grant. The only
 * thing stubbed is the chain, and it is stubbed precisely so the derived
 * address can be made to disagree with the signed one — which is the case that
 * cannot be constructed at all if the derivation never runs.
 */

const entryPoint = getEntryPoint("0.7");

/** `SenderAddressResult(address)` — how the EntryPoint answers getSenderAddress. */
const SENDER_ADDRESS_RESULT = [
  { inputs: [{ name: "sender", type: "address" }], name: "SenderAddressResult", type: "error" },
] as const;

/**
 * A chain that deploys exactly where we say it does.
 *
 * getSenderAddress works by CALLING EntryPoint.getSenderAddress and reading the
 * address back out of the revert, so a stub that reverts with
 * SenderAddressResult(x) IS a chain whose factory deploys to x. Nothing else is
 * faked: the validators, the plugin manager, the enable signature and the
 * serialized blob are all built by the real packages.
 */
function chainThatDeploysTo(where: Address) {
  const seen: string[] = [];
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: custom({
      async request({ method }: { method: string }) {
        seen.push(method);
        if (method === "eth_chainId") return `0x${robinhoodChain.id.toString(16)}`;
        if (method === "eth_call") {
          throw Object.assign(new Error("execution reverted"), {
            code: 3,
            data: encodeErrorResult({
              abi: SENDER_ADDRESS_RESULT,
              errorName: "SenderAddressResult",
              args: [where],
            }),
          });
        }
        if (method === "eth_getCode") return "0x";
        throw new Error(`the stub was asked for ${method}, which this test did not anticipate`);
      },
    }),
  });
  return { client, seen };
}

/** A grant, built the way the browser builds one. */
async function signedGrant(deployedTo: Address) {
  const { client } = chainThatDeploysTo(deployedTo);
  const owner = privateKeyToAccount(generatePrivateKey());
  const sessionKey = generatePrivateKey();

  const sudo = await signerToEcdsaValidator(client, {
    signer: owner,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });
  const regular = await toPermissionValidator(client, {
    signer: await toECDSASigner({ signer: privateKeyToAccount(sessionKey) }),
    policies: [toTimestampPolicy({ validAfter: 1_800_000_000, validUntil: 1_800_086_400 })],
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    flag: WALL_POLICY_FLAG,
  } as never);

  // No `address` — the account's address is DERIVED, which is what makes the
  // stub's answer the account's real identity rather than a decoration.
  const account = await createKernelAccount(client, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo, regular },
  });
  assert.equal(account.address.toLowerCase(), deployedTo.toLowerCase(), "the fixture is what it claims");

  return { blob: await serializePermissionAccount(account, sessionKey), sessionKey };
}

/** Rewrite one field of a serialized grant, leaving everything else signed. */
function withAccountAddress(blob: string, address: Address): string {
  const params = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(blob), (c) => c.codePointAt(0)!)));
  params.accountParams.accountAddress = address;
  const json = JSON.stringify(params);
  return btoa(String.fromCodePoint(...new TextEncoder().encode(json)));
}

const REAL = "0x1111111111111111111111111111111111111111" as Address;
const IMPOSTOR = "0x2222222222222222222222222222222222222222" as Address;

test("an honest grant arms", async () => {
  const { blob } = await signedGrant(REAL);
  const { client } = chainThatDeploysTo(REAL);
  const account = await deserializeFlaggedPermissionAccount(
    client as never,
    entryPoint,
    KERNEL_V3_3,
    blob,
    WALL_POLICY_FLAG,
  );
  assert.equal(account.address.toLowerCase(), REAL.toLowerCase());
});

test("REGRESSION: a grant whose address does not match its own initCode is REFUSED", async () => {
  // This is the case the old check could not see. Everything else about the
  // blob is genuinely signed; only the address claim is wrong — which is
  // exactly the shape of "a correct validator attached to the wrong address"
  // that the old comment claimed to catch.
  const { blob } = await signedGrant(REAL);
  const tampered = withAccountAddress(blob, IMPOSTOR);
  const { client } = chainThatDeploysTo(REAL);

  await assert.rejects(
    () =>
      deserializeFlaggedPermissionAccount(client as never, entryPoint, KERNEL_V3_3, tampered, WALL_POLICY_FLAG),
    (e: unknown) => {
      assert.ok(e instanceof AccountAddressMismatch, `expected AccountAddressMismatch, got ${String(e)}`);
      assert.equal(e.signed.toLowerCase(), IMPOSTOR.toLowerCase());
      assert.equal(e.derived.toLowerCase(), REAL.toLowerCase());
      assert.match(e.message, /Refusing to arm/);
      return true;
    },
  );
});

test("THE DERIVATION ACTUALLY RUNS — the address is never handed to the deriver", async () => {
  // The whole defect was that the answer was supplied, so the work was skipped.
  // A behavioural test cannot see a call that does not happen, so watch the
  // chain: an eth_call to the EntryPoint is the derivation, and its absence is
  // the bug.
  const { blob } = await signedGrant(REAL);
  const { client, seen } = chainThatDeploysTo(REAL);
  await deserializeFlaggedPermissionAccount(client as never, entryPoint, KERNEL_V3_3, blob, WALL_POLICY_FLAG);
  assert.ok(seen.includes("eth_call"), "the account address must be derived, not accepted");
});
