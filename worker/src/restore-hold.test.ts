/**
 * A FAILED PAPER RESTORE HOLDS THE TENANT; IT DOES NOT TAKE ITS BOT DOWN.
 *
 * The gate in spawnChild returned before the owner's link was restored and
 * before anything was spawned, and the trading child was the only process
 * that polled the owner's bot. So a practice book that would not restore made
 * the bot silent for as long as the book stayed broken: days, in the incident
 * this came from. Now the tenant is held: a hold process answers the bot, and
 * the tenant is kept out of everything that trades, mirrors or ferries.
 *
 * Read out of the source, through the TypeScript parser where the shape
 * matters, in the style of telegram-restore.test.ts and restart-storm.test.ts:
 * these are one branch and a handful of loops, and the failure they guard
 * against is silent. restore-hold.integration.test.ts drives the same paths
 * through the real reconcile(); telegram/hold.integration.test.ts drives the
 * hold process.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import ts from "typescript";
import { wrapSqlite } from "./db";
import {
  TELEGRAM_CONDITION_ALERTS_DDL,
  TELEGRAM_HOLD_NOTIFIED_DDL,
  TELEGRAM_LIVENESS_DDL,
  TELEGRAM_STATE_DDL,
  clearHoldNotified,
  ensureTelegramSchema,
  holdNotifiedClasses,
  recordHoldNotified,
} from "./telegram-store";
import { UNCLASSIFIED_BLOCK, holdNoticeText, holdText, restoreBlockClass } from "./restore-block";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ORCH = readFileSync(path.join(SRC, "orchestrator.ts"), "utf8");
const AST = ts.createSourceFile("orchestrator.ts", ORCH, ts.ScriptTarget.Latest, true);

const fn = (name: string): ts.FunctionDeclaration => {
  const f = AST.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(f?.body, `${name} must exist`);
  return f;
};
const all = (root: ts.Node, keep: (n: ts.Node) => boolean): ts.Node[] => {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (keep(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
};
const calls = (root: ts.Node, name: string) =>
  all(root, (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) as ts.CallExpression[];
/** Every `for (const … of <expr>)` in `root` whose iterated expression reads `name`. */
const loopsOver = (root: ts.Node, name: string) =>
  all(root, (n) => ts.isForOfStatement(n) && new RegExp(`\\b${name}\\b`).test(n.expression.getText())) as ts.ForOfStatement[];

describe("the restore gate holds instead of returning", () => {
  it("THE FAILING BRANCH HANDS THE TENANT TO spawnHolder BEFORE IT RETURNS", () => {
    const spawn = fn("spawnChild");
    const branch = all(spawn, (n) => ts.isIfStatement(n) && n.expression.getText() === "settings?.paperTradingEnabled === true")[0] as
      | ts.IfStatement
      | undefined;
    assert.ok(branch, "the practice-book gate is still there: a book we cannot restore must not restart its cash");
    const held = calls(branch.thenStatement, "spawnHolder")[0];
    const ret = all(branch.thenStatement, ts.isReturnStatement)[0];
    assert.ok(held && ret && held.getEnd() < ret.getStart(), "held first, then no worker");
    assert.ok(ts.isAwaitExpression(held.parent), "and awaited, inside the spawning claim");
    // Nothing else in spawnChild returns on a failed restore.
    const restore = calls(spawn, "tryPaperRestore")[0];
    assert.ok(restore, "the restore is one call now (tryPaperRestore)");
  });

  it("spawnHolder PUTS THE OWNER'S LINK BACK BEFORE ANYTHING POLLS THE BOT", () => {
    const hold = fn("spawnHolder");
    const link = calls(hold, "writeTelegramForChild")[0];
    const start = calls(hold, "startHolderProcess")[0];
    assert.ok(link && start, "it restores the link, and it starts the hold process");
    assert.ok(link.getEnd() < start.getStart(), "the link first: a link restored after the bot is polled is read from a replaced file");
    assert.equal(link.arguments.map((a) => a.getText()).join(","), "tenant");
    // Under the lease spawnChild checked, asked again after the last await.
    const late = calls(hold, "lateSpawnRefusal")[0];
    assert.ok(late && link.getEnd() < late.getStart() && late.getEnd() < start.getStart());
    for (const a of all(hold, ts.isAwaitExpression)) {
      if (ts.isAwaitExpression(a) && a.expression.getText() === "startHolderProcess(held)") continue;
      assert.ok(a.getEnd() < late.getStart(), "preparation finishes before the first late check");
    }
    // Pacing adds a wait inside startHolderProcess. It checks the same lease,
    // halt and kill conditions again after that wait and before the OS fork.
    const started = fn("startHolderProcess");
    const slot = calls(started, "waitForSpawnSlot")[0];
    const last = calls(started, "lateSpawnRefusal")[0];
    const fork = calls(started, "spawn")[0];
    assert.ok(slot && last && fork && slot.getEnd() < last.getStart() && last.getEnd() < fork.getStart());
    // A tenant with no bot is still recorded, so reconcile stops retrying it every pass.
    const recorded = all(hold, (n) => ts.isCallExpression(n) && n.expression.getText() === "holders.set")[0];
    const noBot = all(hold, (n) => ts.isIfStatement(n) && n.expression.getText() === "!holderBotReady(settings)")[0];
    assert.ok(recorded && noBot && recorded.getEnd() < noBot.getStart(), "held before the no-bot return");
  });

  it("THE HOLD PROCESS RUNS WITH THE CHILD'S ENV, AND ITS OWN ENTRY", () => {
    const start = fn("startHolderProcess").body!.getText();
    assert.match(start, /spawn\(\s*process\.execPath,\s*\[`--max-old-space-size=\$\{HOLDER_MAX_OLD_SPACE_MB\}`, "--import", "tsx", HOLD_ENTRY\]/);
    assert.match(start, /env: childEnv\(tenant\)/, "the same strip: no DATABASE_URL, no store key");
    assert.match(ORCH, /const HOLD_ENTRY = path\.join\(fileURLToPath\(new URL\("\.", import\.meta\.url\)\), "telegram-hold\.ts"\);/);
    assert.ok(existsSync(path.join(SRC, "telegram-hold.ts")));
  });

  it("A HELD TENANT IS NEVER A CHILD: spawnHolder and the retry never touch `children`", () => {
    for (const name of ["spawnHolder", "startHolderProcess", "watchHolder", "retryHold", "handHoldBack", "standDownHolder"]) {
      assert.doesNotMatch(fn(name).body!.getText(), /children\.set\(/, `${name} must not put a held tenant in children`);
    }
  });
});

describe("held tenants reach only the loops they belong in", () => {
  it("THE FERRIES AND THE WATCHDOG ITERATE `children` ONLY", () => {
    for (const name of ["ferryCommands", "ferryOrdersNow", "watchdog"]) {
      assert.doesNotMatch(fn(name).body!.getText(), /\bholders\b/, `${name} must not see a held tenant`);
    }
    assert.ok(loopsOver(fn("ferryCommands"), "children").length > 0, "ferryCommands walks children");
    assert.match(fn("ferryOrdersNow").body!.getText(), /\[\.\.\.children\.entries\(\)\]/, "ferryOrdersNow walks children");
    assert.ok(loopsOver(fn("watchdog"), "children").length > 0, "the watchdog walks children");
  });

  it("AND NOTHING ELSE IN THE ORCHESTRATOR SO MUCH AS READS `holders`", () => {
    // Named by the functions that may, rather than by the passes that may
    // not: the builder and news desks, the room, the X poster, the fleet
    // report and whatever pass comes next all walk `children`, and a new one
    // that reached for `holders` fails here without anybody listing it.
    const readers = AST.statements
      .filter((st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && !!st.body && /\bholders\b/.test(st.body.getText()))
      .map((f) => f.name!.text)
      .sort();
    assert.deepEqual(readers, [
      "adoptHolderForTest",
      "handHoldBack",
      "honourFleetHalt",
      "isHeldForTest",
      "localChildProcessCount",
      "mirrorLedgers",
      "reconcile",
      "refreshGrantForChild",
      "retireExpiredGrants",
      "retryHold",
      "runOrchestrator",
      "scheduleRestart",
      "spawnChild",
      "spawnHolder",
      "standDownHolder",
      "standDownLostLeasesNow",
      "startHolderProcess",
      "watchHolder",
    ]);
  });

  it("THE MIRROR'S HOLDERS LOOP PUBLISHES TELEGRAM, AND NEVER OPENS OR COPIES A LEDGER", () => {
    const mirror = fn("mirrorLedgers");
    const loops = loopsOver(mirror, "holders");
    assert.equal(loops.length, 1, "one loop over held tenants");
    const body = loops[0]!.statement.getText();
    // Published as held, with the class its owner is told, so the dashboard
    // says trading is held rather than "connected" (plan §3.1).
    assert.match(body, /await publishChildTelegram\(tenant as `0x\$\{string\}`, shared, `held:\$\{held\.cls\}`\);/);
    assert.match(body, /if \(!lease \|\| !lease\.healthy\(\)\) continue;/, "only under the lease");
    for (const never of ["mirrorTenant", "openChildLedger", "mirrorSerially", "writePeersFor", "heldEquitySymbols"]) {
      assert.ok(!body.includes(never), `the holders loop must not call ${never}`);
    }
    // And a fleet whose only tenants are held still gets to that loop.
    assert.match(mirror.body!.getText(), /if \(!url \|\| \(children\.size === 0 && holders\.size === 0\)\) return;/);
  });

  it("A LEASE KEPT FOR A HOLD PROCESS THAT HAS NOT EXITED SPEAKS FOR NOBODY AND MIRRORS NOTHING", () => {
    // Kept past the stand-down only so no other replica starts beside that
    // process (reconcile's last loop, honourFleetHalt), and let go on its exit.
    const rec = fn("reconcile");
    const release = loopsOver(rec, "leases").find((l) => calls(l.statement, "releaseLease").length > 0 && /wanted\.has/.test(l.statement.getText()));
    assert.ok(release && /!holders\.get\(tenant\)\?\.leaving/.test(release.statement.getText()), "not released while its process lives");
    assert.match(fn("honourFleetHalt").body!.getText(), /if \(!kept\(t\)\) await releaseLease\(t\);/);
    assert.equal(calls(fn("watchHolder"), "releaseLease").length, 1, "released when the exit is seen");
    // The mirror does not publish for such a tenant: its grant may be gone.
    const loop = loopsOver(fn("mirrorLedgers"), "holders")[0]!.statement.getText();
    const gate = loop.indexOf("if (!lease || !lease.healthy()) continue;");
    const skip = loop.indexOf("if (held.stoodDown) continue;");
    assert.ok(gate >= 0 && skip > gate && skip < loop.indexOf("publishChildTelegram("), "stood-down tenants are skipped before anything is published");
    // And the sweep of homes never mirrors a held book on its way out, lease or no lease.
    const sweep = calls(rec, "finalMirrorBeforeAnchor")[0]!;
    let guard: ts.Node = sweep;
    while (!ts.isIfStatement(guard)) guard = guard.parent;
    assert.match((guard as ts.IfStatement).expression.getText(), /!holders\.has\(tenant\)/);
  });

  it("RECONCILE STEPS ROUND A HELD TENANT, RETRIES ITS RESTORE, AND REFRESHES IT FIRST", () => {
    const rec = fn("reconcile");
    const skip = all(rec, (n) => ts.isIfStatement(n) && n.expression.getText() === "holders.has(lc)" && ts.isContinueStatement(n.thenStatement))[0];
    const spawnCall = calls(rec, "spawnChild")[0];
    assert.ok(skip && spawnCall && skip.getEnd() < spawnCall.getStart(), "the spawn loop skips it");
    assert.ok(calls(rec, "retryHold").length === 1, "the restore is retried from here");
    const refresh = loopsOver(rec, "holders").find((l) => /writeSettingsForChild/.test(l.statement.getText()));
    const childRefresh = loopsOver(rec, "children").find((l) => /writeSettingsForChild/.test(l.statement.getText()));
    assert.ok(refresh && childRefresh && refresh.getEnd() < childRefresh.getStart(), "held tenants' settings first, so the bot de-dupe sees their tokens");
    assert.match(refresh.statement.getText(), /writeSettingsForChild\(tenant as `0x\$\{string\}`, seenBots, holderClaims, botClaims\)/);
  });

  it("EVERY STAND-DOWN STANDS A HOLD PROCESS DOWN TOO", () => {
    const rec = fn("reconcile").body!.getText();
    // The lease loss now runs immediately on the socket callback, with
    // reconcile repeating it as a fallback. Both process types are signaled.
    assert.match(rec, /standDownLostLeasesNow\(\);/);
    const leaseLoss = fn("standDownLostLeasesNow").body!.getText();
    assert.match(leaseLoss, /for \(const \[tenant, lease\] of \[\.\.\.leases\]\)/);
    assert.ok(leaseLoss.indexOf("killChild(tenant)") >= 0 && leaseLoss.indexOf("killChild(tenant)") < leaseLoss.indexOf("standDownHolder(tenant)"));
    assert.match(leaseLoss, /standDownHolder\(tenant\);/);
    // The kill switch, with the home.
    const kill = loopsOver(fn("reconcile"), "holders").find((l) => /standDownHolder/.test(l.statement.getText()));
    assert.ok(kill && /rmSync\(childHome\(tenant\)/.test(kill.statement.getText()) && /wanted\.has\(tenant\)/.test(kill.statement.getText()));
    assert.ok(!/finalMirrorBeforeAnchor/.test(kill.statement.getText()), "a held book is never mirrored on the way out");
    // FLEET_HALT, one loop of which the main loop runs in place of a pass, and stop().
    const halt = fn("honourFleetHalt").body!.getText();
    assert.match(halt, /for \(const t of \[\.\.\.holders\.keys\(\)\]\) standDownHolder\(t\);/);
    const run = fn("runOrchestrator").body!.getText();
    assert.match(run, /if \(haltRequested\(\)\) \{\s*await honourFleetHalt\(\);\s*\} else \{/);
    assert.match(run, /for \(const held of holders\.values\(\)\) held\.proc\?\.kill\("SIGTERM"\);/);
  });

  it("THE HANDOVER STOPS THE HOLD PROCESS AND WAITS FOR IT BEFORE A WORKER STARTS", () => {
    const hand = fn("handHoldBack");
    const kill = all(hand, (n) => ts.isCallExpression(n) && n.expression.getText() === "proc.kill" && n.arguments[0]?.getText() === '"SIGTERM"')[0];
    const wait = all(hand, (n) => ts.isAwaitExpression(n) && /Promise\.race/.test(n.getText()))[0];
    const leave = all(hand, (n) => ts.isCallExpression(n) && n.expression.getText() === "holders.delete")[0];
    const spawn = calls(hand, "spawnChild")[0];
    assert.ok(kill && wait && leave && spawn, "stop, wait, leave, spawn");
    assert.ok(kill.getEnd() < wait.getStart() && wait.getEnd() < leave.getStart() && leave.getEnd() < spawn.getStart());
    // Nothing between leaving `holders` and spawnChild's own claim can interleave.
    const spawnAt = ts.isAwaitExpression(spawn.parent) ? spawn.parent.getStart() : spawn.getStart();
    const between = hand.body!.getText().slice(leave.getEnd() - hand.body!.getStart(), spawnAt - hand.body!.getStart());
    assert.doesNotMatch(between, /\bawait\b/);
    // A process still there when the wait ends keeps the tenant held: it
    // leaves `holders` only once an exit has been seen, never "anyway".
    const stuck = all(hand, (n) => ts.isIfStatement(n) && n.expression.getText() === "leaving")[0] as ts.IfStatement | undefined;
    assert.ok(stuck && all(stuck.thenStatement, ts.isReturnStatement).length === 1, "a hold process not yet gone returns before the handover");
    assert.ok(wait.getEnd() < stuck.getStart() && stuck.getEnd() < leave.getStart());
    assert.doesNotMatch(hand.body!.getText(), /anyway/);
    // And it is the only way out of a hold into trading: a restore that took,
    // or a gate that no longer holds. Neither spawns a worker itself.
    assert.equal(calls(fn("retryHold"), "spawnChild").length, 0);
    assert.equal(calls(fn("retryHold"), "handHoldBack").length, 1);
    const rec = fn("reconcile");
    const release = loopsOver(rec, "released")[0];
    assert.ok(release && calls(release, "handHoldBack").length === 1, "reconcile hands back what the gate no longer holds");
    const childRefresh = loopsOver(rec, "children").find((l) => /writeSettingsForChild/.test(l.statement.getText()));
    assert.ok(childRefresh && childRefresh.getEnd() < release.getStart(), "after the children's refresh, which would strip the worker's own token");
  });

  it("THE HOLDERS' REFRESH SKIPS A TENANT NO LONGER ELIGIBLE, AND ASKS THE GATE AGAIN", () => {
    const refresh = loopsOver(fn("reconcile"), "holders").find((l) => /writeSettingsForChild/.test(l.statement.getText()));
    assert.ok(refresh && ts.isBlock(refresh.statement));
    const first = refresh.statement.statements[0]!;
    assert.equal(
      first.getText(),
      "if (!eligible.has(tenant) || retiringExpired.has(tenant)) continue;",
      "a revoked or expired grant, including one still retiring, claims no bot before its settings are written",
    );
    assert.match(refresh.statement.getText(), /if \(stored && stored\.paperTradingEnabled !== true\) \{\s*released\.push\(held\);/);
    // The same test spawnChild's gate makes, or the two would disagree about who is held.
    assert.ok(all(fn("spawnChild"), (n) => ts.isIfStatement(n) && n.expression.getText() === "settings?.paperTradingEnabled === true").length === 1);
  });
});

/**
 * THE HOLD PROCESS IMPORTS NOTHING THAT TRADES, STORES OR THINKS — at any depth.
 *
 * The plan asks that telegram/hold.ts and telegram-hold.ts import none of the
 * store, the database, the ledger mirror, the model or the paper book. Checked
 * through every relative import they reach, not only their own, since a
 * forbidden module one hop away is loaded all the same. Type-only imports are
 * erased and do not count.
 *
 * Nor the Telegram groups' memory or persona. The hold writes a /forgetme and
 * what it passes over in groups down for whoever holds that memory
 * (tg-groups/forget-file.ts, held-groups.ts), and reaches no further.
 */
describe("the hold process's imports", () => {
  const FORBIDDEN = [
    "store.ts",
    "db.ts",
    "ledger-mirror.ts",
    "llm.ts",
    "paper-checkpoint.ts",
    "telegram/service.ts",
    "telegram/interpreter.ts",
    "telegram/executor.ts",
    "telegram/tg-groups/store.ts",
    "telegram/tg-groups/handler.ts",
  ];

  const runtimeImports = (file: string): string[] => {
    const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    for (const s of src.statements) {
      if (!ts.isImportDeclaration(s) && !ts.isExportDeclaration(s)) continue;
      if (ts.isImportDeclaration(s) && s.importClause?.isTypeOnly) continue;
      if (ts.isExportDeclaration(s) && (s.isTypeOnly || !s.moduleSpecifier)) continue;
      const spec = (s.moduleSpecifier as ts.StringLiteral).text;
      if (!spec.startsWith(".")) continue;
      // An import whose every binding is `type` is erased too.
      const named = ts.isImportDeclaration(s) ? s.importClause?.namedBindings : undefined;
      if (ts.isImportDeclaration(s) && !s.importClause?.name && named && ts.isNamedImports(named) && named.elements.every((e) => e.isTypeOnly)) continue;
      const base = path.resolve(path.dirname(file), spec);
      const resolved = [base, `${base}.ts`, path.join(base, "index.ts")].find((p) => existsSync(p) && p.endsWith(".ts"));
      if (resolved) out.push(resolved);
    }
    return out;
  };
  const reach = (entry: string): Set<string> => {
    const seen = new Set<string>();
    const todo = [entry];
    while (todo.length) {
      const f = todo.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      todo.push(...runtimeImports(f));
    }
    return seen;
  };

  for (const entry of ["telegram/hold.ts", "telegram-hold.ts"]) {
    it(`${entry} reaches no store, database, ledger, model or paper module`, () => {
      const reached = [...reach(path.join(SRC, entry))].map((f) => path.relative(SRC, f).split(path.sep).join("/"));
      for (const bad of FORBIDDEN) assert.ok(!reached.includes(bad), `${entry} reaches ${bad}: ${reached.join(", ")}`);
      // And directly, by the names the plan gives.
      const own = readFileSync(path.join(SRC, entry), "utf8");
      for (const bad of ["../store", "../db", "../ledger-mirror", "../llm", "../paper-checkpoint", "./store", "./db", "./ledger-mirror", "./llm", "./paper-checkpoint"]) {
        assert.ok(!new RegExp(`from "${bad.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`).test(own), `${entry} imports ${bad}`);
      }
    });
  }

  it("the walk does find a forbidden module when there is one (control)", () => {
    const reached = [...reach(path.join(SRC, "telegram/service.ts"))].map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    assert.ok(reached.includes("store.ts") && reached.includes("llm.ts"));
    assert.ok(reached.includes("telegram/tg-groups/store.ts") && reached.includes("telegram/tg-groups/handler.ts"));
  });
});

/**
 * A PRACTICE RESET HONOURED WHILE HELD (plan §3.4), where the integration test
 * cannot look: it runs with no DATABASE_URL, so the anchor file never carries
 * an epoch, and the lease there is the no-op one that is always healthy.
 */
describe("a held tenant's practice reset", () => {
  it("spawnChild HONOURS IT ONLY FOR A PRACTICE BOOK THAT HAS JUST FAILED TO RESTORE, AND WRITES THE ANCHOR AGAIN BEFORE RESTORING", () => {
    const spawn = fn("spawnChild");
    const honour = calls(spawn, "honourHeldPaperReset");
    assert.equal(honour.length, 1);
    // Asked only on the true side of `<failed, practice> ? … : null`.
    const asked = all(spawn, (n) => ts.isConditionalExpression(n) && calls(n.whenTrue, "honourHeldPaperReset").length === 1)[0] as
      | ts.ConditionalExpression
      | undefined;
    assert.ok(asked, "the reset is looked at only on one side of a condition");
    assert.equal(asked.condition.getText(), "!restore.ok && settings?.paperTradingEnabled === true", "after a failed restore, for the book the gate holds");
    assert.equal(honour[0]!.arguments.map((a) => a.getText()).join(","), "tenant,smartAccount,lease", "under the lease spawnChild checked");
    // The anchor was read before the reset closed its epoch; the worker files
    // every row under the anchor's. So it is written again, then restored.
    const gate = all(spawn, (n) => ts.isIfStatement(n) && n.expression.getText() === "honour?.applied")[0] as ts.IfStatement | undefined;
    assert.ok(gate && asked.getEnd() < gate.getStart(), "only when it was applied");
    const anchor = calls(gate.thenStatement, "writeBootstrapForChild")[0];
    const again = calls(gate.thenStatement, "tryPaperRestore")[0];
    assert.ok(anchor && again && anchor.getEnd() < again.getStart(), "the anchor again, then the restore again");
    // And the gate's own branch comes after, so a reset that did not happen
    // still holds, and hands spawnHolder what was looked at.
    const hold = all(spawn, (n) => ts.isIfStatement(n) && n.expression.getText() === "settings?.paperTradingEnabled === true")[0] as ts.IfStatement;
    assert.ok(gate.getEnd() < hold.getStart());
    const holder = calls(hold.thenStatement, "spawnHolder")[0]!;
    assert.equal(holder.arguments.at(-1)!.getText(), "honour", "so the hold does not look at the same reset again this pass");
  });

  it("retryHold HONOURS IT ONLY AFTER ITS OWN RESTORE FAILED, INSIDE THE RETRY'S CLAIM, AND HANDS BACK ONLY THROUGH handHoldBack", () => {
    const retry = fn("retryHold");
    const guard = all(retry, (n) => ts.isIfStatement(n) && calls(n.thenStatement, "honourHeldPaperReset").length === 1)[0] as ts.IfStatement;
    assert.ok(guard);
    assert.equal(guard.expression.getText(), "!restore.ok && holders.get(tenant) === held");
    const applied = all(guard.thenStatement, (n) => ts.isIfStatement(n) && n.expression.getText() === "honour.applied")[0] as ts.IfStatement;
    assert.ok(applied, "restored again only when the book was started over");
    assert.equal(calls(applied.thenStatement, "tryPaperRestore").length, 1, "restored again");
    const tryStmt = all(retry, ts.isTryStatement)[0] as ts.TryStatement;
    assert.ok(tryStmt.tryBlock.getStart() < guard.getStart() && guard.getEnd() < tryStmt.tryBlock.getEnd(), "while `retrying` is set");
    assert.equal(calls(retry, "handHoldBack").length, 1);
  });

  it("A RESET THAT COULD NOT BE DECIDED IS ASKED ABOUT AGAIN AT THE QUICK PACE, AND ONLY A RETRY THAT RAN USES UP A PRESS", () => {
    const retry = fn("retryHold");
    const pace = calls(retry, "scheduleHoldRetry")[0]!;
    assert.equal(pace.arguments[1]!.getText(), "unsure ? UNCLASSIFIED_BLOCK : cls", "an unsure honour does not wait out the backoff");
    // The first thing it does is decline when holdMayLeave says no, and it
    // says so: `return false`, before anything is tried.
    const first = retry.body!.statements.find((st) => ts.isIfStatement(st)) as ts.IfStatement;
    assert.equal(first.expression.getText(), "!holdMayLeave(tenant)");
    assert.equal(first.thenStatement.getText(), "return false;");
    const hold = fn("spawnHolder").body!.getText();
    assert.match(hold, /resetSeen: honour\?\.looked \?\? null/, "a hold starts having seen what its spawn looked at");
    assert.match(hold, /scheduleHoldRetry\(held, honour\?\.transient \? UNCLASSIFIED_BLOCK : restoreBlockClass\(reason\)\)/);
    const rec = fn("reconcile").body!.getText();
    assert.match(rec, /if \(\(await retryHold\(held\)\) && early\) held\.resetSeen = ask;/, "marked seen only once the retry ran");
  });

  it("THE WRITE IS REFUSED WHEN ANYTHING THAT STOPS A SPAWN WOULD STOP IT, AND THE CLAIM IS deliverCommand's", () => {
    const honour = fn("honourHeldPaperReset").body!.getText();
    assert.match(honour, /mayWrite: \(\) => \(lease \? lateSpawnRefusal\(tenant, lease\) : "it holds no lease"\)/);
    const held = readFileSync(path.join(SRC, "held-reset.ts"), "utf8");
    const deliver = fn("deliverCommand").body!.getText();
    const claim = 'UPDATE agent_commands SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL';
    assert.ok(deliver.includes(claim) && held.includes(claim), "the same claim, so one of the two wins");
    // Inside the one transaction, with the reset and the answer.
    const tx = held.slice(held.indexOf("shared.tx(async (db) => {"));
    for (const step of [claim, "resetBlockedPaperBookIn(db, account, decision.epoch)", 'SET done_at = ?, result = ? WHERE id = ?']) {
      assert.ok(tx.includes(step), `inside the transaction: ${step}`);
    }
  });
});

describe("what an owner is told", () => {
  it("the class is a fixed phrase with no figures, whatever the restore said", () => {
    const reasons = [
      "paper fills are newer than the recoverable valuation",
      "the recoverable valuation does not add up (cash+vault+positions-equity=0.0066)",
      "paper positions do not value (positions=3)",
      "invalid paper checkpoint: MU is held with no paper cost basis",
      "invalid paper checkpoint: NVDA basis 71971347499786536 raw disagrees with 0.07197134749978654 shares at multiplier 1.0007751591646306",
      "invalid paper checkpoint: cash is -1, not a non-negative number",
      "connect ECONNREFUSED 10.0.0.7:5432",
    ];
    const classes = reasons.map(restoreBlockClass);
    assert.deepEqual(classes, [
      "trades newer than the last valuation",
      "the last valuation doesn't add up",
      "holdings could not be priced",
      "a holding has no cost basis",
      "cost basis and holdings disagree",
      "the saved book is unreadable",
      "restore error",
    ]);
    for (const c of classes) {
      for (const resettable of [true, false]) {
        assert.ok(!/\d/.test(holdText(c, resettable)) && !/\d/.test(holdNoticeText(c, resettable)), `no figure in what the owner reads: ${c}`);
      }
    }
  });
});

describe("a hold that names no cause", () => {
  it("IS TOLD AS A RETRY: no \"couldn't be restored\", and no reset offered, whatever the settings allow", () => {
    for (const resettable of [true, false]) {
      for (const text of [holdText(UNCLASSIFIED_BLOCK, resettable), holdNoticeText(UNCLASSIFIED_BLOCK, resettable)]) {
        assert.doesNotMatch(text, /Start over|start practice over|couldn't be restored|wait for a fix|team has been alerted/);
        assert.match(text, /trying again/);
        assert.match(text, /Nothing was traded or lost\./);
      }
    }
  });

  it("a named class still offers the reset where it would be honoured, and only there", () => {
    const named = restoreBlockClass("paper fills are newer than the recoverable valuation");
    assert.match(holdText(named, true), /couldn't be restored after a server update \(trades newer than the last valuation\).*Wallet → Start over/);
    assert.match(holdNoticeText(named, true), /Wallet → Start over/);
    assert.doesNotMatch(holdText(named, false), /Start over/);
  });
});

/**
 * THE NOTICE IS SENT ONCE PER HOLD, ACROSS REDEPLOYS.
 *
 * The dedupe lives in tenant_telegram.hold_notified, keyed on the class, and
 * is added with the same guarded ALTER the mirror uses. Driven over sqlite
 * through wrapSqlite; the Postgres side runs the same statements.
 */
describe("the durable notice record", () => {
  it("records each class once, reads them back, clears them when the book restores, and survives its ALTER running twice", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await db.exec(TELEGRAM_STATE_DDL);
      await db.exec(TELEGRAM_HOLD_NOTIFIED_DDL);
      await assert.rejects(db.exec(TELEGRAM_HOLD_NOTIFIED_DDL), "the second ALTER throws, which the callers swallow");
      await db.prepare("INSERT INTO tenant_telegram (tenant, owner_id, updated_at) VALUES (?, ?, 0)").run("0xabc", 4242);
      assert.deepEqual(await holdNotifiedClasses(db, "0xABC"), []);
      await recordHoldNotified(db, "0xABC", "a holding has no cost basis");
      assert.deepEqual(await holdNotifiedClasses(db, "0xabc"), ["a holding has no cost basis"], "told: the next pass and the next deploy say nothing");
      await recordHoldNotified(db, "0xabc", "trades newer than the last valuation");
      await recordHoldNotified(db, "0xabc", "a holding has no cost basis");
      assert.deepEqual(
        await holdNotifiedClasses(db, "0xabc"),
        ["a holding has no cost basis", "trades newer than the last valuation"],
        "a set: a hold that goes back to an earlier cause has already said it",
      );
      await clearHoldNotified(db, "0xabc");
      assert.deepEqual(await holdNotifiedClasses(db, "0xabc"), [], "restored: the next hold is news again");
      assert.deepEqual(await holdNotifiedClasses(db, "0xnobody"), []);
      // A bare class, as a value that is not a list reads.
      await db.prepare("UPDATE tenant_telegram SET hold_notified = ? WHERE tenant = ?").run("restore error", "0xabc");
      assert.deepEqual(await holdNotifiedClasses(db, "0xabc"), ["restore error"]);
    } finally {
      raw.close();
    }
  });

  it("THE ORCHESTRATOR'S ONE SEQUENCE (ensureTelegramSchema): every column on the first run, and on sqlite every ALTER after it fails without throwing", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      assert.deepEqual(await ensureTelegramSchema(db), [], "a fresh database: the table and every column, nothing failed");
      const cols = (raw.prepare("PRAGMA table_info(tenant_telegram)").all() as { name: string }[]).map((c) => c.name);
      for (const c of ["hold_notified", "bot_id", "poll_ok_at", "poll_err", "poll_err_at", "child_state", "condition_alerts"]) assert.ok(cols.includes(c), c);
      await db.prepare("INSERT INTO tenant_telegram (tenant, owner_id, updated_at) VALUES (?, ?, 0)").run("0xabc", 4242);
      // sqlite's ADD COLUMN has no IF NOT EXISTS: each ALTER fails, and is handed back, not thrown.
      const again = await ensureTelegramSchema(db);
      const migrations = [TELEGRAM_HOLD_NOTIFIED_DDL, ...TELEGRAM_LIVENESS_DDL, TELEGRAM_CONDITION_ALERTS_DDL];
      assert.equal(again.length, migrations.length);
      assert.ok(again.every((e) => /duplicate column/i.test(String(e))), again.map(String).join("; "));
      for (const ddl of migrations) {
        const column = /ADD COLUMN (\w+)/.exec(ddl)?.[1];
        assert.ok(column && again.some((e) => String(e).includes(column)), `duplicate-column result for ${column}`);
      }
      assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM tenant_telegram").get() as { n: number }).n, 1, "and the rows survive it");
    } finally {
      raw.close();
    }
  });
});
