/**
 * THE CARRIED HISTORY IS FOR ANSWERS, NEVER FOR DECISIONS.
 *
 * `trade-history.json` sits in a tenant-writable home and is a capped snapshot
 * of the shared ledger (history-files.ts). It is good enough to tell an owner
 * what happened. If the daily cap, the op-hash set the reconciler checks, the
 * cost basis or the breaker ever read it, a carried row could loosen a limit
 * or hide an operation from the reconciler — so the only code allowed to know
 * the file exists is the orchestrator that writes it and the Telegram reads
 * that show it. Pinned here because the boundary is invisible at a call site.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const WORKER_SRC = path.dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const MENTIONS = /history-files|history-overlay|trade-history\.json|overlayHistory|readHistory\(/;

describe("who may read the carried history", () => {
  it("only the writer and the Telegram reads", () => {
    const allowed = new Set([
      "history-files.ts",
      "orchestrator.ts",
      "telegram/history-overlay.ts",
      "telegram/chat-tools.ts",
      "telegram/reads.ts",
    ]);
    const files = walk(WORKER_SRC);
    assert.ok(files.length > 100, "the walk found the worker at all");
    const guilty = files
      .filter((f) => MENTIONS.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(WORKER_SRC, f).split(path.sep).join("/"))
      .filter((f) => !allowed.has(f));
    assert.deepEqual(guilty, [], "something outside the chat reads the carried history");
  });

  it("and the Telegram reads that do are not the notifier's", () => {
    const notifier = readFileSync(path.join(WORKER_SRC, "telegram", "notifier.ts"), "utf8");
    assert.doesNotMatch(notifier, MENTIONS);
  });
});
