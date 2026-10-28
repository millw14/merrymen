/**
 * THE FIGURES LINE, BUILT BY CODE (the owner's decision, 2026-10-12): an
 * active agent's answer may carry market figures, AiXBT-style, but only ones
 * code built from a provider's typed numbers. The model still writes no
 * digit at all (the X gate's has-digits rule does not move); this line is
 * put in AFTER the gate admitted the words, at the end of the answer (an
 * answer carries no opt-out notice: the owner's decision, 2026-10-12), and it
 * is held to its own grammar here, so nothing but what these functions render
 * can ever stand where it stands.
 *
 *   BTC #1, ~$97k, mcap ~$1.9T, vol ~$41B, 24h +1.2%, 7d -3.4%.
 *   trending: ABC 24h +42.1% vol ~$1.2M; fomo: most bought ABC.
 *
 * NO SOURCE NAMED (the owner's teammate, 2026-10-13): the line never says
 * coingecko, geckoterminal or bitquery, and nothing else posted by an active
 * owner does either (gate.ts XGateCtx.house, "source-named"). Fomo's own
 * section keeps "fomo:": the owner holds Enterprise rights to paraphrased,
 * attributed Fomo facts.
 *
 * WHAT GOES IN IS TYPED DATA, NEVER TEXT. A provider's numbers, and of its
 * words only a ticker that passes `cleanTicker`: A-Z, two to ten letters,
 * never a digit, nothing else. Anything else is dropped,
 * never echoed, never repaired: a symbol with a space, a dot, an emoji, a
 * lowercase look-alike from another alphabet or eleven characters is not
 * shown at all. A ticker that spells sherwood, merrymen, robinhood or the
 * agent's own name, a slur, a political name or a hype word is dropped too:
 * under an answer from Merrymen's own account it would read as Merrymen
 * speaking for that coin.
 *
 * THE GRAMMAR (FIGURES_LINE below, pinned by figures.test.ts):
 *   money    ~$ then 1-999 or 1.1-9.9, then k, M, B or T. Under a thousand
 *            dollars is left out, never shown.
 *   percent  an explicit sign, then at most one decimal (below 100) or a whole
 *            number, then %: +1.2%, -38%, +0%.
 *   rank     #1 to #999.
 *   sections a ticker alone at the head (one coin's rank, price, market
 *            cap, 24h volume, 24h and 7d change), "24h:" (up to three big
 *            coins, each its day's change: the market overview, 2026-10-12),
 *            "trending:" (up to three of the chain's coins, each its 24h
 *            change and volume), "fomo: most bought" (up to two tickers),
 *            "hot:" (up to three tickers of the global trending list), "1h"
 *            (a coin's buys and sells in money), joined by "; ", ending with
 *            ".". At most six figures in all: a handful.
 *
 * TOO LONG FOR X, FIELDS GO FIRST, THEN THE LINE (`withFigures`): the least
 * telling field is dropped, then the next, and when no form of the line fits
 * X's weighted 280 with the words, the answer goes out as the
 * gate admitted it, with no line.
 *
 * NEVER WHAT THE MODEL READS AS ITS OWN WORDS. A posted answer keeps its line
 * (it is what X published), but every prompt and every echo check reads it
 * without it (`withoutFiguresLine`): the model is never shown a figure it
 * could repeat as its own, two answers are never a repeat because their
 * figures match, and never "not a repeat" because their figures differ.
 *
 * Pure: no I/O, no clock, no model, no provider.
 */
import { xWeightedLength, X_MAX_WEIGHTED } from "./client";
import { answerWord } from "./words";

// ── the pieces ──────────────────────────────────────────────────────────────

/** At most this many figures (money, percent, rank) in one line: a handful. */
export const FIGURES_MAX = 6;
/** Coins one trending section shows, Fomo's tickers, CoinGecko's trending tickers. */
export const POOLS_MAX = 3;
/** The big coins one market overview shows, each by its day's change: bitcoin, ether, solana. */
export const MAJORS_MAX = 3;
export const CROWD_MAX = 2;
export const TRENDING_MAX = 3;
/** Coins a recap's line names. */
export const TRADED_MAX = 3;
/** The most trades of one side a recap counts: past this it is no recap but a feed. */
const RECAP_COUNT_MAX = 999;

/**
 * WORDS A TICKER MAY NOT SPELL, read on its letters. Merrymen's own names and
 * its model's, the agent's, the chain's and its stock token's; slurs and
 * profanity; political names; hype; a sum of money in words ("MILLION",
 * "BUCKS"). Errs toward dropping: "SKILL" holds "kill" and is left out, which
 * costs one ticker in one line.
 */
/**
 * The names no line of the house's answers under (NEVER_ANSWERED below): its
 * own, its agent's and its chain's, a model's or a provider's, a slur, a hate
 * code, a political name. The rest of TICKER_REFUSED (its products and
 * sources, hype, a call, a holding, money in words) only keeps a ticker out of
 * the figures line.
 */
const HOUSE_NAMES: readonly string[] = [
  // its own house, in any spelling the letters allow ("MERRIMEN", "MERYMEN", "MRYMN": red-team 2026-10-12)
  "s+h+e*r+w+o*d", "h+e+r+w+o+d", "s+h+e*r+o{2,}d", "sherw", "merry", "merr", "m+[aeiouy]*r+[aeiouy]*m+[aeiouy]*n", "robinhood", "robin", "hood", "alan", "aidale",
  // and the chain's and the agent's names however they are shortened ("RBNHD", "ALDALE": red-team 2026-10-12)
  "r+o*b+[iy]*n+h+o*d", "rbnhd", "aldale", "dale",
  // AND ROBIN HOOD'S OTHER MERRY MEN AND HIS COUNTRY (red-team review of 1ed46625, 2026-10-12): "trending $LITTLEJOHN 24h +212%, $FRIARTUCK …,
  // $MAIDMARIAN …; fomo: most bought $LITTLEJOHN" went out from the account of Alan-a-Dale of merrymen. ("TUCK" whole only: "stuck", "truck".)
  "l+[iy]+t+l+e*j+o+h*n", "f+r+[iy]+a+r", "m+a+r+[iy]+a+n", "s+c+a+r+l+e+t", "n+o+t+[iy]*n+g+h+a+m", "l+o+x+l+e*y", "l+o+c+k+s+l+e*y", "s+h+e+r+[iy]+f",
  "gisborne", "gamwell",
  // the model and provider names a tag may never get code's lines under (orchestrator-xpost-research.ts MODEL_LETTERS)
  "gpt", "claude", "grok", "gemini", "llama", "qwen", "deepseek", "mistral", "openai", "anthropic", "copilot", "perplexity", "llm",
  // and the house's own provider and the models a reader knows it by, in any spelling ("$GROQ", "$OPUS": red-team 2026-10-12)
  "groq", "opus", "sonnet", "haiku", "kimi", "codex", "mixtral", "cohere", "ollama", "nemotron", "minimax", "gemma", "xai", "openrouter", "cerebras",
];
/** The house's own products ("$TRENCHER", "$FOMO", "$TRNCHR": red-team 2026-10-12). */
const HOUSE_OWN_PRODUCTS: readonly string[] = [
  "trench", "fomo", "shogun", "t+[aeiouy]*r+[aeiouy]*n+[aeiouy]*c+h+[aeiouy]*r", "shgn", "sh+[aeiouy]*g+[aeiouy]*n",
];
// and the sources it names
const HOUSE_PRODUCTS: readonly string[] = [...HOUSE_OWN_PRODUCTS, "pons", "gecko", "bitquery"];
const ABUSE_AND_POLITICS: readonly string[] = [
  // abuse
  "fuck", "fuk", "shit", "cunt", "nigg", "fag", "nazi", "hitler", "rape", "porn", "sex", "nude", "cock", "dick", "puss", "bitch", "whore", "slut", "retard", "kill", "isis", "jihad", "terror",
  // AND EVERY SLUR AND HATE CODE A DEPLOYER MAY NAME A POOL (red-team 2026-10-12): "$KYS", "$KIKE",
  // "$CHINK", "$KKK", "$HEIL" were posted as trending coins from the house account.
  "kys", "kike", "kyke", "chink", "spic", "tranny", "trannie", "gook", "wetback", "coon", "pedo", "paedo", "loli", "shota", "niga", "nigr", "negro",
  "dyke", "spaz", "beaner", "raghead", "towelhead", "paki", "cuck", "incel", "rapist", "molest", "csam", "hamas", "hezbollah", "taliban", "qaeda",
  "kkk", "sieg", "heil", "aryan", "whitepower", "wpww", "suicid", "selfharm", "murder", "massacre", "genocide", "holocaust", "bomb", "shooting",
  "anal", "anus", "tits", "boob", "penis", "vagina", "milf", "hentai", "onlyfans", "xxx", "horny", "nsfw", "jizz", "wank", "twat", "arse", "asshole",
  // AND THE ONES THAT LIST MISSED (red-team 2026-10-12): "$FUHRER", "$GOYIM", "$NIGLET", "$JIGABOO",
  // "$HOLOHOAX", "$KNEEGROW", "$NIBBA", "$GASTHEM", "$HAILHTLR", "$ADOLF", "$CUMSHOT" were posted as
  // trending from the house account. Errs toward dropping: "JEWEL" holds "jew", "SCUM" and
  // "ACCUM" hold "cum", "KNIGHT" holds "nig"; each costs one ticker in one line.
  "nig", "niq", "nyg", "nibb", "negr", "kneegr", "jigab", "jiggab", "jigga", "porchmonk", "pickaninn", "golliwog", "sambo", "darkie", "darky",
  "jew", "goy", "zog", "hymie", "heeb", "yid", "shylock", "holohoax", "hoax", "sixmil", "gasthe", "gaskike", "oven", "zyklon", "auschwitz", "dachau",
  "fuhrer", "fuehrer", "fhrer", "hitl", "htlr", "hilter", "adolf", "himmler", "goebbel", "mengele", "eichmann", "gestapo", "waffen", "nsdap", "reich",
  "swastik", "svastik", "lynch", "noose", "klan", "klux", "whitepride", "rahowa", "groyper", "proudboy", "boogaloo", "fourteenwords", "allahu",
  "wigger", "gypsy", "gyp", "chinaman", "zipperhead", "kaffir", "kafir", "mongoloid", "spastic", "spazz", "tard", "cracker", "honky", "redskin",
  "squaw", "injun", "gringo", "kraut", "cameljock", "sandnig", "homo", "lesbo", "faggot", "trann", "shemale", "ladyboy",
  "cum", "dildo", "orgy", "orgasm", "blowjob", "handjob", "boner", "erection", "nipple", "semen", "sperm", "creampie", "bukkake", "gangbang",
  "threesome", "fetish", "bdsm", "bondage", "stripper", "hooker", "escort", "camgirl", "incest", "bestial", "zoophil", "necrophil", "phuck", "fvck",
  "fck", "kunt", "biatch", "pussy",
  // politics
  "trump", "melania", "biden", "maga", "kamala", "harris", "obama", "putin", "zelensk", "election", "president", "vote",
  "barron", "ivanka", "vance", "pelosi", "desantis", "rfk", "kennedy", "milei", "bukele", "jinping", "netanyahu", "bibi", "khamenei", "erdogan",
  "musk", "elon", "israel", "palestin", "gaza", "ukrain", "russia", "antifa", "woke", "democrat", "republican", "commie", "communis", "fascis",
  // AND THE POLITICAL AND HATE NAMES SPELLED ONE LETTER OFF, AND THEIR NICKNAMES AND
  // CODES (red-team review of a964a74c, 2026-10-12): "$TRMP", "$TRUMMP", "$TREMP",
  // "$DONALD", "$DOLAND", "$BIDN", "$BODEN", "$KAMLA", "$OBUMA", "$PUTN", "$MELANYA",
  // "$NETANYA", "$NATZI", "$NAZY", "$GOEBEL", "$FJB", "$LGB", "$LETSGO", "$BRANDON" and
  // "$DJT" passed every screen, and code posted "trending $NATZI 24h +80%, $TRMP 24h +70%"
  // in "how's the market" and "what's hot". Each read on the letters, with the vowels
  // and the doubled letters a copy plays with left loose.
  "t+r+[aeiouy]*m+p", "d[aeiou]?n[aeiou]?ld", "d[aeiou]?l[aeiou]?nd", "b[iy]+d[eiy]*n(?!g)", "boden", "k+a+m+a*l+a", "ob[aeiou]m[aeiou]", "pu+t[iy]*n",
  "m[ae]l[aeiou]n[iy]a", "netany", "n[aeiou]+t?z+[iy]", "go[e]?b+[e]?l", "fjb", "lgb", "letsgo", "brandon", "djt",
  // and the dictators, movements and groups the first list missed (red-team review of a964a74c: "$ZIONIST", "$STALIN")
  "zionis", "stalin", "lenin", "zedong", "maotse", "houthi", "intifada", "idf", "mussolini", "pinochet", "kimjong", "jongun",
];
/**
 * AND A TRAGEDY, TERROR, A FAITH'S HOLY NAMES, A DRUG OR A NOTORIOUS PERSON
 * (red-team review of daaae961, 2026-10-12). With CoinGecko listing each
 * contract, "how's the market?" and "what's hot?" posted "geckoterminal
 * robinhood: trending $EPSTEIN 24h +312%, $OSAMA 24h +88%, $SANDYHOOK 24h
 * +41%" from the house account, and the same for COLUMBINE, FENTANYL, QANON,
 * MANGIONE, SHOAH, ADOLPH, DAHMER, UVALDE and PIZZAGATE; and "should i buy
 * $SANDYHOOK?" was declined in a laugh. Whoever deploys a token names it, so
 * no list is whole: these are the classes the review found, read inside a
 * ticker like the rest. The short or everyday ones ("meth" hides in
 * "something", "gacy" in "legacy", "modi" in "modify") are refused only
 * whole (TICKER_REFUSED_WHOLE).
 */
const TRAGEDY_AND_NOTORIETY: readonly string[] = [
  // mass shootings, attacks and atrocities
  "sandyhook", "uvalde", "columbine", "parkland", "twintower", "nineeleven", "christchurch", "utoya", "bataclan", "hiroshima", "nagasaki", "chernobyl",
  "shoah", "holodomor", "nakba", "unabomber", "mcveigh", "breivik", "tarrant", "kaczynski",
  // terror
  "osama", "binladen", "laden", "baghdadi", "zarqawi", "alqaida", "alshabaab", "bokoharam", "jihadi",
  // a faith's holy names, books and places
  "allah", "quran", "koran", "muhammad", "mohammed", "mohammad", "prophet", "jesus", "christ", "yahweh", "jehovah", "messiah", "buddha", "krishna",
  "vishnu", "bible", "torah", "talmud", "mecca", "kaaba", "vatican", "satan", "lucifer",
  // drugs
  "fentanyl", "fentanil", "heroin", "cocaine", "cocain", "opioid", "opium", "oxycontin", "oxycodone", "xanax", "ketamine", "methamphet",
  // notorious people and conspiracies
  "epstein", "diddy", "dahmer", "mangione", "luigi", "manson", "bundy", "escobar", "elchapo", "saddam", "gaddafi", "qaddafi", "adolph",
  "rittenhouse", "chauvin", "georgefloyd", "floyd", "charliekirk", "andrewtate", "bankman", "dokwon", "qanon", "pizzagate", "donjr", "wlfi",
];

const HYPE_AND_MONEY: readonly string[] = [
  // hype and trust words
  "pump", "moon", "gem", "lambo", "scam", "rug", "safe", "legit", "official",
  // AND ADVICE AND HYPE RUN TOGETHER INTO ONE WORD (red-team 2026-10-12):
  // "$BUYNOW", "$SENDIT", "$APEIN", "$GOBUY", "$SAFU" read as a call in the
  // house's own line; the gate's word screen never sees inside one token.
  "buy", "sell", "send", "ape", "lfg", "wagmi", "ngmi", "nfa", "dyor", "bull", "bear", "rich", "safu", "hodl", "yolo", "long", "short",
  "alert", "signal", "entry", "target", "profit", "gain", "rekt", "shill", "free", "risk", "guarant", "winner", "winning", "invest",
  "airdrop", "presale", "giveaway", "bonus", "claim", "rocket", "dip",
  // AND A HOLDING, A PICK OR A SURE THING RUN TOGETHER (red-team 2026-10-12): "$IBOUGHT", "$MYBAG",
  // "$THEPLAY", "$SUREBET", "$GETIN", "$HOLDIT", "$NOLOSS", "$UPONLY", "$EZMONEY", "$TOPPICK" were
  // posted in the house's line, reading as Alan claiming a buy, a bag or a pick.
  "bought", "bag", "pick", "hold", "play", "bet", "getin", "gotin", "allin", "imin", "loadup", "load", "grab", "jump", "noloss", "nolose",
  "cantlose", "uponly", "onlyup", "goup", "money", "cash", "stack", "surewin", "added",
  // money in words: "$MILLION" beside "~$1.2M" reads as a sum code never built
  "million", "billion", "trillion", "thousand", "hundred", "dollar", "bucks", "cents", "usd",
];
const TICKER_REFUSED = new RegExp([...HOUSE_NAMES, ...HOUSE_PRODUCTS, ...ABUSE_AND_POLITICS, ...TRAGEDY_AND_NOTORIETY, ...HYPE_AND_MONEY].join("|"));
/**
 * The house's own names and its own products' ("fomo", "trencher": red-team
 * 2026-10-12), a model's, a slur, a hate code or a political name: what no
 * line of the house's answers under. The sources it reads (coingecko,
 * bitquery, pons) are no such name.
 */
const NEVER_ANSWERED = new RegExp([...HOUSE_NAMES, ...HOUSE_OWN_PRODUCTS, ...ABUSE_AND_POLITICS, ...TRAGEDY_AND_NOTORIETY].join("|"));

/** Words too short to read inside other tickers, refused only whole: "ASS", "CUM", "JAP", "DIE", "HH", "SS", "WOP". */
const TICKER_REFUSED_WHOLE: ReadonlySet<string> = new Set(("ASS CUM JAP DIE HH SS WOP FAP KMS NAMBLA HOE NIP CP TUCK " +
  // and the short or everyday names of TRAGEDY_AND_NOTORIETY's classes, whole only
  "WTC METH OXY LSD MDMA COKE CRACK WEED KIRK TATE GACY MODI XI SBF POPE").split(" "));

/**
 * AND ON ITS CONSONANTS (red-team 2026-10-12): a slur spelled without its
 * vowels, or with other ones, is the same slur to a reader ("KNEEGROW",
 * "HAILHTLR", "NIBBA", "NIQQA"). A ticker's letters with every vowel and y
 * taken out are read against the slurs' own consonants. Errs toward
 * dropping: "ANGER" and "FINGER" carry n-g-r and are left out.
 */
const SKELETON_REFUSED = /n+g+r|n+g{2,}|n+q{2,}|n+b{2,}|h+t+l+r|f+h+r+r|g+s+t+h+m|k+k+k/;
const skeletonOf = (lower: string): string => lower.replace(/[aeiouy]/g, "");

/**
 * THE FIRST PERSON RUN INTO A TICKER (red-team 2026-10-12): "$MYBAG",
 * "$MYCOIN", "$IHOLD", "$IMIN", "$IMHOLDING", "$IGOTIN" beside figures in
 * the house's own line read as Alan saying it holds or bought the coin. A
 * ticker that starts with MY or OUR is never shown, nor one that is I, IM, IAM,
 * IVE, WE or WEARE before an everyday word (words.ts answerWord) or a word of a
 * claim. Errs toward dropping: "MYTH" goes too.
 */
const FIRST_PERSON = /^(?:my|our)/;
const CLAIMS: ReadonlySet<string> = new Set("got gotin add added aped ape buy buying bought in am on won win love like call called said own have had bag bagged long short".split(" "));
function firstPerson(lower: string): boolean {
  if (FIRST_PERSON.test(lower)) return true;
  for (const p of ["i", "im", "iam", "ive", "we", "weare"]) {
    const rest = lower.slice(p.length);
    if (lower.startsWith(p) && rest.length >= 2 && (CLAIMS.has(rest) || answerWord(rest))) return true;
  }
  return false;
}

/**
 * A PROVIDER'S SYMBOL AS THE LINE MAY SHOW IT, or null. Exactly A-Z and a-z,
 * two to ten of them, read before anything is changed (a Turkish dotless i or
 * a German sharp s never becomes a capital by upper-casing): then upper-cased.
 * Nothing else is trimmed, folded or repaired, and a refused word
 * (TICKER_REFUSED) is null too.
 *
 * NO DIGIT AT ALL (red-team 2026-10-12): "$1B", "$97K" and "$100X" were posted
 * as trending coins, reading as sums and a multiple that no code built and
 * the FIGURE count never saw; "$USDC2" as a dollar. A ticker with a digit is
 * never shown, nor one the X gate would refuse as a word (gate.ts
 * tickerRefusal, which the orchestrator runs on every ticker of the line).
 */
export function cleanTicker(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^[A-Za-z]{2,10}$/.test(raw)) return null;
  const t = raw.toUpperCase();
  const lower = t.toLowerCase();
  return TICKER_REFUSED.test(lower) || TICKER_REFUSED_WHOLE.has(t) || SKELETON_REFUSED.test(skeletonOf(lower)) || firstPerson(lower) ? null : t;
}

/**
 * A NAME NO LINE OF THE HOUSE'S ANSWERS UNDER (2026-10-12), read on its
 * letters and its consonants: its own, its agent's or its chain's, its
 * products', a model's or a provider's, a slur, a hate code, a political
 * name. Narrower than cleanTicker, which also keeps hype, a call, a holding
 * and money in words out of the figures line: an advice tag is all hype
 * words, and is still declined. What orchestrator-xpost-research.ts
 * unshowableName reads every word of a tag with before code's casual lines go
 * up under it. Errs toward refusing, as cleanTicker does.
 *
 * ANY LENGTH (red-team review, 2026-10-12): only two to ten letters were read,
 * so "hitlerdidnothingwrong", "niggercoins", "gasthejewsnow" and
 * "donaldjtrumpcoin" were no name at all and got code's decline. A run of
 * letters of any length is searched for every such name inside it.
 *
 * AND WITH ITS DIGITS READ AS THE LETTERS THEY STAND FOR (red-team review,
 * 2026-10-12): "$H1TLER" was read as "tler", and declined. A run of letters
 * and digits is read with 0 as o, 1 as i, 3 as e, 4 as a, 5 as s and 7 as t,
 * any other digit dropped ("$PEPE2" is "pepe").
 */
const DIGIT_LETTER: Readonly<Record<string, string>> = Object.freeze({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" });
export function neverAnsweredName(raw: unknown): boolean {
  if (typeof raw !== "string" || !/^[A-Za-z0-9]{2,}$/.test(raw) || !/[A-Za-z]/.test(raw)) return false;
  const lower = raw.toLowerCase().replace(/[0-9]/g, (d) => DIGIT_LETTER[d] ?? "");
  if (lower.length < 2) return false;
  return NEVER_ANSWERED.test(lower) || TICKER_REFUSED_WHOLE.has(lower.toUpperCase()) || SKELETON_REFUSED.test(skeletonOf(lower));
}

/**
 * Every ticker a rendered line shows. Tickers are bare capitals: X refuses an
 * API post with more than one cashtag, so the line never writes a $ before a
 * ticker; every other word in the grammar is lower case, and a unit (the M of
 * ~$1.2M) always follows a digit.
 */
export function figuresTickers(line: unknown): string[] {
  return typeof line === "string" ? [...line.matchAll(/(?<![\w~$.])([A-Z]{2,10})(?!\w)/g)].map((m) => m[1]!) : [];
}

const UNITS: readonly [number, string][] = [[1e3, "k"], [1e6, "M"], [1e9, "B"], [1e12, "T"]];

/**
 * MONEY, COMPACT: ~$97k, ~$3.4k, ~$850M, ~$1.9T. One decimal below ten of a
 * unit, whole numbers above, the next unit at a thousand. Under a thousand
 * dollars, or past a thousand trillion, or not a finite number: null, and the
 * field is left out.
 */
export function compactMoney(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1000) return null;
  for (let i = UNITS.length - 1; i >= 0; i--) {
    const [unit, name] = UNITS[i]!;
    if (v < unit) continue;
    const s = v / unit;
    const tenths = Math.round(s * 10) / 10;
    let text: string;
    if (tenths < 10) text = Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
    else {
      const whole = Math.round(s);
      if (whole >= 1000) {
        // Rounded up into the next unit: 999,999 is ~$1M, never ~$1000k.
        if (i === UNITS.length - 1) return null;
        return `~$1${UNITS[i + 1]![1]}`;
      }
      text = String(whole);
    }
    return `~$${text}${name}`;
  }
  return null;
}

/**
 * A CHANGE, WITH ITS SIGN: +1.2%, -3.4%, +38%, +0%. One decimal below a
 * hundred, whole numbers from there; ".0" never written. Not a finite number,
 * or a move of a hundred thousand percent or more (an indexer's artefact):
 * null.
 */
export function signedPercent(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) >= 100_000) return null;
  const r = Math.abs(v) < 99.95 ? Math.round(v * 10) / 10 : Math.round(v);
  const abs = Math.abs(r);
  if (abs >= 100_000) return null;
  const sign = r < 0 ? "-" : "+";
  return `${sign}${Number.isInteger(abs) ? String(abs) : abs.toFixed(1)}%`;
}

/** Whole days as a span: "3d", "2w", "5mo", "2y". Null for anything that is not a whole, sane number of days. */
function spanOf(days: unknown): string | null {
  if (typeof days !== "number" || !Number.isFinite(days) || days < 1 || days > 36_500) return null;
  const d = Math.floor(days);
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.round(d / 7)}w`;
  if (d < 730) return `${Math.min(99, Math.round(d / 30))}mo`;
  return `${Math.min(99, Math.round(d / 365))}y`;
}
/** Days since: "today" under a day, else a span and "ago". */
function agoOf(days: unknown): string | null {
  if (typeof days !== "number" || !Number.isFinite(days) || days < 0) return null;
  if (days < 1) return "today";
  const span = spanOf(days);
  return span ? `${span} ago` : null;
}
/** Commits in the window: "1 commit", "14 commits", "100+ commits" when the page filled. */
function commitsOf(n: unknown, partial: boolean): string | null {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 100) return null;
  // A full page is a floor however it was flagged: never "100 commits", always "100+".
  if (partial || n >= 100) return n >= 100 ? "100+ commits" : `${n} commit${n === 1 ? "" : "s"}`;
  return `${n} commit${n === 1 ? "" : "s"}`;
}
function starsOf(n: unknown): string | null {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 999_999 ? `${n} star${n === 1 ? "" : "s"}` : null;
}
/** A share of supply, whole percent, 0 to 100. */
function shareOf(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? `${Math.round(v)}%` : null;
}

/** A market-cap rank: #1 to #999. */
export function rankOf(v: unknown): string | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 999 ? `#${v}` : null;
}

// ── the data ────────────────────────────────────────────────────────────────

/** One section of the line: what one source showed, as numbers and tickers only. */
export type FiguresSection =
  /** A coin by name or ticker, from CoinGecko's markets: "BTC #1, ~$97k, mcap …". */
  | { kind: "major"; symbol: string; rank?: number | null; priceUsd?: number | null; marketCapUsd?: number | null; volume24hUsd?: number | null; change24hPct?: number | null; change7dPct?: number | null }
  /** The big coins' day, from CoinGecko's markets: "24h: BTC +1.2%, ETH -0.8%, SOL +3.1%" (the market overview). */
  | { kind: "majors"; coins: { symbol: string; change24hPct?: number | null }[] }
  /** Robinhood Chain coins trending on GeckoTerminal that cleared the fleet's floors. */
  | { kind: "pools"; coins: { symbol: string; change24hPct?: number | null; volume24hUsd?: number | null }[] }
  /** The coins most Fomo traders bought in the window, by ticker only. */
  | { kind: "crowd"; symbols: string[] }
  /** CoinGecko's own trending list, by ticker only. */
  | { kind: "trending"; symbols: string[] }
  /** One coin's last hour of onchain flow, from Bitquery: buys and sells in money. */
  | { kind: "flow"; buyUsd?: number | null; sellUsd?: number | null }
  /**
   * A PROJECT'S GITHUB, as a larp check read it (research/github.ts): days
   * since its last push, commits in thirty days (a floor when `commitsPartial`),
   * stars, and the repo's age in days. Names no coin, so it may stand beside a
   * drafted answer, as a coin's flow may.
   */
  | { kind: "git"; pushedDaysAgo: number | null; commits30d?: number | null; commitsPartial?: boolean; stars?: number | null; repoAgeDays?: number | null }
  /** A coin's holders as the index counts them: the top ten's share and the creator's. Names no coin. */
  | { kind: "holders"; top10Pct: number | null; creatorPct?: number | null }
  /**
   * AN ACTIVE AGENT'S RECAP OF A BURST OF TRADES (planner.ts planRecap,
   * 2026-10-14): how many buys and sales, how many of the sales closed in
   * profit and at a loss (receipt-backed outcomes only), and the best measured
   * gain among them. Counts of its own trades, never a balance or a size.
   */
  | { kind: "recap"; buys: number; sells: number; wins?: number | null; losses?: number | null; bestPct?: number | null }
  /** The coins a recap's trades were in, by ticker, newest first, at most TRADED_MAX. */
  | { kind: "traded"; symbols: string[] };

export type FiguresSpec = readonly FiguresSection[];

/** Distinct clean tickers, in order, at most `max`. */
function tickers(list: readonly unknown[], max: number): string[] {
  const out: string[] = [];
  for (const s of list) {
    const t = cleanTicker(s);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** The figures a section can actually show, in its own order, after every rule above. */
type Shown =
  | { kind: "major"; ticker: string; rank: string | null; price: string | null; mcap: string | null; vol: string | null; d1: string | null; d7: string | null }
  | { kind: "majors"; coins: { ticker: string; d1: string }[] }
  | { kind: "pools"; coins: { ticker: string; d1: string | null; vol: string | null }[] }
  | { kind: "crowd"; tickers: string[] }
  | { kind: "trending"; tickers: string[] }
  | { kind: "flow"; buys: string | null; sells: string | null }
  | { kind: "git"; pushed: string; commits: string | null; stars: string | null; age: string | null }
  | { kind: "holders"; top10: string; creator: string | null }
  | { kind: "recap"; buys: number; sells: number; wl: { w: number; l: number } | null; best: string | null }
  | { kind: "traded"; tickers: string[] };

/** What of a spec can be shown: unclean tickers, unshowable numbers and empty sections out; the caps applied. */
function shownOf(spec: FiguresSpec): Shown[] {
  const out: Shown[] = [];
  for (const s of Array.isArray(spec) ? spec : []) {
    if (!s || typeof s !== "object") continue;
    if (s.kind === "major") {
      const ticker = cleanTicker(s.symbol);
      if (!ticker) continue;
      const m: Shown = { kind: "major", ticker, rank: rankOf(s.rank), price: compactMoney(s.priceUsd), mcap: compactMoney(s.marketCapUsd),
        vol: compactMoney(s.volume24hUsd), d1: signedPercent(s.change24hPct), d7: signedPercent(s.change7dPct) };
      if (m.rank || m.price || m.mcap || m.vol || m.d1 || m.d7) out.push(m);
    } else if (s.kind === "majors") {
      // Each coin by its day's change, or not at all: a ticker with no figure is never shown.
      const coins: { ticker: string; d1: string }[] = [];
      for (const c of Array.isArray(s.coins) ? s.coins : []) {
        const ticker = cleanTicker(c?.symbol), d1 = signedPercent(c?.change24hPct);
        if (!ticker || !d1 || coins.some((x) => x.ticker === ticker)) continue;
        coins.push({ ticker, d1 });
        if (coins.length >= MAJORS_MAX) break;
      }
      if (coins.length) out.push({ kind: "majors", coins });
    } else if (s.kind === "pools") {
      const coins: { ticker: string; d1: string | null; vol: string | null }[] = [];
      for (const c of Array.isArray(s.coins) ? s.coins : []) {
        const ticker = cleanTicker(c?.symbol);
        if (!ticker || coins.some((x) => x.ticker === ticker)) continue;
        const d1 = signedPercent(c.change24hPct), vol = compactMoney(c.volume24hUsd);
        if (d1 || vol) coins.push({ ticker, d1, vol });
        if (coins.length >= POOLS_MAX) break;
      }
      if (coins.length) out.push({ kind: "pools", coins });
    } else if (s.kind === "crowd" || s.kind === "trending") {
      const list = tickers(Array.isArray(s.symbols) ? s.symbols : [], s.kind === "crowd" ? CROWD_MAX : TRENDING_MAX);
      if (list.length) out.push({ kind: s.kind, tickers: list });
    } else if (s.kind === "flow") {
      const buys = compactMoney(s.buyUsd), sells = compactMoney(s.sellUsd);
      // Both sides or neither: one side alone is half a picture.
      if (buys && sells) out.push({ kind: "flow", buys, sells });
    } else if (s.kind === "git") {
      // The last push or no section: the push is what "is it alive" means.
      const pushed = agoOf(s.pushedDaysAgo);
      if (!pushed) continue;
      const age = spanOf(s.repoAgeDays);
      out.push({ kind: "git", pushed, commits: commitsOf(s.commits30d, s.commitsPartial === true), stars: starsOf(s.stars), age });
    } else if (s.kind === "holders") {
      const top10 = shareOf(s.top10Pct);
      if (top10) out.push({ kind: "holders", top10, creator: shareOf(s.creatorPct) });
    } else if (s.kind === "recap") {
      const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= RECAP_COUNT_MAX ? v : 0);
      const buys = count(s.buys), sells = count(s.sells), w = count(s.wins), l = count(s.losses);
      // GREEN AND RED ONLY WHEN EVERY SALE COUNTED HAS A MEASURED OUTCOME
      // (review of the recap branch, 2026-10-14): "3 sells (1 green, 0 red)"
      // beside two sales nobody measured reads as none of them lost.
      const wl = sells > 0 && w + l === sells ? { w, l } : null;
      // A best gain too small to show at one decimal is none, never "+0%" beside a green (third review, 2026-10-14; sale-outcome.ts gainFigure).
      const best = typeof s.bestPct === "number" && s.bestPct >= 0.05 && wl && wl.w > 0 ? signedPercent(s.bestPct) : null;
      if (buys + sells > 0) out.push({ kind: "recap", buys, sells, wl, best });
    } else if (s.kind === "traded") {
      const list = tickers(Array.isArray(s.symbols) ? s.symbols : [], TRADED_MAX);
      if (list.length) out.push({ kind: "traded", tickers: list });
    }
  }
  return capFigures(out);
}

function figuresIn(s: Shown): number {
  switch (s.kind) {
    case "major": return [s.rank, s.price, s.mcap, s.vol, s.d1, s.d7].filter((x) => x !== null).length;
    case "majors": return s.coins.length;
    case "pools": return s.coins.reduce((n, c) => n + (c.d1 ? 1 : 0) + (c.vol ? 1 : 0), 0);
    case "flow": return 2;
    case "git": return [s.pushed, s.commits, s.stars, s.age].filter((x) => x !== null).length;
    case "holders": return s.creator === null ? 1 : 2;
    case "recap": return (s.buys > 0 ? 1 : 0) + (s.sells > 0 ? 1 : 0) + (s.best ? 1 : 0);
    default: return 0;
  }
}

/** No more than FIGURES_MAX figures: sections past the handful are left out whole. */
function capFigures(list: Shown[]): Shown[] {
  const out: Shown[] = [];
  let n = 0;
  for (const s of list) {
    const k = figuresIn(s);
    if (n + k > FIGURES_MAX) continue;
    n += k;
    out.push(s);
  }
  return out;
}

function renderSection(s: Shown): string {
  switch (s.kind) {
    case "major": {
      const head = `${s.ticker}${s.rank ? ` ${s.rank}` : ""}`;
      const rest = [s.price, s.mcap ? `mcap ${s.mcap}` : null, s.vol ? `vol ${s.vol}` : null, s.d1 ? `24h ${s.d1}` : null, s.d7 ? `7d ${s.d7}` : null].filter((x): x is string => x !== null);
      return [head, ...rest].join(", ");
    }
    case "majors":
      return `24h: ${s.coins.map((c) => `${c.ticker} ${c.d1}`).join(", ")}`;
    case "pools":
      return `trending: ${s.coins.map((c) => [c.ticker, c.d1 ? `24h ${c.d1}` : null, c.vol ? `vol ${c.vol}` : null].filter((x): x is string => x !== null).join(" ")).join(", ")}`;
    case "crowd":
      return `fomo: most bought ${s.tickers.join(", ")}`;
    case "trending":
      return `hot: ${s.tickers.join(", ")}`;
    case "flow":
      return `1h buys ${s.buys}, sells ${s.sells}`;
    case "git":
      return [`github: last push ${s.pushed}`, s.commits ? `${s.commits} in 30d` : null, s.stars, s.age ? `repo ${s.age} old` : null].filter((x): x is string => x !== null).join(", ");
    case "holders":
      return `top10 hold ${s.top10}${s.creator ? `, creator ${s.creator}` : ""}`;
    case "recap": {
      const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
      const parts = [s.buys > 0 ? plural(s.buys, "buy") : null,
        s.sells > 0 ? `${plural(s.sells, "sell")}${s.wl ? ` (${s.wl.w} green, ${s.wl.l} red)` : ""}` : null,
        s.best ? `best ${s.best}` : null].filter((x): x is string => x !== null);
      return `recap: ${parts.join(", ")}`;
    }
    case "traded":
      return `traded ${s.tickers.join(", ")}`;
  }
}

function renderShown(list: readonly Shown[]): string | null {
  return list.length ? `${list.map(renderSection).join("; ")}.` : null;
}

/** The whole line for a spec, or null when nothing in it can be shown. Never anything but FIGURES_LINE. */
export function renderFiguresLine(spec: FiguresSpec): string | null {
  const line = renderShown(shownOf(spec));
  return line !== null && admitFiguresLine(line) ? line : null;
}

// ── the grammar ─────────────────────────────────────────────────────────────

// A ticker, bare: X refuses an API post with more than one cashtag
// (docs.x.com, "Posts created via the API are limited to a maximum of 1
// cashtag"), so the line never writes one.
const T = String.raw`[A-Z]{2,10}`;
const MONEY = String.raw`~\$(?:[1-9]\.[1-9]|[1-9]\d{0,2})[kMBT]`;
const PCT = String.raw`[+-](?:0|[1-9]\d{0,4})(?:\.[1-9])?%`;
const RANK = String.raw`#[1-9]\d{0,2}`;
// A coin with no figure is never rendered, so the grammar refuses one: after
// the ticker a field must follow (the lookahead), whichever it is. Every other
// section opens with a word of its own in lower case or a digit, so a ticker
// at the head of a section is always a major's.
const MAJOR = String.raw`${T}(?=[ ,])(?: ${RANK})?(?:, ${MONEY})?(?:, mcap ${MONEY})?(?:, vol ${MONEY})?(?:, 24h ${PCT})?(?:, 7d ${PCT})?`;
const MAJORS = String.raw`24h: ${T} ${PCT}(?:, ${T} ${PCT}){0,${MAJORS_MAX - 1}}`;
const POOL = String.raw`${T}(?= )(?: 24h ${PCT})?(?: vol ${MONEY})?`;
const POOLS = String.raw`trending: ${POOL}(?:, ${POOL}){0,${POOLS_MAX - 1}}`;
const CROWD = String.raw`fomo: most bought ${T}(?:, ${T}){0,${CROWD_MAX - 1}}`;
const TRENDING = String.raw`hot: ${T}(?:, ${T}){0,${TRENDING_MAX - 1}}`;
const FLOW = String.raw`1h buys ${MONEY}, sells ${MONEY}`;
// A larp check's GitHub and holders (2026-10-13): spans in whole days, weeks, months or years, shares in whole percent.
const SPAN = String.raw`[1-9]\d?(?:d|w|mo|y)`;
const SHARE = String.raw`(?:100|[1-9]?\d)%`;
const GIT = String.raw`github: last push (?:today|${SPAN} ago)(?:, (?:(?:0|[1-9]\d?) commits?|100\+ commits) in 30d)?(?:, [1-9]\d{0,5} stars?)?(?:, repo ${SPAN} old)?`;
const HOLDERS = String.raw`top10 hold ${SHARE}(?:, creator ${SHARE})?`;
// A recap's counts (2026-10-14): buys, then sales with their green and red, then the best gain; at least one side.
const COUNT = String.raw`[1-9]\d{0,2}`, COUNT0 = String.raw`(?:0|[1-9]\d{0,2})`;
// The best gain only after measured sales with at least one green, never
// beside buys alone or a red-only run; and "traded" only right after a recap,
// never alone, so an ordinary sentence ending "traded ETH." is never read as
// a figures line (review of the recap branch, 2026-10-14).
const R_BUYS = String.raw`${COUNT} buys?`;
// A best gain is a gain: signed plus, never minus, never "+0%".
const GAIN = String.raw`\+(?:0\.[1-9]|[1-9]\d{0,4}(?:\.[1-9])?)%`;
const R_SELLS = String.raw`${COUNT} sells?(?: \((?:${COUNT} green, ${COUNT0} red\)(?:, best ${GAIN})?|0 green, ${COUNT} red\)))?`;
const TRADED = String.raw`traded ${T}(?:, ${T}){0,${TRADED_MAX - 1}}`;
const RECAP = String.raw`recap: (?:${R_BUYS}(?:, ${R_SELLS})?|${R_SELLS})(?:; ${TRADED})?`;
const SECTION = `(?:${MAJOR}|${MAJORS}|${POOLS}|${CROWD}|${TRENDING}|${FLOW}|${GIT}|${HOLDERS}|${RECAP})`;
/** The line, whole: one to five sections joined by "; ", ending with a full stop. Nothing else. */
const LINE = String.raw`${SECTION}(?:; ${SECTION}){0,4}\.`;
export const FIGURES_LINE = new RegExp(`^${LINE}$`);
const FIGURE = new RegExp(`${MONEY}|${PCT}|${RANK}`, "g");

/** The longest a figures line may be, weighted as X weighs it: room is always left for the words. */
export const FIGURES_MAX_WEIGHTED = 200;

/**
 * IS THIS A FIGURES LINE, AND ONLY THAT? The whole string in the renderer's
 * grammar (FIGURES_LINE), at most FIGURES_MAX figures, and at most
 * FIGURES_MAX_WEIGHTED long. Whatever the caller hands in — a draft with a
 * digit, a provider's text, a line with a link or a handle — that is not
 * exactly what renderFiguresLine can produce is false.
 */
export function admitFiguresLine(line: unknown): line is string {
  if (typeof line !== "string" || !FIGURES_LINE.test(line)) return false;
  if ((line.match(FIGURE) ?? []).length > FIGURES_MAX) return false;
  return xWeightedLength(line) <= FIGURES_MAX_WEIGHTED;
}

// ── fitting it in ───────────────────────────────────────────────────────────

/** Each shorter form of a section list, least telling field first, down to one field; never the empty list. */
function* shorter(list: Shown[]): Generator<Shown[]> {
  let cur = list.map((s) => (s.kind === "pools" || s.kind === "majors" ? { ...s, coins: s.coins.map((c) => ({ ...c })) } : { ...s })) as Shown[];
  const emit = (next: Shown[]) => { cur = next.filter((s) => figuresIn(s) > 0 || s.kind === "crowd" || s.kind === "trending" || s.kind === "traded"); return cur; };
  const pools = (): Extract<Shown, { kind: "pools" }> | undefined => cur.find((s): s is Extract<Shown, { kind: "pools" }> => s.kind === "pools");
  const fewerCoins = (down: number) => { const p = pools()!; return emit(cur.map((s) => (s === p ? { ...p, coins: p.coins.slice(0, down) } : s))); };
  const without = (kind: "trending" | "crowd") => (cur.some((s) => s.kind === kind) && cur.length > 1 ? emit(cur.filter((s) => s.kind !== kind)) : null);
  // CoinGecko's global list first: the chain's own coins are what was asked.
  const t = without("trending");
  if (t) yield t;
  // Then the chain's third coin, before Fomo's few tickers: what Fomo traders
  // are on is a signal of its own, and costs a few characters.
  if ((pools()?.coins.length ?? 0) > 2) yield fewerCoins(2);
  const c = without("crowd");
  if (c) yield c;
  // Fewer coins before thinner coins: one coin said whole beats three said halfway.
  while ((pools()?.coins.length ?? 0) > 1) yield fewerCoins(pools()!.coins.length - 1);
  const p = pools();
  if (p && p.coins[0]!.vol && p.coins[0]!.d1) yield emit(cur.map((s) => (s === p ? { ...p, coins: [{ ...p.coins[0]!, vol: null }] } : s)));
  // A coin's line: the week, then volume, market cap, price, and last its rank.
  for (const field of ["d7", "vol", "mcap", "price", "rank"] as const) {
    const m = cur.find((s): s is Extract<Shown, { kind: "major" }> => s.kind === "major");
    if (!m || m[field] === null || figuresIn(m) <= 1) continue;
    yield emit(cur.map((s) => (s === m ? { ...m, [field]: null } : s)));
  }
  // The market overview: the chain's coins went above; then the big coins, the last named first to go.
  const majors = (): Extract<Shown, { kind: "majors" }> | undefined => cur.find((s): s is Extract<Shown, { kind: "majors" }> => s.kind === "majors");
  // Beside the big coins, the chain's last coin goes whole before any big coin does.
  const lastPools = pools();
  if (majors() && lastPools) yield emit(cur.filter((s) => s !== lastPools));
  while ((majors()?.coins.length ?? 0) > 1) {
    const m = majors()!;
    yield emit(cur.map((s) => (s === m ? { ...m, coins: m.coins.slice(0, -1) } : s)));
  }
  // A recap's line: the coins go first, then the best gain; the counts stay.
  const traded = cur.find((s) => s.kind === "traded");
  if (traded && cur.length > 1) yield emit(cur.filter((s) => s !== traded));
  const recap = cur.find((s): s is Extract<Shown, { kind: "recap" }> => s.kind === "recap");
  if (recap?.best) yield emit(cur.map((s) => (s === recap ? { ...recap, best: null } : s)));
  // A larp check's line: the holders go whole first (the repo is what was
  // checked), then the repo's age, its stars and its commits; the last push stays.
  const holders = cur.find((s) => s.kind === "holders");
  if (holders && cur.length > 1) yield emit(cur.filter((s) => s !== holders));
  for (const field of ["age", "stars", "commits"] as const) {
    const g = cur.find((s): s is Extract<Shown, { kind: "git" }> => s.kind === "git");
    if (!g || g[field] === null) continue;
    yield emit(cur.map((s) => (s === g ? { ...g, [field]: null } : s)));
  }
}

export interface WithFigures {
  /** What to post: the gate's text with the line after its words, or the gate's text as it was. */
  text: string;
  /** The line put in, or null when none was (nothing to show, no words, or no form of it fit). */
  line: string | null;
  /** Fields dropped to make it fit (0 when the whole line fit). */
  dropped: number;
}

/** The opt-out notice at the very end of a text, as older answers carried it: the line stays before it there. */
const NOTICE_TAIL = /\s*(say stop to opt out\.)\s*$/i;

/**
 * THE ANSWER WITH ITS FIGURES, OR WITHOUT. `admitted` is the X gate's own
 * text, already judged: an answer's words, with no opt-out notice (gate.ts
 * XGateCtx.answer). The line goes after the words (before a notice, were one
 * ever handed in); the words gain a full stop if they ended without one. The
 * full line is tried first, then each shorter
 * form (`shorter`), and the first whose whole post fits X_MAX_WEIGHTED is
 * used. None fits, no words, or nothing in `spec` can be shown: `admitted`
 * unchanged.
 */
export function withFigures(admitted: string, spec: FiguresSpec | null | undefined): WithFigures {
  const none: WithFigures = { text: admitted, line: null, dropped: 0 };
  if (typeof admitted !== "string" || !spec) return none;
  const m = NOTICE_TAIL.exec(admitted);
  const words = (m ? admitted.slice(0, m.index) : admitted).trim();
  if (!words) return none;
  const lead = /[.!?…]$/.test(words) ? words : `${words}.`;
  const full = shownOf(spec);
  if (!full.length) return none;
  const total = full.reduce((n, s) => n + figuresIn(s) + (s.kind === "crowd" || s.kind === "trending" || s.kind === "traded" ? s.tickers.length : 0), 0);
  const tries: Shown[][] = [full, ...shorter(full)];
  for (const t of tries) {
    const line = renderShown(t);
    if (line === null || !admitFiguresLine(line)) continue;
    const text = m ? `${lead} ${line} ${m[1]!}` : `${lead} ${line}`;
    if (xWeightedLength(text) > X_MAX_WEIGHTED) continue;
    const kept = t.reduce((n, s) => n + figuresIn(s) + (s.kind === "crowd" || s.kind === "trending" || s.kind === "traded" ? s.tickers.length : 0), 0);
    return { text, line, dropped: total - kept };
  }
  return none;
}

const LINE_AT_END = new RegExp(String.raw`\s*(${LINE})(?=\s*(?:[Ss]ay stop to opt out\.)?\s*$)`);

/**
 * A POSTED ANSWER AS EVERY PROMPT AND ECHO CHECK READS IT: without its figures
 * line, the notice left where it was. Only a line in the renderer's own
 * grammar, at the end of the words, is taken out; text that only looks like
 * one is left as it was (and a prompt's own digit screen drops it).
 */
export function withoutFiguresLine(text: string): string {
  if (typeof text !== "string") return text;
  const m = LINE_AT_END.exec(text);
  if (!m || !admitFiguresLine(m[1])) return text;
  return `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`.replace(/\s+/g, " ").trim();
}
