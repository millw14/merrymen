/**
 * A ONE-OFF PLATFORM ANNOUNCEMENT, SENT THROUGH EACH TENANT'S OWN BOT.
 *
 * There is no shared merrymen bot. Every tenant creates their own with
 * @BotFather and pastes the token in, so "message all users" means using ~43
 * people's private credentials to speak in their agent's chat. That is a
 * consent decision, not a technical one, and it is the operator's to make —
 * which is why this file does nothing until it is explicitly confirmed, and why
 * the message it sends says out loud that it is from the team and not from the
 * agent the reader named.
 *
 * WHAT THIS MUST NEVER DO, each learned from a real failure mode in this repo:
 *
 * - Never call getUpdates or setWebhook. A Telegram bot allows exactly ONE
 *   long-poll per token, and every tenant's child is already polling theirs
 *   (telegram/api.ts). A second reader silently breaks the tenant's bot.
 *   `sendMessage` alongside a running poll is safe; nothing else here is.
 * - Never write, log or return a bot token. They live sealed under
 *   MERRYMEN_STORE_DEK precisely so they never sit in the clear; a crash dump
 *   or a saved intermediate would leak a fleet of live credentials.
 * - Never send to a tenant who turned Telegram off. That is a setting, and an
 *   announcement is not an exception to it.
 * - Never send twice. `sendMessage` never throws, so a partial run that is
 *   re-run without a cursor re-delivers to everyone already reached.
 *
 * DRY RUN IS THE DEFAULT. It resolves every recipient, builds every message and
 * reports exactly what would happen, without contacting Telegram at all.
 */
import { createHash } from "node:crypto";
import { getSettingsStore } from "./settings-store";
import { esc, sendMessage } from "./telegram/api";
import { botIdOf } from "./telegram/state";
import { liveBlockerText } from "../../packages/core/src/index";

/**
 * The same structural type settings-store.ts uses. `pg` ships no types here and
 * is imported at RUNTIME only, so the caller hands us a connected client rather
 * than this module resolving one — which also keeps the connection, and the
 * decision to open one at all, in the operator's hands.
 */
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Only what this module reads. Injected rather than imported so a test can hand
 * over a double without ever constructing a real sealed store — an ESM export
 * cannot be redefined in place, and a test that needed the real one would need
 * the real DEK.
 */
export interface SettingsReader {
  listTenants(): Promise<`0x${string}`[]>;
  get(
    tenant: `0x${string}`,
  ): Promise<{
    telegramBotToken?: string;
    telegramEnabled?: boolean;
    telegramNotifyEnabled?: boolean;
    telegramAllowlist?: number[];
  } | null>;
}

/** Telegram tolerates ~30 messages/second globally; this is far under it. */
const SEND_GAP_MS = 250;

/**
 * Telegram's HTML parse mode accepts ONLY these. Everything an operator reaches
 * for when writing a file called `body.html` — p, br, ul, li, h2, div — is
 * rejected with "can't parse entities".
 *
 * And the rejection is invisible. `telegram/api.ts` catches that reason,
 * strips EVERY tag and re-sends as plain text, then returns a bare `{ok:true}`.
 * That behaviour is right for a chat reply — a reply must never be lost — and
 * wrong here: the announcement would reach all 43 as one unformatted run-on,
 * be recorded as delivered, and report `failed: 0`. The dry run cannot catch it
 * either, because it never contacts Telegram at all.
 *
 * So the body is checked BEFORE the first send, and a bad tag is named.
 */
const TELEGRAM_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "tg-spoiler", "blockquote", "span"]);

/** Tags in `body` that Telegram will reject, in order of appearance. Empty is good. */
export function illegalTags(body: string): string[] {
  const bad: string[] = [];
  for (const m of body.matchAll(/<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g)) {
    const tag = m[1]!.toLowerCase();
    if (!TELEGRAM_TAGS.has(tag) && !bad.includes(tag)) bad.push(tag);
  }
  return bad;
}

export interface AnnounceRecipient {
  tenant: string;
  chatId: number;
  /** Public numeric bot identity; the secret is fetched again just before send. */
  botId: string;
  /** `agents.live_blocker` for this tenant, when known. */
  blocker: string | null;
  /** `agents.name` — what the OWNER called it. Null when the join found none. */
  name: string | null;
}

export interface AnnounceOutcome {
  considered: number;
  eligible: number;
  skippedNoChat: number;
  skippedNoToken: number;
  skippedDisabled: number;
  /** Telegram on, but notifications explicitly turned off. Their answer stands. */
  skippedNotifyOff: number;
  /** The chat was removed from the tenant's durable allowlist. */
  skippedNotAllowed: number;
  /** Missing, moved, or invalid bot claim: no tenant may speak through it. */
  skippedNoClaim: number;
  skippedAlreadySent: number;
  /** A previous attempt may have reached Telegram; it must not be replayed. */
  skippedAlreadyAttempted: number;
  /** Settings, chat, or claim changed after recipient resolution. */
  skippedChanged: number;
  /** Eligible, but outside this campaign's tenant allowlist. */
  skippedNotSelected: number;
  /** Selected for a per-agent campaign with no prepared body. Never defaulted. */
  skippedNoBody: number;
  sent: number;
  /** How many messages will carry this agent's own reason. The rest are generic. */
  personalised: number;
  /**
   * HOW MANY HAVE EVER LINKED, from the DURABLE record.
   *
   * `telegramAllowlist` lives in the sealed settings and survives a redeploy;
   * `tenant_telegram.owner_id` is a mirror of an EPHEMERAL child file. When
   * these two disagree, the difference is people whose link was destroyed by a
   * deploy rather than people who never linked — and those need telling to
   * re-link, not telling how to set one up.
   */
  withAllowlist: number;
  /** Tenants holding a bot token at all, counted independently of the chat. */
  withBotToken: number;
  failed: { tenant: string; reason: string }[];
  /**
   * The blocker join failed. An empty blocker map means "nobody is blocked"
   * OR "the query broke", and those are opposite facts — this is how the dry
   * run tells the operator which one they are looking at.
   */
  blockerJoinError: string | null;
  dryRun: boolean;
  /**
   * WHAT A DRY RUN ACTUALLY SHOWS, per recipient.
   *
   * Counters answer "how many" and a per-agent campaign has to be approved on
   * "which text, to whom" — the operator is signing off on three different
   * claims about three different people money. Populated ONLY on a dry run,
   * and deliberately carries no token: the chat is redacted to its last four
   * digits, which is enough to tell two recipients apart and not enough to
   * message anybody.
   */
  preview: { tenant: string; name: string | null; blocker: string | null; chatRedacted: string; chars: number; body: string }[];
}

export const ANNOUNCE_DDL = `
  CREATE TABLE IF NOT EXISTS announcements (
    announce_id TEXT NOT NULL,
    tenant TEXT NOT NULL,
    sent_at BIGINT NOT NULL,
    PRIMARY KEY (announce_id, tenant)
  );`;

/** A pre-send claim closes the crash window between Telegram and `announcements`. */
export const ANNOUNCE_ATTEMPTS_DDL = `
  CREATE TABLE IF NOT EXISTS announcement_attempts (
    announce_id TEXT NOT NULL,
    tenant TEXT NOT NULL,
    claimed_at BIGINT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (announce_id, tenant)
  );`;

async function ensureAnnouncementAttempts(client: PgClientLike): Promise<void> {
  try {
    await client.query(ANNOUNCE_ATTEMPTS_DDL);
  } catch (e) {
    // Two orchestrator replicas may run the one-shot on the same deployment.
    // Postgres can report a catalog conflict even for IF NOT EXISTS when both
    // create a table concurrently. Accept only a table that now exists.
    if (!["23505", "42P07", "42710"].includes(String((e as { code?: unknown } | null)?.code))) throw e;
    const probe = await client.query("SELECT to_regclass('announcement_attempts') AS table_name");
    if (!probe.rows[0]?.table_name) throw e;
  }
}

/** The outage notice has no cached per-agent status line. */
export const RECOVERY_ANNOUNCE_ID = "recovery-2026-10-01";

/** Approve the exact source body or prepared-body set, rather than a reusable campaign name.
 * Older generic campaigns may append a live blocker line after this digest;
 * the recovery campaign disables that line, so its digest covers all sent text.
 */
export function announcementConfirmation(
  announceId: string,
  payload: string,
  confirmId: string | undefined,
  confirmBodySha256: string | undefined,
): { confirmed: boolean; bodySha256: string } {
  const bodySha256 = createHash("sha256").update(payload).digest("hex");
  return {
    bodySha256,
    confirmed: confirmId === announceId && confirmBodySha256 === bodySha256,
  };
}

/**
 * Who would receive this, with what.
 *
 * Deliberately a separate step from sending: the dry run and the real run
 * resolve recipients through the SAME code, so what the operator approves is
 * what goes out. A dry run that took a different path would be theatre.
 */
export async function resolveRecipients(
  client: PgClientLike,
  out: Omit<AnnounceOutcome, "sent" | "failed" | "dryRun">,
  store: SettingsReader = getSettingsStore(),
): Promise<AnnounceRecipient[]> {
  const tenants = await store.listTenants();
  out.considered = tenants.length;

  // One query rather than one per tenant. `owner_id` is the chat of whoever
  // ran /link first; `link_code` in the same table is a BEARER CREDENTIAL and
  // is deliberately NOT selected.
  const chats = new Map<string, { chatId: number; botId: string | null }>();
  const { rows } = await client.query(
    `SELECT tenant, owner_id, bot_id FROM tenant_telegram WHERE owner_id IS NOT NULL`,
  );
  for (const r of rows) chats.set(String(r.tenant).toLowerCase(), {
    chatId: Number(r.owner_id), botId: typeof r.bot_id === "string" ? r.bot_id : null,
  });

  // The claim is authoritative. A copied token can remain in another tenant's
  // sealed settings after its bot was moved; sending through that copy would
  // speak to the wrong owner's linked chat. Missing claims fail closed too.
  const claims = new Map<string, string>();
  const claimRows = await client.query(`SELECT bot_id, tenant FROM telegram_bot_claims`);
  for (const r of claimRows.rows) claims.set(String(r.bot_id), String(r.tenant).toLowerCase());

  // THE PER-AGENT REASON — and the join that carries it.
  //
  // `agents` is keyed by `smart_account` and has NO `tenant` column. The first
  // draft queried one anyway; Postgres threw, a bare `catch {}` swallowed it,
  // and every single message would have lost its personalised line while the
  // run reported a clean success. A total failure of the one thing that makes
  // sending through people's own bots worth doing, dressed as "no blockers
  // known" — the empty-vs-unavailable trap, in the place it costs most.
  //
  // `grants` IS keyed by tenant and carries the account, so it is the index
  // between the two. Same expression the orchestrator and grant-store already
  // use (`grant_json->>'smartAccount'`), and deliberately NOT
  // `agents.owner_address`: web/src/lib/agent-for.ts records that matching a
  // tenant against owner_address returns zero rows for every hosted tenant,
  // because the hosted grant owner is a browser-generated key.
  //
  // A tenant with no `grants` row has no live grant — killed, or never armed —
  // and drops out of the join, which is also the right answer for whether to
  // message them at all.
  const blockers = new Map<string, string>();
  // THE AGENT'S NAME, from the same join and for the same reason.
  //
  // A message addressed to "your agent" reads like a mailshot; one that names
  // the agent its owner named reads like it is about them. Resolved SERVER-SIDE
  // here rather than typed into a campaign file, because a name typed by hand is
  // a name that can be wrong, and being wrong about which agent you are
  // describing is worse than not naming it.
  const names = new Map<string, string>();
  try {
    const b = await client.query(
      `SELECT g.tenant AS tenant, a.live_blocker AS live_blocker, a.name AS name
         FROM grants g
         JOIN agents a ON LOWER(a.smart_account) = LOWER(g.grant_json->>'smartAccount')`,
    );
    for (const r of b.rows) {
      const key = String(r.tenant).toLowerCase();
      if (r.live_blocker !== null && r.live_blocker !== undefined) {
        blockers.set(key, String(r.live_blocker));
      }
      if (r.name) names.set(key, String(r.name));
    }
  } catch (e) {
    // NOT swallowed. A failed join and an unblocked fleet produce the same
    // empty map, and the operator must be able to tell them apart BEFORE
    // sending — which is exactly what the dry run is for.
    out.blockerJoinError = e instanceof Error ? e.message : String(e);
  }

  const recipients: AnnounceRecipient[] = [];
  for (const tenant of tenants) {
    const key = tenant.toLowerCase();
    // READ SETTINGS FIRST, and count the two durable facts unconditionally.
    //
    // The skip counters below are ORDERED — chat before token — so a tenant
    // dropped at the first test was never examined for the second, and
    // "0 no bot" meant "nobody got that far", not "everybody has one". That
    // reading cost a wrong conclusion about the whole fleet.
    const s = await store.get(tenant);
    if (s?.telegramBotToken) out.withBotToken += 1;
    if (Array.isArray(s?.telegramAllowlist) && s.telegramAllowlist.length > 0) out.withAllowlist += 1;

    const chat = chats.get(key);
    if (!chat || !Number.isSafeInteger(chat.chatId) || chat.chatId <= 0) {
      out.skippedNoChat += 1;
      continue;
    }
    if (!s?.telegramBotToken) {
      out.skippedNoToken += 1;
      continue;
    }
    // Their setting, not ours. An owner who switched the bot off has said what
    // they want; a platform announcement does not outrank that.
    if (s.telegramEnabled !== true) {
      out.skippedDisabled += 1;
      continue;
    }
    // THE OPT-OUT THAT EXISTS FOR EXACTLY THIS KIND OF MESSAGE. An owner who
    // left the bot on for commands but turned pushes OFF has already said they
    // do not want us starting conversations. A platform announcement is the
    // most literal instance of the thing they declined, not an exception to it.
    if (s.telegramNotifyEnabled === false) {
      out.skippedNotifyOff += 1;
      continue;
    }
    if (!Array.isArray(s.telegramAllowlist) || !s.telegramAllowlist.includes(chat.chatId)) {
      out.skippedNotAllowed += 1;
      continue;
    }
    const botId = botIdOf(s.telegramBotToken);
    if (!botId || claims.get(botId) !== key || chat.botId !== botId) {
      out.skippedNoClaim += 1;
      continue;
    }
    recipients.push({
      tenant: key,
      chatId: chat.chatId,
      botId,
      blocker: blockers.get(key) ?? null,
      name: names.get(key) ?? null,
    });
  }
  out.eligible = recipients.length;
  return recipients;
}

/**
 * The one line that makes this worth sending through their own bot rather than
 * posting in a group: THIS agent's actual reason.
 *
 * Absent when we do not know. A confident-sounding "everything looks fine" for
 * an agent whose blocker simply was not recorded would be worse than silence.
 */
export function personalLine(blocker: string | null): string {
  if (!blocker) return "";
  const said = liveBlockerText(blocker as never) || blocker;
  return (
    `\n\n<b>Your agent, right now:</b> ${esc(said)}\n` +
    `Open <b>app.merrymen.dev</b> — the banner on your agent names the button.`
  );
}

export async function runAnnouncement(opts: {
  client: PgClientLike;
  announceId: string;
  body: string;
  confirmed: boolean;
  /** Service updates can omit a cached agent blocker that may no longer be current. */
  appendPersonalLine?: boolean;
  /**
   * ONE FULLY-RESOLVED MESSAGE PER TENANT, keyed by lowercased tenant.
   *
   * A campaign that tells three owners three different things cannot be one
   * body plus a canned line — "your agent has no trading money" and "your agent
   * is fine, the market is shut" are not variations of a sentence. So the
   * caller may hand over the finished text per recipient instead.
   *
   * DIAGNOSIS DOES NOT LIVE HERE. Whatever is in these strings — balances,
   * statuses, next steps — was computed by the caller before this ran. This
   * module talks to Postgres and Telegram and to nothing else; it has no RPC,
   * no chain, and no opinion about what an agent's problem is. Keeping that
   * boundary is why a bad diagnosis can never become a bad send.
   *
   * A SELECTED TENANT WITH NO ENTRY IS SKIPPED, never defaulted. Falling back
   * to `body` would mail one owner another owner's circumstances, which on a
   * per-agent campaign is worse than silence.
   */
  bodies?: Record<string, string>;
  /**
   * Restrict this campaign to these tenants. Absent means everyone eligible,
   * which is the existing behaviour.
   */
  tenants?: string[];
  /** Injected in tests; the real sender otherwise. */
  send?: typeof sendMessage;
  /** Injected in tests; the sealed per-tenant store otherwise. */
  store?: SettingsReader;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AnnounceOutcome> {
  const out: AnnounceOutcome = {
    considered: 0,
    eligible: 0,
    skippedNoChat: 0,
    skippedNoToken: 0,
    skippedDisabled: 0,
    skippedNotifyOff: 0,
    skippedNotAllowed: 0,
    skippedNoClaim: 0,
    skippedAlreadySent: 0,
    skippedAlreadyAttempted: 0,
    skippedChanged: 0,
    skippedNotSelected: 0,
    skippedNoBody: 0,
    sent: 0,
    personalised: 0,
    withAllowlist: 0,
    withBotToken: 0,
    failed: [],
    blockerJoinError: null,
    dryRun: !opts.confirmed,
    preview: [],
  };
  await opts.client.query(ANNOUNCE_DDL);
  await ensureAnnouncementAttempts(opts.client);
  const already = new Set<string>();
  const prior = await opts.client.query(
    `SELECT tenant FROM announcements WHERE announce_id = $1`,
    [opts.announceId],
  );
  for (const r of prior.rows) already.add(String(r.tenant).toLowerCase());
  const attempted = new Set<string>();
  const attempts = await opts.client.query(
    `SELECT tenant FROM announcement_attempts WHERE announce_id = $1`,
    [opts.announceId],
  );
  for (const r of attempts.rows) attempted.add(String(r.tenant).toLowerCase());

  const store = opts.store ?? getSettingsStore();
  const recipients = await resolveRecipients(opts.client, out, store);
  const send = opts.send ?? sendMessage;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // The campaign allowlist, applied AFTER resolution so the skip counters above
  // still describe the whole fleet — "3 eligible" would otherwise read as "the
  // fleet has 3 linked owners", which is a different and alarming claim.
  const only = opts.tenants ? new Set(opts.tenants.map((t) => t.toLowerCase())) : null;

  for (const r of recipients) {
    if (only && !only.has(r.tenant)) {
      out.skippedNotSelected += 1;
      continue;
    }
    if (already.has(r.tenant)) {
      out.skippedAlreadySent += 1;
      continue;
    }
    if (attempted.has(r.tenant)) {
      out.skippedAlreadyAttempted += 1;
      continue;
    }
    // A PREPARED BODY WINS, AND ITS ABSENCE IS A REFUSAL.
    //
    // `opts.bodies` present means this is a per-agent campaign, so every
    // selected recipient must have their own text. Falling through to
    // `opts.body` here would send one owner a message written about somebody
    // else's agent — the one failure this whole feature exists to avoid.
    const prepared = opts.bodies ? opts.bodies[r.tenant] : undefined;
    if (opts.bodies && !prepared) {
      out.skippedNoBody += 1;
      continue;
    }
    const includePersonal = opts.appendPersonalLine !== false;
    const text = prepared ?? opts.body + (includePersonal ? personalLine(r.blocker) : "");
    // A prepared body already carries its own reason; the canned line would
    // only repeat it, worse.
    if (!prepared && includePersonal && r.blocker) out.personalised += 1;
    if (out.dryRun) {
      out.sent += 1;
      out.preview.push({
        tenant: r.tenant,
        name: r.name,
        blocker: r.blocker,
        chatRedacted: `…${String(r.chatId).slice(-4)}`,
        chars: text.length,
        body: text,
      });
      continue;
    }
    // A settings save may revoke consent or replace the token while this pass
    // works through other tenants. Re-read it for this recipient, then reserve
    // the send with one Postgres statement checking the CURRENT claim and chat.
    const fresh = await store.get(r.tenant as `0x${string}`);
    const token = fresh?.telegramBotToken;
    if (!token || botIdOf(token) !== r.botId || fresh.telegramEnabled !== true ||
        fresh.telegramNotifyEnabled === false || !fresh.telegramAllowlist?.includes(r.chatId)) {
      out.skippedChanged += 1;
      continue;
    }
    const claimed = await opts.client.query(
      `INSERT INTO announcement_attempts (announce_id, tenant, claimed_at, state)
       SELECT $1, $2, $5, 'claimed'
       WHERE EXISTS (SELECT 1 FROM telegram_bot_claims WHERE bot_id = $3 AND LOWER(tenant) = $2)
         AND EXISTS (SELECT 1 FROM tenant_telegram WHERE tenant = $2 AND owner_id = $4 AND bot_id = $3)
         AND NOT EXISTS (SELECT 1 FROM announcements WHERE announce_id = $1 AND tenant = $2)
       ON CONFLICT DO NOTHING RETURNING tenant`,
      [opts.announceId, r.tenant, r.botId, r.chatId, Math.floor(Date.now() / 1000)],
    );
    if (claimed.rows.length !== 1) {
      out.skippedChanged += 1;
      continue;
    }
    // Settings live outside this SQL transaction. One last read narrows the
    // remaining save-to-send race and refuses if consent or token changed.
    const final = await store.get(r.tenant as `0x${string}`);
    if (final?.telegramBotToken !== token || final.telegramEnabled !== true ||
        final.telegramNotifyEnabled === false || !final.telegramAllowlist?.includes(r.chatId)) {
      out.skippedChanged += 1;
      await opts.client.query(
        `UPDATE announcement_attempts SET state = 'aborted' WHERE announce_id = $1 AND tenant = $2`,
        [opts.announceId, r.tenant],
      );
      continue;
    }
    const finalDb = await opts.client.query(
      `SELECT
         EXISTS (SELECT 1 FROM telegram_bot_claims WHERE bot_id = $1 AND LOWER(tenant) = $2) AS bot_owned,
         EXISTS (SELECT 1 FROM tenant_telegram WHERE tenant = $2 AND bot_id = $1 AND owner_id = $3) AS chat_current`,
      [r.botId, r.tenant, r.chatId],
    );
    if (finalDb.rows[0]?.bot_owned !== true || finalDb.rows[0]?.chat_current !== true) {
      out.skippedChanged += 1;
      await opts.client.query(
        `UPDATE announcement_attempts SET state = 'aborted' WHERE announce_id = $1 AND tenant = $2`,
        [opts.announceId, r.tenant],
      );
      continue;
    }
    let res: Awaited<ReturnType<typeof send>>;
    try {
      res = await send({ token }, r.chatId, text);
    } catch {
      // A transport failure can arrive after Telegram accepted the message.
      // Keep the claim; an operator can investigate instead of replaying it.
      out.failed.push({ tenant: r.tenant, reason: "send outcome unknown" });
      await opts.client.query(
        `UPDATE announcement_attempts SET state = 'uncertain' WHERE announce_id = $1 AND tenant = $2`,
        [opts.announceId, r.tenant],
      );
      await sleep(SEND_GAP_MS);
      continue;
    }
    if (res.ok) {
      out.sent += 1;
      await opts.client.query(
        `INSERT INTO announcements (announce_id, tenant, sent_at) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
        [opts.announceId, r.tenant, Math.floor(Date.now() / 1000)],
      );
      await opts.client.query(
        `UPDATE announcement_attempts SET state = 'sent' WHERE announce_id = $1 AND tenant = $2`,
        [opts.announceId, r.tenant],
      );
    } else {
      // sendMessage never throws — a blocked user, a deleted chat or a revoked
      // token comes back as {ok:false}. Collected, because otherwise nobody
      // ever learns who did not receive it.
      out.failed.push({ tenant: r.tenant, reason: res.reason?.replaceAll(token, "[redacted]") ?? "unknown" });
      await opts.client.query(
        `UPDATE announcement_attempts SET state = 'uncertain' WHERE announce_id = $1 AND tenant = $2`,
        [opts.announceId, r.tenant],
      );
    }
    await sleep(SEND_GAP_MS);
  }
  return out;
}
