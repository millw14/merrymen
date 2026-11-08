import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { clearPrivySignIn } from "./privy-reset";

// A Spot grant as the browser keeps it, owner key included. Reset must never
// touch this shape of record, whatever else it clears.
const grant = JSON.stringify({ smartAccount: `0x${"a".repeat(40)}`, demoOwnerPrivateKey: `0x${"b".repeat(64)}` });
const ours: Record<string, string> = {
  "merrymen.grant.v1": grant,
  "merrymen.grant.perps.v1": grant,
  [`merrymen.grant.archive.0x${"a".repeat(40)}`]: grant,
  [`merrymen.backup.0x${"a".repeat(40)}`]: "backed-up",
  "merrymen.grant.backedup.v1": "1",
  "merrymen:trencher-fast:v2:dismissed": "1",
  "merryman.outfit.v1:dddddddddddddddd": "{}",
  // Near misses that are not Privy's.
  privy: "x",
  "Privy:token": "x",
  "xprivy:token": "x",
};
// Every key shape react-auth 3.51.1 and js-sdk-core 0.79.2 write.
const privys = [
  "privy:token",
  "privy:refresh_token",
  "privy:pat",
  "privy:id_token",
  "privy:id-token",
  "privy:did:privy:owner:token",
  "privy:did:privy:owner:refresh_token",
  "privy:active-user",
  "privy:saved-users",
  "privy:caid",
  "privy:connections",
  "privy:state_code",
  "privy:code_verifier",
  `privy:sent:${"c".repeat(25)}:12345`,
];

let dom: JSDOM;
const scope = () => ({ localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, document: dom.window.document });
const cookieNames = () => dom.window.document.cookie.split(";").map((part) => part.split("=", 1)[0].trim()).filter(Boolean).sort();

beforeEach(() => {
  dom = new JSDOM("", { url: "https://app.example.test/create" });
});

afterEach(() => {
  dom.window.close();
});

describe("clearPrivySignIn", () => {
  it("removes Privy's saved sign-in and leaves every Merrymen key and grant byte-for-byte", () => {
    const { localStorage, sessionStorage, document } = dom.window;
    for (const [key, value] of Object.entries(ours)) localStorage.setItem(key, value);
    for (const key of privys) localStorage.setItem(key, JSON.stringify("secret"));
    sessionStorage.setItem("privy:headless_oauth", "true");
    sessionStorage.setItem("merrymen.chat.draft", "keep");
    // How js-cookie writes Privy's cookies: host-only, path /, Secure, Strict.
    for (const name of ["privy-token", "privy-refresh-token", "privy-id-token", "privy-session", "privy-did%3Aprivy%3Aowner-session"]) {
      document.cookie = `${name}=t; Path=/; Secure; SameSite=Strict`;
    }
    document.cookie = "merrymen-theme=dark; Path=/";
    document.cookie = "privycookie=keep; Path=/";

    const cleared = clearPrivySignIn(scope());

    assert.deepEqual(Object.keys(localStorage).sort(), Object.keys(ours).sort());
    for (const [key, value] of Object.entries(ours)) assert.equal(localStorage.getItem(key), value, key);
    assert.deepEqual(Object.keys(sessionStorage), ["merrymen.chat.draft"]);
    assert.deepEqual(cookieNames(), ["merrymen-theme", "privycookie"]);
    assert.deepEqual(cleared.storage.sort(), [
      ...privys.map((key) => `localStorage:${key}`),
      "sessionStorage:privy:headless_oauth",
    ].sort());
    assert.deepEqual(cleared.cookies.sort(), [
      "privy-did%3Aprivy%3Aowner-session",
      "privy-id-token",
      "privy-refresh-token",
      "privy-session",
      "privy-token",
    ]);
  });

  it("still clears Privy's cookies when the browser refuses storage", () => {
    dom.window.document.cookie = "privy-session=t; Path=/";
    const refused = () => { throw new dom.window.DOMException("The operation is insecure.", "SecurityError"); };
    const blocked = {
      get localStorage(): Storage { return refused(); },
      sessionStorage: { get length() { return 1; }, key: refused, removeItem: refused } as unknown as Storage,
      document: dom.window.document,
    };
    const cleared = clearPrivySignIn(blocked);
    assert.deepEqual(cleared, { storage: [], cookies: ["privy-session"] });
    assert.deepEqual(cookieNames(), []);
  });

  it("does nothing outside a browser", () => {
    assert.deepEqual(clearPrivySignIn({}), { storage: [], cookies: [] });
  });
});
