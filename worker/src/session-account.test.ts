import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPublicClient, decodeAbiParameters, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PolicyFlags, toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { toRateLimitPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { getEntryPoint } from "@zerodev/sdk/constants";
import { KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { robinhoodChain, WALL_POLICY_FLAG } from "../../packages/core/src/index";

/**
 * THE ASSERTION WHOSE ABSENCE LET THIS SHIP.
 *
 * wall.test.ts pins WALL_POLICY_FLAG's VALUE — that it is
 * PolicyFlags.NOT_FOR_VALIDATE_SIG — and stops there. A constant being right
 * says nothing about whether it survives the trip to the chain, and it did not:
 * the flag is hashed into the permission id and concatenated into the enable
 * data at sign time, then dropped by getPluginSerializationParams and defaulted
 * back to FOR_ALL_VALIDATION on the way in.
 *
 * These tests are about the SEAM, not the constant. They construct validators
 * the way the signers and the worker each do, and compare what the chain would
 * actually see.
 *
 * No network: toPermissionValidator only reads `client.chain.id` when the chain
 * is present (toPermissionValidator.ts:41), so a client with a chain never
 * dials out. That is why this can be a unit test at all.
 */

const client = createPublicClient({ chain: robinhoodChain, transport: http("http://127.0.0.1:1") });
const entryPoint = getEntryPoint("0.7");
const NOW = 1_800_000_000;

/** A validator built the way one side or the other builds it. */
async function validatorWith(flag: `0x${string}` | undefined, key: `0x${string}`) {
  const signer = await toECDSASigner({ signer: privateKeyToAccount(key) });
  return toPermissionValidator(client, {
    signer,
    policies: [toTimestampPolicy({ validAfter: NOW, validUntil: NOW + 86_400 })],
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    ...(flag === undefined ? {} : { flag }),
  } as never);
}

/**
 * The flag the chain would actually read.
 *
 * `getEnableData()` is an ABI-encoded `bytes[]` whose entries are the policies
 * followed by ONE signer entry, `concat([flag, signerContract, signerData])`
 * (toPermissionValidator.ts:47-67). So the flag is the first two bytes of the
 * LAST entry. Decoding for it rather than grepping the hex matters: the encoded
 * blob is full of offset and length words, and "0002" appears in several of
 * them — a substring search finds the encoding, not the flag.
 */
function signerFlagOf(enableData: `0x${string}`): string {
  const [entries] = decodeAbiParameters([{ name: "policyAndSignerData", type: "bytes[]" }], enableData) as [
    readonly `0x${string}`[],
  ];
  const signerEntry = entries[entries.length - 1]!;
  return signerEntry.slice(0, 6).toLowerCase(); // 0x + 2 bytes
}

test("THE BUG: dropping the flag changes the enable data the account is handed", async () => {
  const key = generatePrivateKey();
  // What both signers produce (web/src/lib/session.ts, mobile/src/crypto/signGrant.ts).
  const signed = await validatorWith(WALL_POLICY_FLAG, key);
  // What deserializePermissionAccount rebuilds: no flag, so the library default.
  const submitted = await validatorWith(undefined, key);

  const signedData = await signed.getEnableData();
  const submittedData = await submitted.getEnableData();

  assert.notEqual(
    signedData,
    submittedData,
    "if these were equal the bug would not exist — the owner signs one blob and the worker submits the other",
  );
  // And name the difference precisely, so a future reader need not rediscover
  // which bytes moved.
  assert.equal(signerFlagOf(signedData), PolicyFlags.NOT_FOR_VALIDATE_SIG, "signed: 0x0002, execute-but-never-sign");
  assert.equal(
    signerFlagOf(submittedData),
    PolicyFlags.FOR_ALL_VALIDATION,
    "submitted: 0x0000 — the session key may sign, which is the hole the flag exists to close",
  );
});

test("THE BUG, second half: the permission id is unaffected, which is why it stayed hidden", async () => {
  // getIdentifier() still matches because permissionId is serialized and passed
  // back verbatim. So the validator installs under the RIGHT id with the WRONG
  // enable data — nothing upstream disagrees, and the only symptom is a first
  // UserOp that will not validate.
  const key = generatePrivateKey();
  const flagged = await validatorWith(WALL_POLICY_FLAG, key);
  const unflagged = await validatorWith(undefined, key);
  assert.notEqual(
    flagged.getIdentifier(),
    unflagged.getIdentifier(),
    "the flag IS hashed into the id — so a rebuild that recomputes the id catches this, and one that is handed the id cannot",
  );
});

test("THE FIX: rebuilding WITH the flag reproduces the signed enable data exactly", async () => {
  const key = generatePrivateKey();
  const signed = await validatorWith(WALL_POLICY_FLAG, key);
  const rebuilt = await validatorWith(WALL_POLICY_FLAG, key);

  assert.equal(
    await rebuilt.getEnableData(),
    await signed.getEnableData(),
    "BYTE EQUALITY. This is the property the account contract checks, and the only one that matters.",
  );
  assert.equal(rebuilt.getIdentifier(), signed.getIdentifier());
});

test("the id check is not tautological — it must be computed, never accepted", async () => {
  // session-account.ts computes the id WITHOUT passing permissionId, precisely
  // so a wrong rebuild fails. This pins why: passing it makes getIdentifier()
  // return the input verbatim, so the comparison would compare a value with
  // itself and pass however wrong the policies or the flag were.
  const key = generatePrivateKey();
  const honest = await validatorWith(WALL_POLICY_FLAG, key);
  const wrong = await toPermissionValidator(client, {
    signer: await toECDSASigner({ signer: privateKeyToAccount(key) }),
    // Deliberately the WRONG policies — a different expiry entirely.
    policies: [toTimestampPolicy({ validAfter: NOW, validUntil: NOW + 999_999 })],
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    flag: WALL_POLICY_FLAG,
    // ...but handed the honest id.
    permissionId: honest.getIdentifier(),
  } as never);

  assert.equal(wrong.getIdentifier(), honest.getIdentifier(), "handed the answer, it agrees — this is the trap");
  assert.notEqual(
    await wrong.getEnableData(),
    await honest.getEnableData(),
    "while the enable data — what the chain actually checks — is different",
  );
});

test("WALL_POLICY_FLAG is the flag the worker passes, not merely a constant", async () => {
  // wall.test.ts asserts the value. This asserts the wiring: the flag the
  // executor hands deserializeFlaggedPermissionAccount is the same one the
  // signers use, so the two cannot drift.
  assert.equal(WALL_POLICY_FLAG, PolicyFlags.NOT_FOR_VALIDATE_SIG);
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("./executor.ts", import.meta.url), "utf8"),
  );
  assert.match(src, /deserializeFlaggedPermissionAccount\([\s\S]*?WALL_POLICY_FLAG,/, "the executor must pass it");
  assert.equal(
    /\bdeserializePermissionAccount\(/.test(src),
    false,
    "and must never call the flag-dropping one",
  );
});

/**
 * THE OUTAGE THIS FILE CAUSED, pinned so it cannot recur.
 *
 * policyFromParams knew only the two policy kinds the NEW wall emits. But a
 * grant is a frozen signature: every key signed before the rate-limit policy
 * was dropped still carries one. So the default threw, syncGrant failed on
 * every tick, and TEN hosted tenants sat in a crash loop unable to arm —
 * discovered in production logs, not by any test here.
 *
 * The lesson is narrow and worth stating exactly: removing a policy from the
 * wall means ADDING it here, in the same change. This file must understand
 * every kind merrymen has ever sealed, not every kind it seals today.
 */
test("REGRESSION: a legacy rate-limit policy still rebuilds", async () => {
  const key = generatePrivateKey();
  const signer = await toECDSASigner({ signer: privateKeyToAccount(key) });
  const legacy = await toPermissionValidator(client, {
    signer,
    policies: [
      toTimestampPolicy({ validAfter: NOW, validUntil: NOW + 86_400 }),
      // What every pre-2026-08-30 grant carries.
      toRateLimitPolicy({ count: 48, interval: 86_400 }),
    ],
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    flag: WALL_POLICY_FLAG,
  } as never);

  // The rebuild must reproduce it byte for byte, or the permission id changes
  // and the account is dead. Omitting the policy is not a lighter failure than
  // throwing — it is the same failure with a worse error message.
  const rebuilt = await toPermissionValidator(client, {
    signer,
    policies: [
      toTimestampPolicy({ validAfter: NOW, validUntil: NOW + 86_400 }),
      toRateLimitPolicy({ count: 48, interval: 86_400 }),
    ],
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    flag: WALL_POLICY_FLAG,
  } as never);
  assert.equal(rebuilt.getIdentifier(), legacy.getIdentifier());
  assert.equal(await rebuilt.getEnableData(), await legacy.getEnableData());

  // And dropping it really would break the grant — the reason rebuilding is
  // mandatory rather than a courtesy.
  const dropped = await toPermissionValidator(client, {
    signer,
    policies: [toTimestampPolicy({ validAfter: NOW, validUntil: NOW + 86_400 })],
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    flag: WALL_POLICY_FLAG,
  } as never);
  assert.notEqual(dropped.getIdentifier(), legacy.getIdentifier(), "a dropped policy is a different key");
});

test("every policy kind the wall has EVER emitted is handled", () => {
  // Read from source rather than exercised, because policyFromParams is not
  // exported — and the thing that broke was a missing switch case, which a
  // source assertion catches exactly.
  const src = readFileSync("worker/src/session-account.ts", "utf8");
  for (const kind of ["call", "timestamp", "rate-limit"]) {
    assert.match(src, new RegExp(`case "${kind}":`), `policyFromParams must handle '${kind}'`);
  }
  // The default still throws, and should. An unknown policy IS a bound we would
  // be dropping; the fix was never to stop refusing.
  assert.match(src, /refusing to arm rather than dropping it/);
});

test("a stale grant is DETECTED, so its owner is told rather than left guessing", () => {
  // Rebuilding lets it arm. It still cannot transact — the policy points at an
  // address with no code — so the owner needs words, not a silent loop of
  // validation failures.
  const src = readFileSync("worker/src/session-account.ts", "utf8");
  assert.match(src, /export function grantHasDeadRateLimit/);
  const idx = readFileSync("worker/src/index.ts", "utf8");
  assert.match(idx, /grantHasDeadRateLimit\(grant\.serialized\)/);
  assert.match(idx, /revoking the old permissions requires network fees/);
});
