/**
 * THE GROUP THESIS DIGEST (digest.ts, plan WP9 P1): what traders argue, in
 * fixed words, deterministic, with no count a room could read as a verdict.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { admitTgLine } from "../telegram/tg-groups/gate";
import { contentFree, digestTheses, GROUP_PHRASE, readThesisForDigest, TOPIC_PHRASE, WAITING_PHRASE, type DigestThesis } from "./digest";
import { resolveFamilies, type DossierTopic } from "./dossier";
import type { Thesis } from "./types";

interface Row {
  id: string;
  text: string;
  likes: number;
  isDev: boolean;
  userId: string;
  ts: string;
}
const rich = (JSON.parse(readFileSync(new URL("./testdata/theses-token-rich.json", import.meta.url), "utf8")) as { theses: Row[] }).theses;

/** Views as service.ts builds them: families resolved over the rows, the reading from the full text. */
function viewsOf(rows: Row[]): DigestThesis[] {
  const fam = resolveFamilies(rows.map((r) => ({ id: r.id, text: r.text, familyKey: `id:${r.id}` }) as unknown as Thesis));
  return rows.map((r) => ({
    excerpt: r.text,
    likes: r.likes,
    postedAt: Date.parse(r.ts),
    isDev: r.isDev,
    family: fam.get(r.id) ?? r.id,
    author: { userId: r.userId },
    ...readThesisForDigest(r.text),
  }));
}

const view = (text: string, i: number, over: Partial<DigestThesis> = {}): DigestThesis => ({
  excerpt: text,
  likes: i,
  postedAt: 1_000 + i,
  isDev: false,
  family: `f${i}`,
  author: { userId: `u${i}` },
  ...over,
});

describe("digestTheses", () => {
  it("says what the rich fixture argues, in fixed words only", () => {
    const d = digestTheses(viewsOf(rich));
    assert.equal(d.theses, 25);
    assert.equal(d.devPosts, 1);
    assert.deepEqual(d.forIt.slice(0, 2), ["it's still early", "a strong community"]);
    assert.ok(d.forIt.includes("the chart setting up"));
    assert.ok(d.against.includes("fears it could collapse"));
    assert.ok(d.against.includes("worries about the dev's wallet"));
    assert.ok(d.against.includes("it looks overvalued"));
    assert.ok(d.about.length > 0 && d.about.length <= 3);
    // "not a rug" is negated: it neither adds a worry nor removes one.
    for (const p of [...d.forIt, ...d.against, ...d.about, ...d.waitingOn]) {
      assert.ok(Object.values(GROUP_PHRASE).includes(p) || Object.values(TOPIC_PHRASE).includes(p as never) || Object.values(WAITING_PHRASE).includes(p), p);
    }
  });

  it("counts a family once, whichever copy comes first", () => {
    const a = view("top wallets hold most of supply, careful this could rug", 1, { family: "same" });
    const b = view("top wallets hold most of supply, careful this could rug", 9, { family: "same" });
    const c = view("community is strong and growing every day", 2);
    assert.deepEqual(digestTheses([a, b, c]), digestTheses([b, a, c]));
    assert.equal(digestTheses([a, b, c]).families, 2);
  });

  it("drops a negated cue ('not a rug'), never inverting it", () => {
    const d = digestTheses([view("not a rug, dev is doxxed and building", 1)]);
    assert.deepEqual(d.against, []);
    assert.deepEqual(d.forIt, []);
    assert.deepEqual(d.about, ["the team"]);
  });

  it("leaves the dev's own posts out of every tally, and counts them apart", () => {
    const d = digestTheses([view("still early, strong community here", 1, { isDev: true }), view("chart and volume look heavy, careful", 2)]);
    assert.equal(d.devPosts, 1);
    assert.deepEqual(d.forIt, []);
    assert.deepEqual(d.about, ["the chart and volume"]);
  });

  it("drops content-free rows: lfg, send it, a bare link", () => {
    for (const t of ["lfg", "send it", "https://x.com/a/status/1", "@someone 0x39DBED3A00000000000000000000000000000C0D"]) assert.equal(contentFree(t), true, t);
    assert.equal(contentFree("community is strong here"), false);
    const d = digestTheses([view("lfg", 1), view("send it", 2)]);
    assert.equal(d.contentFree, 2);
    assert.equal(d.families, 0);
  });

  it("all hype and no cue: topics only, no case either way", () => {
    const hype = ["AnyPS5 to the moon", "lfg anyps5", "ps5 giveaway meme going viral on tiktok, gamers are piling in", "sony narrative lol, this could get big", "the ps5 meme is everywhere, culture coin"];
    const d = digestTheses(hype.map((t, i) => view(t, i)));
    assert.deepEqual([d.forIt, d.against], [[], []]);
    assert.deepEqual(d.about, ["the story behind it"]);
  });

  it("never waits on an airdrop, and conveys a hoped-for listing as an event without inferring support", () => {
    assert.deepEqual(readThesisForDigest("claim the airdrop before the listing").waitingOn, []);
    assert.deepEqual(readThesisForDigest("roadmap drops friday, then the launch").waitingOn, ["roadmap"]);
    const d = digestTheses([view("holders are hoping for a listing on the app", 1)]);
    assert.deepEqual(d.forIt, []);
    assert.deepEqual(d.waitingOn, ["a listing"]);
  });

  it("does not turn denied, cancelled, completed or merely mentioned events into catalysts", () => {
    for (const text of [
      "No listing is planned and no launch is expected this year",
      "The listing is not happening and the launch was cancelled",
      "Holders were waiting for a listing but it got cancelled",
      "We are waiting for an update but it has been delayed",
      "The partnership was announced last week and the launch already happened",
      "The coin listed yesterday after the release",
      "A listing, a roadmap, a launch, a partnership and an update were discussed",
      "Is a listing expected soon? Is the launch coming tomorrow?",
      "There is no reason to expect the listing or launch",
      "The planned listing has been scrapped",
      "Waiting for a listing. The listing has been cancelled",
      "Waiting for a launch. It was cancelled yesterday",
      "Waiting for a listing. Cancelled.",
      "We stopped waiting for a listing",
      "The listing planned last Friday fell through",
      "I expect the listing to fail",
    ]) {
      const reading = readThesisForDigest(text);
      assert.deepEqual(reading.waitingOn, [], text);
      assert.ok(!reading.cues.some((c) => c.label === "listing"), text);
      assert.deepEqual(digestTheses([view(text, 1)]).forIt, [], text);
    }
  });

  it("keeps explicit anticipation attached to the event it describes", () => {
    for (const [text, expected] of [
      ["Traders are waiting for a listing and a launch", ["listing", "launch"]],
      ["The launch is scheduled for next week", ["launch"]],
      ["An update is expected soon", ["update"]],
      ["Looking forward to the roadmap", ["roadmap"]],
      ["The team will launch next month", ["launch"]],
      ["launch next week they say", ["launch"]],
      ["Waiting for an update after the launch", ["update"]],
      ["A listing is cancelled. Holders are waiting for a launch", ["launch"]],
    ] as const) assert.deepEqual(readThesisForDigest(text).waitingOn, expected, text);
  });

  it("does not turn intentions to sell or discuss an event into support for the coin", () => {
    for (const text of [
      "we will sell at the listing next week",
      "we will sell at the listing",
      "we will discuss the listing",
      "I expect the listing next week and will sell into it",
      "The listing is scheduled for next week",
      "I expect a listing next week",
      "Waiting for a listing to sell my tokens",
    ]) {
      const d = digestTheses([view(text, 1)]);
      assert.deepEqual(d.forIt, [], text);
    }
    assert.deepEqual(readThesisForDigest("we will discuss the listing").waitingOn, []);
    assert.deepEqual(readThesisForDigest("we will discuss a listing next week").waitingOn, []);
    assert.deepEqual(readThesisForDigest("we will assess the listing tomorrow").waitingOn, []);
    assert.deepEqual(readThesisForDigest("the team will launch").waitingOn, ["launch"]);
    const cached = view("the listing is expected next week", 1, {
      cues: [{ label: "listing", stance: "supporting" }], topics: [], waitingOn: ["listing"],
    });
    assert.deepEqual(digestTheses([cached]).forIt, []);
    assert.deepEqual(digestTheses([cached]).waitingOn, ["a listing"]);
  });

  it("is deterministic and survives odd input", () => {
    const v = viewsOf(rich);
    assert.deepEqual(digestTheses(v), digestTheses(v.map((x) => ({ ...x }))));
    assert.deepEqual(digestTheses([]).forIt, []);
    assert.doesNotThrow(() => digestTheses([null as unknown as DigestThesis, { excerpt: 3 } as unknown as DigestThesis]));
  });

  it("every phrase a room can hear passes the group gate as research AND as answer, with no digit", () => {
    const phrases = [...Object.values(GROUP_PHRASE), ...Object.values(TOPIC_PHRASE), ...Object.values(WAITING_PHRASE)];
    for (const p of phrases) {
      assert.ok(!/\d/.test(p), p);
      for (const line of [`For it: ${p}.`, `Against it: ${p}.`, `Most of it is about ${p}.`, `Waiting on: ${p}.`]) {
        for (const kind of ["research", "answer"] as const) {
          const v = admitTgLine(line, { agentName: "Shogun", kind, recentOwn: [] });
          assert.ok(v.ok, `${kind} refused ${line}: ${v.ok ? "" : v.reason}`);
        }
      }
    }
    const topics: DossierTopic[] = ["team", "liquidity", "supply", "momentum", "narrative", "community"];
    assert.deepEqual(Object.keys(TOPIC_PHRASE).sort(), [...topics].sort());
  });
});
