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
