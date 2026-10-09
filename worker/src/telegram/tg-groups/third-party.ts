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
 * theft ("stole", "ran off with the money", "exited with the funds") are
 * refused wherever the permit applies, and in every quote.
 */
const PEOPLE = String.raw`(?:us|everyone|everybody|holders|bagholders|buyers|followers|community|people|retail|you|y'all|ya'll|the\s+(?:community|holders|buyers|bagholders|followers))`;
export const RUG_CONTEXT_ACCUSE = U(
  new RegExp(
    String.raw`\b(?:dump(?:ed|ing|s)?|sold|selling|sells)\s+(?:[\p{L}\p{N}'%.]+\s+){0,4}?on\s+(?:(?:the|their|his|her|its|all|all\s+the)\s+)?${PEOPLE}\b` +
      String.raw`|\b[\p{L}\p{N}_']+\s+(?:(?:just|has|have|had|then|already|literally|basically|totally)\s+)*(?:pulled|pulls|pulling|drained|drains|draining|removed|removes|yanked|yanks|took|takes|rugged)\s+(?:out\s+)?(?:all\s+)?(?:of\s+)?(?:the\s+|their\s+|its\s+|our\s+|his\s+|her\s+)?(?:liquidity|lp|pool|funds)\b` +
      String.raw`|\b(?:stole|stolen|steal(?:s|ing)?|thief|thieves|ran\s+(?:off\s+|away\s+)?with\s+(?:the|our|your|their|all|everyone'?s)\s+(?:money|funds|liquidity|lp|bag|bags)|exit(?:ed)?\s+with)\b`,
    "i",
  ),
);

/**
 * MERRYMEN AS A PLAY. The persona's brag about a rugged coin ("rugged cause
 * it wasn't merrymen 😤") is a joke about where the coin did not come from,
 * never an invitation: Merrymen (or "one of ours") within forty characters of
 * a buy, a hold, a switch, a promise or a pump ("rugged, buy merrymen
 * instead", "merrymen is the play", "merrymen coins never rug", "stick to
 * merrymen coins") is advice, and never said (WP3; HARD EXCLUSION: nothing
 * about buying or holding Merrymen's own coin).
 */
const MERRY = String.raw`(?:merry\s?m[ae]n|one\s+of\s+ours)`;
const SHILL = String.raw`(?:buy|buys|buying|bought|ape|aped|aping|grab|grabbed|get\s+(?:a|some|in|into|on)|load|loaded|loading|stick|switch|rotate|hold|holding|hodl|bag|bags|invest|investing|play|move|only|moon|mooning|pump|pumping|send|sending|next|safe|safer|never\s+rugs?|can'?t\s+rug|won'?t\s+rug|don'?t\s+rug|doesn'?t\s+rug|never\s+dumps?|can'?t\s+dump|won'?t\s+dump|guarantee\w*|instead)`;
export const MERRY_SHILL = U(new RegExp(String.raw`\b${MERRY}\b[^.!?\n]{0,40}\b${SHILL}\b|\b${SHILL}\b[^.!?\n]{0,40}\b${MERRY}\b`, "i"));

/** A Merrymen brag already said: what makes the next one wait (no brag back to back). */
export const MERRY_BRAG = U(/\bmerry\s?m[ae]n\b|\bone of ours\b/i);

/**
 * A POST-RUG DRAINER LURE, for quotes only: a refund, compensation, recovery,
 * reimbursement or being "made whole"; something to approve; a v2, a
 * relaunch, a new contract or a migration to do now; a swap at an "official"
 * place; somewhere to search, check or read (their x, the pinned post, the
 * bio); a support ticket; a vip or paid group; a send that comes back more.
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
      String.raw`|check\s+(?:out\s+)?(?:the\s+|their\s+|its\s+|his\s+)?(?:x|twitter|telegram|tg|discord|site|website|pinned|pin|bio|channel)|read\s+(?:the\s+)?pinned|links?\s+in\s+(?:the\s+|their\s+)?bio` +
      String.raw`|(?:open|create|submit|raise)\s+(?:a\s+)?(?:support\s+)?ticket|support\s+ticket|(?:vip|alpha|paid|private)\s+(?:group|chat|channel|calls?)` +
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
 * quote never carries one (review, 2026-10-09).
 */
const LINK_TLD = String.raw`(?:com|net|org|io|xyz|gg|ly|app|fun|vip|site|info|cc|tv)`;
export const SPELLED_LINK = U(
  new RegExp(
    String.raw`\bslash\s+[\p{L}\p{N}_]` +
      String.raw`|[\p{L}\p{N}_-](?:\s+(?:point|punto|dott|d0t|dawt)\s+|,)${LINK_TLD}\b` +
      String.raw`|\b(?:discord\s+gg|bit\s+ly|linktr\s+ee|t\s+me|tme|(?:vercel|netlify)\s+app|(?:x|twitter)\s+com)\b` +
      String.raw`|\bvisit\s+[\p{L}\p{N}_-]+\s+${LINK_TLD}\b`,
    "i",
  ),
);

/**
 * A PERSON'S PRIVATE DETAILS, for quotes only: a real, full, legal or last
 * name, where someone lives or works ("the dev lives at…", "he's based in…",
 * "works at a bank"), a home or street address, a house number on a street,
 * a phone, an email, a whatsapp or a profile ("his insta is…", "on
 * linkedin"), "his name is…", a dox. After a rug, doxxing the dev is the
 * likeliest post, and private data never passes (rule 3). "Liquidity lives
 * on raydium" stays: only a person lives somewhere, and a bare "number"
 * ("the number one coin") is never one (review, 2026-10-09).
 */
const PRIVATE_SUBJECT = String.raw`(?:dev|devs|he|she|they|team|founder|ceo|owner|creator|guy|kid|dude)`;
export const PRIVATE_THIRD = U(
  new RegExp(
    String.raw`\b(?:real|full|legal|irl|first|last)\s*-?\s*names?\b|\bsurnames?\b|\b(?:his|her|their)\s+name\s+is\b` +
      String.raw`|\b${PRIVATE_SUBJECT}\b[^.!?\n]{0,20}?\b(?:(?:lives?|living|based)\s+(?:in|at|near)|works?\s+at)\b` +
      String.raw`|\b(?:home|house|street|mailing|postal)\s+address(?:es)?\b|\bdox+\w*` +
      String.raw`|\b\d+\s+\p{L}+\s+(?:street|st|road|rd|avenue|ave|lane|ln|blvd|boulevard|drive|dr|close|court|way)\b` +
      String.raw`|\b(?:phone|whatsapp|e-?mail|insta(?:gram)?|linkedin|facebook)\b|\big(?:\s*:|\s+is\b)|\birl\b`,
    "i",
  ),
);

/**
 * A CONTACT LURE OR A CHANNEL POINTER, for quotes only: "inbox me", "pm us",
 * "hmu", "hit me up", a channel named without its @ ("telegram: autonarmy",
 * "join autonarmy on telegram"), a link or a contact "pinned" or "in the
 * bio", "search <name> on google", and a name ending in "claim" or "portal"
 * ("autonclaim", "autonportal"; never "reclaim", "proclaim", "acclaim").
 * The words of LURE and OUT_LURE are unchanged; "the telegram is dead" and
 * "contact with the team is lost" stay (review, 2026-10-09).
 */
export const CONTACT_LURE = U(
  new RegExp(
    String.raw`\b(?:pm|inbox|dm|text|msg)\s+(?:me|us)\b|\bhmu\b|\bhit\s+(?:me|us)\s+up\b` +
      String.raw`|\b(?:telegram|tg|discord|whatsapp|signal|twitter|x)\s*[:=]\s*[\p{L}\p{N}_]|\bjoin\s+(?:the\s+|our\s+)?[\p{L}\p{N}_]+\s+(?:on|in)\s+(?:telegram|tg|discord|whatsapp|signal)\b` +
      String.raw`|\blink\s+(?:is\s+)?(?:pinned|in\s+(?:the\s+)?(?:bio|description|comments?|replies))\b|\b(?:contact|address|ca|link)\s+(?:is\s+)?in\s+(?:the\s+|my\s+)?(?:description|bio|comments?|replies|pinned)\b` +
      String.raw`|\bsearch\s+[\p{L}\p{N}_]+\s+on\s+(?:google|telegram|tg|x|twitter)\b|(?<=[\p{L}\p{N}])(?<!(?:re|dis|pro|ac|ex))(?:claim|portal)\b`,
    "i",
  ),
);
