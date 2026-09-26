/**
 * THE DEPOSITS AN AGENT NEVER SAW, BOOKED — AND ONLY WHERE THE CHAIN LEAVES
 * NOTHING TO JUDGE.
 *
 * The case these tests are built around is real: on 2026-09-25 an owner funded
 * an agent that had started on paper with two transfers (4.935223 and 5.937578
 * USDG). The child never booked them, restarts laundered the drift into a
 * "clean" resume on zero contributions, and the Brain refused to size anything
 * until an operator ran MERRYMEN_REPAIR by hand. The end-to-end test below
 * replays that ledger and then asks the child's OWN accounting code whether it
 * would now resume with contributions known.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { totalCapital, type Classification } from "../../packages/core/src/index";
import type { AccountCapital, CapitalMovement } from "./chain-capital";
import { planReconstruction } from "./accounting-reconstruction";
import { deriveBootstrapAccounting } from "./bootstrap-source";
import { accountingLicence, planFirstObservation, type TenantBootstrapState } from "./bootstrap-state";
import {
  AUTO_CAPITAL_MIN_AGE_BLOCKS,
  autoCapitalCandidate,
  autoCapitalEnv,
  decideAutoCapital,
  runAutoCapitalPass,
  withVerifiedCash,
  type VaultFacts,
} from "./auto-capital";

const CHAIN = 4663;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ACCT = "0x492aB82fE8425023e8bA04c8fd223A8436598Bb4";
const OWNER = "0xf70da97812cb96acdf810712aa562db8dfa3dbef";
const TENANT = "0x8adfebdb338c66d872ccd0b936fd9a677b733039";
const TX1 = "0x642f28af06a4b9439aeaddb49ec906972654316f25dfca3ce92e4b46c70aba11";
const TX2 = "0x1b579f6444cd908b27cf40548bf2c5e2e8fc4bcb4172c3ba0a190a2773d593f2";
const HEAD = 72_440_526n;

const kind = (k: Classification["kind"]): Classification => ({
  kind: k,
  why: "test fixture",
  evidence: { counterparty: OWNER, direction: k.endsWith("out") ? "out" : "in", txLegCount: 1, rule: "no-pair-external" },
});

const move = (
  tx: string,
  block: number,
  amountRaw: string,
  k: Classification["kind"] = "capital-in",
  logIndex = 0,
): CapitalMovement => ({
  txHash: tx,
  blockNumber: block,
  logIndex,
  direction: k.endsWith("out") ? "out" : "in",
  amountRaw,
  counterparty: OWNER,
  classification: kind(k),
});

const capital = (movements: CapitalMovement[], complete = true): AccountCapital => ({
  account: ACCT,
  movements,
  totals: totalCapital(movements),
  complete,
  notes: [],
});

/** The two transfers the owner actually sent, at the blocks they actually landed in. */
const DEPOSITS = () => [move(TX1, 71_894_974, "4935223"), move(TX2, 71_908_795, "5937578")];

const agentRow = (over: Record<string, unknown> = {}) => ({
  smart_account: ACCT,
  owner_address: OWNER,
  epoch: 1,
  mode: "live",
  hwm_usdg: 10.872801,
  hwm_withdrawn_usdg: 0,
  contributions_known: 1,
  ...over,
});

function planFor(movements: CapitalMovement[], opts: { flows?: Record<string, unknown>[]; agent?: Record<string, unknown>; complete?: boolean; cash?: number } = {}) {
  const cap = capital(movements, opts.complete ?? true);
  const [plan] = planReconstruction({
    agents: [opts.agent ?? agentRow()],
    flows: opts.flows ?? [],
    equityByAccountEpoch: new Map([[`${ACCT.toLowerCase()}#1`, 10.872801]]),
    chain: new Map([[ACCT.toLowerCase(), cap]]),
    onchainCash: new Map([[ACCT.toLowerCase(), opts.cash ?? 10.872801]]),
  });
  return { plan: plan!, cap };
}

const decide = (
  movements: CapitalMovement[],
  over: Partial<Parameters<typeof decideAutoCapital>[0]> & { complete?: boolean; flows?: Record<string, unknown>[] } = {},
) => {
  const { plan, cap } = planFor(movements, { complete: over.complete, flows: over.flows });
  return decideAutoCapital({
    plan,
    cap,
    onchainCashRaw: 10_872_801n,
    vaults: [],
    head: HEAD,
    hwmGrossUsdg: 10.872801,
    hwmWithdrawnUsdg: 0,
    ...over,
  });
};

// ── the switch ──────────────────────────────────────────────────────────────

test("on by default, every ten minutes; off only for exactly '0'", () => {
  assert.deepEqual(
    { enabled: autoCapitalEnv({}).enabled, everyMs: autoCapitalEnv({}).everyMs },
    { enabled: true, everyMs: 600_000 },
  );
  assert.equal(autoCapitalEnv({ MERRYMEN_AUTO_CAPITAL: "0" }).enabled, false);
  assert.equal(autoCapitalEnv({ MERRYMEN_AUTO_CAPITAL: "false" }).enabled, true);
  assert.equal(autoCapitalEnv({ MERRYMEN_AUTO_CAPITAL_EVERY_SEC: "120" }).everyMs, 120_000);
  // Faster than a minute would put a chain scan on the fleet's RPC every pass.
  assert.equal(autoCapitalEnv({ MERRYMEN_AUTO_CAPITAL_EVERY_SEC: "5" }).everyMs, 600_000);
});

// ── who is worth a scan ─────────────────────────────────────────────────────

test("a funded account with nothing on record is a candidate; dust, traders and agreeing ledgers are not", () => {
  const base = { onchainCashRaw: 10_872_801n, evidencedNetRaw: 0n, unevidencedRows: 0, liveTrades: 0 };
  assert.equal(autoCapitalCandidate(base).candidate, true);
  assert.equal(autoCapitalCandidate({ ...base, onchainCashRaw: 999_999n }).candidate, false);
  assert.equal(autoCapitalCandidate({ ...base, liveTrades: 1 }).candidate, false);
  assert.equal(autoCapitalCandidate({ ...base, evidencedNetRaw: 10_872_801n }).candidate, false);
  // Agreeing totals are not enough while an inferred row sits beside them: that
  // row alone makes the anchor call contributions unknown.
  assert.equal(autoCapitalCandidate({ ...base, evidencedNetRaw: 10_872_801n, unevidencedRows: 1 }).candidate, true);
});

// ── what gets booked ────────────────────────────────────────────────────────

test("the 2026-09-25 account: two deposits, balance equal to their sum, peak already there — booked, peak untouched", () => {
  const d = decide(DEPOSITS());
  assert.equal(d.apply, true, d.why);
  assert.equal(d.depositsRaw, 10_872_801n);
  assert.equal(d.hwmGrossTarget, null);
});

test("a peak below the deposits is raised to meet them, so the first live tick cannot call them profit", () => {
  const d = decide(DEPOSITS(), { hwmGrossUsdg: 0 });
  assert.equal(d.apply, true, d.why);
  assert.equal(d.hwmGrossTarget, 10.872801);
});

test("anything but deposits is an operator's call, and stays refused until money moves again", () => {
  const cases: [string, CapitalMovement[]][] = [
    ["a withdrawal", [...DEPOSITS(), move("0x" + "c".repeat(64), 71_910_000, "1000000", "capital-out")]],
    ["a trade", [...DEPOSITS(), move("0x" + "d".repeat(64), 71_910_000, "1000000", "trade-out")]],
    ["a vault transfer", [...DEPOSITS(), move("0x" + "e".repeat(64), 71_910_000, "1000000", "internal")]],
    ["an unclassified movement", [...DEPOSITS(), move("0x" + "f".repeat(64), 71_910_000, "1000000", "ambiguous")]],
  ];
  for (const [label, movements] of cases) {
    const d = decide(movements);
    assert.equal(d.apply, false, label);
    assert.equal(d.retry, false, label);
  }
});

test("an account past its first accounting epoch is refused: its carry and its deposits would count twice", () => {
  const { plan, cap } = planFor(DEPOSITS(), { agent: agentRow({ epoch: 2 }) });
  const d = decideAutoCapital({
    plan,
    cap,
    onchainCashRaw: 10_872_801n,
    vaults: [],
    head: HEAD,
    hwmGrossUsdg: 10.872801,
    hwmWithdrawnUsdg: 0,
  });
  assert.equal(d.apply, false);
  assert.match(d.why, /epoch 2/);
});

test("a balance the deposits do not explain is refused", () => {
  const d = decide(DEPOSITS(), { onchainCashRaw: 10_000_000n });
  assert.equal(d.apply, false);
  assert.match(d.why, /not the sum of the deposits/);
});

const VAULT = "0x7d1a5ec0c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5";
const vault = (over: Partial<VaultFacts> = {}): VaultFacts => ({
  address: VAULT,
  cap: { ...capital([]), account: VAULT },
  deployed: false,
  cashRaw: 0n,
  ...over,
});

test("a class vault nobody ever used does not stand in the way", () => {
  assert.equal(decide(DEPOSITS(), { vaults: [vault()] }).apply, true);
});

test("a class vault is judged on its whole history, not its balance today", () => {
  // Paid into directly and spent on a token: no USDG left, but the owner's money went through it.
  const spent = [move("0x" + "b".repeat(64), 71_900_000, "5785344"), move("0x" + "b".repeat(63) + "c", 71_900_100, "5785344", "trade-out")];
  const history = decide(DEPOSITS(), { vaults: [vault({ cap: { ...capital(spent), account: VAULT } })] });
  assert.equal(history.apply, false);
  assert.match(history.why, /USDG movement/);
  const deployed = decide(DEPOSITS(), { vaults: [vault({ deployed: true })] });
  assert.equal(deployed.apply, false);
  assert.match(deployed.why, /deployed/);
  assert.equal(decide(DEPOSITS(), { vaults: [vault({ cashRaw: 1n })] }).apply, false);
  const unread = decide(DEPOSITS(), { vaults: [vault({ cap: { ...capital([], false), account: VAULT } })] });
  assert.equal(unread.apply, false);
  assert.equal(unread.retry, true);
});

test("a peak ABOVE every deposit is not touched and not explained away", () => {
  const d = decide(DEPOSITS(), { hwmGrossUsdg: 20 });
  assert.equal(d.apply, false);
  assert.match(d.why, /above every dollar ever deposited/);
});

test("an incomplete scan and a deposit still settling are retried, not remembered", () => {
  const partial = decide(DEPOSITS(), { complete: false });
  assert.equal(partial.apply, false);
  assert.equal(partial.retry, true);

  const young = decide(DEPOSITS(), { head: 71_908_795n + AUTO_CAPITAL_MIN_AGE_BLOCKS - 1n });
  assert.equal(young.apply, false);
  assert.equal(young.retry, true);
  assert.equal(decide(DEPOSITS(), { head: 71_908_795n + AUTO_CAPITAL_MIN_AGE_BLOCKS }).apply, true);
});

test("deposits the ledger already holds as receipts are left alone", () => {
  const flows = [
    { id: 1, agent_id: ACCT, epoch: 1, direction: "in", amount_usdg: 4.935223, source: "chain-log", tx_hash: TX1 },
    { id: 2, agent_id: ACCT, epoch: 1, direction: "in", amount_usdg: 5.937578, source: "chain-log", tx_hash: TX2 },
  ];
  const d = decide(DEPOSITS(), { flows });
  assert.equal(d.apply, false);
  assert.match(d.why, /already records/);
});

// ── the anchor the restarted child reads ────────────────────────────────────

test("the verified balance stands in for a stale equity row, and only until the child writes a newer one", () => {
  const established: TenantBootstrapState["accounting"] = {
    kind: "established",
    highWaterMarkUsdg: "10872801",
    netContributionsUsdg: "10872801",
    anchoredContributionsUsdg: "10872801",
    unanchoredFlowCount: 0,
    lastObservedCashUsdg: "0",
    accountingEpoch: 1,
    observedAt: 1_000,
  };
  const verified = { cashRaw: 10_872_801n, atSec: 2_000 };
  const over = withVerifiedCash(established, verified, 1_500);
  assert.equal(over.kind === "established" && over.lastObservedCashUsdg, "10872801");
  assert.equal(withVerifiedCash(established, verified, 2_001), established);
  // Same second: the dying child's last row, not an observation by the new one.
  const sameSecond = withVerifiedCash(established, verified, 2_000);
  assert.equal(sameSecond.kind === "established" && sameSecond.lastObservedCashUsdg, "10872801");
  assert.equal(withVerifiedCash(established, undefined, null), established);
  const unknown: TenantBootstrapState["accounting"] = { kind: "unknown", why: "x", observedAt: 1 };
  assert.equal(withVerifiedCash(unknown, verified, null), unknown);
});

// ── end to end, on a real ledger ────────────────────────────────────────────

async function freshDb(): Promise<Db> {
  const db = wrapSqlite(new DatabaseSync(":memory:"));
  await applyLedgerSchema(db);
  return db;
}

async function seedAgent(db: Db, hwm: number) {
  await db
    .prepare(
      `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at)
       VALUES (?, ?, ?, ?, '{}', 0, 0)`,
    )
    .run(ACCT, OWNER, OWNER, CHAIN);
  await db.prepare("UPDATE agents SET hwm_usdg = ?, mode = 'live', contributions_known = 1 WHERE smart_account = ?").run(hwm, ACCT);
  // The paper history that made the ledger "established" without a single flow.
  for (let i = 0; i < 3; i++) {
    await db
      .prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status) VALUES (?, 'swap', 'INU', 5, 'paper')")
      .run(ACCT);
  }
  await db
    .prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, at) VALUES (?, '0', 0, 0, 0, 100)")
    .run(ACCT);
}

/**
 * A node: a head that can move between reads, and a balance that can change
 * after the first read of it — the two ways money moves while a pass judges.
 */
function fakeRpc(
  balances: Record<string, bigint>,
  chain: { heads?: bigint[]; balanceAfterFirst?: bigint; code?: Record<string, string> } = {},
) {
  let headReads = 0;
  const balanceReads = new Map<string, number>();
  return async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === "eth_blockNumber") {
      const heads = chain.heads ?? [HEAD];
      return "0x" + heads[Math.min(headReads++, heads.length - 1)]!.toString(16);
    }
    if (method === "eth_call") {
      const data = (params[0] as { data: string }).data;
      const holder = ("0x" + data.slice(-40)).toLowerCase();
      const n = balanceReads.get(holder) ?? 0;
      balanceReads.set(holder, n + 1);
      const value = n > 0 && chain.balanceAfterFirst !== undefined ? chain.balanceAfterFirst : (balances[holder] ?? 0n);
      return "0x" + value.toString(16);
    }
    if (method === "eth_getCode") return chain.code?.[String(params[0]).toLowerCase()] ?? "0x";
    throw new Error(`unexpected rpc ${method}`);
  };
}

/** A scan that honours the block range, as the node does: movements outside it are not returned. */
function scanOf(cap: AccountCapital, others: Record<string, AccountCapital> = {}) {
  const calls: string[][] = [];
  const known: (readonly string[] | undefined)[] = [];
  const scan = async (
    _rpc: unknown,
    args: { accounts: readonly string[]; knownAccounts?: readonly string[]; fromBlock: bigint; toBlock: bigint },
  ) => {
    calls.push([...args.accounts]);
    known.push(args.knownAccounts);
    const inRange = (c: AccountCapital): AccountCapital => {
      const movements = c.movements.filter(
        (m) => BigInt(m.blockNumber) >= args.fromBlock && BigInt(m.blockNumber) <= args.toBlock,
      );
      return { ...c, movements, totals: totalCapital(movements) };
    };
    return new Map(
      args.accounts.map((a) => {
        const k = a.toLowerCase();
        const c = k === ACCT.toLowerCase() ? cap : (others[k] ?? { ...capital([]), account: a });
        return [k, inRange(c)] as const;
      }),
    );
  };
  return { scan: scan as never, calls, known };
}

const pass = (
  db: Db,
  cap: AccountCapital,
  refused = new Map<string, bigint>(),
  balance = 10_872_801n,
  chain: { heads?: bigint[]; balanceAfterFirst?: bigint; code?: Record<string, string> } = {},
  custody: { vaults?: string[]; vaultCaps?: Record<string, AccountCapital> } = {},
) => {
  const s = scanOf(cap, custody.vaultCaps);
  const lines: string[] = [];
  return {
    ...s,
    lines,
    run: () =>
      runAutoCapitalPass({
        db,
        rpc: fakeRpc({ [ACCT.toLowerCase()]: balance }, chain),
        usdgToken: USDG,
        chainId: CHAIN,
        tenants: [{ tenant: TENANT, smartAccount: ACCT, vaults: custody.vaults ?? [] }],
        refused,
        log: (m) => lines.push(m),
        scan: s.scan,
        nowSec: () => 5_000,
      }),
  };};

test("end to end: the unbooked deposits become receipts, and the child would resume with contributions known", async () => {
  const db = await freshDb();
  await seedAgent(db, 10.872801);

  // BEFORE: the anchor a child gets today — established, zero contributions,
  // and "known", because no rows is read as a proven zero.
  const before = await deriveBootstrapAccounting(db, ACCT, 6_000);
  assert.equal(before.kind === "established" && before.netContributionsUsdg, "0");

  const p = pass(db, capital(DEPOSITS()));
  const booked = await p.run();
  assert.equal(booked.length, 1, p.lines.join("\n"));
  assert.equal(booked[0]!.tenant, TENANT);
  assert.equal(booked[0]!.cashRaw, 10_872_801n);

  const rows = (await db
    .prepare("SELECT source, direction, amount_usdg, tx_hash FROM flows WHERE agent_id = ? ORDER BY block_number")
    .all(ACCT)) as { source: string; direction: string; amount_usdg: number; tx_hash: string }[];
  assert.deepEqual(
    rows.map((r) => [r.source, r.direction, r.amount_usdg, r.tx_hash]),
    [
      ["chain-log", "in", 4.935223, TX1],
      ["chain-log", "in", 5.937578, TX2],
    ],
  );
  const agent = (await db.prepare("SELECT hwm_usdg, contributions_known FROM agents WHERE smart_account = ?").get(ACCT)) as {
    hwm_usdg: number;
    contributions_known: number;
  };
  assert.equal(agent.hwm_usdg, 10.872801, "the peak already held the deposits and is not moved");
  assert.equal(agent.contributions_known, 1);
  const events = (await db.prepare("SELECT message FROM events WHERE agent_id = ?").all(ACCT)) as { message: string }[];
  assert.ok(events.some((e) => e.message.includes("10.872801 USDG")), "the owner is told, in the agent's own log");

  // AFTER: what the restarted child arms against, with the balance this pass
  // verified standing in for the pre-deposit equity row.
  const derived = await deriveBootstrapAccounting(db, ACCT, 6_000);
  const anchor = withVerifiedCash(derived, { cashRaw: booked[0]!.cashRaw, atSec: 5_000 }, 100);
  assert.equal(anchor.kind, "established");
  const state: TenantBootstrapState = { schemaVersion: 1, tenantId: ACCT.toLowerCase(), generatedAt: 6_000, accounting: anchor };
  const licence = accountingLicence({ kind: "valid", state, accounting: anchor }, { hosted: true });
  assert.equal(licence.licence, "resume");
  assert.equal(licence.contributionsKnown, true, licence.why);
  assert.equal(licence.netContributionsUsdg, 10_872_801n);
  const first = planFirstObservation({
    licence: licence.licence,
    equityUsdg: 10_872_801n,
    cashUsdg: 10_872_801n,
    anchorCashUsdg: licence.lastObservedCashUsdg,
    materialDriftUsdg: 10_000n,
  });
  assert.deepEqual(first, { action: "resume-clean" });

  // AND AGAIN: a second pass finds nothing to do and scans nothing.
  const again = pass(db, capital(DEPOSITS()));
  assert.deepEqual(await again.run(), []);
  assert.equal(again.calls.length, 0);
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM flows WHERE agent_id = ?").get(ACCT)) as { n: number };
  assert.equal(Number(count.n), 2, "nothing is booked twice");
});

test("end to end: a peak the deposits never reached is raised with them", async () => {
  const db = await freshDb();
  await seedAgent(db, 0);
  const booked = await pass(db, capital(DEPOSITS())).run();
  assert.equal(booked.length, 1);
  const agent = (await db.prepare("SELECT hwm_usdg FROM agents WHERE smart_account = ?").get(ACCT)) as { hwm_usdg: number };
  assert.equal(agent.hwm_usdg, 10.872801);
});

test("end to end: an inferred row for the same money is quarantined, never added to", async () => {
  const db = await freshDb();
  await seedAgent(db, 10.872801);
  await db
    .prepare("INSERT INTO flows (agent_id, direction, amount_usdg, source, epoch, at) VALUES (?, 'in', 10.872801, 'inferred', 1, 0)")
    .run(ACCT);
  const booked = await pass(db, capital(DEPOSITS())).run();
  assert.equal(booked.length, 1);
  const net = (await db
    .prepare("SELECT SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END) AS net FROM flows WHERE agent_id = ?")
    .get(ACCT)) as { net: number };
  assert.equal(Math.round(net.net * 1e6), 10_872_801);
  const moved = (await db.prepare("SELECT COUNT(*) AS n FROM flows_quarantine").get()) as { n: number };
  assert.equal(Number(moved.n), 1);
});

test("end to end: a refused account is not rescanned until its balance moves", async () => {
  const db = await freshDb();
  await seedAgent(db, 10.872801);
  const refused = new Map<string, bigint>();
  const withdrawal = capital([...DEPOSITS(), move("0x" + "c".repeat(64), 71_910_000, "1000000", "capital-out")]);

  const first = pass(db, withdrawal, refused, 9_872_801n);
  assert.deepEqual(await first.run(), []);
  assert.equal(first.calls.length, 1);
  assert.equal(refused.get(ACCT.toLowerCase()), 9_872_801n);

  const second = pass(db, withdrawal, refused, 9_872_801n);
  await second.run();
  assert.equal(second.calls.length, 0, "same balance, same answer — no scan");

  const third = pass(db, withdrawal, refused, 20_000_000n);
  await third.run();
  assert.equal(third.calls.length, 1, "the balance moved, so it is looked at again");
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM flows").get()) as { n: number };
  assert.equal(Number(count.n), 0, "nothing was written for an account with a withdrawal");
});

test("end to end: the scan classifies against every hosted account, not only the one being judged", async () => {
  const db = await freshDb();
  await seedAgent(db, 10.872801);
  const OTHER = "0x75cD5d5c395f271df7a1D5A1Aecb637f29C59148";
  await db
    .prepare(
      `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at)
       VALUES (?, ?, ?, ?, '{}', 0, 0)`,
    )
    .run(OTHER, OTHER, OTHER, CHAIN);
  const p = pass(db, capital(DEPOSITS()));
  await p.run();
  assert.deepEqual(p.calls, [[ACCT]], "only the candidate is scanned");
  assert.ok(p.known[0]?.includes(OTHER.toLowerCase()), "but a transfer from any hosted account reads as internal");
  assert.ok(p.known[0]?.includes(ACCT.toLowerCase()));
});

test("end to end: a booking the owner's note could not follow is still reported, so the child is restarted", async () => {
  const db = await freshDb();
  await seedAgent(db, 10.872801);
  await db.exec("DROP TABLE events");
  const p = pass(db, capital(DEPOSITS()));
  const booked = await p.run();
  assert.equal(booked.length, 1, p.lines.join("\n"));
  assert.ok(p.lines.some((l) => l.includes("owner's note was not written")));
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM flows WHERE agent_id = ?").get(ACCT)) as { n: number };
  assert.equal(Number(count.n), 2);
});

test("end to end: an account that has traded live is never scanned", async () => {
  const db = await freshDb();
  await seedAgent(db, 10.872801);
  await db
    .prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status) VALUES (?, 'swap', 'INU', 5, 'landed')")
    .run(ACCT);
  const p = pass(db, capital(DEPOSITS()));
  assert.deepEqual(await p.run(), []);
  assert.equal(p.calls.length, 0);
});

test("end to end: money that moves after the history scan stops the booking, and is judged again next pass", async () => {
  const db = await freshDb();
  await seedAgent(db, 10.872801);
  const refused = new Map<string, bigint>();
  // A withdrawal mined after the scanned head: invisible to the history scan,
  // and the balance read before it still equals the deposits.
  const late = move("0x" + "a".repeat(64), Number(HEAD) + 50, "1000000", "capital-out");
  const p = pass(db, capital([...DEPOSITS(), late]), refused, 10_872_801n, { heads: [HEAD, HEAD + 100n] });
  assert.deepEqual(await p.run(), []);
  assert.deepEqual(p.calls, [[ACCT], [ACCT]], "the history, then the window since it");
  assert.ok(p.lines.some((l) => l.includes("1 USDG movement(s) since block")), p.lines.join("\n"));
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM flows").get()) as { n: number };
  assert.equal(Number(count.n), 0);
  assert.equal(refused.size, 0, "not remembered as refused — the new state gets its own judgement");
});

test("end to end: a balance that changes while the account is judged stops the booking", async () => {
  const db = await freshDb();
  await seedAgent(db, 10.872801);
  const p = pass(db, capital(DEPOSITS()), new Map(), 10_872_801n, { balanceAfterFirst: 5_000_000n });
  assert.deepEqual(await p.run(), []);
  assert.ok(p.lines.some((l) => l.includes("the balance moved")), p.lines.join("\n"));
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM flows").get()) as { n: number };
  assert.equal(Number(count.n), 0);
});

test("end to end: the vault is scanned with the account, and an untouched one does not block the booking", async () => {
  const db = await freshDb();
  await seedAgent(db, 10.872801);
  const p = pass(db, capital(DEPOSITS()), new Map(), 10_872_801n, {}, { vaults: [VAULT] });
  assert.equal((await p.run()).length, 1, p.lines.join("\n"));
  assert.deepEqual(p.calls[0], [ACCT, VAULT], "the vault's own history is read");
});

test("end to end: a vault the owner paid into and spent from blocks the booking", async () => {
  const db = await freshDb();
  await seedAgent(db, 10.872801);
  const spent = [move("0x" + "b".repeat(64), 71_900_000, "5785344"), move("0x" + "b".repeat(63) + "c", 71_900_100, "5785344", "trade-out")];
  const p = pass(db, capital(DEPOSITS()), new Map(), 10_872_801n, {}, {
    vaults: [VAULT],
    vaultCaps: { [VAULT.toLowerCase()]: { ...capital(spent), account: VAULT } },
  });
  assert.deepEqual(await p.run(), []);
  assert.ok(p.lines.some((l) => l.includes("USDG movement(s) — an operator's call")), p.lines.join("\n"));
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM flows").get()) as { n: number };
  assert.equal(Number(count.n), 0);
});

test("end to end: a deployed vault blocks the booking", async () => {
  const db = await freshDb();
  await seedAgent(db, 10.872801);
  const p = pass(db, capital(DEPOSITS()), new Map(), 10_872_801n, { code: { [VAULT.toLowerCase()]: "0x6080" } }, { vaults: [VAULT] });
  assert.deepEqual(await p.run(), []);
  assert.ok(p.lines.some((l) => l.includes("has been deployed")), p.lines.join("\n"));
});

// ── the wiring ──────────────────────────────────────────────────────────────

test("the orchestrator runs the pass in its loop, restarts what it booked, and hands the child the verified balance", () => {
  const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  const between = (a: string, b: string) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
  const has = (hay: string, needle: string, why?: string) => assert.ok(hay.includes(needle), why ?? needle);
  has(between("export async function runOrchestrator", "// Run when invoked directly"), "startAutoCapitalPass();");
  has(between("async function writeBootstrapForChild", "async function spawnChild"), "withVerifiedCash(accounting, verified, newestAt)");
  const pass = between("async function runAutoCapital()", "function restartForNewAnchor");
  has(pass, "leases.get(tenant)", "only tenants this replica holds");
  has(pass, "verifiedCash.set(");
  has(pass, "restartForNewAnchor(b.tenant");
});
