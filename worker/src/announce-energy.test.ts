import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { illegalTags } from "./announce";

/**
 * THE ENERGY ANNOUNCEMENT, CHECKED BEFORE IT CAN REACH A FLEET.
 *
 * docs/announcements/energy-daily-cap-2026-09-28.html is sent through every
 * tenant's own bot by the orchestrator's two-key announcer. Telegram rejects
 * any tag outside its small HTML set by silently stripping ALL formatting, and
 * truncates at 4096 characters (the per-agent line is appended last) — both
 * would reach everyone as "delivered". It also carries the product's stance:
 * utility only, exits and owner orders never limited, and the buy happens in
 * the app chat, never in Telegram.
 */
const body = readFileSync(
  new URL("../../docs/announcements/energy-daily-cap-2026-09-28.html", import.meta.url),
  "utf8",
).trim();

describe("the energy daily-cap announcement", () => {
  it("USES ONLY TAGS TELEGRAM ACCEPTS, AND LEAVES ROOM FOR THE PER-AGENT LINE", () => {
    assert.deepEqual(illegalTags(body), []);
    assert.ok(body.length <= 3600, `body is ${body.length} chars`);
  });

  it("says it is from the team, not the agent", () => {
    assert.match(body, /^📣 <b>A note from the merrymen team<\/b> — not from your agent\./);
  });

  it("STATES THE RULE, WHAT NEVER CHANGES, AND BOTH WAYS TO FULL STRENGTH", () => {
    assert.match(body, /100,000 \$MERRYMEN/);
    assert.match(body, /00:00 UTC/);
    assert.match(body, /stop-losses, take-profits and the orders you place yourself always run/);
    assert.match(body, /Send \$MERRYMEN on Robinhood Chain to your agent's account/);
    assert.match(body, /Merrymen app chat<\/b> \(not here\)/);
    assert.match(body, /can never sell or send it/);
  });

  it("NEVER TALKS PRICE OR RETURNS, beyond disclaiming them", () => {
    assert.doesNotMatch(body, /\b(returns?|profit|moon|pump|investment|buyback|burn)\b/i);
    assert.match(body, /utility only: it buys capacity, nothing else, and we make no promise about its price/);
  });
});
