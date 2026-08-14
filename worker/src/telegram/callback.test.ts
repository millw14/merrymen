import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { livePendingEntry, resolveCallback, type ResolveCallbackCtx } from "./callback";
import type { TgCallback } from "./api";
import type { Command } from "./interpreter";
import type { PendingAction } from "./executor";

// ── harness: in-memory pending + recorded api/executor calls ───────────────

interface Rec {
  calls: string[];
  answer: (queryId: string, extra?: { text?: string }) => Promise<unknown>;
  edit: (chatId: number, messageId: number, text: string) => Promise<{ ok: boolean }>;
  send: (chatId: number, text: string) => Promise<unknown>;
  execute: (action: Command) => Promise<string>;
  note: (level: "ok" | "warn", message: string) => void;
  pending: Map<string, PendingAction>;
  now: () => number;
  ctx: ResolveCallbackCtx;
}

function harness(overrides: Partial<Rec> = {}): Rec {
  const calls: string[] = [];
  const pending = new Map<string, PendingAction>();
  let nowVal = 1_000_000;
  const now = () => nowVal;
  const ctx: ResolveCallbackCtx = {
    token: "t",
    allowlist: [111],
    pending,
    now,
    execute: async (action) => {
      calls.push(`exec:${action.kind}`);
      return `done ${action.kind}`;
    },
    note: (level, message) => calls.push(`note:${level}:${message}`),
    answer: async (queryId, extra) => {
      calls.push(`answer:${extra?.text ?? ""}`);
      return { ok: true };
    },
    edit: async (chatId, messageId, text) => {
      calls.push(`edit:${messageId}:${text}`);
      return { ok: true };
    },
    send: async (chatId, text) => {
      calls.push(`send:${text}`);
      return { ok: true };
    },
  };
  return {
    calls,
    answer: ctx.answer,
    edit: ctx.edit,
    send: ctx.send,
    execute: ctx.execute,
    note: ctx.note,
    pending,
    now,
    ctx: { ...ctx, ...overrides },
  };
}

const cb = (overrides: Partial<TgCallback> = {}): TgCallback => ({
  updateId: 1,
  chatId: 111,
  fromId: 111,
  messageId: 42,
  data: "confirm:abc12345",
  queryId: "q1",
  ...overrides,
});

const pendingFor = (nonce = "abc12345", expiresAt = 1_000_090): PendingAction => ({
  kind: "type",
  text: "hello",
  expiresAt,
  nonce,
});

// ── livePendingEntry — the TTL sweep ────────────────────────────────────────

describe("livePendingEntry — expired slots are swept on read", () => {
  it("returns a live entry unchanged", () => {
    const pending = new Map<string, PendingAction>([["111:111", pendingFor()]]);
    const hit = livePendingEntry(pending, "111:111", 1_000_000);
    assert.equal(hit, pending.get("111:111"));
  });

  it("deletes an expired entry and returns null", () => {
    const pending = new Map<string, PendingAction>([["111:111", pendingFor("abc12345", 1_000_050)]]);
    const hit = livePendingEntry(pending, "111:111", 1_000_090);
    assert.equal(hit, null);
    assert.equal(pending.has("111:111"), false); // swept, not just hidden
  });

  it("returns null for a missing key", () => {
    assert.equal(livePendingEntry(new Map(), "111:111", 1_000_000), null);
  });
});

// ── resolveCallback — the four fixed behaviours ─────────────────────────────

describe("resolveCallback — nonce binding (stale buttons can't confirm a newer ask)", () => {
  it("confirm with a matching nonce executes and edits the parked message", async () => {
    const h = harness();
    h.pending.set("111:111", pendingFor());
    await resolveCallback(cb({ data: "confirm:abc12345" }), h.ctx);
    assert.deepEqual(h.calls, ["exec:confirm", "answer:Confirmed ✓", "edit:42:done confirm"]);
  });

  it("cancel with a matching nonce resolves without a send fallback", async () => {
    const h = harness();
    h.pending.set("111:111", pendingFor());
    await resolveCallback(cb({ data: "cancel:abc12345" }), h.ctx);
    assert.deepEqual(h.calls, ["exec:cancel", "answer:Cancelled", "edit:42:done cancel"]);
  });

  it("a stale nonce (superseded ask) is refused — no execute, message edited to superseded", async () => {
    const h = harness();
    h.pending.set("111:111", pendingFor("abc12345"));
    await resolveCallback(cb({ data: "confirm:deadbeef" }), h.ctx);
    assert.deepEqual(h.calls, [
      "answer:this ask was superseded.",
      "edit:42:this ask was superseded — a newer action is waiting.",
    ]);
    assert.ok(!h.calls.some((c) => c.startsWith("exec:")));
  });

  it("bare or foreign callback_data is an unknown button — no execute, no edit", async () => {
    const h = harness();
    h.pending.set("111:111", pendingFor());
    for (const data of ["confirm", "cancel", "foo:bar", "steal:abc12345"]) {
      await resolveCallback(cb({ data, queryId: `q-${data}` }), h.ctx);
    }
    assert.deepEqual(h.calls, ["answer:unknown button.", "answer:unknown button.", "answer:unknown button.", "answer:unknown button."]);
  });
});

describe("resolveCallback — callback authorization (same gates as messages)", () => {
  it("a tap from a non-allowlisted chat is refused — no edit, no execute", async () => {
    const h = harness();
    h.pending.set("999:999", pendingFor());
    await resolveCallback(cb({ chatId: 999, fromId: 999 }), h.ctx);
    assert.deepEqual(h.calls, ["answer:not authorized."]);
  });

  it("in a group, only individually-allowlisted senders may confirm", async () => {
    const h = harness();
    const group = -100111;
    h.ctx.allowlist = [group, 111]; // group allowlisted, but not every member
    h.pending.set(`${group}:111`, pendingFor()); // owner parked it in the group
    await resolveCallback(cb({ chatId: group, fromId: 222 }), h.ctx); // stranger taps
    assert.deepEqual(h.calls, ["answer:in a group, only individually-allowlisted users can confirm."]);
  });

  it("an allowlisted sender in a group may confirm the group's pending", async () => {
    const h = harness();
    const group = -100111;
    h.pending.set(`${group}:111`, pendingFor());
    await resolveCallback(cb({ chatId: group, fromId: 111 }), h.ctx);
    assert.deepEqual(h.calls, ["exec:confirm", "answer:Confirmed ✓", "edit:42:done confirm"]);
  });
});

describe("resolveCallback — only the pending owner's message is ever edited", () => {
  it("a tap with no live pending (stranger/expired) toasts only — never edits", async () => {
    const h = harness();
    await resolveCallback(cb(), h.ctx); // nothing parked at all
    assert.deepEqual(h.calls, ["answer:"]);

    h.calls.length = 0;
    h.pending.set("111:111", pendingFor("abc12345", 999_900)); // expired (now = 1_000_000) — swept on read
    await resolveCallback(cb({ data: "confirm:abc12345" }), h.ctx);
    assert.deepEqual(h.calls, ["answer:"]); // no edit, no execute
    assert.equal(h.pending.has("111:111"), false); // swept
  });
});

describe("resolveCallback — execution failure and edit fallback", () => {
  it("an executor throw is surfaced in the edited message (never silent)", async () => {
    const h = harness();
    h.pending.set("111:111", pendingFor());
    h.ctx.execute = async () => {
      throw new Error("policy wall");
    };
    await resolveCallback(cb({ data: "confirm:abc12345" }), h.ctx);
    assert.deepEqual(h.calls, [
      "note:warn:Telegram: confirm:abc12345 callback failed — policy wall",
      "answer:Confirmed ✓",
      "edit:42:🚫 that confirm:abc12345 failed: policy wall",
    ]);
  });

  it("when the edit fails the outcome is sent as a fresh message", async () => {
    const h = harness();
    h.pending.set("111:111", pendingFor());
    h.ctx.edit = async () => ({ ok: false, reason: "message not modified" });
    await resolveCallback(cb({ data: "cancel:abc12345" }), h.ctx);
    assert.deepEqual(h.calls, ["exec:cancel", "answer:Cancelled", "send:done cancel"]);
  });
});
