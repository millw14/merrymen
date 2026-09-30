/**
 * THE ON-CHAIN LEGS' STATE MACHINE (onboard.ts) — every branch, as a table.
 *
 * What each block pins, and why it is load-bearing:
 *   order      — the steps come out in the contract's order: not-granted, a
 *                due claim (an exit waits on nothing), the chain's index, a
 *                foreign or retired key BEFORE a single micro is deposited,
 *                then the account's own path.
 *   21126      — no key registration on an account with no cross collateral:
 *                the deposit first, then the credit, then the key.
 *   the slot   — the worker registers over an empty slot, its own older key
 *                or the owner's recorded rotation, and NOTHING else: any other
 *                key is an incident, and a retired key is never registered or
 *                funded (wall-security.md owner-key-rotation-undone…).
 *   funding    — a deposit exists only to fund a pending open: margin + 10%,
 *                ≥ 1 USDG, inside the per-call cap, the collateral cap and the
 *                cash — a cap clamps the buffer and never gives way itself.
 *   builders   — each builder's calls pass their own fence (final-fence.ts).
 *   self-check — verifyKeyUsable needs the public key AND a token our private
 *                key made; either failing is perp-key-mismatch, proven or
 *                unread.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIGHTER_ROUTE_V1, type PerpGrant } from "../../../packages/core/src/index";
import { checkPerpClaimCalls, checkPerpDepositCalls, checkPerpKeyCalls, type FenceCall } from "../final-fence";
import type { LighterResult } from "./api";
import type { ApiKeyRead } from "./markets";
import {
  CLAIM_GRACE_SEC,
  MIN_DEPOSIT_MICRO,
  apiKeySlotOf,
  buildClaimCalls,
  buildDepositCalls,
  buildKeyCalls,
  claimDue,
  onboardingBlocker,
  planDeposit,
  planOnboarding,
  verifyKeyUsable,
  type OnboardingInput,
  type OnboardingStep,
} from "./onboard";

const key = (b: string) => `0x${(b + "00".repeat(7)).repeat(5)}` as `0x${string}`;
const SEALED = key("01");
const OLD = key("02"); // a key this worker registered from an earlier grant
const OWNER_T = key("03"); // recover's throwaway, recorded as the owner's rotation
const FOREIGN = key("04");
const SELF = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const PERP: PerpGrant = { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: SEALED };
const USDG = (n: number) => BigInt(Math.round(n * 1_000_000));
const NOW = 1_800_000_000;
const IDX = 22_149n;

/** An armed, funded agent with its key registered and nothing pending: `ready`. Every case moves one thing. */
function input(over: {
  grantPerp?: PerpGrant | null;
  chainState?: Partial<OnboardingInput["chainState"]>;
  venue?: Partial<OnboardingInput["venue"]>;
  ledger?: Partial<OnboardingInput["ledger"]>;
  needMarginMicro?: bigint | null;
  caps?: Partial<OnboardingInput["caps"]>;
  nowSec?: number;
} = {}): OnboardingInput {
  return {
    grantPerp: over.grantPerp === undefined ? PERP : over.grantPerp,
    chainState: { usdgBalanceMicro: USDG(100), accountIndex: IDX, pendingBalanceMicro: 0n, pendingSinceSec: null, ...over.chainState },
    venue: { apikeysAtIndex: { publicKey: SEALED }, crossCollateralMicro: USDG(20), withdrawalDelaySec: 600, ...over.venue },
    ledger: { registeredPubKey: SEALED, retiredPubKeys: [], ownerRotatedPubKeys: [], depositsInFlight: 0, keyRegistrationInFlight: false, ...over.ledger },
    needMarginMicro: over.needMarginMicro === undefined ? 0n : over.needMarginMicro,
    caps: { perTradeMicro: USDG(25), maxCollateralMicro: USDG(60), committedMicro: USDG(20), ...over.caps },
    nowSec: over.nowSec ?? NOW,
  };
}
const plan = (over: Parameters<typeof input>[0] = {}): OnboardingStep => planOnboarding(input(over));

describe("the order the contract gives", () => {
  it("no perp block on the grant is not-granted, whatever else is true", () => {
    assert.deepEqual(plan({ grantPerp: null }), { kind: "not-granted" });
    assert.deepEqual(plan({ grantPerp: { ...PERP, apiKeyIndex: 3 } }), { kind: "not-granted" }, "the route's index or nothing");
    assert.deepEqual(plan({ grantPerp: { ...PERP, apiPublicKey: `0x${"ff".repeat(40)}` } }), { kind: "not-granted" });
    assert.deepEqual(
      plan({ grantPerp: null, chainState: { pendingBalanceMicro: USDG(5), pendingSinceSec: 0 } }),
      { kind: "not-granted" },
      "a claim through the wall needs the wall's permission",
    );
  });

  it("an armed, funded account with the sealed key registered is ready", () => {
    assert.deepEqual(plan(), { kind: "ready" });
    // A wiped ledger (hosted re-home) does not make the sealed key foreign.
    assert.deepEqual(plan({ ledger: { registeredPubKey: null } }), { kind: "ready" });
  });

  it("a due claim comes first — before an unread index, a foreign key, a retired key", () => {
    const due = { pendingBalanceMicro: USDG(7), pendingSinceSec: NOW - (2 * 600 + CLAIM_GRACE_SEC) };
    assert.deepEqual(plan({ chainState: due }), { kind: "claim", amountMicro: USDG(7) });
    assert.deepEqual(plan({ chainState: { ...due, accountIndex: null } }), { kind: "claim", amountMicro: USDG(7) });
    assert.deepEqual(plan({ chainState: due, venue: { apikeysAtIndex: { publicKey: FOREIGN } } }), { kind: "claim", amountMicro: USDG(7) });
    assert.deepEqual(plan({ chainState: due, ledger: { retiredPubKeys: [SEALED] } }), { kind: "claim", amountMicro: USDG(7) });
  });

  it("the chain's account index unread is unread — never 'no account'", () => {
    assert.deepEqual(plan({ chainState: { accountIndex: null } }), { kind: "unread", what: "account-index" });
    assert.deepEqual(plan({ chainState: { accountIndex: -1 } }), { kind: "unread", what: "account-index" });
    assert.deepEqual(plan({ chainState: { accountIndex: 2n ** 48n } }), { kind: "unread", what: "account-index" });
  });
});

describe("the claim: only once the relayer has had 2 × the venue's delay + 10 minutes", () => {
  const since = NOW - (2 * 600 + CLAIM_GRACE_SEC);
  it("claims exactly the pending balance, at the boundary and not a second before", () => {
    assert.equal(claimDue({ pendingBalanceMicro: USDG(3), pendingSinceSec: since, withdrawalDelaySec: 600, nowSec: NOW }), USDG(3));
    assert.equal(claimDue({ pendingBalanceMicro: USDG(3), pendingSinceSec: since + 1, withdrawalDelaySec: 600, nowSec: NOW }), null);
    // The delay is read each time: a longer one waits longer.
    assert.equal(claimDue({ pendingBalanceMicro: USDG(3), pendingSinceSec: since, withdrawalDelaySec: 1314, nowSec: NOW }), null);
  });
  it("anything unread is 'not yet', never 'now'", () => {
    const base = { pendingBalanceMicro: USDG(3), pendingSinceSec: since, withdrawalDelaySec: 600, nowSec: NOW };
    assert.equal(claimDue({ ...base, pendingBalanceMicro: null }), null);
    assert.equal(claimDue({ ...base, pendingBalanceMicro: 0n }), null);
    assert.equal(claimDue({ ...base, pendingSinceSec: null }), null);
    assert.equal(claimDue({ ...base, withdrawalDelaySec: null }), null);
    assert.equal(claimDue({ ...base, withdrawalDelaySec: 600.5 }), null);
    assert.equal(claimDue({ ...base, nowSec: undefined }), null);
    // …and a claim that is not due never blocks the rest of the machine.
    assert.deepEqual(plan({ chainState: { pendingBalanceMicro: null } }), { kind: "ready" });
    assert.deepEqual(plan({ chainState: { pendingBalanceMicro: USDG(3), pendingSinceSec: since + 1 } }), { kind: "ready" });
  });
});

describe("no Lighter account yet: only a deposit creates one, and only for an open", () => {
  const none = { accountIndex: 0n };
  it("nothing to fund is idle — the first deposit is never volunteered", () => {
    assert.deepEqual(plan({ chainState: none }), { kind: "idle" });
    assert.deepEqual(plan({ chainState: { accountIndex: 0 } }), { kind: "idle" }, "a number 0 from viem's uint48 is 'none' too");
  });
  it("an open to fund deposits its margin + 10%", () => {
    assert.deepEqual(plan({ chainState: none, needMarginMicro: USDG(10) }), { kind: "deposit", amountMicro: USDG(11) });
  });
  it("a deposit already on its way is awaited, never repeated", () => {
    assert.deepEqual(plan({ chainState: none, needMarginMicro: USDG(10), ledger: { depositsInFlight: 1 } }), { kind: "await-credit" });
    assert.deepEqual(plan({ chainState: none, ledger: { depositsInFlight: 1 } }), { kind: "await-credit" });
  });
  it("unread cash is unread, not zero", () => {
    assert.deepEqual(plan({ chainState: { ...none, usdgBalanceMicro: null }, needMarginMicro: USDG(10) }), { kind: "unread", what: "cash" });
  });
  it("a grant whose key was retired funds nothing, even the first deposit", () => {
    assert.deepEqual(plan({ chainState: none, needMarginMicro: USDG(10), ledger: { retiredPubKeys: [SEALED] } }), { kind: "key-retired", inSlot: false });
  });
});

describe("21126: no key change on an account with no cross collateral", () => {
  const empty = { apikeysAtIndex: "empty" as const };
  it("an empty slot on a funded account registers the sealed key", () => {
    assert.deepEqual(plan({ venue: empty }), { kind: "register-key", accountIndex: 22_149 });
  });
  it("C = 0 with our deposit landing: wait for the credit, then register", () => {
    assert.deepEqual(plan({ venue: { ...empty, crossCollateralMicro: 0n }, ledger: { depositsInFlight: 1 } }), { kind: "await-credit" });
    // The venue not showing the account yet (read null) while our deposit lands: the same wait.
    assert.deepEqual(plan({ venue: { ...empty, crossCollateralMicro: null }, ledger: { depositsInFlight: 1 } }), { kind: "await-credit" });
    // Credited: now the key.
    assert.deepEqual(plan({ venue: { ...empty, crossCollateralMicro: USDG(11) }, ledger: { depositsInFlight: 0 } }), { kind: "register-key", accountIndex: 22_149 });
  });
  it("C = 0 and an open to fund: the deposit first (it also satisfies 21126)", () => {
    assert.deepEqual(plan({ venue: { ...empty, crossCollateralMicro: 0n }, needMarginMicro: USDG(10) }), { kind: "deposit", amountMicro: USDG(11) });
  });
  it("C = 0 and nothing to fund: idle, never a key change the venue would refuse", () => {
    assert.deepEqual(plan({ venue: { ...empty, crossCollateralMicro: 0n } }), { kind: "idle" });
  });
  it("C unread is unread — the registration waits for a read, not a guess", () => {
    assert.deepEqual(plan({ venue: { ...empty, crossCollateralMicro: null } }), { kind: "unread", what: "collateral" });
  });
  it("our registration in flight is awaited, never sent twice", () => {
    assert.deepEqual(plan({ venue: empty, ledger: { keyRegistrationInFlight: true } }), { kind: "await-key" });
  });
  it("the slot unread on an existing account is unread — never 'empty'", () => {
    assert.deepEqual(plan({ venue: { apikeysAtIndex: "unread" } }), { kind: "unread", what: "api-key" });
  });
});

describe("the slot: register over empty, our own older key, or the owner's recorded rotation — nothing else", () => {
  it("our own older key (a re-sign rotated the sealed key) is replaced", () => {
    assert.deepEqual(plan({ venue: { apikeysAtIndex: { publicKey: OLD } }, ledger: { registeredPubKey: OLD } }), { kind: "register-key", accountIndex: 22_149 });
  });
  it("…unless that older key was retired: then it is somebody else's now", () => {
    assert.deepEqual(
      plan({ venue: { apikeysAtIndex: { publicKey: OLD } }, ledger: { registeredPubKey: OLD, retiredPubKeys: [OLD] } }),
      { kind: "key-foreign", publicKey: OLD },
    );
  });
  it("the owner's recover key, as recover recorded it, is replaced by a fresh grant's key", () => {
    assert.deepEqual(
      plan({ venue: { apikeysAtIndex: { publicKey: OWNER_T } }, ledger: { registeredPubKey: OLD, retiredPubKeys: [OLD], ownerRotatedPubKeys: [OWNER_T] } }),
      { kind: "register-key", accountIndex: 22_149 },
    );
  });
  it("any other key is foreign: an incident, never registered over, never funded", () => {
    const foreign = { apikeysAtIndex: { publicKey: FOREIGN } };
    assert.deepEqual(plan({ venue: foreign }), { kind: "key-foreign", publicKey: FOREIGN });
    assert.deepEqual(plan({ venue: foreign, needMarginMicro: USDG(40) }), { kind: "key-foreign", publicKey: FOREIGN }, "no deposit to a key someone else holds");
    assert.deepEqual(plan({ venue: foreign, ledger: { keyRegistrationInFlight: true } }), { kind: "key-foreign", publicKey: FOREIGN });
    // An owner rotation nobody recorded is indistinguishable from a thief's key.
    assert.deepEqual(plan({ venue: { apikeysAtIndex: { publicKey: OWNER_T } } }), { kind: "key-foreign", publicKey: OWNER_T });
  });
  it("the venue's spelling never matters: bare, uppercase, 0x", () => {
    const bareUpper = SEALED.slice(2).toUpperCase() as `0x${string}`;
    assert.deepEqual(plan({ venue: { apikeysAtIndex: { publicKey: bareUpper } } }), { kind: "ready" });
  });
});

describe("a retired sealed key is never registered, funded or trusted", () => {
  it("retired and back at our index: someone holding the old grant put it back — an incident", () => {
    assert.deepEqual(plan({ ledger: { retiredPubKeys: [SEALED] } }), { kind: "key-retired", inSlot: true });
  });
  it("retired, the owner's key at our index: perps refused for this grant until a fresh re-sign", () => {
    assert.deepEqual(
      plan({ venue: { apikeysAtIndex: { publicKey: OWNER_T } }, ledger: { retiredPubKeys: [SEALED], ownerRotatedPubKeys: [OWNER_T] } }),
      { kind: "key-retired", inSlot: false },
    );
    assert.deepEqual(plan({ venue: { apikeysAtIndex: "empty" }, ledger: { retiredPubKeys: [SEALED] } }), { kind: "key-retired", inSlot: false });
  });
  it("a retired list that does not parse in full is not a shorter list", () => {
    assert.deepEqual(plan({ ledger: { retiredPubKeys: ["not a key"] } }), { kind: "key-retired", inSlot: false });
    // …while the same key twice, in two spellings, is still one readable list.
    assert.deepEqual(plan({ ledger: { retiredPubKeys: [OLD, OLD.toUpperCase().replace("0X", "0x")] } }), { kind: "ready" });
  });
});

describe("funding a pending open: margin + 10%, within every cap, never a cap relaxed", () => {
  it("covered by the cross collateral already there: ready, no deposit", () => {
    assert.deepEqual(plan({ needMarginMicro: USDG(20) }), { kind: "ready" });
  });
  it("short: tops up to margin + 10%", () => {
    assert.deepEqual(plan({ needMarginMicro: USDG(30) }), { kind: "deposit", amountMicro: USDG(13) });
  });
  it("short with our deposit on its way: await it", () => {
    assert.deepEqual(plan({ needMarginMicro: USDG(30), ledger: { depositsInFlight: 1 } }), { kind: "await-credit" });
  });
  it("C unread: never a deposit sized from a guess", () => {
    assert.deepEqual(plan({ needMarginMicro: USDG(30), venue: { crossCollateralMicro: null } }), { kind: "unread", what: "collateral" });
  });
  it("the buffer gives way to a cap; the margin never does", () => {
    const d = (over: Partial<Parameters<typeof planDeposit>[0]>) =>
      planDeposit({ needMarginMicro: USDG(10), crossCollateralMicro: USDG(5), usdgBalanceMicro: USDG(100), caps: { perTradeMicro: USDG(25), maxCollateralMicro: USDG(60), committedMicro: USDG(5) }, ...over });
    assert.deepEqual(d({}), { kind: "deposit", amountMicro: USDG(6) });
    // Per call: 5.5 still covers the 5 short — the buffer shrinks.
    assert.deepEqual(d({ caps: { perTradeMicro: USDG(5.5), maxCollateralMicro: USDG(60), committedMicro: USDG(5) } }), { kind: "deposit", amountMicro: USDG(5.5) });
    // Per call: 3 cannot cover 5 → the open is refused, the cap stands.
    const perTrade = d({ caps: { perTradeMicro: USDG(3), maxCollateralMicro: USDG(60), committedMicro: USDG(5) } });
    assert.equal(perTrade.kind === "cannot-fund" ? perTrade.rule : perTrade.kind, "perp-per-trade-cap");
    // Collateral headroom 2 → refused.
    const coll = d({ caps: { perTradeMicro: USDG(25), maxCollateralMicro: USDG(30), committedMicro: USDG(28) } });
    assert.equal(coll.kind === "cannot-fund" ? coll.rule : coll.kind, "perp-collateral-cap");
    // Already past the cap (headroom negative) → refused, never a negative deposit.
    const past = d({ caps: { perTradeMicro: USDG(25), maxCollateralMicro: USDG(30), committedMicro: USDG(31) } });
    assert.equal(past.kind === "cannot-fund" ? past.rule : past.kind, "perp-collateral-cap");
    // The cash is the last clamp.
    const cash = d({ usdgBalanceMicro: USDG(4) });
    assert.equal(cash.kind === "cannot-fund" ? cash.rule : cash.kind, "perp-no-cash");
    assert.deepEqual(d({ usdgBalanceMicro: USDG(5.2) }), { kind: "deposit", amountMicro: USDG(5.2) });
  });
  it("never under Lighter's 1 USDG minimum: raised to it, or refused when a cap will not allow it", () => {
    const d = (over: Partial<Parameters<typeof planDeposit>[0]>) =>
      planDeposit({ needMarginMicro: USDG(10.2), crossCollateralMicro: USDG(10), usdgBalanceMicro: USDG(100), caps: { perTradeMicro: USDG(25), maxCollateralMicro: USDG(60), committedMicro: USDG(10) }, ...over });
    // 0.2 short, target 11.22: 1.22 — above the minimum anyway.
    assert.deepEqual(d({}), { kind: "deposit", amountMicro: USDG(1.22) });
    // 0.01 short: 10% of 10.01 would make 1.011 — fine; 0.001 short of a tiny margin is raised to 1 USDG.
    assert.deepEqual(d({ needMarginMicro: USDG(0.5), crossCollateralMicro: USDG(0.4) }), { kind: "deposit", amountMicro: MIN_DEPOSIT_MICRO });
    const below = d({ caps: { perTradeMicro: USDG(25), maxCollateralMicro: USDG(10.5), committedMicro: USDG(10) } });
    assert.equal(below.kind === "cannot-fund" ? below.rule : below.kind, "perp-below-min");
  });
  it("the table's cannot-fund comes out of planOnboarding too, with nothing deposited", () => {
    const s = plan({ needMarginMicro: USDG(30), caps: { perTradeMicro: USDG(5) } });
    assert.equal(s.kind, "cannot-fund");
    assert.equal(s.kind === "cannot-fund" ? s.rule : null, "perp-per-trade-cap");
  });
  it("no margin wanted is never a deposit, whatever the account holds", () => {
    assert.deepEqual(plan({ needMarginMicro: null, venue: { crossCollateralMicro: 0n } }), { kind: "ready" });
    assert.deepEqual(plan({ needMarginMicro: -5n }), { kind: "ready" });
  });
});

describe("what each step tells the owner", () => {
  it("maps to the perps blockers, and the steps that are not reasons map to none", () => {
    assert.equal(onboardingBlocker({ kind: "not-granted" }), "perps-not-granted");
    assert.equal(onboardingBlocker({ kind: "deposit", amountMicro: 1n }), "perps-awaiting-deposit");
    assert.equal(onboardingBlocker({ kind: "await-credit" }), "perps-awaiting-deposit");
    assert.equal(onboardingBlocker({ kind: "register-key", accountIndex: 1 }), "perps-key-pending");
    assert.equal(onboardingBlocker({ kind: "await-key" }), "perps-key-pending");
    assert.equal(onboardingBlocker({ kind: "key-foreign", publicKey: FOREIGN }), "perps-key-mismatch");
    assert.equal(onboardingBlocker({ kind: "key-retired", inSlot: false }), "perps-key-mismatch");
    assert.equal(onboardingBlocker({ kind: "unread", what: "api-key" }), "perps-venue-unreachable");
    assert.equal(onboardingBlocker({ kind: "cannot-fund", rule: "perp-no-cash", detail: "" }), "perps-no-collateral");
    assert.equal(onboardingBlocker({ kind: "cannot-fund", rule: "perp-collateral-cap", detail: "" }), null);
    assert.equal(onboardingBlocker({ kind: "ready" }), null);
    assert.equal(onboardingBlocker({ kind: "idle" }), null);
    assert.equal(onboardingBlocker({ kind: "claim", amountMicro: 1n }), null);
  });
});

describe("the builders: each one's calls pass its own fence", () => {
  it("deposit, key and claim", () => {
    const dep = buildDepositCalls({ perp: PERP, account: SELF, amountMicro: USDG(11) }) as FenceCall[];
    assert.deepEqual(checkPerpDepositCalls(dep, { account: SELF, usdg: LIGHTER_ROUTE_V1.usdg, proxy: LIGHTER_ROUTE_V1.proxy, amount: USDG(11) }), { ok: true });
    const k = buildKeyCalls({ perp: PERP, accountIndex: 22_149 }) as FenceCall[];
    assert.deepEqual(checkPerpKeyCalls(k, { proxy: LIGHTER_ROUTE_V1.proxy, accountIndex: 22_149, apiKeyIndex: 16, apiPublicKey: SEALED }), { ok: true });
    const c = buildClaimCalls({ perp: PERP, account: SELF, amountMicro: USDG(7) }) as FenceCall[];
    assert.deepEqual(checkPerpClaimCalls(c, { proxy: LIGHTER_ROUTE_V1.proxy, account: SELF, amount: USDG(7) }), { ok: true });
  });
  it("a planned step builds straight into its fence: deposit from planOnboarding, key from its account index", () => {
    const s = plan({ chainState: { accountIndex: 0n }, needMarginMicro: USDG(10) });
    assert.equal(s.kind, "deposit");
    const amount = s.kind === "deposit" ? s.amountMicro : 0n;
    const calls = buildDepositCalls({ perp: PERP, account: SELF, amountMicro: amount }) as FenceCall[];
    assert.deepEqual(checkPerpDepositCalls(calls, { account: SELF, usdg: LIGHTER_ROUTE_V1.usdg, proxy: LIGHTER_ROUTE_V1.proxy, amount }), { ok: true });
    const r = plan({ venue: { apikeysAtIndex: "empty" } });
    assert.equal(r.kind, "register-key");
    const idx = r.kind === "register-key" ? r.accountIndex : 0;
    assert.deepEqual(
      checkPerpKeyCalls(buildKeyCalls({ perp: PERP, accountIndex: idx }) as FenceCall[], { proxy: LIGHTER_ROUTE_V1.proxy, accountIndex: idx, apiKeyIndex: 16, apiPublicKey: PERP.apiPublicKey }),
      { ok: true },
    );
  });
  it("refuse to build what nobody could have decided", () => {
    assert.throws(() => buildDepositCalls({ perp: PERP, account: SELF, amountMicro: MIN_DEPOSIT_MICRO - 1n }), /minimum/);
    assert.throws(() => buildDepositCalls({ perp: PERP, account: "0x12" as `0x${string}`, amountMicro: USDG(2) }), /not an account/);
    assert.throws(() => buildDepositCalls({ perp: { ...PERP, route: "x" as never }, account: SELF, amountMicro: USDG(2) }), /no Lighter route/);
    assert.throws(() => buildKeyCalls({ perp: PERP, accountIndex: 0 }), /not a Lighter account/);
    assert.throws(() => buildKeyCalls({ perp: PERP, accountIndex: 2n ** 48n }), /not a Lighter account/);
    assert.throws(() => buildKeyCalls({ perp: { ...PERP, apiPublicKey: `0x${"ff".repeat(40)}` }, accountIndex: 1 }), /not a canonical/);
    assert.throws(() => buildClaimCalls({ perp: PERP, account: SELF, amountMicro: 0n }), /not an amount/);
  });
});

// ── reading the slot, and the arm-time self-check ───────────────────────────

const ok = <T>(value: T): LighterResult<T> => ({ ok: true, value, serverDateMs: null });
const read = (publicKey: string, apiKeyIndex = 16): ApiKeyRead => ({ accountIndex: 22_149, apiKeyIndex, nonce: 1, publicKey: publicKey as `0x${string}` });
const rejected = (code: number, status = 400): LighterResult<never> => ({
  ok: false,
  error: { kind: "rejected", status, code, retryable: false, detail: `GET /api/v1/apikeys → HTTP ${status} code ${code}` },
  serverDateMs: null,
});

describe("apiKeySlotOf: empty only on the venue's own word", () => {
  it("21109 is empty; a key is a key; everything else is unread", () => {
    assert.equal(apiKeySlotOf(rejected(21109)), "empty");
    assert.deepEqual(apiKeySlotOf(ok([read(SEALED.slice(2))])), { publicKey: SEALED });
    assert.equal(apiKeySlotOf(ok([])), "unread", "a 200 with no key is not the venue saying 'empty'");
    assert.equal(apiKeySlotOf(ok([read(SEALED), read(FOREIGN)])), "unread");
    assert.equal(apiKeySlotOf(ok([read(SEALED, 15)])), "unread", "an answer about another index");
    assert.equal(apiKeySlotOf(ok([read(`0x${"ff".repeat(40)}`)])), "unread", "not a key the contract could hold");
    assert.equal(apiKeySlotOf(rejected(20001)), "unread");
    assert.equal(apiKeySlotOf({ ok: false, error: { kind: "unavailable", status: 503, retryable: true, detail: "x" }, serverDateMs: null }), "unread");
  });
});

describe("verifyKeyUsable: the public key AND a token only our private key could make", () => {
  const probeOk = async () => ok({});
  it("passes only when both halves pass", async () => {
    let probed = 0;
    const v = await verifyKeyUsable({ apikeysRead: ok([read(SEALED.slice(2).toUpperCase())]), sealedPubKey: SEALED, authProbe: async () => (probed++, ok({})) });
    assert.deepEqual(v, { ok: true });
    assert.equal(probed, 1);
  });
  it("another key, or none, is a proven mismatch — and the probe is not spent on it", async () => {
    let probed = 0;
    const probe = async () => (probed++, ok({}));
    const other = await verifyKeyUsable({ apikeysRead: { publicKey: FOREIGN }, sealedPubKey: SEALED, authProbe: probe });
    assert.equal(other.ok, false);
    assert.equal(!other.ok && other.rule, "perp-key-mismatch");
    assert.equal(!other.ok && other.unread, false);
    const none = await verifyKeyUsable({ apikeysRead: rejected(21109), sealedPubKey: SEALED, authProbe: probe });
    assert.equal(!none.ok && none.unread, false);
    assert.equal(probed, 0);
  });
  it("the venue refusing our token is proven: the private key is not the registered one", async () => {
    for (const refusal of [
      rejected(20013),
      { ok: false as const, error: { kind: "unavailable" as const, status: 401, retryable: true as const, detail: "HTTP 401 with no venue code" }, serverDateMs: null },
    ]) {
      const v = await verifyKeyUsable({ apikeysRead: { publicKey: SEALED }, sealedPubKey: SEALED, authProbe: async () => refusal });
      assert.equal(!v.ok && v.rule, "perp-key-mismatch");
      assert.equal(!v.ok && v.unread, false);
    }
  });
  it("could-not-check is still a failure — unread, so nobody is told the key leaked over a blip", async () => {
    const limited = await verifyKeyUsable({
      apikeysRead: { publicKey: SEALED },
      sealedPubKey: SEALED,
      authProbe: async () => ({ ok: false, error: { kind: "rate-limited", source: "venue", status: 429, retryAfterMs: 60_000, retryable: true, detail: "x" }, serverDateMs: null }),
    });
    assert.equal(!limited.ok && limited.unread, true);
    const threw = await verifyKeyUsable({ apikeysRead: { publicKey: SEALED }, sealedPubKey: SEALED, authProbe: async () => { throw new Error("signer unavailable"); } });
    assert.equal(threw.ok, false);
    assert.equal(!threw.ok && threw.unread, true);
    assert.doesNotMatch(!threw.ok ? threw.detail : "", /signer unavailable/, "a thrown message is not echoed (it may carry key material)");
    const slotUnread = await verifyKeyUsable({ apikeysRead: "unread", sealedPubKey: SEALED, authProbe: probeOk });
    assert.equal(!slotUnread.ok && slotUnread.unread, true);
  });
});
