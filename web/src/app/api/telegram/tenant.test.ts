/**
 * THE LINK CODE IS A BEARER CREDENTIAL, AND THIS ROUTE USED TO HAVE NO IDEA WHO
 * WAS ASKING.
 *
 * Two beta testers were stopped at the same step: token saved, "connected as
 * @merrymen_hosted_…_bot", "the bot is listening" ticked, and a placeholder
 * where the six-character code belongs. "I'm stuck at this point, no code from
 * /link."
 *
 * `GET()` took no Request — so no tenant could be resolved even in principle —
 * and read `merrymenHome()`, the WEB container's home. Hosted, the child writes
 * its telegram.json into `<childHome>` on the ORCHESTRATOR's disk. Different
 * service, different filesystem. The route therefore returned constants to
 * everyone: linkCode and ownerId null forever, enabled/hasToken/allowlist empty
 * because /api/settings writes the per-tenant store rather than that file, and
 * `control` a constant true that could contradict a tenant who had turned
 * control off.
 *
 * The security half is why the fix is a tenant check and not a repointing.
 * `/link <code>` is accepted from ANY chat, first-come, and on success sets the
 * owner and allowlists that chat — so the code is a bearer credential for an
 * agent's control commands. Pointing this route at shared storage WITHOUT
 * resolving the caller would have turned a dead field into a cross-tenant
 * disclosure, which is a worse bug than the one being fixed.
 *
 * This is the third route in the repo with the container-split bug (see
 * api/feed/identity.test.ts and api/grants/route.ts). Those tests each scan one
 * hard-coded path, which is why none of them caught this one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const ROUTE = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

/** Comments stripped — this header names what it refuses, so a raw scan lies. */
const CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, " ")
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

describe("it knows who is asking", () => {
  it("GET TAKES A REQUEST AND RESOLVES A TENANT", () => {
    // The whole bug in one signature: a handler with no Request cannot be
    // scoped, however carefully everything below it is written.
    assert.match(CODE, /export async function GET\(req: Request\)/);
    assert.match(CODE, /const tenant = isHostedMode\(\) \? tenantOf\(req\) : null/);
  });

  it("the settings half comes from the tenant's store, not the container's file", () => {
    // The identical fix /api/feed's identity read already carries.
    assert.match(CODE, /getSettingsStore\(\)\.get\(tenant\)/);
    const fn = CODE.slice(CODE.indexOf("async function settingsFor"));
    const hosted = fn.indexOf("isHostedMode()");
    const file = fn.indexOf("SETTINGS_FILE");
    assert.ok(hosted > 0 && file > hosted, "the file read is the self-hosted arm, below the branch");
  });

  it("POST resolves the caller too, before falling back to a stored token", () => {
    // It read the container's settings.json for the fallback token, so the
    // "test connection" button was answering about the operator's bot.
    const post = CODE.slice(CODE.indexOf("export async function POST"));
    assert.match(post, /tenantOf\(req\)/);
    assert.ok(!/readJson<MerrymenSettings>\(SETTINGS_FILE\)/.test(post), "no direct file read in POST");
  });
});

describe("a hosted request with no session gets nothing", () => {
  it("NO TENANT MEANS NO READ — not a file, and not an unscoped query", () => {
    const fn = CODE.slice(CODE.indexOf("async function runtimeFor"), CODE.indexOf("async function botUsername"));
    assert.match(fn, /if \(!tenant\) return \{ linkCode: null, ownerId: null \}/);
    // The query that follows must be keyed on the tenant. A SELECT without a
    // WHERE here would hand one owner another's credential.
    assert.match(fn, /WHERE tenant = \?/);
    assert.match(fn, /\.get\(tenant\.toLowerCase\(\)\)/);
    // And the file must be unreachable hosted: it belongs to whoever runs the
    // web container, which hosted is the operator.
    const hosted = fn.indexOf("if (!isHostedMode())");
    const file = fn.indexOf("TELEGRAM_FILE");
    assert.ok(hosted >= 0 && file > hosted, "the file read sits inside the self-hosted arm");
  });

  it("the token is still never returned to the browser", () => {
    // The status object is what GET serialises, and POST answers with a
    // username or a reason. Reading the token into a local to CALL getMe is
    // the point of the route; returning it is the invariant.
    const status = CODE.slice(CODE.indexOf("const status: TelegramStatus"), CODE.indexOf("if (status.hasToken)"));
    // hasToken is a BOOLEAN derived from it and is the point of the field; what
    // must never appear is the value itself being assigned to a response key.
    assert.ok(status.includes("hasToken:"), "the boolean is still reported");
    assert.ok(!status.includes(": token"), "no response key is assigned the token value");
    assert.ok(!status.includes("telegramBotToken"), "and the stored field is not echoed");
    const iface = CODE.slice(CODE.indexOf("export interface TelegramStatus"), CODE.indexOf("export async function GET"));
    assert.ok(!iface.includes("botToken"), "the wire type has no token field");
  });

  it("control keeps its `!== false` default", () => {
    // `=== true` would report control OFF for every install that never touched
    // the toggle — the route argues this in its own comment.
    assert.match(CODE, /control: settings\.telegramControlEnabled !== false/);
  });
});

describe("the link survives the orchestrator's next pass", () => {
  const ORCH = readFileSync(new URL("../../../../../worker/src/orchestrator.ts", import.meta.url), "utf8");
  const STATE = readFileSync(new URL("../../../../../worker/src/telegram/state.ts", import.meta.url), "utf8");
  const SERVICE = readFileSync(new URL("../../../../../worker/src/telegram/service.ts", import.meta.url), "utf8");

  it("A LINKED CHAT IS RECORDED WHERE NOTHING OVERWRITES IT", () => {
    // The child authorizes a chat by patching its own settings.json, and
    // writeSettingsForChild replaces that file wholesale from the tenant store
    // every 15 seconds — so the link was undone before the owner could send a
    // second command, with the code already spent by the rotation. telegram.json
    // is child-owned and never written from above.
    assert.match(STATE, /linkedChats: number\[\]/);
    assert.match(SERVICE, /linkedChats: state\.linkedChats\.includes\(msg\.chatId\)/);
  });

  it("and the orchestrator promotes it into the stored allowlist", () => {
    assert.match(ORCH, /async function publishChildTelegram/);
    assert.match(ORCH, /getSettingsStore\(\)\.put\(tenant, \{ \.\.\.stored, telegramAllowlist/);
    // ONLY WHEN SOMETHING IS NEW. `put` replaces the whole sealed blob and the
    // web is its other writer, so an unconditional write on a 15-second loop
    // would race a tenant's save on the settings page.
    assert.match(ORCH, /if \(missing\.length === 0\) return;/);
  });

  it("the ferry runs under the same lease as the ledger mirror", () => {
    // A replica that no longer owns a child must not speak for it — the same
    // rule the mirror learned the hard way.
    const lease = ORCH.indexOf("if (!lease || !lease.healthy()) continue;");
    const call = ORCH.indexOf("await publishChildTelegram(");
    assert.ok(lease > 0 && call > lease, "the publish sits below the lease check");
  });

  it("an absent telegram.json publishes nothing, rather than a null code", () => {
    // A child with no bot token has no file. Publishing an empty code would
    // erase a real one during a restart.
    assert.match(ORCH, /if \(!tg\) return;/);
  });
});
