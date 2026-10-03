/**
 * THE CATALOG'S CHAT ROUTE IS THE CHAT'S ALLOWLIST, NOT A SECOND ONE.
 *
 * packages/core/src/settings-catalog.ts says which changes an owner may approve
 * with a ✅ in Telegram. That list already exists and is a security boundary:
 * SETTING_SPECS here, plus the agent's name (chat-settings.ts CHAT_SETTABLE),
 * pinned by chat-settings.test.ts. Two lists that can drift are two
 * boundaries; this holds them equal, and holds every chat bound inside the
 * dashboard's.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHAT_ROUTE_KEYS, catalogEntry } from "../../../packages/core/src/index";
import { CHAT_SETTABLE } from "./chat-settings";
import { SETTING_SPECS } from "./setting-spec";

describe("the catalog's chat route", () => {
  it("IS EXACTLY what the chat could already change", () => {
    assert.deepEqual([...CHAT_ROUTE_KEYS].sort(), [...CHAT_SETTABLE].sort());
  });

  it("asks the same question of each value: same kind of thing, chat bounds inside the dashboard's", () => {
    const sameKind: Record<string, string[]> = {
      usd: ["usd"], pct: ["pct"], int: ["int", "minutes", "hour"], bool: ["bool"], enum: ["enum"],
      symbols: ["symbols"], strategy: ["enum"], hoursAsSec: ["hoursAsSec"],
    };
    for (const spec of SETTING_SPECS) {
      const c = catalogEntry(spec.key);
      assert.ok(c, `${spec.key} is in the catalog`);
      assert.ok(sameKind[spec.kind]?.includes(c.kind), `${spec.key}: chat ${spec.kind} vs catalog ${c.kind}`);
      if (spec.min !== undefined) assert.ok(c.min! <= spec.min, `${spec.key}: chat min ${spec.min} below the dashboard's ${c.min}`);
      if (spec.max !== undefined) assert.ok(c.max! >= spec.max, `${spec.key}: chat max ${spec.max} above the dashboard's ${c.max}`);
      if (spec.values) assert.deepEqual([...c.values!].sort(), [...spec.values].sort(), spec.key);
    }
  });
});
