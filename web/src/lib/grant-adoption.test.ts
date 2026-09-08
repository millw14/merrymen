/**
 * A SECOND BROWSER IS NOT A LOST WALLET.
 *
 * Reported from the beta: create an agent and grant on app.merrymen.dev, then
 * sign in from incognito or another machine with the same X account, and you
 * cannot re-sign or change your trading limits. The screen fell to its RESTORE
 * panel, which asks for the owner private key — and a Privy-owned agent has no
 * such key for anyone to paste, in any browser, ever. So the one screen that
 * edits a signed limit offered the single action that account can never take.
 *
 * The tester got out by hand-writing the server's grant into localStorage. It
 * works, and it is a trap, which is why these tests exist at all:
 *
 *   localStorage["merrymen.grant.v1"] is the browser's FULL-FAT copy — the
 *   session key, a second copy of it inside `serialized`, and on a legacy agent
 *   the OWNER key, which is the smart account's sudo validator and is not bound
 *   by the wall at all. GET /api/grants strips all three. Writing what comes
 *   back over that slot replaces the only copy of those keys with an object
 *   that has none.
 *
 * So the fix adopts the server's grant into REACT STATE for display and
 * re-signing, and never into storage. Nothing secret is needed for either: the
 * re-sign takes the smart account, the caps and the chain from the response and
 * its signature from the Privy owner, which travels with the login.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const wallet = () => readFileSync(new URL("../terminal/screens/Wallet.tsx", import.meta.url), "utf8");
const route = () => readFileSync(new URL("../app/api/grants/route.ts", import.meta.url), "utf8");

describe("the server's grant may be adopted, never stored", () => {
  it("IT IS ADOPTED INTO STATE WHEN THE OWNER IS PRIVY", () => {
    const src = wallet();
    assert.match(src, /const adoptable = s\.grant && s\.grant\.binding\?\.version === "privy-did-owner-v1";/);
    assert.match(src, /if \(adoptable && s\.grant\) \{[\s\S]{0,400}setGrant\(s\.grant\);/);
  });

  it("AND NEVER WRITTEN TO merrymen.grant.v1", () => {
    // The whole hazard in one assertion. `setGrant` is React state; the storage
    // slot is written in exactly one place in the app — session.ts, at mint —
    // and this screen must not become a second writer.
    const src = wallet();
    assert.ok(
      !/localStorage\.setItem\(\s*(STORAGE_KEY|["']merrymen\.grant\.v1["'])/.test(src),
      "Wallet.tsx must never write the grant storage slot",
    );
  });

  it("and a legacy agent still goes to restore, because its key really is local", () => {
    // Not a fallback to be removed later: a browser-generated owner key exists
    // only in the browser that minted it, and no server has ever held one.
    const src = wallet();
    assert.match(src, /\} else \{[\s\S]{0,300}setMode\("restore"\);/);
  });

  it("and the backup gate is skipped only for the adopted case", () => {
    // The gate forces the owner to write down their key before funding. A
    // Privy agent has no key in any browser, so in an adopted session the gate
    // would block the screen on a task nobody can perform.
    const src = wallet();
    const adopt = src.slice(src.indexOf("const adoptable ="), src.indexOf('setMode("restore")'));
    assert.match(adopt, /setBackedUp\(true\);/);
  });
});

describe("what the endpoint may hand over", () => {
  it("THE THREE KEY-BEARING FIELDS ARE STRIPPED, and that is why adoption is safe", () => {
    // `serialized` is base64 JSON that embeds the session key — it is not an
    // opaque handle — so it counts as key material exactly like the two named
    // key fields.
    const src = route();
    assert.match(
      src,
      /const \{ serialized: _s, demoSessionPrivateKey: _k, demoOwnerPrivateKey: _o, \.\.\.publicGrant \} = grant;/,
    );
  });

  it("and the response is typed to exclude them, so a later field cannot slip through by name", () => {
    const src = route();
    assert.match(src, /Omit<StoredGrant, "serialized" \| "demoSessionPrivateKey" \| "demoOwnerPrivateKey">/);
  });

  it("and the adopted grant is only ever the binding version the re-sign can actually use", () => {
    // If a legacy grant were ever adopted, `resignBy` would resolve to null and
    // the control would be dead — a worse dead end than restore. The version
    // check is what keeps those two cases apart.
    const src = wallet();
    assert.match(src, /binding\?\.version === "privy-did-owner-v1"/);
    assert.match(src, /const resignBy: "owner-key" \| "privy" \| null = grant\?\.demoOwnerPrivateKey/);
  });
});

describe("re-arming says why it cannot, instead of doing nothing", () => {
  it("AN ADOPTED BROWSER HAS NOTHING TO RE-PUSH, AND SAYS SO", () => {
    // This panel has already shipped one button that silently did nothing;
    // an adopted grant carries no session key, so the same failure was
    // available again by a different route.
    const src = wallet();
    assert.match(src, /if \(!stored\) \{[\s\S]{0,600}setError\(/);
    assert.match(src, /this browser doesn't hold a copy of the signed key/);
  });
});

describe("the chat no longer refuses what it can do", () => {
  it("SYSTEM NO LONGER CONTRADICTS THE COMMAND BLOCK", async () => {
    // The agent told an owner "I can't move money or change settings from
    // here" while the command registry — appended to the same prompt,
    // unconditionally — carries set-strategy, set-size, set-basket, buy, sell,
    // open-deposit and the rest. It was following the older line.
    const chat = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
    assert.ok(
      !chat.includes("you can't do it in a chat reply"),
      "the line that told it to refuse must be gone",
    );
    assert.match(chat, /YOU CAN PROPOSE, AND THEY CONFIRM/);
    // And the one refusal that IS true stays true: the key carries no transfer
    // permission, so money cannot leave to an outside address however it asks.
    assert.match(chat, /sending money to an outside address, which the key you were signed with does not permit/);
  });

  it("and the command block is still appended unconditionally", () => {
    const chat = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
    assert.match(chat, /system: SYSTEM \+ COMMANDS/);
  });
});
