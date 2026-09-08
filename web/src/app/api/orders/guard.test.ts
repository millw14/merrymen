/**
 * THE ONE ROUTE IN THIS APP THAT CAN SPEND MONEY.
 *
 * Everything else the chat can reach writes a setting or moves the page. This
 * writes a row that a process holding a key will read as an instruction to
 * trade, so the properties below are not style — they are the difference
 * between "one click, at most one trade" and an account draining over an hour.
 *
 * Source-read, deliberately. The behaviour that matters here is a SQL predicate,
 * an id derivation and a validation order, and the alternative — standing up a
 * Postgres, a session and a grant store to assert them — would test the harness.
 * honesty.test.ts and privy-boundary.test.ts use the same discipline for the
 * same reason: where the property lives in the words, read the words.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const ROUTE = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

/** The file with its comments removed — this repo documents what it does NOT do. */
const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const CODE = codeOf(ROUTE);

describe("who may place an order", () => {
  it("A SIGNED-OUT CALLER PLACES NOTHING", () => {
    // Hosted, `tenantOf` is a server-verified wallet and the account is resolved
    // through the grant store — so a caller can never name somebody else's
    // agent. Self-hosted there is no auth and the localhost middleware is the
    // perimeter, which is the same split /api/selftest already draws.
    assert.match(CODE, /const agent = await agentFor\(req\);\s*\n\s*if \(!agent\) return NextResponse\.json\(\{ error: "not signed in" \}, \{ status: 401 \}\);/);
    assert.equal((CODE.match(/if \(!agent\) return/g) ?? []).length, 2, "both POST and GET");
  });

  it("and the agent is never read from the body", () => {
    // The one shape that would turn an authenticated session into a way to
    // trade from somebody else's account.
    assert.ok(!/body\.(agent|agentId|account|tenant)/.test(CODE));
    assert.ok(!/searchParams\.get\("agent/.test(CODE));
  });
});

describe("one click is at most one trade", () => {
  it("THE ID IS A HASH OF THE ORDER, so a retry collides instead of filling twice", () => {
    // A double-click, a component that mounts twice, or a retry after a lost
    // response are all the same order — and with a random uuid each would have
    // been a second position at a second price with a second gas bill. The
    // minute bucket is what keeps a genuinely-repeated order possible.
    assert.match(CODE, /createHash\("sha256"\)/);
    assert.match(CODE, /Math\.floor\(nowMs \/ 60_000\)/);
    assert.match(CODE, /\$\{agent\.toLowerCase\(\)\}\|\$\{o\.side\}\|\$\{o\.symbol\}\|\$\{o\.usdgAmount\}\|\$\{bucket\}/);
    // A HASH, never a concatenation: the id becomes a filename under a child's
    // home in the process that can see every tenant's home. command-files.ts
    // validates the shape again, and this is why it has to.
    assert.match(CODE, /\.digest\("hex"\)/);
  });

  it("and a duplicate is reported as QUEUED, not as an error", () => {
    // Telling somebody their order failed when it is queued invites exactly the
    // retry this exists to absorb.
    assert.match(CODE, /duplicate: true/);
  });

  it("ONE ORDER IN FLIGHT AT A TIME, checked before the insert", () => {
    // Two DIFFERENT orders a second apart are two different ids, so the key
    // collision above would not catch them. Without this, a queue can be filled
    // faster than a worker drains it.
    assert.match(CODE, /kind = 'trade' AND done_at IS NULL/);
    assert.match(CODE, /"in-flight"/);
    assert.match(CODE, /status: result\.why === "in-flight" \? 409 : 503/);
    // Self-hosted has no table, so the pending FILE is the same rule.
    assert.match(CODE, /hasPendingCommand\(merrymenHome\(\)\)/);
  });

  it("and an order EXPIRES, because a settings write is timeless and this is not", () => {
    // The child returns early from its drain when it is unarmed, restarting or
    // when the market was unreadable, and the command file survives a restart.
    // Without this, a click during a wobble fills hours later at a price the
    // owner never saw.
    // TWO TICKS OF THE TICK THIS TENANT ACTUALLY RUNS, not a constant tuned for
    // the 60s default. The hosted fleet runs 240s and the child drains at most
    // one command per tick, so five minutes bought exactly ONE attempt — and an
    // order that missed it was dead. Watched that happen in production: a child
    // re-armed, its tick clock reset, and the queued order sat through its
    // entire window without being looked at once.
    assert.match(CODE, /const ORDER_TTL_FLOOR_MS = 5 \* 60_000;/);
    assert.match(CODE, /Math\.max\(ORDER_TTL_FLOOR_MS, \(2 \* tickSeconds \+ 15\) \* 1000\)/);
    assert.ok(CODE.includes("now + ttlMs"), "hosted and self-hosted both stamp it");
    assert.equal((CODE.match(/now \+ ttlMs/g) ?? []).length, 2);
    // And it is the CALLER's tick, not this container's — the same lesson the
    // ceiling above it had to learn.
    assert.match(CODE, /\(await getSettingsStore\(\)\.get\(tenant\)\)\?\.tickSeconds/);
  });
});

describe("what a size is allowed to be", () => {
  it("NOT NaN, NOT INFINITE, NOT ZERO, NOT NEGATIVE", () => {
    // A negative size passes every cap in the wall, because every cap is an
    // UPPER bound — and it REDUCES the day's spend on its way past, so the
    // accounting is what gets fooled. It is refused here and again at the wall:
    // two gates, neither relying on the other.
    assert.match(CODE, /if \(!Number\.isFinite\(usdgAmount\) \|\| usdgAmount <= 0\) return \{ error:/);
  });

  it("and it is rounded before it is hashed, so a retry is the same order", () => {
    assert.match(CODE, /Math\.round\(usdgAmount \* 100\) \/ 100/);
  });

  it("THE OWNER'S OWN CEILING IS APPLIED, not silently inherited as nothing", () => {
    // The setting predates this surface and is named for the other one; it
    // means the same thing in both. Applying it is the point — a new surface
    // that bounded nothing would claim more than the owner's configured limit.
    assert.match(CODE, /resolveConfig\(\)\.telegramMaxActionUsdg/);
    assert.match(CODE, /over your \$\{ceiling\} USDG limit/);
  });

  it("and a symbol is a ticker, not a sentence", () => {
    assert.match(CODE, /\/\^\[A-Z0-9\]\{1,12\}\$\//);
  });

  it("a side is buy or sell and nothing else", () => {
    assert.match(CODE, /body\.side === "buy" \|\| body\.side === "sell" \? body\.side : null/);
  });
});

describe("what this route deliberately does NOT decide", () => {
  it("IT NEVER JUDGES WHETHER THE TRADE IS ALLOWED", () => {
    // The watch set, the grant's sellable assets, the venue and every cap live
    // in the worker, and only the worker can answer without guessing. A second,
    // weaker copy of the wall in the web tier is the exact shape of the bug the
    // wall exists to prevent — and a wrong "yes" from here would be worse than
    // no check at all.
    for (const forbidden of ["sellableAssets", "allowedAssets", "perTradeUsdg", "checkPolicy", "knownCurves", "grantTokens"]) {
      assert.ok(!CODE.includes(forbidden), `${forbidden} is the worker's to decide, not this route's`);
    }
  });

  it("and it never signs, sends or touches a key", () => {
    for (const forbidden of ["privateKey", "signUserOperation", "sendUserOperation", "mnemonic", "sessionKey", "viem"]) {
      assert.ok(!CODE.includes(forbidden), `${forbidden} has no business in a web route`);
    }
  });
});

describe("what the caller is told", () => {
  it("FOUR STATES, because a spinner cannot tell them apart", () => {
    // "queued" and "running" look identical to somebody watching and mean
    // different things when they stop changing: queued-forever is a worker that
    // is not draining, running-forever is an order that hung.
    assert.match(CODE, /state: done \? "done" : claimed \? "running" : "queued"/);
    assert.match(CODE, /\{ state: "none" \}/);
  });

  it("and SELF-HOSTED reads the files, because no table ever gets the result there", () => {
    // There is no orchestrator self-hosted, so nothing ferries a result into a
    // row — reading the table would answer "none" for an order that had already
    // filled, which is the same body as one that was never placed.
    assert.match(CODE, /readCommandState\(merrymenHome\(\), id\)/);
  });

  it("and the queued response never claims a trade happened", () => {
    // A 200 here means one thing: a row exists. Not ferried, not claimed, not
    // put to the wall, not signed.
    assert.ok(!/bought|sold|filled|executed/i.test(CODE.replace(/'trade'|"trade"/g, "")));
  });
});

describe("what the review found, pinned so it cannot come back", () => {
  it("A DATABASE ERROR IS NOT A DUPLICATE", () => {
    // The INSERT catch used to swallow EVERY error and answer {queued:true} —
    // so a missing column, a dropped connection or a full disk all told the
    // owner their order was placed when no row existed. Exactly one error means
    // "already queued", and it is the only one reported as success.
    assert.match(CODE, /if \(!isDuplicateKey\(e\)\) return \{ ok: false as const, why: "unreachable" as const \};/);
    assert.match(CODE, /code === "23505"/, "postgres unique violation");
    assert.match(CODE, /PRIMARYKEY\|UNIQUE constraint\|duplicate key/, "and the sqlite spelling");
  });

  it("THE IN-FLIGHT GUARD HAS AN AGE BOUND, or one dead order locks the owner out forever", () => {
    // `done_at` is written only by the ferry's up-leg, which fires only when the
    // child produced a result file. A child SIGKILLed mid-trade — the watchdog
    // does that in bulk on this fleet — left a row nothing could ever finish,
    // and every future order from that tenant was refused.
    assert.match(CODE, /done_at IS NULL AND created_at > \?/);
    assert.match(CODE, /now - ttlMs - STALE_GRACE_MS/);
    assert.match(CODE, /const STALE_GRACE_MS = /);
  });

  it("THE CEILING IS THE CALLER'S, not this container's", () => {
    // `resolveConfig()` reads the WEB process's own ~/.merrymen/settings.json —
    // hosted, the house's file, which has nothing to do with this tenant, whose
    // settings live in the per-tenant store /api/settings reads. Every hosted
    // tenant was held to the house default whatever they had configured.
    assert.match(CODE, /const ceiling = await ceilingFor\(req\);/);
    assert.match(CODE, /getSettingsStore\(\)\.get\(tenant\)/);
    // Self-hosted the web process and the worker genuinely share one home, so
    // the bare resolve is correct there and stays.
    assert.match(CODE, /if \(!isHostedMode\(\)\) return fallback;/);
  });

  it("and an unreadable settings store falls back to the SMALLER number", () => {
    // Fail-safe: the default is the tighter ceiling, and the sealed per-trade
    // cap is the real wall underneath either way.
    const fn = CODE.slice(CODE.indexOf("async function ceilingFor"), CODE.indexOf("function orderId"));
    assert.match(fn, /catch \{\s*return fallback;\s*\}/);
  });
});
