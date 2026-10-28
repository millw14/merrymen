/**
 * THE CHAIN AND THE DATA PROVIDERS ARE NEVER NAMED BY CODE'S OWN WORDS (the
 * owner, 2026-10-18). An active owner's post that names coingecko,
 * geckoterminal, bitquery or the chain by its name ("robinhood chain", "robin
 * hood chain", "r0binhood chain") is refused as source-named, a model's
 * draft or code's own line alike (gate.ts sourceNamed, XGateCtx.house). So a
 * code line that said one would never go out, and the slot it stood in for
 * would go quiet: every pool is held to it here, two ways.
 *
 *   - ITS SOURCE: every string and template piece of the modules that hold
 *     code's lines and the writer's prompts, read with the TypeScript parser
 *     so comments (which quote the refused posts by name) are not read.
 *   - ITS LINES: every line each pool builds, for every read it can be
 *     handed, live and paper, as it would be posted.
 *
 * NOT HERE, ON PURPOSE: public-wallet.ts, whose disclosures (an intro's
 * " Wallet (Robinhood Chain): 0x…" and a buy's explorer link on
 * robinhoodchain.blockscout.com) are trusted suffixes code puts on AFTER
 * the gate, unchanged by this rule; figures.ts, whose "gecko" and
 * "bitquery" are tickers it refuses to show; and
 * orchestrator-xpost-research.ts, whose "robinhood chain" is in patterns
 * that read a tag, never in anything posted.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { STRATEGY_SPOKEN } from "./groupchat/templates";
import { chatAnswers, declineAnswers, reactionAnswers, selfAnswers, tradesAnswers, vibeAnswers } from "./xpost/casual";
import { checkAnswers, checkPhrases, type CheckRead, type CheckSignal, type CheckVerdict } from "./xpost/check";
import { sourceNamed } from "./xpost/gate";
import { hotAnswers, hotNoneAnswers, hotUnreadAnswers, insightFacts, majorAnswers, majorUnreadAnswers, marketAnswers, type HotRead, type MajorRead, type MarketRead, type Move } from "./xpost/market";
import { recapLines } from "./xpost/recap";
import { appendSaleOutcome } from "./xpost/sale-outcome";
import { saleLines } from "./xpost/sale-words";
import { greetingAnswers, introTemplate, modelAnswer, modelAnswers } from "./xpost/writer";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The modules whose strings are code's lines or the writer's prompts. */
const POOL_FILES = [
  "xpost/casual.ts", "xpost/market.ts", "xpost/check.ts", "xpost/sale-words.ts", "xpost/sale-outcome.ts", "xpost/recap.ts",
  "xpost/writer.ts", "xpost/replies.ts", "orchestrator-xpost.ts", "orchestrator-xpost-check.ts",
].map((f) => path.join(HERE, f));

/** Every string literal, template string and template piece in a source, comments left out. */
function literalsIn(name: string, src: string): string[] {
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
const literalsOf = (file: string) => literalsIn(file, readFileSync(file, "utf8"));

const NAMED = ["robinhood chain", "Robinhood Chain", "robin hood chain", "r0binhood chain", "R0B1NH00D CHAIN", "robinhood's chain", "coingecko", "geckoterminal", "bitquery"];

describe("code's own words never name the chain or a data provider (the owner, 2026-10-18)", () => {
  it("the screen it is held to reads every form the owner named", () => {
    for (const t of NAMED) assert.ok(sourceNamed(`quiet one on ${t} today`), t);
    // "robinhood" alone and "the chain" alone are not names.
    for (const t of ["robinhood", "the chain's trending list", "merrymen and robinhood built me, the chain is quiet"]) assert.ok(!sourceNamed(t), t);
  });

  it("no string in the pools' or the prompts' source says one", () => {
    let read = 0;
    for (const file of POOL_FILES) {
      const strings = literalsOf(file);
      assert.ok(strings.length > 10, `${path.basename(file)}: read no strings, so this check would be vacuous`);
      read += strings.length;
      for (const s of strings) assert.ok(!sourceNamed(s), `${path.basename(file)}: ${JSON.stringify(s.slice(0, 160))}`);
    }
    // The parser finds a name planted where the pools keep theirs, and skips one in a comment.
    const planted = literalsIn("planted.ts", '// robinhood chain in a comment\nconst A = ["fine", `on robinhood chain ${1} today`];\n');
    assert.ok(planted.some(sourceNamed), "a planted name is found");
    assert.ok(!planted.some((s) => s.includes("comment")), "a comment is not read");
    assert.ok(read > 1000, `read ${read} strings`);
  });

  it("no line any pool builds says one, live or paper, for any read", () => {
    const lines: string[] = [];
    const style = { lower: true };
    const seeds = ["1", "100000000000000002", "alan|2026-10-18"];
    const moves: (Move | null)[] = [null, { dir: "flat", size: null }];
    for (const dir of ["up", "down"] as const) for (const size of ["a little", "a fair bit", "sharply"] as const) moves.push({ dir, size });
    const hots: HotRead[] = [1, 2, 3].flatMap((coins) => moves.map((lead) => ({ coins, lead })));
    const majorsAll: MarketRead["majors"][] = [null, { dir: "mixed" }, { dir: "flat" }];
    for (const dir of ["up", "down"] as const) for (const size of ["a little", "a fair bit", "sharply", "uneven"] as const) majorsAll.push({ dir, size });
    const verdicts: CheckVerdict[] = ["real", "partly", "thin", "larp", "unclear"];
    const signals: CheckSignal[] = ["names-other", "names-coin", "names-none", "site-app", "site-up", "site-thin", "site-down", "no-site", "docs",
      "git-active", "git-recent", "git-quiet", "git-stale", "git-none", "git-linked-only", "git-fork", "git-empty", "git-archived", "git-new", "git-old", "git-busy",
      "holders-concentrated", "creator-heavy", "liq-thin", "coin-young"];
    const strategies = [null, ...Object.values(STRATEGY_SPOKEN)];
    for (const seed of seeds) {
      for (const paper of [false, true]) {
        const o = { paper };
        lines.push(...declineAnswers(seed, style, o), ...vibeAnswers(seed, style, o), ...chatAnswers(seed, style, o), ...reactionAnswers(seed, style, o));
        for (const s of strategies) lines.push(...selfAnswers(s, seed, style, o));
        for (const coins of [[], ["pepe"], ["pepe", "bonk"]]) lines.push(...tradesAnswers(coins, seed, style, o));
        lines.push(...greetingAnswers(seed, style, o), ...modelAnswers(seed, style, o), modelAnswer(seed, style, o));
        lines.push(...hotNoneAnswers(seed, style, o), ...hotUnreadAnswers(seed, style, o), ...majorUnreadAnswers(seed, style, o));
        for (const read of hots) lines.push(...hotAnswers(read, seed, style, o));
        for (const rank of [null, "top", "large", "mid"] as const) {
          for (const day of moves) for (const volume of [null, "heavy", "light", "ordinary"] as const) {
            const read: MajorRead = { rank, day, week: day, volume };
            lines.push(...majorAnswers(read, seed, style, o));
          }
        }
        for (const majors of majorsAll) for (const chain of [null, { coins: 0, lead: null }, ...hots]) {
          lines.push(...marketAnswers({ majors, chain }, seed, style, o));
          lines.push(...insightFacts({ day: majors, week: majors, chain, crowd: chain && chain.coins > 0 ? 1 : null }));
        }
        for (const verdict of verdicts) {
          for (let i = 0; i < signals.length; i++) {
            const read: CheckRead = { verdict, signals: [signals[i]!, signals[(i + 1) % signals.length]!], score: 0 };
            lines.push(...checkAnswers(read, seed, o), ...checkPhrases(read));
          }
          lines.push(...checkAnswers({ verdict, signals: [], score: 0 }, seed, o));
        }
        lines.push(...recapLines(seed, o));
        for (const mode of ["paper", "live", "idle"] as const) {
          let n = 0;
          for (let k = 0; k < 40; k++) lines.push(introTemplate({ agentName: "Alan Al Dale", mode, style }, () => ((n = (n * 9301 + 49297) % 233280) / 233280)));
        }
      }
      for (const parts of [2, 3] as const) {
        for (const coin of ["PEPE", "Bonk", "Tesla"]) {
          for (const line of saleLines(coin, seed, parts)) {
            lines.push(line);
            for (const outcome of ["profit", "loss", "flat", "unknown"] as const) {
              const out = appendSaleOutcome(line, outcome, outcome === "loss" ? -12.3 : 41.2);
              if (out) lines.push(out);
            }
          }
        }
      }
    }
    assert.ok(lines.length > 20_000, `built ${lines.length} lines`);
    const bad = [...new Set(lines)].filter(sourceNamed);
    assert.deepEqual(bad.slice(0, 5), [], `${bad.length} lines name a source`);
  });
});

