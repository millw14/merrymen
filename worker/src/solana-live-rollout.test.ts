import test from "node:test";
import assert from "node:assert/strict";
import { SOLANA_LIVE_CAP_DEFAULTS, SOLANA_LIVE_MAX_TENANTS, SolanaLiveRolloutError, solanaLiveCapRefusal, solanaLiveCaps, solanaLiveCapsExceeded, solanaLiveCapsText,
  solanaLiveRolloutFingerprint, solanaLiveSessionAboveCaps, solanaLiveTenants } from "./solana-live-rollout";

const A = `0x${"ab".repeat(20)}`, B = `0x${"12".repeat(20)}`;
const refusedWith = (pattern: RegExp, value?: string) => (error: unknown) => {
  assert.ok(error instanceof SolanaLiveRolloutError, String(error));
  assert.match(error.message, pattern);
  // The value is an operator's and may name other tenants: never repeated.
  if (value) assert.ok(!error.message.includes(value), error.message);
  return true;
};

test("the live list: unset or empty names nobody; entries are trimmed and compared case-insensitively", () => {
  for (const value of [undefined, "", "   "]) assert.deepEqual([...solanaLiveTenants({ MERRYMEN_SOLANA_LIVE_TENANTS: value })], [], String(value));
  assert.deepEqual([...solanaLiveTenants({})], []);
  const mixed = `0x${"AB".repeat(20)}`;
  assert.deepEqual([...solanaLiveTenants({ MERRYMEN_SOLANA_LIVE_TENANTS: mixed })], [A], "lowercased, so a checksummed spelling names the same tenant");
  assert.deepEqual([...solanaLiveTenants({ MERRYMEN_SOLANA_LIVE_TENANTS: ` ${A} ,\t${B}\n` })], [A, B]);
  assert.deepEqual([...solanaLiveTenants({ MERRYMEN_SOLANA_LIVE_TENANTS: `${A},${A.toUpperCase().replace("0X", "0x")}` })], [A], "named twice is harmless");
});

test("a malformed live list refuses, naming the setting and the entry's position, never its text", () => {
  const solana = "So11111111111111111111111111111111111111112";
  for (const [value, pattern, secret] of [
    [`${A},`, /^MERRYMEN_SOLANA_LIVE_TENANTS entry 2 is empty$/, A],
    [`,${A}`, /^MERRYMEN_SOLANA_LIVE_TENANTS entry 1 is empty$/, A],
    [`${A},,${B}`, /entry 2 is empty/, B],
    [`${A}, 0x1234`, /^MERRYMEN_SOLANA_LIVE_TENANTS entry 2 is not a tenant id \(0x and 40 hex digits\)$/, "0x1234"],
    [`${A} ${B}`, /entry 1 is not a tenant id/, B],
    [`0X${"ab".repeat(20)}`, /entry 1 is not a tenant id/, "ab".repeat(20)],
    [`${A.slice(0, -1)}g`, /entry 1 is not a tenant id/, A.slice(2, -1)],
    [`${A}0`, /entry 1 is not a tenant id/, A],
    [solana, /entry 1 is not a tenant id/, solana],
    [`${A}:trade`, /entry 1 is not a tenant id/, A],
    ["all", /entry 1 is not a tenant id/, undefined],
  ] as const) assert.throws(() => solanaLiveTenants({ MERRYMEN_SOLANA_LIVE_TENANTS: value }), refusedWith(pattern, secret), value);
  const many = Array.from({ length: SOLANA_LIVE_MAX_TENANTS + 1 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`).join(",");
  assert.throws(() => solanaLiveTenants({ MERRYMEN_SOLANA_LIVE_TENANTS: many }), refusedWith(/names more than 512 tenants/));
  assert.equal(solanaLiveTenants({ MERRYMEN_SOLANA_LIVE_TENANTS: many.split(",").slice(0, SOLANA_LIVE_MAX_TENANTS).join(",") }).size, SOLANA_LIVE_MAX_TENANTS);
});

test("live caps default to 10 and 25 USDG, 0.1 and 0.25 SOL, and read decimal amounts exactly", () => {
  const defaults = { perTradeUsdg: "10000000", dailyUsdg: "25000000", perTradeWsol: "100000000", dailyWsol: "250000000" };
  assert.deepEqual(SOLANA_LIVE_CAP_DEFAULTS, defaults);
  assert.deepEqual(solanaLiveCaps({}), defaults);
  // Empty is unset, as for the other Solana settings.
  assert.deepEqual(solanaLiveCaps({ MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG: "", MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "", MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL: "",
    MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "" }), defaults);
  assert.deepEqual(solanaLiveCaps({ MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG: "2.5", MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "12.000001",
    MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL: "0.000000001", MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "3" }),
  { perTradeUsdg: "2500000", dailyUsdg: "12000001", perTradeWsol: "1", dailyWsol: "3000000000" });
  // The largest each program field holds (u64 base units).
  assert.equal(solanaLiveCaps({ MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "18446744073709.551615" }).dailyUsdg, "18446744073709551615");
  assert.equal(solanaLiveCaps({ MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "18446744073.709551615" }).dailyWsol, "18446744073709551615");
});

test("a malformed cap, one beyond the program's u64 limits, a per-trade cap above its daily cap, or a USDG per-trade cap under the live minimum refuses clearly", () => {
  for (const [setting, value] of [
    ["MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG", "ten"], ["MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG", "-1"], ["MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG", "0"],
    ["MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG", " 25"], ["MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG", "25 "], ["MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG", "1e3"],
    ["MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG", "25.0000001"], ["MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG", "025"], ["MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG", "25."],
    ["MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG", "18446744073709.551616"], ["MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL", "18446744073.709551616"],
    ["MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL", "0.0000000001"], ["MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL", "0.000000000"],
  ] as const) {
    assert.throws(() => solanaLiveCaps({ [setting]: value }), refusedWith(new RegExp(`^${setting} must be a positive amount in (USDG with at most 6|SOL with at most 9) decimal places that fits the vault program \\(unset is [0-9.]+\\)$`)), `${setting}=${value}`);
  }
  assert.throws(() => solanaLiveCaps({ MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG: "30" }), refusedWith(/^MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG must not exceed MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG$/));
  assert.throws(() => solanaLiveCaps({ MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "0.05" }), refusedWith(/^MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL must not exceed MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL$/));
  assert.throws(() => solanaLiveCaps({ MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG: "0.999999" }), refusedWith(/must be at least the 1 USDG live minimum/));
  assert.equal(solanaLiveCaps({ MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG: "1" }).perTradeUsdg, "1000000", "exactly the minimum is a cap");
});

test("limits are judged against each cap, and the owner hears which cap and all of them", () => {
  const caps = SOLANA_LIVE_CAP_DEFAULTS;
  const at = { perTradeUsdg: "10000000", dailyUsdg: "25000000", perTradeWsol: "100000000", dailyWsol: "250000000" };
  assert.deepEqual(solanaLiveCapsExceeded(at, caps), []);
  assert.equal(solanaLiveCapRefusal(at, caps, "save"), null);
  assert.deepEqual(solanaLiveCapsExceeded({ ...at, perTradeUsdg: "10000001" }, caps), ["perTradeUsdg"]);
  assert.deepEqual(solanaLiveCapsExceeded({ perTradeUsdg: 10_000_000n, dailyUsdg: 25_000_000n, perTradeWsol: 100_000_001n, dailyWsol: 250_000_001n }, caps), ["perTradeWsol", "dailyWsol"]);
  // Paper-shaped limits (no SOL sell limits) are judged on what they carry.
  assert.deepEqual(solanaLiveCapsExceeded({ perTradeUsdg: "1", dailyUsdg: "25000001" }, caps), ["dailyUsdg"]);
  assert.equal(solanaLiveCapsText(caps), "at most 10 USDG per trade, 25 USDG per 24 hours, 0.1 SOL sold per trade and 0.25 SOL sold per 24 hours");
  assert.equal(solanaLiveCapRefusal({ ...at, dailyUsdg: "50000000", dailyWsol: "500000000" }, caps, "save"),
    "USDG per 24 hours is above this platform's live cap of 25 USDG; SOL sold per 24 hours is above this platform's live cap of 0.25 SOL. "
    + "Live limits here are at most 10 USDG per trade, 25 USDG per 24 hours, 0.1 SOL sold per trade and 0.25 SOL sold per 24 hours. Lower them and save again. Nothing was saved.");
  assert.match(solanaLiveCapRefusal({ ...at, perTradeUsdg: "20000000", dailyUsdg: "20000000" }, caps, "register")!,
    /^USDG per trade is above this platform's live cap of 10 USDG\. .* Save live limits within them, then register\. Nothing was prepared\.$/);
  assert.equal(solanaLiveSessionAboveCaps(caps), "Your registered live permission allows more than this platform's live caps (at most 10 USDG per trade, 25 USDG per 24 hours, "
    + "0.1 SOL sold per trade and 0.25 SOL sold per 24 hours). Buying is paused until you register a new permission within them; exits, revoke and withdraw still work.");
});

test("the rollout fingerprint is the same for the same settings however spelled, differs for any other list or cap, and names no tenant", () => {
  const base = solanaLiveRolloutFingerprint({ MERRYMEN_SOLANA_LIVE_TENANTS: `${A},${B}` });
  assert.match(base, /^[0-9a-f]{64}$/);
  for (const env of [
    { MERRYMEN_SOLANA_LIVE_TENANTS: ` ${B} ,${A.toUpperCase().replace("0X", "0x")}, ${A}` },
    { MERRYMEN_SOLANA_LIVE_TENANTS: `${A},${B}`, MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG: "10", MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "", MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "0.250" },
  ]) assert.equal(solanaLiveRolloutFingerprint(env), base, JSON.stringify(env));
  const others = [
    { MERRYMEN_SOLANA_LIVE_TENANTS: A }, { MERRYMEN_SOLANA_LIVE_TENANTS: "" }, { MERRYMEN_SOLANA_LIVE_TENANTS: `${A},${B}`, MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "24" },
    { MERRYMEN_SOLANA_LIVE_TENANTS: `${A},${B}`, MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL: "0.05" },
  ].map(env => solanaLiveRolloutFingerprint(env));
  assert.equal(new Set([base, ...others]).size, 5, "each other setting has its own digest");
  // Unreadable is one state of its own, whatever made it so.
  const unreadable = solanaLiveRolloutFingerprint({ MERRYMEN_SOLANA_LIVE_TENANTS: `${A},` });
  assert.equal(solanaLiveRolloutFingerprint({ MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "lots" }), unreadable);
  assert.ok(![base, ...others].includes(unreadable));
  for (const digest of [base, unreadable]) assert.ok(!digest.includes(A.slice(2)) && !digest.includes(B.slice(2)));
});
