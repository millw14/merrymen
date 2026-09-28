import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { botIdOf, ensureLinkCode, loadTelegramState, rotateLinkCode, saveTelegramState, type TelegramState } from "./state";

const base: TelegramState = {
  offset: 0,
  botId: null,
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
});
