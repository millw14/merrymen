/**
 * THE SAFETY PROPERTIES OF SPEAKING THROUGH 43 PEOPLE'S BOTS.
 *
 * This is the only code in the repo that touches every tenant's Telegram
 * credential in one process, and the only code that can message the whole beta
 * at once. Both of those make its failure modes categorical rather than
 * cosmetic: a mistake here leaks a fleet of live bot tokens, or double-sends to
 * real people, or speaks to someone who switched the bot off.
 *
 * So the tests are about REFUSALS, not about output. Each one corresponds to a
 * failure mode that is real in this system:
 *
 *  - a second getUpdates on a token silently breaks that tenant's bot, because
 *    Telegram allows exactly one long-poll per token and the child already has it
 *  - sendMessage never throws, so an un-collected failure is an invisible one
 *  - a partial run re-run without a cursor re-delivers to everyone reached
 *  - telegramEnabled=false is the owner having already answered this question
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, mock } from "node:test";
import { personalLine, runAnnouncement } from "./announce";

const SRC = readFileSync(new URL("./announce.ts", import.meta.url), "utf8");
/** Comment-stripped: this repo explains its refusals where it makes them. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("what the announcer must never do", () => {
  it("never reads from Telegram — only sendMessage", () => {
    // THE one that breaks other people's bots. A bot token allows a single
    // getUpdates long-poll and every tenant's child already holds it.
    assert.doesNotMatch(code, /getUpdates|setWebhook|deleteWebhook/);
    assert.match(code, /sendMessage/);
  });

  it("never logs, prints or persists a bot token", () => {
    // Tokens are sealed under MERRYMEN_STORE_DEK precisely so they never sit in
    // the clear. Any console line or write that could carry one is banned by
    // shape, because the leak would be a fleet of live credentials at once.
    assert.doesNotMatch(code, /console\./, "this module must be silent; the caller reports");
    assert.doesNotMatch(code, /writeFile|appendFile|createWriteStream/);
    // The token is on the in-memory recipient and must not reach the outcome.
    // ANCHORED, AND THE ANCHORS ARE CHECKED. indexOf returns -1 on a miss and
    // slice maps that to length-1, so a rename of either anchor collapsed this
    // to the empty string and `doesNotMatch("", /token/)` passed while reading
    // nothing at all — a security guard that disarms itself silently.
    const a = SRC.indexOf("export interface AnnounceOutcome");
    const b = SRC.indexOf("export const ANNOUNCE_DDL");
    assert.ok(a >= 0 && b > a, "the outcome-interface anchors moved — this guard is no longer reading anything");
    // A FIELD THAT HOLDS ONE, not the word anywhere: `skippedNoToken: number`
    // is a count and is fine, `token: string` or `botToken: string` is not.
    // The first draft was case-SENSITIVE and would have missed `botToken`.
    assert.doesNotMatch(
      SRC.slice(a, b),
      /\btoken\s*\??\s*:\s*string/i,
      "the returned outcome must not carry a token",
    );
  });

  it("never selects the link code, which is a bearer credential", () => {
    // tenant_telegram holds link_code beside owner_id; whoever holds one can
    // /link and gain control commands over that agent.
    assert.match(code, /SELECT tenant, owner_id FROM tenant_telegram/);
    assert.doesNotMatch(code, /link_code/);
  });
});

/** A store double, so no real settings or Postgres are touched. */
const makeClient = (opts: { chats: [string, number][]; blockers?: [string, string][]; already?: string[] }) => {
  const queries: string[] = [];
  return {
    queries,
    inserted: [] as string[],
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);
      if (sql.includes("FROM tenant_telegram")) {
        return { rows: opts.chats.map(([tenant, owner_id]) => ({ tenant, owner_id })) };
      }
      if (sql.includes("live_blocker IS NOT NULL")) {
        return { rows: (opts.blockers ?? []).map(([tenant, live_blocker]) => ({ tenant, live_blocker })) };
      }
      if (sql.includes("SELECT tenant FROM announcements")) {
        return { rows: (opts.already ?? []).map((tenant) => ({ tenant })) };
      }
      if (sql.includes("INSERT INTO announcements")) {
        (this as unknown as { inserted: string[] }).inserted.push(String((params ?? [])[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
};

/**
 * A settings double. Injected rather than module-mocked: an ESM export cannot
 * be redefined in place ("Cannot redefine property"), and reaching for the real
 * store would need the real DEK.
 */
const store = (
  tenants: Record<string, { telegramBotToken?: string; telegramEnabled?: boolean; telegramNotifyEnabled?: boolean }>,
) =>
  ({
    listTenants: async () => Object.keys(tenants) as `0x${string}`[],
    get: async (t: string) => tenants[t] ?? null,
  }) as never;

describe("the announcer's refusals, exercised", () => {
  it("a DRY RUN contacts Telegram zero times", async () => {
    const st = store({ "0xaa": { telegramBotToken: "t1" } });
    const send = mock.fn(async () => ({ ok: true }));
    const client = makeClient({ chats: [["0xaa", 111]] });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "hello", confirmed: false, send: send as never, sleep: async () => {},
    });
    assert.equal(send.mock.callCount(), 0, "a dry run that sends is not a dry run");
    assert.equal(out.dryRun, true);
    assert.equal(out.sent, 1, "but it still reports who WOULD receive it");
  });

  it("skips an owner who turned Telegram off", async () => {
    const st = store({
      "0xaa": { telegramBotToken: "t1", telegramEnabled: false },
      "0xbb": { telegramBotToken: "t2" },
    });
    const send = mock.fn(async () => ({ ok: true }));
    const client = makeClient({ chats: [["0xaa", 111], ["0xbb", 222]] });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(out.skippedDisabled, 1);
    assert.equal(send.mock.callCount(), 1, "only the tenant who left it on");
    assert.equal((send.mock.calls[0]!.arguments as unknown[])[1], 222);
  });

  it("does not send twice for the same announcement id", async () => {
    const st = store({ "0xaa": { telegramBotToken: "t1" }, "0xbb": { telegramBotToken: "t2" } });
    const send = mock.fn(async () => ({ ok: true }));
    const client = makeClient({ chats: [["0xaa", 111], ["0xbb", 222]], already: ["0xaa"] });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(out.skippedAlreadySent, 1);
    assert.equal(out.sent, 1);
  });

  it("records each delivery immediately, not in a batch at the end", async () => {
    // A crash halfway through a batched write re-sends to everyone reached.
    const st = store({ "0xaa": { telegramBotToken: "t1" }, "0xbb": { telegramBotToken: "t2" } });
    const client = makeClient({ chats: [["0xaa", 111], ["0xbb", 222]] });
    const seenAtSend: number[] = [];
    const send = mock.fn(async () => {
      seenAtSend.push(client.queries.filter((q) => q.includes("INSERT INTO announcements")).length);
      return { ok: true };
    });
    await runAnnouncement({ client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {} });
    // Before the 1st send: 0 inserts. Before the 2nd: 1 — the first was written
    // between them, which is what "immediately" means.
    assert.deepEqual(seenAtSend, [0, 1]);
  });

  it("collects failures instead of losing them — sendMessage never throws", async () => {
    const st = store({ "0xaa": { telegramBotToken: "t1" }, "0xbb": { telegramBotToken: "t2" } });
    const send = mock.fn(async (_o: unknown, chatId: number) =>
      chatId === 111 ? { ok: false, reason: "Forbidden: bot was blocked by the user" } : { ok: true },
    );
    const client = makeClient({ chats: [["0xaa", 111], ["0xbb", 222]] });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(out.sent, 1);
    assert.deepEqual(out.failed, [{ tenant: "0xaa", reason: "Forbidden: bot was blocked by the user" }]);
    // A blocked recipient must NOT be recorded as delivered, or a re-run skips
    // the one person who never got it.
    assert.deepEqual(client.inserted, ["0xbb"]);
  });

  it("skips a tenant with no linked chat and one with no token", async () => {
    const st = store({ "0xaa": {}, "0xbb": { telegramBotToken: "t2" }, "0xcc": { telegramBotToken: "t3" } });
    const send = mock.fn(async () => ({ ok: true }));
    const client = makeClient({ chats: [["0xaa", 111], ["0xbb", 222]] });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(out.skippedNoToken, 1, "0xaa has a chat but no bot");
    assert.equal(out.skippedNoChat, 1, "0xcc has a bot but never linked");
    assert.equal(out.eligible, 1);
  });
});

describe("the blocker join, against the real schema", () => {
  it("does NOT select a tenant column from agents, because there isn't one", () => {
    // The defect this file shipped with. `agents` is keyed by smart_account
    // (worker/src/store.ts: "CREATE TABLE IF NOT EXISTS agents (smart_account
    // TEXT PRIMARY KEY"). The first draft selected `tenant` from it, Postgres
    // threw, a bare catch swallowed it, and every message would have lost its
    // personalised line while the run reported success.
    const DDL = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
    const agents = DDL.slice(DDL.indexOf("CREATE TABLE IF NOT EXISTS agents"));
    const cols = agents.slice(0, agents.indexOf(")"));
    assert.ok(cols.includes("smart_account TEXT PRIMARY KEY"), "agents is keyed by smart_account");
    assert.ok(
      !cols.split("\n").some((l) => l.trim().startsWith("tenant ")),
      "agents has no tenant column — pin it, so the join cannot regress",
    );

    const join = code.slice(code.indexOf("FROM grants g"), code.indexOf("WHERE a.live_blocker"));
    // A literal, not a regex: the parentheses and dots in this SQL are all
    // regex metacharacters, and an unescaped version silently matches nothing
    // it was meant to pin.
    assert.ok(
      join.includes("JOIN agents a ON LOWER(a.smart_account) = LOWER(g.grant_json->>'smartAccount')"),
      "the tenant->account join must go through grants, which is the only table keyed by tenant",
    );
    // owner_address is the OTHER wrong answer: agent-for.ts records that
    // matching a tenant against it returns zero rows for every hosted tenant.
    assert.doesNotMatch(join, /owner_address/);
  });

  it("a failed join is REPORTED, never swallowed into an empty map", () => {
    // "nobody is blocked" and "the query broke" produce the same empty map and
    // are opposite facts. Only one of them is safe to send on.
    assert.match(code, /out.blockerJoinError = /);
    assert.doesNotMatch(code, /} catch {s*}/, "no bare swallow on the blocker path");
  });

  it("carries the blocker through to the sent text, end to end", async () => {
    const st = store({ "0xaa": { telegramBotToken: "t1" } });
    const client = makeClient({ chats: [["0xaa", 111]], blockers: [["0xaa", "no-cash"]] });
    let delivered = "";
    const send = mock.fn(async (_o: unknown, _c: number, text: string) => {
      delivered = text;
      return { ok: true };
    });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "BODY", confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(out.blockerJoinError, null);
    assert.equal(out.personalised, 1);
    assert.match(delivered, /^BODY/);
    assert.match(delivered, /no USDG/i, "the agent's own reason reaches the reader");
  });

  it("reports when NOTHING is personalised, which is the failure it hides", async () => {
    const st = store({ "0xaa": { telegramBotToken: "t1" } });
    const client = makeClient({ chats: [["0xaa", 111]] });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "B", confirmed: false, send: (async () => ({ ok: true })) as never, sleep: async () => {},
    });
    assert.equal(out.personalised, 0);
    assert.equal(out.sent, 1, "so the operator sees 0 of 1 and can stop");
  });
});

describe("consent signals beyond the on/off switch", () => {
  it("skips an owner who left the bot on but turned PUSHES off", async () => {
    // telegramNotifyEnabled is the opt-out that exists for exactly this kind of
    // message: an unprompted push. An announcement is the most literal instance
    // of the thing they declined, not an exception to it.
    const st = store({
      "0xaa": { telegramBotToken: "t1", telegramNotifyEnabled: false },
      "0xbb": { telegramBotToken: "t2", telegramNotifyEnabled: true },
    });
    const send = mock.fn(async () => ({ ok: true }));
    const client = makeClient({ chats: [["0xaa", 111], ["0xbb", 222]] });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(out.skippedNotifyOff, 1);
    assert.equal(send.mock.callCount(), 1);
    assert.equal((send.mock.calls[0]!.arguments as unknown[])[1], 222);
  });
});

describe("the body Telegram will actually accept", () => {
  it("names tags that would be silently stripped", async () => {
    const { illegalTags } = await import("./announce");
    // api.ts catches "can't parse entities", strips EVERY tag and re-sends as
    // plain text, returning {ok:true}. Right for a chat reply; here it means 43
    // unformatted walls of text reported as a clean success.
    assert.deepEqual(illegalTags("<p>hi</p><ul><li>x</li></ul>"), ["p", "ul", "li"]);
    assert.deepEqual(illegalTags("<b>bold</b> <i>it</i> <a href=\"u\">l</a> <code>c</code>"), []);
  });
});

describe("the personalised line", () => {
  it("is absent when the blocker is unknown", () => {
    // Silence beats a confident "everything looks fine" for an agent whose
    // reason simply was not recorded.
    assert.equal(personalLine(null), "");
  });

  it("renders a known blocker in the product's own words, escaped", () => {
    const line = personalLine("no-cash");
    assert.match(line, /no USDG/i, "the product's own sentence for no-cash");
    assert.match(line, /<b>Your agent, right now:<\/b>/);
    // The diagnosis is useless without somewhere to act on it, and the reader
    // is in a chat, not on the dashboard.
    assert.match(line, /app\.merrymen\.dev/);
  });
});

describe("the phone-fireable trigger on the orchestrator", () => {
  const ORCH = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  const BLOCK = ORCH.slice(
    ORCH.indexOf("async function runAnnouncementIfAsked"),
    ORCH.indexOf("async function runIdentityAuditIfAsked"),
  );

  it("exists and is anchored", () => {
    assert.ok(BLOCK.length > 400, "the announcement one-shot moved — re-point this test, do not delete it");
  });

  it("ARMING and SENDING are two different variables", () => {
    // MERRYMEN_ANNOUNCE_ID alone is a dry run. Messaging 43 real people must
    // never be one variable set by muscle memory.
    assert.match(BLOCK, /MERRYMEN_ANNOUNCE_ID/);
    assert.match(BLOCK, /MERRYMEN_ANNOUNCE_CONFIRM \?\? ""\)\.trim\(\) === id/);
  });

  it("is safe to leave set, because Railway restarts services freely", () => {
    // It runs on the reconcile loop, so it re-enters on every restart. The
    // per-recipient record in `announcements` is what makes that harmless —
    // without it, a redeploy loop would message everyone repeatedly.
    assert.match(ORCH, /if \(cohortPasses === 1\) await runAnnouncementIfAsked\(\);/);
    assert.match(code, /SELECT tenant FROM announcements WHERE announce_id = \$1/);
  });

  it("refuses a body Telegram would silently mangle, before any send", () => {
    assert.match(BLOCK, /illegalTags\(body\)/);
    assert.match(BLOCK, /refusing/);
  });

  it("never lets a thrown error object reach the log", () => {
    // A pg or fetch error can carry request context, and in this process that
    // context can include a bot token.
    assert.match(BLOCK, /e instanceof Error \? e\.message : String\(e\)/);
    assert.doesNotMatch(BLOCK, /log\(`[^`]*\$\{e\}/, "never interpolate the error object itself");
  });

  it("shouts when the per-agent lookup failed rather than reporting a clean run", () => {
    assert.match(BLOCK, /blockerJoinError/);
    assert.match(BLOCK, /every message would be generic/);
  });
});
