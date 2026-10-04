import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { closeLocalFomoDbsForTest, localFomoDbPath, openLocalFomoDb } from "./local-db";
import { ensureFomoSchema, getSubject, setSubject } from "./store";

const home = mkdtempSync(path.join(os.tmpdir(), "mm-fomo-local-"));
after(() => {
  closeLocalFomoDbsForTest();
  rmSync(home, { recursive: true, force: true });
});

describe("the self-hosted Fomo database", () => {
  it("is its own file beside the ledger, opened once per process", async () => {
    assert.equal(localFomoDbPath(home), path.join(home, "fomo.sqlite"));
    const a = openLocalFomoDb(home);
    assert.equal(openLocalFomoDb(home), a);
    await ensureFomoSchema(a, "sqlite");
    await setSubject(a, "self", "app:self", JSON.stringify({ v: 1 }), 1_000);
    assert.equal((await getSubject(a, "self", "app:self"))?.json, JSON.stringify({ v: 1 }));
  });
});
