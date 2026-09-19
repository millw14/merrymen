import assert from "node:assert/strict";
import test from "node:test";
import { limitsFromGrant } from "./limits";
import { checkPolicy, type AgentState, type TradeIntent } from "./policy";
import {
  buildCallPermissions,
  CASH,
  GRANT_TRANSFER,
  WITHDRAWAL_ALLOWLIST_LANDED_AT,
  usdgUnits,
  type StoredGrant,
} from "../../packages/core/src/index";

/**
 * THE MIRROR MAY NEVER BE LOOSER THAN THE CHAIN.
 *
 * packages/core/src/wall.ts emits a USDG `transfer` permission only for
 * withdrawal addresses registered at signing. The dashboard signer now seals
 * doors into grantWithdrawals (with the GRANT_TRANSFER marker, lockstep); a
 * grant without sealed doors carries no transfer permission, and limits.ts
 * must mirror exactly that — [] for signed-with-no-doors, the list for sealed
 * doors, undefined only for pre-allowlist free-form grants.
 *
 * So the worker believed it could send, built the UserOp, and the account
 * contract refused it: gas spent to be told no, with a revert reason that
 * explains nothing. Exactly the failure family as quoting a multi-hop route the
 * key could not execute — a mirror describing intent rather than the policy.
 *
 * These tests assert the two halves against each other, not against prose.
 */

const grantWith = (
  features: string[],
  grantedAt = 1_000_000,
  grantWithdrawals?: { name: string; address: string }[],
): StoredGrant =>
  ({
    smartAccount: "0x00000000000000000000000000000000000000a1",
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    chainId: 4663,
    grantFeatures: features,
    ...(grantWithdrawals === undefined ? {} : { grantWithdrawals }),
  }) as unknown as StoredGrant;

const CALM: AgentState = {
  spentTodayUsdg: 0n,
  opsToday: 0,
  equityUsdg: 1_000_000_000n,
  highWaterMarkUsdg: 1_000_000_000n,
  nowSec: Math.floor(Date.now() / 1000),
};

const sendTo = (recipient: `0x${string}`): TradeIntent => ({
  kind: "transfer",
  target: CASH.USDG as `0x${string}`,
  recipient,
  amountUsdg: usdgUnits(10),
});

test("the default wall grants NO transfer permission — the fact everything else follows from", () => {
  // Read from the real builder with the options both signers actually pass.
  const SELF = "0x00000000000000000000000000000000000000a1" as const;
  const CAPS = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };
  const perms = buildCallPermissions(CAPS as never, SELF) as unknown as { functionName?: string }[];
  assert.equal(
    perms.filter((p) => p.functionName === "transfer").length,
    0,
    "no signer registers a withdrawal address, so the chain refuses every send",
  );
});

test("a grant minted today cannot transfer, and the mirror agrees", () => {
  // What both signers now produce: no "transfer" marker.
  const limits = limitsFromGrant(grantWith(["tradeable-v2", "multihop"]));
  assert.deepEqual(limits.withdrawalAddresses, [], "EMPTY, not undefined — undefined means 'free-form, permit it'");
  const verdict = checkPolicy(sendTo("0x00000000000000000000000000000000000000ee"), limits, CALM);
  assert.equal(verdict.ok, false, "refused off-chain, before a UserOp is built and gas is spent");
  assert.equal(verdict.rule, "transfer-not-permitted");
});

test("even sending to YOURSELF is refused — it is the permission that is missing, not the destination", () => {
  const limits = limitsFromGrant(grantWith(["tradeable-v2"]));
  const verdict = checkPolicy(sendTo("0x00000000000000000000000000000000000000a1"), limits, CALM);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, "transfer-not-permitted");
});

test("a pre-allowlist grant still works — absent must not be read as legacy", () => {
  // Grants signed before the withdrawal allowlist landed DO carry a transfer
  // permission, with a free-form recipient. Tightening them here would make the
  // mirror stricter than the chain, which breaks a working wallet.
  const limits = limitsFromGrant(grantWith([GRANT_TRANSFER, "tradeable-v2"]));
  assert.equal(limits.withdrawalAddresses, undefined, "left free-form, exactly as before");
  const verdict = checkPolicy(sendTo("0x00000000000000000000000000000000000000ee"), limits, CALM);
  assert.equal(verdict.ok, true, "a legacy grant keeps the capability its signature actually carries");
});

test("a grant with sealed doors mirrors exactly those doors — and nothing else", () => {
  const COLD = "0x1111111111111111111111111111111111111111";
  const limits = limitsFromGrant(
    grantWith([GRANT_TRANSFER, "tradeable-v2"], WITHDRAWAL_ALLOWLIST_LANDED_AT + 1, [
      { name: "cold wallet", address: COLD },
    ]),
  );
  assert.deepEqual(limits.withdrawalAddresses, [COLD]);
  assert.equal(checkPolicy(sendTo(COLD as `0x${string}`), limits, CALM).ok, true, "a sealed door opens");
  const refused = checkPolicy(sendTo("0x00000000000000000000000000000000000000ee"), limits, CALM);
  assert.equal(refused.ok, false, "an unlisted door stays shut");
  assert.equal(refused.rule, "transfer-recipient-allowlist");
});

test("a post-allowlist marker WITHOUT sealed doors is evidence of nothing", () => {
  // The 24-day window: marker present, no doors recorded. The mirror must read
  // this as no transfer permission (like the chain does), not free-form.
  const limits = limitsFromGrant(grantWith([GRANT_TRANSFER, "tradeable-v2"], WITHDRAWAL_ALLOWLIST_LANDED_AT + 1, []));
  assert.deepEqual(limits.withdrawalAddresses, []);
  assert.equal(checkPolicy(sendTo("0x00000000000000000000000000000000000000ee"), limits, CALM).ok, false);
});

test("swaps and vault moves are untouched by any of this", () => {
  // Narrowing the transfer path must not narrow the trading path with it.
  const limits = limitsFromGrant(grantWith(["tradeable-v2"]));
  const verdict = checkPolicy(
    {
      kind: "vault-deposit",
      target: limits.allowedTargets[2]!,
      amountUsdg: usdgUnits(10),
    } as never,
    limits,
    CALM,
  );
  assert.equal(verdict.ok, true, "parking cash is not a withdrawal");
});

test("a STALE marker is not a permission — the Aug 2..26 generation is refused too", () => {
  // THE POPULATION THIS ALMOST MISSED. The withdrawal allowlist landed on
  // 2026-08-02 and made the wall's transfer permission conditional; both
  // signers kept writing the "transfer" marker anyway until 2026-08-26. So
  // every grant minted in that window claims a permission its wall never
  // emitted — and with a 14-day default expiry, that window is essentially the
  // entire population of currently-armed grants, while the genuinely
  // pre-allowlist ones the marker protects are mostly expired.
  //
  // Reading the marker alone would leave exactly those grants with a mirror
  // looser than the chain: the worker offers the transfer, builds the UserOp,
  // and the account contract refuses it.
  const stale = grantWith([GRANT_TRANSFER, "tradeable-v2"], WITHDRAWAL_ALLOWLIST_LANDED_AT + 60);
  const limits = limitsFromGrant(stale);
  assert.deepEqual(limits.withdrawalAddresses, [], "the claim is not honoured");
  const verdict = checkPolicy(sendTo("0x00000000000000000000000000000000000000ee"), limits, CALM);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, "transfer-not-permitted");
});

test("one second before the allowlist landed, the marker still means what it said", () => {
  // The boundary itself, so the cutoff cannot drift silently.
  const genuine = grantWith([GRANT_TRANSFER, "tradeable-v2"], WITHDRAWAL_ALLOWLIST_LANDED_AT - 1);
  assert.equal(limitsFromGrant(genuine).withdrawalAddresses, undefined, "free-form, as signed");
  const atCutoff = grantWith([GRANT_TRANSFER, "tradeable-v2"], WITHDRAWAL_ALLOWLIST_LANDED_AT);
  assert.deepEqual(limitsFromGrant(atCutoff).withdrawalAddresses, [], "at the cutoff the permission is already gone");
});
