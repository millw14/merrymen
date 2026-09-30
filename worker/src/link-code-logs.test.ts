/**
 * NO HOSTED LOG LINE CARRIES A LINK CODE.
 *
 * A link code is a bearer credential: whoever sends it to the bot first
 * becomes the agent's owner and can trade, transfer and kill. index.ts printed
 * "link code ready — send /link XXXXXX" on every child's start, and hosted that
 * line lands in the fleet's shared logs, so every tenant who had not linked
 * yet had a working code sitting there in plain text. Hosted it now says only
 * that the code is on the dashboard; self-hosted the log is the owner's own
 * terminal, and the code there is how they link.
 *
 * Source-scanned, so a new log line anywhere in the worker that interpolates a
 * code fails here rather than in someone's log viewer.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

/**
 * Every line in the worker that could print a link code: a `${…}` that reads
 * one, or a log call (console.*, note, log) with one anywhere in its line,
 * which catches `"…" + state.linkCode` too.
 */
function interpolations(): { file: string; line: string }[] {
  const out: { file: string; line: string }[] = [];
  const interpolated = /\$\{[^}]*\b(linkCode|link_code)\b[^}]*\}/;
  const logged = /\b(console\.(log|info|warn|error)|note|log)\([^\n]*\b(linkCode|link_code)\b/;
  for (const file of sources(ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const line of src.split("\n")) {
      if (interpolated.test(line) || logged.test(line)) out.push({ file: path.relative(ROOT, file), line: line.trim() });
    }
  }
  return out;
}

describe("link codes stay out of hosted logs", () => {
  it("the only line that prints a code is index.ts's self-hosted one", () => {
    const found = interpolations();
    assert.deepEqual(
      found.map((f) => f.file),
      ["index.ts"],
      `a link code is interpolated in: ${found.map((f) => `${f.file}: ${f.line}`).join(" | ")}`,
    );
    assert.match(found[0]!.line, /^else console\.log\(`\[telegram\] link code ready — send "\/link \$\{/);
  });

  it("…and that line is the else of a hosted check whose own line names no code", () => {
    const src = readFileSync(path.join(ROOT, "index.ts"), "utf8");
    const at = src.indexOf('else console.log(`[telegram] link code ready — send "/link ${');
    assert.ok(at > 0, "the self-hosted line moved — re-point this test, do not delete it");
    const lineStart = src.lastIndexOf("\n", at) + 1;
    const previous = src.slice(src.lastIndexOf("\n", lineStart - 2) + 1, lineStart - 1);
    assert.equal(previous.trim(), 'if (isHostedMode()) console.log("[telegram] link code ready (shown on the dashboard)");');
  });

  it("…and a code those lines already printed is retired before anything prints or publishes one", () => {
    // Redaction stops new codes reaching the logs; the ones already there were
    // derived from each token and are restored from the mirror, so the child
    // replaces any such code on start (state.ts retireLegacyCode, pinned in
    // state.test.ts and backlog.integration.test.ts).
    const src = readFileSync(path.join(ROOT, "index.ts"), "utf8");
    const retire = src.indexOf("tgState.set(ensureLinkCode(retireLegacyCode(tgState.get(), cfg.telegramBotToken)));");
    assert.ok(retire > 0, "index.ts no longer retires a legacy code at startup");
    assert.ok(retire < src.indexOf('console.log("[telegram] link code ready'), "retired before the line that reports the code");
  });

  it("the orchestrator's restore says a code came back without saying which", () => {
    const src = readFileSync(path.join(ROOT, "orchestrator.ts"), "utf8");
    assert.match(src, /log\(`\$\{tenant\}: telegram link code restored \(shown on the dashboard\)`\)/);
  });
});
