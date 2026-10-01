import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import type { MerrymenSettings } from "../../packages/core/src/index";
import type { PgClientLike } from "./announce";
import { sealSecret } from "./store-crypto";
import { emptyTgGroupsState } from "./telegram/tg-groups/store";
import type { TgRoom } from "./telegram/tg-groups/types";
import {
  RECOVERY_ROOM_TITLE, SHOGUN_BOT_USERNAME, SHOGUN_TENANT, runTgGroupRecoveryNotice,
} from "./tg-group-recovery-notice";

const CHAT_ID = -1001234567890;
const DEK = randomBytes(32);
const BODY = "Hey, I’m back. Sorry I went quiet. Sign up at https://app.merrymen.dev.";
const BODY_SHA256 = createHash("sha256").update(BODY).digest("hex");
const ID = "recovery-2026-10-01";

function room(chatId = CHAT_ID, title = RECOVERY_ROOM_TITLE, status: TgRoom["status"] = "approved"): TgRoom {
  return {
    chatId, title, status, kind: "supergroup", statusAtMs: 1,
    lines: [{ messageId: 1, fromId: 12, name: "Private member", text: "Do not log this", atMs: 1 }],
    sinceSummary: 0, summary: "Private chat summary", people: [], coins: [], claims: {},
  };
}

function sealed(rooms: TgRoom[]): string {
  const state = emptyTgGroupsState();
  state.rooms = Object.fromEntries(rooms.map((r) => [String(r.chatId), r]));
  return sealSecret(`tg-groups/v1 ${SHOGUN_TENANT}\n${JSON.stringify(state)}`, DEK);
}

class FakePg implements PgClientLike {
  sealedState = sealed([room(), room(-1002222222222, "Another room"), room(-1003333333333, "Merrymen", "pending")]);
  name = "Shogun";
  botClaimHolder: string | null = SHOGUN_TENANT;
  moveClaimAtInsert = false;
  notices = new Map<string, string>();
  queries: string[] = [];
  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.queries.push(sql);
    if (sql.includes("FROM grants g")) return { rows: this.name ? [{ name: this.name }] : [] };
    if (sql.startsWith("SELECT tenant FROM telegram_bot_claims")) {
      assert.equal(params[0], "123");
      return { rows: this.botClaimHolder ? [{ tenant: this.botClaimHolder }] : [] };
    }
    if (sql.startsWith("SELECT sealed FROM") && sql.includes("WHERE tenant = $1")) return { rows: [{ sealed: this.sealedState }] };
    if (sql.startsWith("CREATE TABLE") || sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" ||
        sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
    if (sql.startsWith("SELECT status FROM tg_group_notices")) {
      const status = this.notices.get(`${params[0]}:${params[2]}`);
      return { rows: status ? [{ status }] : [] };
    }
    if (sql.startsWith("INSERT INTO tg_group_notices")) {
      assert.match(sql, /WHERE EXISTS \(SELECT 1 FROM telegram_bot_claims/);
      assert.equal(params[5], "123");
      if (this.moveClaimAtInsert) this.botClaimHolder = `0x${"ab".repeat(20)}`;
      if (this.botClaimHolder !== SHOGUN_TENANT) return { rows: [] };
      const key = `${params[0]}:${params[2]}`;
      if (this.notices.has(key)) return { rows: [] };
      this.notices.set(key, "claimed");
      return { rows: [{ status: "claimed" }] };
    }
    if (sql.startsWith("UPDATE tg_group_notices")) {
      this.notices.set(`${params[2]}:${params[4]}`, String(params[0]));
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 30)}`);
  }
}

function harness() {
  const client = new FakePg();
  const calls: string[] = [];
  const settingsState = { current: {
    telegramBotToken: "123:secret", telegramEnabled: true, telegramGroupsEnabled: true,
  } as MerrymenSettings };
  const settings = { get: async (tenant: `0x${string}`) => {
    assert.equal(tenant, SHOGUN_TENANT);
    return settingsState.current;
  } };
  const deps = {
    client, campaignId: ID, body: BODY, settings, dek: DEK, env: {},
    inspectBot: async () => { calls.push("bot"); return { bot: { id: 123, username: SHOGUN_BOT_USERNAME, isBot: true } }; },
    inspectChat: async (_opts: unknown, id: number) => { calls.push("chat"); return { chat: { id, title: RECOVERY_ROOM_TITLE, type: "supergroup" as const, isForum: false } }; },
    send: async (_opts: unknown, id: number, text: string, _extra?: unknown) => { calls.push("send"); assert.equal(id, CHAT_ID); assert.equal(text, BODY); return { ok: true, messageId: 123 }; },
  };
  return { client, calls, settingsState, deps };
}

test("dry run lists only approved Shogun rooms titled Merrymen and contacts no Telegram endpoint", async () => {
  const { calls, client, deps } = harness();
  const out = await runTgGroupRecoveryNotice(deps);
  assert.equal(out.status, "preview");
  assert.equal(out.dryRun, true);
  assert.equal(out.bodySha256, BODY_SHA256);
  assert.deepEqual(out.rooms.map((r) => r.chatId), [CHAT_ID]);
  assert.deepEqual(calls, []);
  assert.equal(client.queries.some((sql) => sql.startsWith("CREATE TABLE")), false);
  assert.equal(JSON.stringify(out).includes("Private"), false);
});

test("a real send needs campaign id, exact approved chat id and reviewed body digest", async () => {
  const { calls, deps } = harness();
  const wrongConfirm = await runTgGroupRecoveryNotice({ ...deps, selectedChatId: CHAT_ID, confirmCampaignId: "another-campaign", confirmBodySha256: BODY_SHA256 });
  assert.equal(wrongConfirm.dryRun, true);
  const wrongChat = await runTgGroupRecoveryNotice({ ...deps, selectedChatId: -1009999999999, confirmCampaignId: ID, confirmBodySha256: BODY_SHA256 });
  assert.equal(wrongChat.status, "refused");
  assert.deepEqual(calls, []);
});

test("missing or stale body digest refuses before a database claim or Telegram call", async () => {
  const { client, calls, deps } = harness();
  const selected = { ...deps, selectedChatId: CHAT_ID, confirmCampaignId: ID };
  const missing = await runTgGroupRecoveryNotice(selected);
  assert.equal(missing.status, "refused");
  assert.equal(missing.bodySha256, BODY_SHA256);
  const changed = await runTgGroupRecoveryNotice({ ...selected,
    body: `${BODY} One more sentence.`, confirmBodySha256: BODY_SHA256,
  });
  assert.equal(changed.status, "refused");
  assert.notEqual(changed.bodySha256, BODY_SHA256);
  assert.deepEqual(client.queries, []);
  assert.deepEqual(calls, []);
});

test("claim is durable before send and a rerun cannot post again", async () => {
  const { calls, client, deps } = harness();
  const opts = { ...deps, selectedChatId: CHAT_ID, confirmCampaignId: ID, confirmBodySha256: BODY_SHA256 };
  const sent = await runTgGroupRecoveryNotice({ ...opts, send: async (...args) => {
    assert.equal(client.notices.get(`${ID}:${CHAT_ID}`), "claimed");
    return deps.send(...args);
  } });
  assert.equal(sent.status, "sent");
  assert.equal(client.notices.get(`${ID}:${CHAT_ID}`), "sent");
  const again = await runTgGroupRecoveryNotice(opts);
  assert.equal(again.status, "already-claimed");
  assert.deepEqual(calls, ["bot", "chat", "send"]);
});

test("an uncertain Telegram result retains the claim for manual review", async () => {
  const { client, deps } = harness();
  const out = await runTgGroupRecoveryNotice({ ...deps, selectedChatId: CHAT_ID, confirmCampaignId: ID, confirmBodySha256: BODY_SHA256,
    send: async () => ({ ok: false, reason: "request failed: timed out" }),
  });
  assert.equal(out.status, "uncertain");
  assert.equal(client.notices.get(`${ID}:${CHAT_ID}`), "uncertain");
});

test("current bot, chat and tenant identity must all match before a claim", async () => {
  const { client, deps } = harness();
  const options = { ...deps, selectedChatId: CHAT_ID, confirmCampaignId: ID, confirmBodySha256: BODY_SHA256 };
  client.name = "Another agent";
  assert.equal((await runTgGroupRecoveryNotice(options)).status, "refused");
  client.name = "Shogun";
  assert.equal((await runTgGroupRecoveryNotice({ ...options,
    inspectBot: async () => ({ bot: { id: 123, username: "Other_bot", isBot: true } }),
  })).status, "refused");
  assert.equal((await runTgGroupRecoveryNotice({ ...options,
    inspectBot: async () => ({ bot: { id: 999, username: SHOGUN_BOT_USERNAME, isBot: true } }),
  })).status, "refused");
  assert.equal((await runTgGroupRecoveryNotice({ ...options,
    inspectChat: async () => ({ chat: { id: CHAT_ID, title: "Other room", type: "supergroup", isForum: false } }),
  })).status, "refused");
  assert.equal(client.notices.size, 0);
});

test("missing or moved durable bot claim blocks even a dry-run candidate", async () => {
  const { client, calls, deps } = harness();
  client.botClaimHolder = null;
  assert.equal((await runTgGroupRecoveryNotice(deps)).status, "refused");
  client.botClaimHolder = `0x${"ab".repeat(20)}`;
  assert.equal((await runTgGroupRecoveryNotice(deps)).status, "refused");
  assert.deepEqual(calls, []);
  assert.equal(client.notices.size, 0);
});

test("settings, token and operator switch are checked again after Telegram responds", async () => {
  for (const change of ["groups", "telegram", "token", "switch"] as const) {
    const { client, calls, settingsState, deps } = harness();
    const env: Record<string, string | undefined> = {};
    const out = await runTgGroupRecoveryNotice({ ...deps, env, selectedChatId: CHAT_ID, confirmCampaignId: ID, confirmBodySha256: BODY_SHA256,
      inspectChat: async () => {
        if (change === "groups") settingsState.current.telegramGroupsEnabled = false;
        if (change === "telegram") settingsState.current.telegramEnabled = false;
        if (change === "token") settingsState.current.telegramBotToken = "123:new-secret";
        if (change === "switch") env.MERRYMEN_TG_GROUPS = "0";
        return { chat: { id: CHAT_ID, title: RECOVERY_ROOM_TITLE, type: "supergroup", isForum: false } };
      },
    });
    assert.equal(out.status, "refused", change);
    assert.equal(client.notices.size, 0, change);
    assert.equal(calls.includes("send"), false, change);
  }
});

test("bot claim moved during lookup or at the guarded insert blocks delivery", async () => {
  const { client, calls, deps } = harness();
  const opts = { ...deps, selectedChatId: CHAT_ID, confirmCampaignId: ID, confirmBodySha256: BODY_SHA256 };
  const duringLookup = await runTgGroupRecoveryNotice({ ...opts,
    inspectChat: async () => {
      client.botClaimHolder = `0x${"ab".repeat(20)}`;
      return { chat: { id: CHAT_ID, title: RECOVERY_ROOM_TITLE, type: "supergroup", isForum: false } };
    },
  });
  assert.equal(duringLookup.status, "refused");
  assert.equal(client.notices.size, 0);
  client.botClaimHolder = SHOGUN_TENANT;
  client.moveClaimAtInsert = true;
  const atInsert = await runTgGroupRecoveryNotice(opts);
  assert.equal(atInsert.status, "refused");
  assert.equal(client.notices.size, 0);
  assert.equal(calls.includes("send"), false);
});

test("an owner switching groups off or removing approval prevents the notice", async () => {
  const { client, deps } = harness();
  assert.equal((await runTgGroupRecoveryNotice({ ...deps, env: { MERRYMEN_TG_GROUPS: "0" } })).status, "refused");
  client.sealedState = sealed([room(CHAT_ID, RECOVERY_ROOM_TITLE, "left")]);
  assert.equal((await runTgGroupRecoveryNotice({ ...deps, selectedChatId: CHAT_ID, confirmCampaignId: ID, confirmBodySha256: BODY_SHA256 })).status, "refused");
  assert.equal(client.notices.size, 0);
});

test("approval withdrawn during the live Telegram checks prevents the claim", async () => {
  const { client, deps } = harness();
  const out = await runTgGroupRecoveryNotice({ ...deps, selectedChatId: CHAT_ID, confirmCampaignId: ID, confirmBodySha256: BODY_SHA256,
    inspectChat: async () => {
      client.sealedState = sealed([room(CHAT_ID, RECOVERY_ROOM_TITLE, "left")]);
      return { chat: { id: CHAT_ID, title: RECOVERY_ROOM_TITLE, type: "supergroup", isForum: false } };
    },
  });
  assert.equal(out.status, "refused");
  assert.equal(client.notices.size, 0);
});
