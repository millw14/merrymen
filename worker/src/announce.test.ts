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
import { announcementConfirmation, personalLine, runAnnouncement, type SettingsReader } from "./announce";

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
    assert.match(code, /SELECT tenant, owner_id, bot_id FROM tenant_telegram/);
    assert.doesNotMatch(code, /link_code/);
  });
});

/** A store double, so no real settings or Postgres are touched. */
const botId = (tenant: string) => String(Number.parseInt(tenant.slice(2, 4), 16));
const makeClient = (opts: { chats: [string, number][]; blockers?: [string, string][]; already?: string[]; claims?: [string, string][]; attempted?: string[] }) => {
  const queries: string[] = [];
  const attempts = new Set(opts.attempted ?? []);
  return {
    queries,
    attempts,
    inserted: [] as string[],
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);
      if (sql.startsWith("INSERT INTO announcement_attempts")) {
        const tenant = String(params?.[1]);
        const chat = opts.chats.find(([t]) => t === tenant);
        const claim = (opts.claims ?? opts.chats.map(([t]) => [botId(t), t] as [string, string]))
          .find(([id]) => id === params?.[2]);
        if (attempts.has(tenant) || (opts.already ?? []).includes(tenant) || !chat ||
            chat[1] !== params?.[3] || claim?.[1] !== tenant) return { rows: [] };
        attempts.add(tenant);
        return { rows: [{ tenant }] };
      }
      if (sql.startsWith("SELECT tenant FROM announcement_attempts")) {
        return { rows: [...attempts].map((tenant) => ({ tenant })) };
      }
      if (sql.startsWith("SELECT bot_id, tenant FROM telegram_bot_claims")) {
        return { rows: (opts.claims ?? opts.chats.map(([t]) => [botId(t), t] as [string, string]))
          .map(([bot_id, tenant]) => ({ bot_id, tenant })) };
      }
      if (sql.includes("AS bot_owned")) {
        const claim = (opts.claims ?? opts.chats.map(([t]) => [botId(t), t] as [string, string]))
          .some(([id, tenant]) => id === params?.[0] && tenant === params?.[1]);
        const chat = opts.chats.some(([tenant, owner_id]) =>
          tenant === params?.[1] && owner_id === params?.[2] && botId(tenant) === params?.[0]);
        return { rows: [{ bot_owned: claim, chat_current: chat }] };
      }
      if (sql.startsWith("SELECT tenant, owner_id, bot_id FROM tenant_telegram")) {
        return { rows: opts.chats.map(([tenant, owner_id]) => ({ tenant, owner_id, bot_id: botId(tenant) })) };
      }
      // Matches on FROM grants, not on a WHERE clause: the join no longer
      // filters to blocked agents, because an UNBLOCKED agent still has a name
      // and a per-agent campaign needs it.
      if (sql.includes("FROM grants")) {
        return { rows: (opts.blockers ?? []).map(([tenant, live_blocker]) => ({ tenant, live_blocker })) };
      }
      if (sql.startsWith("SELECT tenant FROM announcements")) {
        return { rows: (opts.already ?? []).map((tenant) => ({ tenant })) };
      }
      if (sql.startsWith("INSERT INTO announcements")) {
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
  tenants: Record<
    string,
    {
      telegramBotToken?: string;
      telegramEnabled?: boolean;
      telegramNotifyEnabled?: boolean;
      telegramAllowlist?: number[];
    }
  >,
) =>
  ({
    listTenants: async () => Object.keys(tenants) as `0x${string}`[],
    get: async (t: string) => {
      const s = tenants[t];
      if (!s) return null;
      return {
        ...s,
        telegramBotToken: s.telegramBotToken ? `${botId(t)}:${s.telegramBotToken}` : undefined,
        telegramEnabled: s.telegramEnabled ?? true,
        telegramAllowlist: s.telegramAllowlist ?? (s.telegramBotToken ? [111, 222, 333] : []),
      };
    },
  }) as SettingsReader;

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

  it("treats an omitted Telegram enable flag as off, matching the product default", async () => {
    const st: SettingsReader = {
      listTenants: async () => ["0xaa"],
      get: async () => ({ telegramBotToken: `${botId("0xaa")}:TOKEN`, telegramAllowlist: [111] }),
    };
    const send = mock.fn(async () => ({ ok: true }));
    const client = makeClient({ chats: [["0xaa", 111]] });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(out.skippedDisabled, 1);
    assert.equal(send.mock.callCount(), 0);
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

  it("refuses a copied token whose bot claim belongs to another tenant", async () => {
    const st = store({ "0xaa": { telegramBotToken: "t1" } });
    const send = mock.fn(async () => ({ ok: true }));
    const client = makeClient({ chats: [["0xaa", 111]], claims: [[botId("0xaa"), "0xbb"]] });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(out.skippedNoClaim, 1);
    assert.equal(send.mock.callCount(), 0);
    assert.equal(client.attempts.size, 0);
  });

  it("re-reads consent before the send and keeps a declined tenant unclaimed", async () => {
    const base = store({ "0xaa": { telegramBotToken: "t1" } });
    let reads = 0;
    const st = {
      listTenants: base.listTenants,
      get: async (tenant: `0x${string}`) => {
        const value = await base.get(tenant);
        return ++reads >= 2 ? { ...(value ?? {}), telegramNotifyEnabled: false } : value;
      },
    } as never;
    const send = mock.fn(async () => ({ ok: true }));
    const client = makeClient({ chats: [["0xaa", 111]] });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(out.skippedChanged, 1);
    assert.equal(send.mock.callCount(), 0);
    assert.equal(client.attempts.size, 0);
  });

  it("refuses an owner chat removed from the allowlist while the campaign is prepared", async () => {
    const base = store({ "0xaa": { telegramBotToken: "t1", telegramAllowlist: [111] } });
    let reads = 0;
    const st: SettingsReader = {
      listTenants: base.listTenants,
      get: async (tenant) => {
        const value = await base.get(tenant);
        return ++reads >= 2 ? { ...(value ?? {}), telegramAllowlist: [] } : value;
      },
    };
    const send = mock.fn(async () => ({ ok: true }));
    const client = makeClient({ chats: [["0xaa", 111]] });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(out.skippedChanged, 1);
    assert.equal(send.mock.callCount(), 0);
    assert.equal(client.attempts.size, 0);
  });

  it("refuses a bot claim moved to another tenant before the pre-send reservation", async () => {
    const claims: [string, string][] = [[botId("0xaa"), "0xaa"]];
    const base = store({ "0xaa": { telegramBotToken: "t1" } });
    let reads = 0;
    const st: SettingsReader = {
      listTenants: base.listTenants,
      get: async (tenant) => {
        const value = await base.get(tenant);
        if (++reads === 2) claims[0]![1] = "0xbb";
        return value;
      },
    };
    const send = mock.fn(async () => ({ ok: true }));
    const client = makeClient({ chats: [["0xaa", 111]], claims });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(out.skippedChanged, 1);
    assert.equal(send.mock.callCount(), 0);
    assert.equal(client.attempts.size, 0);
  });

  it("rechecks the claim after reservation if the bot moves just before send", async () => {
    const claims: [string, string][] = [[botId("0xaa"), "0xaa"]];
    const base = store({ "0xaa": { telegramBotToken: "t1" } });
    let reads = 0;
    const st: SettingsReader = {
      listTenants: base.listTenants,
      get: async (tenant) => {
        const value = await base.get(tenant);
        if (++reads === 3) claims[0]![1] = "0xbb";
        return value;
      },
    };
    const send = mock.fn(async () => ({ ok: true }));
    const client = makeClient({ chats: [["0xaa", 111]], claims });
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(out.skippedChanged, 1);
    assert.equal(send.mock.callCount(), 0);
    assert.equal(client.attempts.size, 1, "the pre-send claim remains as an aborted attempt");
  });

  it("does not replay after a send succeeds but the delivered-row write crashes", async () => {
    const st = store({ "0xaa": { telegramBotToken: "t1" } });
    const client = makeClient({ chats: [["0xaa", 111]] });
    const original = client.query.bind(client);
    let crash = true;
    client.query = async (sql: string, params?: unknown[]) => {
      if (crash && sql.startsWith("INSERT INTO announcements")) throw new Error("database went away after Telegram replied");
      return original(sql, params);
    };
    const send = mock.fn(async () => ({ ok: true }));
    await assert.rejects(runAnnouncement({
      client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {},
    }), /database went away/);
    assert.equal(client.attempts.size, 1, "the claim landed before Telegram");
    crash = false;
    const rerun = await runAnnouncement({
      client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(rerun.skippedAlreadyAttempted, 1);
    assert.equal(send.mock.callCount(), 1, "the second pass must not replay the message");
  });

  it("claims each delivery before sending, so a crash cannot replay it", async () => {
    const st = store({ "0xaa": { telegramBotToken: "t1" }, "0xbb": { telegramBotToken: "t2" } });
    const client = makeClient({ chats: [["0xaa", 111], ["0xbb", 222]] });
    const seenAtSend: number[] = [];
    const send = mock.fn(async () => {
      seenAtSend.push(client.attempts.size);
      return { ok: true };
    });
    await runAnnouncement({ client, store: st, announceId: "x", body: "hi", confirmed: true, send: send as never, sleep: async () => {} });
    assert.deepEqual(seenAtSend, [1, 2]);
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
    // A blocked recipient is not recorded as delivered. Its pre-send claim
    // remains until an operator inspects it; transport failures can be uncertain.
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

    const join = code.slice(code.indexOf("FROM grants g"), code.indexOf("`,", code.indexOf("FROM grants g")));
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

  it("omits a cached blocker from the general recovery update", async () => {
    const st = store({ "0xaa": { telegramBotToken: "t1" } });
    const client = makeClient({ chats: [["0xaa", 111]], blockers: [["0xaa", "no-cash"]] });
    let delivered = "";
    const send = mock.fn(async (_auth: unknown, _chat: number, body: string) => {
      delivered = body;
      return { ok: true };
    });
    await runAnnouncement({
      client, store: st, announceId: "recovery-2026-10-01", body: "Service is back", appendPersonalLine: false,
      confirmed: true, send: send as never, sleep: async () => {},
    });
    assert.equal(delivered, "Service is back");
  });
});

describe("recovery text confirmation", () => {
  it("requires the exact dry-run body digest in addition to the campaign id", () => {
    const dry = announcementConfirmation("recovery-2026-10-01", "A", undefined, undefined);
    assert.equal(dry.confirmed, false);
    assert.match(dry.bodySha256, /^[a-f0-9]{64}$/);
    assert.equal(announcementConfirmation("recovery-2026-10-01", "A", "recovery-2026-10-01", undefined).confirmed, false);
    assert.equal(announcementConfirmation("recovery-2026-10-01", "B", "recovery-2026-10-01", dry.bodySha256).confirmed, false);
    assert.equal(announcementConfirmation("recovery-2026-10-01", "A", "recovery-2026-10-01", dry.bodySha256).confirmed, true);
    assert.equal(announcementConfirmation("older-campaign", "A", "older-campaign", undefined).confirmed, false);
    assert.equal(announcementConfirmation("older-campaign", "A", "older-campaign", dry.bodySha256).confirmed, true);
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
    assert.match(BLOCK, /announcementConfirmation\(/);
    assert.match(BLOCK, /MERRYMEN_ANNOUNCE_CONFIRM/);
    assert.match(BLOCK, /MERRYMEN_ANNOUNCE_BODY_SHA256/);
  });

  it("is safe to leave set, because Railway restarts services freely", () => {
    // It runs on the reconcile loop, so it re-enters on every restart. The
    // per-recipient record in `announcements` is what makes that harmless —
    // without it, a redeploy loop would message everyone repeatedly.
    assert.match(ORCH, /if \(cohortPasses === 1\) await runAnnouncementIfAsked\(\);/);
    assert.match(code, /SELECT tenant FROM announcements WHERE announce_id = \$1/);
  });

  it("refuses a body Telegram would silently mangle, before any send", () => {
    // EVERY body, not just the first. A per-agent campaign ships several, and
    // telegram/api.ts answers one bad tag by stripping ALL tags, re-sending as
    // plain text and returning {ok:true} — so an unchecked body is delivered
    // mangled and reported as a clean send. The check is inside the loop over
    // bodies, which is why this no longer pins the literal `illegalTags(body)`.
    assert.match(BLOCK, /illegalTags\(text\)/);
    assert.match(BLOCK, /for \(const \[who, text\] of/, "checked per body, in a loop");
    assert.match(BLOCK, /refusing/);
  });

  it("a per-agent campaign cannot select an owner whose message was never written", () => {
    // The recipient list IS the set of prepared files, so the two cannot drift.
    assert.match(BLOCK, /tenants: Object\.keys\(bodies\)/);
    assert.match(BLOCK, /bodies\[f\.slice\(0, -5\)\.toLowerCase\(\)\]/, "keyed by the filename's tenant");
  });

  it("the dry run prints the text and the agent, never a token", () => {
    assert.match(BLOCK, /out\.preview/, "the preview must be logged");
    assert.match(BLOCK, /p\.chatRedacted/, "the chat is redacted");
    assert.doesNotMatch(BLOCK, /\.token/, "no token may be logged from the trigger");
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

describe("the census counts the durable facts independently", () => {
  it("counts bot tokens and allowlists BEFORE the ordered skips", async () => {
    // The skip counters are ordered — chat is tested before token — so a tenant
    // dropped at the first test was never examined for the second. Reading
    // "0 no bot" as "everybody has a bot" cost me a wrong conclusion about the
    // whole fleet, stated to the owner. These two are counted for every tenant,
    // whatever happens after.
    const st = store({
      "0xaa": { telegramBotToken: "t1", telegramAllowlist: [111] },
      "0xbb": { telegramBotToken: "t2", telegramAllowlist: [] },
      "0xcc": {},
    });
    const client = makeClient({ chats: [] }); // nobody has a live chat
    const out = await runAnnouncement({
      client, store: st, announceId: "x", body: "B", confirmed: false, send: (async () => ({ ok: true })) as never, sleep: async () => {},
    });
    assert.equal(out.skippedNoChat, 3, "all three drop out at the first test");
    assert.equal(out.withBotToken, 2, "and the token count is still right for all three");
    assert.equal(out.withAllowlist, 1, "as is the count of who has ever linked");
  });

  it("separates 'never linked' from 'link was destroyed'", () => {
    // telegramAllowlist is in the sealed settings and survives a redeploy;
    // tenant_telegram.owner_id mirrors an EPHEMERAL child file. A gap between
    // them is people whose link a deploy destroyed — who need telling to
    // re-link, not telling how to set one up.
    const src = readFileSync(new URL("./announce.ts", import.meta.url), "utf8");
    const doc = src.slice(src.indexOf("HOW MANY HAVE EVER LINKED"), src.indexOf("withAllowlist: number;"));
    assert.match(doc, /survives a redeploy/);
    assert.match(doc, /EPHEMERAL/);
  });
});
