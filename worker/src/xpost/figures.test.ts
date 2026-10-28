/**
 * THE FIGURES LINE: only what code renders from typed numbers and clean
 * tickers, in one grammar, short enough for X with the words around it — and
 * never read back as the agent's own words.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { xWeightedLength, X_MAX_WEIGHTED } from "./client";
import {
  admitFiguresLine, cleanTicker, compactMoney, FIGURES_LINE, FIGURES_MAX, figuresTickers, neverAnsweredName, rankOf, renderFiguresLine, signedPercent,
  withFigures, withoutFiguresLine, type FiguresSpec,
} from "./figures";
import { merrymenMentioned, sherwoodMentioned } from "./gate";

const BTC: FiguresSpec = [{ kind: "major", symbol: "btc", rank: 1, priceUsd: 97_431.2, marketCapUsd: 1.93e12, volume24hUsd: 41.2e9, change24hPct: 1.234, change7dPct: -3.44 }];
const HOT: FiguresSpec = [
  { kind: "pools", coins: [{ symbol: "ABC", change24hPct: 42.07, volume24hUsd: 1.21e6 }, { symbol: "DEF", change24hPct: -8.3, volume24hUsd: 310_400 }, { symbol: "GHI", change24hPct: 5, volume24hUsd: 90_000 }] },
  { kind: "crowd", symbols: ["DEF"] },
  { kind: "trending", symbols: ["PEPE", "WIF", "TAO"] },
];
const NOTICE = "Say stop to opt out.";

describe("tickers: A-Z, two to ten letters, nothing else", () => {
  it("a clean symbol is upper-cased and kept", () => {
    assert.equal(cleanTicker("btc"), "BTC");
    assert.equal(cleanTicker("SOL"), "SOL");
    assert.equal(cleanTicker("ABCDEFGHIJ"), "ABCDEFGHIJ");
  });

  it("anything else is dropped, never repaired or echoed", () => {
    for (const bad of ["B", "ABCDEFGHIJK", "123", "$BTC", "BTC.X", "BTC 2", " BTC", "BTC​", "ΒΤC", "ВТС", "ıNCH", "straße", "🐸", "PEPE🐸", "B-TC", "", null, undefined, 42, { s: "BTC" }]) {
      assert.equal(cleanTicker(bad), null, String(bad));
    }
  });

  it("never a digit: a sum, a multiple or a copy that no code built (red-team 2026-10-12)", () => {
    // The red team's posts: "trending $100X 24h +55.5% vol ~$1.2M, $1B 24h +21% vol ~$640k, $97K 24h +3.3% vol ~$120k".
    for (const bad of ["100X", "1B", "97K", "10M", "1000X", "1INCH", "PEPE2", "USDC2", "ETH2", "S0L", "HH1488"]) assert.equal(cleanTicker(bad), null, bad);
    assert.equal(renderFiguresLine([{ kind: "pools", coins: ["100X", "1B", "97K"].map((symbol) => ({ symbol, change24hPct: 21, volume24hUsd: 640_000 })) }]), null);
    assert.equal(admitFiguresLine("trending: $1B 24h +21% vol ~$640k."), false, "nor does the grammar take one");
    for (const bad of ["MILLION", "BILLIONS", "BUCKS", "DOLLAR", "MELANIA"]) assert.equal(cleanTicker(bad), null, bad);
  });

  it("every ticker a line shows, read off it", () => {
    assert.deepEqual(figuresTickers(renderFiguresLine(HOT)), ["ABC", "DEF", "GHI", "DEF", "PEPE", "WIF", "TAO"]);
    assert.deepEqual(figuresTickers("1h buys ~$12k, sells ~$8.1k."), []);
  });

  it("never a sherwood, merrymen, robinhood or agent name, however its digits spell it", () => {
    for (const bad of ["SHERWOOD", "SHERWOOD1", "SH3RW00D", "SHRWD", "HERWOOD", "SHEROOD", "MERRY", "MERRYMEN", "HOOD", "ROBINHOOD", "ALAN", "ALANAIDALE"]) {
      assert.equal(cleanTicker(bad), null, bad);
    }
    // Whatever the gate reads as sherwood, the line never shows.
    for (const t of ["SHERW00D", "SHERWOOD", "SHERWOOOD", "5HERWOOD", "SHERWOD"]) {
      if (sherwoodMentioned(t)) assert.equal(cleanTicker(t), null, t);
    }
  });

  it("never Robin Hood's other merry men or his country: Little John, Friar Tuck, Maid Marian, Will Scarlet, the sheriff (red-team review of 1ed46625, 2026-10-12)", () => {
    // Posted at 1ed46625: "trending $LITTLEJOHN 24h +212% …, $FRIARTUCK …, $MAIDMARIAN …; fomo: most bought $LITTLEJOHN".
    for (const bad of ["LITTLEJOHN", "LITLEJOHN", "LITTLEJON", "FRIARTUCK", "FRIAR", "TUCK", "MAIDMARIAN", "MARIAN", "SCARLET", "WILLSCARLET", "NOTTINGHAM",
      "LOXLEY", "LOCKSLEY", "SHERIFF", "SHERIF", "GISBORNE"]) {
      assert.equal(cleanTicker(bad), null, bad);
      assert.ok(neverAnsweredName(bad), bad);
    }
    for (const ok of ["CHUMP", "TRUCK", "STUCK", "JOHN", "MARINA", "FROGGY"]) assert.equal(cleanTicker(ok), ok, ok);
  });

  it("never merrymen in any spelling the letters allow (red-team 2026-10-12)", () => {
    // Posted at 34ced01e: "trending $MERRIMEN 24h +12% vol ~$300k, $MERYMEN 24h +9% vol ~$200k".
    for (const bad of ["MERRYMEN", "MERRYMAN", "MERRYMEM", "MERRIMEN", "MERYMEN", "MERIMEN", "MERRMEN", "MRRYMEN", "MEERYMEN", "MRYMN", "MERR", "MERRIMAN", "merrimen"]) {
      assert.equal(cleanTicker(bad), null, bad);
      assert.ok(merrymenMentioned(bad), bad);
    }
    for (const ok of ["CHUMP", "PEPE", "MERIT", "MERCURY", "MEME", "SUMMER", "HAMMER"]) {
      assert.equal(cleanTicker(ok), ok, ok);
      assert.equal(merrymenMentioned(ok), false, ok);
    }
  });

  it("never advice or hype run together into one word (red-team 2026-10-12)", () => {
    // Posted at 34ced01e, each as "trending $<SYM> 24h +312% vol ~$1.2M".
    for (const bad of ["BUYNOW", "BUYIT", "SENDIT", "APEIN", "GOBUY", "APENOW", "SAFU", "SELLNOW", "FREEMONEY", "RISKFREE", "GUARANTEE", "BULLRUN",
      "HODL", "YOLO", "LONGIT", "SHORTIT", "BEARISH", "GETRICH", "PROFITS", "AIRDROP", "PRESALE", "ROCKET", "BUYTHEDIP"]) {
      assert.equal(cleanTicker(bad), null, bad);
    }
    for (const ok of ["CHUMP", "FROGGY", "WOJAK", "MEMECOIN", "PEPE", "TAO", "BONK"]) assert.equal(cleanTicker(ok), ok, ok);
  });

  it("never a slur, a hate code, a house, chain, agent or model name in any short form, nor advice: the red team's thirty (red-team 2026-10-12)", () => {
    // Each accepted by cleanTicker at 34ced01e, and posted as trending from the house account.
    for (const bad of ["KYS", "HEIL", "KIKE", "CHINK", "SPIC", "TRANNY", "GOOK", "WETBACK", "COON", "PEDO", "LOLI", "HAMAS", "KKK", "SIEG", "HH1488",
      "MERYMEN", "MERRIMEN", "MRYMN", "RBNHD", "ALDALE", "BUYNOW", "BUYIT", "SENDIT", "APEIN", "100X", "1000X", "FREEMONEY", "RISKFREE", "GUARANTEE", "SELLNOW",
      "HH", "SS", "ASS", "ROBNHOOD", "CLAUDE", "GROKCOIN", "OPENAI", "CHATGPT", "MELANIA", "ELON"]) {
      assert.equal(cleanTicker(bad), null, bad);
    }
    for (const ok of ["PEPE", "CHUMP", "FROGGY", "WOJAK", "BTC", "ETH", "SOL", "TAO", "BONK", "WIF", "DOGE", "LINK", "AAVE", "NEAR", "BASS", "GALA"]) {
      assert.equal(cleanTicker(ok), ok, ok);
    }
  });

  it("never the slurs, hate codes and sexual words the first list missed, nor a slur spelled on its consonants (red-team 2026-10-12)", () => {
    // Each passed cleanTicker at fbcf8756 and was posted as trending, or as fomo's most bought, from the house account.
    for (const bad of ["JIGABOO", "HOLOHOAX", "KNEEGROW", "NIBBA", "GASTHEM", "HAILHTLR", "NIQQA", "JEWBOY", "GOYIM", "ZOG", "FUHRER", "SWASTIKA", "LYNCH",
      "WHITEPRIDE", "HITLR", "SHEMALE", "DILDO", "ADOLF", "HIMMLER", "JEW", "JEWS", "NIGLET", "CUMSHOT", "SPASTIC", "NYGGA", "NIGRO", "HTLR", "FUHRR"]) {
      assert.equal(cleanTicker(bad), null, bad);
    }
    for (const ok of ["PEPE", "CHUMP", "FROGGY", "WOJAK", "BONK", "COINA", "ZAPX", "QRTZ", "MOLT", "GALA", "BASS", "MERIT"]) assert.equal(cleanTicker(ok), ok, ok);
  });

  it("never merrymen with other vowels, the trencher on its consonants, the house's provider or a model a reader knows (red-team 2026-10-12)", () => {
    // Posted at fbcf8756: "trending $MARRYMEN …, $TRNCHR …; fomo: most bought $MARRYMEN, $TRNCHR", "$MURRYMEN …, $OPUS …".
    for (const bad of ["MARRYMEN", "MURRYMEN", "MARYMEN", "MIRRYMEN", "MORRYMAN"]) {
      assert.equal(cleanTicker(bad), null, bad);
      assert.ok(merrymenMentioned(bad), bad);
    }
    for (const bad of ["TRNCHR", "TRENCHR", "TRANCHER", "GROQ", "OPUS", "SONNET", "HAIKU", "KIMI", "CODEX", "SHOGUN", "SHGN"]) assert.equal(cleanTicker(bad), null, bad);
    assert.ok(merrymenMentioned("TRNCHR"));
    for (const ok of ["CHUMP", "PEPE", "MERIT", "MERCURY", "MEME", "SUMMER", "HAMMER", "QRTZ", "ZAPX"]) {
      assert.equal(cleanTicker(ok), ok, ok);
      assert.equal(merrymenMentioned(ok), false, ok);
    }
  });

  it("never the first person, a holding, a pick or a sure thing run together into one word (red-team 2026-10-12)", () => {
    // Each posted at fbcf8756 in both sections: "trending $IBOUGHT 24h +312% vol ~$1.2M, …; fomo: most bought $IBOUGHT".
    for (const bad of ["IBOUGHT", "MYBAG", "MYPICK", "IMIN", "IHOLD", "IMHOLDING", "IGOTIN", "IADDED", "MYCOIN", "MYBOOK", "MYPLAY", "THEPLAY", "SUREBET",
      "BESTBET", "STACKIN", "ALLIN", "GETIN", "HOLDIT", "HOLD", "LOADUP", "GRAB", "JUMPIN", "NOLOSS", "CANTLOSE", "UPONLY", "GOUP", "EZMONEY", "MONEY",
      "TOPPICK", "MYBUY", "RICHES", "NEXTGEM", "EASYGAINS", "OURBAG", "WEBOUGHT", "IVEGOT", "IAMIN", "WELOVE"]) {
      assert.equal(cleanTicker(bad), null, bad);
    }
    for (const ok of ["PEPE", "CHUMP", "FROGGY", "IOTA", "ICP", "IMX", "INJ", "WOJAK", "COINA", "ZAPX", "QRTZ", "WEETH"]) assert.equal(cleanTicker(ok), ok, ok);
  });

  it("never a slur, a political name or a hype word", () => {
    for (const bad of ["NAZI", "FUCK", "TRUMP", "MAGA", "BIDEN", "PUMP", "MOON", "GEM", "SCAM", "SAFE", "LEGIT"]) assert.equal(cleanTicker(bad), null, bad);
  });
});

describe("figures, compact and signed", () => {
  it("money: ~$1.2T, ~$850M, ~$85k; under a thousand dollars is left out", () => {
    assert.equal(compactMoney(1.2e12), "~$1.2T");
    assert.equal(compactMoney(850e6), "~$850M");
    assert.equal(compactMoney(85_000), "~$85k");
    assert.equal(compactMoney(97_431.2), "~$97k");
    assert.equal(compactMoney(3_412), "~$3.4k");
    assert.equal(compactMoney(1_000), "~$1k");
    assert.equal(compactMoney(1.04e12), "~$1T", "no .0");
    assert.equal(compactMoney(9_960), "~$10k");
    assert.equal(compactMoney(999_999), "~$1M", "never ~$1000k");
    for (const none of [999.99, 0, -5_000, Number.NaN, Number.POSITIVE_INFINITY, 2e15, "5000", null]) assert.equal(compactMoney(none), null, String(none));
  });

  it("percent: an explicit sign, at most one decimal, whole from a hundred", () => {
    assert.equal(signedPercent(1.234), "+1.2%");
    assert.equal(signedPercent(-3.44), "-3.4%");
    assert.equal(signedPercent(3), "+3%");
    assert.equal(signedPercent(0), "+0%");
    assert.equal(signedPercent(-0.04), "+0%", "a rounded zero has one sign");
    assert.equal(signedPercent(150.6), "+151%");
    assert.equal(signedPercent(-99.97), "-100%");
    for (const none of [100_000, -250_000, Number.NaN, "1.2", null]) assert.equal(signedPercent(none), null, String(none));
  });

  it("rank: #1 to #999", () => {
    assert.equal(rankOf(1), "#1");
    assert.equal(rankOf(200), "#200");
    for (const none of [0, -1, 1.5, 1000, Number.NaN, "1"]) assert.equal(rankOf(none), null, String(none));
  });
});

describe("the line, rendered from typed data", () => {
  it("a coin by name or ticker: rank, price, market cap, volume, the day and the week, naming no source", () => {
    assert.equal(renderFiguresLine(BTC), "BTC #1, ~$97k, mcap ~$1.9T, vol ~$41B, 24h +1.2%, 7d -3.4%.");
  });

  it("a major under a thousand dollars shows no price", () => {
    assert.equal(renderFiguresLine([{ kind: "major", symbol: "sol", rank: 5, priceUsd: 185.2, marketCapUsd: 88e9, volume24hUsd: 4.1e9, change24hPct: -2.1, change7dPct: 6 }]),
      "SOL #5, mcap ~$88B, vol ~$4.1B, 24h -2.1%, 7d +6%.");
  });

  it("what's hot: three coins of the chain, fomo's most bought, the global trending list", () => {
    assert.equal(renderFiguresLine(HOT),
      "trending: ABC 24h +42.1% vol ~$1.2M, DEF 24h -8.3% vol ~$310k, GHI 24h +5% vol ~$90k; fomo: most bought DEF; hot: PEPE, WIF, TAO.");
  });

  it("onchain flow: both sides, or nothing", () => {
    assert.equal(renderFiguresLine([{ kind: "flow", buyUsd: 12_300, sellUsd: 8_100 }]), "1h buys ~$12k, sells ~$8.1k.");
    assert.equal(renderFiguresLine([{ kind: "flow", buyUsd: 12_300, sellUsd: 400 }]), null);
  });

  it("an unclean ticker takes its coin with it; nothing showable is no line", () => {
    assert.equal(renderFiguresLine([{ kind: "major", symbol: "B T C", rank: 1, priceUsd: 97_000 }]), null);
    assert.equal(renderFiguresLine([{ kind: "pools", coins: [{ symbol: "SHERWOOD", change24hPct: 900, volume24hUsd: 5e6 }, { symbol: "OKAY", change24hPct: 2, volume24hUsd: 60_000 }] }]),
      "trending: OKAY 24h +2% vol ~$60k.");
    assert.equal(renderFiguresLine([{ kind: "major", symbol: "BTC", rank: null, priceUsd: 900 }]), null, "a coin with no figure is no line");
    assert.equal(renderFiguresLine([{ kind: "crowd", symbols: ["🐸", "a b"] }]), null);
    assert.equal(renderFiguresLine([]), null);
  });

  it("never more than a handful: three coins, two fomo tickers, three trending, six figures", () => {
    const line = renderFiguresLine([
      { kind: "pools", coins: ["AA", "BB", "CC", "DD"].map((symbol) => ({ symbol, change24hPct: 1, volume24hUsd: 50_000 })) },
      { kind: "crowd", symbols: ["AA", "BB", "CC"] },
      { kind: "trending", symbols: ["XA", "XB", "XC", "XD"] },
      { kind: "flow", buyUsd: 5_000, sellUsd: 5_000 },
    ])!;
    assert.doesNotMatch(line, /DD|CC, \$|XD/);
    assert.doesNotMatch(line, /1h buys/, "a section past six figures is left out whole");
    assert.ok((line.match(/~\$|[+-]\d/g) ?? []).length <= FIGURES_MAX);
  });
});

describe("the grammar the validator holds an inserted line to", () => {
  it("every rendered line is admitted", () => {
    for (const spec of [BTC, HOT, [{ kind: "flow", buyUsd: 1e6, sellUsd: 2e5 }] as FiguresSpec]) {
      const line = renderFiguresLine(spec)!;
      assert.ok(admitFiguresLine(line), line);
      assert.match(line, FIGURES_LINE);
    }
  });

  it("nothing else is: a word more, a link, a handle, a lowercase ticker, a missing stop, a seventh figure", () => {
    const ok = "BTC #1, ~$97k, mcap ~$1.9T.";
    assert.ok(admitFiguresLine(ok));
    for (const bad of [
      "BTC #1, ~$97k, mcap ~$1.9T", // no full stop
      "$btc #1, ~$97k.",
      "BTC #1, ~$97k, buy now.",
      "BTC #1, ~$97k, https://x.co.",
      "BTC #1, @someone.",
      "BTC.",
      "BTC #0.",
      "BTC, ~$97.0k.",
      "BTC, ~$1000k.",
      "BTC, 24h 1.2%.",
      "BTC, 24h +1.23%.",
      "the public index: BTC #1.",
      "BTC #1, ~$97k, mcap ~$1.9T, vol ~$41B, 24h +1.2%, 7d -3.4%; 1h buys ~$1k, sells ~$1k.",
      "trending: AA 24h +1%, BB 24h +1%, CC 24h +1%, DD 24h +1%.",
      "trending: AA.",
      "Say stop to opt out.",
      "",
      null,
    ]) assert.equal(admitFiguresLine(bad), false, String(bad));
  });

  it("fuzzed specs render only admitted lines, and only the grammar's characters", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const n = () => (rnd() < 0.1 ? Number.NaN : (rnd() - 0.3) * 10 ** Math.floor(rnd() * 15));
    const sym = () => ["BTC", "eth", "S0L", "🐸", "x", "WAYTOOLONGTICKER", "SHERWOOD", "DOGE", "1INCH", "PEPE2"][Math.floor(rnd() * 10)]!;
    for (let i = 0; i < 400; i++) {
      const spec: FiguresSpec = [
        { kind: "major", symbol: sym(), rank: Math.floor(rnd() * 1200), priceUsd: n(), marketCapUsd: n(), volume24hUsd: n(), change24hPct: n(), change7dPct: n() },
        { kind: "pools", coins: [0, 1, 2, 3].map(() => ({ symbol: sym(), change24hPct: n(), volume24hUsd: n() })) },
        { kind: "crowd", symbols: [sym(), sym(), sym()] },
        { kind: "flow", buyUsd: n(), sellUsd: n() },
      ];
      const line = renderFiguresLine(spec.filter(() => rnd() < 0.7));
      if (line === null) continue;
      assert.ok(admitFiguresLine(line), line);
      assert.match(line, /^[a-z :;,.$#~%+\-0-9A-Z]+$/, line);
      assert.doesNotMatch(line, /SHERWOOD|🐸|http|@/);
    }
  });
});

describe("fitting it into the answer", () => {
  const words = "it's up a little today on coingecko and the week looks soft, not a call.";

  it("between the words and the notice, the whole line when it fits", () => {
    const r = withFigures(`${words} ${NOTICE}`, BTC);
    assert.equal(r.text, `${words} BTC #1, ~$97k, mcap ~$1.9T, vol ~$41B, 24h +1.2%, 7d -3.4%. ${NOTICE}`);
    assert.equal(r.dropped, 0);
    assert.ok(xWeightedLength(r.text) <= X_MAX_WEIGHTED);
  });

  it("words that end without a stop get one; a lowercase notice stays as written", () => {
    const r = withFigures(`its up a little today on coingecko ${NOTICE.toLowerCase()}`, BTC);
    assert.match(r.text, /^its up a little today on coingecko\. BTC #1, .* say stop to opt out\.$/);
  });

  it("too long for X: the least telling fields go first, then the line", () => {
    const long = "x".repeat(175) + " up a little on coingecko today.";
    const r = withFigures(`${long} ${NOTICE}`, BTC);
    assert.ok(xWeightedLength(r.text) <= X_MAX_WEIGHTED, String(xWeightedLength(r.text)));
    assert.ok(r.line !== null && r.dropped > 0);
    assert.doesNotMatch(r.line!, /7d/, "the week went first");
    assert.match(r.line!, /BTC #1/, "the rank goes last");
    const longer = "x".repeat(240) + " today.";
    const none = withFigures(`${longer} ${NOTICE}`, BTC);
    assert.equal(none.line, null);
    assert.equal(none.text, `${longer} ${NOTICE}`, "no form fits: the gate's text as it was");
  });

  it("what's hot sheds the global trending list, then the third coin, then fomo's, then coins, then volume, before the line", () => {
    const mid = "y".repeat(130) + ", not a call.";
    const r = withFigures(`${mid} ${NOTICE}`, HOT);
    assert.ok(r.line);
    assert.ok(xWeightedLength(r.text) <= X_MAX_WEIGHTED);
    assert.doesNotMatch(r.line!, /hot:/);
    assert.match(r.line!, /^trending: ABC/);
    // As the words grow, each shorter form in turn, and every post fits.
    const seen: (string | null)[] = [];
    for (let n = 4; n <= 270; n++) {
      const f = withFigures(`${"z".repeat(n)}. ${NOTICE}`, HOT);
      if (f.line) assert.ok(xWeightedLength(f.text) <= X_MAX_WEIGHTED, String(n));
      if (seen.at(-1) !== f.line) seen.push(f.line);
    }
    assert.deepEqual(seen, [
      renderFiguresLine(HOT),
      "trending: ABC 24h +42.1% vol ~$1.2M, DEF 24h -8.3% vol ~$310k, GHI 24h +5% vol ~$90k; fomo: most bought DEF.",
      "trending: ABC 24h +42.1% vol ~$1.2M, DEF 24h -8.3% vol ~$310k; fomo: most bought DEF.",
      "trending: ABC 24h +42.1% vol ~$1.2M, DEF 24h -8.3% vol ~$310k.",
      "trending: ABC 24h +42.1% vol ~$1.2M.",
      "trending: ABC 24h +42.1%.",
      null,
    ]);
  });

  it("no notice (someone already told they can say stop): the line goes after the words, and still fits X (2026-10-12)", () => {
    const r = withFigures(words, BTC);
    assert.equal(r.text, `${words} BTC #1, ~$97k, mcap ~$1.9T, vol ~$41B, 24h +1.2%, 7d -3.4%.`);
    assert.equal(withFigures("its up a little today on coingecko", BTC).text.startsWith("its up a little today on coingecko. BTC #1,"), true, "a stop added");
    assert.equal(withoutFiguresLine(r.text), words, "read back without its line");
    const long = "x".repeat(200) + " up a little on coingecko today.";
    const fit = withFigures(long, BTC);
    assert.ok(fit.line !== null && fit.dropped > 0 && xWeightedLength(fit.text) <= X_MAX_WEIGHTED);
    assert.equal(withFigures("x".repeat(270) + " today.", BTC).line, null, "no form fits: unchanged");
  });

  it("no words, or nothing showable: unchanged", () => {
    assert.equal(withFigures(NOTICE, BTC).line, null);
    assert.equal(withFigures("", BTC).line, null);
    assert.equal(withFigures(`${words} ${NOTICE}`, []).line, null);
    assert.equal(withFigures(`${words} ${NOTICE}`, null).text, `${words} ${NOTICE}`);
  });
});

describe("the names no line of the house's answers under (2026-10-12)", () => {
  it("its own, a model's, a slur, a hate code or a political name: on letters and consonants, as a ticker is read", () => {
    for (const name of ["MERRYMEN", "merrimen", "sherwood", "ALDALE", "GROK", "claude", "KIKE", "niglet", "kneegrow", "HEIL", "TRUMP", "maga", "elon", "HH", "KKK"]) {
      assert.equal(neverAnsweredName(name), true, name);
    }
    // The house's own products, and a run of any length (red-team 2026-10-12).
    for (const name of ["fomo", "trencher", "trenches", "TRNCHR", "shogun", "hitlerdidnothingwrong", "niggercoins", "gasthejewsnow", "donaldjtrumpcoin", "MAGAMAGAMAGA"]) {
      assert.equal(neverAnsweredName(name), true, name);
    }
    // And its digits read as the letters they stand for (red-team 2026-10-12).
    for (const name of ["H1TLER", "h1tl3r", "N1GGERCOINS", "TRUMPMAGACOIN", "K1LL", "5EX", "M3RRYMEN"]) assert.equal(neverAnsweredName(name), true, name);
    for (const name of ["BTC2", "24h", "100x", "2026", "w1f"]) assert.equal(neverAnsweredName(name), false, name);
    // Hype, a call, a holding, money and the sources it names keep a ticker out of the line, but are no reason to stay silent.
    for (const name of ["PEPE", "BTC", "moon", "LAMBO", "scam", "buy", "loading", "gainers", "bag", "million", "gecko", "bitquery", "", "toolongforaticker", "PEPE2", null]) {
      assert.equal(neverAnsweredName(name), false, String(name));
    }
    for (const name of ["moon", "LAMBO", "scam", "fomo"]) assert.equal(cleanTicker(name), null, `${name}: still never in the line`);
  });
});

describe("how's the market: the big coins' day beside the chain's movers (2026-10-12)", () => {
  const MARKET: FiguresSpec = [
    { kind: "majors", coins: [{ symbol: "btc", change24hPct: 1.234 }, { symbol: "eth", change24hPct: -0.84 }, { symbol: "sol", change24hPct: 3.08 }] },
    { kind: "pools", coins: [{ symbol: "ABC", change24hPct: 42.07 }, { symbol: "DEF", change24hPct: -8.3 }, { symbol: "GHI", change24hPct: 5 }] },
    { kind: "crowd", symbols: ["DEF"] },
  ];
  it("renders in its own grammar, each big coin by its day's change only, within the handful of figures", () => {
    const line = renderFiguresLine(MARKET)!;
    assert.equal(line, "24h: BTC +1.2%, ETH -0.8%, SOL +3.1%; trending: ABC 24h +42.1%, DEF 24h -8.3%, GHI 24h +5%; fomo: most bought DEF.");
    assert.ok(admitFiguresLine(line));
    assert.match(line, FIGURES_LINE);
    assert.deepEqual(figuresTickers(line), ["BTC", "ETH", "SOL", "ABC", "DEF", "GHI", "DEF"]);
    assert.ok((line.match(/[+-]\d/g) ?? []).length <= FIGURES_MAX);
  });
  it("a big coin with no change, a dirty ticker or one past three is left out, never shown bare; none at all is no section", () => {
    assert.equal(renderFiguresLine([{ kind: "majors", coins: [{ symbol: "btc", change24hPct: null }, { symbol: "e.th", change24hPct: 1 }, { symbol: "sol", change24hPct: -2 },
      { symbol: "bnb", change24hPct: 1 }, { symbol: "xrp", change24hPct: 1 }, { symbol: "ada", change24hPct: 1 }] }]), "24h: SOL -2%, BNB +1%, XRP +1%.");
    assert.equal(renderFiguresLine([{ kind: "majors", coins: [{ symbol: "btc" }, { symbol: "pump", change24hPct: 9 }] }]), null);
    for (const bad of ["24h: BTC.", "24h: BTC +1.2%, ETH -0.8%, SOL +3.1%, BNB +1%.", "24h: BTC ~$97k.", "24h: BTC +1.2% buy."]) {
      assert.equal(admitFiguresLine(bad), false, bad);
    }
  });
  it("too long for X: the third chain coin, fomo's, then the chain's coins go before any big coin, and the big coins last of all", () => {
    const seen: (string | null)[] = [];
    for (let n = 4; n <= 270; n++) {
      const f = withFigures(`${"z".repeat(n)}. ${NOTICE}`, MARKET);
      if (f.line) assert.ok(xWeightedLength(f.text) <= X_MAX_WEIGHTED, String(n));
      if (seen.at(-1) !== f.line) seen.push(f.line);
    }
    assert.deepEqual(seen, [
      renderFiguresLine(MARKET),
      "24h: BTC +1.2%, ETH -0.8%, SOL +3.1%; trending: ABC 24h +42.1%, DEF 24h -8.3%; fomo: most bought DEF.",
      "24h: BTC +1.2%, ETH -0.8%, SOL +3.1%; trending: ABC 24h +42.1%, DEF 24h -8.3%.",
      "24h: BTC +1.2%, ETH -0.8%, SOL +3.1%; trending: ABC 24h +42.1%.",
      "24h: BTC +1.2%, ETH -0.8%, SOL +3.1%.",
      "24h: BTC +1.2%, ETH -0.8%.",
      "24h: BTC +1.2%.",
      null,
    ]);
    // Read back without its line, notice or none.
    const posted = withFigures("big caps look perky, and the trenches feel lively. not a call, purely the tape.", MARKET).text;
    assert.equal(withoutFiguresLine(posted), "big caps look perky, and the trenches feel lively. not a call, purely the tape.");
  });
});

describe("never read back as its own words", () => {
  it("a posted answer without its line, the notice where it was", () => {
    const posted = withFigures(`its up a little today on coingecko. ${NOTICE}`, BTC).text;
    assert.equal(withoutFiguresLine(posted), `its up a little today on coingecko. ${NOTICE}`);
    const hot = withFigures(`a few movers on the index, not a call. ${NOTICE}`, HOT).text;
    assert.equal(withoutFiguresLine(hot), `a few movers on the index, not a call. ${NOTICE}`);
    assert.equal(withoutFiguresLine(`a few movers, not a call. ${renderFiguresLine(HOT)}`), "a few movers, not a call.", "with the notice already off");
  });

  it("two answers with different figures read the same, and so do two with the same figures", () => {
    const a = withFigures(`steady on coingecko today. ${NOTICE}`, BTC).text;
    const b = withFigures(`steady on coingecko today. ${NOTICE}`, [{ ...BTC[0]!, change24hPct: -9 } as FiguresSpec[number]]).text;
    assert.notEqual(a, b);
    assert.equal(withoutFiguresLine(a), withoutFiguresLine(b));
  });

  it("text that only looks like a line is left as it was", () => {
    for (const t of ["nothing here. Say stop to opt out.", "$btc #1. Say stop to opt out.", "BTC #1, buy. Say stop to opt out."]) {
      assert.equal(withoutFiguresLine(t), t);
    }
  });
});

describe("red-team review of a964a74c: political and hate copies one letter off, and their codes (2026-10-12)", () => {
  it("are never shown and never answered under", () => {
    // Each passed showTicker, cleanTicker, the gate's tickerRefusal and neverAnsweredName at a964a74c.
    for (const t of ["TRMP", "TRUMMP", "DONALD", "BRANDON", "LETSGO", "FJB", "LGB", "TREMP", "BODEN", "DJT", "KAMLA", "BIDN", "OBUMA", "PUTN", "MELANYA",
      "NETANYA", "DOLAND", "NAZY", "NATZI", "GOEBEL", "STALIN", "ZIONIST"]) {
      assert.equal(cleanTicker(t), null, t);
      assert.equal(neverAnsweredName(t), true, t);
    }
    for (const t of ["CHUMP", "ZAPX", "FROGGY", "COINA", "QRTZ", "DUMPR"]) assert.equal(cleanTicker(t), t, t);
  });
});

describe("a tragedy, terror, a faith's holy names, a drug or a notorious person is no ticker and no name the house answers under (red-team review of daaae961)", () => {
  it("each is refused, inside a ticker or whole, and everyday tickers still pass", () => {
    // Each shown as a trending chain coin, listed on coingecko, at daaae961; or declined in a laugh under "should i buy $X?".
    for (const t of ["EPSTEIN", "OSAMA", "SANDYHOOK", "COLUMBINE", "FENTANYL", "QANON", "MANGIONE", "SHOAH", "ADOLPH", "DAHMER", "UVALDE", "PIZZAGATE",
      "TWINTOWERS", "NINEELEVEN", "ALLAH", "QURAN", "MUHAMMAD", "HEROIN", "DIDDY", "KIRK", "CHARLIEKIRK", "DONJR", "MODI", "XI", "WLFI", "BABYEPSTEIN", "OSAMAINU"]) {
      assert.equal(cleanTicker(t), null, t);
      assert.equal(neverAnsweredName(t), true, t);
    }
    // The short ones only whole: they hide in everyday tickers and words.
    for (const t of ["METHOD", "LEGACY", "MODIFY", "PROXY", "KIRKBY"]) assert.notEqual(cleanTicker(t), null, t);
    for (const t of ["CHUMP", "ZAPX", "FROGGY", "ZORBX"]) assert.equal(cleanTicker(t), t, t);
  });
});

describe("no cashtag in the line: X refuses an API post with more than one (2026-10-13)", () => {
  // docs.x.com: "Posts created via the API are limited to a maximum of 1
  // cashtag (e.g. $TICKER) per post." A market answer with $BTC, $ETH and $SOL
  // in its line was refused by X with a 403 and never posted.
  const CASHTAG = /(?<![\w$])\$[A-Za-z]/;
  it("every section renders its tickers bare, and its money as ~$ figures only", () => {
    const line = renderFiguresLine([
      { kind: "majors", coins: [{ symbol: "btc", change24hPct: 1.2 }, { symbol: "eth", change24hPct: -0.8 }, { symbol: "sol", change24hPct: 3.1 }] },
      { kind: "pools", coins: [{ symbol: "ABC", change24hPct: 42.1, volume24hUsd: 1_200_000 }] },
      { kind: "crowd", symbols: ["ABC"] },
    ]);
    assert.ok(line);
    assert.doesNotMatch(line!, CASHTAG);
    assert.equal(renderFiguresLine(BTC), "BTC #1, ~$97k, mcap ~$1.9T, vol ~$41B, 24h +1.2%, 7d -3.4%.");
    for (const t of ["BTC", "ETH", "SOL", "ABC"]) assert.ok(figuresTickers(line).includes(t), t);
    assert.ok(figuresTickers(line).every((t) => /^[A-Z]{2,10}$/.test(t)), "only bare tickers, never a unit or a lower-case word");
  });
  it("the grammar refuses a ticker written as a cashtag", () => {
    assert.equal(admitFiguresLine("$BTC #1, ~$97k."), false);
    assert.equal(admitFiguresLine("24h: $BTC +1.2%, $ETH -0.8%."), false);
    assert.equal(admitFiguresLine("24h: BTC +1.2%, ETH -0.8%."), true);
  });
});

describe("no source named in the line (the owner's teammate, 2026-10-13)", () => {
  it("each section as the teammate wrote it: a major, the big coins' day, the chain's trending, the global list, the hour's flow", () => {
    assert.equal(renderFiguresLine([{ kind: "major", symbol: "eth", rank: 2, priceUsd: 3_412, marketCapUsd: 411e9, volume24hUsd: 18e9, change24hPct: 1.2, change7dPct: -3.4 }]),
      "ETH #2, ~$3.4k, mcap ~$411B, vol ~$18B, 24h +1.2%, 7d -3.4%.");
    assert.equal(renderFiguresLine([{ kind: "majors", coins: [{ symbol: "btc", change24hPct: 1.2 }, { symbol: "eth", change24hPct: -0.8 }, { symbol: "sol", change24hPct: 3.1 }] }]),
      "24h: BTC +1.2%, ETH -0.8%, SOL +3.1%.");
    assert.equal(renderFiguresLine([{ kind: "pools", coins: [{ symbol: "abc", change24hPct: 42.1, volume24hUsd: 1.2e6 }] }]), "trending: ABC 24h +42.1% vol ~$1.2M.");
    assert.equal(renderFiguresLine([{ kind: "trending", symbols: ["aa", "bb"] }]), "hot: AA, BB.");
    assert.equal(renderFiguresLine([{ kind: "flow", buyUsd: 12_300, sellUsd: 8_100 }]), "1h buys ~$12k, sells ~$8.1k.");
    assert.equal(renderFiguresLine([{ kind: "crowd", symbols: ["abc"] }]), "fomo: most bought ABC.", "fomo's attribution stays");
  });

  it("no rendered line, whole or shortened, ever says coingecko, geckoterminal or bitquery, nor carries a cashtag", () => {
    const specs: FiguresSpec[] = [BTC, HOT, [{ kind: "flow", buyUsd: 9_000, sellUsd: 4_000 }],
      [{ kind: "majors", coins: [{ symbol: "btc", change24hPct: 1 }, { symbol: "eth", change24hPct: 2 }] }, ...HOT]];
    for (const spec of specs) {
      for (let n = 4; n <= 260; n += 3) {
        const f = withFigures(`${"w".repeat(n)}.`, spec);
        if (!f.line) continue;
        assert.doesNotMatch(f.line, /gecko|bitquery|robinhood/i, f.line);
        assert.doesNotMatch(f.line, /\$[A-Za-z]/, f.line);
      }
    }
  });

  it("the old source-named forms are no line at all: the validator holds only the new grammar", () => {
    for (const old of ["coingecko: BTC #1, ~$97k.", "coingecko 24h: BTC +1.2%, ETH -0.8%.", "geckoterminal robinhood: trending ABC 24h +42.1%.",
      "coingecko: trending PEPE, WIF.", "bitquery: 1h buys ~$12k, sells ~$8.1k."]) {
      assert.equal(admitFiguresLine(old), false, old);
    }
    assert.equal(admitFiguresLine("BTC."), false, "a ticker with no figure is no section");
    assert.equal(admitFiguresLine("hot: PEPE; BTC #1."), true);
  });
});

describe("a larp check's figures", () => {
  it("renders a project's github and holders in the line's own grammar", () => {
    const line = renderFiguresLine([{ kind: "git", pushedDaysAgo: 2.4, commits30d: 14, stars: 41, repoAgeDays: 200 }, { kind: "holders", top10Pct: 41.3, creatorPct: 2.6 }]);
    assert.equal(line, "github: last push 2d ago, 14 commits in 30d, 41 stars, repo 7mo old; top10 hold 41%, creator 3%.");
    assert.ok(admitFiguresLine(line));
  });
  it("says a full page of commits as a floor, a push today as today, and one of each in the singular", () => {
    assert.equal(renderFiguresLine([{ kind: "git", pushedDaysAgo: 0.2, commits30d: 100, commitsPartial: true, stars: 1 }]), "github: last push today, 100+ commits in 30d, 1 star.");
    assert.equal(renderFiguresLine([{ kind: "git", pushedDaysAgo: 800, commits30d: 1 }]), "github: last push 2y ago, 1 commit in 30d.");
  });
  it("shows no github section without its last push, and no holders without the top ten", () => {
    assert.equal(renderFiguresLine([{ kind: "git", pushedDaysAgo: null, commits30d: 5 }]), null);
    assert.equal(renderFiguresLine([{ kind: "holders", top10Pct: null, creatorPct: 5 }]), null);
  });
  it("drops the holders, then the repo's age, stars and commits to fit, and keeps the push", () => {
    const words = "w".repeat(200);
    const r = withFigures(words, [{ kind: "git", pushedDaysAgo: 3, commits30d: 9, stars: 12, repoAgeDays: 40 }, { kind: "holders", top10Pct: 50, creatorPct: 1 }]);
    assert.ok(r.line === null || r.line.startsWith("github: last push 3d ago"));
    const short = withFigures("site is up, repo is busy.", [{ kind: "git", pushedDaysAgo: 3, commits30d: 9, stars: 12, repoAgeDays: 40 }, { kind: "holders", top10Pct: 50, creatorPct: 1 }]);
    assert.equal(short.dropped, 0);
    assert.equal(withoutFiguresLine(short.text), "site is up, repo is busy.");
  });
  it("refuses a github line in any other shape", () => {
    for (const bad of ["github: last push 3d ago, 100 commits in 30d.", "github: last push soon.", "github: last push 3d ago, see github.com/x.", "top10 hold 101%."]) {
      assert.equal(admitFiguresLine(bad), false, bad);
    }
  });
});
