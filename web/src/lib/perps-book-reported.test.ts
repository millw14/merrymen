/**
 * A PERPS OWNER COMMAND IS QUEUED ONLY ONTO A BOOK THAT HAS REPORTED
 * (perps-book-reported.ts), and the refusal says only what is known.
 *
 * No `agents` row is "not said", never "nothing": a worker that has armed can
 * hold a practice position before the mirror carries its row up, and a Perps
 * wallet the rollout holds never reports at all. The routes that ask this are
 * driven end to end in orders/perps-not-reported.postgres.test.ts; here, the
 * look itself on the worker's own spelling of the account, and the words.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getAddress } from "viem";
import { wrapSqlite } from "../../../worker/src/db";
import { applyLedgerSchema } from "../../../worker/src/store";
import { PERPS_EXIT_NOT_REPORTED, PERPS_RESET_NOT_REPORTED, perpsBookReported } from "./perps-book-reported";

/** As the worker writes it: viem's EIP-55 checksummed spelling (store.ts ensureAgent writes grant.smartAccount as signed). */
const CHECKSUMMED = getAddress("0xabcdef0123456789abcdef0123456789abcdef01");

describe("perpsBookReported", () => {
  it("finds the worker's row whatever case either side is spelled in, and no row is false", async () => {
    const raw = new DatabaseSync(":memory:");
    try {
      const db = wrapSqlite(raw);
      await applyLedgerSchema(db);
      assert.equal(await perpsBookReported(db, CHECKSUMMED), false, "no row yet");
      raw.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, ?, ?, 4663, '{}', 0, 0)")
        .run(CHECKSUMMED, CHECKSUMMED, CHECKSUMMED);
      assert.notEqual(CHECKSUMMED, CHECKSUMMED.toLowerCase(), "set-up: the checksummed spelling is mixed case");
      for (const asked of [CHECKSUMMED, CHECKSUMMED.toLowerCase(), `0x${CHECKSUMMED.slice(2).toUpperCase()}`]) {
        assert.equal(await perpsBookReported(db, asked), true, asked);
      }
      assert.equal(await perpsBookReported(db, "0x0000000000000000000000000000000000000001"), false, "another account's row is not this one's");
    } finally {
      raw.close();
    }
  });

  it("a read that fails throws, never answers", async () => {
    const raw = new DatabaseSync(":memory:");
    try {
      await assert.rejects(perpsBookReported(wrapSqlite(raw), CHECKSUMMED), /no such table/);
    } finally {
      raw.close();
    }
  });
});

describe("the not-reported refusals", () => {
  for (const [name, sentence] of [["exit", PERPS_EXIT_NOT_REPORTED], ["reset", PERPS_RESET_NOT_REPORTED]] as const) {
    it(`${name}: says nothing was queued, and never that there is nothing there, nor when the book will show`, () => {
      assert.match(sentence, /has not reported its practice book yet/);
      assert.match(sentence, /queued/);
      assert.match(sentence, /once your Perps wallet shows its book/);
      // Not said is never nothing (agent-perps.ts rule 11).
      assert.doesNotMatch(sentence, /no position|no book|nothing (is )?(open|there|to close|to reset)/i);
      // A wallet the rollout holds may never report.
      assert.doesNotMatch(sentence, /in a (minute|moment)|shortly|soon/i);
    });
  }
  it("a refused Close all says no pause was set", () => {
    assert.match(PERPS_EXIT_NOT_REPORTED, /nothing was closed or paused/);
  });
});
