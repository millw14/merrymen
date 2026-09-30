/**
 * Every tool's error result must be valid for a client that validates
 * structuredContent against the tool's outputSchema whenever it is present
 * (the v1 TypeScript SDK's callTool does, even with isError set). So an error
 * carries no structuredContent at all; its envelope rides in _meta and, as
 * JSON after a blank line, in the text.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Principal } from "./oauth/server";
import { OWNER_A, installFixtures, makeTestDb } from "./testing";
import { ERROR_META_KEY, runTool } from "./tool";
import { ALL_TOOLS } from "./tools";
import { ERROR_CODES } from "./errors";

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

const nobody: Principal = {
  tenant: OWNER_A, connectionId: "mcpcon_shape", clientId: "client", clientName: "Shape test", clientHost: null,
  kind: "oauth", scopes: new Set(), agentSlugs: [], tokenExpiresAt: 4_102_444_800, staff: false,
};

test("no tool's error result carries structuredContent; the envelope is in _meta and in the text", async () => {
  const d = await makeTestDb();
  restore = installFixtures(d);
  for (const def of ALL_TOOLS) {
    const r = await runTool(def, { __not_an_argument: 1 }, nobody, "trace-shape");
    assert.equal(r.isError, true, def.name);
    assert.equal("structuredContent" in r, false, `${def.name}: an error result must not carry structuredContent`);
    const env = (r._meta as Record<string, Record<string, unknown>> | undefined)?.[ERROR_META_KEY];
    assert.ok(env, `${def.name}: envelope in _meta`);
    assert.ok(Object.keys(ERROR_CODES).includes(String(env.code)), `${def.name}: ${String(env.code)}`);
    assert.equal(typeof env.message, "string");
    assert.equal(typeof env.retryable, "boolean");
    assert.equal(env.trace_id, "trace-shape");
    const text = (r.content[0] as { text: string }).text;
    assert.match(text, new RegExp(`^Error ${String(env.code)}: `));
    assert.deepEqual(JSON.parse(text.slice(text.indexOf("\n\n") + 2)).error, env, `${def.name}: the text carries the same envelope`);
  }
});
