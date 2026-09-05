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
    /** Unix seconds of the last SUCCESSFUL answer. 0 when there has never been one. */
    fetchedAt: number;
    /** Null when the last fetch succeeded, otherwise a short reason. */
    failure: string | null;
    items: NewsItem[];
  };
}

export function researchFilePath(home: string): string {
  return path.join(home, FILE);
}

export const EMPTY_RESEARCH: ResearchFile = {
  at: 0,
  news: { asked: [], fetchedAt: 0, failure: null, items: [] },
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
    return {
      at: Number(f.at) || 0,
      news: {
        asked: Array.isArray(news.asked) ? news.asked.filter((s) => typeof s === "string") : [],
        fetchedAt: Number(news.fetchedAt) || 0,
        failure: typeof news.failure === "string" && news.failure ? news.failure : null,
        items: Array.isArray(news.items) ? news.items.filter(isNewsItem) : [],
      },
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
