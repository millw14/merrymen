/**
 * WHAT THE STORE KEEPS NEVER CARRIES AN RPC KEY, proven against a real sqlite
 * file (a throwaway MERRYMEN_HOME) — same discipline as the budget tests.
 *
 * The rows are the durable half of the 2026-10-17 leak: an event is the
 * owner's dashboard and the desk's mirror of it, and a `couldn't submit: …`
 * reject_rule is what the orchestrator's `autonomy| 1h refusals` line reads
 * back every few seconds. Both were a viem error's text, URL and key included.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpRequestError } from "viem";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-redact-"));
process.env.MERRYMEN_HOME = HOME;
// sqlite, whatever the shell running the suite points at.
delete process.env.DATABASE_URL;

const { closeStoreForTest, initStore, addEvent, addTrade, addDecision, enqueueCommand, finishCommand } = await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");
const { AUTONOMY_TRADE_FUNNEL_SQL, autonomyLines, foldFunnel } = await import("./autonomy-funnel");
const { errorText } = await import("./redact-urls");

/** Made up, Alchemy-shaped. See redact-urls.test.ts. */
const KEY = "Fk7qZ2mXw9Lr4TbN0cVyH3sJ8dPaQe6U";
const HOST = "robinhood-mainnet.g.alchemy.com";
const KEYED = `https://${HOST}/v2/${KEY}`;

/**
 * Any eight characters of the key, anywhere. A slice that cut the URL in half
 * must not leave the half it kept.
 */
function leaksKey(text: string): boolean {
  for (let i = 0; i + 8 <= KEY.length; i++) if (text.includes(KEY.slice(i, i + 8))) return true;
  return false;
}
const AGENT = "0xab7bde0000000000000000000000000000000001";

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function rows<T>(sql: string, ...args: (string | number)[]): T[] {
  const db = new DatabaseSync(homePaths.db());
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

describe("the store's free text", () => {
  it("an event made of a viem error keeps the host and loses the key", async () => {
    await initStore();
    const e = new HttpRequestError({ url: KEYED, details: "merrymen-rpc-declined: not sent" });
    // Raw, as a caller that never heard of redact-urls.ts would write it.
    await addEvent(AGENT, "err", `tick failed: ${e.message}`);
    const [ev] = rows<{ message: string }>("SELECT message FROM events WHERE agent_id = ?", AGENT);
    assert.ok(ev, "the event was written");
    assert.ok(!leaksKey(ev.message), "the event carries the key");
    assert.ok(ev.message.includes(HOST));
  });

  it("a couldn't-submit reject_rule loses the key, and the refusals line never shows it", async () => {
    const e = new HttpRequestError({ url: KEYED, details: "merrymen-rpc-declined: not sent" });
    // index.ts's own construction, from the RAW message — the store must hold
    // even if the call site's redaction is ever lost.
    const raw = e.message;
    assert.ok(raw.includes(KEY));
    const ok = await addTrade({
      agent_id: AGENT,
      kind: "swap",
      target: "0x1111111111111111111111111111111111111111",
      amount_usdg: 5,
      status: "rejected",
      reject_rule: `couldn't submit: ${raw.replace(/\s+/g, " ").slice(0, 80)}`,
    });
    assert.equal(ok, true);
    const stored = rows<{ reject_rule: string }>("SELECT reject_rule FROM trades WHERE agent_id = ?", AGENT);
    assert.equal(stored.length, 1);
    assert.ok(!leaksKey(stored[0]!.reject_rule), "reject_rule carries the key");
    assert.match(stored[0]!.reject_rule, /^couldn't submit: HTTP request failed\. URL: https:\/\/robinhood-mainnet\.g\.alchemy\.com\//);

    // And the line the orchestrator prints from it.
    const funnel = foldFunnel(
      rows(AUTONOMY_TRADE_FUNNEL_SQL, Math.floor(Date.now() / 1000) - 3600),
      () => "live",
    );
    const text = autonomyLines(1, funnel, []).join("\n");
    assert.match(text, /autonomy\| 1h refusals — couldn't submit: HTTP request failed\. URL: https:\/\/robinhood-mainnet/);
    assert.ok(!leaksKey(text));
  });

  it("a decision's reason and a command's receipt lose the key too", async () => {
    const e = new HttpRequestError({ url: KEYED, details: "merrymen-rpc-declined: not sent" });
    await addDecision({ id: "d-redact", agent_id: AGENT, source: "brain-shadow", reason: `no decision (provider): ${e.message}`, dropped_rule: `couldn't submit: ${e.message}` });
    const [d] = rows<{ reason: string; dropped_rule: string }>("SELECT reason, dropped_rule FROM decisions WHERE id = ?", "d-redact");
    assert.ok(d, "the decision was written");
    assert.ok(!leaksKey(d.reason) && !leaksKey(d.dropped_rule), "the decision carries the key");
    assert.ok(d.reason.includes(HOST));

    assert.equal(await enqueueCommand(AGENT, "c-redact", "probe"), true);
    // Longer than the 500-character receipt, with the URL across the cut.
    await finishCommand("c-redact", `${"x".repeat(470)} ${e.message}`);
    const [c] = rows<{ result: string }>("SELECT result FROM agent_commands WHERE id = ?", "c-redact");
    assert.ok(c, "the command was finished");
    assert.ok(!leaksKey(c.result), "the receipt carries the key");
  });

  it("a row written before the fix is redacted when the refusals line reads it back", () => {
    // Rows from before this change are still in the ledger for the hour the
    // line covers. They must not be repeated every seventeen seconds.
    const funnel = foldFunnel(
      [{ agent_id: AGENT, status: "rejected", rule: `couldn't submit: HTTP request failed. URL: ${KEYED}`, n: 7 }],
      () => "live",
    );
    const text = autonomyLines(1, funnel, []).join("\n");
    assert.ok(!leaksKey(text));
    assert.match(text, /couldn't submit: HTTP request failed\. URL: https:\/\/robinhood-mainnet\.g\.alchemy\.com\/\[redacted\] 7 \[exec\]/);
    assert.ok(errorText(new Error(text)).includes(HOST));
  });
});
