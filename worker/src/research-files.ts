/**
 * EXTERNAL RESEARCH, MATERIALISED INTO A CHILD'S HOME.
 *
 * The transport half of the news desk, and the same wire `peer-files.ts`
 * already runs for published theses: the orchestrator holds the credential and
 * does the fetching, the child reads a file.
 *
 * WHY THE ORCHESTRATOR FETCHES AND NOT THE CHILD. Four reasons, and the first
 * two are the ones that decided it.
 *
 *   1. THE WORKER IS ONE PROCESS PER TENANT. A module-level cache inside a
 *      child is a cache for exactly one agent. Three agents on a fifteen-minute
 *      cadence would make three times the vendor calls against an allowance
 *      measured in the low hundreds per day, and the fleet is meant to grow.
 *      Caching where the fleet is, rather than where the agent is, is the only
 *      arrangement whose cost does not scale with the number of tenants.
 *   2. THE KEY MUST NOT REACH A CHILD. `CHILD_SECRET_STRIP` removes it from
 *      every child's environment, which makes "a tenant worker cannot leak the
 *      news token" a property of the process boundary rather than of anybody's
 *      diligence — the same argument that already keeps `DATABASE_URL` out.
 *   3. It keeps a general-purpose HTTP client whose target is configuration off
 *      the trading path, for the reason `peer-files.ts` states at length.
 *   4. An absent or unreadable file is synchronously an empty desk. A hanging
 *      fetch inside a tick is not.
 *
 * THIS FILE IS A CACHE, NOT A HISTORY. It holds the latest window and is
 * overwritten; the durable record of what a given run actually saw is the
 * decision row that run wrote. That separation is what makes the point-in-time
 * rule enforceable rather than aspirational: nothing here is ever back-dated,
 * and the reader filters on `publishedAt <= now` on every read, so a later
 * fetch cannot retroactively put today's headline in front of yesterday's
 * decision.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NewsItem } from "./research/news";
import { isBuilderRecord, type BuilderRecord } from "./research/builder";

const FILE = "research.json";

export interface ResearchFile {
  /** Unix seconds the orchestrator wrote this file. */
  at: number;
  news: {
    /**
     * The symbols the provider was actually asked about.
     *
     * THE LOAD-BEARING FIELD. Without it, a symbol with no stories and a symbol
     * nobody queried are the same empty list, and the desk would report the
     * second as though it were the first — "no news" when the truth is "no
     * request". That is precisely the dishonest no-data this work exists to
     * remove, and one array of strings is what separates them.
     */
    asked: string[];
    /** Last successful ask per symbol. The global fetchedAt cannot date an individual symbol. */
    askedAt?: Record<string, number>;
    /** Crypto coverage certified by a successful single-symbol provider query. */
    perpsCheckedAt?: Record<string, number>;
    /** Last direct crypto answer, retained separately from the shared 200-story cache. */
    perpsDirect?: Record<string, { items: NewsItem[]; hadRows: boolean }>;
    /** Unix seconds of the last SUCCESSFUL answer. 0 when there has never been one. */
    fetchedAt: number;
    /** Null when the last fetch succeeded, otherwise a short reason. */
    failure: string | null;
    items: NewsItem[];
    /** Reader detected rows that could not be trusted; perps must not call that a quiet tape. */
    invalidItems?: boolean;
  };
  /**
   * What a builder directory said about the coins in THIS tenant's universe.
   *
   * NO `asked` FIELD, AND THAT IS NOT AN OVERSIGHT — it is the difference
   * between this desk and the news one. `asked` exists above because a symbol
   * with no stories and a symbol nobody queried are the same empty list and
   * have to be told apart. Here they cannot be confused: a contract that was
   * asked about produces a record whatever the answer was, including the
   * answer "we hold no page for this", so a missing record means exactly one
   * thing — nobody has asked yet. The absence IS the honesty field.
   *
   * A FAILED LOOKUP IS ALSO A MISSING RECORD, on purpose, and the desk treats
   * it the same way: no lens. See builder-pass.ts on why an outage must not be
   * stored as an empty result.
   */
  builders: BuilderRecord[];
}

export function researchFilePath(home: string): string {
  return path.join(home, FILE);
}

export const EMPTY_RESEARCH: ResearchFile = {
  at: 0,
  news: { asked: [], fetchedAt: 0, failure: null, items: [] },
  builders: [],
};

/**
 * Write a child's research file. Called by the orchestrator only.
 *
 * Temp-then-rename, mode 0600, exactly as `writePeersForChild` — a desk reading
 * mid-write must never observe half a file, and rename is atomic within a
 * filesystem where write is not.
 */
export function writeResearchForChild(home: string, file: ResearchFile): void {
  mkdirSync(home, { recursive: true });
  const tmp = path.join(home, "." + FILE + ".tmp");
  writeFileSync(tmp, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, researchFilePath(home));
}

/**
 * Read a child's research file. NEVER THROWS.
 *
 * Absent, unreadable, malformed and empty all mean the same thing to the desk:
 * there is no external research this window. A throw here would take down a
 * tick over material that is meant to be additional evidence.
 *
 * The items are re-validated rather than trusted: this file is written by the
 * orchestrator, but it lives in a tenant-writable home, and a desk that assumed
 * its shape would be assuming the one thing about the filesystem it should not.
 */
export function readResearch(home: string): ResearchFile {
  try {
    const raw = JSON.parse(readFileSync(researchFilePath(home), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return EMPTY_RESEARCH;
    const f = raw as Partial<ResearchFile>;
    const news = f.news;
    if (!news || typeof news !== "object") return EMPTY_RESEARCH;
    const validItems = Array.isArray(news.items) ? news.items.filter(isNewsItem) : [];
    let invalidItems = !Array.isArray(news.items) || validItems.length !== news.items.length;
    const perpsDirect: NonNullable<ResearchFile["news"]["perpsDirect"]> = {};
    if (news.perpsDirect !== undefined) {
      if (!news.perpsDirect || typeof news.perpsDirect !== "object" || Array.isArray(news.perpsDirect)) invalidItems = true;
      else for (const [symbol, answer] of Object.entries(news.perpsDirect)) {
        if (!/^CC:(BTC|ETH|SOL)$/.test(symbol) || !answer || typeof answer !== "object" ||
            typeof answer.hadRows !== "boolean" || !Array.isArray(answer.items) || answer.items.length > 8) {
          invalidItems = true; continue;
        }
        const items = answer.items.filter(isNewsItem);
        if (items.length !== answer.items.length) invalidItems = true;
        perpsDirect[symbol] = { items, hadRows: answer.hadRows };
      }
    }
    return {
      at: Number(f.at) || 0,
      news: {
        asked: Array.isArray(news.asked) ? news.asked.filter((s) => typeof s === "string") : [],
        ...(news.askedAt && typeof news.askedAt === "object" && !Array.isArray(news.askedAt)
          ? { askedAt: Object.fromEntries(Object.entries(news.askedAt).filter(([symbol, at]) =>
              /^[A-Z0-9:.]{1,24}$/.test(symbol) && Number.isSafeInteger(at) && typeof at === "number" && at > 0)) }
          : {}),
        ...(news.perpsCheckedAt && typeof news.perpsCheckedAt === "object" && !Array.isArray(news.perpsCheckedAt)
          ? { perpsCheckedAt: Object.fromEntries(Object.entries(news.perpsCheckedAt).filter(([symbol, at]) =>
              /^CC:(BTC|ETH|SOL)$/.test(symbol) && Number.isSafeInteger(at) && typeof at === "number" && at > 0)) }
          : {}),
        ...(news.perpsDirect !== undefined ? { perpsDirect } : {}),
        fetchedAt: Number(news.fetchedAt) || 0,
        failure: typeof news.failure === "string" && news.failure ? news.failure : null,
        items: validItems,
        ...(invalidItems ? { invalidItems: true } : {}),
      },
      // ABSENT IS EMPTY, NOT INVALID. A file written by an orchestrator that
      // predates the builder desk has no `builders` key at all, and a reader
      // that treated a missing key as a malformed file would throw away a
      // perfectly good news desk during every rollout.
      builders: Array.isArray(f.builders) ? f.builders.filter(isBuilderRecord) : [],
    };
  } catch {
    return EMPTY_RESEARCH;
  }
}

/** The minimum a row must be before the desk will read it as a story. */
function isNewsItem(v: unknown): v is NewsItem {
  if (!v || typeof v !== "object") return false;
  const it = v as Partial<NewsItem>;
  return (
    typeof it.headline === "string" &&
    it.headline.length > 0 &&
    typeof it.publishedAt === "number" &&
    Number.isFinite(it.publishedAt) &&
    Array.isArray(it.symbols)
  );
}
