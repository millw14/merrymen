import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { AGENT_NAME_RULE } from "@/lib/agent-name-rule";

/**
 * THE SETTINGS ROUTE, RUN, ON THE NAME IT IS SENT BACK.
 *
 * The Settings screen sends the whole form on every save, name included, so
 * which stored name the route hands the rule is the difference between an
 * owner whose agent is "007" saving a strategy and being refused on a field
 * they never touched. Driven through PUT against a real settings file:
 * self-hosted, that file IS the store.
 */
let home: string;
let PUT: (req: Request) => Promise<Response>;
const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED };

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-settings-agent-name-"));
  process.env.MERRYMEN_HOME = home;
  delete process.env.MERRYMEN_HOSTED;
  // After the env: the route resolves its settings path when it loads.
  ({ PUT } = await import("./route"));
});
after(() => {
  for (const [key, value] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const file = () => path.join(home, "settings.json");
const stored = () => JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
let seed: Record<string, unknown> = {};
beforeEach(() => writeFileSync(file(), JSON.stringify(seed)));

const put = async (body: unknown) => {
  const res = await PUT(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as { ok?: boolean; errors?: string[] } };
};

describe("PUT /api/settings with the agent's name", () => {
  it("an agent already called \"007\" can still have its strategy changed", async () => {
    seed = { agentName: "007", strategy: "steady-basket" };
    writeFileSync(file(), JSON.stringify(seed));
    const r = await put({ agentName: "007", strategy: "even-keel" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(stored().agentName, "007", "the name it was stored under is kept");
    assert.equal(stored().strategy, "even-keel", "and the setting the owner actually changed is saved");
  });

  it("renaming an agent TO a letterless name is refused, and nothing is written", async () => {
    seed = { agentName: "Shogun", strategy: "steady-basket" };
    writeFileSync(file(), JSON.stringify(seed));
    const r = await put({ agentName: "007", strategy: "even-keel" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.errors, [`name: ${AGENT_NAME_RULE}`]);
    assert.deepEqual(stored(), seed, "a refused save stores none of the form");
  });

  it("a new name is stored in the shape the soul stores, and an empty one clears", async () => {
    seed = { agentName: "007" };
    writeFileSync(file(), JSON.stringify(seed));
    assert.equal((await put({ agentName: "  Little   John " })).status, 200);
    assert.equal(stored().agentName, "Little John");
    assert.equal((await put({ agentName: "" })).status, 200);
    assert.equal("agentName" in stored(), false, "cleared back to the default");
  });
});
