/**
 * /api/mcp/health reports both addresses the server answers on, so an
 * operator sees a directory profile that a bad
 * MERRYMEN_MCP_DIRECTORY_RESOURCE_URL (or the kill switch) turned off.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpConfig } from "./config";
import { directoryHealth, mcpHealth } from "./health";
import { makeTestDb, testConfig } from "./testing";

const envOf = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
const BASE = { MERRYMEN_HOSTED: "1", DATABASE_URL: "postgres://x", MERRYMEN_OAUTH_ISSUER: "https://mcp.test" };

test("health reports the canonical and the directory endpoint", async () => {
  const d = await makeTestDb();
  const res = await mcpHealth({ cfg: testConfig(), env: envOf({}), mcp: async () => d });
  assert.equal(res.status, 200);
  const body = await res.json() as { ready: boolean; endpoint: string; directory: { endpoint: string | null; why: string | null } };
  assert.equal(body.ready, true);
  assert.equal(body.endpoint, "https://app.test/mcp");
  assert.deepEqual(body.directory, { endpoint: "https://app.test/mcp/directory", why: null });
});

test("health says the directory is off, and why, without echoing the bad value", async () => {
  const d = await makeTestDb();
  const off = await mcpHealth({ cfg: testConfig({ directoryResource: "" }), env: envOf({ MERRYMEN_MCP_DIRECTORY: "0" }), mcp: async () => d });
  assert.equal(off.status, 200, "the directory being off does not make the server unready");
  const body = await off.json() as { directory: { endpoint: string | null; why: string } };
  assert.equal(body.directory.endpoint, null);
  assert.match(body.directory.why, /MERRYMEN_MCP_DIRECTORY=0/);

  const bad = "http://evil.test/listing?x=1";
  const env = envOf({ ...BASE, MERRYMEN_MCP_DIRECTORY_RESOURCE_URL: bad });
  const cfg = mcpConfig(env);
  assert.equal(cfg.directoryResource, "", "config turned the bad URL off");
  const h = directoryHealth(cfg, env);
  assert.equal(h.endpoint, null);
  assert.match(h.why ?? "", /MERRYMEN_MCP_DIRECTORY_RESOURCE_URL is not usable/);
  assert.ok(!(h.why ?? "").includes(bad));
  // One on the canonical path is refused too, and reported the same way.
  const same = envOf({ ...BASE, MERRYMEN_MCP_DIRECTORY_RESOURCE_URL: "https://mcp.test/mcp/" });
  assert.match(directoryHealth(mcpConfig(same), same).why ?? "", /not usable/);
  // So is one on a path the directory is not served at, and the reason names the path it must have.
  const elsewhere = envOf({ ...BASE, MERRYMEN_MCP_DIRECTORY_RESOURCE_URL: "https://mcp.test/listing" });
  assert.equal(mcpConfig(elsewhere).directoryResource, "");
  assert.match(directoryHealth(mcpConfig(elsewhere), elsewhere).why ?? "", /not usable.*whose path is \/mcp\/directory/);
  // A canonical endpoint on the directory's own path leaves it nowhere to go, and says so.
  const taken = envOf({ ...BASE, MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp/directory" });
  assert.equal(mcpConfig(taken).directoryResource, "");
  assert.match(directoryHealth(mcpConfig(taken), taken).why ?? "", /\(MERRYMEN_MCP_RESOURCE_URL\) is at \/mcp\/directory/);
  // Even beside a valid override: no override can fix that, so it is not the one blamed.
  const takenOver = envOf({ ...BASE, MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp/directory/", MERRYMEN_MCP_DIRECTORY_RESOURCE_URL: "https://dir.test/mcp/directory" });
  assert.equal(mcpConfig(takenOver).directoryResource, "");
  assert.match(directoryHealth(mcpConfig(takenOver), takenOver).why ?? "", /\(MERRYMEN_MCP_RESOURCE_URL\) is at \/mcp\/directory/);
  // A usable override (another origin, the served path) is reported as the endpoint.
  const good = envOf({ ...BASE, MERRYMEN_MCP_DIRECTORY_RESOURCE_URL: "https://dir.test/mcp/directory" });
  assert.deepEqual(directoryHealth(mcpConfig(good), good), { endpoint: "https://dir.test/mcp/directory", why: null });
});

test("a database outage is 503 and still reports the directory; a disabled server reports neither", async () => {
  const down = await mcpHealth({ cfg: testConfig(), env: envOf({}), mcp: async () => { throw new Error("down"); } });
  assert.equal(down.status, 503);
  const body = await down.json() as { ready: boolean; directory: { endpoint: string | null } };
  assert.equal(body.ready, false);
  assert.equal(body.directory.endpoint, "https://app.test/mcp/directory");

  const disabled = await mcpHealth({ cfg: testConfig({ enabled: false, disabledWhy: "off" }), env: envOf({}) });
  assert.equal(disabled.status, 503);
  assert.deepEqual(await disabled.json(), { ready: false, enabled: false, why: "off" });
});
