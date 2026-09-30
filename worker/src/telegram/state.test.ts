import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  PRIOR_BOTS_KEPT,
  bindToken,
  botIdOf,
  ensureLinkCode,
  loadTelegramState,
  retireLegacyCode,
  POLL_RECORD_EVERY_SEC,
  parsePollHealth,
  recordPoll,
  rotateLinkCode,
  saveTelegramState,
  switchBot,
  tokenTagOf,
  type TelegramState,
} from "./state";

const base: TelegramState = {
  offset: 0,
  botId: null,
  priorBots: [],
  tokenTag: null,
  boundAt: null,
  chatSettings: null,
  linkCode: "",
  linkedChats: [],
  linkedChatAt: {},
  linkRound: 0,
  ownerId: null,
  linkedAt: null,
  messageCount: 0,
  lastNotifiedTradeId: -1,
  lastTradeDigestAt: 0,
  lastRemedyRule: null,
  firedAlerts: {},
  signWatch: null,
  lastDigestDate: "",
  lastJournalDate: "",
  priceAlerts: [],
  reminders: [],
  watchers: [],
  nextId: 1,
  poll: null,
};

/** An rng that hands out `bytes` in order, looping, so a test can say exactly which code comes next. */
function scripted(...bytes: number[]) {
  let i = 0;
  return (n: number): Uint8Array => Uint8Array.from({ length: n }, () => bytes[i++ % bytes.length]!);
}
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

describe("link code — random, rotating, unambiguous", () => {
  it("is six characters from the unambiguous alphabet, taken from the random source", () => {
    const a = ensureLinkCode(base, scripted(0, 1, 2, 3, 4, 30));
    assert.equal(a.linkCode, "ABCDE9");
    assert.match(ensureLinkCode(base).linkCode, CODE);
  });

  it("is not derived from anything: two mints from the real source differ", () => {
    // The old code was a hash of the token and the round, so anyone holding
    // the token could compute every code, and a restore that reset the round
    // re-issued one already used.
    const seen = new Set(Array.from({ length: 50 }, () => ensureLinkCode(base).linkCode));
    assert.ok(seen.size > 45, `${seen.size} distinct codes out of 50`);
  });

  it("drops bytes that would bias the alphabet instead of folding them in", () => {
    // 248..255 would make A–H likelier than the rest if taken mod 31.
    assert.equal(ensureLinkCode(base, scripted(248, 255, 0, 250, 1, 2, 3, 4, 5)).linkCode, "ABCDEF");
  });

  it("does not regenerate when a code already exists", () => {
    const a = ensureLinkCode(base);
    const again = ensureLinkCode(a, scripted(9));
    assert.equal(again.linkCode, a.linkCode);
  });

  it("rotateLinkCode consumes the code — a used code can't link twice", () => {
    const a = ensureLinkCode(base);
    const rotated = rotateLinkCode(a);
    assert.equal(rotated.linkRound, 1);
    assert.notEqual(rotated.linkCode, a.linkCode);
    assert.match(rotated.linkCode, CODE);
  });

  it("a rotation never lands on the code just used, even when the random source repeats it", () => {
    const a = ensureLinkCode(base, scripted(0, 1, 2, 3, 4, 5));
    assert.equal(a.linkCode, "ABCDEF");
    // Each mint draws twelve bytes. The first draw repeats ABCDEF; the
    // rotation must draw again.
    const rotated = rotateLinkCode(a, scripted(0, 1, 2, 3, 4, 5, 0, 0, 0, 0, 0, 0, 6, 7, 8, 9, 10, 11, 0, 0, 0, 0, 0, 0));
    assert.equal(rotated.linkCode, "GHJKMN");
  });

  it("a restored code X, then a link: the new code is not X, and two rotations differ", () => {
    // What a hosted redeploy does: telegram.json comes back with the published
    // code and the round at 0. The old hash minted hash(token:1) next, which
    // could be X itself.
    const restored = { ...base, linkCode: "NTE49D", linkRound: 0 };
    const once = rotateLinkCode(restored);
    const twice = rotateLinkCode(once);
    assert.notEqual(once.linkCode, "NTE49D");
    assert.notEqual(twice.linkCode, once.linkCode);
    assert.notEqual(twice.linkCode, "NTE49D");
  });

  it("an rng that never gives a usable byte throws rather than spinning the poll loop", () => {
    assert.throws(() => ensureLinkCode(base, scripted(255)), /no usable bytes/);
    assert.throws(() => rotateLinkCode({ ...base, linkCode: "ABCDEF" }, scripted(0, 1, 2, 3, 4, 5)), /keeps repeating/);
  });
});

/**
 * The old scheme, as it stood at 350d0882, copied here as an oracle so the
 * test does not trust the copy it is testing.
 */
function oldScheme(token: string, round: number): string {
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let h = 2166136261 >>> 0;
  for (const ch of `${token}:${round}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[h % ALPHABET.length];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return code;
}

describe("retireLegacyCode — a code the old scheme derived from the token does not survive the upgrade", () => {
  it("the oracle is the old scheme: these are the codes 350d0882 minted for these tokens", () => {
    assert.deepEqual([0, 1, 2, 3].map((r) => oldScheme("111:a", r)), ["U8D9W3", "BMXBHV", "TZGDZP", "AD6KGG"]);
    assert.equal(oldScheme("222:secret", 7), "PHW6TW");
  });

  it("a never-linked tenant's code, hash(token:0), restored or kept, is replaced by a random one", () => {
    // Exactly what index.ts printed into the fleet's logs for every tenant that
    // had a token and had not linked.
    const kept = { ...base, linkCode: "U8D9W3" };
    const retired = retireLegacyCode(kept, "111:a", scripted(0, 1, 2, 3, 4, 5));
    assert.equal(retired.linkCode, "ABCDEF");
    assert.equal(retired.linkRound, 1, "a rotation like any other");
  });

  it("a code from any round is found, although a restore put the stored round back to 0", () => {
    for (const round of [1, 3, 17, 64]) {
      const restored = { ...base, linkCode: oldScheme("111:a", round), linkRound: 0 };
      assert.notEqual(retireLegacyCode(restored, "111:a").linkCode, restored.linkCode, `round ${round}`);
    }
    // Past the stored round too, and with a round a corrupt file made nonsense of.
    assert.notEqual(retireLegacyCode({ ...base, linkCode: oldScheme("111:a", 90), linkRound: 40 }, "111:a").linkCode, oldScheme("111:a", 90));
    assert.notEqual(retireLegacyCode({ ...base, linkCode: "U8D9W3", linkRound: Number.NaN }, "111:a").linkCode, "U8D9W3");
    assert.notEqual(retireLegacyCode({ ...base, linkCode: "u8d9w3" }, "111:a").linkCode, "u8d9w3", "the compare ignores case, as /link does");
  });

  it("a random code, no code, and another token's hash are left exactly as they are", () => {
    const random = ensureLinkCode(base);
    assert.equal(retireLegacyCode(random, "111:a"), random, "the same object, so a caller can tell nothing changed");
    const none = { ...base, linkCode: "" };
    assert.equal(retireLegacyCode(none, "111:a"), none);
    // Derived from a token this bot no longer has: the token was never stored,
    // so there is nothing to recognise it by.
    const other = { ...base, linkCode: "PHW6TW", linkRound: 7 };
    assert.equal(retireLegacyCode(other, "111:a"), other);
  });
});

describe("botIdOf — the bot a token belongs to, never the token", () => {
  it("is the numeric id before the ':'", () => {
    assert.equal(botIdOf("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"), "123456789");
    assert.equal(botIdOf("111:x"), "111");
  });

  it("is null for anything that is not <digits>:<secret>, rather than the whole string", () => {
    for (const t of ["", "garbage", "abc:def", ":secret", "111:", "111", " 111:x", "0:x", "000:x"]) {
      assert.equal(botIdOf(t), null, JSON.stringify(t));
    }
  });

  it("IS NULL FOR A TOKEN THAT COULD STEER THE URL IT IS PASTED INTO", () => {
    // `111:x/../../bot<own>/getChat?chat_id=111&z=` read as bot 111, and
    // fetch resolved it into a call on the sender's own bot whose answer
    // carried id 111: a "confirmation" of somebody else's bot.
    for (const t of [
      "111:x/../../bot222:own/getChat?chat_id=111&z=",
      "111:x/../../file/bot222:own/documents/file_0.json#",
      "111:x?y",
      "111:x#y",
      "111:x%2Fy",
      "111:x.y",
      "111:x y",
      "111:x\n",
      "111:x/",
    ]) {
      assert.equal(botIdOf(t), null, JSON.stringify(t));
    }
    assert.equal(botIdOf("111:AAH_dq-Tc"), "111", "base64url is what Telegram issues");
  });

  it("is the number, so a zero typed in front names the same bot getMe does", () => {
    assert.equal(botIdOf("0111:x"), "111");
  });
});

describe("telegram.json carries the bot id", () => {
  /** Run `fn` against a throwaway home, so the real ~/.merrymen is never touched. */
  const inHome = (fn: (file: string) => void) => {
    const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-tg-state-"));
    const prev = process.env.MERRYMEN_HOME;
    process.env.MERRYMEN_HOME = home;
    try {
      fn(path.join(home, "telegram.json"));
    } finally {
      if (prev === undefined) delete process.env.MERRYMEN_HOME;
      else process.env.MERRYMEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  };

  it("round-trips through save and load, next to the offset it qualifies", () => {
    inHome((file) => {
      saveTelegramState({ ...base, offset: 900_000_000, botId: "111", linkCode: "ABCDEF" });
      assert.equal(JSON.parse(readFileSync(file, "utf8")).botId, "111");
      const back = loadTelegramState();
      assert.equal(back.botId, "111");
      assert.equal(back.offset, 900_000_000);
      assert.equal(back.linkCode, "ABCDEF");
    });
  });

  it("a file from before the field existed loads with no bot and keeps its offset and code", () => {
    // What the service then adopts without a reset (service.ts bindBot).
    inHome((file) => {
      writeFileSync(file, JSON.stringify({ offset: 4242, linkCode: "ABCDEF", ownerId: 7 }));
      const st = loadTelegramState();
      assert.equal(st.botId, null);
      assert.equal(st.offset, 4242);
      assert.equal(st.linkCode, "ABCDEF");
    });
  });

  it("anything but a numeric id under that name is dropped, so a token can never come back in through it", () => {
    inHome((file) => {
      for (const botId of ["111:secret", 111, "", "abc"]) {
        writeFileSync(file, JSON.stringify({ offset: 1, botId }));
        assert.equal(loadTelegramState().botId, null, JSON.stringify(botId));
      }
    });
  });

  it("round-trips the other bots' offsets, the token fingerprint and when the bot was bound", () => {
    inHome(() => {
      const tag = tokenTagOf("111:a");
      saveTelegramState({ ...base, botId: "111", priorBots: [{ botId: "222", offset: 77 }], tokenTag: tag, boundAt: 1_790_000_000 });
      const back = loadTelegramState();
      assert.deepEqual(back.priorBots, [{ botId: "222", offset: 77 }]);
      assert.equal(back.tokenTag, tag);
      assert.equal(back.boundAt, 1_790_000_000);
    });
  });

  it("a file from before these fields existed loads with none of them", () => {
    inHome((file) => {
      writeFileSync(file, JSON.stringify({ offset: 4242, botId: "111" }));
      const st = loadTelegramState();
      assert.deepEqual(st.priorBots, []);
      assert.equal(st.tokenTag, null);
      assert.equal(st.boundAt, null);
    });
  });

  it("round-trips when each chat linked; a file from before has none, and a malformed entry is dropped", () => {
    // What the orchestrator promotes by (link.ts linksToPromote): a time
    // lost on load would make a removed chat's old link look new.
    inHome((file) => {
      saveTelegramState({ ...base, linkedChats: [555, -100123], linkedChatAt: { "555": 1_790_000_000, "-100123": 1_790_000_060 } });
      assert.deepEqual(loadTelegramState().linkedChatAt, { "555": 1_790_000_000, "-100123": 1_790_000_060 });
      writeFileSync(file, JSON.stringify({ linkedChats: [555] }));
      assert.deepEqual(loadTelegramState().linkedChatAt, {});
      writeFileSync(file, JSON.stringify({ linkedChatAt: { "555": "soon", abc: 1, "666": -1, "777": 1_790_000_000 } }));
      assert.deepEqual(loadTelegramState().linkedChatAt, { "777": 1_790_000_000 });
    });
  });

  it("a malformed entry is dropped: no token under a bot id, no zero offset, and at most PRIOR_BOTS_KEPT", () => {
    inHome((file) => {
      const many = Array.from({ length: PRIOR_BOTS_KEPT + 3 }, (_, i) => ({ botId: String(300 + i), offset: 10 + i }));
      writeFileSync(
        file,
        JSON.stringify({
          priorBots: [{ botId: "111:secret", offset: 5 }, { botId: "222", offset: 0 }, { botId: "333" }, null, "444", ...many],
          tokenTag: "111:secret",
        }),
      );
      const st = loadTelegramState();
      assert.deepEqual(st.priorBots, many.slice(0, PRIOR_BOTS_KEPT));
      assert.equal(st.tokenTag, null, "only a 16-hex fingerprint is taken");
    });
  });
});

describe("tokenTagOf — tells a new secret apart without keeping the token", () => {
  it("is 16 hex characters, stable for a token, different for a new secret on the same bot", () => {
    const a = tokenTagOf("111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(tokenTagOf("111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), a);
    assert.notEqual(tokenTagOf("111:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"), a);
    assert.ok(!a.includes("AAAA") && !a.includes("111"), "and carries nothing of the token");
  });
});

describe("switchBot — each bot keeps its own place in its own stream", () => {
  const on111: TelegramState = { ...base, botId: "111", offset: 11, linkCode: "ABCDEF", tokenTag: tokenTagOf("111:a") };

  it("a bot never polled starts from its first update; the one left is remembered", () => {
    const st = switchBot(on111, "222", tokenTagOf("222:b"), 1_000);
    assert.equal(st.botId, "222");
    assert.equal(st.offset, 0);
    assert.deepEqual(st.priorBots, [{ botId: "111", offset: 11 }]);
    assert.equal(st.tokenTag, tokenTagOf("222:b"));
    assert.equal(st.boundAt, 1_000);
    assert.equal(st.linkCode, "", "for the caller to re-mint");
  });

  it("A → B → A resumes A where it was left, so Telegram does not hand its last batch over again", () => {
    const onB = { ...switchBot(on111, "222", tokenTagOf("222:b"), 1_000), offset: 40 };
    const backOnA = switchBot(onB, "111", tokenTagOf("111:a"), 2_000);
    assert.equal(backOnA.offset, 11);
    assert.deepEqual(backOnA.priorBots, [{ botId: "222", offset: 40 }], "A is current again, so it is not listed twice");
    assert.equal(backOnA.boundAt, 2_000);
  });

  it("a bot that never got past 0 (a mistyped token) takes no slot, and the list stays bounded", () => {
    let st = switchBot(on111, "900", tokenTagOf("900:x"), 1);
    st = switchBot(st, "901", tokenTagOf("901:x"), 2);
    assert.deepEqual(st.priorBots, [{ botId: "111", offset: 11 }], "900 never polled, so nothing to remember");
    for (let i = 0; i < PRIOR_BOTS_KEPT + 4; i++) st = switchBot({ ...st, offset: 100 + i }, String(500 + i), "0000000000000000", 10 + i);
    assert.equal(st.priorBots.length, PRIOR_BOTS_KEPT);
    assert.equal(st.priorBots[0]!.botId, String(500 + PRIOR_BOTS_KEPT + 2), "newest first");
  });
});

/**
 * bindToken is the state half of service.ts bindBot, and the hold process's
 * too (telegram/hold.ts): whichever of them polls the bot must leave
 * telegram.json as the other expects to find it. Each case once, here; the
 * poll loops' own tests drive them end to end.
 */
describe("bindToken — the state a token's bot binds, shared by the child and the hold process", () => {
  const rng = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 248);
  it("adopts a bot when none is on file, and resets nothing", () => {
    const b = bindToken({ ...base, offset: 90, linkCode: "ABCDEF" }, "111:a", 5);
    assert.equal(b.change, "adopted");
    assert.deepEqual([b.state.botId, b.state.tokenTag, b.state.offset, b.state.linkCode], ["111", tokenTagOf("111:a"), 90, "ABCDEF"]);
  });
  it("a different bot is switched onto, with a fresh code and the boundary at `at`", () => {
    const on111 = { ...base, botId: "111", tokenTag: tokenTagOf("111:a"), offset: 90, linkCode: "ABCDEF" };
    const b = bindToken(on111, "222:b", 5, rng);
    assert.equal(b.change, "switched");
    assert.equal(b.state.botId, "222");
    assert.equal(b.state.offset, 0);
    assert.equal(b.state.boundAt, 5);
    assert.ok(b.state.linkCode && b.state.linkCode !== "ABCDEF");
  });
  it("the same bot with a new secret keeps its offset and rotates the code; a missing fingerprint is not announced", () => {
    const on111 = { ...base, botId: "111", tokenTag: tokenTagOf("111:a"), offset: 90, linkCode: "ABCDEF" };
    const renewed = bindToken(on111, "111:b", 5, rng);
    assert.equal(renewed.change, "renewed");
    assert.ok(renewed.change === "renewed" && renewed.told);
    assert.equal(renewed.state.offset, 90);
    assert.notEqual(renewed.state.linkCode, "ABCDEF");
    const untagged = bindToken({ ...on111, tokenTag: null }, "111:a", 5, rng);
    assert.ok(untagged.change === "renewed" && !untagged.told);
  });
  it("the same token changes nothing, and a malformed one is not bound", () => {
    const on111 = { ...base, botId: "111", tokenTag: tokenTagOf("111:a"), offset: 90, linkCode: "ABCDEF" };
    assert.equal(bindToken(on111, "111:a", 5).state, on111);
    assert.equal(bindToken(on111, "111:a", 5).change, "same");
    assert.equal(bindToken(on111, "not-a-token", 5).change, "invalid");
  });
});

/**
 * WHETHER ANYTHING IS HEARING THE BOT (plan §1.4). The process polling it
 * records each poll here; the orchestrator publishes it and alerts on it.
 * Nothing recorded it before, and the dashboard said "connected" for days in
 * which nothing polled the owner's bot.
 */
describe("the poll record", () => {
  const T = 1_790_000_000;

  it("round-trips through save and load", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-tg-poll-"));
    const prev = process.env.MERRYMEN_HOME;
    process.env.MERRYMEN_HOME = home;
    try {
      const poll = { okAt: T, err: "conflict: another program is reading this bot's updates (409)", errAt: T - 40, botId: "111" };
      saveTelegramState({ ...base, botId: "111", poll });
      assert.deepEqual(loadTelegramState().poll, poll);
      // A file from before it existed, and one whose record is not an object.
      writeFileSync(path.join(home, "telegram.json"), JSON.stringify({ offset: 1 }));
      assert.equal(loadTelegramState().poll, null);
      writeFileSync(path.join(home, "telegram.json"), JSON.stringify({ poll: "live" }));
      assert.equal(loadTelegramState().poll, null);
      // It is published: no token may ride in under the bot's name.
      writeFileSync(path.join(home, "telegram.json"), JSON.stringify({ poll: { okAt: T, botId: "111:secret" } }));
      assert.deepEqual(loadTelegramState().poll, { okAt: T, err: null, errAt: null, botId: null });
    } finally {
      if (prev === undefined) delete process.env.MERRYMEN_HOME;
      else process.env.MERRYMEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("IS READ AS UNTRUSTED: the orchestrator logs and publishes what it says", () => {
    // The home is writable by an agent's tools, and by builds that wrote it
    // under other rules. A line break in `err` would forge a line in the
    // fleet's log; a fraction would fail the database's integer column on
    // every pass; a far-future time would read as "heard" until it came.
    const read = (poll: Record<string, unknown>) => parsePollHealth(poll, T);
    const forged = read({ okAt: T, err: "failed: x\n[orchestrator] [alert] telegram not polling: 0xdead", errAt: T, botId: "111" })!;
    assert.ok(!/[\n\r]/.test(forged.err!), forged.err!);
    assert.equal(read({ err: "failed: bot8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getUpdates" })!.err, "failed: bot<token>/getUpdates");
    assert.equal(read({ err: "\n\t" })!.err, null);
    assert.ok(read({ err: "x".repeat(5_000) })!.err!.length <= 160);
    for (const bad of [T + 0.5, T + 3_600, Number.MAX_SAFE_INTEGER + 2, -5, 0, Number.NaN, "1790000000"]) {
      assert.equal(read({ okAt: bad, errAt: bad })!.okAt, null, String(bad));
      assert.equal(read({ okAt: bad, errAt: bad })!.errAt, null, String(bad));
    }
    // A second or two ahead is recordPoll's own doing, and is kept.
    assert.equal(read({ okAt: T + 2 })!.okAt, T + 2);
  });

  it("a good poll records when, for which bot", () => {
    assert.deepEqual(recordPoll(base, "111", T, null).poll, { okAt: T, err: null, errAt: null, botId: "111" });
  });

  it("A FAILURE IS KEPT AFTER A SUCCESS, so the latest outcome is whichever is later", () => {
    // Two programs on one bot take turns failing with 409. A record that
    // cleared the failure on every success would look healthy half the time.
    const conflict = "conflict: another program is reading this bot's updates (409)";
    let st = recordPoll(base, "111", T, null);
    st = recordPoll(st, "111", T + 10, conflict);
    assert.deepEqual(st.poll, { okAt: T, err: conflict, errAt: T + 10, botId: "111" });
    st = recordPoll(st, "111", T + 20, null);
    assert.deepEqual(st.poll, { okAt: T + 20, err: conflict, errAt: T + 10, botId: "111" });
  });

  it("WRITES AT ONCE WHEN THE ANSWER CHANGES, and otherwise at most every 30s", () => {
    let st = recordPoll(base, "111", T, null);
    // The same outcome inside the window: the same object, so nothing is saved.
    assert.equal(recordPoll(st, "111", T + POLL_RECORD_EVERY_SEC - 1, null), st);
    const later = recordPoll(st, "111", T + POLL_RECORD_EVERY_SEC, null);
    assert.notEqual(later, st);
    assert.equal(later.poll!.okAt, T + POLL_RECORD_EVERY_SEC);
    // A failure right after a success is news, and so is a different failure.
    st = recordPoll(st, "111", T + 1, "failed: request failed: timed out");
    assert.equal(st.poll!.errAt, T + 1);
    const same = recordPoll(st, "111", T + 2, "failed: request failed: timed out");
    assert.equal(same, st, "the same failure again inside the window is not");
    assert.equal(recordPoll(st, "111", T + 2, "refused: 401 Unauthorized").poll!.err, "refused: 401 Unauthorized");
    // And a success after a failure, at once.
    assert.equal(recordPoll(st, "111", T + 2, null).poll!.okAt, T + 2);
  });

  it("a failure and a success in the same second still say which came last", () => {
    let st = recordPoll(base, "111", T, null);
    st = recordPoll(st, "111", T, "conflict: another program is reading this bot's updates (409)");
    assert.equal(st.poll!.errAt, T + 1, "the failure, after the success it followed");
    st = recordPoll(st, "111", T + 1, null);
    assert.equal(st.poll!.okAt, T + 2, "and the success after it, written at once");
  });

  it("a record about another bot is dropped, not carried: its successes were not this bot's", () => {
    const on111 = recordPoll(base, "111", T, null);
    const on222 = recordPoll(on111, "222", T + 5, "failed: HTTP 502");
    assert.deepEqual(on222.poll, { okAt: null, err: "failed: HTTP 502", errAt: T + 5, botId: "222" });
  });
});
