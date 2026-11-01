/**
 * WHAT "FUND IT PRIVATELY" MAY CLAIM, AND WHAT IT MAY TOUCH.
 *
 * The Gloam option sits on the screen where money moves, so the same two rules
 * as the rest of this panel apply: it says only what is true about privacy, and
 * it changes nothing about the agent's authority. Source reads where the
 * property is how the screen is written, in the idiom of honesty.test.ts.
 * See docs/gloam-private-funding.md.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { GLOAM_PAY_URL, gloamFundingLink } from "../lib/gloam-funding";
import { EN, type MessageKey } from "../lib/messages/en";
import { CATALOGUES } from "../lib/messages";

const at = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** Source with comments removed: these files explain at length what they will not do. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const KEYS = (Object.keys(EN) as MessageKey[]).filter((k) => k.startsWith("fund.gloam."));
const COPY = KEYS.map((k) => EN[k]).join("\n");

describe("the link goes only where the money reaches the agent", () => {
  it("ROBINHOOD CHAIN MAINNET, AND NOWHERE ELSE", () => {
    assert.equal(gloamFundingLink(4663), GLOAM_PAY_URL);
    // The same address on any other network is not the agent. Testnet included:
    // its USDG is not the cash the agent trades.
    for (const chainId of [46630, 1, 8453, 0]) assert.equal(gloamFundingLink(chainId), null, String(chainId));
  });

  it("AND CARRIES NOTHING ABOUT THE AGENT TO A SERVER", () => {
    // No address, amount or owner in the query. Gloam's request links only take
    // a gloamr1 recipient today, so a 0x one would open rejected anyway.
    const url = new URL(GLOAM_PAY_URL);
    assert.equal(url.origin, "https://gloam.trade");
    assert.deepEqual([...url.searchParams.keys()].sort(), ["mode", "tab"]);
    assert.equal(url.hash, "");
  });
});

describe("the copy says what is private and what is not", () => {
  it("NEVER CLAIMS MORE THAN GLOAM DOES", () => {
    assert.ok(KEYS.length >= 5, "the option's copy should live in the catalogue");
    for (const word of [/anonym/i, /untrace/i, /invisible/i, /fully private/i, /no one can/i, /nobody can/i, /trades privately/i]) {
      assert.doesNotMatch(COPY, word);
    }
  });

  it("SAYS THE AGENT STAYS PUBLIC, AND HOW THE LINK CAN STILL BE DRAWN", () => {
    // The account's owner is its Kernel sudo validator (lib/derive-account.ts),
    // so the owning wallet is on chain whatever route the money took.
    assert.match(EN["fund.gloam.public"], /address, the wallet that owns it, its balance and its trades stay public/);
    assert.match(EN["fund.gloam.public"], /can still give away where it came from/);
  });

  it("NAMES THE ONE NETWORK, AND THE RELAY THAT HIDES THE WALLET", () => {
    assert.match(EN["fund.gloam.steps"], /Robinhood Chain only/);
    assert.match(EN["fund.gloam.steps"], /Hide my wallet on/);
  });

  it("no em dashes", () => {
    assert.doesNotMatch(COPY, /\u2014/);
  });
});

describe("it changes nothing about the agent's authority", () => {
  const src = code(at("./GloamFunding.tsx"));

  it("READS NO SESSION, GRANT OR WALLET, AND CALLS NOTHING", () => {
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!).sort();
    assert.deepEqual(imports, ["@/lib/gloam-funding", "@/lib/i18n", "react"]);
    assert.doesNotMatch(src, /\bfetch\(|requestJson|loadGrant|sessionStorage|localStorage/);
  });

  it("opens Gloam without telling it where the owner came from", () => {
    assert.match(src, /target="_blank"/);
    assert.match(src, /rel="noopener noreferrer"/);
  });

  it("SITS IN THE DEPOSIT PANEL BESIDE THE ADDRESS, AND STEPS ASIDE DURING RECOVERY", () => {
    const panel = code(at("./HostedControls.tsx"));
    assert.match(
      panel,
      /!pausedRecovery\(account\.status\.recovery\) && <GloamFunding address=\{grant\.smartAccount\} chainId=\{grant\.chainId\}\/>/,
    );
  });
});

describe("a namespace does not ship until its SCREEN is extracted", () => {
  it("NO CATALOGUE TRANSLATES fund.* WHILE THE FUNDING PANEL IS ENGLISH", () => {
    // The same rule settings.* follows in lib/i18n.test.ts. This comes OFF when
    // the rest of FundingPanel reads from the catalogue, and not before.
    for (const [tag, table] of Object.entries(CATALOGUES)) {
      const shipped = Object.keys(table ?? {}).filter((k) => k.startsWith("fund."));
      assert.deepEqual(shipped, [], `${tag} would put a translated block in an English panel`);
    }
  });
});
