/**
 * HOME'S ONE TELEGRAM BUTTON, run through the real components.
 *
 * The owner asked for "a single button on home that takes care of telegram
 * completely". These pin that every step of the setup is one primary control
 * on the Telegram row (create, open Telegram, connect, turn on, open my bot),
 * that it moves on by itself, and that a step it cannot do is a way to
 * Settings rather than a dead button.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import React, { act } from "react";
import { AgentStrip } from "./AgentStrip";
import { TelegramCreateBot } from "./TelegramCreateBot";
import { json, testDom } from "./test-dom";

const OWNER = `0x${"1".repeat(40)}`;
const ID = "setup-1234567890";
const originalFetch = globalThis.fetch;
type Call = { url: string; init?: RequestInit };
let ui: ReturnType<typeof testDom>;
let calls: Call[];
let respond: (call: Call) => Promise<Response>;

const intent = (status = "waiting_telegram") => ({
  id: ID, status, expiresAt: Date.now() + 60_000,
  botUsername: status === "confirm" || status === "connected" ? "merrymen_testbot" : null,
  botId: status === "confirm" || status === "connected" ? "1234567" : null,
});
const drain = () => act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
async function advance(ms: number) { await act(async () => mock.timers.tick(ms)); await drain(); }
const primaries = () => [...ui.container.querySelectorAll<HTMLElement>(".mm-btn.primary")];
const primary = () => { const all = primaries(); assert.equal(all.length, 1, `exactly one primary control, got ${all.map(b => b.textContent).join(" | ")}`); return all[0]!; };
const path = (call: Call) => new URL(call.url, "https://app.example.test").pathname;

const tgStatus = (over: Record<string, unknown> = {}) => ({
  enabled: true, hasToken: true, connected: true, botUsername: "merrymen_testbot", ownerId: null, allowlist: [],
  linkCode: null, linkPending: false, botElsewhere: false, listening: null, tradingHeld: null, ...over,
});

beforeEach(() => {
  ui = testDom();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  calls = [];
  ui.dom.window.open = () => null;
  // next/link's prefetch observer schedules on `self`, a browser global
  // test-dom does not install; the strip's Settings links are next/links.
  Object.defineProperty(globalThis, "self", { configurable: true, writable: true, value: ui.dom.window });
  globalThis.fetch = async (input, init) => { const call = { url: String(input), init }; calls.push(call); return respond(call); };
});
afterEach(async () => { Reflect.deleteProperty(globalThis, "self"); await ui.close(); mock.timers.reset(); globalThis.fetch = originalFetch; });

describe("TelegramCreateBot compact: the create steps as one button", () => {
  it("Set up Telegram → Open Telegram → Connect @bot → saved, one primary control at every step", async () => {
    let server = intent();
    respond = async call => {
      if (call.init?.method === "POST") {
        const action = (JSON.parse(String(call.init.body)) as { action: string }).action;
        if (action === "begin") return json({ intent: server, telegramUrl: "https://t.me/MerrymenManagerBot?start=server_nonce" });
        if (action === "confirm") { server = intent("connected"); return json({ intent: server }); }
      }
      return json({ available: true, intent: server });
    };
    const connected: string[] = [];
    await ui.render(React.createElement(TelegramCreateBot, { compact: true, owner: OWNER, hasBot: false,
      onConnected: async (_o: string, _s: AbortSignal, bot: string) => { connected.push(bot); }, onIntentMissing: async () => {} }));
    await drain();
    assert.equal(primary().textContent, "Set up Telegram");

    await ui.click("Set up Telegram");
    await drain();
    const open = primary() as HTMLAnchorElement;
    assert.equal(open.textContent, "Open Telegram");
    assert.equal(open.href, "https://t.me/MerrymenManagerBot?start=server_nonce");
    assert.ok([...ui.container.querySelectorAll("button")].some(b => b.textContent === "Cancel"), "cancel is there, quietly");

    // Telegram made the bot: the same button now connects it, by name.
    server = intent("confirm");
    await advance(3000);
    assert.equal(primary().textContent, "Connect @merrymen_testbot");
    await ui.click("Connect @merrymen_testbot");
    await drain();
    assert.deepEqual(connected, ["merrymen_testbot"], "the row is told to re-read once the bot is saved");
  });

  it("when creation can't start here, the button goes to the manual path in Settings", async () => {
    respond = async () => json({ available: false });
    await ui.render(React.createElement(TelegramCreateBot, { compact: true, owner: OWNER, hasBot: false, onConnected: async () => {}, onIntentMissing: async () => {} }));
    await drain();
    const link = primary() as HTMLAnchorElement;
    assert.equal(link.textContent, "Connect Telegram");
    assert.equal(new URL(link.href).hash, "#telegram");
  });
});

describe("AgentStrip: the Telegram row carries the next step", () => {
  const settingsFor = (owner: string | null) => json({ owner, values: { strategy: "momentum" } });

  it("no bot: Set up Telegram, from Home", async () => {
    respond = async call => {
      if (path(call) === "/api/telegram") return json(tgStatus({ hasToken: false, enabled: false, connected: false, botUsername: null }));
      if (path(call) === "/api/settings") return settingsFor(OWNER);
      return json({ available: true });
    };
    await ui.render(React.createElement(AgentStrip, { hasAgent: true, recovery: null }));
    await drain();
    assert.equal(primary().textContent, "Set up Telegram");
  });

  it("a saved bot switched off: Turn on Telegram writes that one setting for this owner, then re-reads", async () => {
    let enabled = false;
    respond = async call => {
      if (path(call) === "/api/telegram") return json(tgStatus({ enabled, linkCode: "code_123" }));
      if (path(call) === "/api/settings" && call.init?.method === "PUT") { enabled = true; return json({ ok: true }); }
      if (path(call) === "/api/settings") return settingsFor(OWNER);
      return json({});
    };
    await ui.render(React.createElement(AgentStrip, { hasAgent: true, recovery: null }));
    await drain();
    assert.equal(primary().textContent, "Turn on Telegram");
    await ui.click("Turn on Telegram");
    await drain();
    const put = calls.find(c => c.init?.method === "PUT")!;
    assert.deepEqual(JSON.parse(String(put.init!.body)), { telegramEnabled: true, owner: OWNER });
    assert.equal(primary().textContent, "Open my bot", "and the button moves on to linking");
  });

  it("waiting on the agent: a disabled step, re-read until the code lands, then Open my bot carries it", async () => {
    let code: string | null = null;
    respond = async call => {
      if (path(call) === "/api/telegram") return json(tgStatus({ linkCode: code, linkPending: code === null }));
      if (path(call) === "/api/settings") return settingsFor(OWNER);
      return json({});
    };
    await ui.render(React.createElement(AgentStrip, { hasAgent: true, recovery: null }));
    await drain();
    const wait = primary() as HTMLButtonElement;
    assert.equal(wait.textContent, "Starting your bot…");
    assert.equal(wait.disabled, true);
    code = "code_456";
    await advance(4000);
    const open = primary() as HTMLAnchorElement;
    assert.equal(open.textContent, "Open my bot");
    assert.equal(open.href, "https://t.me/merrymen_testbot?start=code_456");
  });

  it("linked: no button left to press", async () => {
    respond = async call => {
      if (path(call) === "/api/telegram") return json(tgStatus({ ownerId: 42 }));
      if (path(call) === "/api/settings") return settingsFor(OWNER);
      return json({});
    };
    await ui.render(React.createElement(AgentStrip, { hasAgent: true, recovery: null }));
    await drain();
    assert.equal(primaries().length, 0);
    const reads = calls.filter(c => path(c) === "/api/telegram").length;
    await advance(20_000);
    assert.equal(calls.filter(c => path(c) === "/api/telegram").length, reads, "nothing to wait for, so no polling");
  });

  it("self-hosted (no signed-in owner): the manual path in Settings", async () => {
    respond = async call => {
      if (path(call) === "/api/telegram") return json(tgStatus({ hasToken: false, enabled: false, connected: false, botUsername: null }));
      if (path(call) === "/api/settings") return settingsFor(null);
      return json({});
    };
    await ui.render(React.createElement(AgentStrip, { hasAgent: true, recovery: null }));
    await drain();
    assert.equal(primary().textContent, "Connect Telegram");
    assert.ok(!calls.some(c => path(c) === "/api/telegram/create"), "no creation attempt without an owner");
  });
});

describe("AgentStrip under a recovery hold: setting up a bot is not trading", () => {
  const held = { state: "history-only", tradingPaused: true, history: "available", memory: "unknown",
    checkedAt: 1_791_111_100, lastVerifiedHeartbeatAt: 1_791_110_000 } as unknown as import("../../../worker/src/fleet-recovery").FleetRecoveryView;
  const settingsFor = (owner: string | null) => json({ owner, values: { strategy: "momentum" } });
  const mount = async (tg: Record<string, unknown>) => {
    respond = async call => {
      if (path(call) === "/api/telegram") return json(tgStatus(tg));
      if (path(call) === "/api/settings" && call.init?.method === "PUT") return json({ ok: true });
      if (path(call) === "/api/settings") return settingsFor(OWNER);
      return json({ available: true });
    };
    await ui.render(React.createElement(AgentStrip, { hasAgent: true, recovery: held }));
    await drain();
  };

  it("no bot: the held account still gets Set up Telegram, beside the recovery notice", async () => {
    await mount({ hasToken: false, enabled: false, connected: false, botUsername: null });
    assert.ok(ui.container.querySelector(".agent-recovery"), "the recovery notice stays");
    assert.equal(primary().textContent, "Set up Telegram");
    assert.match(ui.container.textContent ?? "", /Trading paused/);
  });

  it("a saved bot switched off: Turn on Telegram, under the recovery wording", async () => {
    await mount({ enabled: false });
    assert.equal(primary().textContent, "Turn on Telegram");
    assert.match(ui.container.textContent ?? "", /Switched off/);
  });

  it("a working bot: the recovery wording, and no button that would promise trading", async () => {
    await mount({ ownerId: 42, linkCode: "code_1" });
    assert.equal(primaries().length, 0);
    assert.match(ui.container.textContent ?? "", /Waiting for recovery|Listening for public questions/);
  });

  /**
   * A NEW BOT SAVED WHILE HELD. The tenant is not admitted, so no worker and
   * no hold process runs, and the recovery listener answers only an owner
   * already linked to that exact bot: nothing mints this bot's code until the
   * agent resumes. The strip re-read /api/telegram (a live getMe with the
   * owner's token) every four seconds for fifteen minutes, waiting for it.
   */
  for (const agentDown of [null, "recovery"] as const) {
    for (const [what, tg] of [
      ["not picked up", { linkPending: true }],
      ["the old bot's held row", { linkPending: true, listening: { state: "held", lastOkAt: null, reason: "recovery-replies" }, tradingHeld: "recovery-replies" }],
    ] as const) {
      it(`a new unlinked bot with no code (${what}, agentDown ${agentDown}): says it answers once the agent resumes, and does not poll`, async () => {
        respond = async call => {
          if (path(call) === "/api/telegram") return json(tgStatus({ linkCode: null, ...tg }));
          if (path(call) === "/api/settings") return settingsFor(OWNER);
          return json({});
        };
        await ui.render(React.createElement(AgentStrip, { hasAgent: true, recovery: held, agentDown }));
        await drain();
        const text = ui.container.textContent ?? "";
        assert.match(text, /Saved\. @merrymen_testbot answers once your agent resumes\./);
        assert.doesNotMatch(text, /check back|shortly|next pass|Starting your bot/i);
        assert.equal(primaries().length, 0);
        const reads = calls.filter(c => path(c) === "/api/telegram").length;
        await advance(60_000);
        await act(async () => { document.dispatchEvent(new ui.dom.window.Event("visibilitychange")); }); await drain();
        assert.equal(calls.filter(c => path(c) === "/api/telegram").length, reads, "nothing will mint a code while held, so no getMe every four seconds");
      });
    }
  }
});

/**
 * A SAVED BOT ON AN AGENT THAT ISN'T RUNNING. A tenant the fleet holds (not
 * admitted by the rollout, an accounting hold) or whose session key expired
 * gets no worker and no hold process, so nothing mints its link code. The
 * strip was telling that owner "Your agent mints a link code on its next
 * pass. Check back shortly." and re-reading every four seconds, for a pass
 * that never comes. /api/grants already says the worker is silent, never
 * heard from, or the key expired (App.tsx agentDown); the row says that.
 */
describe("AgentStrip: a saved bot whose agent isn't running", () => {
  const settingsFor = (owner: string | null) => json({ owner, values: { strategy: "momentum" } });
  const mount = async (agentDown: "stopped" | "not-started" | "expired" | null, tg: Record<string, unknown> = {}) => {
    respond = async call => {
      if (path(call) === "/api/telegram") return json(tgStatus({ linkCode: null, linkPending: false, ...tg }));
      if (path(call) === "/api/settings") return settingsFor(OWNER);
      return json({});
    };
    await ui.render(React.createElement(AgentStrip, { hasAgent: true, recovery: null, agentDown }));
    await drain();
  };
  const text = () => ui.container.textContent ?? "";

  for (const linkPending of [false, true]) {
    it(`stopped worker, no code (${linkPending ? "a stale row" : "no row"}): says it isn't running, promises no pass, and does not poll`, async () => {
      await mount("stopped", { linkPending });
      assert.match(text(), /@merrymen_testbot answers once your agent is running; it isn't running right now\./);
      assert.doesNotMatch(text(), /check back|shortly|next pass|picked up/i);
      assert.ok(![...ui.container.querySelectorAll("button")].some(b => b.textContent === "Starting your bot…"), "no step that claims the bot is starting");
      assert.equal(primaries().length, 0);
      const reads = calls.filter(c => path(c) === "/api/telegram").length;
      await advance(60_000);
      assert.equal(calls.filter(c => path(c) === "/api/telegram").length, reads, "nothing will mint a code, so nothing to poll for");
    });
  }

  it("never heard from: says it hasn't started, and promises no pass", async () => {
    await mount("not-started");
    assert.match(text(), /answers once your agent is running; it hasn't started yet\./);
    assert.doesNotMatch(text(), /check back|shortly|next pass/i);
  });

  it("expired session key: points to renewal, not to a pass", async () => {
    await mount("expired");
    assert.match(text(), /can't run until you renew its trading permission/);
    assert.doesNotMatch(text(), /check back|shortly|next pass/i);
    const renew = [...ui.container.querySelectorAll<HTMLAnchorElement>("a")].find(a => a.textContent?.startsWith("Renew permission"));
    assert.ok(renew, "a way to renew");
    assert.equal(new URL(renew.href).pathname, "/grant");
    assert.equal(new URL(renew.href).hash, "#resign");
  });

  it("a code already on file is still shown: the hold changes only the wait", async () => {
    await mount("stopped", { linkCode: "code_789" });
    assert.equal(primary().textContent, "Open my bot");
  });

  it("an agent that is running (or not known not to be) keeps the wait and the re-read", async () => {
    await mount(null);
    assert.equal(primary().textContent, "Starting your bot…");
    const reads = calls.filter(c => path(c) === "/api/telegram").length;
    await advance(4000);
    assert.ok(calls.filter(c => path(c) === "/api/telegram").length > reads);
  });
});

describe("Turn on Telegram waits until it knows whose bot it is", () => {
  for (const recovery of [null, { state: "history-only", tradingPaused: true, history: "available", memory: "unknown",
    checkedAt: 1_791_111_100, lastVerifiedHeartbeatAt: 1_791_110_000 }]) {
    it(`${recovery ? "held" : "normal"}: hidden while /api/settings is unanswered, and the write names that owner`, async () => {
      let answerSettings!: (r: Response) => void;
      const settingsGate = new Promise<Response>(resolve => { answerSettings = resolve; });
      respond = async call => {
        if (path(call) === "/api/telegram") return json(tgStatus({ enabled: false }));
        if (path(call) === "/api/settings" && call.init?.method === "PUT") return json({ ok: true });
        if (path(call) === "/api/settings") return settingsGate;
        return json({});
      };
      await ui.render(React.createElement(AgentStrip, { hasAgent: true, recovery: recovery as never }));
      await drain();
      assert.ok(![...ui.container.querySelectorAll("button")].some(b => b.textContent === "Turn on Telegram"), "no write offered before the owner is known");
      answerSettings(json({ owner: OWNER, values: {} }));
      await drain();
      await ui.click("Turn on Telegram");
      await drain();
      const put = calls.find(c => c.init?.method === "PUT")!;
      assert.equal((JSON.parse(String(put.init!.body)) as { owner?: string }).owner, OWNER);
    });
  }
});

