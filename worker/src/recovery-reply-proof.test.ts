/** Pure proof fixtures: no database, Telegram, production root or environment mutation. */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { proveRecoveryReplyRoot } from "./recovery-reply-proof";
import { PERSISTENT_HOME_MANIFEST } from "./persistent-home";

const first = "0x" + "1".repeat(40);
const second = "0x" + "a".repeat(40);
function fixture(t: TestContext, holds?: string) {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-reply-proof-")));
  const home = path.join(parent, "volume");
  mkdirSync(home, { mode: 0o700 });
  const halt = path.join(home, "FLEET_HALT");
  writeFileSync(halt, "synthetic unchanged operator halt\n", { mode: 0o600 });
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const s = lstatSync(home, { bigint: true });
  const major = ((s.dev >> 8n) & 0xfffn) | ((s.dev >> 32n) & 0xfffff000n);
  const minor = (s.dev & 0xffn) | ((s.dev >> 12n) & 0xffffff00n);
  const mount = () => `40 20 ${major}:${minor} / ${home} rw - ext4 /dev/synthetic rw\n`;
  const env: NodeJS.ProcessEnv = {
    MERRYMEN_HOME: home, RAILWAY_VOLUME_MOUNT_PATH: home,
    MERRYMEN_HOME_VOLUME_ID: "d6481580-14af-430c-af4a-f3540dfb833d",
    MERRYMEN_HOSTED: "1", MERRYMEN_PERSISTENT_HOME_REQUIRED: "1",
    MERRYMEN_FLEET_RECOVERY_REPORT_ONLY: "1", MERRYMEN_FLEET_RECOVERY_REPLIES: "1",
    DATABASE_URL: "postgresql://synthetic@127.0.0.1:1/synthetic",
    ...(holds === undefined ? {} : { MERRYMEN_ACCOUNTING_HOLD_TENANTS: holds })
  };
  const facts = () => {
    const st = lstatSync(halt, { bigint: true });
    return { bytes: readFileSync(halt).toString("base64"), stat: [st.dev, st.ino, st.mode, st.uid, st.nlink, st.size, st.mtimeNs, st.ctimeNs].map(String) };
  };
  return { env, home, halt, mount, facts };
}

test("empty and omitted accounting lists preserve the mandatory mode and existing halt", t => {
  for (const holds of [undefined, ""]) {
    const f = fixture(t, holds), before = f.facts();
    const proof = proveRecoveryReplyRoot(f.env, f.mount);
    proof.assert();
    assert.equal(f.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS, holds);
    assert.deepEqual(f.facts(), before);
    assert.equal(existsSync(path.join(f.home, PERSISTENT_HOME_MANIFEST)), false);
    for (const key of ["MERRYMEN_FLEET_RECOVERY_REPORT_ONLY", "MERRYMEN_FLEET_RECOVERY_REPLIES"])
      assert.throws(() => proveRecoveryReplyRoot({ ...f.env, [key]: "0" }, f.mount));
    rmSync(f.halt);
    assert.throws(() => proveRecoveryReplyRoot(f.env, f.mount));
    assert.throws(() => proof.assert());
  }
});

test("nonempty accounting lists still reject empty CSV tokens, whitespace and malformed addresses", t => {
  const malformed = [" ", "\t", "\n", ",", `,${first}`, `${first},`, `${first},,${second}`,
    `${first}, \t,${second}`, `${first};${second}`, "0x" + "1".repeat(39),
    "0x" + "1".repeat(41), first + "private-prose"];
  for (const holds of malformed) {
    const f = fixture(t, holds), before = f.facts();
    assert.throws(() => proveRecoveryReplyRoot(f.env, f.mount), /Reply-only prerequisites changed/, JSON.stringify(holds));
    assert.equal(f.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS, holds);
    assert.deepEqual(f.facts(), before);
  }
});

test("valid accounting lists stay byte-exact and every later list mutation refuses", t => {
  for (const holds of [undefined, "", first, `${first},${second}`, ` ${first}, ${second.toUpperCase()}\t`]) {
    const f = fixture(t, holds), before = f.facts();
    const proof = proveRecoveryReplyRoot(f.env, f.mount);
    proof.assert();
    for (const changed of [undefined, "", first, second, `${first},${second}`, " "]) {
      if (changed === holds) continue;
      if (changed === undefined) delete f.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
      else f.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = changed;
      assert.throws(() => proof.assert(), /Reply-only prerequisites changed/, `${JSON.stringify(holds)} -> ${JSON.stringify(changed)}`);
      if (holds === undefined) delete f.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
      else f.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = holds;
      proof.assert();
    }
    assert.equal(f.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS, holds);
    assert.deepEqual(f.facts(), before);
  }
});
