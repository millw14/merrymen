/**
 * THE WIRE, AND THE FOUR WAYS A FILE CAN BE ABSENT.
 *
 * Missing, unreadable, malformed and empty all have to mean the same thing to a
 * desk: there is no external research this window. Any of them throwing would
 * take down a tick over material that is meant to be ADDITIONAL evidence, which
 * is the wrong trade in every direction — the same contract `readPeers` holds
 * and for the same reason.
 *
 * The round trip is checked end to end rather than in halves, because the two
 * sides run in different processes and the only thing that keeps them agreeing
 * is that they were written against each other.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EMPTY_RESEARCH,
  readResearch,
  researchFilePath,
  writeResearchForChild,
  type ResearchFile,
} from "./research-files";
import { newsDesk, type NewsItem } from "./research/news";

const NOW = 1_788_600_000;
const homes: string[] = [];
const home = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "merrymen-research-"));
  homes.push(d);
  return d;
};
after(() => {
  for (const d of homes) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const story = (over: Partial<NewsItem> = {}): NewsItem => ({
  id: "1",
  source: "reuters.com",
  publishedAt: NOW - 3600,
  headline: "Tesla deliveries beat estimates",
  summary: null,
  url: "https://reuters.com/1",
  symbols: ["TSLA"],
  relevance: 0.8,
  sentiment: 0.4,
  ...over,
});

const file = (
  over: Partial<ResearchFile["news"]> = {},
  builders: ResearchFile["builders"] = [],
): ResearchFile => ({
  at: NOW,
  news: { asked: ["TSLA"], fetchedAt: NOW, failure: null, items: [story()], ...over },
  builders,
});

describe("the research file round trip", () => {
  it("what the orchestrator wrote is what the child reads", () => {
    const h = home();
    writeResearchForChild(h, file());
    const back = readResearch(h);
    assert.equal(back.at, NOW);
    assert.deepEqual(back.news.asked, ["TSLA"]);
    assert.equal(back.news.fetchedAt, NOW);
    assert.equal(back.news.failure, null);
    assert.equal(back.news.items.length, 1);
    assert.equal(back.news.items[0]!.headline, "Tesla deliveries beat estimates");
  });

  it("and it reaches the desk as material", () => {
    const h = home();
    writeResearchForChild(h, file());
    const r = readResearch(h);
    const v = newsDesk({
      symbol: "TSLA",
      asOf: NOW,
      asked: r.news.asked,
      failure: r.news.failure,
      items: r.news.items,
    });
    assert.equal(v.coverage, "ok");
    assert.match(v.news!, /Tesla deliveries beat estimates/);
  });

  it("a write replaces the previous window rather than appending to it", () => {
    const h = home();
    writeResearchForChild(h, file());
    writeResearchForChild(h, file({ items: [], asked: ["NVDA"], fetchedAt: NOW + 900 }));
    const back = readResearch(h);
    assert.deepEqual(back.news.asked, ["NVDA"]);
    assert.equal(back.news.items.length, 0);
  });
});

describe("every kind of absence is an empty desk, never a throw", () => {
  it("no file at all", () => {
    assert.deepEqual(readResearch(home()), EMPTY_RESEARCH);
  });

  it("a file that is not JSON", () => {
    const h = home();
    writeFileSync(researchFilePath(h), "not json at all");
    assert.deepEqual(readResearch(h), EMPTY_RESEARCH);
  });

  it("JSON of the wrong shape", () => {
    for (const junk of ["null", "7", '"hello"', "[]", '{"news":"nope"}', "{}"]) {
      const h = home();
      writeFileSync(researchFilePath(h), junk);
      assert.deepEqual(readResearch(h), EMPTY_RESEARCH, junk);
    }
  });

  it("a file whose items are junk keeps the file and drops the junk", () => {
    const h = home();
    writeFileSync(
      researchFilePath(h),
      JSON.stringify({
        at: NOW,
        news: {
          asked: ["TSLA", 7, null],
          fetchedAt: NOW,
          failure: "",
          items: [story(), null, { headline: "" }, { headline: "x" }, "nope"],
        },
      }),
    );
    const back = readResearch(h);
    assert.deepEqual(back.news.asked, ["TSLA"], "non-strings are not symbols");
    assert.equal(back.news.failure, null, "an empty failure string is not a failure");
    assert.equal(back.news.items.length, 1, "only the row that is actually a story survives");
  });

  it("a failure recorded in the file survives the read", () => {
    const h = home();
    writeResearchForChild(h, file({ failure: "http-error", items: [] }));
    const back = readResearch(h);
    assert.equal(back.news.failure, "http-error");
    const v = newsDesk({
      symbol: "TSLA",
      asOf: NOW,
      asked: back.news.asked,
      failure: back.news.failure,
      items: back.news.items,
    });
    assert.equal(v.coverage, "fetch-failed", "a provider outage must not read as a quiet tape");
  });
});

/**
 * THE SECOND DESK ON THE SAME WIRE.
 *
 * Builder records ride the file the news already rides, because the child must
 * see one consistent view and two files renamed a moment apart is two views. A
 * rollout is the interesting case: an orchestrator that predates this half
 * writes a file with no `builders` key at all, and a reader that treated that
 * as malformed would throw away a perfectly good news desk on every deploy.
 */
const builderRecord = (address: string, over: Record<string, unknown> = {}) => ({
  address,
  readAt: NOW,
  found: true,
  name: "A Project",
  symbol: "PRJ",
  status: "Shipping",
  statusHelp: null,
  verified: true,
  activity: { commits30d: 12, commitsPartial: false, releases30d: 1, ships30d: 2, lastShip: "2026-09-21" },
  url: "https://example.invalid/p",
  disclaimer: null,
  ...over,
}) as ResearchFile["builders"][number];

const ADDR_A = "0x" + "a".repeat(40);
const ADDR_B = "0x" + "b".repeat(40);

describe("the builder half of the wire", () => {
  it("round-trips beside the news rather than instead of it", () => {
    const h = home();
    writeResearchForChild(h, file({}, [builderRecord(ADDR_A)]));
    const back = readResearch(h);
    assert.equal(back.builders.length, 1);
    assert.equal(back.builders[0]!.address, ADDR_A);
    assert.equal(back.news.items.length, 1, "neither desk displaced the other");
  });

  it("AN UNLISTED RECORD SURVIVES THE TRIP, because it is an answer", () => {
    const h = home();
    writeResearchForChild(h, file({}, [builderRecord(ADDR_B, { found: false, name: null })]));
    const back = readResearch(h);
    assert.equal(back.builders.length, 1);
    assert.equal(back.builders[0]!.found, false);
  });

  it("a file written before this half existed still reads", () => {
    // The rollout case, written out literally rather than described: no
    // `builders` key at all.
    const h = home();
    writeFileSync(
      researchFilePath(h),
      JSON.stringify({ at: NOW, news: { asked: ["TSLA"], fetchedAt: NOW, failure: null, items: [] } }),
    );
    const back = readResearch(h);
    assert.deepEqual(back.builders, [], "absent is empty, not invalid");
    assert.deepEqual(back.news.asked, ["TSLA"], "and the news desk is untouched");
  });

  it("junk rows are dropped and the good ones kept", () => {
    const h = home();
    writeFileSync(
      researchFilePath(h),
      JSON.stringify({
        at: NOW,
        news: { asked: [], fetchedAt: 0, failure: null, items: [] },
        builders: [
          builderRecord(ADDR_A),
          { address: "not-an-address", found: true },
          { found: true },
          null,
          "nope",
        ],
      }),
    );
    const back = readResearch(h);
    assert.equal(back.builders.length, 1);
    assert.equal(back.builders[0]!.address, ADDR_A);
  });

  it("and `builders` of the wrong type is an empty desk, not a throw", () => {
    const h = home();
    writeFileSync(
      researchFilePath(h),
      JSON.stringify({ at: NOW, news: { asked: [], fetchedAt: 0, failure: null, items: [] }, builders: "nope" }),
    );
    assert.deepEqual(readResearch(h).builders, []);
  });
});
