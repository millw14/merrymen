/**
 * get_attention: everything that needs the owner, across the agents shared
 * with this connection, in one read.
 *
 * For an assistant that checks in by itself (Claude Duet's periodic checks and
 * morning brief): one call instead of status, controls, proposals and alert
 * deliveries per agent, with severities and keys it can act on without
 * re-deriving them. The rules live in lib/services/attention.ts; this adapter
 * picks what the connection may see and says what it could not.
 */
import * as z from "zod";
import {
  EVENT_KINDS, KEY_RE, SEVERITIES, SEVERITY_MEANING, conditionOfKey, deliveryItems, proposalItems, rankItems, readAgentAttention,
  type AttentionKind,
  type AttentionItem, type AttentionLinks, type Severity,
} from "@/lib/services/attention";
import { connectionStanding, KIND_CAPABILITY, liveAwaitingRows, MAX_OPEN_PROPOSALS, type ProposalKind } from "@/lib/services/proposals";
import { settingsReader } from "@/lib/services/settings-view";
import { mcpConfig } from "../config";
import { hasCapability } from "../policy";
import { scopeFor, type Capability } from "../scopes";
import { defineTool } from "../tool";
import { approvalUrl } from "./proposals";
import { AGENT_ARG, isoOrNull, untrusted } from "./shared";

/** What the owner calls each scope's proposals, for not_checked. */
const PROPOSAL_SCOPES: ReadonlyArray<{ capability: Capability; what: string }> = [
  { capability: "trade.propose", what: "trade proposals" },
  { capability: "drafts.write", what: "settings proposals and agent setup drafts" },
  { capability: "social.write", what: "post drafts" },
];
/** Live waiting proposals read per call: creation refuses more than MAX_OPEN_PROPOSALS, so a full page means something raced past it. */
const PROPOSALS_MAX = 2 * MAX_OPEN_PROPOSALS;
const MAX_SEEN = 100;
const DAY = 86_400;

const SEVERITY = z.enum(["act_now", "today", "fyi"]);
const COUNTS = z.object({ act_now: z.number(), today: z.number(), fyi: z.number() });

const ITEM = z.object({
  key: z.string().describe("Stable while the condition and its severity hold; a rise in severity is a new key"),
  severity: SEVERITY,
  kind: z.string().describe("no-permission, permission-expired, permission-expiring, live-blocker, breaker, worker-stale, arm-error, killed, daily-cap, ops-cap, provider-failure, proposal-waiting, alerts-failing or recovery-hold"),
  agent: z.string().nullable().describe("Agent id, or null for an item about the owner's account as a whole"),
  agent_name: z.string().nullable().describe("The agent's name (owner-chosen text)"),
  title: z.string(),
  detail: z.string(),
  owner_can_fix: z.boolean().describe("False when only Merrymen can fix it, or when it is a signed limit doing its job"),
  what_to_do: z.string().nullable(),
  link: z.string().nullable().describe("The Merrymen page where the owner does it; acting there needs the owner's own sign-in, and their wallet for a permission"),
  started_at: z.string().nullable().describe("When the condition began or reached this severity; null when no record says"),
  ends_at: z.string().nullable().describe("When it lapses by itself, such as a proposal's or a permission's expiry"),
  new: z.boolean().describe("False when its key was among seen_keys"),
});

const getAttention = defineTool({
  name: "get_attention",
  title: "What needs the owner",
  description: "Everything that needs the owner across the agents shared with this connection, in one read: a trading permission that has expired or expires soon, a live-trading blocker (no ETH for fees, no USDG, a permission that cannot reach the chain), a tripped drawdown breaker, a worker that stopped reporting, the kill switch, a reached daily cap, failing data or model providers, proposals waiting for approval and undelivered Telegram alerts. Each item has a severity (act_now, today or fyi) with a fixed meaning, a stable key, what the owner can do and a link to the Merrymen page that does it. Given the keys from an earlier answer, it marks which items are new and lists the ones that have resolved. Read-only: nothing here trades, approves, renews or changes anything.",
  capability: "agents.read",
  input: z.object({
    agent: AGENT_ARG.describe("Limit the check to one agent shared with this connection. Without it, every shared agent is checked."),
    seen_keys: z.array(z.string().regex(KEY_RE, "a key from an earlier get_attention answer")).max(MAX_SEEN).optional()
      .describe("Keys of items already brought to the owner, from earlier answers. Items with these keys come back with new: false, and those no longer open come back in resolved_keys."),
  }).strict(),
  output: z.object({
    items: z.array(ITEM).describe("Most severe first; within a severity, new before already seen, then the most recent first"),
    counts: COUNTS,
    new_counts: COUNTS,
    resolved_keys: z.array(z.string()).describe("Keys from seen_keys whose condition no longer holds: renewed, funded, recovered, approved or lapsed. A key replaced by a more severe one for the same condition is not resolved"),
    severity_meaning: z.object({ act_now: z.string(), today: z.string(), fyi: z.string() }),
    agents_checked: z.array(z.string()),
    not_checked: z.array(z.object({
      part: z.string(),
      why: z.string(),
      scope: z.string().nullable().describe("The scope that would let this connection see it, or null when no scope can (a read that was cut, the directory listing)"),
    })).describe("What this read could not look at, and why; an absent item there is unknown, not fine"),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ agent: ref, seen_keys }, ctx) {
    const now = ctx.now();
    const issuer = mcpConfig().issuer;
    // Fixed paths on the configured issuer; nothing a client sent enters a link.
    const link = (path: string) => (issuer ? new URL(path, issuer).href : null);
    const links: AttentionLinks = { grant: link("/grant"), deposit: link("/deposit"), settings: link("/settings") };
    const agents = ref !== undefined ? [await ctx.agent(ref)] : await ctx.agents();
    const slugs = new Set(agents.map((a) => a.slug));
    const settings = await settingsReader().settingsFor(ctx.principal.tenant);
    const notChecked: Array<{ part: string; why: string; scope: string | null }> = [];
    if (!agents.length) notChecked.push({ part: "agents", why: "No agent is shared with this connection.", scope: null });

    const names = new Map<string, string | null>();
    const items: AttentionItem[] = [];
    const eventsCut = new Set<string>();
    const held = new Set<string>();
    const holdUnread = new Set<string>();
    await ctx.ledger(async (db) => {
      for (const a of agents) {
        const r = await readAgentAttention(db, {
          slug: a.slug, tenant: ctx.principal.tenant, chainId: a.chainId, account: a.account, accounts: a.accounts,
          grantedAt: a.grantedAt, expiresAt: a.expiresAt, settings, now, links,
        });
        if (r.held) held.add(a.slug);
        if (r.holdUnread) {
          holdUnread.add(a.slug);
          notChecked.push({ part: `recovery hold of agent ${a.slug}`, why: "Its recovery report could not be read, so it was judged as if it were not held.", scope: null });
        }
        names.set(a.slug, untrusted(r.name, 64));
        items.push(...r.items);
        if (r.eventsCut) {
          eventsCut.add(a.slug);
          notChecked.push({ part: `older warnings of agent ${a.slug}`, why: "More warnings and errors were recorded in the last day than one read takes; only the newest were read, so an older breaker, provider or arm-failure sighting may be missing.", scope: null });
        }
      }
    });

    // Proposals: only the kinds this connection may see, about agents it was
    // given, from apps that still stand behind them. Read, never expired here.
    // Each kind is checked or not on its own: holding social:write says
    // nothing about trade proposals, which stay unknown.
    const kindChecked = (kind: string) => Object.hasOwn(KIND_CAPABILITY, kind) && hasCapability(ctx.principal, KIND_CAPABILITY[kind as ProposalKind]);
    let proposalsCut = false;
    if (PROPOSAL_SCOPES.some((s) => hasCapability(ctx.principal, s.capability))) {
      const d = await ctx.mcp();
      const rows = await liveAwaitingRows(d.db, ctx.principal.tenant, now, PROPOSALS_MAX);
      // A full page may have left an open proposal unread: none of its seen keys can resolve.
      proposalsCut = rows.length >= PROPOSALS_MAX;
      if (proposalsCut) notChecked.push({ part: "older waiting proposals", why: `More proposals are waiting than one read takes (${PROPOSALS_MAX}); only the newest were read, and Merrymen lists them all.`, scope: null });
      const waiting = [];
      for (const r of rows) {
        if (!kindChecked(r.kind)) continue;
        if (r.agent_slug === null ? ref !== undefined : !slugs.has(r.agent_slug)) continue;
        if (!(await connectionStanding(d.db, r)).ok) continue;
        waiting.push({ id: r.id, kind: r.kind, agent_slug: r.agent_slug, created_at: r.created_at, expires_at: r.expires_at, approval_url: issuer ? approvalUrl(r.id) : null });
      }
      items.push(...proposalItems(waiting));
    }
    if ((ctx.principal.profile ?? "full") === "directory") {
      notChecked.push({ part: "proposals", why: "The connector-directory listing never sees proposals; they are listed in Merrymen.", scope: null });
    } else {
      for (const s of PROPOSAL_SCOPES) {
        if (!hasCapability(ctx.principal, s.capability)) notChecked.push({ part: s.what, why: `Seeing them needs the ${scopeFor(s.capability)} scope.`, scope: scopeFor(s.capability) });
      }
    }

    // Alert messages to the owner's Telegram that died in the last day, and
    // those skipped because no Telegram is linked (the owner asked for alerts
    // and has nowhere to receive them). A skip because the owner switched
    // alerts off is their choice, and a removed subscription is not asked about.
    const alertsChecked = hasCapability(ctx.principal, "notifications.manage");
    if (alertsChecked) {
      const d = await ctx.mcp();
      const reach = [...slugs];
      const where = ["d.tenant = ?", "s.tenant = d.tenant", "s.status = 'active'",
        "(d.status = 'dead' OR (d.status = 'skipped' AND d.last_error_code = 'no_linked_telegram'))", "d.created_at >= ?",
        ref !== undefined
          ? `s.agent_slug IN (${reach.map(() => "?").join(", ")})`
          : reach.length ? `(s.agent_slug IS NULL OR s.agent_slug IN (${reach.map(() => "?").join(", ")}))` : "s.agent_slug IS NULL"];
      const params = [ctx.principal.tenant.toLowerCase(), now - DAY, ...reach];
      const dead = await d.db.prepare(`SELECT COUNT(*) AS n, MIN(d.created_at) AS first FROM notify_deliveries d JOIN notify_subscriptions s ON s.id = d.subscription_id WHERE ${where.join(" AND ")}`)
        .get(...params) as { n: number | string; first: number | string | null } | undefined;
      const count = Number(dead?.n ?? 0);
      if (count > 0 && dead?.first != null) {
        const last = await d.db.prepare(`SELECT d.last_error_code AS code FROM notify_deliveries d JOIN notify_subscriptions s ON s.id = d.subscription_id WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC LIMIT 1`)
          .get(...params) as { code: string | null } | undefined;
        items.push(...deliveryItems({ count, first: Number(dead.first), lastErrorCode: last?.code ?? null }, links, ref !== undefined ? agents[0]!.slug : null));
      }
    } else {
      notChecked.push({ part: "alert deliveries", why: "Seeing whether alerts reached Telegram needs the notifications:manage scope.", scope: "notifications:manage" });
    }

    const seen = new Set(seen_keys ?? []);
    const ranked = rankItems(items.map((i) => ({ ...i, new: !seen.has(i.key) })));
    // A seen key resolves only when its condition is gone, not when a more
    // severe key for the same condition replaced it, and only if this read
    // looked where it lives: a key about an agent not checked, or a part (or
    // proposal kind) this connection cannot see, stays unknown.
    const openConditions = new Set(ranked.map((i) => conditionOfKey(i.key)));
    const looked = (key: string) => {
      const [kind, agent = "", rest = ""] = key.split(":");
      if (kind === "alerts-failing") return alertsChecked && (agent === "-" ? ref === undefined : slugs.has(agent));
      if (EVENT_KINDS.has(kind as AttentionKind) && eventsCut.has(agent)) return false;
      if (kind === "proposal-waiting") return !proposalsCut && kindChecked(rest.split(".")[0]!) && (agent === "-" ? ref === undefined : slugs.has(agent));
      // A held agent was judged on its hold alone: its other conditions are unknown, not gone.
      if (held.has(agent) && kind !== "recovery-hold") return false;
      // An unreadable recovery report says nothing about whether a hold lifted.
      if (kind === "recovery-hold" && holdUnread.has(agent)) return false;
      return slugs.has(agent);
    };
    const resolved = [...seen].filter((k) => !openConditions.has(conditionOfKey(k)) && looked(k));

    const count = (pick: (i: (typeof ranked)[number]) => boolean) =>
      Object.fromEntries(SEVERITIES.map((s) => [s, ranked.filter((i) => i.severity === s && pick(i)).length])) as Record<Severity, number>;
    const counts = count(() => true);
    const newCounts = count((i) => i.new);
    const summary = ranked.length
      ? `${counts.act_now} to act on now, ${counts.today} for today, ${counts.fyi} FYI${seen_keys ? `; ${ranked.filter((i) => i.new).length} new, ${resolved.length} resolved` : ""}.`
      : `Nothing needs the owner${agents.length ? "" : " (no agent is shared with this connection)"}.`;
    return {
      data: {
        items: ranked.map((i) => ({
          key: i.key, severity: i.severity, kind: i.kind, agent: i.agent, agent_name: i.agent ? names.get(i.agent) ?? null : null,
          title: i.title, detail: i.detail, owner_can_fix: i.owner_can_fix, what_to_do: i.what_to_do, link: i.link,
          started_at: isoOrNull(i.started_at), ends_at: isoOrNull(i.ends_at), new: i.new,
        })),
        counts,
        new_counts: newCounts,
        resolved_keys: resolved,
        severity_meaning: { ...SEVERITY_MEANING },
        agents_checked: [...slugs],
        not_checked: notChecked,
        observed_at: new Date(now * 1000).toISOString(),
      },
      summary,
    };
  },
});

export const ATTENTION_TOOLS = [getAttention];
