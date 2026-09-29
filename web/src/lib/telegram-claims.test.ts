/**
 * decideBotClaim — what a save carrying a Telegram token does to the bot's
 * claim, decided before anything is written. Run on node:sqlite through the
 * same Db seam the shared Postgres is reached by. The route that asks it is
 * driven end to end in app/api/settings/bot-claim.test.ts.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MerrymenSettings } from "@merrymen/core";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { botIdOf, claimBot, ensureBotClaims, readBotClaims, settleBotClaims } from "../../../worker/src/telegram-claims";
import {
  BOT_CLAIMED_TEXT,
  BOT_UNCONFIRMED_TEXT,
  decideBotClaim,
  isBotToken,
  SAVE_BUSY,
  settleWithoutToken,
  telegramBotIdOf,
  useBotClaimsDbForTest,
  withSettingsSaveLock,
} from "./telegram-claims";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const db = async (): Promise<Db> => {
  const d = wrapSqlite(new DatabaseSync(":memory:"));
  await ensureBotClaims(d);
  return d;
};
/** getMe for a live token: it answers for the bot its prefix names. */
const live = async (token: string) => botIdOf(token);
/** getMe for a token Telegram refuses (mistyped, revoked, or never a token). */
const refused = async () => null;
const claims = async (d: Db) => [...(await readBotClaims(d))].sort();
/** The settings store, per tenant: what settle and undo read back after a write. */
let stored = new Map<string, MerrymenSettings>();
beforeEach(() => {
  stored = new Map();
});
/** A save's write landing: the token it carries is what the store now holds. */
const write = (tenant: `0x${string}`, token: string | undefined) => void stored.set(tenant, token === undefined ? {} : { telegramBotToken: token });
const settingsOf = (tenant: `0x${string}`) => ({ before: stored.get(tenant) ?? null, read: async (t: `0x${string}`) => stored.get(t) ?? null });
const save = (d: Db, tenant: `0x${string}`, token: string | undefined, over: Partial<Parameters<typeof decideBotClaim>[0]> = {}) =>
  decideBotClaim({ db: d, tenant, token, moveBot: false, confirmBot: live, settings: settingsOf(tenant), now: 1, ...over });

describe("decideBotClaim", () => {
  it("A FREE BOT IS CLAIMED, and the claim is taken back if the save fails", async () => {
    const d = await db();
    const got = await save(d, A, "111:AAA-secret");
    assert.ok(got.ok && !got.moved);
    assert.deepEqual(await claims(d), [["111", A]]);
    await got.undo();
    assert.deepEqual(await claims(d), [], "no claim outlives a token that was not stored");
  });

  it("A BOT ANOTHER ACCOUNT HOLDS IS REFUSED WITH 409 bot_claimed, and the refusal names nobody", async () => {
    const d = await db();
    await claimBot(d, "111", A, "111", 1);
    const got = await save(d, B, "111:BBB-secret", { now: 2 });
    assert.ok(!got.ok);
    assert.equal(got.status, 409);
    assert.equal(got.body.error, "bot_claimed");
    assert.deepEqual(got.body.errors, [BOT_CLAIMED_TEXT]);
    assert.ok(!JSON.stringify(got.body).toLowerCase().includes(A.slice(2)), "not the other account");
    assert.doesNotMatch(BOT_CLAIMED_TEXT, /login|account|0x/i, "not even 'your other login'");
    assert.deepEqual(await claims(d), [["111", A]]);
  });

  it("A TOKEN TELEGRAM REFUSES CLAIMS NOTHING, AND IS ANSWERED THE SAME WHETHER OR NOT THE BOT IS HELD", async () => {
    // A bot id is public. `<id>:anything` must neither take the bot from its
    // owner nor tell a stranger that the bot belongs to a Merrymen agent.
    const free = await db();
    const held = await db();
    await claimBot(held, "111", A, "111", 1);
    const a = await save(free, B, "111:guessed-secret", { confirmBot: refused });
    const b = await save(held, B, "111:guessed-secret", { confirmBot: refused });
    assert.ok(a.ok && b.ok && !a.moved && !b.moved, "saved as typed, both times, as it always was");
    assert.deepEqual(await claims(free), [], "no claim for it");
    assert.deepEqual(await claims(held), [["111", A]], "and the owner's stands");
    for (const d of [free, held]) {
      const move = await save(d, B, "111:guessed-secret", { confirmBot: refused, moveBot: true });
      assert.ok(!move.ok);
      assert.deepEqual(move.body, { error: "bot_unconfirmed", errors: [BOT_UNCONFIRMED_TEXT] }, "a move it cannot vouch for: the same answer either way");
    }
    assert.deepEqual(await claims(held), [["111", A]]);
  });

  it("MOVE IT HERE MOVES THE CLAIM ONLY WHEN getMe CONFIRMS THE BOT, and puts it back if the save fails", async () => {
    const d = await db();
    await save(d, A, "111:AAA-secret");
    for (const answer of [null, "222"]) {
      const got = await save(d, B, "111:BBB-secret", { moveBot: true, confirmBot: async () => answer, now: 2 });
      assert.ok(!got.ok);
      assert.equal(got.body.error, "bot_unconfirmed");
      assert.deepEqual(await claims(d), [["111", A]], `nothing moved on getMe=${answer}`);
    }
    const asked: string[] = [];
    const got = await save(d, B, "111:BBB-secret", { moveBot: true, now: 3, confirmBot: async (t) => (asked.push(t), "111") });
    assert.ok(got.ok && got.moved);
    assert.deepEqual(asked, ["111:BBB-secret"], "getMe is asked about the token being saved");
    assert.deepEqual(await claims(d), [["111", B]]);
    await got.undo();
    assert.deepEqual(await claims(d), [["111", A]], "a failed save puts the bot back where it was");
  });

  it("A SAVE THAT LANDS LETS GO OF THE BOT THIS ACCOUNT LEFT, and clearing the token lets go of all of them", async () => {
    const d = await db();
    await save(d, A, "111:AAA-secret");
    write(A, "111:AAA-secret");
    await save(d, B, "333:BBB-secret");
    write(B, "333:BBB-secret");
    const change = await save(d, A, "222:AAA-new-bot", { now: 2 });
    assert.ok(change.ok);
    write(A, "222:AAA-new-bot");
    await change.settle();
    assert.deepEqual(await claims(d), [["222", A], ["333", B]]);
    const clear = await save(d, A, undefined, { confirmBot: async () => assert.fail("nothing to confirm"), now: 3 });
    assert.ok(clear.ok);
    write(A, undefined);
    await clear.settle();
    assert.deepEqual(await claims(d), [["333", B]], "only this account's claims go");
  });

  it("re-entering a token for a bot this account already holds changes nothing, and undoes nothing", async () => {
    const d = await db();
    await save(d, A, "111:AAA-secret");
    const again = await save(d, A, "111:AAA-renewed", { moveBot: true, now: 2 });
    assert.ok(again.ok && !again.moved);
    await again.undo();
    assert.deepEqual(await claims(d), [["111", A]]);
  });
});

/**
 * TWO SAVES FOR ONE ACCOUNT AT ONCE, WITHOUT THE SAVE LOCK. The settings PUT
 * takes turns (withSettingsSaveLock, driven through the route in
 * app/api/settings/bot-claim.test.ts); these are the claim functions on their
 * own, as a caller that could not take the lock runs them. Both decide (and
 * claim) before either writes; then the writes, the settles after them, and
 * the undo of a write that failed, land in every order. Whatever the order,
 * the account's claims end on the bot of the token stored last, and a failed
 * save takes back only what no landed save stands on.
 */
describe("two saves at once for one account", () => {
  const TO_222 = "222:AAA-bee";
  const TO_333 = "333:AAA-sea";
  /** Account A holds bot 111, and stores its token. */
  const start = async () => {
    const d = await db();
    await claimBot(d, "111", A, "111", 0);
    write(A, "111:AAA-prior");
    return d;
  };
  const stamp = async (d: Db, bot: string) =>
    Number(((await d.prepare("SELECT claimed_at FROM telegram_bot_claims WHERE bot_id = ?").get(bot)) as { claimed_at: number }).claimed_at);
  /** A read of the store that, once armed, returns what it read only after `meanwhile` has run: a settle or undo overtaken mid-flight. */
  const overtaken = () => {
    let meanwhile: (() => Promise<void>) | null = null;
    return {
      arm: (fn: () => Promise<void>) => void (meanwhile = fn),
      read: async (t: `0x${string}`) => {
        const got = stored.get(t) ?? null;
        const fn = meanwhile;
        meanwhile = null;
        if (fn) await fn();
        return got;
      },
    };
  };

  // Every order of the two writes and two settles in which each settle
  // follows its own write: w1 w2 s1 s2, w1 s1 w2 s2, w2 w1 s2 s1, …
  const orders: string[][] = [];
  const steps = ["w1", "w2", "s1", "s2"];
  const permute = (done: string[]) => {
    if (done.length === steps.length) return void orders.push(done);
    for (const e of steps) {
      if (done.includes(e)) continue;
      if (e[0] === "s" && !done.includes(`w${e[1]}`)) continue;
      permute([...done, e]);
    }
  };
  permute([]);
  assert.equal(orders.length, 6);
  for (const order of orders) {
    it(`${order.join(" ")}: the claims end on the bot stored last, and only on it`, async () => {
      const d = await start();
      const one = await save(d, A, TO_222, { now: 10 });
      const two = await save(d, A, TO_333, { now: 20 });
      assert.ok(one.ok && two.ok);
      assert.deepEqual(await claims(d), [["111", A], ["222", A], ["333", A]], "both claimed before either wrote");
      for (const e of order) {
        if (e === "w1") write(A, TO_222);
        if (e === "w2") write(A, TO_333);
        if (e === "s1") await one.settle();
        if (e === "s2") await two.settle();
      }
      const last = order.indexOf("w1") > order.indexOf("w2") ? "222" : "333";
      assert.deepEqual(await claims(d), [[last, A]]);
    });
  }

  it("A SETTLE THAT READ THE STORE BEFORE THE LAST WRITE, AND LETS GO AFTER IT, PUTS THE STORED BOT'S CLAIM BACK", async () => {
    // The settle of the save for 222 reads "222", and before it lets go of
    // anything, 333 is written and its own settle runs to the end (and finds
    // its claim in place). Then the stale settle lets go of every bot but 222:
    // 333's claim with them. Its next read says 333, so it puts that claim
    // back, stamp and all, and settles on it.
    const d = await start();
    const store = overtaken();
    const one = await save(d, A, TO_222, { now: 10, settings: { before: stored.get(A)!, read: store.read } });
    const two = await save(d, A, TO_333, { now: 20 });
    assert.ok(one.ok && two.ok);
    write(A, TO_222);
    store.arm(async () => {
      write(A, TO_333);
      await two.settle();
      assert.deepEqual(await claims(d), [["333", A]], "the last save settled on its own bot");
    });
    await one.settle();
    assert.deepEqual(await claims(d), [["333", A]], "and the stale settle left it standing");
    assert.equal(await stamp(d, "333"), 20, "the claim put back is the one the save for 333 made");
  });

  it("THE LAST SETTLE CLAIMS ONLY A BOT ITS OWN SAVE CONFIRMED: a stored token Telegram refused is never claimed for it", async () => {
    const d = await start();
    const one = await save(d, A, TO_222, { now: 10 });
    const guessed = await save(d, A, "444:guessed-secret", { now: 20, confirmBot: refused });
    assert.ok(one.ok && guessed.ok);
    write(A, TO_222);
    write(A, "444:guessed-secret");
    await guessed.settle();
    // The save for 222 settles last, reading 444: it lets go of 222 (and 111),
    // and does not claim 444 on the strength of a token nobody confirmed.
    await one.settle();
    assert.deepEqual(await claims(d), []);
    const other = await save(d, B, "444:BBB-real", { now: 30 });
    assert.ok(other.ok && !other.moved, "444 is free for whoever proves they hold it");
  });

  describe("and one of them fails to write", () => {
    it("THE FAILED SAVE KEEPS THE CLAIM A LANDED SAVE FOR THE SAME BOT STANDS ON", async () => {
      // The second save decided while the first save's claim stood, so it
      // made none of its own (holder A, not fresh). Taken back, the account
      // would be left storing 222 with no claim on it.
      const d = await start();
      const failed = await save(d, A, TO_222, { now: 10 });
      const landed = await save(d, A, "222:AAA-bee-reissued", { now: 20 });
      assert.ok(failed.ok && landed.ok);
      write(A, "222:AAA-bee-reissued");
      await landed.settle();
      await failed.undo();
      assert.deepEqual(await claims(d), [["222", A]]);
    });

    it("…AND PUTS IT BACK WHEN THAT SAVE LANDS AND SETTLES WHILE THE UNDO IS TAKING IT", async () => {
      const d = await start();
      const store = overtaken();
      const failed = await save(d, A, TO_222, { now: 10, settings: { before: stored.get(A)!, read: store.read } });
      const landed = await save(d, A, "222:AAA-bee-reissued", { now: 20 });
      assert.ok(failed.ok && landed.ok);
      // The undo reads "111" (nothing for 222 has landed), and before it
      // deletes, the other save writes and settles, finding the claim there.
      store.arm(async () => {
        write(A, "222:AAA-bee-reissued");
        await landed.settle();
      });
      await failed.undo();
      assert.deepEqual(await claims(d), [["222", A]]);
      assert.equal(await stamp(d, "222"), 10, "put back as the failed save left it");
    });

    it("A DOUBLE-CLICKED MOVE WHOSE FIRST SAVE FAILS LEAVES THE BOT WITH THE SAVE THAT LANDED", async () => {
      // The second click's save finds the bot already this account's (the
      // first one's move) and so moves nothing itself: it stands on the first
      // one's move. Put back to B, A would be left storing a bot B holds.
      const d = await db();
      await claimBot(d, "111", B, "111", 0);
      const failed = await save(d, A, "111:AAA-first", { moveBot: true, now: 10 });
      const landed = await save(d, A, "111:AAA-second", { moveBot: true, now: 20 });
      assert.ok(failed.ok && failed.moved && landed.ok && !landed.moved);
      write(A, "111:AAA-second");
      await landed.settle();
      await failed.undo();
      assert.deepEqual(await claims(d), [["111", A]]);
    });

    it("A FAILED MOVE GOES BACK EVEN WHEN THE ACCOUNT ALREADY STORED A TOKEN FOR THAT BOT: nothing has landed since", async () => {
      // A was refused bot 111 before (its child stripped of it), asked to move
      // it here, and the save failed. The token stored from before is no
      // reason to keep the move: the other account keeps its bot.
      const d = await db();
      await claimBot(d, "111", B, "111", 0);
      write(A, "111:AAA-from-before");
      const failed = await save(d, A, "111:AAA-new", { moveBot: true, now: 10 });
      assert.ok(failed.ok && failed.moved);
      assert.deepEqual(await claims(d), [["111", A]]);
      await failed.undo();
      assert.deepEqual(await claims(d), [["111", B]]);
      assert.equal(await stamp(d, "111"), 0, "stamp and all");
    });

    it("A FAILED SAVE WHOSE STORE CANNOT BE READ TAKES ITS CLAIM BACK, as before", async () => {
      const d = await start();
      const failed = await save(d, A, TO_222, {
        now: 10,
        settings: { before: stored.get(A)!, read: async () => { throw new Error("store down"); } },
      });
      assert.ok(failed.ok);
      await failed.undo();
      assert.deepEqual(await claims(d), [["111", A]]);
    });
  });
});

/**
 * A WRITE THAT WENT THROUGH AND THEN FAILED TO SAY SO (the store committed,
 * the connection dropped before it answered). The route runs the undo; the
 * undo finds the token stored, keeps the claim, and settles as the write's
 * own settle would have, so the bot the account left is let go.
 */
describe("a write that landed and then failed", () => {
  const start = async () => {
    const d = await db();
    await claimBot(d, "111", A, "111", 0);
    write(A, "111:AAA-prior");
    return d;
  };

  it("A FRESH CLAIM: kept, and the bot left behind is let go", async () => {
    const d = await start();
    const x = await save(d, A, "222:AAA-new", { now: 10 });
    assert.ok(x.ok);
    write(A, "222:AAA-new");
    await x.undo();
    assert.deepEqual(await claims(d), [["222", A]]);
  });

  it("A MOVE: kept, and the bot left behind is let go", async () => {
    const d = await start();
    await claimBot(d, "222", B, "222", 0);
    const x = await save(d, A, "222:AAA-new", { moveBot: true, now: 10 });
    assert.ok(x.ok && x.moved);
    write(A, "222:AAA-new");
    await x.undo();
    assert.deepEqual(await claims(d), [["222", A]]);
  });

  it("A CLAIM THE ACCOUNT ALREADY HELD, AND A CLEARED TOKEN: nothing of their own to undo, and they settle all the same", async () => {
    const d = await start();
    await claimBot(d, "222", A, "222", 0);
    const x = await save(d, A, "222:AAA-renewed", { now: 10 });
    assert.ok(x.ok && !x.moved);
    write(A, "222:AAA-renewed");
    await x.undo();
    assert.deepEqual(await claims(d), [["222", A]], "111 let go");
    const clear = await save(d, A, undefined, { now: 20 });
    assert.ok(clear.ok);
    write(A, undefined);
    await clear.undo();
    assert.deepEqual(await claims(d), []);
  });

  it("A WRITE THAT DID NOT LAND STILL SETTLES NOTHING: the claims stay as they were before the save", async () => {
    const d = await start();
    await claimBot(d, "222", A, "222", 0);
    const x = await save(d, A, "222:AAA-renewed", { now: 10 });
    assert.ok(x.ok);
    await x.undo();
    assert.deepEqual(await claims(d), [["111", A], ["222", A]]);
  });
});

describe("settleBotClaims, at its edges", () => {
  it("SETTINGS THAT CANNOT BE READ BACK: every bot but the one this save wrote is let go, and it says so", async () => {
    const d = await db();
    await claimBot(d, "111", A, "111", 0);
    write(A, "111:AAA-prior");
    const x = await save(d, A, "222:AAA-new", {
      now: 10,
      settings: { before: stored.get(A)!, read: async () => { throw new Error("store down"); } },
    });
    assert.ok(x.ok);
    await assert.rejects(x.settle(), /store down.*settled on the token this save wrote/);
    assert.deepEqual(await claims(d), [["222", A]], "not 111 as well");
  });

  it("SETTINGS STILL CHANGING AFTER FOUR ROUNDS: a last release leaves at most the bot read last", async () => {
    const d = await db();
    for (const b of ["201", "202", "203", "204", "205"]) await claimBot(d, b, A, b, 0);
    const reads = ["201", "202", "203", "204", "205"];
    let n = 0;
    await settleBotClaims(d, A, async () => reads[Math.min(n++, reads.length - 1)]!, null, 5);
    assert.equal(n, 5, "four rounds, each read again");
    assert.deepEqual(await claims(d), [["205", A]]);
  });
});

describe("settleWithoutToken — a save that does not carry the token", () => {
  it("LETS GO OF A CLAIM ON A BOT THE ACCOUNT NO LONGER STORES, CLAIMS NOTHING, AND TOUCHES NO OTHER ACCOUNT'S", async () => {
    // A token save stored 222 and settled; then a writer that does not settle
    // put the old token (111) back. The claim on 222 is for a bot A no longer
    // stores; 111 is free, and only a token Telegram confirms may claim it.
    const d = await db();
    await claimBot(d, "222", A, "222", 0);
    await claimBot(d, "333", B, "333", 0);
    write(A, "111:AAA-prior");
    const s = await settleWithoutToken({ db: d, tenant: A, next: stored.get(A)!, settings: settingsOf(A), now: 5 });
    assert.ok(!s.moved);
    await s.undo();
    assert.deepEqual(await claims(d), [["222", A], ["333", B]], "a write that did not land changes nothing");
    await s.settle();
    assert.deepEqual(await claims(d), [["333", B]]);
  });

  it("KEEPS THE BOT IT STORES", async () => {
    const d = await db();
    await claimBot(d, "111", A, "111", 0);
    await claimBot(d, "222", A, "222", 0);
    write(A, "111:AAA-prior");
    const s = await settleWithoutToken({ db: d, tenant: A, next: stored.get(A)!, settings: settingsOf(A), now: 5 });
    await s.settle();
    assert.deepEqual(await claims(d), [["111", A]]);
  });

  it("THE STORE UNREADABLE: keeps the bot it wrote back, and says so", async () => {
    const d = await db();
    await claimBot(d, "111", A, "111", 0);
    await claimBot(d, "222", A, "222", 0);
    write(A, "111:AAA-prior");
    const blind = await settleWithoutToken({ db: d, tenant: A, next: stored.get(A)!, settings: { read: async () => { throw new Error("store down"); } }, now: 6 });
    await assert.rejects(blind.settle(), /store down/);
    assert.deepEqual(await claims(d), [["111", A]]);
  });
});

describe("withSettingsSaveLock", () => {
  afterEach(() => useBotClaimsDbForTest(null));

  it("A SAVE THAT CANNOT GET ITS TURN IN TIME IS TOLD SO, AND RUNS NOTHING", async () => {
    const d = await db();
    useBotClaimsDbForTest(d);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const holder = withSettingsSaveLock(A, async (c) => {
      assert.equal(c.db, d, "handed the claims database it holds the lock on");
      entered();
      await released;
      return "saved";
    });
    await inside;
    assert.equal(await withSettingsSaveLock(A, async () => assert.fail("runs nothing"), 20), SAVE_BUSY);
    assert.equal(await withSettingsSaveLock(B, async () => "another account's"), "another account's", "and no other account waits");
    release();
    assert.equal(await holder, "saved");
    assert.equal(await withSettingsSaveLock(A, async () => "next"), "next");
  });

  it("NO SHARED DATABASE: no lock, and no claims database to hand over", async () => {
    const url = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.deepEqual(await withSettingsSaveLock(A, async (c) => c), { db: null });
    } finally {
      if (url !== undefined) process.env.DATABASE_URL = url;
    }
  });
});

/**
 * Tokens that read as bot 111 before botIdOf knew Telegram's alphabet, and
 * that fetch resolves into a request on the sender's own bot: a getChat that
 * answers with id 111, or a file they uploaded to it that says anything.
 */
const CRAFTED = [
  "111:x/../../bot999:own-secret/getChat?chat_id=111&z=",
  "111:x/../../file/bot999:own-secret/documents/file_0.json#",
  "111:x?chat_id=111",
  "111:x%2F..%2Fbot999",
];

describe("telegramBotIdOf — getMe, as a claim may trust it", () => {
  const realFetch = globalThis.fetch;
  let sent: string[] = [];
  /** Telegram answering every request with `result`: what the sender's own bot, or a file on it, would say. */
  const answerAll = (result: Record<string, unknown>) => {
    sent = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      sent.push(String(input instanceof Request ? input.url : input));
      return Response.json({ ok: true, result });
    }) as typeof fetch;
  };
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("NEVER SENDS A TOKEN THAT COULD STEER THE URL, whatever the far end would answer", async () => {
    answerAll({ id: 111, is_bot: true, username: "victimbot" });
    for (const token of CRAFTED) {
      assert.equal(isBotToken(token), false, token);
      assert.equal(await telegramBotIdOf(token), null, token);
    }
    assert.deepEqual(sent, [], "nothing was sent");
  });

  it("counts only an answer that says it is a bot: a chat's or a user's carries an id too", async () => {
    answerAll({ id: 111, username: "victimbot", type: "private" });
    assert.equal(await telegramBotIdOf("111:AAA-secret"), null);
    answerAll({ id: 111, is_bot: true, username: "bot111" });
    assert.equal(await telegramBotIdOf("111:AAA-secret"), "111");
    assert.deepEqual(sent, ["https://api.telegram.org/bot111:AAA-secret/getMe"]);
  });

  it("A CRAFTED TOKEN FOR A HELD BOT GETS NO 409 THAT SAYS SO, AND MOVES NOTHING", async () => {
    answerAll({ id: 111, is_bot: true, username: "victimbot" });
    const d = await db();
    await claimBot(d, "111", A, "111", 1);
    for (const token of CRAFTED) {
      const plain = await decideBotClaim({ db: d, tenant: B, token, moveBot: false, confirmBot: telegramBotIdOf, settings: settingsOf(B), now: 2 });
      assert.ok(plain.ok && !plain.moved, `${token}: the answer a free bot's would get`);
      const move = await decideBotClaim({ db: d, tenant: B, token, moveBot: true, confirmBot: telegramBotIdOf, settings: settingsOf(B), now: 3 });
      assert.ok(!move.ok);
      assert.equal(move.body.error, "bot_unconfirmed");
    }
    assert.deepEqual(await claims(d), [["111", A]], "the owner keeps the bot");
    assert.deepEqual(sent, [], "and Telegram was never asked");
  });
});
