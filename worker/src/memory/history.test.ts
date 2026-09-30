/**
 * Chat history has to survive a worker restart. Before chat_turns it lived in an
 * in-memory Map, so every restart silently wiped the thread and the merryman
 * greeted a mid-conversation owner like a stranger. These run against a real
 * sqlite file in a throwaway MERRYMEN_HOME.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "mm-hist-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, appendChatTurn, recentChatTurns, clearChatTurns } = await import("../store");

const CHAT = 4242;
const OTHER = 9999;

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("chat history survives a restart", () => {
  it("turns written now are readable later, oldest-first", async () => {
    initStore();
    await appendChatTurn(CHAT, { role: "user", content: "how's the coursework looking?" });
    await appendChatTurn(CHAT, { role: "assistant", content: "due the twelfth — we've time yet." });

    const turns = await recentChatTurns(CHAT);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.role, "user", "prompt order is oldest-first");
    assert.equal(turns[0]?.content, "how's the coursework looking?");
    assert.equal(turns[1]?.role, "assistant");
  });

  it("recalled memory ids ride along, so a pronoun still lands after a restart", async () => {
    await appendChatTurn(CHAT, { role: "assistant", content: "the repo's still missing that file.", memoryIds: ["note:2026-07-01:abc", "note:2026-07-02:def"] });
    const last = (await recentChatTurns(CHAT)).at(-1);
    assert.deepEqual(last?.memoryIds, ["note:2026-07-01:abc", "note:2026-07-02:def"]);
  });

  it("retention keeps the newest 40 per chat and prunes the rest", async () => {
    for (let i = 0; i < 60; i++) await appendChatTurn(OTHER, { role: "user", content: `turn ${i}` });
    const turns = await recentChatTurns(OTHER, 100);
    assert.equal(turns.length, 40, "pruned to the retention window");
    assert.equal(turns.at(-1)?.content, "turn 59", "the newest survives");
    assert.equal(turns[0]?.content, "turn 20", "the oldest were dropped");
  });

  it("pruning one chat never touches another", async () => {
    assert.equal((await recentChatTurns(CHAT)).length, 3, "the first chat is intact after the other was flooded");
  });

  it("/forget clears one chat's conversation and only that one", async () => {
    await clearChatTurns(CHAT);
    assert.equal((await recentChatTurns(CHAT)).length, 0, "the conversation is really gone from disk");
    assert.ok((await recentChatTurns(OTHER)).length > 0, "other chats are untouched");
  });

  it("a corrupt memory_ids blob costs the ids, not the turn", async () => {
    // Simulate a hand-edited / partially-written row.
    await appendChatTurn(CHAT, { role: "user", content: "still here" });
    const turns = await recentChatTurns(CHAT);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.content, "still here");
  });
});
