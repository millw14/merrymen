/**
 * A BOT NOBODY HEARS IS SAID, ONCE, AND NOTHING IS KILLED FOR IT (plan §1.4).
 *
 * In the incident behind this, nothing polled an owner's bot for days and not
 * one line in the fleet's log said so. The orchestrator now reads the poll
 * record each polling process keeps (telegram/state.ts PollHealth) and logs
 * `[alert] telegram not polling` once per incident. It must never become a
 * second watchdog: a deaf bot is not a reason to kill a trading worker, and
 * no restart fixes a revoked token or a second program on the bot.
 *
 * The verdict and the line are pure and run directly; the pass itself is
 * pinned in the source (the watchdog never reads the record; the pass kills
 * nothing) and driven over a held tenant in telegram-liveness.integration.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import ts from "typescript";
import { LIVENESS_STALE_SEC, livenessAlertLine, pollFailingNow, telegramLivenessVerdict } from "./telegram-liveness";

const T = 1_790_000_000;
const CONFLICT = "conflict: another program is reading this bot's updates (409)";
const REFUSED = "refused: 401 Unauthorized";

describe("telegramLivenessVerdict", () => {
  const v = (p: Partial<Parameters<typeof telegramLivenessVerdict>[0]>) =>
    telegramLivenessVerdict({ enabled: true, okAt: null, err: null, errAt: null, since: T, now: T, ...p });

  it("off when nothing should be polling", () => {
    assert.equal(v({ enabled: false, okAt: T - 86_400 }), "off");
  });

  it("live while heard within ten minutes", () => {
    assert.equal(v({ okAt: T - LIVENESS_STALE_SEC, now: T }), "live");
    assert.equal(v({ okAt: T - LIVENESS_STALE_SEC - 1, since: 0, now: T }), "stale");
  });

  it("A PROCESS THAT HAS ONLY JUST STARTED IS NOT STALE for a predecessor's old success, or for having none yet", () => {
    // After a restart or a redeploy the record in the home is the last
    // process's, or there is none. The clock starts when this one was first
    // watched.
    assert.equal(v({ okAt: T - 3_600, since: T - 60, now: T }), "live");
    assert.equal(v({ okAt: null, since: T - 60, now: T }), "live");
    assert.equal(v({ okAt: null, since: T - LIVENESS_STALE_SEC - 1, now: T }), "stale");
  });

  it("a refused token is said at once: waiting cannot change it", () => {
    assert.equal(v({ okAt: T - 30, err: REFUSED, errAt: T - 5 }), "revoked");
    // Unless a poll has worked since (a new secret pasted for the same bot).
    assert.equal(v({ okAt: T - 5, err: REFUSED, errAt: T - 30 }), "live");
  });

  it("a conflict is stale with its own name, and only once it has kept the bot unheard", () => {
    // A single 409 at a redeploy handover, while the old worker's long poll
    // is still open, is not an incident.
    assert.equal(v({ okAt: T - 60, err: CONFLICT, errAt: T - 30, since: 0 }), "live");
    assert.equal(v({ okAt: T - 3_600, err: CONFLICT, errAt: T - 5, since: 0 }), "conflict");
    // A conflict a later success overtook says nothing about now.
    assert.equal(v({ okAt: T - 1_000, err: CONFLICT, errAt: T - 2_000, since: 0 }), "stale");
  });

  it("the latest outcome is whichever of success and failure is later", () => {
    assert.equal(pollFailingNow(null, "failed: x", null), true);
    assert.equal(pollFailingNow(T, "failed: x", T - 1), false);
    assert.equal(pollFailingNow(T, "failed: x", T), true);
    assert.equal(pollFailingNow(T, null, null), false);
  });
});

describe("the alert line", () => {
  const TENANT = "0x542978aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("says which tenant, since when, and why", () => {
    assert.equal(
      livenessAlertLine(TENANT, "stale", { okAt: Date.parse("2026-09-19T08:00:00Z") / 1000, err: "failed: HTTP 502", since: T }),
      `[alert] telegram not polling: ${TENANT} since 2026-09-19T08:00:00.000Z (failed: HTTP 502)`,
    );
    assert.match(
      livenessAlertLine(TENANT, "conflict", { okAt: T - 3_600, err: CONFLICT, since: T })!,
      /^\[alert\] telegram not polling: .* \(conflict: another program is reading this bot's updates \(409\)\)$/,
    );
    assert.match(
      livenessAlertLine(TENANT, "stale", { okAt: null, err: null, since: T })!,
      /since the watch began at .*, with no poll that worked \(no failure recorded\)$/,
    );
  });

  it("A REVOKED TOKEN HAS A LINE OF ITS OWN: its remedy is the owner's", () => {
    const line = livenessAlertLine(TENANT, "revoked", { okAt: T - 60, err: REFUSED, since: T })!;
    assert.match(line, /^\[alert\] telegram bot token refused: /);
    assert.doesNotMatch(line, /not polling/);
  });

  it("nothing to say for a live or switched-off bot", () => {
    assert.equal(livenessAlertLine(TENANT, "live", { okAt: T, err: null, since: T }), null);
    assert.equal(livenessAlertLine(TENANT, "off", { okAt: null, err: null, since: T }), null);
  });
});

describe("alert only: in the orchestrator's source", () => {
  const SRC = path.dirname(fileURLToPath(import.meta.url));
  const ORCH = readFileSync(path.join(SRC, "orchestrator.ts"), "utf8");
  const AST = ts.createSourceFile("orchestrator.ts", ORCH, ts.ScriptTarget.Latest, true);
  const body = (name: string): string => {
    const f = AST.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
    assert.ok(f?.body, `${name} must exist`);
    // Comments out: they explain what the code refuses to do, in its words.
    return f.body.getText().replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  };

  it("THE WATCHDOG NEVER READS THE POLL RECORD", () => {
    // The watchdog kills. If it could see Telegram's health, a deaf bot would
    // cost the owner their trading too.
    const wd = body("watchdog");
    for (const never of ["poll", "readChildTelegram", "telegramLiveness", "telegram.json", "livenessWatch"]) {
      assert.ok(!wd.includes(never), `watchdog must not touch ${never}`);
    }
  });

  it("AND THE LIVENESS PASS KILLS, STOPS, RESTARTS AND FORGETS NOTHING", () => {
    const pass = body("telegramLiveness");
    for (const never of [".kill(", "killChild", "scheduleRestart", "standDownHolder", "spawnChild", "children.delete", "holders.delete", "gaveUpUntil", "releaseLease"]) {
      assert.ok(!pass.includes(never), `telegramLiveness must not call ${never}`);
    }
    // It reads the record, under the lease, and logs.
    assert.match(pass, /readChildTelegram\(tenant, nowSec\)/);
    assert.match(pass, /if \(!lease\.healthy\(\)\) continue;/);
    assert.match(pass, /if \(!lease \|\| !lease\.healthy\(\)\) livenessWatch\.delete\(tenant\);/);
    assert.match(pass, /log\(line\)/);
  });

  it("WATCHES EVERY TENANT THIS REPLICA HOLDS, not every process it runs", () => {
    // Keyed on the process, a bot whose processes kept dying was never said:
    // each new one restarted the clock, and a tenant between processes (a
    // crash cool-off) was not watched at all.
    const pass = body("telegramLiveness");
    assert.match(pass, /for \(const \[tenant, lease\] of leases\)/);
    for (const never of ["children", "holders", ".proc"]) {
      assert.ok(!pass.includes(never), `telegramLiveness must not key its watch on ${never}`);
    }
    // A new watch only for another bot.
    assert.match(pass, /if \(!watch \|\| watch\.bot !== bot\)/);
  });

  it("runs every pass, beside the watchdog, outside FLEET_HALT", () => {
    const main = body("runOrchestrator");
    const wd = main.indexOf("watchdog();");
    const pass = main.indexOf("telegramLiveness();");
    assert.ok(wd > 0 && pass > wd, "right after the watchdog");
  });

  it("publishes the liveness columns for workers and held tenants alike", () => {
    const mirror = body("mirrorLedgers");
    assert.match(mirror, /publishChildTelegram\(tenant as `0x\$\{string\}`, shared, "trading"\)/);
    assert.match(mirror, /publishChildTelegram\(tenant as `0x\$\{string\}`, shared, `held:\$\{held\.cls\}`\)/);
    // The columns, from the one sequence the Postgres suite races (telegram-store.ts ensureTelegramSchema).
    assert.match(mirror, /await ensureTelegramSchema\(shared\);/);
    const publish = body("publishChildTelegram");
    assert.match(publish, /await publishTelegramRuntime\(/);
    // The bot only while this process is still handed its token
    // (telegram-store.ts livenessFor, run for real in web
    // lib/telegram-runtime.db.test.ts).
    assert.match(publish, /const handed = botTokenOf\(readChildSettings\(tenant\)\);/);
    assert.match(publish, /livenessFor\(tg, handed \? botIdOf\(handed\) : null, childState\)/);
    // And a tenant with no bot file still says whether it trades.
    assert.match(publish, /publishTenantChildState\(shared, tenant, childState\)/);
  });
});
