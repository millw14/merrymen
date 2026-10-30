import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { recoveryWallets } from "./recovery-wallets.mjs";
const address = n => `0x${n.repeat(40)}`;
test("recovery discovers active and archived Perps and legacy Spot independently, with paper off", async t => {
  const home = mkdtempSync(path.join(tmpdir(), "perps-recovery-discovery-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  const save = (file, g) => { mkdirSync(path.dirname(path.join(home, file)), { recursive: true }); writeFileSync(path.join(home, file), JSON.stringify(g)); };
  save("grant.json", { smartAccount: address("1"), chainId: 4663 });
  save("grants/old.json", { smartAccount: address("2"), chainId: 4663 });
  save("accounts/perps/grant.json", { purpose: "perps", smartAccount: address("3"), chainId: 4663 });
  save("accounts/perps/grants/old.json", { purpose: "perps", smartAccount: address("4"), chainId: 4663 });
  save("accounts/perps/grants/duplicate.json", { purpose: "perps", smartAccount: address("3"), chainId: 4663 });
  const result = await recoveryWallets(home);
  assert.equal(result.unread.length, 0); assert.equal(result.wallets.length, 4);
  assert.deepEqual(result.wallets.map(w => [w.purpose, w.active]), [["spot", true], ["spot", false], ["perps", true], ["perps", false]]);
  assert.ok(result.wallets.filter(w => w.purpose === "perps").every(w => w.home === path.join(home, "accounts/perps")));
});
test("corrupt and wrong-purpose files are disclosed, never treated as missing or another wallet", async t => {
  const home = mkdtempSync(path.join(tmpdir(), "perps-recovery-unread-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(await recoveryWallets(home), { wallets: [], unread: [] });
  mkdirSync(path.join(home, "accounts/perps"), { recursive: true });
  writeFileSync(path.join(home, "grant.json"), "{bad");
  writeFileSync(path.join(home, "accounts/perps/grant.json"), JSON.stringify({ smartAccount: address("1"), chainId: 4663 }));
  const result = await recoveryWallets(home); assert.equal(result.wallets.length, 0); assert.equal(result.unread.length, 2);
});
