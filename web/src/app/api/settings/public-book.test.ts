import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * THE BOOK IS PUBLISHED ONLY WHEN ITS OWNER SAID SO, IN A BOOLEAN.
 *
 * read-agent.ts has read `publicBook` for months and nothing could write it:
 * the route had no branch, so a PUT carrying it returned {ok:true} and dropped
 * the field — every profile hid its dollars, including the ones whose owners
 * wanted them shown. The write path is the consent, so it is driven through the
 * real PUT against a real settings file (self-hosted, that file IS the store).
 */
let home: string;
let PUT: (req: Request) => Promise<Response>;
const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED };

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-settings-public-book-"));
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
  return { status: res.status, body: (await res.json()) as { ok?: boolean; errors?: string[]; ignored?: string[] } };
};

describe("PUT /api/settings with publicBook", () => {
  it("true is stored, and is not reported as an ignored key", async () => {
    seed = { strategy: "steady-basket" };
    writeFileSync(file(), JSON.stringify(seed));
    const r = await put({ publicBook: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ignored, undefined, "a field the owner set must not be dropped");
    assert.equal(stored().publicBook, true);
    assert.equal(stored().strategy, "steady-basket", "nothing else moves");
  });

  it("false is stored as false — turning the book back off is the same consent", async () => {
    seed = { publicBook: true };
    writeFileSync(file(), JSON.stringify(seed));
    assert.equal((await put({ publicBook: false })).status, 200);
    assert.equal(stored().publicBook, false);
  });

  it("a STRING is refused, not coerced, and nothing is written", async () => {
    // "false" is truthy to any reader that forgets `=== true`, so a string here
    // would be one careless check away from publishing a book its owner closed.
    seed = { publicBook: false };
    writeFileSync(file(), JSON.stringify(seed));
    for (const bad of ["true", "false", 1, 0, "yes"]) {
      const r = await put({ publicBook: bad });
      assert.equal(r.status, 400, `accepted ${JSON.stringify(bad)}`);
      assert.deepEqual(r.body.errors, ["publicBook: must be true or false"]);
      assert.deepEqual(stored(), seed, `a refused ${JSON.stringify(bad)} stores nothing`);
    }
  });

  it("null clears back to the default, which is private", async () => {
    seed = { publicBook: true };
    writeFileSync(file(), JSON.stringify(seed));
    assert.equal((await put({ publicBook: null })).status, 200);
    assert.equal("publicBook" in stored(), false);
  });

  it("a save that does not mention it leaves it alone", async () => {
    // The Settings screen sends its own form; the toggle lives on the profile.
    // A save from one must never reset the other.
    seed = { publicBook: true, strategy: "steady-basket" };
    writeFileSync(file(), JSON.stringify(seed));
    assert.equal((await put({ strategy: "even-keel" })).status, 200);
    assert.equal(stored().publicBook, true);
  });
});
