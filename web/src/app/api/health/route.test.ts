import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Route-shape test: /api/health answers the liveness contract from existing
// sources (heartbeat file, grant file, sqlite open) with no new state.
describe("/api/health", () => {
  it("reports unhealthy with an empty home (no db, no grant, no beat)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "health-test-"));
    const prev = process.env.MERRYMEN_HOME;
    process.env.MERRYMEN_HOME = dir;
    try {
      const { GET } = await import("./route");
      const res = await GET();
      const body = (await res.json()) as { ok: boolean; db: boolean; grant: boolean; workerAliveSec: number | null };
      assert.equal(body.db, false);
      assert.equal(body.grant, false);
      assert.equal(body.workerAliveSec, null);
      assert.equal(body.ok, false);
    } finally {
      if (prev === undefined) delete process.env.MERRYMEN_HOME;
      else process.env.MERRYMEN_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports healthy against a fabricated home", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkdtempSync(path.join(tmpdir(), "health-test-"));
    const prev = process.env.MERRYMEN_HOME;
    process.env.MERRYMEN_HOME = dir;
    try {
      const db = new DatabaseSync(path.join(dir, "merrymen.db"));
      db.exec("CREATE TABLE t(x)");
      db.close();
      writeFileSync(
        path.join(dir, "grant.json"),
        JSON.stringify({ serialized: "0xabc", smartAccount: "0x1234567890123456789012345678901234567890" }),
      );
      writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ at: Math.floor(Date.now() / 1000) - 30 }));
      const { GET } = await import("./route");
      const res = await GET();
      const body = (await res.json()) as { ok: boolean; db: boolean; grant: boolean; workerAliveSec: number | null };
      assert.equal(body.db, true);
      assert.equal(body.grant, true);
      assert.ok(typeof body.workerAliveSec === "number" && body.workerAliveSec >= 0 && body.workerAliveSec < 300);
      assert.equal(body.ok, true);
    } finally {
      if (prev === undefined) delete process.env.MERRYMEN_HOME;
      else process.env.MERRYMEN_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
