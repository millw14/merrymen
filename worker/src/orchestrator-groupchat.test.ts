/**
 * The group chat's glue in the orchestrator — the few lines of orchestrator.ts
 * the room depends on, pinned where a busy file's edits cannot quietly drop them.
 *
 * The room itself is tested under groupchat/. What lives here is what only the
 * orchestrator can get wrong: whether the room's key reaches a child, whether
 * the serial loop waits on the pass, whether FLEET_HALT silences it, how the
 * operator's knobs are read, and what the boot log says. The structural checks
 * read orchestrator.ts through the TypeScript parser, so a comment or a string
 * that happens to contain the words cannot satisfy them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

process.env.MERRYMEN_HOME = path.join(process.cwd(), ".test-orch-groupchat-home");
process.env.MERRYMEN_HOSTED = "1";
process.env.GROQ_API_KEY = "house-groq-key";
process.env.MERRYMEN_GROUPCHAT_LLM_KEY = "gsk_room_only_key_never_to_a_child";

const { childEnv, groupChatEnv, groupChatModelWarning } = await import("./orchestrator");
const { SETTINGS_DEFAULTS } = await import("../../packages/core/src/index");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "orchestrator.ts"), "utf8");
const AST = ts.createSourceFile("orchestrator.ts", SRC, ts.ScriptTarget.Latest, true);

function all(root: ts.Node, keep: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (keep(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

function callsTo(root: ts.Node, name: string): ts.CallExpression[] {
  return all(root, (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) as ts.CallExpression[];
}

function fn(name: string): ts.FunctionDeclaration {
  const f = AST.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(f?.body, `function ${name} not found in orchestrator.ts`);
  return f;
}

function within(node: ts.Node, ancestor: ts.Node): boolean {
  for (let p: ts.Node | undefined = node; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

describe("the room's key never reaches a child", () => {
  it("childEnv strips MERRYMEN_GROUPCHAT_LLM_KEY and still passes the house keys", () => {
    const env = childEnv("0xABCDef0000000000000000000000000000000001");
    assert.equal(env.MERRYMEN_GROUPCHAT_LLM_KEY, undefined, "a child holding the room's key could spend it on anything");
    assert.equal(env.GROQ_API_KEY, "house-groq-key", "the strip is of the room's key only, not the house keys");
  });
});

describe("the pass is started, never awaited, and only when the fleet is not halted", () => {
  it("startGroupChatPass() is called once, as a bare statement, after `await runNewsPass();` in the not-halted branch", () => {
    const loop = fn("runOrchestrator");
    const sites = callsTo(AST, "startGroupChatPass");
    assert.equal(sites.length, 1, "one call site");
    const call = sites[0]!;
    assert.ok(within(call, loop), "called from the main loop");
    const stmt = call.parent;
    assert.ok(ts.isExpressionStatement(stmt), "a bare statement: no await, no return, nothing that waits on it");

    const branch = stmt.parent;
    assert.ok(ts.isBlock(branch), "directly in a block");
    const ifs = branch.parent;
    assert.ok(
      ts.isIfStatement(ifs) && ifs.elseStatement === branch && ifs.expression.getText() === "haltRequested()",
      "inside the else of `if (haltRequested())`, so FLEET_HALT silences the room too",
    );

    const news = branch.statements.findIndex((s) => s.getText() === "await runNewsPass();");
    assert.ok(news >= 0, "the news pass is in the same branch");
    assert.ok(news < branch.statements.indexOf(stmt), "after the news pass, so the mirror has landed the fills the room calls");
  });

  it("nothing awaits the pass", () => {
    const start = fn("startGroupChatPass");
    assert.ok(!start.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword), "startGroupChatPass is synchronous");
    const runs = callsTo(AST, "runGroupChatPass");
    assert.equal(runs.length, 1, "one caller of runGroupChatPass");
    assert.ok(within(runs[0]!, start), "and it is startGroupChatPass, behind the in-flight latch");
    const awaited = all(AST, (n) => ts.isAwaitExpression(n) && /\b(?:start|run)GroupChatPass\b/.test(n.expression.getText()));
    assert.deepEqual(awaited.map((n) => n.getText()), []);
  });
});

describe("the room's profile is recorded before the early return", () => {
  it("tenantChatProfile.set precedes `if (!settings) return null` in the same block of writeSettingsForChild", () => {
    const f = fn("writeSettingsForChild");
    const set = all(
      f,
      (n) => ts.isCallExpression(n) && n.expression.getText() === "tenantChatProfile.set",
    )[0] as ts.CallExpression | undefined;
    assert.ok(set, "writeSettingsForChild records the profile");
    const stmt = set.parent;
    assert.ok(ts.isExpressionStatement(stmt) && ts.isBlock(stmt.parent), "unconditionally, as its own statement");
    const block = stmt.parent;
    const early = block.statements.findIndex(
      (s) => ts.isIfStatement(s) && s.expression.getText() === "!settings" && ts.isReturnStatement(s.thenStatement),
    );
    assert.ok(early >= 0, "the early return is in the same block");
    assert.ok(block.statements.indexOf(stmt) < early, "a tenant with no saved settings still gets a (default) profile");
  });
});

describe("groupChatEnv reads the knobs the way an operator means them", () => {
  it("unset and set-but-blank are both the default", () => {
    assert.deepEqual(groupChatEnv({}), { off: null, perHour: undefined, llmPerDay: undefined, notes: [] });
    const blank = groupChatEnv({ MERRYMEN_GROUPCHAT_PER_HOUR: "", MERRYMEN_GROUPCHAT_LLM_PER_DAY: "  " });
    assert.equal(blank.llmPerDay, undefined, "a cleared LLM_PER_DAY must not read as 0 and switch the model off");
    assert.equal(blank.perHour, undefined);
    assert.deepEqual(blank.notes, []);
  });

  it("readable values pass through, padded or not", () => {
    const k = groupChatEnv({ MERRYMEN_GROUPCHAT_PER_HOUR: " 60 ", MERRYMEN_GROUPCHAT_LLM_PER_DAY: "100" });
    assert.equal(k.perHour, 60);
    assert.equal(k.llmPerDay, 100);
    assert.equal(k.off, null);
    assert.deepEqual(k.notes, []);
    assert.equal(groupChatEnv({ MERRYMEN_GROUPCHAT_LLM_PER_DAY: "0" }).llmPerDay, 0, "0 is a real budget: templates only");
  });

  it("MERRYMEN_GROUPCHAT=0 is off, and says so", () => {
    for (const v of ["0", " 0 "]) {
      const k = groupChatEnv({ MERRYMEN_GROUPCHAT: v });
      assert.ok(k.off && /MERRYMEN_GROUPCHAT=0/.test(k.off), JSON.stringify(v));
    }
    for (const v of ["", "1", "no", "false"]) assert.equal(groupChatEnv({ MERRYMEN_GROUPCHAT: v }).off, null, JSON.stringify(v));
  });

  it("a ceiling of zero lines an hour is a silent room, not the default 240", () => {
    for (const v of ["0", "0.4"]) {
      const k = groupChatEnv({ MERRYMEN_GROUPCHAT_PER_HOUR: v });
      assert.ok(k.off && /MERRYMEN_GROUPCHAT_PER_HOUR=0/.test(k.off), v);
    }
  });

  it("an unreadable ceiling keeps the default and says so", () => {
    for (const v of ["1,000", "-5", "lots", "Infinity"]) {
      const k = groupChatEnv({ MERRYMEN_GROUPCHAT_PER_HOUR: v });
      assert.equal(k.off, null, v);
      assert.equal(k.perHour, undefined, v);
      assert.equal(k.notes.length, 1, v);
      assert.match(k.notes[0] ?? "", /^groupchat: ignoring MERRYMEN_GROUPCHAT_PER_HOUR=/);
    }
  });

  it("an unreadable model allowance fails closed and says so", () => {
    for (const v of ["1,200", "-1", "many", "NaN"]) {
      const k = groupChatEnv({ MERRYMEN_GROUPCHAT_LLM_PER_DAY: v });
      assert.equal(k.llmPerDay, 0, `${v}: a budget the room cannot read is spent as none`);
      assert.equal(k.notes.length, 1, v);
      assert.match(k.notes[0] ?? "", /MERRYMEN_GROUPCHAT_LLM_PER_DAY=/);
    }
  });

  it("the orchestrator reads the knobs only through groupChatEnv", () => {
    const direct = all(
      AST,
      (n) =>
        ts.isPropertyAccessExpression(n) &&
        n.expression.getText() === "process.env" &&
        /^MERRYMEN_GROUPCHAT(?:_PER_HOUR|_LLM_PER_DAY)?$/.test(n.name.text),
    );
    assert.deepEqual(direct.map((n) => n.getText()), [], "read by hand, a blank or a zero means something else again");
  });
});

describe("a room key in the house's Groq org is warned about", () => {
  // Literal creds, not groupChatCreds(): which key the room accepts is voice.ts's
  // business and pinned in voice.test.ts. This pins only what the boot log says
  // about a key it accepted — a different string that may still be the house org.
  const ROOM = "gsk_a_different_string_same_org_maybe";
  const house = { GROQ_API_KEY: "gsk_house", MERRYMEN_GROUPCHAT_LLM_KEY: ROOM };
  const FLEET = SETTINGS_DEFAULTS.groqModel;

  it("warns when the room would run on the fleet's default trading model", () => {
    const w = groupChatModelWarning({ model: FLEET }, house);
    assert.ok(w, "a shared org would mean a shared per-model allowance");
    assert.match(w, /SEPARATE Groq organization/);
    assert.ok(!w.includes(ROOM) && !w.includes("gsk_house"), "never a key in the log");
    assert.ok(groupChatModelWarning({ model: ` ${FLEET.toUpperCase()} ` }, house), "case and padding do not hide it");
  });

  it("warns on the fleet's overridden model too, and not on the default it replaced", () => {
    const env = { ...house, MERRYMEN_GROQ_MODEL: " llama-9-fast " };
    assert.ok(groupChatModelWarning({ model: "llama-9-fast" }, env));
    assert.equal(groupChatModelWarning({ model: FLEET }, env), null);
  });

  it("is quiet when the models differ, when there is no house Groq key, or with no model at all", () => {
    assert.equal(groupChatModelWarning({ model: "some-other-model" }, house), null);
    assert.equal(groupChatModelWarning({ model: FLEET }, { MERRYMEN_GROUPCHAT_LLM_KEY: ROOM }), null);
    assert.equal(groupChatModelWarning({ model: FLEET }, { ...house, GROQ_API_KEY: "  " }), null);
    assert.equal(groupChatModelWarning(null, house), null);
  });

  it("is quiet when the operator has said in so many words that the room may share", () => {
    assert.equal(groupChatModelWarning({ model: FLEET }, { ...house, MERRYMEN_GROUPCHAT_SHARE_HOUSE_KEY: "1" }), null);
  });
});

describe("the boot log", () => {
  const run = fn("runGroupChatPass");
  const logged = callsTo(run, "log").map((c) => c.arguments.map((a) => a.getText()).join(", "));

  it("logs plan().why as is — it carries its own prefix", () => {
    assert.ok(logged.includes("groupChat.plan().why"), "the plan is logged");
    const doubled = all(
      AST,
      (n) => ts.isTemplateExpression(n) && n.templateSpans.some((s) => s.expression.getText() === "groupChat.plan().why"),
    );
    assert.deepEqual(doubled.map((n) => n.getText()), [], "a doubled 'groupchat: groupchat:' prefix");
  });

  it("says why the voice is what it is, and warns on a shared model", () => {
    assert.ok(logged.includes("describeCreds(creds)"), "a refused key must say why, not just 'templates only'");
    assert.equal(callsTo(run, "groupChatModelWarning").length, 1, "the same-model warning is checked at boot");
  });
});
