/**
 * ONE CAMPAIGN, THREE DIFFERENT TRUTHS.
 *
 * The announcement sender was built for one body plus a canned blocker line,
 * and that is right for "the platform changed". It is wrong the moment the
 * message is ABOUT the reader's own agent: "your agent is fine, the market is
 * shut" and "your agent has no trading money" are not variations of a sentence,
 * and a per-agent campaign that fell back to a shared body would mail one owner
 * another owner's circumstances.
 *
 * So `bodies` carries a finished message per tenant and `tenants` bounds the
 * campaign. Both are optional and absent means exactly the old behaviour.
 *
 * THE BOUNDARY THAT MATTERS: diagnosis is not in this module. Balances,
 * statuses and next steps are computed by the caller and arrive as strings.
 * announce.ts talks to Postgres and Telegram and to nothing else — it has no
 * RPC and no opinion about what an agent's problem is, so a wrong diagnosis can
 * never become a wrong SEND, only a wrong sentence the operator read first.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAnnouncement, type PgClientLike, type SettingsReader } from "./announce";

const A = "0x4b6dcd559c82ea897c34dacfb785fb0c8f85d4c5";
const B = "0x69ae6200000000000000000000000000000000b2";
const C = "0x9b9e7c00000000000000000000000000000000c3";
const D = "0xdddddd00000000000000000000000000000000d4";

/** A store with four linked tenants, all eligible. */
const store = (): SettingsReader => ({
  listTenants: async () => [A, B, C, D] as `0x${string}`[],
  get: async (t) => ({
    telegramBotToken: `SECRET-TOKEN-FOR-${t.slice(0, 8)}`,
    telegramEnabled: true,
    telegramNotifyEnabled: true,
    telegramAllowlist: [111],
  }),
});

/** Postgres with a chat for each, and a blocker + name for two of them. */
function db(sent: { announce_id: string; tenant: string }[] = []): PgClientLike & { writes: unknown[][] } {
  const writes: unknown[][] = [];
  return {
    writes,
    async query(sql: string, params?: unknown[]) {
      if (/FROM announcements/i.test(sql)) {
        return { rows: sent.filter((s) => s.announce_id === params?.[0]).map((s) => ({ tenant: s.tenant })) };
      }
      if (/FROM tenant_telegram/i.test(sql)) {
        return {
          rows: [
            { tenant: A, owner_id: 1001 },
            { tenant: B, owner_id: 1002 },
            { tenant: C, owner_id: 1003 },
            { tenant: D, owner_id: 1004 },
          ],
        };
      }
      if (/FROM grants/i.test(sql)) {
        return {
          rows: [
            { tenant: A, live_blocker: null, name: "SirSendIt" },
            { tenant: B, live_blocker: "wrong-chain", name: "EvenKeel" },
            { tenant: C, live_blocker: "no-cash", name: "Trencher" },
          ],
        };
      }
      if (/INSERT INTO announcements/i.test(sql)) writes.push(params ?? []);
      return { rows: [] };
    },
  };
}

interface Delivered {
  chatId: number;
  text: string;
  token: string;
}
const collector = () => {
  const out: Delivered[] = [];
  const send = async (auth: { token: string }, chatId: number, text: string) => {
    out.push({ chatId, text, token: auth.token });
    return { ok: true as const };
  };
  return { out, send: send as never };
};

const BODIES = {
  [A]: "Agent: SirSendIt\nStatus: Healthy\nReal funds: about $49.22 USDG",
  [B]: "Agent: EvenKeel\nStatus: Blocked\nReal USDG balance: $0\nRe-sign for Robinhood Chain.",
  [C]: "Agent: Trencher\nStatus: Blocked\nReal USDG balance: $0\nFund the agent with USDG.",
};

describe("a per-agent campaign delivers each owner only their own message", () => {
  it("A gets A, B gets B, C gets C — and nobody gets two", async () => {
    const { out, send } = collector();
    const r = await runAnnouncement({
      client: db(),
      announceId: "health-1",
      body: "GENERIC — MUST NOT BE SENT",
      bodies: BODIES,
      tenants: [A, B, C],
      confirmed: true,
      send,
      store: store(),
      sleep: async () => {},
    });
    assert.equal(r.sent, 3);
    assert.equal(out.length, 3, "exactly one message each");
    const byChat = new Map(out.map((d) => [d.chatId, d.text]));
    assert.match(byChat.get(1001) ?? "", /SirSendIt/);
    assert.match(byChat.get(1001) ?? "", /\$49\.22/);
    assert.match(byChat.get(1002) ?? "", /EvenKeel/);
    assert.match(byChat.get(1003) ?? "", /Trencher/);
    // The decisive one: no crossover.
    assert.doesNotMatch(byChat.get(1002) ?? "", /SirSendIt|49\.22/, "B must not hear about A");
    assert.doesNotMatch(byChat.get(1003) ?? "", /EvenKeel|Re-sign/, "C must not hear about B");
    for (const d of out) assert.doesNotMatch(d.text, /GENERIC/, "the shared body must never appear");
  });

  it("the tenant filter excludes everyone else", async () => {
    const { out, send } = collector();
    const r = await runAnnouncement({
      client: db(),
      announceId: "health-2",
      body: "x",
      bodies: BODIES,
      tenants: [A, B, C],
      confirmed: true,
      send,
      store: store(),
      sleep: async () => {},
    });
    assert.equal(out.length, 3);
    assert.ok(!out.some((d) => d.chatId === 1004), "D is linked and eligible but not in the campaign");
    assert.equal(r.skippedNotSelected, 1);
    // `eligible` still describes the FLEET, not the campaign — otherwise
    // "3 eligible" reads as "only three owners have Telegram".
    assert.equal(r.eligible, 4);
  });

  it("a selected tenant with NO prepared body is skipped, never given another's", async () => {
    const { out, send } = collector();
    const r = await runAnnouncement({
      client: db(),
      announceId: "health-3",
      body: "GENERIC — MUST NOT BE SENT",
      bodies: { [A]: BODIES[A]! },
      tenants: [A, B],
      confirmed: true,
      send,
      store: store(),
      sleep: async () => {},
    });
    assert.equal(out.length, 1, "only the tenant with a body is written to");
    assert.equal(out[0]!.chatId, 1001);
    assert.equal(r.skippedNoBody, 1);
    assert.equal(r.sent, 1);
  });
});

describe("nothing about the old behaviour moved", () => {
  it("with neither option, every eligible tenant gets the shared body plus its own line", async () => {
    const { out, send } = collector();
    const r = await runAnnouncement({
      client: db(),
      announceId: "generic-1",
      body: "THE PLATFORM CHANGED",
      confirmed: true,
      send,
      store: store(),
      sleep: async () => {},
    });
    assert.equal(out.length, 4, "all four, as before");
    assert.equal(r.sent, 4);
    assert.equal(r.skippedNotSelected, 0);
    assert.equal(r.skippedNoBody, 0);
    for (const d of out) assert.match(d.text, /THE PLATFORM CHANGED/);
    // The canned per-agent line still fires for the two with blockers.
    assert.equal(r.personalised, 2);
    const blocked = out.find((d) => d.chatId === 1002)!;
    assert.match(blocked.text, /Your agent, right now:/);
  });

  it("dedupe is still per recipient per campaign", async () => {
    const { out, send } = collector();
    const r = await runAnnouncement({
      client: db([{ announce_id: "health-4", tenant: A }]),
      announceId: "health-4",
      body: "x",
      bodies: BODIES,
      tenants: [A, B, C],
      confirmed: true,
      send,
      store: store(),
      sleep: async () => {},
    });
    assert.equal(r.skippedAlreadySent, 1, "A already had it");
    assert.equal(out.length, 2, "and is not written to again");
    assert.ok(!out.some((d) => d.chatId === 1001));
  });

  it("a dry run contacts Telegram zero times, even with prepared bodies", async () => {
    const { out, send } = collector();
    const r = await runAnnouncement({
      client: db(),
      announceId: "health-5",
      body: "x",
      bodies: BODIES,
      tenants: [A, B, C],
      confirmed: false,
      send,
      store: store(),
      sleep: async () => {},
    });
    assert.equal(r.dryRun, true);
    assert.equal(r.sent, 3, "it reports who WOULD receive");
    assert.equal(out.length, 0, "and sends nothing");
  });
});

describe("credentials never leave the module", () => {
  it("no bot token appears in the outcome, the DB writes, or any counter", async () => {
    const { send } = collector();
    const client = db();
    const r = await runAnnouncement({
      client,
      announceId: "health-6",
      body: "x",
      bodies: BODIES,
      tenants: [A, B, C],
      confirmed: true,
      send,
      store: store(),
      sleep: async () => {},
    });
    const serialised = JSON.stringify(r) + JSON.stringify(client.writes);
    assert.doesNotMatch(serialised, /SECRET-TOKEN/, "a token must never reach the outcome or the ledger");
    // The recorded row is the campaign and the tenant, and nothing else.
    for (const w of client.writes) {
      assert.equal(w.length, 3, "announce_id, tenant, sent_at — no fourth column");
    }
  });
});
