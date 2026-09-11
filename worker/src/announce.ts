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
import { getSettingsStore } from "./settings-store";
import { esc, sendMessage } from "./telegram/api";
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
  /** Present only in memory, never returned, logged or persisted. */
  token: string;
  /** `agents.live_blocker` for this tenant, when known. */
  blocker: string | null;
}

export interface AnnounceOutcome {
  considered: number;
  eligible: number;
  skippedNoChat: number;
  skippedNoToken: number;
  skippedDisabled: number;
  /** Telegram on, but notifications explicitly turned off. Their answer stands. */
  skippedNotifyOff: number;
  skippedAlreadySent: number;
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
}

export const ANNOUNCE_DDL = `
  CREATE TABLE IF NOT EXISTS announcements (
    announce_id TEXT NOT NULL,
    tenant TEXT NOT NULL,
    sent_at BIGINT NOT NULL,
    PRIMARY KEY (announce_id, tenant)
  );`;

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
  const chats = new Map<string, number>();
  const { rows } = await client.query(
    `SELECT tenant, owner_id FROM tenant_telegram WHERE owner_id IS NOT NULL`,
  );
  for (const r of rows) chats.set(String(r.tenant).toLowerCase(), Number(r.owner_id));

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
  try {
    const b = await client.query(
      `SELECT g.tenant AS tenant, a.live_blocker AS live_blocker
         FROM grants g
         JOIN agents a ON LOWER(a.smart_account) = LOWER(g.grant_json->>'smartAccount')
        WHERE a.live_blocker IS NOT NULL`,
    );
    for (const r of b.rows) blockers.set(String(r.tenant).toLowerCase(), String(r.live_blocker));
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

    const chatId = chats.get(key);
    if (chatId === undefined) {
      out.skippedNoChat += 1;
      continue;
    }
    if (!s?.telegramBotToken) {
      out.skippedNoToken += 1;
      continue;
    }
    // Their setting, not ours. An owner who switched the bot off has said what
    // they want; a platform announcement does not outrank that.
    if (s.telegramEnabled === false) {
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
    recipients.push({
      tenant: key,
      chatId,
      token: s.telegramBotToken,
      blocker: blockers.get(key) ?? null,
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
    skippedAlreadySent: 0,
    sent: 0,
    personalised: 0,
    withAllowlist: 0,
    withBotToken: 0,
    failed: [],
    blockerJoinError: null,
    dryRun: !opts.confirmed,
  };
  await opts.client.query(ANNOUNCE_DDL);
  const already = new Set<string>();
  const prior = await opts.client.query(
    `SELECT tenant FROM announcements WHERE announce_id = $1`,
    [opts.announceId],
  );
  for (const r of prior.rows) already.add(String(r.tenant).toLowerCase());

  const recipients = await resolveRecipients(opts.client, out, opts.store ?? getSettingsStore());
  const send = opts.send ?? sendMessage;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (const r of recipients) {
    if (already.has(r.tenant)) {
      out.skippedAlreadySent += 1;
      continue;
    }
    const text = opts.body + personalLine(r.blocker);
    if (r.blocker) out.personalised += 1;
    if (out.dryRun) {
      out.sent += 1;
      continue;
    }
    const res = await send({ token: r.token }, r.chatId, text);
    if (res.ok) {
      out.sent += 1;
      // Recorded IMMEDIATELY, per recipient. Batching this at the end means a
      // crash halfway re-sends to everyone already reached.
      await opts.client.query(
        `INSERT INTO announcements (announce_id, tenant, sent_at) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
        [opts.announceId, r.tenant, Math.floor(Date.now() / 1000)],
      );
    } else {
      // sendMessage never throws — a blocked user, a deleted chat or a revoked
      // token comes back as {ok:false}. Collected, because otherwise nobody
      // ever learns who did not receive it.
      out.failed.push({ tenant: r.tenant, reason: res.reason ?? "unknown" });
    }
    await sleep(SEND_GAP_MS);
  }
  return out;
}
