/**
 * decideBotClaim — what a save carrying a Telegram token does to the bot's
 * claim, decided before anything is written. Run on node:sqlite through the
 * same Db seam the shared Postgres is reached by. The route that asks it is
 * driven end to end in app/api/settings/bot-claim.test.ts.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { botIdOf, claimBot, ensureBotClaims, readBotClaims } from "../../../worker/src/telegram-claims";
import { BOT_CLAIMED_TEXT, BOT_UNCONFIRMED_TEXT, decideBotClaim } from "./telegram-claims";

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
const save = (d: Db, tenant: `0x${string}`, token: string | undefined, over: Partial<Parameters<typeof decideBotClaim>[0]> = {}) =>
  decideBotClaim({ db: d, tenant, token, moveBot: false, confirmBot: live, now: 1, ...over });

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
    await save(d, B, "333:BBB-secret");
    const change = await save(d, A, "222:AAA-new-bot", { now: 2 });
    assert.ok(change.ok);
    await change.settle();
    assert.deepEqual(await claims(d), [["222", A], ["333", B]]);
    const clear = await save(d, A, undefined, { confirmBot: async () => assert.fail("nothing to confirm"), now: 3 });
    assert.ok(clear.ok);
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
