/**
 * Telegram groups — which model writes group lines, and the one door to it.
 * The contract is docs/tg-groups.md, "The model" and rule 7 ("never spend
 * trading's allowance, never block the owner").
 *
 * WHOSE KEY. Group chatter is the cheapest thing an agent does and the easiest
 * to overdo, and the house Groq key has a daily allowance trading shares (the
 * in-app room exhausted it once). So a group line is written, in order, with:
 *
 *   1. MERRYMEN_TG_GROUPS_LLM_KEY, the operator's dedicated key — refused when
 *      it IS one of the fleet's keys, unless the operator says in so many words
 *      that it may share one (MERRYMEN_TG_GROUPS_SHARE_HOUSE_KEY=1);
 *   2. the owner's own key: self-hosted, whatever `resolveLlm` picks (the owner
 *      is the operator there); hosted, only a key the owner saved themselves,
 *      told apart from the house default by not being equal to any fleet key;
 *   3. hosted, the house key through `resolveLlm`, only with the share flag;
 *   4. nothing: templates for what must be answered, silence for the rest.
 *
 * COPIED, NOT IMPORTED. The provider, default-model and base-URL handling of
 * the dedicated key follows xpost/writer.ts `xpostModel` so the two operator
 * knobs behave alike, but telegram/ may not import xpost/ (its boundary test).
 *
 * THE GATE KEEPS THE MODEL FROM COSTING ANYTHING ELSE. `TgModelGate` counts
 * every call against a per-agent daily allowance and a per-chat hourly one,
 * both in the durable store (a redeploy does not hand out a fresh day), runs
 * at most two calls at once, time-boxes each at 20 s, and pauses all group
 * calls after a provider says no: ten minutes for a rate limit, until UTC
 * midnight for a spent daily cap, a rejected key or a missing model. A
 * failure is logged by its KIND only — never the key, the prompt or the
 * provider's own words — and never reaches a group (rule 5).
 *
 * NAMING: never write the web room's name (group + chat, joined or separated)
 * in code here. See types.ts.
 */
import { describeLlmFailure, isLlmProviderFailure } from "../../llm-failure";
import { llmText, resolveLlm, type LlmCreds } from "../../llm";
import type { ResolvedConfig } from "../../settings";
import { stripThinkingBlock } from "../interpreter";
import { utcDay, utcHour, type TgGroupsStore } from "./store";

export interface TgModel {
  creds: LlmCreds;
  /** `provider/model` for logs and the boot line. Never the key, not even a prefix of it. */
  label: string;
  source: "dedicated" | "owner" | "house";
}

type Env = Record<string, string | undefined>;

// ── the dedicated key's defaults (as xpost/writer.ts has them) ─────────────

export const TG_GROUPS_GROQ_BASE_URL = "https://api.groq.com/openai/v1";
/** The same small open model the X writer and the in-app room default to: short casual lines need nothing bigger. */
export const TG_GROUPS_GROQ_DEFAULT_MODEL = "qwen/qwen3.8-27b";
/**
 * CLAUDE OPUS 5, as the X writer chose it: llm.ts's anthropic path sends
 * `thinking: {type: "disabled"}`, which Opus 5 accepts at its default effort
 * and newer models answer with a 400. A group line needs no thinking.
 */
export const TG_GROUPS_ANTHROPIC_DEFAULT_MODEL = "claude-opus-5";

/** Keys trading spends. A group line never spends one unless the operator says it may. */
const FLEET_KEYS = ["GROQ_API_KEY", "MERRYMEN_LLM_API_KEY", "ANTHROPIC_API_KEY"] as const;

function fleetKeyMatching(key: string, env: Env): string | null {
  const k = key.trim();
  if (!k) return null;
  for (const name of FLEET_KEYS) {
    const v = env[name]?.trim();
    if (v && v === k) return name;
  }
  return null;
}

function shareHouseKey(env: Env): boolean {
  return env.MERRYMEN_TG_GROUPS_SHARE_HOUSE_KEY?.trim() === "1";
}

/** An OpenAI-compatible base: https, or http on loopback for a local runtime. No credentials in it. */
function baseOk(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

/** `provider/model`, with the key taken out should a misconfigured model name carry it. */
function labelOf(creds: LlmCreds): string {
  const raw = `${creds.provider}/${creds.model}`;
  const key = String(creds.apiKey ?? "").trim();
  return key.length >= 4 ? raw.split(key).join("[key]") : raw;
}

/**
 * The dedicated key's creds, or why there are none. `problem` names env
 * variables and the fleet key's NAME only — never a value.
 */
function dedicated(env: Env): { creds: LlmCreds | null; problem: string | null } {
  const key = env.MERRYMEN_TG_GROUPS_LLM_KEY?.trim() ?? "";
  if (!key) return { creds: null, problem: null };
  const fleet = fleetKeyMatching(key, env);
  if (fleet && !shareHouseKey(env)) {
    return {
      creds: null,
      problem: `MERRYMEN_TG_GROUPS_LLM_KEY is the fleet's ${fleet}, and group lines never spend a fleet key (MERRYMEN_TG_GROUPS_SHARE_HOUSE_KEY=1 allows it)`,
    };
  }
  const provider = env.MERRYMEN_TG_GROUPS_LLM_PROVIDER?.trim().toLowerCase() || "groq";
  const model = env.MERRYMEN_TG_GROUPS_MODEL?.trim() ?? "";
  if (provider === "groq") {
    return {
      creds: { provider: "groq", transport: "openai", baseUrl: TG_GROUPS_GROQ_BASE_URL, apiKey: key, model: model || TG_GROUPS_GROQ_DEFAULT_MODEL, vision: false },
      problem: null,
    };
  }
  if (provider === "anthropic") {
    return {
      creds: { provider: "anthropic", transport: "anthropic", baseUrl: "", apiKey: key, model: model || TG_GROUPS_ANTHROPIC_DEFAULT_MODEL, vision: false },
      problem: null,
    };
  }
  if (provider === "openai") {
    const base = env.MERRYMEN_TG_GROUPS_LLM_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
    // No default model for an arbitrary endpoint: guessing one would spend
    // the first calls of every day on a 404 and a pause.
    if (!base || !baseOk(base) || !model) {
      return {
        creds: null,
        problem: "MERRYMEN_TG_GROUPS_LLM_PROVIDER=openai needs an https MERRYMEN_TG_GROUPS_LLM_BASE_URL and a MERRYMEN_TG_GROUPS_MODEL",
      };
    }
    return { creds: { provider: "openai", transport: "openai", baseUrl: base, apiKey: key, model, vision: false }, problem: null };
  }
  return { creds: null, problem: "MERRYMEN_TG_GROUPS_LLM_PROVIDER is not groq, anthropic or openai" };
}

/**
 * The config with every key field that holds a fleet key's value taken out.
 *
 * WHY STRIP RATHER THAN CHECK AFTERWARDS ONLY. settings.ts resolves each key
 * file-first, env-second, so a hosted cfg carries the house keys in the same
 * fields an owner's saved keys go in. `resolveLlm` prefers an explicit
 * provider selection; an owner who selected Anthropic without saving an
 * Anthropic key would be handed the house Anthropic key, refused by the check,
 * and lose the Groq key they DID save. Stripping first lets resolveLlm find
 * the owner's own key wherever it is; the result is still checked.
 */
function withoutFleetKeys(cfg: ResolvedConfig, env: Env): ResolvedConfig {
  const strip = (v: string | undefined): string | undefined => (v && fleetKeyMatching(v, env) ? undefined : v);
  return { ...cfg, groqApiKey: strip(cfg.groqApiKey), anthropicApiKey: strip(cfg.anthropicApiKey), llmApiKey: strip(cfg.llmApiKey) };
}

const model = (creds: LlmCreds, source: TgModel["source"]): TgModel => ({ creds, label: labelOf(creds), source });

/**
 * WHO WRITES GROUP LINES, decided once per boot (and again when settings
 * change). See the file header for the order. A refused or misconfigured
 * dedicated key falls through to the owner's own key: the operator's mistake
 * must not silence an owner who brought a key, and it can never reach the
 * house key without the share flag.
 */
export function resolveTgGroupsModel(cfg: ResolvedConfig, env: Env, hosted: boolean): TgModel | null {
  const d = dedicated(env);
  if (d.creds) return model(d.creds, "dedicated");

  if (!hosted) {
    const own = resolveLlm(cfg);
    return own ? model(own, "owner") : null;
  }

  const own = resolveLlm(withoutFleetKeys(cfg, env));
  if (own && !fleetKeyMatching(String(own.apiKey ?? ""), env)) return model(own, "owner");

  if (shareHouseKey(env)) {
    const house = resolveLlm(cfg);
    if (house) return model(house, "house");
  }
  return null;
}

/**
 * Why the dedicated key was not used, for the boot log — or null when it is
 * unset or fine. Names variables only, never a value.
 */
export function tgGroupsDedicatedKeyProblem(env: Env): string | null {
  return dedicated(env).problem;
}

/** The boot line. Names the source, provider and model only. */
export function describeTgGroupsModel(m: TgModel | null): string {
  if (!m) {
    return "telegram groups: no model — addressed answers, coin acks and outcomes use templates; no ambient lines (reactions still happen)";
  }
  const on =
    m.source === "dedicated"
      ? "its own key (MERRYMEN_TG_GROUPS_LLM_KEY)"
      : m.source === "owner"
        ? "the owner's own key"
        : "the house key (MERRYMEN_TG_GROUPS_SHARE_HOUSE_KEY=1)";
  return `telegram groups: model ${m.label} on ${on}`;
}

/** MERRYMEN_TG_GROUPS_LLM_PER_DAY: model calls per agent per UTC day. Default 300 hosted, 1000 self-hosted; clamped to [0, 20000]. */
export function tgGroupsPerDay(env: Env, hosted: boolean): number {
  const fallback = hosted ? 300 : 1000;
  const raw = env.MERRYMEN_TG_GROUPS_LLM_PER_DAY?.trim() ?? "";
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(20_000, Math.max(0, Math.floor(n)));
}

// ── the gate ────────────────────────────────────────────────────────────────

const MIN = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PER_CHAT_HOUR = 40;
const DEFAULT_MAX_IN_FLIGHT = 2;
/** More callers than this waiting for a slot and the newest is dropped: a line that waits that long is stale anyway. */
const MAX_WAITING = 6;
const RATE_LIMIT_PAUSE_MS = 10 * MIN;
/**
 * HOW LONG A CALL THAT OUTLIVED ITS TIME BOX KEEPS ITS SLOT. llmText takes no
 * signal, so a timed-out call is still running at the provider; holding its
 * slot keeps "at most two at once" true of what the provider sees. But a call
 * that never settles must not hold a slot forever, so after this grace it is
 * written off and the slot freed.
 */
const LATE_GRACE_MS = 60_000;
/** Less time than this left in the box after waiting for a slot, and the call is not started. */
const MIN_CALL_MS = 1_000;

/** A 429 that means the day is spent, not the minute: Groq's TPD/RPD, a "per day" or "daily" limit, an exhausted quota. */
const DAILY_CAP = /per[\s_-]?day|\bdaily\b|\bTPD\b|\bRPD\b|quota/i;

function nextUtcMidnight(ms: number): number {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

type Failure = { kind: string; pause: "short" | "day" | null };

/**
 * What a thrown call means for the NEXT calls. Reads the message the way
 * llm-failure.ts does (llm.ts's `providerError` shape), and an SDK error's
 * numeric `status` too — the Anthropic SDK's messages do not start with the
 * provider's name, so the shape alone would miss its 429s.
 */
function classify(e: unknown): Failure {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const statusRaw = (e as { status?: unknown } | null)?.status;
  const status = typeof statusRaw === "number" ? statusRaw : null;
  const f = describeLlmFailure(msg);
  let kind: string = f.kind;
  if (!isLlmProviderFailure(msg)) {
    if (status === 429) kind = "rate-limited";
    else if (status === 401 || status === 403) kind = "key-rejected";
    else if (status === 404) kind = "model-missing";
    else if (status !== null && status >= 500) kind = "provider-down";
  }
  if (kind === "rate-limited") return DAILY_CAP.test(msg) ? { kind: "daily-cap", pause: "day" } : { kind, pause: "short" };
  if (kind === "key-rejected" || kind === "model-missing") return { kind, pause: "day" };
  return { kind, pause: null };
}

export interface TgModelGateOptions {
  /** Calls per agent per UTC day (`tgGroupsPerDay`). 0 disables the model. */
  perDay: number;
  /** Calls per chat per UTC hour. Default 40. */
  perChatHour?: number;
  /** Calls running at once. Default 2. */
  maxInFlight?: number;
  /** Clock for days, hours and pauses (the store should share it). Time boxes use real timers. */
  now?: () => number;
  log?: (s: string) => void;
}

/**
 * EVERY GROUP MODEL CALL GOES THROUGH HERE. `run` answers null — and the
 * caller falls back to a template or silence — when the model is paused, the
 * day's or the chat's allowance is spent, too many calls are already waiting,
 * the call took longer than its time box, or it threw. It never throws.
 */
export class TgModelGate {
  private readonly store: TgGroupsStore;
  private readonly perDay: number;
  private readonly perChatHour: number;
  private readonly maxInFlight: number;
  private readonly now: () => number;
  private readonly log: (s: string) => void;
  private inFlight = 0;
  private readonly waiters: Array<{ grant: () => void }> = [];

  constructor(store: TgGroupsStore, o: TgModelGateOptions) {
    this.store = store;
    const n = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : d);
    this.perDay = Math.max(0, n(o?.perDay, 0));
    this.perChatHour = Math.max(0, n(o?.perChatHour, DEFAULT_PER_CHAT_HOUR));
    this.maxInFlight = Math.max(1, n(o?.maxInFlight, DEFAULT_MAX_IN_FLIGHT));
    this.now = typeof o?.now === "function" ? o.now : Date.now;
    this.log = typeof o?.log === "function" ? o.log : (s) => console.warn(s);
  }

  /**
   * Could a call run now? A read-only look — nothing is taken. For a caller
   * deciding whether to try at all (pacing's `hasModel`, an ambient roll).
   */
  available(chatId: number): boolean {
    try {
      const now = this.now();
      return !this.paused(now) && this.dayHasRoom(now) && this.roomHasRoom(chatId, now) && this.waiters.length < MAX_WAITING;
    } catch {
      return false;
    }
  }

  /**
   * Run one model call for `chatId`, or answer null. The allowance is taken
   * only once a slot is free — a call dropped while waiting costs nothing —
   * and the time box covers the wait as well as the call: a line that took
   * twenty seconds to start is as late as one that took twenty to write.
   */
  async run<T>(chatId: number, fn: () => Promise<T>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T | null> {
    try {
      const box = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
      const started = Date.now();
      const now = this.now();
      if (this.paused(now) || !this.dayHasRoom(now) || !this.roomHasRoom(chatId, now)) return null;
      if (this.waiters.length >= MAX_WAITING) return null;
      if (!(await this.acquire(box))) return null;

      let handedOff = false;
      try {
        // Re-read after the wait: another call may have paused the model or spent the day meanwhile.
        const at = this.now();
        if (this.paused(at) || !this.dayHasRoom(at) || !this.roomHasRoom(chatId, at)) return null;
        // A slot that came free at the very end of the box is not worth a
        // call: it would be abandoned at once and still cost the allowance.
        const remaining = box - (Date.now() - started);
        if (remaining < Math.min(MIN_CALL_MS, box / 4)) return null;
        if (!this.store.takeLlm(this.perDay)) return null;
        if (!this.store.takeRoomLlm(chatId, this.perChatHour)) return null;

        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          this.release();
        };
        const grace = setTimeout(release, remaining + LATE_GRACE_MS);
        grace.unref?.();
        handedOff = true;
        // A failure is classified even when it lands after the time box: a
        // late 429 still pauses the next calls.
        const settled = Promise.resolve()
          .then(fn)
          .then(
            (v): { ok: true; v: T } => ({ ok: true, v }),
            (e: unknown): { ok: false } => {
              this.failed(e);
              return { ok: false };
            },
          )
          .finally(() => {
            clearTimeout(grace);
            release();
          });

        // NOT unref'd: an unref'd timer racing a call that never settles would
        // let node exit with the await still pending. Cleared as soon as the race ends.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), remaining);
        });
        const out = await Promise.race([settled, timeout]);
        if (timer !== undefined) clearTimeout(timer);
        if (out === "timeout") {
          this.say("[tg-groups] model call timed out");
          return null;
        }
        return out.ok ? out.v : null;
      } finally {
        if (!handedOff) this.release();
      }
    } catch {
      return null;
    }
  }

  private paused(now: number): boolean {
    return this.store.llmPausedUntil() > now;
  }

  /** Mirrors store.takeLlm without taking: a new UTC day is fresh, a clock that went back gets nothing. */
  private dayHasRoom(now: number): boolean {
    if (this.perDay <= 0) return false;
    const llm = this.store.state.llm;
    const day = utcDay(now);
    if (day < llm.day) return false;
    return day !== llm.day || llm.used < this.perDay;
  }

  /** Mirrors store.takeRoomLlm without taking. An unknown room has no allowance. */
  private roomHasRoom(chatId: number, now: number): boolean {
    if (this.perChatHour <= 0) return false;
    const room = this.store.room(chatId);
    if (!room) return false;
    const hour = utcHour(now);
    const h = room.llmHour;
    if (h && hour < h.hour) return false;
    return !h || h.hour !== hour || h.n < this.perChatHour;
  }

  private acquire(ms: number): Promise<boolean> {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight++;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const w = {
        grant: () => {
          clearTimeout(t);
          resolve(true);
        },
      };
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      }, ms);
      this.waiters.push(w);
    });
  }

  /** Hand the slot to the next waiter, or give it back. */
  private release(): void {
    const next = this.waiters.shift();
    if (next) next.grant();
    else this.inFlight = Math.max(0, this.inFlight - 1);
  }

  private failed(e: unknown): void {
    try {
      const f = classify(e);
      const now = this.now();
      if (f.pause === "short") this.store.pauseLlm(now + RATE_LIMIT_PAUSE_MS);
      else if (f.pause === "day") this.store.pauseLlm(nextUtcMidnight(now));
      const paused = f.pause === "short" ? ", paused for ten minutes" : f.pause === "day" ? ", paused until UTC midnight" : "";
      // THE KIND ONLY. The provider's message can quote the request back.
      this.say(`[tg-groups] model call failed (${f.kind})${paused}`);
    } catch {
      // Classifying a failure must not become one.
    }
  }

  private say(s: string): void {
    try {
      this.log(s);
    } catch {
      // A logger that throws costs nothing.
    }
  }
}

// ── the call ────────────────────────────────────────────────────────────────

/**
 * THE FLOOR UNDER EVERY COMPLETION BUDGET. The default fleet model reasons
 * before it answers and is not on llm.ts's quiet-reasoning list, so a budget
 * sized for a six-word line can be spent entirely on thinking: llmText then
 * throws on the empty reply, or returns an unclosed <think> that
 * stripThinkingBlock empties. A line is short either way; the floor only
 * costs tokens a model actually uses.
 */
const MIN_TOKENS = 600;

/**
 * One free-text completion with its thinking removed ("" when it was all
 * thinking — fail closed, never the raw text). Throws what llmText throws;
 * run it inside `TgModelGate.run`, which classifies and swallows.
 */
export async function callText(m: TgModel, system: string, prompt: string, maxTokens: number): Promise<string> {
  const budget = Math.max(MIN_TOKENS, typeof maxTokens === "number" && Number.isFinite(maxTokens) ? Math.floor(maxTokens) : 0);
  const out = await llmText(m.creds, { system, prompt, maxTokens: budget });
  return stripThinkingBlock(out);
}
