/**
 * TWO CALL PERMISSIONS MAY NOT SHARE A TARGET AND SELECTOR.
 *
 * ── THE PRODUCTION FAILURE THIS REPRODUCES ───────────────────────────────
 *
 * Kernel's CallPolicy keys each permission by a hash over (target, selector)
 * and refuses to install the same key twice. Every UserOperation from a grant
 * carrying BOTH the Trencher vault and the ordinary router approvals therefore
 * reverts during validation:
 *
 *   AA23 reverted duplicate permissionHash
 *
 * Measured on chain 4663: agent 0x8e93ba, 20 refusals in 3.5 hours on
 * permission id 0x5f645dab, then — after the owner re-signed, minting the
 * brand-new id 0x5d8c1f22 — the very first entry attempt failed identically at
 * 18:41:09 on 2026-09-20. A fresh session key cannot help, because the
 * duplicate is INSIDE the wall being installed, not left over on chain.
 *
 * The collision:
 *
 *   trencherPermissions[0]  target USDG, `approve`, EQUAL(vault),    LTE(min(cap,5))
 *   buildCallPermissions    target USDG, `approve`, ONE_OF(spenders), LTE(perTrade)
 *
 * and `buildCallPermissions` spreads the first straight into the second's
 * array. Both are individually correct; together they are uninstallable.
 *
 * ── WHY THE PROPERTY, NOT THE PAIR ───────────────────────────────────────
 *
 * Asserting "these two specific entries do not collide" would pass the moment
 * someone renames one and break again on the next feature that adds a target
 * already in the wall. The wall is assembled by spreading several independent
 * builders into one array, so the invariant belongs to the array.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCallPermissions } from "./wall";
import { ENERGY_ROUTE_V1 } from "./energy";

const SELF = "0x1111111111111111111111111111111111111111";
const CAPS = { perTradeUsdg: 10, dailyUsdg: 500, maxOpsPerDay: 24, maxDrawdownBps: 500, expiryDays: 7 };

const TRENCHER = {
  trencherVaultAddress: "0x2222222222222222222222222222222222222222",
  trencherFactoryAddress: "0x3333333333333333333333333333333333333333",
};

/** The key Kernel's CallPolicy actually collides on. */
const keyOf = (p: { target: string; functionName?: string }) =>
  `${String(p.target).toLowerCase()}:${p.functionName ?? "(fallback)"}`;

const duplicatesIn = (wall: readonly { target: string; functionName?: string }[]) => {
  const seen = new Map<string, number>();
  for (const p of wall) seen.set(keyOf(p), (seen.get(keyOf(p)) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
};

test("a wall with the Trencher vault installs — no (target, selector) appears twice", () => {
  const wall = buildCallPermissions(CAPS as never, SELF, TRENCHER);
  assert.deepEqual(
    duplicatesIn(wall as never),
    [],
    "Kernel's CallPolicy refuses a repeated (target, selector); this wall cannot be enabled at all",
  );
});

test("the plain wall has no duplicates either — the invariant is not Trencher-specific", () => {
  assert.deepEqual(duplicatesIn(buildCallPermissions(CAPS as never, SELF, {}) as never), []);
});

test("nor does it with every optional rail switched on at once", () => {
  // The combination an owner actually ends up with, and the one most likely to
  // collide as rails are added independently of each other.
  const everything = {
    ...TRENCHER,
    ponsClassVaultAddress: "0x4444444444444444444444444444444444444444",
    ponsClassVaultFactoryAddress: "0x5555555555555555555555555555555555555555",
    v4AdapterAddress: "0x6666666666666666666666666666666666666666",
    ponsAdapterAddress: "0x7777777777777777777777777777777777777777",
    withdrawalAddresses: ["0x8888888888888888888888888888888888888888"],
    // The energy buy is the newest rail and the one that most invites the
    // Trencher mistake: its router pulls USDG, so the obvious build is a second
    // USDG `approve` scoped to the router — the exact (target, selector) pair
    // the ordinary approve already holds.
    energyBuy: true,
  } as never;
  assert.deepEqual(duplicatesIn(buildCallPermissions(CAPS as never, SELF, everything) as never), []);
});

test("the energy router is a USDG spender through the ONE approve, not a second one", () => {
  const wall = buildCallPermissions(CAPS as never, SELF, { energyBuy: true } as never) as readonly {
    target: string; functionName?: string; args?: readonly (null | { value?: unknown })[];
  }[];
  const approvals = wall.filter((p) => p.functionName === "approve" && /^0x5fc5360d/i.test(p.target));
  assert.equal(approvals.length, 1, "exactly one USDG approve permission");
  const spenders = (approvals[0]!.args?.[0]?.value as string[]).map((a) => a.toLowerCase());
  assert.ok(spenders.includes(ENERGY_ROUTE_V1.router), "the router rides in that approve's ONE_OF");
});

test("the Trencher vault is still an approved USDG spender after any de-duplication", () => {
  // The fix must not be "drop one entry": the vault has to remain approvable or
  // buy() cannot pull cash, and the whole rail is dead in a quieter way.
  const wall = buildCallPermissions(CAPS as never, SELF, TRENCHER) as readonly {
    target: string; functionName?: string; args?: readonly (null | { value?: unknown })[];
  }[];
  const approvals = wall.filter((p) => p.functionName === "approve" && /^0x5fc5360d/i.test(p.target));
  assert.ok(approvals.length >= 1, "USDG approve must exist");
  const vault = TRENCHER.trencherVaultAddress.toLowerCase();
  const names = approvals.flatMap((p) => {
    const v = p.args?.[0]?.value;
    return Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : v === undefined ? [] : [String(v).toLowerCase()];
  });
  assert.ok(names.includes(vault), "the vault must remain an approved spender");
});
