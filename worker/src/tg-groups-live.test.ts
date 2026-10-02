/**
 * THE LIVE FAILURE, THROUGH THE REAL LOOK AND THE REAL PORT (docs/tg-groups.md,
 * "The coin flow", step 4).
 *
 * In the owner's test group a bare Robinhood Chain Pons bonding-curve coin was
 * posted while the fleet's RPC reads were being declined by the governor and
 * rate-limited by the provider, and GeckoTerminal pages were timing out. The
 * group handler went silent. The chat side's half of that is pinned in
 * telegram/tg-groups/scenarios.test.ts with a fake port; this file wires the
 * handler to `createTgCoinsPort(createCoinLook(...))` — the trading side's
 * look, which the chat side's tests may not import — with the chain reads
 * failing, and pins what the group then hears.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ResolvedConfig } from "./settings";
import type { FetchLike, TgMessage } from "./telegram/api";
import type { StateRef, TelegramState } from "./telegram/state";
import { createTgGroups, type TgGroups } from "./telegram/tg-groups/handler";
import { TgGroupsStore, emptyTgGroupsState } from "./telegram/tg-groups/store";
import type { Nomination } from "./telegram/tg-groups/types";
import { createCoinLook, createTgCoinsPort, type CoinLookReaders } from "./tg-coin-look";
import { emptyGeckoBuckets, type GeckoPool } from "./venues/geckoterminal";
import { readDexTokenPairs } from "./venues/dexscreener";

const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);
const CHAT = -1001234567890;
const OWNER = 424242;
const BOT = { id: 999999, username: "merrymanme_bot", name: "Pine" };
/** The coin that was posted: AppShare, on the Pons bonding curve. */
const CA = "0x0338a1b7fa2ae1cd997b541432d01af011754b0e";

const ponsPool = (): GeckoPool => ({
  poolId: `0x${"4".repeat(64)}`,
  poolAddress: null,
  tokenAddress: CA,
  name: "APPSHARE / WETH",
  dex: "pons-v2",
  priceUsd: 0.0001,
  reserveUsd: 5_000,
  fdvUsd: 20_000,
  volume24hUsd: 3_000,
  change24hPct: 0,
  change1hPct: 0,
  buys24h: 10,
  sells24h: 4,
  buyers24h: 9,
  buckets: emptyGeckoBuckets(),
  createdAt: Math.floor(T0 / 1000) - 3600,
});

describe("a Pons coin posted while the chain reads are declined: the real look, the real port", () => {
  let home: string;
  let clock: number;
  let store: TgGroupsStore;
  let groups: TgGroups;
  let sends: Array<Record<string, unknown>>;
  let reads: { code: number; pools: number; probe: number };
  let nominations: Nomination[];
  let logs: string[];
  let nextMsg: number;
  let tstate: TelegramState;
  const stateRef: StateRef = {
    get: () => tstate,
    set: (s) => {
      tstate = s;
    },
  };

  const fetchFn: FetchLike = async (url, init) => {
    const method = url.split("/").pop() ?? "";
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (method === "sendMessage") sends.push(body);
    const env = method === "sendMessage" ? { ok: true, result: { message_id: 5_000 + sends.length } } : { ok: true, result: true };
    return { ok: true, status: 200, json: async () => env };
  };

  function make(readers: Partial<CoinLookReaders>): void {
    const look = createCoinLook({
      own: () => [],
      held: () => null,
      tokenPools: async () => {
        reads.pools++;
        return [ponsPool()];
      },
      getCode: async () => {
        reads.code++;
        // What the governed client answers when the governor declines the read.
        throw new Error("rpc read declined");
      },
      probe: async () => {
        reads.probe++;
        return null;
      },
      now: () => clock,
      ...readers,
    });
    const port = createTgCoinsPort({
      readiness: () => ({ kind: "ready-paper", ownerReason: "ready" }),
      look,
      book: {
        nominate: (n) => {
          nominations.push(n);
          return { ok: true };
        },
      },
      heldNames: () => [],
      paper: () => true,
    });
    groups = createTgGroups({
      opts: () => ({ token: "123456:TOKEN", fetchFn }),
      store,
      getCfg: () =>
        ({ telegramGroupsEnabled: true, telegramGroupCoinsEnabled: true, telegramGroupsChattiness: "normal", telegramAllowlist: [OWNER] }) as unknown as ResolvedConfig,
      stateRef,
      port: () => port,
      self: () => BOT,
      privacyOff: () => true,
      note: () => {},
      dashboardBase: () => "https://app.test",
      agentKey: () => "agent-1",
      now: () => clock,
      rand: () => 0.99,
      env: {},
      hosted: true,
      sleep: async (ms) => {
        clock += Math.max(0, ms);
      },
      log: (l) => logs.push(l),
    });
    store.ensureRoom(CHAT, { title: "test group", kind: "supergroup" });
    store.setStatus(CHAT, "approved", OWNER);
    store.update(CHAT, (r) => {
      r.helloSaid = true;
    });
  }

  const msg = (text: string, over: Partial<TgMessage> = {}): TgMessage => {
    const id = nextMsg++;
    return {
      updateId: id,
      chatId: CHAT,
      fromId: OWNER,
      fromFirstName: "Milla",
      fromIsBot: false,
      text,
      messageId: id,
      date: Math.floor(clock / 1000),
      dateSec: Math.floor(clock / 1000),
      chatType: "supergroup",
      chatTitle: "test group",
      ...over,
    };
  };
  const said = async (m: TgMessage): Promise<void> => {
    groups.onMessage(m);
    await groups.drain();
  };
  const replyOf = (b: Record<string, unknown> | undefined): number | undefined => (b?.reply_parameters as { message_id?: number } | undefined)?.message_id;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tg-live-"));
    clock = T0;
    store = new TgGroupsStore(path.join(home, "tg-groups.json"), emptyTgGroupsState(), { now: () => clock, debounceMs: 60_000 });
    sends = [];
    reads = { code: 0, pools: 0, probe: 0 };
    nominations = [];
    logs = [];
    nextMsg = 100;
    tstate = { ownerId: OWNER } as unknown as TelegramState;
  });

  afterEach(async () => {
    groups?.stop();
    await groups?.drain();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("the bare CA gets the curve line, tagging her: GeckoTerminal's Robinhood page stood in for the failed getCode", async () => {
    make({});
    const post = msg(CA);
    await said(post);
    assert.equal(sends.length, 1);
    assert.equal(replyOf(sends[0]), post.messageId);
    const text = String(sends[0]?.text);
    assert.match(text, new RegExp(`^<a href="tg://user\\?id=${OWNER}">Milla</a> `), text);
    assert.match(text, /curve/, text);
    assert.ok(!/\d/.test(text.replace(/^<a [^>]+>[^<]*<\/a> /, "")), "no figure");
    assert.deepEqual(reads, { code: 1, pools: 1, probe: 0 }, "one failed getCode, one index page, no multicall on the chain that failed");
    assert.equal(nominations.length, 0, "a curve coin is never nominated");
    assert.equal(store.coin(CHAT, CA)?.verdict, "curve", "remembered as the Robinhood Chain coin it is");

    // Then "@bot didnt you see" (a reply to the CA) and "@bot ??": answered.
    const didnt = msg("@merrymanme_bot didnt you see", { replyTo: { messageId: post.messageId!, fromId: OWNER, fromIsBot: false } });
    await said(didnt);
    await said(msg("@merrymanme_bot ??"));
    assert.equal(sends.length, 3);
    assert.equal(replyOf(sends[1]), didnt.messageId);
    assert.ok(!logs.join("\n").includes(CA.slice(2, 12)), "never the address in a log");
  });

  it("the index failing too: unknown — silence for the bare CA, 'can't pull that one up rn' when it was asked", async () => {
    make({
      tokenPools: async () => {
        reads.pools++;
        return null;
      },
    });
    await said(msg(CA));
    assert.equal(sends.length, 0, "a look that could not be made is not a Robinhood Chain coin shown");
    assert.deepEqual(store.room(CHAT)?.coins, []);
    const asked = msg(`@merrymanme_bot ${CA}?`);
    await said(asked);
    assert.equal(sends.length, 1);
    assert.equal(replyOf(sends[0]), asked.messageId);
    assert.match(String(sends[0]?.text), /can't|won't|not loading|blank/);
    assert.equal(nominations.length, 0);
  });

  it("a healthy chain says the same thing about the same coin", async () => {
    make({
      getCode: async () => {
        reads.code++;
        return "0x6000";
      },
    });
    await said(msg(CA));
    assert.equal(sends.length, 1);
    assert.match(String(sends[0]?.text), /curve/);
    assert.deepEqual(reads, { code: 1, pools: 1, probe: 0 });
  });
});

describe("the Shogun exchange: a Robinhood coin while the chain AND GeckoTerminal fail, then 'wdyt about this shogun' as a reply to it", () => {
  // Commander Vrax, a Robinhood Chain coin with six figures of liquidity, was
  // posted while the fleet's RPC reads were rate-limited and GeckoTerminal's
  // shared quota was in cooldown. Its look was `unknown`, and a bare CA nobody
  // asked about gets silence for that. Then "wdyt about this shogun", replying
  // to the post, was answered by its words alone — no look — and the model
  // said "my owner's rules say i don't do 'should you buy this' talks".
  const SHOGUN = { id: 888888, username: "shogun_merry_bot", name: "Shogun" };
  const VRAX = "0x7a3c0d5e11b2f4c6a8e9d0b1c2d3e4f5a6b7c8d9";
  const DODGE = "my owner's rules say i don't do 'should you buy this' talks";
  /** DexScreener's `/tokens/v1/robinhood/<token>` answer for it, as the real parser reads it. */
  const dexBody = (nowMs: number) =>
    JSON.stringify([
      {
        chainId: "robinhood",
        dexId: "uniswap",
        url: `https://dexscreener.com/robinhood/0x${"5".repeat(40)}`,
        pairAddress: `0x${"5".repeat(40)}`,
        labels: ["v3"],
        baseToken: { address: VRAX, name: "Commander Vrax", symbol: "VRAX" },
        quoteToken: { address: "0x0000000000000000000000000000000000000006", name: "Wrapped Ether", symbol: "WETH" },
        priceUsd: "0.00041",
        txns: { m5: { buys: 12, sells: 9 }, h1: { buys: 140, sells: 90 }, h6: { buys: 500, sells: 380 }, h24: { buys: 1900, sells: 1400 } },
        volume: { m5: 1500, h1: 21000, h6: 120000, h24: 410000 },
        priceChange: { m5: 0.4, h1: 2.1, h6: -3.2, h24: 12.5 },
        liquidity: { usd: 190000 },
        fdv: 1200000,
        pairCreatedAt: nowMs - 3 * 24 * 3600_000,
      },
      // Another chain's pair of a same-looking address is never counted.
      { chainId: "ethereum", dexId: "uniswap", pairAddress: `0x${"6".repeat(40)}`, labels: ["v3"], baseToken: { address: VRAX, symbol: "VRAX" }, quoteToken: { symbol: "WETH" }, liquidity: { usd: 9 } },
    ]);

  let home: string;
  let clock: number;
  let store: TgGroupsStore;
  let groups: TgGroups;
  let sends: Array<Record<string, unknown>>;
  let nominations: Nomination[];
  let logs: string[];
  let prompts: number;
  let dexUp: boolean;
  let nextMsg: number;
  let tstate: TelegramState;
  const realFetch = globalThis.fetch;
  const stateRef: StateRef = {
    get: () => tstate,
    set: (s) => {
      tstate = s;
    },
  };
  const fetchFn: FetchLike = async (url, init) => {
    const method = url.split("/").pop() ?? "";
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (method === "sendMessage") sends.push(body);
    const env = method === "sendMessage" ? { ok: true, result: { message_id: 5_000 + sends.length } } : { ok: true, result: true };
    return { ok: true, status: 200, json: async () => env };
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tg-shogun-"));
    clock = T0;
    store = new TgGroupsStore(path.join(home, "tg-groups.json"), emptyTgGroupsState(), { now: () => clock, debounceMs: 60_000 });
    sends = [];
    nominations = [];
    logs = [];
    prompts = 0;
    dexUp = true;
    nextMsg = 300;
    tstate = { ownerId: OWNER } as unknown as TelegramState;
    // The group model answers every line with the dodge.
    globalThis.fetch = (async () => {
      prompts++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: DODGE } }] }) };
    }) as never;
    const look = createCoinLook({
      own: () => [],
      held: () => null,
      // GeckoTerminal's fleet quota in cooldown: the page cannot be read.
      tokenPools: async () => null,
      // The fleet's RPC rate-limited.
      getCode: async () => {
        throw new Error("429 Too Many Requests");
      },
      probe: async () => null,
      dexPairs: (a) =>
        readDexTokenPairs(a, {
          fetchFn: (async () => (dexUp ? new Response(dexBody(clock), { status: 200 }) : new Response("", { status: 503 }))) as unknown as typeof fetch,
        }),
      now: () => clock,
    });
    const port = createTgCoinsPort({
      readiness: () => ({ kind: "ready-paper", ownerReason: "ready" }),
      look,
      book: {
        nominate: (n) => {
          nominations.push(n);
          return { ok: true };
        },
      },
      heldNames: () => [],
      paper: () => true,
    });
    groups = createTgGroups({
      opts: () => ({ token: "123456:TOKEN", fetchFn }),
      store,
      getCfg: () =>
        ({ telegramGroupsEnabled: true, telegramGroupCoinsEnabled: true, telegramGroupsChattiness: "normal", telegramAllowlist: [OWNER] }) as unknown as ResolvedConfig,
      stateRef,
      port: () => port,
      self: () => SHOGUN,
      privacyOff: () => true,
      note: () => {},
      dashboardBase: () => "https://app.test",
      agentKey: () => "agent-1",
      now: () => clock,
      rand: () => 0.99,
      env: {
        MERRYMEN_TG_GROUPS_LLM_KEY: "k-test",
        MERRYMEN_TG_GROUPS_LLM_PROVIDER: "openai",
        MERRYMEN_TG_GROUPS_LLM_BASE_URL: "https://llm.test/v1",
        MERRYMEN_TG_GROUPS_MODEL: "fake",
      },
      hosted: true,
      sleep: async (ms) => {
        clock += Math.max(0, ms);
      },
      log: (l) => logs.push(l),
    });
    store.ensureRoom(CHAT, { title: "test group", kind: "supergroup" });
    store.setStatus(CHAT, "approved", OWNER);
    store.update(CHAT, (r) => {
      r.helloSaid = true;
    });
  });

  afterEach(async () => {
    groups?.stop();
    await groups?.drain();
    globalThis.fetch = realFetch;
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const msg = (text: string, over: Partial<TgMessage> = {}): TgMessage => {
    const id = nextMsg++;
    return {
      updateId: id,
      chatId: CHAT,
      fromId: OWNER,
      fromFirstName: "Milla",
      fromIsBot: false,
      text,
      messageId: id,
      date: Math.floor(clock / 1000),
      dateSec: Math.floor(clock / 1000),
      chatType: "supergroup",
      chatTitle: "test group",
      ...over,
    };
  };
  const said = async (m: TgMessage): Promise<void> => {
    groups.onMessage(m);
    await groups.drain();
  };
  const replyOf = (b: Record<string, unknown> | undefined): number | undefined => (b?.reply_parameters as { message_id?: number } | undefined)?.message_id;
  const words = (b: Record<string, unknown> | undefined): string => String(b?.text ?? "").replace(/^<a href="tg:\/\/user\?id=\d+">[^<]*<\/a> /, "");

  it("the coin post itself is answered: DexScreener shows the Robinhood coin, and the reply asking about it is answered about THAT coin — never with rules", async () => {
    const post = msg(VRAX);
    await said(post);
    assert.equal(sends.length, 1, "no longer silent");
    assert.equal(replyOf(sends[0]), post.messageId);
    assert.match(String(sends[0]?.text), new RegExp(`^<a href="tg://user\\?id=${OWNER}">Milla</a> `), "thinking out loud, tagging her");
    assert.deepEqual(nominations.map((n) => [n.address, n.messageId]), [[VRAX, post.messageId]], "handed across as the coin it is");
    assert.equal(store.coin(CHAT, VRAX)?.verdict, "candidate");
    assert.equal(store.coin(CHAT, VRAX)?.name, "VRAX");
    assert.ok(logs.includes("[tg-groups] coin post (not to me): answered; look: candidate via dexscreener"), logs.join("\n"));

    const wdyt = msg("wdyt about this shogun", { replyTo: { messageId: post.messageId!, fromId: OWNER, fromIsBot: false } });
    await said(wdyt);
    assert.equal(sends.length, 2);
    assert.equal(replyOf(sends[1]), wdyt.messageId, "the question gets its answer");
    assert.match(words(sends[1]), /VRAX — DexScreener snapshot \d{2}:\d{2} UTC/, "the factual reply names the actual observed coin and source");
    assert.match(words(sends[1]), /liquidity \$190k, 24h volume \$410k, 24h change \+12\.5%/, "the Robinhood pair's observations reach the reply, not the other chain's liquidity");
    assert.match(words(sends[1]), /clears the quick screen; that's not a buy decision/);
    assert.doesNotMatch(words(sends[1]), /bought|vibing|haven't.*chart/, "an acknowledgement is not a fill or a fabricated opinion");
    for (const s of sends) assert.doesNotMatch(words(s), /rules|allowed|advice|should you buy/, words(s));
    assert.ok(prompts >= 1, "the model was asked, and its dodge was refused");
    assert.equal(nominations.length, 1, "one coin, one nomination");
    assert.ok(!logs.join("\n").includes(VRAX.slice(2, 12)), "never the address in a log");
  });

  it("DexScreener down too: the post is silent (not asked, not shown), and the reply asks again — answered once the coin can be seen", async () => {
    dexUp = false;
    const post = msg(VRAX);
    await said(post);
    assert.equal(sends.length, 0);
    assert.ok(logs.includes("[tg-groups] coin post (not to me): nothing (coin-unknown); look: unknown"), logs.join("\n"));

    const still = msg("wdyt about this shogun", { replyTo: { messageId: post.messageId!, fromId: OWNER, fromIsBot: false } });
    await said(still);
    assert.equal(sends.length, 1);
    assert.equal(replyOf(sends[0]), still.messageId);
    assert.match(words(sends[0]), /can't|won't|not loading|blank/, "asked, and the look could not be made: said so");

    clock += 11 * 60_000;
    dexUp = true;
    const again = msg("shogun?? wdyt", { replyTo: { messageId: post.messageId!, fromId: OWNER, fromIsBot: false } });
    await said(again);
    assert.equal(sends.length, 2);
    assert.equal(replyOf(sends[1]), again.messageId);
    assert.deepEqual(nominations.map((n) => [n.address, n.messageId, n.senderId]), [[VRAX, again.messageId, OWNER]]);
    assert.doesNotMatch(words(sends[1]), /rules|allowed|advice/);
  });
});
