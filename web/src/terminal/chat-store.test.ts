/**
 * ONE OWNER'S CONVERSATION MUST NOT BE READABLE BY THE NEXT.
 *
 * The chat tab kept nothing at all, so persisting it is a new surface, and the
 * new surface is a shared browser. Everything here is about the two properties
 * that make that safe — the key, and the delete — plus the three ways
 * `localStorage` fails that would otherwise crash a working screen.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { chatKeyFor, clearTurns, loadTurns, MAX_TURNS, saveTurns } from "./chat-store";

/** A Storage that behaves, and one that throws the way a private window does. */
function memStore() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}
const hostile = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("quota");
  },
  removeItem() {
    throw new Error("blocked");
  },
};

const turn = (n: number) => ({ question: `q${n}`, answer: `a${n}` });

describe("whose conversation this is", () => {
  it("A HOSTED READER IS KEYED ON THEIR OWN ADDRESS", () => {
    const a = chatKeyFor({ hosted: true, address: "0xAAAA000000000000000000000000000000000001" });
    const b = chatKeyFor({ hosted: true, address: "0xbbbb000000000000000000000000000000000002" });
    assert.ok(a && b && a !== b, "two owners must not share a key");
    // Lowercased: the same wallet arriving with different casing is one owner,
    // not two, and a second bucket would look to them like a lost history.
    assert.equal(a, chatKeyFor({ hosted: true, address: "0xaaaa000000000000000000000000000000000001" }));
  });

  it("a hosted visitor who is signed out gets NO key", () => {
    // Not an anonymous bucket. A shared anonymous key is exactly the leak that
    // keying exists to prevent, and a visitor with no wallet has no agent to
    // have talked to.
    assert.equal(chatKeyFor({ hosted: true, address: null }), null);
    assert.equal(chatKeyFor(null), null);
  });

  it("self-hosted gets one, because there is one operator and no second owner", () => {
    assert.equal(chatKeyFor({ hosted: false, address: null }), "merrymen.chat.self");
  });

  it("and nothing is written when there is no key", () => {
    const s = memStore();
    saveTurns(null, [turn(1)], s);
    assert.equal(s.map.size, 0, "a null key must not fall back to a default one");
    assert.deepEqual(loadTurns(null, s), []);
  });
});

describe("round trip", () => {
  it("keeps what was said, under the right key", () => {
    const s = memStore();
    const key = chatKeyFor({ hosted: true, address: "0xaaaa000000000000000000000000000000000001" });
    saveTurns(key, [turn(1), turn(2)], s);
    assert.deepEqual(loadTurns(key, s), [turn(1), turn(2)]);
    // And the other owner's read is empty, not the first owner's history.
    assert.deepEqual(loadTurns(chatKeyFor({ hosted: true, address: "0xbbbb000000000000000000000000000000000002" }), s), []);
  });

  it("SIGN-OUT DELETES, it does not merely stop showing", () => {
    const s = memStore();
    const key = chatKeyFor({ hosted: true, address: "0xaaaa000000000000000000000000000000000001" })!;
    saveTurns(key, [turn(1)], s);
    clearTurns(key, s);
    assert.equal(s.map.has(key), false, "the transcript must not be left in the browser");
  });

  it("an emptied conversation removes the row rather than storing []", () => {
    const s = memStore();
    const key = "merrymen.chat.self";
    saveTurns(key, [turn(1)], s);
    saveTurns(key, [], s);
    assert.equal(s.map.has(key), false);
  });

  it("keeps the NEWEST turns when there are too many", () => {
    const s = memStore();
    const key = "merrymen.chat.self";
    const many = Array.from({ length: MAX_TURNS + 10 }, (_, i) => turn(i));
    saveTurns(key, many, s);
    const back = loadTurns(key, s);
    assert.equal(back.length, MAX_TURNS);
    assert.deepEqual(back[back.length - 1], turn(MAX_TURNS + 9), "the last thing said must survive");
  });
});

describe("what it refuses to trust or to crash on", () => {
  it("SHAPE-CHECKS WHAT IT READS BACK", () => {
    // This came out of a store any script on this origin could have written,
    // and it is rendered as the agent's own words.
    const s = memStore();
    const key = "merrymen.chat.self";
    s.map.set(key, JSON.stringify([turn(1), { question: 1, answer: null }, "nope", null, { question: "q" }]));
    assert.deepEqual(loadTurns(key, s), [turn(1)]);
  });

  it("survives a value that is not JSON, and one that is not a list", () => {
    const s = memStore();
    s.map.set("k", "{not json");
    assert.deepEqual(loadTurns("k", s), []);
    s.map.set("k", JSON.stringify({ question: "q", answer: "a" }));
    assert.deepEqual(loadTurns("k", s), []);
  });

  it("A THROWING STORE IS NOT A CRASH", () => {
    // localStorage throws outright in a private window, in some embedded views
    // and wherever site data is blocked — it does not return null. A bare read
    // would take down a screen that was working perfectly.
    assert.deepEqual(loadTurns("k", hostile), []);
    saveTurns("k", [turn(1)], hostile);
    clearTurns("k", hostile);
  });
});

describe("the shell uses it the way it has to be used", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

  it("THE OUTGOING OWNER'S KEY IS THE ONE THAT GETS CLEARED", () => {
    // Sign-out drops the account first, so by the time anything reacts, the
    // current key is null — the key that must be deleted is the previous one.
    assert.match(app, /if \(previous && previous !== chatKey\) clearTurns\(previous\);/);
    assert.match(app, /lastChatKey = useRef<string \| null>\(null\)/);
  });

  it("and it is written on every change, not on unmount", () => {
    // A phone reclaiming a backgrounded tab never fires an unmount, which is
    // one of the ways the conversation was being lost.
    assert.match(app, /saveTurns\(chatKey, turns\);/);
    assert.match(app, /\}, \[chatKey, turns\]\);/);
  });
});
