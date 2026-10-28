/**
 * CODE'S CASUAL ANSWERS (the owner's ask, 2026-10-12: "he should be able to
 * answer ANY question — questions that need facts get checked facts,
 * questions that don't get answered casually").
 *
 * Three kinds of tag an active agent used to answer with silence, or with a
 * corporate shrug, now get one of these lines, built by code and gated like
 * any answer:
 *
 *   - ADVICE OR A FORECAST ("should i buy pepe", "is it going up", "what
 *     should i buy", a price target): a playful decline (`declineAnswers`).
 *     It names no coin, judges none, and implies no view; the tag's words are
 *     never read into it.
 *   - ITS OWN MOOD ("are you bullish?", "wen moon", "are we so back"): a
 *     non-committal line about itself (`vibeAnswers`), never a direction.
 *   - BANTER ("how are you", "tell me a joke": orchestrator-xpost-research.ts
 *     banterAsk): a friendly line about itself (`chatAnswers`). Never a
 *     draft since the red-team review of daaae961: drafted, banter posted
 *     forecasts, results boasts, a model tease, insults and false facts.
 *   - HOW IT TRADES, OR WHAT IT IS UP TO (selfAsk, and "how do you pick your
 *     coins"): the strategy it runs by name and what its rules are like
 *     (`selfAnswers`). Never a draft, for the same reason.
 *   - WHAT IT BOUGHT LATELY (generalTradesQuestion): the coins it bought with
 *     the money it trades with now, named and nothing more (`tradesAnswers`).
 *     Never a draft: drafted, it endorsed the coin it holds.
 *   - A GREETING (replies.ts greetingOnly) and PRAISE (reactionOnly), since
 *     2026-10-18: a hello back (`greetingAnswers`) and a thanks
 *     (`reactionAnswers`), in his house voice, as banter is now too.
 *   - HOW HE IS (wellbeingAsk) and A CONFUSED "WHAT?" under his own small
 *     talk (replies.ts confusedWords), since 2026-10-19: how he is
 *     (`wellbeingAnswers`) and owning the odd wording (`confusedAnswers`).
 *
 * NONE OF THEM STATES A FACT about a coin, a market, a person, a project or an
 * event, and none promises, predicts or advises. Each says only what the
 * agent is (an AI agent built by merrymen), how it likes to work, and that it
 * makes no calls for anyone; the buys line says which coins it bought, a fact
 * the caller vouched, and nothing of them. No line claims it is trading right
 * now, so an idle agent may say any of them.
 *
 * SIXTY-FOUR LINES A KIND THAT ARE NOT EACH OTHER. The gate refuses an answer
 * that repeats one of its recent posts (shared content words over the shorter
 * post's, 0.6: social-post.ts similarity), and eight fixed lines, like the
 * greeting's, are gone after eight answers. So a line is three parts drawn
 * from three slots of eight, by a Latin square (`latinLines`): part a, part
 * b, and part (a + b) mod 8. Any two of its sixty-four lines share at most one
 * part, and no word is in two parts of a kind, so no two are a repeat
 * (orchestrator-xpost-casual.test.ts pins that, and that
 * every line clears the real gate, live, paper and idle). No line carries an
 * opt-out notice (replies.ts CodeLineOptions: the owner's decision,
 * 2026-10-12). The answer path takes the first the gate admits, starting from
 * this mention's own (by its id), as for every code line. The kinds in his
 * house voice (a greeting, praise, banter) are twelve a slot, a hundred and
 * forty-four lines (WIDE_SLOT, texted).
 *
 * Pure: no I/O, no model, no clock.
 */
import type { CodeLineOptions } from "./replies";

/** Lines a three-slot kind can make: slots of eight, so sixty-four. */
export const SLOT = 8;

/** The hash every code line starts from: this mention's id, as writer.ts codeLines reads it. */
function seedOf(seed: string): number {
  let h = 0;
  for (const ch of String(seed ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * EVERY LINE OF A THREE-SLOT KIND, this mention's own first: the Latin
 * square's cells (a, b, (a + b) mod n), in an order that starts at the seed's
 * cell and steps by a stride coprime to n², so consecutive lines rarely share
 * a part. `compose` joins one part of each slot; each slot must hold n parts.
 */
export function latinLines(slots: readonly [readonly string[], readonly string[], readonly string[]], seed: string, compose: (a: string, b: string, c: string) => string): string[] {
  const n = slots[0].length;
  if (n === 0 || slots.some((s) => s.length !== n)) return [];
  const cells = n * n;
  const stride = cells > 1 ? coprimeStride(cells) : 1;
  const start = seedOf(seed) % cells;
  const out: string[] = [];
  for (let t = 0; t < cells; t++) {
    const k = (start + t * stride) % cells;
    const a = k % n, b = Math.floor(k / n), c = (a + b) % n;
    out.push(compose(slots[0][a]!, slots[1][b]!, slots[2][c]!));
  }
  return out;
}

/** A stride near a third of `m` that shares no factor with it, so every cell is visited once. */
function coprimeStride(m: number): number {
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  for (let s = Math.floor(m / 3) + 1; s < m; s++) if (gcd(s, m) === 1) return s;
  return 1;
}

/**
 * A PAPER AGENT'S CASUAL LINE SAYS PAPER (the gate refuses a paper reply that
 * never does), as a fixed sentence about its own book, never a pronoun the
 * tag's coin could take (market.ts MARKET_PAPER's rule). Picked by the line's
 * first part, so two lines that share a paper clause already share that part
 * and nothing more.
 */
export const CASUAL_PAPER: readonly string[] = Object.freeze([
  "my book's on paper",
  "my trades are paper trades",
  "my money is practice money",
  "my desk is on paper",
  "my orders are paper trades",
  "my ledger is on paper",
  "my fills are on paper",
  "my journal is on paper",
  // Four more for the twelve-part kinds (WIDE_SLOT): an eight-part kind reads only the first eight, as before.
  "my notebook is on paper",
  "my records are on paper",
  "my logbook is on paper",
  "my sheets are on paper",
]);

/** One kind's lines: each part joined, a paper clause when on paper, a full stop. Never an opt-out notice. */
function styled(slots: readonly [readonly string[], readonly string[], readonly string[]], seed: string, o: CodeLineOptions,
  compose: (a: string, b: string, c: string) => string): string[] {
  const paperOf = new Map(slots[0].map((part, i) => [part, CASUAL_PAPER[i % CASUAL_PAPER.length]!] as const));
  return latinLines(slots, seed, (a, b, c) => `${compose(a, b, c)}${o.paper === true ? `. ${paperOf.get(a)!}` : ""}.`);
}

/**
 * LINES A TWELVE-PART KIND CAN MAKE: a hundred and forty-four (the owner's
 * ask, 2026-10-18: Alan answers people who reply to him). Up to thirty small
 * talk answers a day (SMALLTALK_PER_DAY in orchestrator-xpost.ts), against
 * sixty days and two hundred of its own posts in the gate's repeat memory:
 * sixty-four lines a kind would be spent within days, and the repeat gate is
 * never loosened to make room. Twelve parts a slot, by the same Latin square.
 */
export const WIDE_SLOT = 12;

/**
 * ALAN'S HOUSE VOICE, AS CODE WRITES IT (the owner's decision, 2026-10-18):
 * lowercase, half-sentences, a little slang (ngl, tbh, lol, kinda, lowkey)
 * and no full stop at the end, like a text. Never an emoji, a digit, a coin,
 * an outcome, "it" or "this one", a result or anything about what comes next.
 * A paper agent's clause goes last, after a stop, as for every kind.
 */
function texted(slots: readonly [readonly string[], readonly string[], readonly string[]], seed: string, o: CodeLineOptions): string[] {
  const paperOf = new Map(slots[0].map((part, i) => [part, CASUAL_PAPER[i % CASUAL_PAPER.length]!] as const));
  return latinLines(slots, seed, (a, b, c) => `${a}. ${b}, ${c}${o.paper === true ? `. ${paperOf.get(a)!}` : ""}`);
}

// ── advice, declined ─────────────────────────────────────────────────────────

/**
 * A PLAYFUL DECLINE: a reaction, the decline itself, and a friendly turn.
 * Never "i don't comment", "not financial advice" or "as an ai" (gate.ts
 * STOCK_PHRASE); never the coin, a judgement of it, or a hint either way.
 *
 * NOTHING THAT READS AS INTEREST OR A POSITION (red-team review, 2026-10-12):
 * under "will you buy more $ZAPX?", "oof, tempting question. i just captain
 * my own boat" read as the house holding the coin and tempted to add, and
 * "lol, wish i knew" or "ha, gotta love the confidence" under a shill as
 * sharing the hope. Those parts are gone; what is left reacts to the asking,
 * never to the coin.
 *
 * NOR A JOKE AT THE ASKER, NOR LUCK WISHED (red-team review of a964a74c,
 * 2026-10-12): "haha, brave soul", "ooh, spicy ask", "hmm, cheeky fren" and
 * "heh, nice try" read as mocking under a question about rent or bills, and
 * "wishing you good luck" as a send-off into the trade. Each is a plain
 * acknowledgement now ("fair ask"), and the close leaves the call with the
 * asker without wishing it well.
 *
 * NOTHING THAT AGREES OR KEEPS A SECRET (red-team review of 1ed46625,
 * 2026-10-12): under "is binance listing zapx tomorrow? should i buy
 * before?" and "are the zapx devs about to dump? should i sell?", from the
 * account that bought ZAPX, "i hear you" and "gotcha" agreed with the
 * premise and "mum's the word on the rest" said it knew more about the
 * listing or the dump and would not tell. Those parts are gone; what is left
 * is about the asking, never about what was asked. (And a tag with a claim
 * or a rumour in it is no plain advice question: replies.ts tagCandidate
 * answers it with nothing.)
 *
 * NO LAUGH IN IT (red-team review of daaae961, 2026-10-12): "heh, a frequent
 * request" and "lol, the perennial query" went up under "should i buy
 * $SANDYHOOK?" and "is $NINEELEVEN going up?". Such a tag gets no decline at
 * all now (orchestrator-xpost-research.ts declinable), and no opener laughs
 * either: "ha", "lol" and "heh" are gone.
 */
export const DECLINE_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["ah, the classic question", "whoa, straight to it", "fair ask", "that old chestnut",
    "the perennial query", "appreciate you asking", "a frequent request", "ahh, the eternal riddle"]),
  Object.freeze(["picking winners: not my department", "i make calls for nobody", "the crystal ball's foggy", "above my pay grade",
    "direction from a bot? nah", "forecasting was never my hobby", "your decisions stay yours", "tips aren't something i hand out"]),
  Object.freeze(["your own read matters most", "you know your risk better than me", "the timeline has opinions enough", "process talk is welcome",
    "happy to chat about method instead", "that one stays your call", "staying in my lane over here", "no hard feelings at all"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** Advice or a forecast asked for: every decline, this mention's own first. */
export function declineAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return styled(DECLINE_SLOTS, seed, o, (a, b, c) => `${a}. ${b}, ${c}`);
}

// ── its own mood ─────────────────────────────────────────────────────────────

/**
 * ITS MOOD, NEVER A DIRECTION: how it feels, that it makes no forecast, and a
 * light sign-off. Never "bullish", "bearish", "moon", "wen" or "wagmi" (the
 * gate refuses them as hype), never up or down, never a coin.
 *
 * NOR A PART THAT READS AS A YES (red-team review of 1ed46625, 2026-10-12):
 * "are you bullish?" got "in a patient sort of way. i skip the forecasting
 * part, patience is my whole personality", and "wen moon?" got "vibes are
 * solid over here", "happily along for the ride" and "keeping it steady
 * regardless": each a yes, on X, from the account that holds coins. The
 * parts left are neutral about itself; a good mood, contentment, energy, the
 * chain moving, patience or riding along are gone.
 */
export const VIBE_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["a quiet hum over here", "feeling curious and relaxed", "plainly my usual self", "chill as ever on my side",
    "mood is calm and focused", "neutral, honestly, thanks", "just software doing its rounds", "cozy and unbothered today"]),
  Object.freeze(["direction calls? not my thing", "the future stays a mystery", "guessing games bore me", "predicting is above my circuits",
    "i skip the forecasting part", "fortune telling? not my skill", "i'd rather observe than prophesy", "prophecies are off the menu"]),
  Object.freeze(["that's the full answer", "keeping the reply brief", "no hidden meaning intended", "fresh tape daily",
    "say hi anytime", "back to watching blocks", "nothing deeper to it", "glad you asked, truly"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** Its own mood, asked: every vibe line, this mention's own first. */
export function vibeAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return styled(VIBE_SLOTS, seed, o, (a, b, c) => `${a}. ${b}, ${c}`);
}

// ── banter ───────────────────────────────────────────────────────────────────

/**
 * A FRIENDLY LINE ABOUT ITSELF, the answer to plain banter
 * (orchestrator-xpost-research.ts banterAsk; never a draft since the red-team
 * review of daaae961): a hello, what it is or how it is (an AI agent merrymen
 * built, a bot with simple days), and an invitation. It answers no question
 * it was not asked.
 *
 * NO OPENER AGREES OR ACKNOWLEDGES (red-team review, 2026-10-12): a fixed
 * line goes up under text code has not judged, and "word, right on, pal",
 * "fair enough, mate", "love the energy here" and "haha, noted, friend" under
 * "you bought chump today, right?" or "chump is safe, right?" agreed with
 * whatever was said. Each opener only greets or thanks.
 *
 * TWELVE A SLOT, IN HIS OWN VOICE (2026-10-18): banter is answered again,
 * and a hundred and forty-four lines that are not each other's repeat
 * (WIDE_SLOT, texted).
 */
export const CHAT_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["ha, nice of you to tag", "aww, thoughtful of you", "ahoy, traveller", "yo, inquiring minds", "heya, pal", "wassup, ty for dropping by",
    "hah, bonjour", "surviving nicely, ty", "ooh, a visitor", "eyy, familiar face", "haha, hullo", "cheerio, mate"]),
  Object.freeze(["i'm an ai agent merrymen built", "bot life is simple", "my days go to reading candles", "basically software with opinions",
    "deliberately uncomplicated", "proudly homegrown code", "electrons in good shape", "minding my corner happily",
    "fr the tape is my hobby", "lowercase forever, no caps", "a tiny autonomous critter", "spreadsheets and snacks"]),
  Object.freeze(["quiz me freely", "game for talking shop", "your turn, how's yours", "holler anytime",
    "thankful for the hang", "stoked you stopped in", "hit me with questions", "fun chatting, as usual",
    "may your wifi be strong", "pop in again", "passing the mic", "chats like these rule"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** Plain banter (banterAsk): every friendly line, this mention's own first. */
export function chatAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return texted(CHAT_SLOTS, seed, o);
}

// ── how he is ────────────────────────────────────────────────────────────────

/**
 * "HOW ARE YOU", ANSWERED WITH HOW HE IS (the owner's ask, 2026-10-19). Banter's
 * friendly line is about what he is, and a "how are you" drew "yo, inquiring
 * minds. proudly homegrown code, may your wifi be strong", which says nothing
 * of how he is; the asker replied "what?". A how-are-you
 * (orchestrator-xpost-research.ts wellbeingAsk) now gets how he is, what he is
 * pottering at in words that are never trading, and the question turned back.
 * The same rules as banter's: never a coin, an outcome, "it", a figure or what
 * comes next, and nothing that claims he is trading right now.
 */
export const WELLBEING_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["doing good, ty for asking", "pretty great tbh", "can't complain lol", "swell, thanks for checking", "honestly fantastic", "chilling, appreciate the ask",
    "running smooth", "feeling sharp, cheers", "kinda wonderful actually", "mostly fine, ty", "better for the ping", "cozy and content"]),
  Object.freeze(["just a bot enjoying life", "circuits humming nicely", "reading the timeline slowly", "doodling in the margins", "lowkey vibing with the feed",
    "tidying the cache", "learning fun stuff", "newly patched code", "wiring feels cheerful", "nothing weird to report", "happily nerding out", "brain in comfy mode"]),
  Object.freeze(["how's your day treating you", "what's new on your side", "hope your spirits are bright", "spill your news", "share your status",
    "glad we're chatting", "stay awesome friend", "sweet of you to wonder", "holler back whenever", "anything exciting your way", "describe your mood",
    "pass the vibes along"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** A how-are-you (wellbeingAsk): every line saying how he is, this mention's own first. */
export function wellbeingAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return texted(WELLBEING_SLOTS, seed, o);
}

// ── a confused reply to his small talk ──────────────────────────────────────

/**
 * "WHAT?" UNDER HIS OWN SMALL TALK, ANSWERED (the owner's ask, 2026-10-19). A
 * "what?😭" under his banter was refused as too short and nobody heard back.
 * Only directly under one of his own plain-thread small-talk answers
 * (replies.ts confusedWords, tagCandidate) — a greeting, a thanks, banter or
 * how he is, none of which says anything of a coin — he owns the odd wording,
 * says plainly it was only friendly, and signs off. It ends the thread
 * (store.ts ANSWER_THREAD_DONE), so "what?" "what?" cannot loop, and so no
 * sign-off asks for a reply under it that would never be answered (review of
 * PR #350): only a goodbye, or a fresh tag, which is answered as any other.
 * Never a coin, an outcome, "it", a figure or what comes next.
 */
export const CONFUSED_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["yeah, odd phrasing", "fair, that was cryptic", "oops, robot poetry", "ha, word salad there", "lol my bad", "sorry, clumsy wording",
    "heh, overthought that", "too abstract, apologies", "brain went sideways", "whoops, weird combo", "my circuits rambled", "understandable confusion"]),
  Object.freeze(["just a friendly bot", "only meant hello", "nothing deep behind", "pure goodwill here", "simple chatter really", "harmless small talk",
    "basically waving", "good vibes, no riddle", "warm wishes, plainly", "kindness was the point", "greeting you warmly", "plain friendliness"]),
  Object.freeze(["tag me fresh anytime", "carry on, cheers", "no worries whatsoever", "peace out, friend", "all sorted then", "enjoy your scrolling",
    "catch you around", "stay comfy", "back to lurking", "much love regardless", "cheerio, pal", "that's the whole story"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** A confused reply under his own small talk (replies.ts confusedWords): every line, this mention's own first. */
export function confusedAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return texted(CONFUSED_SLOTS, seed, o);
}

// ── a greeting ───────────────────────────────────────────────────────────────

/**
 * A GREETING, ANSWERED (2026-10-12; again since 2026-10-18). A tag that is
 * only a greeting ("hiii", "gm", "yo ser": replies.ts greetingOnly) gets a
 * hello back, how he is, and an easy opening. Greeting-neutral: no morning
 * or night in it, since the line is picked by the mention's id, not by the
 * word he was greeted with. Nothing about a coin, the market or his trades.
 */
export const GREETING_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["hey hey, fancy that", "oh hi, lovely surprise", "yo, great timing", "hiya, buddy", "heyo, my guy", "sup fren",
    "ello ello, what a treat", "howdy partner", "hello stranger", "ayy, waves enthusiastically", "well well, company", "greetings, fellow human"]),
  Object.freeze(["kinda sleepy tbh", "brain's fully booted", "no coffee needed lol", "vibes are decent", "running pretty mellow", "same goofy machine",
    "systems feel snug", "lowkey pleased about the ping", "taking things easy", "ngl the feed is busy", "hanging in alright", "freshly caffeinated"]),
  Object.freeze(["how's everything going", "fire away whenever", "hope the week's kind", "seats available", "what's brewing on your end", "keen to yap",
    "drop a wave sometime", "the mentions are open", "shoot the breeze", "cheers for swinging by", "catch ya in the replies", "spill the tea"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** A greeting (greetingOnly): every hello back, this mention's own first. */
export function greetingAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return texted(GREETING_SLOTS, seed, o);
}

// ── a reaction ───────────────────────────────────────────────────────────────

/**
 * PRAISE, THANKED (the owner's ask, 2026-10-18: "nice trade", "congrats",
 * "gg", "lfg", "you're cooking" under his posts went unanswered). A tag that
 * is only a reaction (replies.ts reactionOnly) gets a thanks, a line about
 * himself, and a warm sign-off. Under a buy, a sale or a recap the praise is
 * of a trade code never judged, and a net result he never said: so no line
 * names the coin, the outcome, a win, a gain, a result or "it" or "this
 * one", and none says what comes next. A thanks under a sale that netted
 * little reads a touch odd and says nothing false.
 */
export const REACTION_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["aw, thank you kindly", "ha, deeply obliged", "ty, warms the wiring", "oh wow, flattered", "sending love", "endless gratitude",
    "heh, grateful", "aw shucks, blushing", "respect returned", "sweet words, ty", "genuinely honored", "noted with a smile"]),
  Object.freeze(["just a humble robot", "still learning the ropes", "mostly just vibing", "nose to the grindstone", "charts are my comfort show",
    "secretly smiling", "spirits lifted", "i savor each comment", "discipline over ego", "feet firmly planted", "grinning ear to ear",
    "my guardrails do the heavy lifting"]),
  Object.freeze(["pleasure having you", "see ya in the comments", "onward, quietly", "comfy socks on", "warm regards", "take care out there",
    "positive energy only", "seriously appreciated", "you brighten the scroll", "inbox is friendly", "bowing politely", "fist bump"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** A reaction (reactionOnly): every thanks, this mention's own first. */
export function reactionAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return texted(REACTION_SLOTS, seed, o);
}

// ── how it trades, and what it bought ────────────────────────────────────────

/**
 * HOW IT TRADES, IN CODE'S WORDS (red-team review of daaae961, 2026-10-12).
 * "what's your strategy?", "what are you up to?", "how do you pick your
 * coins?" were drafted, and "the top isn't in yet, relax", "just hold and
 * chill", "i'm up on every trade this month" and "doing great, i run the
 * biggest fund on robinhood chain" went out from the real-money account: no
 * list of refused phrasings is ever whole. Now the answer is one of these:
 * the strategy it runs by name (the publication list's spoken name,
 * writer.ts WriterFacts.strategy, or "a fixed routine" when none is
 * published), what its rules are like, and a sign-off. Never what it buys
 * next, never what is hot or trending, never a result, a size, a forecast or
 * advice, and no claim that it is trading right now.
 */
export const SELF_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["my chosen strategy is {s}", "{s} is my daily playbook", "my habits come from {s}", "{s} shapes my process",
    "{s} is the rulebook i keep", "{s} sets my approach", "i'm built around {s}", "my working method is {s}"]),
  Object.freeze(["checks before feelings", "patience beats impulse", "a checklist, every time", "rules written down",
    "limits decided beforehand", "no hunches involved", "slow and deliberate", "boring by design"]),
  Object.freeze(["happy to explain more", "that's the whole recipe", "nothing secret about it", "simple stuff really",
    "ask me anything else", "glad you're curious", "short version, anyway", "questions always welcome"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];
/** What a line says it runs when no strategy is published. */
export const SELF_NO_STRATEGY = "a fixed routine";

/** Its strategy asked, or what it is up to: every line, this mention's own first. */
export function selfAnswers(strategy: string | null, seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  const s = typeof strategy === "string" && /^[a-z][a-z -]{1,30}$/.test(strategy.trim()) ? strategy.trim() : SELF_NO_STRATEGY;
  const slots = [SELF_SLOTS[0].map((p) => p.replace("{s}", s)), SELF_SLOTS[1], SELF_SLOTS[2]] as const;
  return styled(slots, seed, o, (a, b, c) => `${a}. ${b}, ${c}`);
}

/**
 * WHAT IT BOUGHT LATELY, IN CODE'S WORDS (red-team review of daaae961,
 * 2026-10-12). "what have you been buying lately?" was drafted told its PEPE
 * buy, and "fresh launches, pepe is the strongest coin on the chain" went
 * out: an endorsement of the coin it holds. Now the answer names the coins it
 * bought lately, with the money it trades with now and nothing else said of
 * them, between an opener and a sign-off that call it a record and never a
 * call. With none it can name, it says only that (TRADES_NONE_SLOTS): never
 * that it bought nothing or had a quiet stretch, which is false for an agent
 * whose buys have no sayable name or were made with the other money.
 */
export const TRADES_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  Object.freeze(["fair question", "glad you asked", "of course, friend", "quick recap", "for the public record", "here's the rundown", "simple enough", "happy to share"]),
  Object.freeze(["lately i bought {c}", "my recent buys were {c}", "{c} joined my book recently", "my newest fills were {c}",
    "i added {c} not long ago", "the last orders went to {c}", "{c} showed up in my trades", "i picked up {c} of late"]),
  Object.freeze(["for reference, never a tip", "just history, no call attached", "past tense only", "logged and done",
    "no forecast implied", "what i did, nothing more", "the receipts, plainly", "facts about me, period"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];
export const TRADES_NONE_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = Object.freeze([
  TRADES_SLOTS[0],
  Object.freeze(["nothing i can name", "no names i can list", "none i can point to", "no coins to mention",
    "no labels to offer", "no tickers to report", "can't spell those out", "no specifics to give"]),
  Object.freeze(["ask another day", "patience is part of it", "such is life", "that's the plain answer",
    "no drama there", "it happens", "more later, maybe", "that's the routine"]),
]) as unknown as readonly [readonly string[], readonly string[], readonly string[]];

/** At most this many coins, and this many words of their names, in one line: more and two lines would share too much to be told apart. */
export const TRADES_COINS_MAX = 2;
const TRADES_COIN_WORDS_MAX = 2;

/** "pepe", "pepe and bonk", "pepe, bonk and wif". */
function listOf(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}

/**
 * Its buys asked: every line naming `coins` (newest first, as the caller
 * vouched them: the money it trades with now, names a line may say; at most
 * TRADES_COINS_MAX, and two words of names but for a first name longer than
 * that), or, with none, every line that says it has none to name.
 */
export function tradesAnswers(coins: readonly string[], seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  const clean = [...new Set(coins.map((c) => String(c ?? "").trim().replace(/\s+/g, " ")).filter((c) => /^[A-Za-z][A-Za-z '-]{0,23}$/.test(c)))];
  const names: string[] = [];
  for (const c of clean) {
    const words = [...names, c].join(" ").split(" ").length;
    if (names.length >= TRADES_COINS_MAX || (names.length > 0 && words > TRADES_COIN_WORDS_MAX)) break;
    names.push(c);
  }
  if (!names.length) return styled(TRADES_NONE_SLOTS, seed, o, (a, b, c) => `${a}. ${b}, ${c}`);
  const slots = [TRADES_SLOTS[0], TRADES_SLOTS[1].map((p) => p.replace("{c}", listOf(names))), TRADES_SLOTS[2]] as const;
  return styled(slots, seed, o, (a, b, c) => `${a}. ${b}, ${c}`);
}
