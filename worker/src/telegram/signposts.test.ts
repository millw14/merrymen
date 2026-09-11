/**
 * THE BOT MUST NOT SEND HOSTED USERS TO A MACHINE THAT ISN'T THERE.
 *
 * Two dead-ends, both found while writing an announcement telling ~43 beta
 * testers how to get their agents trading — that is, while writing the exact
 * instructions these commands are supposed to give.
 *
 * 1. `/wallet`, `/fund`, `/grant`, `/recover`, `/restore` and `/reconnect` all
 *    land on the same reply, which says "Open http://localhost:3100/grant on
 *    the machine running merrymen". `readWallet()` has always been able to
 *    print the real dashboard AND the agent's own account address — but
 *    `service.ts` never set `deps.reads.wallet`, and `executor.ts` reads
 *    `deps.reads.wallet ? … : WALLET_TEXT`, so the good function was dead code
 *    and every caller got the static localhost signpost. On the hosted fleet
 *    there is no machine running merrymen, so the instruction cannot be
 *    followed at all — and "fund your agent" is the single commonest thing a
 *    beta tester is ever told to do.
 *
 * 2. `/why` explains the LAST TRADE. An owner whose agent has never traded is
 *    precisely the owner who types it, and got "I haven't made a trade yet —
 *    nothing to explain." The reason was known the whole time: `liveBlocker()`
 *    computes it every tick and writes it to `agents.live_blocker`. It simply
 *    had no route into Telegram, and `/status` does not carry it either.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const READS = readFileSync(new URL("./reads.ts", import.meta.url), "utf8");
const SERVICE = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
const EXECUTOR = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");

/** Source with comments stripped — this repo explains its refusals in place. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("the wallet signpost points somewhere real", () => {
  it("reads.wallet is actually WIRED, or readWallet is dead code", () => {
    // The whole defect in one assertion. executor.ts falls back to the static
    // localhost text whenever this key is absent, silently.
    assert.match(EXECUTOR, /deps\.reads\.wallet \? deps\.reads\.wallet\(\) : WALLET_TEXT/);
    assert.match(code(SERVICE), /wallet: \(\) => readWallet\(/, "service.ts must supply reads.wallet");
  });

  it("the dashboard base is chosen, not hardcoded", () => {
    assert.match(READS, /export function dashboardBase\(\)/);
    // Hosted children get MERRYMEN_HOSTED from the orchestrator, so they can
    // tell. An env override wins for anyone self-hosting behind a domain.
    const fn = READS.slice(READS.indexOf("export function dashboardBase()"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.match(body, /MERRYMEN_DASHBOARD_URL/, "an explicit override must win");
    assert.match(body, /isHostedMode\(\)/, "hosted must not default to localhost");
    assert.match(body, /app\.merrymen\.dev/);
    assert.match(body, /localhost:3100/, "and self-hosted keeps the answer that was always right for it");
  });

  it("no owner-facing reply hardcodes localhost any more", () => {
    // Against comment-stripped source: the prose above legitimately names the
    // string it is banning, and the first draft of this test failed on its own
    // explanation rather than on the code.
    const owner = code(READS)
      // The signpost template and dashboardBase itself are the two places the
      // literal is still correct — one is rewritten per-call, the other IS the
      // chooser.
      .replace(/export function dashboardBase\(\)[\s\S]*?\n}/, "")
      .replace(/"Open <b>http:\/\/localhost:3100\/grant<\/b>[^"]*"/, "")
      .replace(/l\.split\("http:\/\/localhost:3100"\)[\s\S]{0,40}?\)/, "");
    assert.doesNotMatch(owner, /localhost:3100/, "a hosted user cannot open localhost");
  });

  it("the signpost is rewritten to the real base before it is sent", () => {
    const fn = READS.slice(READS.indexOf("export function readWallet("));
    assert.match(fn.slice(0, 600), /dashboardUrl \?\? dashboardBase\(\)/);
    assert.match(fn.slice(0, 600), /split\("http:\/\/localhost:3100"\)\.join\(base\)/);
  });
});

describe("/why answers the question it is actually asked", () => {
  it("falls back to the live blocker when there is no trade", () => {
    assert.match(READS, /export function readLiveBlocker\(/);
    assert.match(READS, /SELECT live_blocker FROM agents WHERE smart_account = \?/);
    assert.match(code(READS), /liveBlockerText\(/, "the rule becomes the product's own sentence");
  });

  it("BOTH no-trade exits use the fallback, not just the last one", () => {
    // The first draft fixed only the `!t` return and left the `!who` path on
    // the dead end — the same class of half-fix this file exists to catch.
    const fn = READS.slice(READS.indexOf("export function readWhyEvidence("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const deadEnds = (body.match(/I haven't made a trade yet — nothing to explain\./g) ?? []).length;
    assert.equal(deadEnds, 1, "only the genuinely-unknowable case may still dead-end");
    assert.equal((body.match(/return nothingYet\(\);/g) ?? []).length, 2, "both no-trade exits");
  });

  it("an unknown blocker is reported as unknown, never as fine", () => {
    // Null means "I have nothing to add", never "nothing is wrong" — the
    // empty-vs-unavailable rule. A pre-migration ledger has no column at all.
    const fn = READS.slice(READS.indexOf("export function readLiveBlocker("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.match(body, /if \(!rule\) return null;/);
    assert.match(body, /catch \{[\s\S]*?return null;/);
  });

  it("and it sends the reader to the dashboard, not to a bot command", () => {
    // Anchored on the next STATEMENT, not on the first `};` — the arrow
    // function contains nested object literals, so a brace-based cut lands
    // inside it and the test fails on its own slicing.
    const fn = READS.slice(READS.indexOf("const nothingYet ="));
    const body = fn.slice(0, fn.indexOf("  try {"));
    assert.match(body, /dashboardBase\(\)/, "the real dashboard, wherever this install is");
    assert.match(body, /esc\(/, "attacker-shaped text never reaches Telegram unescaped");
  });
});
