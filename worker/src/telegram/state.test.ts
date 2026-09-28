import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  PRIOR_BOTS_KEPT,
  botIdOf,
  ensureLinkCode,
  loadTelegramState,
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
};

describe("link code — deterministic, rotating, unambiguous", () => {
  it("is deterministic for a given seed + round", () => {
    const a = ensureLinkCode(base, "123:token");
    const b = ensureLinkCode(base, "123:token");
    assert.equal(a.linkCode, b.linkCode);
    assert.match(a.linkCode, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it("does not regenerate when a code already exists", () => {
    const a = ensureLinkCode(base, "123:token");
    const again = ensureLinkCode(a, "different-seed");
    assert.equal(again.linkCode, a.linkCode);
  });

  it("rotateLinkCode consumes the code — a used code can't link twice", () => {
    const a = ensureLinkCode(base, "123:token");
    const rotated = rotateLinkCode(a, "123:token");
    assert.equal(rotated.linkRound, 1);
    assert.notEqual(rotated.linkCode, a.linkCode); // fresh code, new round
    assert.match(rotated.linkCode, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it("each rotation yields a different code", () => {
    let st = ensureLinkCode(base, "seed");
    const seen = new Set<string>([st.linkCode]);
    for (let i = 0; i < 5; i++) {
      st = rotateLinkCode(st, "seed");
      assert.ok(!seen.has(st.linkCode), `round ${st.linkRound} repeated a code`);
      seen.add(st.linkCode);
    }
  });
});

describe("botIdOf — the bot a token belongs to, never the token", () => {
  it("is the numeric id before the ':'", () => {
    assert.equal(botIdOf("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"), "123456789");
    assert.equal(botIdOf("111:x"), "111");
  });

  it("is null for anything that is not <digits>:<secret>, rather than the whole string", () => {
    for (const t of ["", "garbage", "abc:def", ":secret", "111:", "111", " 111:x"]) {
      assert.equal(botIdOf(t), null, JSON.stringify(t));
    }
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
