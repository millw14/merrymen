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
  for (const d of homes) rmSync(d, { recursive: true, force: true });
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

const file = (over: Partial<ResearchFile["news"]> = {}): ResearchFile => ({
  at: NOW,
  news: { asked: ["TSLA"], fetchedAt: NOW, failure: null, items: [story()], ...over },
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
