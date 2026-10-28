/**
 * get_attention on SQLite with the full ledger schema, through runTool: each
 * condition lands at the severity SEVERITY_MEANING promises, keys hold still
 * while a condition does and change when its severity rises, seen_keys marks
 * what is new and what resolved (and never "resolves" what it did not look
 * at), proposals and alert deliveries appear only under their scopes, no
 * signed limit is offered as a fix, another owner's agents never leak, and
 * the read changes nothing.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getAddress } from "viem";
import { ATTENTION_EVENTS_MAX, conditionOfKey, runStart } from "@/lib/services/attention";
import { settingsArmRefusal } from "../../../../worker/src/settings";
import { FLEET_RECOVERY_SCHEMA } from "../../../../worker/src/fleet-recovery";
import { MAX_OPEN_PROPOSALS, proposalRow } from "@/lib/services/proposals";
import type { AgentDirectory, OwnedAgent } from "../agents";
import type { Principal } from "../oauth/server";
import { resetMetricsForTest } from "../observe";
import { ACCOUNT_A, ACCOUNT_B, OWNER_A, OWNER_B, SLUG_A, SLUG_B, agentFixture, connectAs, errorOf, installFixtures, makeDeps, makeTestDb, type TestDb } from "../testing";
import { toolInProfile } from "../server";
import { runTool, type ToolDef } from "../tool";
import { ATTENTION_TOOLS } from "./attention";
import { PROPOSAL_TOOLS } from "./proposals";

// Links are fixed pages on the configured app address.
process.env.MERRYMEN_PUBLIC_ORIGIN = "https://app.test";

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; resetMetricsForTest(); });
/** Tear down one setup() before the next inside a test. */
const reset = () => { restore?.(); restore = null; };

const NOW = 1_800_000_000;
const HOUR = 3600;
const DAY = 86_400;
const BREAKER = "on-chain drawdown breaker TRIPPED: equity is below the signed floor";

const attention = ATTENTION_TOOLS.find((t) => t.name === "get_attention") as unknown as ToolDef;
const draftPost = PROPOSAL_TOOLS.find((t) => t.name === "draft_post") as unknown as ToolDef;

interface Item { key: string; severity: string; kind: string; agent: string | null; title: string; detail: string; owner_can_fix: boolean; what_to_do: string | null; link: string | null; started_at: string | null; ends_at: string | null; new: boolean }
interface Answer { items: Item[]; counts: Record<string, number>; new_counts: Record<string, number>; resolved_keys: string[]; agents_checked: string[]; not_checked: Array<{ part: string; why: string; scope: string | null }> }

async function setup(o: { agentA?: Partial<OwnedAgent>; scopes?: string[] } = {}) {
  const d = await makeTestDb();
  grantExpiry.clear();
  grantExpiry.set(o.agentA?.account ?? ACCOUNT_A, o.agentA?.expiresAt !== undefined ? o.agentA.expiresAt : 4102444800);
  grantExpiry.set(ACCOUNT_B, NOW - HOUR);
  const directory: AgentDirectory = {
    async agentsFor(t) {
      const map: Record<string, OwnedAgent[]> = {
        [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A, o.agentA)],
        [OWNER_B]: [agentFixture(SLUG_B, ACCOUNT_B, { expiresAt: NOW - HOUR })],
      };
      return map[t.toLowerCase()] ?? [];
    },
  };
  const deps = makeDeps(d, { agents: directory });
  restore = installFixtures(d, { directory, settings: { [OWNER_A]: { tickSeconds: 240 }, [OWNER_B]: { tickSeconds: 240 } } });
  const a = await connectAs(deps, OWNER_A, o.scopes ? { scopes: o.scopes } : {});
  const b = await connectAs(deps, OWNER_B);
  const directory_ = () => connectAs(deps, OWNER_A, { profile: "directory", scopes: ["agents:read", "notifications:manage"] });
  const ask = async (args: Record<string, unknown> = {}, p: Principal = a.principal, at = NOW) => {
    const r = await runTool(attention, args, p, "trace-test", { now: () => at });
    assert.equal(r.isError, undefined, r.content[0]?.text);
    return r.structuredContent as unknown as Answer;
  };
  return { d, pa: a.principal, pb: b.principal, ask, directory: directory_ };
}

/** The expiry each account's stored grant has in the current setup(): a worker that adopted it writes the same into its row. */
const grantExpiry = new Map<string, number | null>();

function agentRow(d: TestDb, account: string, o: { status?: string; mode?: string; beat?: number | null; blocker?: string | null; expires?: number } = {}) {
  d.raw.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, mode, beat_at, live_blocker, sponsor_gas, epoch)
    VALUES (?, 'Alan', ?, '0x1', 4663, '{}', 1700000000, ?, ?, ?, ?, ?, 0, 1)`)
    .run(account, account === ACCOUNT_A ? OWNER_A : OWNER_B, o.expires ?? grantExpiry.get(account) ?? 4102444800, o.status ?? "armed", o.mode ?? "live", o.beat === undefined ? NOW - 30 : o.beat, o.blocker ?? null);
}

function event(d: TestDb, account: string, message: string, at: number, level = "warn") {
  d.raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, ?, ?, ?)").run(account, level, message, at);
}

function refused(d: TestDb, account: string, rule: string, at: number) {
  d.raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, reject_rule, created_at) VALUES (?, 'swap', 'router', 10, 'rejected', ?, ?)`).run(account, rule, at);
}

const only = (r: Answer, kind: string) => {
  const hits = r.items.filter((i) => i.kind === kind);
  assert.equal(hits.length, 1, `one ${kind} item in ${JSON.stringify(r.items.map((i) => i.key))}`);
  return hits[0]!;
};

test("a healthy agent needs nothing, and the parts this connection cannot see are named rather than passed as fine", async () => {
  const { d, ask } = await setup();
  agentRow(d, ACCOUNT_A);
  const r = await ask();
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.counts, { act_now: 0, today: 0, fyi: 0 });
  assert.deepEqual(r.agents_checked, [SLUG_A]);
  assert.deepEqual(r.not_checked.map((n) => [n.part, n.scope]), [
    ["trade proposals", "trade:propose"], ["settings proposals and agent setup drafts", "drafts:write"], ["post drafts", "social:write"], ["alert deliveries", "notifications:manage"],
  ]);
});

test("permission expiry rises through fyi, today and act_now, each a new key, and an old expiry quietens to fyi", async () => {
  const cases: Array<[number, string | null, string]> = [
    [30 * DAY, null, ""],
    [5 * DAY, "fyi", "-7d"],
    [2 * DAY, "today", "-72h"],
    [9 * HOUR, "act_now", "-24h"],
  ];
  for (const [left, severity, tag] of cases) {
    const { d, ask } = await setup({ agentA: { expiresAt: NOW + left } });
    agentRow(d, ACCOUNT_A);
    const r = await ask();
    const items = r.items.filter((i) => i.kind === "permission-expiring");
    if (severity === null) { assert.deepEqual(items, []); restore?.(); restore = null; continue; }
    assert.equal(items.length, 1);
    assert.equal(items[0]!.severity, severity, `${left}s left`);
    assert.equal(items[0]!.key, `permission-expiring:${SLUG_A}:${NOW + left}${tag}`);
    assert.equal(items[0]!.link, "https://app.test/grant");
    assert.equal(items[0]!.ends_at, new Date((NOW + left) * 1000).toISOString());
    restore?.(); restore = null;
  }
  {
    const { d, ask } = await setup({ agentA: { expiresAt: NOW - HOUR } });
    agentRow(d, ACCOUNT_A, { status: "expired" });
    const item = only(await ask(), "permission-expired");
    assert.equal(item.severity, "act_now");
    assert.equal(item.started_at, new Date((NOW - HOUR) * 1000).toISOString());
    restore?.(); restore = null;
  }
  const { d, ask } = await setup({ agentA: { expiresAt: NOW - 10 * DAY } });
  agentRow(d, ACCOUNT_A, { status: "expired" });
  const old = only(await ask(), "permission-expired");
  assert.equal(old.severity, "fyi", "an agent stopped for ten days is not act-now news");
  assert.match(old.key, /-old$/);
});

test("after the permission expires, the row's last blocker and the last minutes' breaker, provider and cap signals are not news: the expired item is", async () => {
  const { d, ask } = await setup({ agentA: { expiresAt: NOW - 10 * 60 } });
  agentRow(d, ACCOUNT_A, { status: "expired", blocker: "no-gas", beat: NOW - 11 * 60 });
  for (let at = NOW - 40 * 60; at <= NOW - 11 * 60; at += 240) {
    event(d, ACCOUNT_A, BREAKER, at);
    event(d, ACCOUNT_A, "strategist driver failed: 400", at + 1);
  }
  refused(d, ACCOUNT_A, "daily-cap", NOW - 12 * 60);
  assert.deepEqual((await ask()).items.map((i) => i.kind), ["permission-expired"]);
});

test("live blockers: funding and re-signing are act_now with the page that fixes them; a deliberate state is nothing; Merrymen's own fault is today with no chore", async () => {
  const { d, ask } = await setup();
  agentRow(d, ACCOUNT_A, { blocker: "no-gas" });
  let item = only(await ask(), "live-blocker");
  assert.equal(item.severity, "act_now");
  assert.equal(item.link, "https://app.test/deposit");
  assert.equal(item.owner_can_fix, true);
  assert.match(item.what_to_do ?? "", /ETH/);

  d.raw.prepare("UPDATE agents SET live_blocker = 'dead-policy'").run();
  item = only(await ask(), "live-blocker");
  assert.equal(item.severity, "act_now");
  assert.equal(item.link, "https://app.test/grant");

  d.raw.prepare("UPDATE agents SET live_blocker = 'live-not-enabled'").run();
  assert.deepEqual((await ask()).items, [], "live trading switched off is the owner's choice, not a fault");

  d.raw.prepare("UPDATE agents SET live_blocker = 'no-executor'").run();
  item = only(await ask(), "live-blocker");
  assert.equal(item.severity, "today");
  assert.equal(item.owner_can_fix, false);
  assert.equal(item.what_to_do, null);
});

test("a breaker the worker restates every tick is one act_now item from the start of the run, with no limit offered as a fix", async () => {
  const { d, ask } = await setup();
  agentRow(d, ACCOUNT_A);
  event(d, ACCOUNT_A, BREAKER, NOW - 20 * HOUR); // an earlier, separate trip
  for (let at = NOW - 2 * HOUR; at <= NOW - 60; at += 240) event(d, ACCOUNT_A, BREAKER, at);
  const item = only(await ask(), "breaker");
  assert.equal(item.severity, "act_now");
  assert.equal(item.started_at, new Date((NOW - 2 * HOUR) * 1000).toISOString());
  assert.equal(item.key, `breaker:${SLUG_A}:on`);
  assert.equal(item.what_to_do, null);
  assert.equal(item.owner_can_fix, false);
  assert.doesNotMatch(item.detail, /raise|lower|increase|re-sign/i);
  // An hour after the last sighting it has recovered.
  assert.deepEqual((await ask({}, undefined, NOW + HOUR)).items.filter((i) => i.kind === "breaker"), []);
});

test("a breaker tripped longer than the lookback keeps its key when its start falls out of the window: not new, not resolved", async () => {
  const { d, ask } = await setup();
  agentRow(d, ACCOUNT_A);
  for (let at = NOW - 20 * HOUR; at <= NOW + 4 * HOUR; at += 240) event(d, ACCOUNT_A, BREAKER, at);
  const before = only(await ask(), "breaker");
  assert.equal(before.started_at, new Date((NOW - 20 * HOUR) * 1000).toISOString());
  const later = await ask({ seen_keys: [before.key] }, undefined, NOW + 4 * HOUR + 60);
  const after = only(later, "breaker");
  assert.equal(after.started_at, null, "the first sighting is now older than the window");
  assert.equal(after.key, before.key);
  assert.equal(after.new, false);
  assert.deepEqual(later.resolved_keys, []);
});

test("an agent stopped on purpose (kill switch, or a discarded permission) is fyi, never 'no permission signed yet' or a stale worker", async () => {
  {
    const { d, ask } = await setup({ agentA: { account: null, accounts: [ACCOUNT_A], expiresAt: null } });
    agentRow(d, ACCOUNT_A, { status: "killed", beat: NOW - 3 * DAY });
    const r = await ask();
    assert.deepEqual(r.items.map((i) => [i.kind, i.severity]), [["killed", "fyi"]]);
    restore?.(); restore = null;
  }
  const { d, ask } = await setup({ agentA: { account: null, accounts: [ACCOUNT_A], expiresAt: null } });
  agentRow(d, ACCOUNT_A, { status: "armed", beat: NOW - 3 * DAY });
  const r = await ask();
  assert.deepEqual(r.items.map((i) => [i.key, i.severity]), [[`no-permission:${SLUG_A}:removed`, "fyi"]]);
  assert.match(r.items[0]!.title, /No trading permission is active/);
});

test("a worker that never reported once (an armed row with no heartbeat, or no row at all) is stale after the start-up grace", async () => {
  {
    const { d, ask } = await setup();
    agentRow(d, ACCOUNT_A, { beat: null });
    const item = only(await ask(), "worker-stale");
    assert.equal(item.key, `worker-stale:${SLUG_A}:since-1700000000`);
    assert.equal(item.severity, "today");
    assert.match(item.title, /never reported/);
    reset();
  }
  {
    const { ask } = await setup();
    assert.equal(only(await ask(), "worker-stale").key, `worker-stale:${SLUG_A}:since-1700000000`, "a signed permission whose ledger row was never written");
    reset();
  }
  const { d, ask } = await setup({ agentA: { grantedAt: NOW - 120 } });
  agentRow(d, ACCOUNT_A, { beat: null });
  assert.deepEqual((await ask()).items, [], "two minutes after signing is still start-up");
});

test("a permission renewed on the same account after a kill or an expiry is pending: the old row's status is not the agent's state", async () => {
  for (const old of ["killed", "expired", "error"]) {
    const { d, ask } = await setup({ agentA: { grantedAt: NOW - 2 * HOUR } });
    agentRow(d, ACCOUNT_A, { status: old, beat: NOW - 3 * HOUR, blocker: "dead-policy" });
    event(d, ACCOUNT_A, "KILL SWITCH — grant discarded, session key destroyed; trading halted", NOW - 3 * HOUR, "err");
    const r = await ask();
    assert.deepEqual(r.items.map((i) => i.key), [`worker-stale:${SLUG_A}:since-${NOW - 2 * HOUR}`], `${old}: only the unreported renewal`);
    assert.match(r.items[0]!.title, /not picked up the new permission/);
    reset();
  }
  const { d, ask } = await setup({ agentA: { grantedAt: NOW - 300 } });
  agentRow(d, ACCOUNT_A, { status: "killed", beat: NOW - 3 * HOUR });
  assert.deepEqual((await ask()).items, [], "five minutes after renewing is still start-up, and the old kill is not reported");
});

test("a renewal the old worker never took up is pending even while that worker keeps beating; once its row carries the new permission it is adopted", async () => {
  const { d, ask } = await setup({ agentA: { grantedAt: NOW - 2 * HOUR, expiresAt: NOW + 30 * DAY } });
  // The old worker: fresh heartbeat, its previous permission's expiry and blocker.
  agentRow(d, ACCOUNT_A, { status: "armed", beat: NOW - 30, expires: NOW + 2 * DAY, blocker: "dead-policy" });
  const r = await ask();
  assert.deepEqual(r.items.map((i) => i.key), [`worker-stale:${SLUG_A}:since-${NOW - 2 * HOUR}`]);
  assert.match(r.items[0]!.detail, /reports are for the previous permission/);

  d.raw.prepare("UPDATE agents SET expires_at = ?, live_blocker = NULL").run(NOW + 30 * DAY);
  assert.deepEqual((await ask()).items, [], "the row now carries the renewed permission: adopted and healthy");
});

test("a permission that failed to arm is an arm error at once, not a worker that never reported, however long ago the one failure event was written", async () => {
  for (const [label, grantedAt, beat] of [["first grant", NOW - 300, null], ["renewal", NOW - 2 * HOUR, NOW - 3 * HOUR], ["three days of the same failure", NOW - 3 * DAY, null]] as const) {
    const { d, ask } = await setup({ agentA: { grantedAt } });
    agentRow(d, ACCOUNT_A, { status: "error", beat });
    event(d, ACCOUNT_A, "this agent CANNOT START and is not trading: no bundler", grantedAt + 60, "err");
    const r = await ask();
    assert.deepEqual(r.items.map((i) => i.key), [`arm-error:${SLUG_A}:on`], label);
    assert.equal(r.items[0]!.started_at, new Date((grantedAt + 60) * 1000).toISOString(), label);
    reset();
  }
  // The settings refusal is the worker's other arm failure, in its own words.
  const refusal = settingsArmRefusal({ why: "settings.json is not valid JSON", since: 0, holding: false }, true);
  assert.ok(refusal);
  const { d, ask } = await setup({ agentA: { grantedAt: NOW - HOUR } });
  agentRow(d, ACCOUNT_A, { status: "error", beat: null });
  event(d, ACCOUNT_A, refusal, NOW - HOUR + 30, "err");
  assert.deepEqual((await ask()).items.map((i) => i.key), [`arm-error:${SLUG_A}:on`]);
});

test("an arm error after a restart does not bring back the row's last blocker", async () => {
  const { d, ask } = await setup();
  agentRow(d, ACCOUNT_A, { status: "error", blocker: "no-gas" });
  assert.deepEqual((await ask()).items.map((i) => i.kind), ["arm-error"]);
});

test("events and refusals stored under the checksummed spelling are read too (the IN list is every spelling, so the index serves it); a retired account's are history", async () => {
  const current = "0x52908400098527886e0f7030069857d2e4169ee7" as const; // EIP-55's own mixed-case example
  const { d, ask } = await setup({ agentA: { account: current, accounts: [current, ACCOUNT_A] } });
  agentRow(d, current);
  const checksummed = getAddress(current);
  assert.equal(checksummed, "0x52908400098527886E0F7030069857D2E4169EE7");
  for (let at = NOW - HOUR; at <= NOW - 60; at += 240) event(d, checksummed, BREAKER, at);
  refused(d, checksummed, "daily-cap", NOW - 600);
  const r = await ask();
  assert.equal(only(r, "breaker").severity, "act_now");
  assert.equal(only(r, "daily-cap").severity, "fyi");

  // The same signals from the account the agent held before a start-over do not describe it now.
  d.raw.prepare("DELETE FROM events").run();
  d.raw.prepare("DELETE FROM trades").run();
  for (let at = NOW - HOUR; at <= NOW - 60; at += 240) event(d, ACCOUNT_A, BREAKER, at);
  refused(d, ACCOUNT_A, "daily-cap", NOW - 600);
  assert.deepEqual((await ask()).items, []);
});

test("two providers failing at once are two open items, and neither resolves while it is still failing", async () => {
  const { d, ask } = await setup();
  agentRow(d, ACCOUNT_A);
  for (let at = NOW - 20 * 60; at <= NOW - 600; at += 240) event(d, ACCOUNT_A, "the market could not be read this tick: rpc timeout", at);
  for (let at = NOW - 10 * 60; at <= NOW - 60; at += 240) event(d, ACCOUNT_A, "strategist driver failed: 400", at);
  const r = await ask({ seen_keys: [`provider-failure:${SLUG_A}:market`] });
  assert.deepEqual(r.items.filter((i) => i.kind === "provider-failure").map((i) => [i.key, i.new]), [
    [`provider-failure:${SLUG_A}:model`, true],
    [`provider-failure:${SLUG_A}:market`, false],
  ]);
  assert.deepEqual(r.resolved_keys, []);
});

test("kill switch, a stale worker, a provider failure and reached caps are named at their severities", async () => {
  const { d, ask } = await setup();
  agentRow(d, ACCOUNT_A, { status: "killed" });
  event(d, ACCOUNT_A, "KILL SWITCH — grant discarded, session key destroyed; trading halted", NOW - 3 * HOUR, "err");
  let item = only(await ask(), "killed");
  assert.equal(item.severity, "fyi");
  assert.equal(item.started_at, new Date((NOW - 3 * HOUR) * 1000).toISOString());

  d.raw.prepare("UPDATE agents SET status = 'armed', beat_at = ?").run(NOW - HOUR);
  item = only(await ask(), "worker-stale");
  assert.equal(item.severity, "today");
  assert.equal(item.owner_can_fix, false);
  assert.equal(item.started_at, new Date((NOW - HOUR + 570) * 1000).toISOString(), "stale from the moment the heartbeat aged past 2 x tick + 90 s");

  // Past its permission's expiry a silent worker owes nothing: the expired item is the one to act on.
  const expiredLater = await ask({}, undefined, 4102444800 + HOUR);
  assert.deepEqual(expiredLater.items.map((i) => i.kind), ["permission-expired"]);

  d.raw.prepare("UPDATE agents SET beat_at = ?").run(NOW - 30);
  for (let at = NOW - 40 * 60; at <= NOW - 120; at += 240) event(d, ACCOUNT_A, "strategist driver failed: 400 json_validate_failed", at);
  item = only(await ask(), "provider-failure");
  assert.equal(item.severity, "fyi");
  assert.equal(item.title, "The AI model provider is failing");
  assert.doesNotMatch(item.detail, /json_validate_failed/, "the provider's own text is never forwarded");

  refused(d, ACCOUNT_A, "daily-cap", NOW - 3 * HOUR);
  refused(d, ACCOUNT_A, "daily-cap", NOW - 600);
  refused(d, ACCOUNT_A, "ops-cap", NOW - 5 * HOUR); // no longer holding anything
  item = only(await ask(), "daily-cap");
  assert.equal(item.severity, "fyi");
  assert.equal(item.started_at, new Date((NOW - 3 * HOUR) * 1000).toISOString());
  assert.equal(item.what_to_do, null, "a reached cap is the signed permission working; raising it is not offered");
  assert.match(item.detail, /trailing 24-hour window/);
  assert.equal((await ask()).items.filter((i) => i.kind === "ops-cap").length, 0);
});

test("seen_keys: what was reported is not new, a fixed condition resolves, a risen severity is news but not a resolution, and an unchecked key never resolves", async () => {
  const { d, ask } = await setup({ agentA: { expiresAt: NOW + 2 * DAY } });
  agentRow(d, ACCOUNT_A, { blocker: "no-cash" });
  const first = await ask();
  assert.deepEqual(first.items.map((i) => [i.kind, i.new]), [["live-blocker", true], ["permission-expiring", true]]);
  const elsewhere = `breaker:${SLUG_B}:${NOW}`;
  const seen = [...first.items.map((i) => i.key), elsewhere];

  const again = await ask({ seen_keys: seen });
  assert.ok(again.items.every((i) => !i.new));
  assert.deepEqual(again.new_counts, { act_now: 0, today: 0, fyi: 0 });
  assert.deepEqual(again.resolved_keys, []);

  d.raw.prepare("UPDATE agents SET live_blocker = NULL").run();
  const later = await ask({ seen_keys: seen }, undefined, NOW + 2 * DAY - 9 * HOUR);
  const blockerKey = first.items.find((i) => i.kind === "live-blocker")!.key;
  const twoDaysKey = first.items.find((i) => i.kind === "permission-expiring")!.key;
  assert.deepEqual(later.resolved_keys, [blockerKey], "funded: resolved. The permission is not: it got closer to expiry");
  const risen = only(later, "permission-expiring");
  assert.equal(risen.severity, "act_now");
  assert.equal(risen.new, true, "nine hours from expiry is news even though two days was reported");
  assert.ok(!later.resolved_keys.includes(elsewhere), "a key about an agent this read did not check stays unknown");

  // Past expiry the same permission is an expired item; neither earlier key resolves.
  const expired = await ask({ seen_keys: [twoDaysKey, risen.key] }, undefined, NOW + 2 * DAY + HOUR);
  assert.equal(only(expired, "permission-expired").new, true);
  assert.deepEqual(expired.resolved_keys, []);
  assert.equal(conditionOfKey(twoDaysKey), conditionOfKey(only(expired, "permission-expired").key));

  const bad = await runTool(attention, { seen_keys: ["not a key"] }, (await setup()).pa, "trace-test", { now: () => NOW });
  assert.equal(errorOf(bad).code, "invalid_input");
});

test("proposals waiting for approval appear only under a proposal scope, link to their approval page, and the read expires nothing", async () => {
  const { d, ask, pa } = await setup({ scopes: ["agents:read", "social:write", "offline_access"] });
  agentRow(d, ACCOUNT_A);
  const made = await runTool(draftPost, { text: "gm merrymen", idempotency_key: "post-00001" }, pa, "trace-test", { now: () => NOW });
  assert.equal(made.isError, undefined, made.content[0]?.text);
  const id = (made.structuredContent as { proposal_id: string }).proposal_id;

  const tradeKey = `proposal-waiting:${SLUG_A}:trade.prp_${"0".repeat(32)}`;
  const r = await ask({ seen_keys: [tradeKey] });
  const item = only(r, "proposal-waiting");
  assert.equal(item.severity, "today");
  assert.equal(item.key, `proposal-waiting:${SLUG_A}:post.${id}`);
  assert.equal(item.link, `https://app.test/connect/approve/${id}`);
  assert.equal(item.agent, SLUG_A);
  // social:write sees posts and nothing else: the other kinds are named as unknown, and a seen trade proposal cannot resolve.
  assert.deepEqual(r.not_checked.map((n) => n.part), ["trade proposals", "settings proposals and agent setup drafts", "alert deliveries"]);
  assert.deepEqual(r.resolved_keys, []);
  assert.deepEqual((await ask({ seen_keys: [`proposal-waiting:${SLUG_A}:constructor.x`] })).resolved_keys, [], "a made-up kind is never checked");

  // Lapsed rows keep 'awaiting_approval' until opened; sixty newer ones must not hide the live one.
  const cols = (d.raw.prepare("PRAGMA table_info(mcp_proposals)").all() as Array<{ name: string }>).map((c) => c.name);
  const copy = cols.map((c) => (c === "id" ? "?" : c === "idempotency_key" ? "NULL" : c === "created_at" ? "?" : c === "expires_at" ? "?" : c)).join(", ");
  for (let i = 0; i < 60; i++) {
    d.raw.prepare(`INSERT INTO mcp_proposals (${cols.join(", ")}) SELECT ${copy} FROM mcp_proposals WHERE id = ?`)
      .run(`prp_${i.toString(16).padStart(32, "0")}`, NOW + 1 + i, NOW + 2, id);
  }
  const crowded = await ask({}, pa, NOW + 100);
  assert.equal(only(crowded, "proposal-waiting").key, `proposal-waiting:${SLUG_A}:post.${id}`);
  assert.ok(!crowded.not_checked.some((n) => n.part === "older waiting proposals"), "lapsed rows do not fill the page");

  // More live ones than a page (creation's quota check can be raced): the read says it did not see them all.
  for (let i = 0; i < 2 * MAX_OPEN_PROPOSALS; i++) {
    d.raw.prepare(`INSERT INTO mcp_proposals (${cols.join(", ")}) SELECT ${copy} FROM mcp_proposals WHERE id = ?`)
      .run(`prp_${(0x100 + i).toString(16).padStart(32, "0")}`, NOW + 10 + i, NOW + DAY, id);
  }
  const full = await ask({}, pa, NOW + 100);
  assert.ok(full.not_checked.some((n) => n.part === "older waiting proposals" && n.scope === null));

  const past = await ask({}, pa, NOW + 30 * DAY);
  assert.deepEqual(past.items.filter((i) => i.kind === "proposal-waiting"), [], "a lapsed proposal is not waiting");
  assert.equal((await proposalRow(d.db, OWNER_A, id))?.status, "awaiting_approval", "and reading did not expire it: get_attention changes nothing");
});

test("undelivered Telegram alerts are an fyi item under notifications:manage", async () => {
  const { d, ask } = await setup({ scopes: ["agents:read", "notifications:manage", "offline_access"] });
  agentRow(d, ACCOUNT_A);
  d.raw.prepare(`INSERT INTO notify_subscriptions (id, tenant, agent_slug, channel, kind, params_json, status, connection_id, cursor_json, created_at, updated_at, last_evaluated_at)
    VALUES ('sub_1', ?, ?, 'telegram', 'risk_halt', '{}', 'active', 'c', NULL, ?, ?, NULL)`).run(OWNER_A, SLUG_A, NOW - DAY, NOW - DAY);
  const dead = (id: string, at: number, code: string) => d.raw.prepare(`INSERT INTO notify_deliveries (id, subscription_id, tenant, dedupe_key, kind, channel, status, attempts, next_attempt_at, last_error_code, payload_json, created_at, sent_at)
      VALUES (?, 'sub_1', ?, ?, 'risk_halt', 'telegram', 'dead', 5, 0, ?, '{}', ?, NULL)`).run(id, OWNER_A, `k:${id}`, code, at);
  dead("dl_old", NOW - 3 * DAY, "chat_not_found");
  dead("dl_1", NOW - 5 * HOUR, "network");
  dead("dl_2", NOW - HOUR, "chat_not_found");
  let item = only(await ask(), "alerts-failing");
  assert.equal(item.severity, "fyi");
  assert.match(item.detail, /^2 alert message.*Link it again/);
  assert.equal(item.started_at, new Date((NOW - 5 * HOUR) * 1000).toISOString());
  assert.equal(item.owner_can_fix, true);
  assert.equal(item.link, "https://app.test/settings");

  // The newest failure is Telegram being unreachable: no setting clears it, so no chore and no link.
  dead("dl_3", NOW - 60, "network");
  item = only(await ask(), "alerts-failing");
  assert.equal(item.key, "alerts-failing:-:on", "the same condition keeps its key");
  assert.equal(item.owner_can_fix, false);
  assert.equal(item.what_to_do, null);
  assert.equal(item.link, null);
});

test("alerts skipped because no Telegram is linked count; a skip the owner chose, or a removed subscription's failures, do not", async () => {
  const { d, ask } = await setup({ scopes: ["agents:read", "notifications:manage", "offline_access"] });
  agentRow(d, ACCOUNT_A);
  const sub = (id: string, status: string) => d.raw.prepare(`INSERT INTO notify_subscriptions (id, tenant, agent_slug, channel, kind, params_json, status, connection_id, cursor_json, created_at, updated_at, last_evaluated_at)
    VALUES (?, ?, ?, 'telegram', 'risk_halt', '{}', ?, 'c', NULL, ?, ?, NULL)`).run(id, OWNER_A, SLUG_A, status, NOW - DAY, NOW - DAY);
  const delivery = (id: string, subId: string, status: string, code: string) => d.raw.prepare(`INSERT INTO notify_deliveries (id, subscription_id, tenant, dedupe_key, kind, channel, status, attempts, next_attempt_at, last_error_code, payload_json, created_at, sent_at)
    VALUES (?, ?, ?, ?, 'risk_halt', 'telegram', ?, 0, 0, ?, '{}', ?, NULL)`).run(id, subId, OWNER_A, `k:${id}`, status, code, NOW - HOUR);
  sub("sub_on", "active");
  sub("sub_gone", "removed");
  delivery("dl_off", "sub_on", "skipped", "owner_disabled");
  delivery("dl_gone", "sub_gone", "dead", "network");
  assert.deepEqual((await ask()).items, []);

  delivery("dl_nolink", "sub_on", "skipped", "no_linked_telegram");
  const item = only(await ask(), "alerts-failing");
  assert.equal(item.owner_can_fix, true);
  assert.match(item.detail, /^1 alert message.*No Telegram chat is linked/);
  assert.equal(item.link, "https://app.test/settings");
});

test("a read limited to one agent keys undelivered alerts by that agent, resolves them there, and a wider read still failing does not", async () => {
  const { d, ask } = await setup({ scopes: ["agents:read", "notifications:manage", "offline_access"] });
  agentRow(d, ACCOUNT_A);
  d.raw.prepare(`INSERT INTO notify_subscriptions (id, tenant, agent_slug, channel, kind, params_json, status, connection_id, cursor_json, created_at, updated_at, last_evaluated_at)
    VALUES ('sub_a', ?, ?, 'telegram', 'risk_halt', '{}', 'active', 'c', NULL, ?, ?, NULL)`).run(OWNER_A, SLUG_A, NOW - DAY, NOW - DAY);
  d.raw.prepare(`INSERT INTO notify_deliveries (id, subscription_id, tenant, dedupe_key, kind, channel, status, attempts, next_attempt_at, last_error_code, payload_json, created_at, sent_at)
    VALUES ('dl_a', 'sub_a', ?, 'k:dl_a', 'risk_halt', 'telegram', 'dead', 5, 0, 'network', '{}', ?, NULL)`).run(OWNER_A, NOW - HOUR);
  const scoped = only(await ask({ agent: SLUG_A }), "alerts-failing");
  assert.equal(scoped.key, `alerts-failing:${SLUG_A}:on`);
  assert.equal(scoped.agent, SLUG_A);

  const wide = await ask({ seen_keys: [scoped.key] });
  assert.equal(only(wide, "alerts-failing").key, "alerts-failing:-:on");
  assert.deepEqual(wide.resolved_keys, [], "still failing, seen through a wider read");

  const later = await ask({ agent: SLUG_A, seen_keys: [scoped.key] }, undefined, NOW + 2 * DAY);
  assert.deepEqual(later.resolved_keys, [scoped.key], "the same scoped read, after the failures aged out");
});

test("a breaker hidden behind more newer warnings than one read takes is not reported resolved, and the cut is named", async () => {
  const { d, ask } = await setup();
  agentRow(d, ACCOUNT_A);
  for (let at = NOW - 25 * 60; at <= NOW - 20 * 60; at += 60) event(d, ACCOUNT_A, BREAKER, at);
  const noise = d.raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', 'quote slower than usual', ?)");
  for (let i = 0; i < ATTENTION_EVENTS_MAX; i++) noise.run(ACCOUNT_A, NOW - 19 * 60 + Math.floor(i / 2));
  const r = await ask({ seen_keys: [`breaker:${SLUG_A}:on`] });
  assert.deepEqual(r.items.filter((i) => i.kind === "breaker"), [], "out of the page");
  assert.deepEqual(r.resolved_keys, [], "but its absence was not established");
  assert.ok(r.not_checked.some((n) => n.part === `older warnings of agent ${SLUG_A}` && n.scope === null), "no scope grants a longer read");
});

test("a recovery hold is tested first: the held agent gets one item with no chore, its other keys stay unknown, and an unreadable report is judged as no hold", async () => {
  const { d, ask } = await setup({ agentA: { expiresAt: NOW - HOUR } });
  agentRow(d, ACCOUNT_A, { status: "armed", beat: NOW - 2 * HOUR, blocker: "no-gas" });
  d.raw.exec(FLEET_RECOVERY_SCHEMA);
  d.raw.prepare("INSERT INTO fleet_recovery_health VALUES (?, ?, ?, 1, 'persistent-source', ?, ?)").run(OWNER_A, ACCOUNT_A, 4663, NOW - DAY, NOW - 60);
  const seen = [`worker-stale:${SLUG_A}:${NOW - 2 * HOUR}`, `live-blocker:${SLUG_A}:no-gas`, `permission-expired:${SLUG_A}:${NOW - HOUR}`];
  const r = await ask({ seen_keys: seen });
  assert.deepEqual(r.items.map((i) => [i.key, i.severity, i.owner_can_fix, i.what_to_do, i.link]), [[`recovery-hold:${SLUG_A}:on`, "today", false, null, null]]);
  assert.match(r.items[0]!.detail, /expired at .*offered once the hold lifts/);
  assert.deepEqual(r.resolved_keys, [], "judged on the hold alone, so nothing else is known to be fixed");

  d.raw.prepare("UPDATE fleet_recovery_health SET held = 0").run();
  const lifted = await ask({ seen_keys: [`recovery-hold:${SLUG_A}:on`] });
  assert.deepEqual(lifted.resolved_keys, [`recovery-hold:${SLUG_A}:on`]);
  assert.deepEqual(lifted.items.map((i) => i.kind), ["permission-expired"], "the owner's step comes back once the hold lifts");

  d.raw.prepare("UPDATE fleet_recovery_health SET held = 1, cause = 'not-a-cause'").run();
  const unread = await ask({ seen_keys: [`recovery-hold:${SLUG_A}:on`] });
  assert.ok(unread.not_checked.some((n) => n.part === `recovery hold of agent ${SLUG_A}` && n.scope === null));
  assert.deepEqual(unread.resolved_keys, [], "an unreadable report does not say the hold lifted");
  assert.equal(only(unread, "permission-expired").severity, "act_now", "an unreadable report never becomes a hold");
});

test("another owner's agent never appears, and asking for it by id is not found", async () => {
  const { d, ask, pb } = await setup();
  agentRow(d, ACCOUNT_A);
  agentRow(d, ACCOUNT_B, { blocker: "no-gas" });
  event(d, ACCOUNT_B, BREAKER, NOW - 60);
  assert.deepEqual((await ask()).items, []);
  const forB = await ask({}, pb);
  assert.ok(forB.items.length >= 1 && forB.items.every((i) => i.agent === SLUG_B), "B sees its own (its permission has expired in the fixture)");
  const r = await runTool(attention, { agent: SLUG_B }, (await setup()).pa, "trace-test", { now: () => NOW });
  assert.equal(errorOf(r).code, "not_found");
});

test("the connector-directory listing has the tool too, and says it cannot see proposals rather than asking for a scope it can never hold", async () => {
  assert.ok(toolInProfile(attention, "directory"));
  const { d, ask, directory } = await setup();
  agentRow(d, ACCOUNT_A, { blocker: "no-gas" });
  const r = await ask({}, (await directory()).principal);
  assert.equal(only(r, "live-blocker").severity, "act_now");
  assert.deepEqual(r.not_checked, [{ part: "proposals", why: "The connector-directory listing never sees proposals; they are listed in Merrymen.", scope: null }]);
});

test("runStart walks back while sightings stay within the gap, and says unknown when the read could have cut the run off", () => {
  assert.equal(runStart([1000, 900, 800, 100], 150, 0, false), 800);
  assert.equal(runStart([1000, 900], 150, 0, false), 900);
  assert.equal(runStart([1000, 900], 150, 800, false), null, "the floor is within the gap of the oldest sighting");
  assert.equal(runStart([1000, 900], 150, 0, true), null, "the read was cut");
  assert.equal(runStart([], 150, 0, false), null);
});
