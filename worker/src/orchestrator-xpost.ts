/**
 * POSTING ON X, FROM THE ORCHESTRATOR — the glue between the room's pieces and
 * worker/src/xpost/ (docs/x-posting.md).
 *
 * WHY THE GLUE LIVES HERE. xpost/ never imports the group room (its
 * boundary.test.ts, and the room's, pin that): X is not in the room and the
 * room is not on the X path. But the room already owns exactly what an X post
 * needs to know about an agent — its facts (name, mode, strategy, traits, the
 * landed or paper calls that passed publishableThesis), its typing style, the
 * owner's zone and sleep window, the agent-line gate, and a dedicated model
 * key. orchestrator*.ts is the one place allowed to hold both, so this file
 * reads the room's pieces and hands xpost/ plain data and functions:
 *
 *   - loadFacts           → the planner's calls and the writer's facts
 *   - styleFor            → the writer's style (lowercase, emoji, "!")
 *   - getMember + clock   → the owner's zone, local day, afternoon and night
 *   - admitAgentLine      → the base gate admitXPost runs first
 *   - STRATEGY_SPOKEN, STRATEGY_FLAVOUR, TRAIT_VOICE → the writer's words for how the agent trades
 *   - SUBJECTS/TAKES/MUSINGS → a casual post's seed, to riff on, never copy
 *   - groupChatCreds      → the writer's fallback key when X has none of its own
 *
 * ONE STEP, TWO HALVES, NEVER A THROW. `step` first SENDS what is due (every
 * pass), then PLANS (at most once a minute): drafts each intent with the
 * model, gates it, and writes it scheduled — or writes it skipped, so a buy
 * the gate refused or the model passed on is not drafted again every minute
 * on the model's allowance. Everything is caught; a failure is one log line,
 * deduplicated like the room's. The pass runs un-awaited behind a latch in
 * orchestrator.ts, so a slow X or a slow model costs a post, never a
 * reconcile (rule 6).
 *
 * WHAT IT NEVER DOES: read a decision's reason, a size, a price or a balance
 * (loadFacts has none to give), log a post's body or a token (the summary is
 * counts), post for a tenant whose lease this replica does not hold healthily
 * (the roster is only those), or write anything but xpost_* rows.
 */
import type { Db } from "./db";
import type { llmText } from "./llm";
import { storeDek } from "./store-crypto";
import { loadFacts, type AgentFacts, type ChatProfile, type RosterEntry } from "./groupchat/facts";
import { admitAgentLine } from "./groupchat/policy";
import { groupChatCreds, styleFor, type LlmCreds } from "./groupchat/voice";
import { isAsleep, localDay, localMinutes } from "./groupchat/clock";
import { ensureGroupchatSchema, getMember } from "./groupchat/store";
import { STRATEGY_FLAVOUR, STRATEGY_SPOKEN, TRAIT_VOICE } from "./groupchat/templates";
import { MUSINGS, SUBJECTS, TAKES } from "./groupchat/topics";
import { xAppFromEnv, type FetchLike, type XApp } from "./xpost/client";
import { admitXPost, vocabularyRefusal, type BaseGate, type XGateCtx } from "./xpost/gate";
import { coinOf, hash32, planPosts, sendDecision, type PlanClock, type PlanIntent } from "./xpost/planner";
import { APP_PAUSE_KEY, APP_PAUSE_MS, CREDITS_PAUSE_MS, PAUSE_KEY, sendOne } from "./xpost/sender";
import {
  cancelPost,
  countPostedSince,
  duePosts,
  ensureXpostSchema,
  failInterrupted,
  getAccount,
  introPostsOf,
  postingAccounts,
  postsOf,
  readMeta,
  recentBodies,
  schedulePost,
  skipScheduled,
  takeAllowance,
  type XAccount,
} from "./xpost/store";
import { buyPrompt, casualPrompt, draft, introPrompt, introTemplate, xpostModel, type WriterFacts, type XStyle } from "./xpost/writer";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEFAULT_PER_DAY = 3;
export const DEFAULT_FLEET_PER_DAY = 1000;
export const DEFAULT_LLM_PER_DAY = 400;
/** Plans are drafted at most this often; sends run every pass. */
const PLAN_EVERY_MS = MIN;
/** A `sending` claim older than this belonged to a pass that died mid-call. */
const INTERRUPTED_AFTER_MS = 10 * MIN;
/** Bounds on one pass: each send can wait ten seconds on X, each draft twenty on a model. */
const MAX_DUE = 50;
const MAX_SENDS_PER_PASS = 20;
const MAX_DRAFTS_PER_PASS = 10;
/** What a new draft must not echo: its own account's history, and the fleet's. */
const OWN_MEMORY_MS = 60 * DAY;
const FLEET_MEMORY_MS = 14 * DAY;
const FLEET_MEMORY_MAX = 1000;
/** The planner weighs caps, gaps and the three-day coin fold over this much of an account's history. */
const PLAN_HISTORY_MS = 4 * DAY;
/** Template intros tried with fresh dice before the intro is skipped. */
const TEMPLATE_TRIES = 8;
/** Log counters that describe a standing condition rather than something that happened. */
const CONDITIONS: ReadonlySet<string> = new Set(["no-model-budget", "zone-unreadable", "owner-failed"]);

// ── the knobs ───────────────────────────────────────────────────────────────

/**
 * THE OPERATOR'S KNOBS, read the way they mean them — the room's rules
 * (groupChatEnv) applied to X.
 *
 * SET-BUT-EMPTY IS UNSET: a cleared variable asks for the default back, and
 * Number("") is 0.
 *
 * ZERO POSTS IS OFF, and said so: MERRYMEN_XPOST_PER_DAY=0 or
 * MERRYMEN_XPOST_FLEET_PER_DAY=0 turns posting off rather than failing a
 * `> 0` check and running at the default.
 *
 * AN UNREADABLE VALUE IS SAID OUT LOUD, ONCE — by name, never by value: a key
 * pasted into the wrong variable must not land in the log. The two that SPEND fail closed:
 * an unreadable fleet ceiling (each post costs money) turns posting off, and an
 * unreadable model allowance is none — intro templates only. An unreadable
 * per-owner cadence keeps its default, because the default is the safe one.
 */
export interface XPostEnv {
  /** The boot line saying why posting is off, or null when it runs. */
  off: string | null;
  perDay: number | undefined;
  fleetPerDay: number | undefined;
  llmPerDay: number | undefined;
  /** One boot line per value that was set and could not be honoured as written. */
  notes: string[];
}

export function xpostEnv(env: Record<string, string | undefined> = process.env): XPostEnv {
  const none = { perDay: undefined, fleetPerDay: undefined, llmPerDay: undefined, notes: [] };
  if ((env.MERRYMEN_XPOST ?? "").trim() === "0") {
    return { ...none, off: "xpost: off — MERRYMEN_XPOST=0, so this orchestrator posts nothing on X (owners can still connect)" };
  }
  const notes: string[] = [];
  const count = (raw: string): number | null => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };

  let perDay: number | undefined;
  const dayRaw = env.MERRYMEN_XPOST_PER_DAY?.trim();
  if (dayRaw) {
    const n = count(dayRaw);
    if (n === null) notes.push(`xpost: ignoring MERRYMEN_XPOST_PER_DAY — it is set but is not a count of posts; each owner keeps the default of ${DEFAULT_PER_DAY} a day`);
    else if (n === 0) return { ...none, off: "xpost: off — MERRYMEN_XPOST_PER_DAY=0 allows no posts" };
    else perDay = n;
  }

  let fleetPerDay: number | undefined;
  const fleetRaw = env.MERRYMEN_XPOST_FLEET_PER_DAY?.trim();
  if (fleetRaw) {
    const n = count(fleetRaw);
    if (n === null) {
      return { ...none, off: "xpost: off — MERRYMEN_XPOST_FLEET_PER_DAY is set but is not a count of posts, and every post costs money; nothing is posted until it is" };
    }
    if (n === 0) return { ...none, off: "xpost: off — MERRYMEN_XPOST_FLEET_PER_DAY=0 allows no posts" };
    fleetPerDay = n;
  }

  let llmPerDay: number | undefined;
  const llmRaw = env.MERRYMEN_XPOST_LLM_PER_DAY?.trim();
  if (llmRaw) {
    const n = count(llmRaw);
    if (n === null) {
      llmPerDay = 0;
      notes.push("xpost: MERRYMEN_XPOST_LLM_PER_DAY is set but is not a count of calls — no model calls until it is; only intros are posted, from templates");
    } else {
      llmPerDay = n;
    }
  }
  return { off: null, perDay, fleetPerDay, llmPerDay, notes };
}

/** Everything the orchestrator needs to start posting, decided once, with the lines that say what was decided. */
export interface XPostSetup {
  off: string | null;
  /** Boot lines: why it is off, or the notes and the writer's model. Never a key. */
  lines: string[];
  app: XApp | null;
  dek: Buffer | null;
  knobs: XPostEnv;
  creds: LlmCreds | null;
}

/**
 * IS POSTING ON FOR THIS PROCESS? Off when the operator switched it off, when
 * there is no X app (client id and secret), no shared database, or no DEK to
 * open the sealed tokens with. The writer's model is the X key, or the room's
 * own dedicated key when X has none (groupChatCreds already refuses a fleet key).
 */
export function xpostSetup(env: Record<string, string | undefined> = process.env, dek: Buffer | null = storeDek()): XPostSetup {
  const knobs = xpostEnv(env);
  const off = (why: string): XPostSetup => ({ off: why, lines: [why, ...knobs.notes], app: null, dek: null, knobs, creds: null });
  if (knobs.off) return off(knobs.off);
  const app = xAppFromEnv(env);
  if (!app) return off("xpost: off — the X app is not configured (MERRYMEN_X_CLIENT_ID and its secret are not both set)");
  if (!env.DATABASE_URL?.trim()) return off("xpost: off — no DATABASE_URL, so there is nowhere to keep the connections and posts");
  if (!dek) return off("xpost: off — MERRYMEN_STORE_DEK is not a 32-byte key, so the X tokens cannot be opened");
  const model = xpostModel(env, groupChatCreds(env));
  return { off: null, lines: [...knobs.notes, model.line], app, dek, knobs, creds: model.creds };
}

// ── the poster ──────────────────────────────────────────────────────────────

export interface XPosterDeps {
  /** X, for a test. Default: fetch. */
  fetch?: FetchLike;
  /** The room's facts. Default loadFacts; a test's bare sqlite has no ledger. */
  facts?: typeof loadFacts;
  /** The owner's room membership, for the zone. Default: the room's store. */
  member?: (shared: Db, tenant: string) => Promise<{ tz: string | null } | null>;
  /** The model call. Default llmText (through the writer's draft). */
  llm?: typeof llmText;
  /** The dialect `shared` speaks, for the one-time schema. Default "postgres". */
  dialect?: "postgres" | "sqlite";
  draftTimeoutMs?: number;
}

export interface XPoster {
  plan(): { why: string };
  step(shared: Db, roster: RosterEntry[], profiles: Map<string, ChatProfile>, nowMs: number): Promise<{ log: string | null }>;
}

/** The owner-local clock the room runs on, as the planner asks for it. With no zone, UTC. */
const PLAN_CLOCK: PlanClock = {
  localDay: (tz, ms) => localDay(tz, ms),
  localMinutes: (tz, ms) => localMinutes(tz ?? "UTC", ms),
  isAsleep: (tz, key, ms) => isAsleep(tz, key, ms),
};

/** The room's agent-line gate, as admitXPost's base. */
const BASE_GATE: BaseGate = (raw, ctx) => admitAgentLine(raw, ctx);

/** A deterministic die from a key: the same draw on every replica and after every redeploy. */
function seeded(key: string): () => number {
  let s = hash32(key);
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** A phrase the writer may be shown: no digit, no slot, nothing its own post would be dropped for. */
function usable(s: unknown): s is string {
  return typeof s === "string" && s.trim() !== "" && !/\p{N}/u.test(s) && !/[{}]/.test(s) && vocabularyRefusal(s) === null;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcMidnight(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}

/** The mode a post may state: the agent's own, or none for an agent that is not trading. */
function modeOf(f: AgentFacts): "paper" | "live" | null {
  return f.mode === "idle" ? null : f.mode;
}

/** How the agent types, as the writer is told. A costume from its slug, never a claim about its book. */
function xStyleOf(f: AgentFacts): XStyle {
  const s = styleFor(f.slug ?? f.name);
  return { lower: s.lower, emoji: s.emoji, exclaim: s.exclaim };
}

/**
 * The writer's facts about this agent — words only. The strategy is named only
 * when it is on the publication list (chatProfileOf already nulled the rest);
 * the flavour is said only by an agent that trades (templates.ts); every
 * phrase is screened so the model is never handed a word its post would be
 * dropped for.
 */
function writerFacts(f: AgentFacts, day: string, recentOwn: string[]): WriterFacts {
  const strategy = f.strategy ? (STRATEGY_SPOKEN[f.strategy] ?? null) : null;
  const flavours = strategy && f.mode !== "idle" ? (STRATEGY_FLAVOUR[f.strategy!] ?? []).filter(usable) : [];
  const flavour = flavours.length ? flavours[hash32(`flavour|${f.tenant}|${day}`) % flavours.length]! : null;
  const traits = f.traits.map((t) => TRAIT_VOICE[t]?.[0]).filter(usable).slice(0, 3);
  return { agentName: f.name, strategy, flavour, traits, mode: f.mode, style: xStyleOf(f), recentOwn: recentOwn.slice(0, 6) };
}

/**
 * A casual post's seed: a subject and one take — or, some days, a shower
 * thought — chosen by the account and the day, so two replicas agree and the
 * fleet does not all riff on one line the same afternoon.
 */
function casualSeed(tenant: string, day: string): { subject: string; seed: string } | null {
  const h = hash32(`seed|${tenant}|${day}`);
  if (h % 10 < 3) {
    const pool = MUSINGS.filter(usable);
    if (pool.length) return { subject: "a passing thought", seed: pool[(h >>> 4) % pool.length]! };
  }
  const subject = SUBJECTS[(h >>> 8) % SUBJECTS.length]!;
  const pool = (TAKES[subject] ?? []).filter(usable);
  if (!pool.length) return null;
  return { subject, seed: pool[(h >>> 12) % pool.length]! };
}

/** Coins the agent bought lately that a post may name, with whether each was on paper. */
function recentCoins(f: AgentFacts): { label: string; paper: boolean }[] {
  const out: { label: string; paper: boolean; key: string }[] = [];
  for (const c of f.calls) {
    if (c.side !== "buy") continue;
    const coin = coinOf(c);
    if (!coin || out.some((o) => o.key === coin.key)) continue;
    out.push({ label: coin.label, paper: c.paper, key: coin.key });
    if (out.length >= 3) break;
  }
  return out.map(({ label, paper }) => ({ label, paper }));
}

/** Every way the post may name its coin: the label, and the clean ticker and name beside it. */
function coinNames(label: string, c: { symbol: string | null; name: string | null }): string[] {
  const out = [label];
  for (const v of [c.symbol, c.name]) {
    if (typeof v === "string" && /^[A-Za-z][A-Za-z '-]{0,23}$/.test(v.trim()) && !out.includes(v.trim())) out.push(v.trim());
  }
  return out;
}

export function makeXPoster(o: { creds: LlmCreds | null; knobs: XPostEnv; app: XApp; dek: Buffer; deps?: XPosterDeps }): XPoster {
  const deps = o.deps ?? {};
  const dialect = deps.dialect ?? "postgres";
  const factsOf = deps.facts ?? loadFacts;
  const memberOf =
    deps.member ??
    (async (shared: Db, tenant: string) => {
      // The room's table holds the zone. It may never have been made on a
      // fleet where the room is switched off; making it is idempotent.
      await ensureGroupchatSchema(shared, dialect);
      return getMember(shared, tenant);
    });
  const perDay = o.knobs.perDay ?? DEFAULT_PER_DAY;
  const fleetPerDay = o.knobs.fleetPerDay ?? DEFAULT_FLEET_PER_DAY;
  // NO CREDS, NO MODEL, whatever the budget says.
  const llmPerDay = o.creds ? (o.knobs.llmPerDay ?? DEFAULT_LLM_PER_DAY) : 0;
  const creds = llmPerDay > 0 ? o.creds : null;

  let lastPlanAt = Number.NEGATIVE_INFINITY;
  let running = false;
  let lastFail: { text: string; at: number } | null = null;
  /** Said once per UTC day, and once per pause: a ceiling reached is news, not a line every fifteen seconds. */
  let capNoted = "";
  let pauseSaidUntil = 0;
  /** The last standing condition said, and when: a condition that has not changed is said again only every twenty minutes. */
  let lastCondition: { text: string; at: number } | null = null;
  let ownerFailure = "";

  const why =
    `xpost: on — at most ${perDay} posts per owner a day, ${fleetPerDay} across the fleet a day; ` +
    (creds ? `up to ${llmPerDay} model calls a day` : "no model, so only intros are posted, from templates");

  return {
    plan: () => ({ why }),
    async step(shared, roster, profiles, nowMs) {
      if (running) return { log: null };
      running = true;
      const counts = new Map<string, number>();
      const bump = (k: string, n = 1) => counts.set(k, (counts.get(k) ?? 0) + n);
      ownerFailure = "";
      try {
        await ensureXpostSchema(shared, dialect);
        const interrupted = await failInterrupted(shared, nowMs - INTERRUPTED_AFTER_MS, nowMs);
        if (interrupted > 0) bump("interrupted", interrupted);

        const byTenant = new Map<string, RosterEntry>();
        for (const r of roster) byTenant.set(r.tenant.toLowerCase(), { tenant: r.tenant.toLowerCase(), agentId: r.agentId.toLowerCase() });
        const tenants = [...byTenant.keys()];
        if (tenants.length === 0) return { log: null };
        const accounts = (await postingAccounts(shared, tenants)).filter((a) => byTenant.has(a.tenant));
        const accountOf = new Map(accounts.map((a) => [a.tenant, a] as const));

        // The owner's zone, once per pass. Unreadable is not "awake": a post
        // for an owner whose night cannot be known waits for a pass that can.
        const zones = new Map<string, { ok: true; tz: string | null } | { ok: false }>();
        const zoneOf = async (tenant: string) => {
          let z = zones.get(tenant);
          if (!z) {
            try {
              z = { ok: true, tz: (await memberOf(shared, tenant))?.tz ?? null };
            } catch {
              z = { ok: false };
            }
            zones.set(tenant, z);
          }
          return z;
        };

        // ── send what is due ──────────────────────────────────────────────
        // THE FLEET'S PAUSES: X out of credits, or X refusing the app's own
        // client credentials. Either is said once per pause, not every pass.
        let pause: { why: string; until: number } | null = null;
        for (const [key, why] of [
          [APP_PAUSE_KEY, "paused-client-credentials-refused"],
          [PAUSE_KEY, "paused-for-credits"],
        ] as const) {
          const until = Number((await readMeta(shared, key))?.v);
          if (Number.isFinite(until) && until > nowMs && until >= (pause?.until ?? 0)) pause = { why, until };
        }
        let sentToday = await countPostedSince(shared, utcMidnight(nowMs));
        let sends = 0;
        for (const post of await duePosts(shared, tenants, nowMs, MAX_DUE)) {
          const account: XAccount | null = accountOf.get(post.tenant) ?? (await getAccount(shared, post.tenant));
          let asleep = false;
          let dayOf: ((ms: number) => string) | undefined;
          if (account?.posting && account.xUserId === post.xUserId) {
            const z = await zoneOf(post.tenant);
            asleep = !z.ok || isAsleep(z.tz, post.tenant, nowMs);
            if (z.ok) dayOf = (ms) => localDay(z.tz, ms);
          }
          const d = sendDecision(post, account, nowMs, asleep, dayOf);
          if (d.action === "cancel") {
            if (await cancelPost(shared, post.id, d.reason, nowMs)) bump("cancelled");
            continue;
          }
          if (d.action === "skip") {
            if (await skipScheduled(shared, post.id, d.reason, nowMs)) bump("stale");
            continue;
          }
          if (d.action === "wait") {
            bump("waiting");
            continue;
          }
          if (pause) {
            if (pauseSaidUntil < pause.until) {
              pauseSaidUntil = pause.until;
              bump(pause.why);
            }
            continue;
          }
          if (sentToday >= fleetPerDay) {
            if (capNoted !== utcDay(nowMs)) {
              capNoted = utcDay(nowMs);
              bump("fleet-ceiling-reached");
            }
            // Not a break: a later post may still be one to cancel or skip.
            continue;
          }
          if (sends >= MAX_SENDS_PER_PASS) break;
          sends++;
          const out = await sendOne(shared, o.dek, o.app, post, { fetch: deps.fetch, nowMs });
          // The app's credentials refused is the one line an operator must act
          // on, so it says what happened rather than an outcome code.
          bump(out === "posted" ? "sent" : out === "app" ? "x-refused-client-credentials" : out);
          // What may exist on X counts toward the ceiling, not only what surely does.
          if (out === "posted" || out === "uncertain" || out === "fault") sentToday++;
          // The sender wrote the pause; this pass honours it at once, and the
          // event just said is the pause's line, so later passes stay quiet.
          if (out === "credits" || out === "app") {
            pause = out === "credits" ? { why: "paused-for-credits", until: nowMs + CREDITS_PAUSE_MS } : { why: "paused-client-credentials-refused", until: nowMs + APP_PAUSE_MS };
            pauseSaidUntil = Math.max(pauseSaidUntil, pause.until);
          }
        }

        // ── plan, at most once a minute ───────────────────────────────────
        if (accounts.length > 0 && nowMs - lastPlanAt >= PLAN_EVERY_MS) {
          lastPlanAt = nowMs;
          await planPass(shared, accounts, byTenant, profiles, nowMs, bump, zoneOf);
        }

        return { log: summary(counts, nowMs) };
      } catch (e) {
        const text = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
        if (!lastFail || lastFail.text !== text || nowMs - lastFail.at > 20 * MIN) {
          lastFail = { text, at: nowMs };
          return { log: `xpost: pass failed — ${text}` };
        }
        return { log: null };
      } finally {
        running = false;
      }
    },
  };

  async function planPass(
    shared: Db,
    accounts: XAccount[],
    byTenant: Map<string, RosterEntry>,
    profiles: Map<string, ChatProfile>,
    nowMs: number,
    bump: (k: string, n?: number) => void,
    zoneOf: (tenant: string) => Promise<{ ok: true; tz: string | null } | { ok: false }>,
  ): Promise<void> {
    const roster = accounts.map((a) => byTenant.get(a.tenant)!);
    const facts = await factsOf(shared, roster, profiles, Math.floor(nowMs / 1000), { dialect });
    const recentFleet = await recentBodies(shared, { tenant: null, sinceMs: nowMs - FLEET_MEMORY_MS, limit: FLEET_MEMORY_MAX });
    let drafts = 0;
    for (const account of accounts) {
      if (drafts >= MAX_DRAFTS_PER_PASS) break;
      try {
        const f = facts.get(account.tenant);
        if (!f) continue;
        const z = await zoneOf(account.tenant);
        if (!z.ok) {
          bump("zone-unreadable");
          continue;
        }
        const posts = await postsOf(shared, account.tenant, nowMs - PLAN_HISTORY_MS, 200);
        const intros = await introPostsOf(shared, account.tenant, account.xUserId);
        const intents = planPosts({
          tenant: account.tenant,
          account,
          tz: z.tz,
          nowMs,
          clock: PLAN_CLOCK,
          intros,
          posts,
          calls: f.calls,
          perDay,
          model: creds !== null,
        });
        if (intents.length === 0) continue;
        const recentOwn = await recentBodies(shared, { tenant: account.tenant, sinceMs: nowMs - OWN_MEMORY_MS, limit: 200 });
        for (const intent of intents) {
          if (drafts >= MAX_DRAFTS_PER_PASS) break;
          drafts++;
          const r = await writeIntent(shared, account, f, intent, nowMs, recentOwn, recentFleet);
          bump(r.outcome);
          if (r.body) {
            recentOwn.unshift(r.body);
            recentFleet.unshift(r.body);
          }
        }
      } catch (e) {
        bump("owner-failed");
        if (!ownerFailure) ownerFailure = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160);
      }
    }
  }

  /**
   * ONE LINE A PASS, COUNTS ONLY — never a post's text, never a token. Events
   * (a post sent, drafted, cancelled, failed) are always said. A standing
   * condition (the model's allowance spent, an owner whose plan keeps
   * failing) is said when it changes, or every twenty minutes while it
   * lasts, not every minute. A post waiting for its owner to wake is not news.
   */
  function summary(counts: Map<string, number>, nowMs: number): string | null {
    const events: string[] = [];
    const conditions: string[] = [];
    for (const [k, n] of counts) {
      if (k === "waiting") continue;
      const part = k === "owner-failed" && ownerFailure ? `${k} ${n} (${ownerFailure})` : `${k} ${n}`;
      (CONDITIONS.has(k) ? conditions : events).push(part);
    }
    const text = conditions.join(", ");
    if (events.length > 0) {
      if (text) lastCondition = { text, at: nowMs };
      return `xpost: ${[...events, ...conditions].join(", ")}`;
    }
    if (conditions.length === 0) return null;
    if (lastCondition && lastCondition.text === text && nowMs - lastCondition.at <= 20 * MIN) return null;
    lastCondition = { text, at: nowMs };
    return `xpost: ${text}`;
  }

  /**
   * DRAFT, GATE, WRITE — one intent. Scheduled when a draft passed; skipped
   * (the key spent) when the model passed or the gate refused, so the same
   * buy or day is not drafted again every minute. The intro alone falls back
   * to the template pool before it gives up. A buy or casual post with no
   * model allowance left is not written at all: nothing was decided.
   */
  async function writeIntent(
    shared: Db,
    account: XAccount,
    f: AgentFacts,
    intent: PlanIntent,
    nowMs: number,
    recentOwn: string[],
    recentFleet: string[],
  ): Promise<{ outcome: string; body: string | null }> {
    const day = PLAN_CLOCK.localDay(null, nowMs);
    const facts = writerFacts(f, day, recentOwn);
    const gate: XGateCtx = {
      kind: intent.kind,
      agentName: f.name,
      mode: modeOf(f),
      coins: [],
      recentOwn,
      recentFleet,
      emojiOk: facts.style.emoji > 0,
    };
    let prompt: ReturnType<typeof introPrompt> | null = null;
    let coin: string | null = null;
    let decisionId: string | null = null;
    if (intent.kind === "intro") {
      prompt = introPrompt(facts);
    } else if (intent.kind === "buy") {
      const call = f.calls.find((c) => c.decisionId === intent.call.decisionId);
      if (!call) return { outcome: "call-gone", body: null };
      gate.mode = call.paper ? "paper" : "live";
      gate.coins = coinNames(intent.coin, call);
      gate.paperCoins = call.paper ? gate.coins : [];
      coin = intent.coinKey;
      decisionId = call.decisionId;
      prompt = buyPrompt({ ...facts, coin: intent.coin, paper: call.paper, bands: call.bands, ownWords: call.ownWords });
    } else {
      const seed = casualSeed(f.tenant, intent.day);
      const coins = recentCoins(f);
      gate.coins = coins.map((c) => c.label);
      gate.paperCoins = coins.filter((c) => c.paper).map((c) => c.label);
      gate.seeds = seed ? [seed.seed] : [];
      prompt = casualPrompt({ ...facts, subject: seed?.subject ?? "anything", seed: seed?.seed ?? "", recentCoins: coins });
    }

    let body: string | null = null;
    let reason = "no-model";
    if (creds) {
      if (await takeAllowance(shared, `llm:${utcDay(nowMs)}`, llmPerDay, nowMs)) {
        // Null is PASS, an empty answer, an error or a timeout alike: the key
        // is spent either way, so a model outage costs posts, never a loop of
        // calls on the allowance.
        const raw = await draft(creds, prompt, { call: deps.llm, timeoutMs: deps.draftTimeoutMs });
        if (raw === null) reason = "no-draft";
        else {
          const v = admitXPost(raw, gate, BASE_GATE);
          if (v.ok) body = v.text;
          else reason = `gate:${v.reason}`;
        }
      } else {
        reason = "no-budget";
        if (intent.kind !== "intro") return { outcome: "no-model-budget", body: null };
      }
    }
    if (!body && intent.kind === "intro") {
      for (let attempt = 0; attempt < TEMPLATE_TRIES && !body; attempt++) {
        // A redraft rolls fresh dice: the draw that was refused last time is not drawn again.
        const redraft = intent.attempt > 0 ? `|redraft-${intent.attempt}` : "";
        const text = introTemplate({ agentName: f.name, mode: f.mode, style: facts.style }, seeded(`intro|${account.tenant}|${account.xUserId}|${attempt}${redraft}`));
        const v = admitXPost(text, gate, BASE_GATE);
        if (v.ok) body = v.text;
        else reason = `template:${v.reason}`;
      }
    }
    const written = await schedulePost(shared, {
      tenant: account.tenant,
      xUserId: account.xUserId,
      kind: intent.kind,
      dedupeKey: intent.dedupeKey,
      // A refused draft is not kept: whatever made it unpostable stays out of the table too.
      body: body ?? "",
      coin,
      decisionId,
      dueAtMs: intent.dueAtMs,
      nowMs,
      status: body ? "scheduled" : "skipped",
      reason: body ? null : reason,
    });
    if (written === null) return { outcome: "already-written", body: null };
    return { outcome: body ? `drafted-${intent.kind}` : "not-posted", body };
  }
}
