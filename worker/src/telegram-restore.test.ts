/**
 * A TELEGRAM LINK MUST SURVIVE A REDEPLOY.
 *
 * `ownerId` is the single recipient every alert, trade ping and daily report is
 * sent to — `startNotifier` returns early at `state.ownerId === null`. It lives
 * in `telegram.json` inside `childHome()`, and the orchestrator runs with no
 * volume, so that directory is destroyed on every redeploy.
 *
 * Grant, settings and bootstrap were all seeded back into a fresh child on
 * spawn. The telegram link was not. `tenant_telegram` held the durable copy and
 * `telegram-store.ts` exported only `publishTenantTelegram` — the table was
 * structurally write-only, so nothing could have read it back.
 *
 * The symptom is the worst kind: the bot still answers /status, because a reply
 * goes to whoever sent the message, while everything the agent INITIATES stops
 * for ever. The link code rotates too, so the owner's old one no longer works.
 * Nobody is told. An owner experiences it as the agent having gone quiet.
 *
 * This was found because a tester was receiving Telegram alerts while a census
 * of `tenant_telegram` reported zero linked chats — two facts that cannot both
 * be true of a healthy system, and the census was the one measuring a mirror.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const ORCH = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
const STORE = readFileSync(new URL("./telegram-store.ts", import.meta.url), "utf8");

describe("the telegram mirror reads as well as writes", () => {
  it("exports a read side at all — it used to be write-only", () => {
    assert.match(STORE, /export async function readTenantTelegram\(/);
    assert.match(STORE, /SELECT link_code, owner_id, linked_at FROM tenant_telegram WHERE tenant = \?/);
  });

  it("distinguishes never-linked from linked-then-unlinked", () => {
    // No row is "never linked". A row with a null owner_id is "linked once,
    // then unlinked". Collapsing them would restore nothing in the first case
    // and silently write an empty file in the second.
    const fn = STORE.slice(STORE.indexOf("export async function readTenantTelegram("));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.match(body, /if \(!row\) return null;/);
    assert.match(body, /ownerId: row\.owner_id === null/);
  });
});

describe("a fresh child gets its link back", () => {
  const FN = ORCH.slice(
    ORCH.indexOf("async function writeTelegramForChild"),
    ORCH.indexOf("async function publishChildTelegram"),
  );

  it("is seeded on spawn, beside grant, settings and bootstrap", () => {
    assert.ok(FN.length > 300, "the restore moved — re-point this test, do not delete it");
    // Ordering matters: a link restored after the child is polling would be
    // read from a file the child has already replaced with a fresh default.
    const spawnBlock = ORCH.slice(ORCH.indexOf("await writeBootstrapForChild(tenant, smartAccount);"));
    const beforeSpawn = spawnBlock.slice(0, spawnBlock.indexOf("const proc = spawn("));
    assert.match(beforeSpawn, /await writeTelegramForChild\(tenant\);/, "seeded before the child starts");
  });

  it("NEVER overwrites a live child's own link", () => {
    // A running child is the authority on its own link — it may have just been
    // re-linked to a different chat. This restores a lost link, never replaces
    // a current one.
    assert.match(FN, /if \(existsSync\(file\)\) return;/);
  });

  it("writes nothing when there is no recipient to restore", () => {
    // An empty file is worse than no file: it looks linked to every later
    // reader and would mask a genuine publish.
    //
    // Tested on the RECOVERED id rather than the mirror's, because the mirror
    // turned out to be empty fleet-wide and the allowlist fallback is what
    // actually produces a recipient.
    assert.match(FN, /if \(!ownerId\) return;/);
  });

  it("cannot take the fleet down if the shared record is unreadable", () => {
    // A child with no telegram link still trades; it just cannot tell anyone.
    // That is the status quo this repairs, so failing to repair it must never
    // be worse than not trying.
    assert.match(FN, /catch \(e\)/);
    assert.match(FN, /could not restore telegram state/);
  });

  it("says so when it does restore one", () => {
    // Silent repair of a silent breakage leaves nobody able to confirm it
    // worked — which is how the original defect survived.
    assert.match(FN, /telegram link restored/);
  });
});

describe("recovering a link the mirror never held", () => {
  const FN = ORCH.slice(
    ORCH.indexOf("async function writeTelegramForChild"),
    ORCH.indexOf("async function publishChildTelegram"),
  );

  it("falls back to the sealed allowlist when the mirror is empty", () => {
    // Measured on the fleet: 4 tenants hold a bot token, 2 completed a link,
    // and 0 had a live owner_id. `tenant_telegram` is only written while a
    // child HAS the file this function exists to restore, so the redeploy that
    // destroys the file also stops the mirror being refreshed. The allowlist is
    // in the sealed settings and survives.
    assert.match(FN, /telegramAllowlist/);
    assert.match(FN, /telegram owner recovered from the stored allowlist/);
  });

  it("only ever recovers a DM, never a group", () => {
    // Telegram gives users positive ids and groups negative ones. Restoring a
    // group as the owner would start sending an agent's private trade reports
    // and P&L into a room full of people.
    assert.match(FN, /typeof c === "number" && c > 0/);
    assert.match(FN, /sort\(\(a, b\) => a - b\)\[0\]/, "the earliest linker, which is who /link made the owner");
  });

  it("does NOT recover the link code, which rotates", () => {
    // A stale code is worse than none: it looks usable and is not. The child
    // mints a fresh one and the dashboard shows it.
    assert.match(FN, /linkCode: tg\?\.linkCode \?\? ""/);
  });

  it("says when the recovery was a heuristic rather than a read", () => {
    // It recovers a recipient rather than reading one, so it must be
    // distinguishable in the log from a straight restore.
    assert.ok(
      FN.includes("recovered from the stored allowlist") && FN.includes("telegram link restored"),
      "the two paths must log differently",
    );
  });
});
