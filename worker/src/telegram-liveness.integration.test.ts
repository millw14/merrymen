/**
 * THE LIVENESS PASS, THROUGH THE REAL ORCHESTRATOR (plan §1.4).
 *
 * A held tenant is adopted with a fake hold process (adoptHolderForTest,
 * which takes the no-op lease: no DATABASE_URL), its home is given the
 * settings.json and telegram.json a real one would have, and the real
 * telegramLiveness() is run at chosen times. What it logs is read off
 * console.log; what it must never do is touch the process.
 *
 * MERRYMEN_HOME is per process (node --test forks per file).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ChildProcess } from "node:child_process";

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-liveness-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_TELEGRAM_ENABLED;
after(() => rmSync(FLEET, { recursive: true, force: true }));

const { adoptHolderForTest, childHome, telegramLiveness } = await import("./orchestrator");

const T = 1_790_000_000;
const ACCOUNT = "0x00000000000000000000000000000000000000c9" as const;

/** A hold process that records whatever is done to it. */
class FakeProc extends EventEmitter {
  readonly pid = 4_242;
  readonly signals: string[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    return true;
  }
}

let n = 0;
let lines: string[] = [];
beforeEach(() => {
  lines = [];
  mock.method(console, "log", (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
});
afterEach(() => mock.restoreAll());

/**
 * A fresh held tenant with a bot, its process (none with `running: false`,
 * as between two, or in a crash cool-off), and a way to write what that
 * process recorded.
 */
async function heldTenant(
  settings: Record<string, unknown> = { telegramEnabled: true, telegramBotToken: "111:AAA" },
  o: { running?: boolean } = {},
) {
  const tenant = `0x00000000000000000000000000000000000000${(0xa0 + n++).toString(16)}` as `0x${string}`;
  const home = childHome(tenant);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "settings.json"), JSON.stringify(settings));
  const proc = new FakeProc();
  await adoptHolderForTest(tenant, ACCOUNT, o.running === false ? null : (proc as unknown as ChildProcess));
  return {
    tenant,
    proc,
    /** The process dies and another takes its place, as a restart or a re-hold gives. */
    respawn: async () => {
      const next = new FakeProc();
      await adoptHolderForTest(tenant, ACCOUNT, next as unknown as ChildProcess);
      return next;
    },
    settings: (next: Record<string, unknown>) => writeFileSync(path.join(home, "settings.json"), JSON.stringify(next)),
    poll: (poll: Record<string, unknown> | null, botId = "111") =>
      writeFileSync(path.join(home, "telegram.json"), JSON.stringify({ botId, linkCode: "K7M2QX", ...(poll ? { poll } : {}) })),
    alerts: () => lines.filter((l) => l.includes(tenant) && l.includes("[alert]")),
  };
}

describe("telegramLiveness", () => {
  it("SAYS A DEAF BOT ONCE PER INCIDENT, says when it is heard again, and kills nothing", async () => {
    const t = await heldTenant();
    t.poll({ okAt: T, botId: "111" });
    telegramLiveness(T); // the watch begins
    telegramLiveness(T + 300);
    assert.deepEqual(t.alerts(), [], "five minutes is not an incident");
    telegramLiveness(T + 601);
    assert.deepEqual(t.alerts(), [`[orchestrator] [alert] telegram not polling: ${t.tenant} since ${new Date(T * 1000).toISOString()} (no failure recorded)`]);
    telegramLiveness(T + 1_200);
    telegramLiveness(T + 86_400);
    assert.equal(t.alerts().length, 1, "once per incident, not once per pass");
    // Heard again: the incident closes, and the next one is said.
    t.poll({ okAt: T + 86_400, botId: "111" });
    telegramLiveness(T + 86_410);
    assert.ok(lines.some((l) => l === `[orchestrator] telegram polling again: ${t.tenant}`));
    telegramLiveness(T + 86_400 + 601);
    assert.equal(t.alerts().length, 2);
    assert.deepEqual(t.proc.signals, [], "NOTHING WAS KILLED");
  });

  it("names the failure the process recorded", async () => {
    const t = await heldTenant();
    t.poll({ okAt: T - 7_200, err: "conflict: another program is reading this bot's updates (409)", errAt: T - 10, botId: "111" });
    telegramLiveness(T);
    telegramLiveness(T + 601);
    assert.equal(t.alerts().length, 1);
    assert.match(t.alerts()[0]!, /not polling: .* \(conflict: another program is reading this bot's updates \(409\)\)$/);
  });

  it("A REFUSED TOKEN IS ITS OWN LINE, at once, and once", async () => {
    const t = await heldTenant();
    t.poll({ okAt: T - 60, err: "refused: 401 Unauthorized", errAt: T - 5, botId: "111" });
    telegramLiveness(T);
    telegramLiveness(T + 30);
    telegramLiveness(T + 900);
    assert.deepEqual(t.alerts(), [
      `[orchestrator] [alert] telegram bot token refused: ${t.tenant} — its owner has to paste a new token from @BotFather (refused: 401 Unauthorized)`,
    ]);
    assert.deepEqual(t.proc.signals, []);
  });

  it("says nothing for a bot switched off, or with no token", async () => {
    const off = await heldTenant({ telegramEnabled: false, telegramBotToken: "111:AAA" });
    const none = await heldTenant({ telegramEnabled: true });
    off.poll(null);
    none.poll(null);
    telegramLiveness(T);
    telegramLiveness(T + 86_400);
    assert.deepEqual([...off.alerts(), ...none.alerts()], []);
  });

  it("a record about another bot does not count as hearing this one", async () => {
    // The owner saved a new bot; the record in the home is the old bot's.
    const t = await heldTenant({ telegramEnabled: true, telegramBotToken: "222:BBB" });
    t.poll({ okAt: T + 10_000, botId: "111" }, "111");
    telegramLiveness(T);
    telegramLiveness(T + 601);
    assert.equal(t.alerts().length, 1);
    assert.match(t.alerts()[0]!, /since the watch began at /);
  });

  it("A BOT WHOSE PROCESSES KEEP DYING IS STILL SAID: the clock is the tenant's, not each process's", async () => {
    // Keyed on the process, each respawn restarted the clock, and a bot that
    // no process lived ten minutes to poll was never said. This is the
    // incident's own shape: nothing polling the bot, for hours.
    const t = await heldTenant();
    t.poll(null);
    telegramLiveness(T);
    const procs = [t.proc];
    for (let i = 1; i <= 3; i++) {
      procs.push(await t.respawn());
      telegramLiveness(T + i * 240);
    }
    assert.equal(t.alerts().length, 1, "said once, after ten minutes, across three processes");
    assert.match(t.alerts()[0]!, new RegExp(`since the watch began at ${new Date(T * 1000).toISOString().replace(/\./g, "\\.")}`));
    assert.deepEqual(procs.flatMap((p) => p.signals), [], "and nothing was killed");
  });

  it("A TENANT WITH NO PROCESS RUNNING IS WATCHED TOO, while its lease is held", async () => {
    // Between two processes, or sitting out a crash cool-off: nothing polls
    // its bot, and that is exactly what must be said.
    const t = await heldTenant(undefined, { running: false });
    t.poll({ okAt: T - 60, botId: "111" });
    telegramLiveness(T);
    telegramLiveness(T + 601);
    assert.equal(t.alerts().length, 1);
  });

  it("another bot starts the clock again: a bot saved a minute ago is not deaf", async () => {
    const t = await heldTenant();
    t.poll(null);
    telegramLiveness(T);
    t.settings({ telegramEnabled: true, telegramBotToken: "222:BBB" });
    telegramLiveness(T + 500);
    telegramLiveness(T + 700);
    assert.deepEqual(t.alerts(), [], "the new bot has had 200 seconds");
    telegramLiveness(T + 1_101);
    assert.equal(t.alerts().length, 1);
  });

  it("WHAT THE HOME'S FILE SAYS CANNOT FORGE A LINE IN THIS LOG", async () => {
    // telegram.json is in the tenant's home, which an agent with shell or file
    // tools can write. Its error goes into an [alert] line; a line break in it
    // would put a second line of the file's choosing into the fleet's log,
    // untagged, reading as the orchestrator's own.
    const t = await heldTenant();
    const forged = "[orchestrator] [alert] telegram bot token refused: 0xdeadbeef — forged";
    t.poll({ okAt: T - 7_200, err: `failed: x\n${forged}\r\u2028y`, errAt: T - 5, botId: "111" });
    telegramLiveness(T);
    telegramLiveness(T + 601);
    assert.equal(t.alerts().length, 1);
    for (const l of lines) assert.ok(!/[\n\r\u2028\u2029]/.test(l), `one line per log call: ${JSON.stringify(l)}`);
    assert.ok(!lines.some((l) => l.startsWith(forged)));
    // Nor can a far-future stamp keep a deaf bot "heard".
    const future = await heldTenant();
    future.poll({ okAt: T + 30 * 86_400, botId: "111" });
    telegramLiveness(T);
    telegramLiveness(T + 601);
    assert.equal(future.alerts().length, 1);
  });
});
