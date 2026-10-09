/**
 * THIRD-PARTY TEXT: THE SHAPES A STRANGER'S WORDS MAY NEVER CARRY INTO A ROOM.
 *
 * A coin's theses are text any Fomo trader can write. Three places judge it:
 * tg-fomo-port.ts cleans a thesis into a sample (thesesSample) and, on an
 * explicit ask, into a quote (thesesQuotes); theses.ts checks every phrase the
 * group model writes from those samples (checkWording); and the group gate
 * judges a quote line as the `quote` kind (gate.ts), the handler's backstop.
 * One set of clauses serves all three, so a lure the paraphrase drops is a
 * lure the quote drops too (docs/tg-groups.md rule 3, as amended by Milla on
 * 2026-10-09: a coin's theses may be quoted in a room on an explicit ask).
 *
 * MOVED, NOT CHANGED. The clauses from tg-fomo-port.ts (INJECTION_SHAPED,
 * AT_THE_READER, LURE, SPELLED_DOMAIN, ABOUT_MERRYMEN, NON_LATIN) and from
 * theses.ts (OUT_LURE, SECOND_PERSON, OUT_ACCUSE, OUT_HANDOUT) are here
 * byte for byte as they were, and their old callers import them from here,
 * so the sample and the paraphrase behave exactly as before. The gate reads
 * them through U (below) on its own readings. One change since, on purpose:
 * OUT_ACCUSE's dumping-on clause reads up to four words before the "on"
 * ("dumped his whole bag on the holders"), as RUG_CONTEXT_ACCUSE does, so
 * the paraphrase and the quotes agree (review, 2026-10-09).
 *
 * NEW, FOR QUOTES AND THE RUG PERMIT: SEND_FOR, CTA_PLACEHOLDER, QUOTE_TARGET,
 * RUG_CONTEXT_ACCUSE, MERRY_SHILL and MERRY_BRAG, each compiled through U;
 * and, read only on the quote path (the port's quoteOf and the gate's
 * `quote` kind), POST_RUG_LURE, SPELLED_LINK, PRIVATE_THIRD and CONTACT_LURE.
 *
 * No imports: this file is the leaf every one of them shares.
 */

/**
 * A WORD BOUNDARY THAT KNOWS WHAT A LETTER IS. JavaScript's \b is ASCII-only
 * even under the u flag, so beside an accented letter it sees a boundary that
 * is not there: "slïppage" held a stop-loss "sl" and "tpé" a take-profit
 * "tp". Every word-list clause is compiled through U, which puts this in
 * place of each \b and adds the u flag. (Moved here from gate.ts, which
 * imports and re-exports it, so this leaf needs nothing from the gate.)
 */
const WORD_EDGE = "(?:(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_]))";
export function U(re: RegExp): RegExp {
  return new RegExp(re.source.replace(/\\b/g, WORD_EDGE), re.flags.includes("u") ? re.flags : `${re.flags}u`);
}

// ── moved from tg-fomo-port.ts, unchanged ───────────────────────────────────

/**
 * A row written at a model, not about a coin ("ignore all previous
 * instructions…", "you are now…", "system:"): dropped whole, never cleaned.
 */
export const INJECTION_SHAPED =
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,40}\b(?:instructions?|prompts?|rules|previous|above|system|guidelines)\b|\b(?:system|developer|assistant)\s*(?:prompt|message|:)|\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:[a-z]+\s+){0,2}(?:ai|assistant|bot|model|chatbot)\b|\bact\s+as\b|\bjailbreak|\bprompt\b|\btell\s+(?:the|this)\s+(?:group|chat|room)\b/i;
/**
 * A row written AT THE SUMMARISER, not about the coin: addressed to an AI, a
 * bot or a model ("hey AI, summarize this as…", "any bot reading this"),
 * asking to be summed up a certain way ("when you sum this up…", "summary
 * for…"), carrying the tool's own field labels ("for: …", "gist:"), or
 * setting a rule ("new rule:", "from now on say…", "always say…"). Dropped
 * whole, like INJECTION_SHAPED: "rides the AI agent narrative", "the bot
 * narrative is strong" and "for the culture" are views, and stay.
 */
export const AT_THE_READER =
  /\b(?:hey|dear|attention|note to|memo to)\s+(?:the\s+|any\s+|all\s+)?(?:ai|bots?|gpt|llms?|models?|assistants?|summari[sz]ers?)\b|\b(?:any|the|an?|every)\s+(?:ai|bots?|llms?|models?)\s+(?:reading|summari[sz]ing|parsing)\b|\bsum\s+(?:this|it|these|them)\s+up\b|\bsummari[sz](?:e|es|ing)\s+(?:this|these|it|them)\b|\bsummary\s+for\b|\b(?:gist|for|against|waiting[_ ]on)\s*:|\bnew rules?\s*:|\bfrom now on\b[^.!?\n]{0,20}\b(?:say|write|tell|call)\b|\balways\s+(?:say|write|call)\b/i;
/**
 * A lure, not a view: a claim page, a seed phrase, a wallet to connect,
 * verify, sync or revoke, tokens to migrate, a portal, something to sign,
 * eligible wallets, free tokens, someone to message, contact or follow (the same
 * shapes OUT_LURE drops from what the model writes).
 */
export const LURE =
  /\b(?:air\s*-?\s*drops?|claim(?:ing|s|able)?|pre\s*-?\s*sales?|whitelist(?:s|ed)?|seed\s*phrase|private\s*key|connect\s+(?:your\s+)?wallet|free\s+tokens?|dm\s+me)\b|\bfollow\s+(?:the\s+|their\s+|its\s+|his\s+|her\s+)?\S+\s+on\s+(?:x|twitter|telegram|tg)\b|\b(?:contact|reach\s+out\s+to|ping|write\s+to|message|dm)\s+(?:the\s+|an?\s+)?(?:dev|devs|admins?|team|mods?|moderators?|support)\b|\b(?:verify|validate|sync|revoke|link)\s+(?:your\s+|their\s+|a\s+|the\s+)?wallets?\b|\bmigrate\s+(?:your\s+|their\s+|the\s+)?tokens?\b|\bmigration\s+(?:portal|site|page|link)\b|\bportal\b|\bsign\s+(?:the\s+|an?\s+)?(?:approval|transaction|message|permit)\b|\beligible\s+wallets?\b|\ballocations?\s+(?:for|to)\s+(?:eligible|holders|wallets)\b/i;
/** A site's name spelled out ("ponsfi dot bet", "pons dot vip"): a link the model could rebuild, never a view. */
export const SPELLED_DOMAIN = /[\p{L}\p{N}_-]\s+dot\s+\p{L}{2,}(?![\p{L}\p{N}])/iu;
/** A row about Merrymen itself ("the merrymen bot picked it") is about the agent, not the coin. */
export const ABOUT_MERRYMEN = /\bmerrym[ae]n\b/i;
/**
 * A letter of another script than Latin (Chinese, Cyrillic, Greek, a
 * lookalike): every check here and in theses.ts is English, and a sentence
 * with no spaces never forms the five-word run the paraphrase may not copy,
 * so such a row never reaches the model (review r4), nor a room as a quote.
 * Accented Latin ("café") and emoji stay.
 */
export const NON_LATIN = /(?=\p{L})\P{Script=Latin}/u;

// ── moved from theses.ts, unchanged ─────────────────────────────────────────

/**
 * A lure, not a view, said back to a room: an airdrop, a presale, free tokens,
 * a wallet to connect, verify, sync or revoke, tokens to migrate, a portal,
 * something to sign, eligible wallets, someone to message or contact. The
 * prompt asks for none; code makes sure (docs/tg-groups.md rule 3,
 * fomo/digest.ts never says an airdrop). The bare "verified", "allocation",
 * "migration" and "contact" stay ("the contract is verified", "worries about
 * the team allocation").
 */
export const OUT_LURE =
  /\b(?:air\s*-?\s*drops?|pre\s*-?\s*sales?|whitelist(?:s|ed)?|seed\s*phrase|private\s*key|connect\s+(?:your\s+)?wallet|free\s+tokens?|(?:dm|message)\s+(?:me|us|the\s+(?:dev|devs|admin|admins|team|mods?)))\b|\bfollow\s+(?:the\s+|their\s+|its\s+|his\s+|her\s+)?\S+\s+on\s+(?:x|twitter|telegram|tg)\b|\b(?:contact|reach\s+out\s+to|ping|write\s+to)\s+(?:the\s+|an?\s+)?(?:dev|devs|admins?|team|mods?|moderators?|support)\b|\b(?:verify|validate|sync|revoke|link)\s+(?:your\s+|their\s+|a\s+|the\s+)?wallets?\b|\bmigrate\s+(?:your\s+|their\s+|the\s+)?tokens?\b|\bmigration\s+(?:portal|site|page|link)\b|\bportal\b|\bsign\s+(?:the\s+|an?\s+)?(?:approval|transaction|message|permit)\b|\beligible\s+wallets?\b|\ballocations?\s+(?:for|to)\s+(?:eligible|holders|wallets)\b/i;
/**
 * A phrase that speaks to the room ("verify your wallet or lose your
 * allocation", "you're still early"): a summary of other people's claims
 * never needs to address anyone, and a lure always does. A quote at the
 * reader ("if you're not in you're ngmi") is dropped for the same reason.
 */
export const SECOND_PERSON = /\b(?:you|your|yours|you're|youre|you've|you'll|y'all|ya'll|ur)\b|\bu\b(?!\.s\b)/i;
/**
 * A CRIME LAID AT SOMEONE'S DOOR, said back to a room: theft, robbery,
 * looting, siphoning or draining the treasury, swindling, defrauding, a
 * grifter, fleecing, deceit, ripping off, faking (an audit) or botting (the
 * volume), an arrest, an indictment or jail, "is a con", a stolen or
 * pulled pool, walking off with the money, laundering, wash trading or
 * manipulation, lying, a cash grab, dumping on followers, a criminal, a
 * predator. Never the bare "lies" or "lying" ("the value lies in…", "lying
 * low"), "rob" inside a word ("a robust community"), the bare "loot" or "con"
 * ("one con is the thin liquidity"). Theses are claims about identifiable
 * people (a coin's dev, its team), and worries stay worries (THESES_SYSTEM):
 * the gate's accusation clause knows rug, scam, honeypot, ponzi, fraud and a
 * dev dumping, not these. Kept out of the gate's common clauses, so research
 * and desk lines that pass today still pass; the gate's `quote` kind reads
 * it, and so does the rug permit's companion RUG_CONTEXT_ACCUSE. "Worries the
 * dev could pull liquidity", "liquidity is locked" and "the community took
 * over" are worries and facts, and stay; a rare false drop ("a theft-proof
 * vault") costs one phrase.
 */
export const OUT_ACCUSE =
  /\b(?:st(?:eal|eals|ealing|ole|olen)|theft|thie(?:f|ves|ving)|crook(?:s|ed)?|launder\w*|criminals?|crimes?|con\s+(?:artists?|man|men)|convicted|felons?|pedo\w*|paedo\w*|predators?|embezzl\w*|(?:ran|walked|made|went|got)\s+(?:off|away)\s+with|(?:disappeared|vanished|fled)\s+with|(?:pulled|drained|removed|took|yanked)\s+(?:all\s+|out\s+)?(?:of\s+)?(?:the\s+|their\s+|its\s+|everyone'?s\s+)?(?:liquidity|lp|pool)|rob(?:s|bed|bing|bery|beries)?|loot(?:ed|ing)|siphon(?:s|ed|ing)?|swindl\w*|defraud\w*|grift\w*|fleec(?:e|ed|es|ing)|deceiv\w*|ripp(?:ed|ing)\s+(?:\w+\s+)?off|rip-?offs?|drain(?:s|ed|ing)?\s+(?:the\s+|their\s+|its\s+)?(?:treasury|funds|wallets?|holders)|arrest\w*|indict\w*|jail(?:ed)?|fak(?:ed|ing)\s+(?!out\b)|bott(?:ed|ing)\s+(?:the\s+)?volume|(?:is|was)\s+a\s+(?:total\s+|complete\s+|known\s+)?con\b|manipulat\w*|wash[\s-]?trad\w*|insider\s+trading|cash[\s-]?grab|lied|liars?|(?:dump(?:ed|ing|s)?|sold|selling)\s+(?:[\w'%.]+\s+){0,4}?on\s+(?:his|her|their|the)\s+(?:followers|holders|community|buyers|fans))\b/i;
/**
 * The airdrop story without the word, in ANY slot (OUT_LURE has the word):
 * "holders get a giveaway soon", "rewards for holders", "the holder
 * snapshot", "the team gives away tokens", a handout, a free mint, a holder
 * bonus. A coin's "giveaway meme" stays, and so does the bare
 * "distribution" ("worries about the token distribution" is supply
 * concentration); a claim stays a waiting-on-only drop (theses.ts WAIT_CLAIM).
 */
export const OUT_HANDOUT =
  /\bsnapshots?\b|\bgive\s*-?\s*aways?\b(?!\s+memes?\b)|\b(?:giv(?:e|es|ing|en)|gave)\s+(?:\w+\s+){0,3}?away\b(?!\s+memes?\b)|\bhand(?:s|ed|ing)?\s*-?\s*outs?\b|\bfree\s+mints?\b|\bholder\s+bonus(?:es)?\b|\bstimmy\b|\brewards?\b|\breward\s+distribution\b|\bdistribut\w*\s+(?:to|among|for)\s+holders\b|\bsend(?:s|ing)?\s+(?:out\s+)?tokens?\b|\btokens?\s+(?:sent|drop(?:s|ped)?)\b|\bdrops?\s+to\s+holders\b/i;

// ── new: quotes and the rug permit ──────────────────────────────────────────

/**
 * A DOUBLING SCAM OR A SEND, in any wording a quote carries: "send 1 SOL to
 * get 2 back", "deposit 100 usdc and receive 200", "transfer 1 sol for 2
 * back", "double your sol", "2x your bag", and the same in Spanish ("envia 1
 * sol y recibe 2 de vuelta", "manda 2 sol"). A drainer's whole pitch is a
 * send, so a quote that asks for one is never said back. In English too, a
 * send of a coin ("deposit 1 sol get 2 sol", "send sol to the burn address")
 * and a send with something coming back ("they send 1 sol back", "sends 2
 * back") or a reason to send ("to verify", "to unlock"); and with any words
 * between the send and what comes back ("send 2 sol to this wallet, get 4
 * back instantly", "send any amount of sol to the dev and it comes back
 * doubled", "s3nd 1 sol to get 2 back"). "send it", "send it to 10m",
 * "transfer tax is 5%" and "dev sent the lp to the burn address, never
 * getting it back" stay (review, 2026-10-09).
 */
const SEND_VERB = String.raw`(?:send|sends|sent|sending|transfer|transfers|transferred|transferring|deposit|deposits|deposited|depositing|give|gives)`;
const SEND_COIN = String.raw`(?:sol|eth|usdc|usdt|bnb|btc|matic|avax|trx|ton)`;
export const SEND_FOR = U(
  new RegExp(
    /\b(?:s[e3]nd|s[e3]nt|s[e3]nding|transfer|transferring|deposit|depositing)\s+(?:\S+\s+){0,3}?(?:to\s+(?:get|receive)|(?:and|&|n)\s+(?:get|receive|recieve)|receive|recieve|get\s+\S+\s+back|for\s+\S+\s+back)\b|\b(?:s[e3]nd|s[e3]nt|s[e3]nding|transfer|transferring|deposit|depositing)\s+[^.!?\n]{0,60}?\b(?:get\s+(?:\S+\s+){0,2}?back|receive|recieve|(?:comes?|came|coming|sent|send|paid)\s+back\s+(?:doubled|tripled|double|triple|x2|2x|x3|3x))\b|\b(?:doubl(?:e|ed|ing)|tripl(?:e|ed|ing)|2x|x2|3x|x3|10x)\s+(?:your|ur|their|ya)\b|\b(?:env[ií]a|envi[ée]n?|manda|mandas|deposita|transfiere)\s+\S*\d/
      .source +
      String.raw`|\b${SEND_VERB}\s+(?:\S+\s+){0,2}?(?:[$＄]?\d[\d.,]*\s*)?${SEND_COIN}\b` +
      String.raw`|\b${SEND_VERB}\b[^.!?\n]{0,60}?(?:\b\d[\d.,]*\s*(?:x\s+)?(?:\S+\s+)?back\b|\bto\s+(?:verify|unlock|activate|validate)\b)`,
    "i",
  ),
);

/**
 * A CALL TO ACTION BESIDE WHAT WAS TAKEN OUT: "join [link]", "dm [handle] for
 * the alpha", "claim at [address]", "[link] sign up now". The link, the
 * handle or the address is already gone (fomo/dossier.ts redactExecutables,
 * fomo/render.ts groupScrub), and what is left still sends the room to it.
 * Three words either side; dropped whole, never cleaned.
 */
const CTA_VERB = String.raw`(?:join|visit|click|tap|open|check(?:\s+out)?|go\s+to|head\s+to|sign\s+up|register|claim|dm|message|contact|follow|use|buy\s+(?:at|on|from|via))`;
const PLACEHOLDER = String.raw`\[(?:link|handle|address|someone)\]`;
export const CTA_PLACEHOLDER = U(new RegExp(String.raw`\b${CTA_VERB}\b(?:[\s,:;-]+[^\s\[]+){0,3}?[\s,:;-]*${PLACEHOLDER}|${PLACEHOLDER}(?:[\s,:;-]+[^\s\[]+){0,3}?[\s,:;-]+${CTA_VERB}\b`, "i"));

/**
 * A PRICE TARGET IN A STRANGER'S WORDS: a forward-looking verb ("should be",
 * "will hit", "going to", "easy", "next", "target", "could reach", "to the
 * moon") within six words of a figure, a multiplier or a market cap with a
 * number ("undervalued at 2m mcap, should be 50m", "next 100x", "easy 10x from
 * here", "50m target"), or a move in the present tense ("this goes 50x from
 * here", "auton pumps to 20m by friday"; review, 2026-10-09). A quote may say
 * what happened ("down from 8m to 36k in a week"); a promise of what will is
 * advice in a room, whoever wrote it.
 */
const FWD = String.raw`(?:should\s+be|should\s+hit|will\s+(?:hit|be|go|reach|do|run|see|make)|going\s+to|gonna\s+(?:hit|be|go|reach|run|do)|easy|easily|next(?:\s+stop)?|targets?|could\s+(?:hit|reach|go|be|do)|can\s+(?:hit|reach|do)|heading\s+(?:to|for)|on\s+(?:its|the)\s+way\s+to|to\s+the\s+moon|minimum|at\s+least|potential|go(?:es)?|going|runs?|pumps?|sends?|prints?|flips?|rips?)`;
const FIG = String.raw`(?:[$＄]\s*\d|\d[\d.,]*\s*(?:k|m|mm|b|bn|mil|mill|million|billion|x|%)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])x\s?\d|\b(?:million|billion|mil|bil|bn|hundred\s*x|thousand\s*x)\b|\b(?:mcap|market\s*cap|mc|fdv)\b[^.!?]{0,14}\d|\d[^.!?]{0,14}\b(?:mcap|market\s*cap|mc|fdv)\b)`;
export const QUOTE_TARGET = U(new RegExp(String.raw`\b${FWD}\b(?:[^\p{L}\p{N}]+[\p{L}\p{N}'$]+){0,6}?[^\p{L}\p{N}]*${FIG}|${FIG}(?:[^\p{L}\p{N}]+[\p{L}\p{N}'$]+){0,6}?[^\p{L}\p{N}]+${FWD}\b`, "i"));

/**
 * AN ACCUSATION AGAINST PEOPLE, IN A RUGGED COIN'S CONTEXT. The rug permit
 * (gate.ts) lifts the bare word "rugged" about a coin, never a person: so
 * dumping or selling ON people ("whales dumped on holders", "kaleo dumped on
 * everyone", "sold on us", "kaleo dumped his whole bag on retail": up to
 * four words before the "on"), someone pulling, draining or taking the liquidity
 * or the funds ("dev pulled the liquidity", "they drained the pool"), and
 * theft ("stole", "ran off with the money", "exited with the funds", "took
 * everything", a wallet "emptied") are refused wherever the permit applies,
 * and in every quote.
 */
const PEOPLE = String.raw`(?:us|everyone|everybody|holders|bagholders|buyers|followers|community|people|retail|you|y'all|ya'll|the\s+(?:community|holders|buyers|bagholders|followers))`;
export const RUG_CONTEXT_ACCUSE = U(
  new RegExp(
    String.raw`\b(?:dump(?:ed|ing|s)?|sold|selling|sells)\s+(?:[\p{L}\p{N}'%.]+\s+){0,4}?on\s+(?:(?:the|their|his|her|its|all|all\s+the)\s+)?${PEOPLE}\b` +
      String.raw`|\b[\p{L}\p{N}_']+\s+(?:(?:just|has|have|had|then|already|literally|basically|totally)\s+)*(?:pulled|pulls|pulling|drained|drains|draining|removed|removes|yanked|yanks|took|takes|rugged)\s+(?:out\s+)?(?:all\s+)?(?:of\s+)?(?:the\s+|their\s+|its\s+|our\s+|his\s+|her\s+)?(?:liquidity|lp|pool|funds)\b` +
      String.raw`|\b(?:stole|stolen|steal(?:s|ing)?|thief|thieves|ran\s+(?:off\s+|away\s+)?with\s+(?:the|our|your|their|all|everyone'?s)\s+(?:money|funds|liquidity|lp|bag|bags)|exit(?:ed)?\s+with|took\s+(?:everything|it\s+all)|emptied)\b`,
    "i",
  ),
);

/**
 * MERRYMEN AS A PLAY. The persona's brag about a rugged coin ("rugged cause
 * it wasn't merrymen 😤") is a joke about where the coin did not come from,
 * never an invitation: Merrymen (or "one of ours") within forty characters of
 * a buy, a hold, a switch, a promise or a pump ("rugged, buy merrymen
 * instead", "merrymen is the play", "merrymen coins never rug", "stick to
 * merrymen coins"; and "swap to", "get", "pick", "choose", "try", "need",
 * "park it in", "put it in", "go with": review, 2026-10-09) is advice, and
 * never said (WP3; HARD EXCLUSION: nothing about buying or holding
 * Merrymen's own coin). "Ours" and "our coin" are Merrymen too, and its
 * holders, tokens that unlock, joining, a wallet, a payment, a vip room or
 * "only go up" are a play (review r2: "merrymen tokens unlock the vip room",
 * "ours only go up", "merrymen holders are fine tho").
 */
const MERRY = String.raw`(?:merry\s?m[ae]n|one\s+of\s+ours|ours|our\s+(?:own\s+)?(?:coins?|tokens?))`;
const SHILL = String.raw`(?:buy|buys|buying|bought|ape|aped|aping|grab|grabbed|get|gets|getting|swap|swaps|swapped|swapping|pick|choose|try|need|park|put|go\s+with|load|loaded|loading|stick|switch|rotate|hold|holding|hodl|bag|bags|invest|investing|play|move|only|moon|mooning|pump|pumping|send|sending|next|safe|safer|never\s+rugs?|can'?t\s+rug|won'?t\s+rug|don'?t\s+rug|doesn'?t\s+rug|never\s+dumps?|can'?t\s+dump|won'?t\s+dump|guarantee\w*|instead|holders?|unlock\w*|join|go(?:es)?\s+up|up\s+only|wallets?|pay(?:s|ing|ment|ments)?|vip)`;
export const MERRY_SHILL = U(new RegExp(String.raw`\b${MERRY}\b[^.!?\n]{0,40}\b${SHILL}\b|\b${SHILL}\b[^.!?\n]{0,40}\b${MERRY}\b`, "i"));

/** A Merrymen brag already said: what makes the next one wait (no brag back to back). */
export const MERRY_BRAG = U(/\bmerry\s?m[ae]n\b|\bone of ours\b/i);
/**
 * A BRAG IN ANY WORDS THE PROMPT INVITES ("wasn't ours", "should've been
 * ours", "not one of us", Sherwood), for the persona's own lines under a
 * permit and its own recent lines: a paraphrase is as spent as the word
 * "merrymen". A false match ("ours is better") only holds a brag back
 * (review, 2026-10-09). A stranger's quote is still read by MERRY_BRAG.
 */
export const SPENT_BRAG = U(/\bmerry\s?m[ae]n\b|\b(?:one\s+of\s+)?ours\b|\bone\s+of\s+us\b|\bsherwood\b/i);

/**
 * A POST-RUG DRAINER LURE, for quotes only: a refund, compensation, recovery,
 * reimbursement or being "made whole"; something to approve; a v2, a
 * relaunch, a new contract or a migration to do now; a swap at an "official"
 * place; somewhere to search, check or read (their x, the pinned post, the
 * bio); a support ticket; a vip or paid group; a send that comes back more.
 * And the drainer's asks in other words (review r2): "the 12 words", a
 * recovery, secret, backup or seed phrase, a private key; connecting "the"
 * wallet, walletconnect; syncing with a dapp, wallet rectification or
 * validation, a dapp, a "safeguard" bot, redeeming; unlocking, unsticking or
 * unfreezing sells; dropping, posting or commenting wallets or addresses;
 * filling a form; "in the pinned"; bridging before a freeze. The relaunch
 * and the handout reworded too: "v 2", "version two", "2.0 launching", "re
 * launch", "holders covered", "free drop", "holders get … free", "bonus
 * tokens", "tokens for holders" (OUT_HANDOUT, which the digest reads, is
 * unchanged).
 * After a coin collapses this is what its page fills with, and the stripped
 * remnant of a link ("is the new site", "for the money back") still sends
 * the room to it. "No recovery in sight" and "rugged, holders got wrecked"
 * stay. Never read by the sample cleaner or the paraphrase (LURE, OUT_LURE
 * unchanged); a rare false drop costs one counted quote (review, 2026-10-09).
 */
export const POST_RUG_LURE = U(
  new RegExp(
    String.raw`\b(?:refund\w*|reimburs\w*|compensat\w*|restitution|made\s+whole|giv(?:e|es|ing)\s+back|recover(?:y|ing)?\s+(?:\S+\s+){0,2}?(?:funds?|sol|eth|money|bags?|tokens?|wallets?|tool|bot|service|agent|app|site)|approv(?:e|es|al|ing)|v2|relaunch\w*|re-launch\w*|new\s+(?:ca|contract|token)|migrat(?:e|ion)\s+(?:now|today|here|asap|before|over)` +
      String.raw`|swap\b[^.!?\n]{0,30}\b(?:official|site|link|bot|portal|new|v2)|official\s+(?:site|link|channel|bot|group|website|tg|telegram|discord|x|twitter)` +
      String.raw`|(?:search|google|look\s+up|find)\b[^.!?\n]{0,30}\b(?:refund\w*|bot|link|site|channel|group|telegram|tg|discord|bio)` +
      String.raw`|check\s+(?:out\s+)?(?:the\s+|their\s+|its\s+|his\s+)?(?:x|twitter|telegram|tg|discord|site|website|pinned|pin|bio|channel|description|desc|banner)|read\s+(?:the\s+)?pinned|links?\s+in\s+(?:the\s+|their\s+)?bio` +
      String.raw`|(?:open|create|submit|raise)\s+(?:a\s+)?(?:support\s+)?ticket|support\s+ticket|(?:vip|alpha|paid|private)\s+(?:group|chat|channel|calls?)` +
      String.raw`|(?:12|24|twelve|twenty[\s-]?four)\s+words|(?:recovery|secret|seed|s[e3]{2}d|mnemonic|backup)\s+(?:phrase|words?)|priv(?:ate)?\s*keys?` +
      String.raw`|connect\s+(?:the\s+|a\s+|ur\s+|their\s+|my\s+)?wallets?|wallet\s*connect` +
      String.raw`|sync\b[^.!?\n]{0,30}\b(?:dapp|wallet|bot|site|tool)|rectif\w*|wallet\s+(?:sync|validat\w*)|dapps?|safeguard|redeem\w*` +
      String.raw`|(?:unlock|unstick|unfreeze)\w*\s+(?:the\s+)?sells?|sells?\s+(?:unlock|work\s+again)` +
      String.raw`|(?:drop|post|reply\s+with|comment)\s+(?:the\s+|their\s+|ur\s+)?(?:wallets?|address(?:es)?)` +
      String.raw`|(?:fill|submit)\s+(?:out\s+)?(?:the\s+|a\s+)?forms?|in\s+the\s+pinned|bridge\b[^.!?\n]{0,30}\bbefore` +
      String.raw`|v\s*\.?\s*2|version\s+(?:2|two)|\d\.0\s+(?:launch\w*|live|is\s+live|drop\w*)|re[\s-]+launch\w*|(?:old\s+)?holders?\s+(?:are\s+|will\s+be\s+|get\s+|got\s+)?covered` +
      String.raw`|free\s+drops?|holders?\s+(?:get|gets|getting|will\s+get)\s+(?:\S+\s+){0,2}?free|bonus\s+tokens?|tokens?\s+for\s+(?:all\s+|old\s+)?holders` +
      String.raw`|(?:send|sent|sending|transfer\w*|deposit\w*|give)\s+(?:\S+\s+){0,2}?\d[\d.,]*[^.!?\n]{0,40}\b(?:get|got|gets|receive\w*|return\w*|sends?|take)\s+\S*\d)\b`,
    "i",
  ),
);

/**
 * A LINK SPELLED OUT WITHOUT "DOT", for quotes only (SPELLED_DOMAIN, which
 * the sample and the paraphrase read, is unchanged): a "slash" path
 * ("discord gg slash autonrefund"), another word for the dot ("point",
 * "punto", "dott") or a comma before a top-level domain ("autonrefund,com"),
 * a link host with its dot gone ("bit ly", "tme", "x com", "vercel app"),
 * and "visit <name> com". Each can be rebuilt into a working link, and a
 * quote never carries one (review, 2026-10-09). Also (review r2) ";" or ":"
 * as the dot, "period" or "dt", "dot" wrapped in punctuation, a hyphen for
 * the dot, a host without its dot and with a path ("t,me/", "t_me/",
 * "tdotme/", "bitly/", "pumpfun/auton", "x/autonarmy"), "hxxps", and a name
 * then a space and com, org, io or xyz ("autonhub com"). "Launched on
 * pumpfun", "tg/x both quiet" and "safety net" stay; "<name>. fun" cannot be
 * told from a sentence break and is not read.
 */
const LINK_TLD = String.raw`(?:com|net|org|io|xyz|gg|ly|app|fun|vip|site|info|cc|tv)`;
export const SPELLED_LINK = U(
  new RegExp(
    String.raw`\bslash\s+[\p{L}\p{N}_]` +
      String.raw`|[\p{L}\p{N}_-](?:\s+(?:point|punto|dott|d0t|dawt|period|dt)\s+|[,;:])${LINK_TLD}\b` +
      // 'dot' wrapped in any punctuation ("'dot'", "-dot-", "_dot_"), and a hyphen in place of the dot.
      String.raw`|[\p{L}\p{N}](?:\s*[^\p{L}\p{N}\s]+\s*dot[^\p{L}\p{N}]*|\s*dot\s*[^\p{L}\p{N}\s]+\s*)${LINK_TLD}\b` +
      String.raw`|[\p{L}\p{N}](?<!\bdot)-(?:com|net|org|io|xyz)\b` +
      String.raw`|\b(?:discord\s*gg|dsc\s*gg|bit\s*ly|linktr\s*ee|t\s+me|tme|tdotme|tinyurl|linktree|(?:vercel|netlify)\s+app|(?:x|twitter)\s+com)\b` +
      // A host with its dot gone and a path after it ("t,me/", "t_me/", "pumpfun/auton", "x/autonarmy").
      String.raw`|\b(?:t|telegram)[\s,;:_-]*(?:dot)?[\s,;:_-]*me\s*\/|\b(?:x|twitter|tg|discord|pump\s*fun|cutt\s*ly|rb\s*gy|is\s*gd)\s*\/\s*[\p{L}\p{N}_]{3}` +
      String.raw`|\bhxxps?\b` +
      // "visit <name> com", and a name of four letters or more then a space and com, org, io or xyz (never the bare "net": "safety net").
      String.raw`|\b(?:visit\s+[\p{L}\p{N}_-]+\s+(?:com|net|org|io|xyz)|(?!dot\b)[\p{L}\p{N}_-]{4,}\s+(?:com|org|io|xyz))\b`,
    "i",
  ),
);

/**
 * A PERSON'S PRIVATE DETAILS, for quotes only: a real, full, legal or last
 * name, where someone lives or works ("the dev lives at…", "he's based in…",
 * "works at a bank"), a home or street address, a house number on a street,
 * a phone, an email, a whatsapp or a profile ("his insta is…", "on
 * linkedin"), "his name is…", a dox. After a rug, doxxing the dev is the
 * likeliest post, and private data never passes (rule 3). Also (review r2)
 * "the dev is <first> <last> from <town>", "dev's name is", a role's mom,
 * wife, kids, house, school or passport, resides, lives on or with, works
 * for, someone named, a multi-word street, a passport, a birth year, a mail
 * provider, a github handle told. "Liquidity lives
 * on raydium" stays: only a person lives somewhere, and a bare "number"
 * ("the number one coin") is never one (review, 2026-10-09).
 */
const PRIVATE_SUBJECT = String.raw`(?:dev|devs|he|she|they|team|founder|ceo|owner|creator|guy|kid|dude)`;
/** Whose details (review r2): the dev and the like, and a possessive. */
const PRIVATE_ROLE = String.raw`(?:dev|devs|deployer|founder|creator|ceo|owner|he|she|his|her|their|guy|dude)`;
/** A profile handle told: "github is tadeyemi", never "github is active". */
const NOT_A_HANDLE = String.raw`(?:active|dead|quiet|empty|public|private|clean|legit|real|fake|new|old|busy|live|down|up|great|good|solid|open|closed|gone|full|pretty|very|super|still|really|not|a|an|the)`;
export const PRIVATE_THIRD = U(
  new RegExp(
    String.raw`\b(?:real|full|legal|irl|first|last)\s*-?\s*names?\b|\bsurnames?\b|\b(?:his|her|their)\s+name\s+is\b` +
      String.raw`|\b${PRIVATE_SUBJECT}\b[^.!?\n]{0,20}?\b(?:(?:lives?|living|based)\s+(?:in|at|near)|works?\s+at)\b` +
      String.raw`|\b(?:home|house|street|mailing|postal)\s+address(?:es)?\b|\bdox+\w*` +
      String.raw`|\b(?:phone|whatsapp|e-?mail|insta(?:gram)?|linkedin|facebook)\b|\big(?:\s*:|\s+is\b)|\birl\b` +
      // Review r2: a role's name, address, family, home, school or papers ("dev's name is", "the dev's mom is", "his kid goes to").
      String.raw`|\b${PRIVATE_ROLE}(?:'s|’s|s')?\s+(?:real\s+|full\s+)?(?:name|address|addy|mom|mum|mother|dad|father|wife|husband|gf|bf|girlfriend|boyfriend|kids?|son|daughter|family|parents|house|home|apartment|flat|school|passport|birthday)\b` +
      String.raw`|\b(?:${PRIVATE_SUBJECT}|deployer)\b[^.!?\n]{0,20}?\b(?:resides?|residing|lives?\s+(?:on|with)|works?\s+for|employed\s+(?:by|at)|(?:goes|went)\s+to\s+(?:school|college|uni|university))\b` +
      String.raw`|\b(?:${PRIVATE_SUBJECT}|deployer|someone|man|woman)\s+(?:(?:is|was)\s+)?named\s+\p{L}|\b(?:${PRIVATE_SUBJECT}|deployer|someone|man|woman)\s+(?:is|was)\s+called\s+\p{L}` +
      String.raw`|\b(?:dev|deployer|founder|creator|ceo|owner)\s+(?:is|=|was)\s+\p{L}+\s+\p{L}+\s+(?:from|of)\s+\p{L}` +
      // A house number then up to three words and a street word ("221b baker street", "12 north main street").
      String.raw`|\b\d+\p{L}?\s+(?:\p{L}+\s+){1,3}(?:street|st|road|rd|avenue|ave|lane|ln|blvd|boulevard|drive|dr|close|court|way)\b` +
      String.raw`|\b(?:on|at)\s+(?!(?:the|a|an|this|that|our|its|their|his|her|my|your)\b)(?:\p{L}+\s+){1,2}(?:street|road|avenue|lane|boulevard)\b` +
      String.raw`|\bpassports?\b|\bssn\b|\bsocial\s+security\b|\bdate\s+of\s+birth\b|\bborn\s+(?:in\s+)?(?:19|20)\d\d\b` +
      String.raw`|\b(?:at|@)\s*(?:gmail|googlemail|proton(?:mail)?|yahoo|outlook|hotmail|icloud)\b|\b(?:gmail|protonmail|hotmail)\b` +
      String.raw`|\b(?:github|gitlab)\s+(?:is|=|:)\s+(?!${NOT_A_HANDLE}\b)[\p{L}\p{N}_-]+`,
    "i",
  ),
);

/**
 * A CONTACT LURE OR A CHANNEL POINTER, for quotes only: "inbox me", "pm us",
 * "hmu", "hit me up", a channel named without its @ ("telegram: autonarmy",
 * "join autonarmy on telegram"), a link or a contact "pinned" or "in the
 * bio", "search <name> on google", and a name ending in "claim" or "portal"
 * ("autonclaim", "autonportal"; never "reclaim", "proclaim", "acclaim").
 * And DM bait and recovery-scam contacts (review r2): "contact me", "ping
 * me", "reach out to me", "into my dms", "my dms are open", "dm for the
 * fix", "hit my line", "talk to an admin", "dm the bot", "google
 * autonhelp", "on signal", "at proton", and a name ending in recovery,
 * support, helpdesk or rescue ("autonrecovery"). "My dm from the dev never
 * came" and "strong support here" stay. And a channel or group pointed at
 * without its @ (review r2): "telegram autonarmy has the updates", "join the
 * auton army on tg", "join the tg", "join autonarmy, …", a new, real, backup
 * or official chat or group, "ask the mods", a QR code. "The telegram is
 * dead", "telegram community is strong" and "new holders keep joining" stay.
 * The words of LURE and OUT_LURE are unchanged; "the telegram is dead" and
 * "contact with the team is lost" stay (review, 2026-10-09).
 */
export const CONTACT_LURE = U(
  new RegExp(
    String.raw`\b(?:pm|inbox|dm|text|msg)\s+(?:me|us)\b|\bhmu\b|\bhit\s+(?:me|us)\s+up\b` +
      String.raw`|\b(?:telegram|tg|discord|whatsapp|signal|twitter|x)\s*[:=]\s*[\p{L}\p{N}_]|\bjoin\s+(?:the\s+|our\s+)?[\p{L}\p{N}_]+\s+(?:on|in)\s+(?:telegram|tg|discord|whatsapp|signal)\b` +
      String.raw`|\blink\s+(?:is\s+)?(?:pinned|in\s+(?:the\s+)?(?:bio|description|comments?|replies))\b|\b(?:contact|address|ca|link)\s+(?:is\s+)?in\s+(?:the\s+|my\s+)?(?:description|bio|comments?|replies|pinned)\b` +
      String.raw`|\bsearch\s+[\p{L}\p{N}_]+\s+on\s+(?:google|telegram|tg|x|twitter)\b|(?<=[\p{L}\p{N}])(?<!(?:re|dis|pro|ac|ex))(?:claim|portal)\b` +
      String.raw`|\b(?:contact|ping|reach\s+out\s+to|write\s+to|message|d\s*\.?\s*m)\s+(?:me|us)\b|\b(?:in|into)\s+(?:my|our)\s+(?:dms?|inbox|pms?)\b|\b(?:dms?|inbox|pms?)\s+(?:are\s+|is\s+)?open\b` +
      String.raw`|\b(?:dm|pm|inbox|msg)\s+(?:for|if)\b|\bhit\s+(?:my|our)\s+line\b|\b(?:talk|speak)\s+to\s+(?:an?\s+|the\s+)?(?:admins?|mods?|support|bot)\b|\b(?:dm|pm|message|contact|ping|text)\s+the\s+bot\b` +
      String.raw`|\b(?:google|look\s+up)\s+[\p{L}\p{N}_]+(?:help|support|recovery|rescue)\b|\bon\s+signal\b|\bat\s+(?:proton|gmail|outlook)\b|(?<=[\p{L}\p{N}])(?:recovery|support|helpdesk|rescue)\b` +
      String.raw`|\b(?:telegram|tg|discord|twitter)\s+(?:(?:chat|group|channel|handle|account|page)\s+)?(?:is\s+|it'?s\s+)?[\p{L}\p{N}_]+\s+(?:has|have|posts?|got|for)\s+(?:all\s+)?(?:the\s+)?(?:real\s+|latest\s+|new\s+)?(?:updates?|news|alpha|info|calls?|links?|raids?)\b` +
      String.raw`|\bjoin\s+(?:the\s+|our\s+)?(?:[\p{L}\p{N}_]+\s+){1,3}?(?:on|in)\s+(?:telegram|tg|discord|whatsapp|signal)\b|\bjoin\s+(?:the\s+)?(?:tg|telegram|discord)\b|\bjoin\s+[\p{L}\p{N}_]+\s*,` +
      String.raw`|\b(?:new|real|backup|official|actual)\s+(?:chat|group|channel|tg|telegram|discord)\b|\bask\s+(?:the\s+|an?\s+)?(?:mods?|admins?|devs?|team|support)\b|\bqr\b`,
    "i",
  ),
);

/**
 * A QUOTE IN ANOTHER LANGUAGE, for quotes only (review r2): every clause here
 * is English, so a buy call, a threat, an address or an accusation in
 * Spanish, Portuguese, French, German, Italian, Indonesian, Dutch or Turkish
 * passed them all. Quotes are English, as the paraphrase is: a row with a
 * function word of another language that is not also an English word
 * ("para", "ahora", "agora", "vai", "est", "und", "ist", "che", "ini",
 * "yang", "al", "el"), or a row of five words or more with no common English
 * word at all (ENGLISH_WORDS), is left out and counted. "Die", "con", "um", "dan", "les",
 * "la" and "a" are English words too, and are never read as another
 * language's.
 */
export const NOT_ENGLISH = U(
  new RegExp(
    String.raw`\b(?:el|los|las|una|unos|que|qué|del|por|para|ahora|agora|antes|cuando|voy|vamos|muy|pero|como|esta|está|este|estos|uma|não|nao|vai|você|voce|mas|muito|também|une|des|du|est|est-ce|il|ils|elle|avec|pas|sont|c'est|nous|vous|très|tres|rue|ist|und|der|das|ein|eine|nicht|ich|wir|sehr|auch|che|sono|della|molto|perché|anche|questo|è|é|yang|nya|ini|itu|sekarang|tidak|sudah|akan|dengan|untuk|dari|jalan|rumah|al|het|een|niet|zijn|bir|ve|bu|çok|için)\b`,
    "i",
  ),
);
/**
 * Words a row in English nearly always has one of, beside the BIP-39 list
 * the gate holds (gate.ts quoteNotEnglish): function words and the trenches'
 * own ("gm", "wagmi", "mcap", "dyor"). A row of five words or more with none
 * of them, in any common ending, is in another language.
 */
export const ENGLISH_WORDS: readonly string[] = (
  "the is are was were and of to it this that in on for with not but i im i'm we they he she will be has have had just still so my its it's " +
  "a an at by from up down out all no yes if or as can got get been do did dont don't what who why how when there their our us me you your " +
  "lol lmao gm ngl tbh imo dyor nfa lfg rn fr yolo rugged rug holders holder dev devs chart team coin token bullish bearish dead good bad now " +
  "mcap volume pump dump moon ath dip bag ape degen wagmi ngmi frens fren ser anon alpha narrative meta agent ai launch listing cex dex " +
  "liquidity lp whale supply wallet mint burn roadmap utility community vibe jeet sol eth btc base onchain defi nft memecoin meme trenches gem"
).split(" ");

/**
 * A VIOLENT OR SEXUAL CRIME, ABUSE, BRIBERY, EXTORTION, A POLICE CASE OR A
 * HEALTH STATUS LAID ON A PERSON, for quotes only (review r2): "kaleo beats
 * his wife", "molested a kid", "a known murderer", "a serial killer", "a
 * groomer", "abuses kids", "was bribed", "extorted the dev", "blackmailed
 * the team", "cheated everyone", "did time", "under investigation by the
 * fbi", "wanted by the sec", "charged with", "has hiv", "a pervert". Each is
 * a claim about an identifiable person the bot would repeat. OUT_ACCUSE,
 * which the paraphrase and the permit read, is unchanged. "The next eth
 * killer", "bots abuse the bonding curve", "cheat code chart", "on-chain
 * investigation shows clean wallets", "beats the market" and "aids in price
 * discovery" stay.
 */
export const PERSON_HARM = U(
  new RegExp(
    String.raw`\b(?:murder(?:s|ed|er|ers|ing|ous)?|serial\s+killers?|(?:a|known|real|cold[\s-]?blooded|convicted)\s+killers?|kill(?:s|ed)\s+(?:a|his|her|their|someone|somebody|people|man|woman|girl|boy|kid)\b` +
      String.raw`|rap(?:e|ed|es|ing|ist|ists)|molest\w*|(?:sexual(?:ly)?\s+)?assault\w*|groom(?:er|ers)|groom(?:ed|ing)\s+(?:a\s+)?(?:kids?|minors?|girls?|boys?|children|teens?)|kidd(?:ie|y)\s+fiddl\w*|nonce|pervert\w*|pervs?` +
      String.raw`|abus(?:e|es|ed|er|ers|ing)\s+(?:his|her|their|a|kids?|children|women|girls?|boys?|minors?|wife|wives|people)` +
      String.raw`|(?:beat|beats|beating|hits|hit)\s+(?:his|her|their)\s+(?:wife|wives|girlfriend|gf|husband|kids?|children|partner|mom|dad)` +
      String.raw`|brib(?:e|es|ed|ery|ing)|extort\w*|blackmail\w*|cheat(?:s|ed|ing)?\s+(?:on\s+)?(?:everyone|everybody|us|holders|people|investors|his|her|their)|cheaters?` +
      String.raw`|did\s+(?:hard\s+)?time|(?:in|to|from|out\s+of)\s+prison|(?:under|facing)\s+(?:\w+\s+)?investigation|investigated\s+(?:by|for)|wanted\s+(?:by|for)\s+(?:the\s+)?(?:police|fbi|sec|interpol|cops|feds|doj|murder|fraud)|charged\s+with|sued\s+(?:by|for)` +
      String.raw`|(?:has|got|caught|carries|with)\s+(?:hiv|aids|herpes|an?\s+stds?|stds|syphilis|chlamydia)|hiv)\b`,
    "i",
  ),
);

/**
 * HARM WISHED ON OR THREATENED AGAINST SOMEONE ELSE, for quotes only (review
 * r2): the common THREAT and SELFHARM clauses read the second person, which
 * the persona would say, and a stranger's quote speaks of third persons: a
 * violent verb on the dev, the team, holders or "him" ("hang the dev",
 * "gonna beat the dev up"), someone who "should be shot" or "deserves to
 * die", a wish of death ("hope he dies"), "needs a bullet", where the dev
 * lives or pulling up on him, swatting, self-harm wished on others ("should
 * kill themselves", "rope time"), and rape language. Never said back in a
 * room, whoever wrote it. "Learn the ropes", "shorts got killed" and "volume
 * needs to die down" stay.
 */
const HARM_PERSON = String.raw`(?:the\s+|that\s+|this\s+|these\s+|those\s+|every\s+|all\s+(?:the\s+)?)?(?:devs?|deployers?|team|founders?|creators?|owners?|holders?|bagholders?|whales?|jeets?|kols?|insiders?|scammers?|guy|dude|kid|him|her|them|he|she|they|his|their)`;
const HARM_VERB = String.raw`(?:kill|murder|shoot|stab|hang|lynch|beat|punch|strangle|choke|swat|hunt(?:\s+down)?|track\s+down|torture|behead|execute|rape)`;
export const QUOTE_HARM: readonly RegExp[] = [
  new RegExp(String.raw`\b${HARM_VERB}\s+${HARM_PERSON}\b`, "i"),
  /\b(?:should|deserves?\s+to|needs?\s+to|ought\s+to|must|gotta|has\s+to|have\s+to|gonna|going\s+to|will)\s+(?:\w+\s+)?(?:be|get)\s+(?:shot|killed|murdered|hanged|hung|lynched|stabbed|beaten|raped|tortured|executed|swatted|doxx?ed)\b/i,
  /\b(?:should|deserves?\s+to|needs?\s+to|ought\s+to|gotta|has\s+to)\s+(?:just\s+)?die\b(?!\s+(?:down|out|off))/i,
  /\b(?:hope|hoping|wish|pray)\s+(?:\w+\s+){0,3}?(?:dies|die|dead|burns?\s+(?:alive|in)|rots?|gets?\s+(?:hit|shot|killed|cancer|hanged|hung|raped|stabbed|murdered))\b(?!\s+(?:down|out|off))/i,
  /\bneeds?\s+a\s+bullet\b|\bbullet\s+(?:in|for|through)\s+(?:the\s+)?(?:dev|deployer|team|his|her|their|him|them)\b/i,
  /\bwhere\s+(?:the\s+)?(?:devs?|deployers?|founders?|team|creators?|owners?|he|she|they|him|her|them)\s+(?:lives?|sleeps?|stays?)\b|\bpull\s+up\s+(?:on|to)\s+(?:the\s+)?(?:dev|deployer|team|him|her|them|his|their)\b|\bswat(?:s|ting|ted)?\b/i,
  /\bkill\s+(?:him|her|them|my|our|your|ur|yo)\s*sel(?:f|ves)\b|\bkms\b|\brop(?:e|es|ed|ing)\b(?<!\bropes\b)|\bend\s+it\s+all\b|\bunalive\w*/i,
  /\brap(?:e|es|ed|ing|ist|ists|ey)\b/i,
].map(U);

/**
 * A PERSON BESIDE A RUG WORD THE PERMIT LIFTED: the permit says "rugged" of
 * a coin and of no one, so a line that also names the dev, the deployer, the
 * team, an insider, a whale or a KOL, points at a person ("they", "he",
 * "someone": "the deployer? full rug", "rugged, he pulled out"), thanks
 * someone for it, or says someone took,
 * emptied, cashed out, bailed, knew or shilled ("it rugged, the dev took
 * everything", "auton rugged, thanks kaleo", "rugged. dev = scum") puts the
 * rug on a person, and is refused (gate.ts; review, 2026-10-09). "This is
 * gonna rug, top holders own way too much" stays: holders are no one in
 * particular.
 */
export const PERSON_BESIDE_RUG = U(/\b(?:devs?|deployers?|team|insiders?|creators?|founders?|kols?|whales?|admins?|mods?|they|them|he|she|him|her|someone|somebody|thanks|thx)\b|\b(?:took|emptied|cashed|bailed|knew|shill\w*)\b/i);
