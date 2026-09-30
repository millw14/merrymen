import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import { prepareAgentGrant } from "./session";

const source = ts.createSourceFile("session.ts", readFileSync(new URL("./session.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function body(name: string): ts.Block {
  const fn = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(fn?.body, `${name} must have an implementation`);
  return fn.body;
}
function identifiers(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (child: ts.Node) => { if (ts.isIdentifier(child)) names.add(child.text); ts.forEachChild(child, visit); };
  visit(node);
  return names;
}

describe("embedded grant preparation shares the permission wall without dashboard delivery", () => {
  it("the preparation core has no app auth, storage or worker-handoff side effects", () => {
    const names = identifiers(body("prepareGrantCore"));
    for (const forbidden of ["fetch", "localStorage", "postGrant", "signBinding", "archivePreviousGrant", "findInjectedProvider", "requestAccount"]) {
      assert.ok(!names.has(forbidden), `preparation must not use ${forbidden}`);
    }
    for (const canonical of ["buildWallPolicies", "wallSignable", "serializePermissionAccount", "assertDerivedAccount"]) {
      assert.ok(names.has(canonical), `preparation must preserve ${canonical}`);
    }
  });

  it("embedded preparation has an explicit external signer and never supplies owner-key material or a Privy identity", () => {
    const entry = body("prepareAgentGrant").getText(source);
    assert.match(entry, /binding: "external-owner"/);
    assert.doesNotMatch(entry, /privateKey|hostedAs|did:|privy/);
    const core = body("prepareGrantCore").getText(source);
    assert.match(core, /ownerSigner\.binding !== "legacy-wallet-owner-v1"\s*\? \{\}/);
    assert.ok(!identifiers(body("prepareAgentGrant")).has("mintGrant"));
  });

  it("dashboard minting still delivers only after running that same preparation core", () => {
    const dashboard = body("mintGrant").getText(source);
    const prepareAt = dashboard.indexOf("prepareGrantCore(");
    assert.ok(prepareAt >= 0);
    for (const effect of ["signBinding(", "archivePreviousGrant(", "localStorage.setItem(", "postGrant("]) {
      assert.ok(dashboard.indexOf(effect) > prepareAt, `${effect} must stay after signing`);
    }
  });

  it("rejects a missing signer before any RPC or signature work", async () => {
    await assert.rejects(prepareAgentGrant(null as never, {} as never), /explicit wallet signer/);
  });
});
