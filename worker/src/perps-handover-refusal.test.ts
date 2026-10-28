/**
 * NO FLEET HANDOVER WHILE A PERPS PAPER BOOK EXISTS (perps-handover-refusal.ts):
 * what counts as a book, what does not, and the memory safeguard's own modes.
 * The ledger handover's modes are driven end to end in ledger-handover-cli.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { PerpsBooksNotHandedOver, refuseWhilePerpsBooks } from "./perps-handover-refusal";
import { runMemorySafeguardCli } from "./memory-safeguard-cli";

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-perps-refusal-")));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const home = () => {
  const h = path.join(root, String(++n));
  mkdirSync(path.join(h, "children"), { recursive: true });
  return h;
};
const OWNER = `0x${"a1".repeat(20)}`;

it("no Perps root, an empty one, homes without a book, or a stray file: the fleet as it always was", () => {
  const h = home();
  refuseWhilePerpsBooks(h);
  mkdirSync(path.join(h, "children-perps", OWNER), { recursive: true });
  refuseWhilePerpsBooks(h);
  writeFileSync(path.join(h, "children-perps", ".keep"), "");
  refuseWhilePerpsBooks(h);
});

it("any home holding a merrymen.db refuses, with the count and no owner", () => {
  const h = home();
  for (const owner of [OWNER, `0x${"b2".repeat(20)}`]) {
    mkdirSync(path.join(h, "children-perps", owner), { recursive: true });
    writeFileSync(path.join(h, "children-perps", owner, "merrymen.db"), "book");
  }
  assert.throws(() => refuseWhilePerpsBooks(h), (e: unknown) => {
    assert.ok(e instanceof PerpsBooksNotHandedOver);
    assert.equal(e.books, 2);
    assert.match(e.message, /2 Perps paper book\(s\) under children-perps\/, and Perps paper books are not covered by the fleet handover yet/);
    assert.equal(e.message.includes(OWNER), false);
    return true;
  });
});

it("a Perps root that is not a directory is never read as no books", () => {
  const h = home();
  writeFileSync(path.join(h, "children-perps"), "not a directory");
  assert.throws(() => refuseWhilePerpsBooks(h), (e: unknown) => e instanceof PerpsBooksNotHandedOver && e.books === null && /could not be read/.test(e.message));
});

it("the memory safeguard's capture, seed and checkpoint refuse too — before any database is opened — and verify still reads its artifact", async () => {
  const h = home();
  mkdirSync(path.join(h, "children-perps", OWNER), { recursive: true });
  writeFileSync(path.join(h, "children-perps", OWNER, "merrymen.db"), "book");
  const saved = { home: process.env.MERRYMEN_HOME, url: process.env.DATABASE_URL, dek: process.env.MERRYMEN_STORE_DEK };
  process.env.MERRYMEN_HOME = h;
  // Never connected to: the refusal comes first.
  process.env.DATABASE_URL = "postgres://refused.invalid:1/never";
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 5).toString("base64");
  try {
    for (const mode of ["capture", "seed", "checkpoint"]) {
      await assert.rejects(runMemorySafeguardCli([mode, "--quiescent", "--single-replica-confirmed"]), PerpsBooksNotHandedOver, mode);
    }
    // verify reads only its artifact, and fails here on that, not on the Perps home.
    await assert.rejects(runMemorySafeguardCli(["verify", "--artifact", path.join(h, "absent.sealed")]), (e: unknown) => !(e instanceof PerpsBooksNotHandedOver));
  } finally {
    for (const [k, v] of [["MERRYMEN_HOME", saved.home], ["DATABASE_URL", saved.url], ["MERRYMEN_STORE_DEK", saved.dek]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
