/**
 * Telegram groups — whose key writes group lines, and the gate every group
 * model call goes through (docs/tg-groups.md, "The model", rule 7).
 *
 * What these pin:
 *   - the four-step order: a dedicated key; else the owner's own key (hosted:
 *     only one that is not a fleet key); else, hosted, the house key only with
 *     the share flag; else nothing — and a dedicated key equal to a fleet key
 *     is refused unless the operator says it may share one;
 *   - no key value ever appears in a label, a boot line or a log line;
 *   - the gate's allowances (per agent per day, per chat per hour) are taken
 *     from the durable store, a paused model is never called, provider
 *     failures pause it for the right time, at most two calls run at once,
 *     more than six waiting are dropped, every call is time-boxed, and `run`
 *     never throws.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mergeSettings } from "../../settings";
import {
  TG_GROUPS_ANTHROPIC_DEFAULT_MODEL,
  TG_GROUPS_GROQ_BASE_URL,
  TG_GROUPS_GROQ_DEFAULT_MODEL,
  TgModelGate,
  callText,
  describeTgGroupsModel,
  resolveTgGroupsModel,
  tgGroupsDedicatedKeyProblem,
  tgGroupsPerDay,
  type TgModel,
} from "./model";
import { TgGroupsStore, emptyTgGroupsState } from "./store";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const CHAT = -1001234567890;
const OTHER = -1009876543210;

/** A ResolvedConfig from a settings file and an environment, the way settings.ts builds one. */
const cfg = (file: Record<string, unknown>, env: Record<string, string> = {}) => mergeSettings(file as never, env);

const HOUSE_GROQ = "gsk_house_fleet_key_000000000000";
const HOUSE_ANTHROPIC = "sk-ant-house-fleet-key-00000000000";
const OWN_GROQ = "gsk_owner_saved_key_1111111111111";
const DEDICATED = "gsk_dedicated_tg_groups_22222222222";

// ── the resolver ────────────────────────────────────────────────────────────

describe("resolveTgGroupsModel: the dedicated key", () => {
  it("is used first, groq by default, with the X writer's default model and base", () => {
    const m = resolveTgGroupsModel(cfg({ groqApiKey: OWN_GROQ }), { MERRYMEN_TG_GROUPS_LLM_KEY: DEDICATED }, true);
    assert.equal(m?.source, "dedicated");
    assert.equal(m?.creds.provider, "groq");
    assert.equal(m?.creds.transport, "openai");
    assert.equal(m?.creds.baseUrl, TG_GROUPS_GROQ_BASE_URL);
    assert.equal(m?.creds.model, TG_GROUPS_GROQ_DEFAULT_MODEL);
    assert.equal(m?.creds.apiKey, DEDICATED);
    assert.equal(TG_GROUPS_GROQ_BASE_URL, "https://api.groq.com/openai/v1");
    assert.equal(TG_GROUPS_GROQ_DEFAULT_MODEL, "qwen/qwen3.8-27b");
  });

  it("is trimmed, and MERRYMEN_TG_GROUPS_MODEL overrides the default model", () => {
    const m = resolveTgGroupsModel(cfg({}), { MERRYMEN_TG_GROUPS_LLM_KEY: `  ${DEDICATED}\n`, MERRYMEN_TG_GROUPS_MODEL: " llama-small " }, false);
    assert.equal(m?.creds.apiKey, DEDICATED);
    assert.equal(m?.creds.model, "llama-small");
  });

  it("speaks anthropic with Opus 5 by default", () => {
    const m = resolveTgGroupsModel(cfg({}), { MERRYMEN_TG_GROUPS_LLM_KEY: "sk-ant-dedicated", MERRYMEN_TG_GROUPS_LLM_PROVIDER: "Anthropic" }, true);
    assert.equal(m?.creds.provider, "anthropic");
    assert.equal(m?.creds.transport, "anthropic");
    assert.equal(m?.creds.baseUrl, "");
    assert.equal(m?.creds.model, TG_GROUPS_ANTHROPIC_DEFAULT_MODEL);
    assert.equal(TG_GROUPS_ANTHROPIC_DEFAULT_MODEL, "claude-opus-5");
  });

  it("speaks any OpenAI-compatible endpoint given an https base and a model", () => {
    const m = resolveTgGroupsModel(
      cfg({}),
      {
        MERRYMEN_TG_GROUPS_LLM_KEY: "sk-openai-dedicated",
        MERRYMEN_TG_GROUPS_LLM_PROVIDER: "openai",
        MERRYMEN_TG_GROUPS_LLM_BASE_URL: "https://llm.example/v1///",
        MERRYMEN_TG_GROUPS_MODEL: "small-chat",
      },
      true,
    );
    assert.equal(m?.source, "dedicated");
    assert.equal(m?.creds.baseUrl, "https://llm.example/v1");
    assert.equal(m?.creds.model, "small-chat");
  });

  it("accepts http only on loopback, and never a base carrying credentials", () => {
    const env = (base: string) => ({
      MERRYMEN_TG_GROUPS_LLM_KEY: "sk-openai-dedicated",
      MERRYMEN_TG_GROUPS_LLM_PROVIDER: "openai",
      MERRYMEN_TG_GROUPS_LLM_BASE_URL: base,
      MERRYMEN_TG_GROUPS_MODEL: "m",
    });
    assert.equal(resolveTgGroupsModel(cfg({}), env("http://127.0.0.1:1234/v1"), true)?.source, "dedicated");
    assert.equal(resolveTgGroupsModel(cfg({}), env("http://llm.example/v1"), true), null);
    assert.equal(resolveTgGroupsModel(cfg({}), env("https://user:pw@llm.example/v1"), true), null);
  });

  it("openai without a base or a model, or an unknown provider, falls through to the owner's key", () => {
    const own = cfg({ groqApiKey: OWN_GROQ });
    const noModel = { MERRYMEN_TG_GROUPS_LLM_KEY: "k-1", MERRYMEN_TG_GROUPS_LLM_PROVIDER: "openai", MERRYMEN_TG_GROUPS_LLM_BASE_URL: "https://x.example/v1" };
    assert.equal(resolveTgGroupsModel(own, noModel, false)?.source, "owner");
    assert.match(tgGroupsDedicatedKeyProblem(noModel) ?? "", /MERRYMEN_TG_GROUPS_MODEL/);
    const odd = { MERRYMEN_TG_GROUPS_LLM_KEY: "k-1", MERRYMEN_TG_GROUPS_LLM_PROVIDER: "gemini" };
    assert.equal(resolveTgGroupsModel(own, odd, false)?.source, "owner");
    assert.equal(resolveTgGroupsModel(cfg({}), odd, true), null);
  });

  for (const fleet of ["GROQ_API_KEY", "MERRYMEN_LLM_API_KEY", "ANTHROPIC_API_KEY"]) {
    it(`is refused when it equals ${fleet}, unless MERRYMEN_TG_GROUPS_SHARE_HOUSE_KEY=1`, () => {
      const env: Record<string, string> = { [fleet]: HOUSE_GROQ, MERRYMEN_TG_GROUPS_LLM_KEY: ` ${HOUSE_GROQ} ` };
      assert.equal(resolveTgGroupsModel(cfg({}), env, true), null);
      const problem = tgGroupsDedicatedKeyProblem(env) ?? "";
      assert.match(problem, new RegExp(fleet));
      assert.ok(!problem.includes(HOUSE_GROQ), "the problem line names the variable, never the value");
      const shared = resolveTgGroupsModel(cfg({}), { ...env, MERRYMEN_TG_GROUPS_SHARE_HOUSE_KEY: " 1 " }, true);
      assert.equal(shared?.source, "dedicated");
      assert.equal(shared?.creds.apiKey, HOUSE_GROQ);
    });
  }

  it("the share flag is exactly 1", () => {
    for (const flag of ["true", "yes", "01", "", "on"]) {
      const env = { GROQ_API_KEY: HOUSE_GROQ, MERRYMEN_TG_GROUPS_LLM_KEY: HOUSE_GROQ, MERRYMEN_TG_GROUPS_SHARE_HOUSE_KEY: flag };
      assert.equal(resolveTgGroupsModel(cfg({}), env, true), null, `flag ${JSON.stringify(flag)}`);
    }
  });

  it("a refused dedicated key falls through to the owner's own key, never the house's", () => {
    const env = { GROQ_API_KEY: HOUSE_GROQ, MERRYMEN_TG_GROUPS_LLM_KEY: HOUSE_GROQ };
    const m = resolveTgGroupsModel(cfg({ groqApiKey: OWN_GROQ }, env), env, true);
    assert.equal(m?.source, "owner");
    assert.equal(m?.creds.apiKey, OWN_GROQ);
  });
});

describe("resolveTgGroupsModel: the owner's key and the house's", () => {
  it("self-hosted: whatever resolveLlm picks — the owner is the operator", () => {
    const env = { GROQ_API_KEY: HOUSE_GROQ };
    const m = resolveTgGroupsModel(cfg({}, env), env, false);
    assert.equal(m?.source, "owner");
    assert.equal(m?.creds.apiKey, HOUSE_GROQ);
  });

  it("self-hosted with no key at all: no model", () => {
    assert.equal(resolveTgGroupsModel(cfg({}), {}, false), null);
  });

  it("hosted: a key the owner saved beats the house default", () => {
    const env = { GROQ_API_KEY: HOUSE_GROQ, ANTHROPIC_API_KEY: HOUSE_ANTHROPIC };
    const m = resolveTgGroupsModel(cfg({ groqApiKey: OWN_GROQ }, { GROQ_API_KEY: HOUSE_GROQ }), env, true);
    assert.equal(m?.source, "owner");
    assert.equal(m?.creds.apiKey, OWN_GROQ);
  });

  it("hosted: the house default alone is never spent", () => {
    const env = { GROQ_API_KEY: HOUSE_GROQ, ANTHROPIC_API_KEY: HOUSE_ANTHROPIC };
    assert.equal(resolveTgGroupsModel(cfg({}, env), env, true), null);
  });

  it("hosted: the house key only with the share flag, and then it says so", () => {
    const env = { GROQ_API_KEY: HOUSE_GROQ, MERRYMEN_TG_GROUPS_SHARE_HOUSE_KEY: "1" };
    const m = resolveTgGroupsModel(cfg({}, env), env, true);
    assert.equal(m?.source, "house");
    assert.equal(m?.creds.apiKey, HOUSE_GROQ);
    assert.match(describeTgGroupsModel(m), /house key/);
  });

  it("hosted: an owner who selected a provider they have no key for still gets the key they did save", () => {
    // resolveLlm alone would hand back the house Anthropic key for the
    // selection; the owner's own Groq key is the one to use.
    const env = { ANTHROPIC_API_KEY: HOUSE_ANTHROPIC, GROQ_API_KEY: HOUSE_GROQ };
    const m = resolveTgGroupsModel(cfg({ llmProvider: "anthropic", groqApiKey: OWN_GROQ }, env), env, true);
    assert.equal(m?.source, "owner");
    assert.equal(m?.creds.provider, "groq");
    assert.equal(m?.creds.apiKey, OWN_GROQ);
  });

  it("hosted: an owner key that happens to equal a fleet key is the house's", () => {
    const env = { MERRYMEN_LLM_API_KEY: OWN_GROQ };
    assert.equal(resolveTgGroupsModel(cfg({ groqApiKey: OWN_GROQ }), env, true), null);
  });
});

describe("labels and the boot line never carry a key", () => {
  it("label is provider/model", () => {
    const m = resolveTgGroupsModel(cfg({}), { MERRYMEN_TG_GROUPS_LLM_KEY: DEDICATED }, true)!;
    assert.equal(m.label, `groq/${TG_GROUPS_GROQ_DEFAULT_MODEL}`);
    assert.ok(!describeTgGroupsModel(m).includes(DEDICATED));
    assert.match(describeTgGroupsModel(m), /its own key/);
  });

  it("a model name that carries the key has it taken out", () => {
    const m = resolveTgGroupsModel(cfg({}), { MERRYMEN_TG_GROUPS_LLM_KEY: DEDICATED, MERRYMEN_TG_GROUPS_MODEL: `x-${DEDICATED}` }, true)!;
    assert.ok(!m.label.includes(DEDICATED));
    assert.ok(!describeTgGroupsModel(m).includes(DEDICATED));
  });

  it("no model: the line says templates", () => {
    assert.match(describeTgGroupsModel(null), /no model/);
    assert.match(describeTgGroupsModel(null), /templates/);
  });

  it("the owner's key is named as the owner's", () => {
    const m = resolveTgGroupsModel(cfg({ groqApiKey: OWN_GROQ }), {}, false);
    assert.match(describeTgGroupsModel(m), /owner's own key/);
    assert.ok(!describeTgGroupsModel(m).includes(OWN_GROQ));
  });
});

describe("tgGroupsPerDay", () => {
  it("defaults: 300 hosted, 1000 self-hosted", () => {
    assert.equal(tgGroupsPerDay({}, true), 300);
    assert.equal(tgGroupsPerDay({}, false), 1000);
    assert.equal(tgGroupsPerDay({ MERRYMEN_TG_GROUPS_LLM_PER_DAY: "  " }, true), 300);
  });

  it("reads the variable, floored and clamped to [0, 20000]", () => {
    assert.equal(tgGroupsPerDay({ MERRYMEN_TG_GROUPS_LLM_PER_DAY: " 42 " }, true), 42);
    assert.equal(tgGroupsPerDay({ MERRYMEN_TG_GROUPS_LLM_PER_DAY: "12.9" }, true), 12);
    assert.equal(tgGroupsPerDay({ MERRYMEN_TG_GROUPS_LLM_PER_DAY: "0" }, true), 0);
    assert.equal(tgGroupsPerDay({ MERRYMEN_TG_GROUPS_LLM_PER_DAY: "-5" }, false), 0);
    assert.equal(tgGroupsPerDay({ MERRYMEN_TG_GROUPS_LLM_PER_DAY: "99999999" }, false), 20_000);
    assert.equal(tgGroupsPerDay({ MERRYMEN_TG_GROUPS_LLM_PER_DAY: "1e3" }, false), 1000);
  });

  it("junk reads as the default", () => {
    assert.equal(tgGroupsPerDay({ MERRYMEN_TG_GROUPS_LLM_PER_DAY: "lots" }, true), 300);
    assert.equal(tgGroupsPerDay({ MERRYMEN_TG_GROUPS_LLM_PER_DAY: "Infinity" }, false), 1000);
  });
});

// ── the gate ────────────────────────────────────────────────────────────────

let home: string;
let clock: number;
let store: TgGroupsStore;
let logs: string[];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "tg-model-"));
  clock = T0;
  store = new TgGroupsStore(path.join(home, "tg-groups.json"), emptyTgGroupsState(), { now: () => clock, debounceMs: 60_000 });
  store.ensureRoom(CHAT, { title: "frens", kind: "supergroup" });
  store.ensureRoom(OTHER, { title: "others", kind: "supergroup" });
  logs = [];
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

function gate(o: Partial<ConstructorParameters<typeof TgModelGate>[1]> = {}): TgModelGate {
  return new TgModelGate(store, { perDay: 100, now: () => clock, log: (s) => logs.push(s), ...o });
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("TgModelGate: allowances", () => {
  it("returns what the call returns, and counts it against the day and the chat's hour", async () => {
    const g = gate();
    assert.equal(await g.run(CHAT, async () => "lol"), "lol");
    assert.equal(store.state.llm.used, 1);
    assert.equal(store.room(CHAT)?.llmHour?.n, 1);
    assert.equal(store.room(OTHER)?.llmHour, undefined);
  });

  it("the day's allowance: past it the call is never made", async () => {
    const g = gate({ perDay: 2 });
    let calls = 0;
    const fn = async () => ++calls;
    assert.equal(await g.run(CHAT, fn), 1);
    assert.equal(await g.run(OTHER, fn), 2);
    assert.equal(g.available(CHAT), false);
    assert.equal(await g.run(CHAT, fn), null);
    assert.equal(calls, 2);
  });

  it("a new UTC day is a fresh allowance", async () => {
    const g = gate({ perDay: 1 });
    assert.equal(await g.run(CHAT, async () => 1), 1);
    assert.equal(await g.run(CHAT, async () => 2), null);
    clock += 13 * 60 * MIN;
    assert.equal(g.available(CHAT), true);
    assert.equal(await g.run(CHAT, async () => 3), 3);
  });

  it("perDay 0 disables the model", async () => {
    const g = gate({ perDay: 0 });
    let called = false;
    assert.equal(g.available(CHAT), false);
    assert.equal(
      await g.run(CHAT, async () => {
        called = true;
        return 1;
      }),
      null,
    );
    assert.equal(called, false);
  });

  it("the chat's hourly allowance is per chat, 40 by default", async () => {
    const g = gate({ perChatHour: 1 });
    assert.equal(await g.run(CHAT, async () => "a"), "a");
    assert.equal(g.available(CHAT), false);
    assert.equal(await g.run(CHAT, async () => "b"), null);
    assert.equal(await g.run(OTHER, async () => "c"), "c");
    clock += 60 * MIN;
    assert.equal(await g.run(CHAT, async () => "d"), "d");

    const d = gate();
    for (let i = 0; i < 39; i++) await d.run(OTHER, async () => i);
    assert.equal(d.available(OTHER), true, "thirty-nine this hour");
    await d.run(OTHER, async () => 40);
    assert.equal(d.available(OTHER), false, "forty this hour");
  });

  it("an unknown chat has no allowance", async () => {
    const g = gate();
    assert.equal(g.available(-42), false);
    assert.equal(await g.run(-42, async () => 1), null);
  });

  it("the allowance survives a restart: it lives in the store's file", async () => {
    const g = gate({ perDay: 1 });
    await g.run(CHAT, async () => 1);
    store.flush();
    const again = TgGroupsStore.open(home, { now: () => clock, debounceMs: 60_000 });
    try {
      assert.equal(new TgModelGate(again, { perDay: 1, now: () => clock }).available(CHAT), false);
    } finally {
      again.close();
    }
  });
});

describe("TgModelGate: provider failures pause the model", () => {
  const fail = (msg: string, extra: Record<string, unknown> = {}) => async () => {
    throw Object.assign(new Error(msg), extra);
  };
  const midnight = Date.UTC(2026, 8, 29);

  it("a paused model is never called", async () => {
    store.pauseLlm(clock + 5 * MIN);
    const g = gate();
    let called = false;
    assert.equal(g.available(CHAT), false);
    assert.equal(
      await g.run(CHAT, async () => {
        called = true;
        return 1;
      }),
      null,
    );
    assert.equal(called, false);
    assert.equal(store.state.llm.used, 0, "a refused call costs no allowance");
  });

  it("a 429 pauses ten minutes", async () => {
    const g = gate();
    assert.equal(await g.run(CHAT, fail("groq 429 — rate_limit_exceeded: Rate limit reached for requests per minute")), null);
    assert.equal(store.llmPausedUntil(), clock + 10 * MIN);
    assert.deepEqual(logs, ["[tg-groups] model call failed (rate-limited), paused for ten minutes"]);
  });

  it("a spent daily cap pauses until UTC midnight", async () => {
    const g = gate();
    await g.run(CHAT, fail("groq 429 — rate_limit_exceeded: Rate limit reached for model on tokens per day (TPD): Limit 500000"));
    assert.equal(store.llmPausedUntil(), midnight);
    assert.match(logs[0] ?? "", /daily-cap/);
  });

  it("a rejected key pauses until UTC midnight", async () => {
    const g = gate();
    await g.run(CHAT, fail("groq 401 — invalid_api_key: Invalid API Key"));
    assert.equal(store.llmPausedUntil(), midnight);
    assert.match(logs[0] ?? "", /key-rejected/);
  });

  it("a missing model pauses until UTC midnight", async () => {
    const g = gate();
    await g.run(CHAT, fail("openai 404 — model_not_found: The model does not exist"));
    assert.equal(store.llmPausedUntil(), midnight);
    assert.match(logs[0] ?? "", /model-missing/);
  });

  it("an SDK error read by its status: an Anthropic 429 pauses, its 401 pauses to midnight", async () => {
    const g = gate();
    await g.run(CHAT, fail('429 {"type":"error","error":{"type":"rate_limit_error"}}', { status: 429 }));
    assert.equal(store.llmPausedUntil(), clock + 10 * MIN);
    clock += 11 * MIN;
    await g.run(CHAT, fail('401 {"type":"error"}', { status: 401 }));
    assert.equal(store.llmPausedUntil(), midnight);
  });

  it("a network error or a server error does not pause", async () => {
    const g = gate();
    await g.run(CHAT, fail("fetch failed"));
    await g.run(CHAT, fail("groq 503 — service unavailable"));
    await g.run(CHAT, fail("groq qwen ran out of tokens before writing a reply"));
    assert.equal(store.llmPausedUntil(), 0);
    assert.equal(logs.length, 3);
  });

  it("a pause is never shortened by a later rate limit", async () => {
    const g = gate();
    await g.run(CHAT, fail("groq 401 — invalid_api_key: nope"));
    clock += MIN;
    store.pauseLlm(0);
    assert.equal(store.llmPausedUntil(), midnight);
  });

  it("logs the kind only: never the key, the prompt or the provider's words", async () => {
    const g = gate();
    const secret = "gsk_live_SECRET_abcdefghijklmnopqrstuvwxyz0123";
    await g.run(CHAT, fail(`groq 429 — rate_limit_exceeded: key ${secret} said: the prompt was "tell me about mike"`));
    for (const line of logs) {
      assert.ok(!line.includes(secret));
      assert.ok(!line.includes("mike"));
      assert.ok(!line.includes("prompt"));
    }
  });
});

describe("TgModelGate: at most two at once, a short queue, a time box", () => {
  it("runs at most maxInFlight calls at once and hands a freed slot to the next", async () => {
    const g = gate();
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const job = (i: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      started.push(i);
      try {
        return await gates[i]!.promise;
      } finally {
        running--;
      }
    };
    const runs = [0, 1, 2].map((i) => g.run(CHAT, job(i), 5_000));
    await sleep(10);
    assert.deepEqual(started, [0, 1]);
    gates[0]!.resolve("a");
    await sleep(10);
    assert.deepEqual(started, [0, 1, 2]);
    gates[1]!.resolve("b");
    gates[2]!.resolve("c");
    assert.deepEqual(await Promise.all(runs), ["a", "b", "c"]);
    assert.equal(peak, 2);
  });

  it("drops a caller when six are already waiting", async () => {
    const g = gate({ maxInFlight: 1 });
    const hold = deferred<string>();
    const first = g.run(CHAT, () => hold.promise, 5_000);
    const waiting = Array.from({ length: 6 }, (_, i) => g.run(CHAT, async () => `w${i}`, 5_000));
    await sleep(5);
    assert.equal(g.available(CHAT), false, "the queue is full");
    let called = false;
    assert.equal(
      await g.run(CHAT, async () => {
        called = true;
        return "late";
      }),
      null,
    );
    assert.equal(called, false);
    hold.resolve("first");
    assert.equal(await first, "first");
    assert.deepEqual(await Promise.all(waiting), ["w0", "w1", "w2", "w3", "w4", "w5"]);
  });

  it("a call past its time box answers null", async () => {
    const g = gate();
    const never = deferred<string>();
    const t = Date.now();
    assert.equal(await g.run(CHAT, () => never.promise, 40), null);
    assert.ok(Date.now() - t < 1_000);
    assert.deepEqual(logs, ["[tg-groups] model call timed out"]);
    never.resolve("too late");
  });

  it("a failure that lands after the time box still pauses the model", async () => {
    const g = gate();
    const late = deferred<string>();
    assert.equal(await g.run(CHAT, () => late.promise, 20), null);
    late.reject(new Error("groq 429 — rate_limit_exceeded: slow down"));
    await sleep(5);
    assert.equal(store.llmPausedUntil(), clock + 10 * MIN);
  });

  it("a timed-out call keeps its slot until it settles, so the provider never sees more than two", async () => {
    const g = gate();
    const a = deferred<string>();
    const b = deferred<string>();
    assert.equal(await g.run(CHAT, () => a.promise, 20), null);
    assert.equal(await g.run(CHAT, () => b.promise, 20), null);
    let third = false;
    const c = g.run(
      CHAT,
      async () => {
        third = true;
        return "c";
      },
      2_000,
    );
    await sleep(10);
    assert.equal(third, false, "both slots are still held by the calls that timed out");
    a.resolve("late");
    assert.equal(await c, "c");
    b.resolve("late");
  });

  it("a caller dropped while waiting costs no allowance", async () => {
    const g = gate({ maxInFlight: 1 });
    const hold = deferred<string>();
    const first = g.run(CHAT, () => hold.promise, 5_000);
    assert.equal(await g.run(CHAT, async () => "never", 30), null);
    assert.equal(store.state.llm.used, 1, "only the call that ran was counted");
    hold.resolve("x");
    await first;
  });

  it("never throws: not for a throwing call, a throwing logger or a broken store", async () => {
    const g = new TgModelGate(store, {
      perDay: 10,
      now: () => clock,
      log: () => {
        throw new Error("logger down");
      },
    });
    assert.equal(await g.run(CHAT, async () => 1, Number.NaN), 1, "a bad time box reads as the default");
    assert.equal(
      await g.run(CHAT, () => {
        throw new Error("groq 429 — sync throw");
      }),
      null,
    );
    assert.equal(store.llmPausedUntil(), clock + 10 * MIN, "a synchronous throw is classified too");
    const broken = {
      llmPausedUntil: () => {
        throw new Error("disk");
      },
    } as unknown as TgGroupsStore;
    const b = new TgModelGate(broken, { perDay: 10 });
    assert.equal(b.available(CHAT), false);
    assert.equal(await b.run(CHAT, async () => 1), null);
  });
});

// ── the call ────────────────────────────────────────────────────────────────

describe("callText", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const m: TgModel = {
    creds: { provider: "groq", transport: "openai", baseUrl: "https://llm.test/v1", apiKey: "k-test", model: "fake", vision: false },
    label: "groq/fake",
    source: "dedicated",
  };

  it("strips the thinking, and never asks for a budget a reasoning model could spend on thinking alone", async () => {
    let body: { max_tokens?: number; messages?: Array<{ role: string; content: string }> } = {};
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "<think>is it good?</think> lol fair" } }] }) };
    }) as never;
    assert.equal(await callText(m, "sys", "go", 40), "lol fair");
    assert.ok((body.max_tokens ?? 0) >= 600);
    assert.deepEqual(
      body.messages?.map((x) => x.role),
      ["system", "user"],
    );
  });

  it("an answer that was all thinking is empty, never the raw text", async () => {
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "<think>ran out mid thought" } }] }) })) as never;
    assert.equal(await callText(m, "sys", "go", 900), "");
  });

  it("throws what the provider said, for the gate to classify", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 429, text: async () => '{"error":{"code":"rate_limit_exceeded","message":"slow"}}' })) as never;
    await assert.rejects(callText(m, "sys", "go", 900), /429/);
  });
});
