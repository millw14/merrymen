/**
 * WHAT MERRYMEN MEANS BY ITS OWN WORDS.
 *
 * The chat could always talk about YOUR agent — its equity, its positions, what
 * it did this morning. It could not explain what any of those words mean, so
 * every question of the form "what IS this" hit a model with no product
 * knowledge, and a model with no product knowledge does one of two things:
 * refuses, or invents something plausible about how crypto usually works. On a
 * screen where somebody has just sent real money, the second is worse.
 *
 * Testers asked, in one hour:
 *
 *   "I tried to fund my wallet with USDG but it didn't arrive"   (it had)
 *   "recovery key is only a bunch of dots"                       (by design)
 *   "couldn't read your owner key — don't fund this account"     (nothing wrong)
 *   "your wallet is on 0x… but you signed in as 0x…"             (two wallets, deliberately)
 *
 * Every one of those has a precise answer that lives in this codebase and
 * nowhere else. A general-purpose model cannot know that merrymen's `equity`
 * excludes ETH, that a balance can sit at an address with no contract deployed,
 * or that the owner key and the login wallet were never the same key. So the
 * answers are written down HERE, next to the code that makes them true, and the
 * chat is given the relevant ones rather than asked to remember.
 *
 * THREE RULES, and they are the whole design:
 *
 *  1. GROUNDED OR ABSENT. Every entry describes what this code does, cited to
 *     the file that does it. If merrymen's meaning differs from the industry
 *     meaning, the difference IS the entry — that gap is where users get hurt.
 *  2. SELECTED DETERMINISTICALLY. Which concepts reach the prompt is decided by
 *     this file, by matching words, not by a model choosing what to look up. A
 *     retrieval step that can hallucinate its own inputs is not retrieval.
 *  3. SILENCE IS AN ANSWER. A question that matches nothing returns nothing,
 *     and the prompt then tells the agent to say it does not know. The failure
 *     mode this replaces is a confident answer about a product the model has
 *     never seen.
 *
 * PURE. No I/O, no model, no chain. Handed a question, returns entries.
 */

export interface Concept {
  /** The word as a user would meet it on screen. */
  term: string;
  /**
   * Other ways somebody might say it, lowercase. These are what the matcher
   * actually reads — a person types "my money isn't showing", not "equity".
   */
  aliases: readonly string[];
  /** One or two sentences, no jargon, for somebody who has just sent money. */
  plain: string;
  /** The mechanism, one sentence. Why it works this way HERE. */
  because: string;
  /** What people mistake it for, or the industry meaning that differs. */
  confusable?: string;
  /** Where in this repo the behaviour lives, so an answer can be checked. */
  evidence: string;
}

/**
 * Words that match everything and therefore mean nothing to a matcher. Kept
 * short on purpose: this is a stop-list for scoring, not a language model.
 */
const NOISE = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "am", "do", "does",
  "did", "my", "me", "i", "you", "your", "it", "its", "this", "that", "these",
  "those", "what", "why", "how", "when", "where", "who", "which", "and", "or",
  "but", "if", "of", "to", "in", "on", "at", "for", "with", "about", "from",
  "can", "could", "would", "should", "will", "not", "no", "yes", "so", "just",
  "get", "got", "have", "has", "had", "there", "here", "any", "some", "mean",
  "means", "meaning", "explain", "tell", "know", "see", "show", "help", "please",
]);

/**
 * Apostrophes out, both sides.
 *
 * A tester typed "it didnt arrive" while the alias read "didn't arrive", so the
 * one entry that answers exactly that question did not match. People also type
 * whatever curly quote their phone inserts. Neither is a different question.
 */
const flatten = (s: string) => s.toLowerCase().replace(/['’ʼ]/g, "");

/** Lowercase word list, punctuation dropped, noise removed. */
function words(text: string): string[] {
  return (flatten(text).match(/[a-z0-9$]+/g) ?? []).filter((w) => w.length > 1 && !NOISE.has(w));
}

/**
 * How well does one concept answer this question?
 *
 * A MULTI-WORD ALIAS BEATS A SINGLE WORD, because "session key" appearing
 * intact is far stronger evidence than "key" appearing anywhere. Scoring by
 * phrase length is what stops "key" dragging in every custody entry the moment
 * somebody types the word.
 */
function score(concept: Concept, question: string, tokens: readonly string[]): number {
  const haystack = flatten(question);
  let total = 0;
  const candidates = [flatten(concept.term), ...concept.aliases.map(flatten)];
  for (const candidate of candidates) {
    if (candidate.includes(" ")) {
      // Phrases are matched against the raw question, so word order counts.
      if (haystack.includes(candidate)) total += 3 + candidate.split(" ").length;
    } else if (tokens.includes(candidate)) {
      total += 2;
    }
  }
  return total;
}

/**
 * The concepts worth putting in front of the model for this question.
 *
 * BOUNDED, because prompt size is the real cost driver and because ten entries
 * about adjacent things is how an answer becomes a lecture. Ties break on the
 * order entries are written in, so the list's own ordering is the editorial
 * decision about what matters most.
 */
export function conceptsFor(
  question: string,
  concepts: readonly Concept[] = CONCEPTS,
  limit = 4,
): Concept[] {
  const tokens = words(question);
  if (tokens.length === 0) return [];
  return concepts
    .map((concept, index) => ({ concept, index, points: score(concept, question, tokens) }))
    .filter((row) => row.points > 0)
    .sort((a, b) => b.points - a.points || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.concept);
}

/**
 * Render concepts for a prompt.
 *
 * `confusable` is included because it is often the ENTIRE answer: somebody
 * asking "why didn't my USDG arrive" is not missing a definition, they are
 * holding a wrong one.
 */
export function renderConcepts(concepts: readonly Concept[]): string {
  if (concepts.length === 0) return "";
  return concepts
    .map((c) => {
      const lines = [`${c.term}: ${c.plain}`, `  why: ${c.because}`];
      if (c.confusable) lines.push(`  often confused with: ${c.confusable}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * THE ENTRIES. Ordered by how often somebody new actually asks.
 *
 * Every one is cited. An entry whose citation stops being true is a lie the
 * chat will repeat confidently, so `explain.test.ts` walks these and fails if a
 * cited file no longer exists.
 */
export const CONCEPTS: readonly Concept[] = [
  {
    term: "Quiet.",
    aliases: ["quiet", "feed is empty", "nothing in my feed", "no activity", "empty feed"],
    plain: "\"Quiet.\" means the feed asked the server what has been happening and the server answered — the answer was just \"nothing recently\". It is a real reply, not a broken page, and it says nothing about your balance. If the request had actually failed you would see \"Couldn't read the ledger just now.\" instead, so seeing \"Quiet.\" is proof the read worked.",
    because: "renders <ReadEmpty title=\"Quiet.\"> only when the read succeeded, and ReadEmpty shows that title exclusively in the `ok` branch — `unread` renders \"Loading…\" and `unreadable` renders the confession instead.",
    confusable: "People read it as \"the app is dead\".",
    evidence: "web/src/terminal/screens/Feed.tsx:194",
  },
  {
    term: "would buy / would sell",
    aliases: ["would buy", "would sell", "a stated intention", "not traded", "shadow", "why does it say would buy"],
    plain: "Your agent posted what it would have done — not something it did. \"Would buy TSLA 5.00 USDG\" is an opinion it published, nothing more. No order was placed, no money left your account, and there is nothing waiting to go through.",
    because: "badgeOf returns the label \"would buy\"/\"would sell\" for any shadow thesis, headOf bakes the same conditional into the head string so non-React surfaces carry it too, and the outcome strip reads \"a stated intention — not traded\".",
    confusable: "Not \"buying\" and not a pending order. \"buying\"/\"selling\" (present tense) means a real trade was submitted and has not landed; \"would buy\" means no trade exists.",
    evidence: "web/src/lib/thesis-badge.ts:34-38",
  },
  {
    term: "has $X to trade with, but no ETH to pay the fees",
    aliases: ["no eth", "it says it cant trade but there is money in it", "no eth for fees", "gas"],
    plain: "Your money is there — the screen can see it, and it says the amount out loud. On this chain two different things are needed in the same account: USDG, which is what your agent trades with, and a small amount of ETH, which is what the network charges to process each trade. You have the first and not the second.",
    because: "statusLine's no-gas branch splits on cashUsdg > 0 specifically so the sentence leads with the money already sent, and network() names the chain in every sentence that asks for funds.",
    confusable: "This is not \"your deposit is missing\".",
    evidence: "web/src/lib/status-line.ts:205-223",
  },
  {
    term: "its trading fees are covered / covered — only needed to withdraw later",
    aliases: ["fees are covered", "gas sponsored", "sponsored", "do i need eth"],
    plain: "When your agent's gas is sponsored, merrymen pays the small network charge on every trade for you. So you only put in USDG — the dollars it trades with — and it can start; it does not need any ETH sitting there to buy and sell. (lets an account with zero ETH start as long as it is sponsored and holds USDG; is the sentence you see.) The one thing that is NOT covered is taking money back out.",
    because: "statusLine's gasSponsored branch returns these sentences and both arms carry the withdrawal caveat; canStart encodes the same rule (gas OR sponsored+capital) and its header says explicitly that sponsorship does not decide anything about withdrawal.",
    confusable: "\"Covered\" never means \"you never need ETH\".",
    evidence: "web/src/lib/status-line.ts:185-204",
  },
  {
    term: "Sign in with your wallet first — a hosted agent is bound to the wallet you sign in with.",
    aliases: ["401", "sign in first", "not signed in", "cant arm"],
    plain: "You weren't signed in on this browser (or your sign-in had lapsed), so the server turned the wallet away. Nothing is lost: the wallet and its permissions were already saved in this browser before the server was asked. Sign in again, then press Re-arm on the wallet screen.",
    because: "refusalMessage maps HTTP 401 to this sentence; the route returns 401 with body \"not signed in\" when there is no tenant on the request.",
    confusable: "It is about the SERVER session, not your wallet's balance or your recovery key.",
    evidence: "web/src/lib/session.ts:678-679",
  },
  {
    term: "this agent account is already linked to a different login",
    aliases: ["409", "already linked", "different login", "account taken"],
    plain: "This agent account is already registered to a different sign-in, so we stopped before saving anything. An account can only belong to one login: everything the agent does — its trades, balances and positions — is filed under that account address, so letting two logins share it would mix two people's records into one. Nothing was taken and no money moved.",
    because: "The grants route asks the store for tenantForAccount before writing and returns 409 with this message when a different tenant already holds the account; if the store itself cannot be read it returns 503 \"couldn't check this account's ownership — please try again\" rather than risk a collision.",
    confusable: "A 503 from that same check reads similarly but means we could not look, not that someone else owns it.",
    evidence: "web/src/app/api/grants/route.ts:203-215",
  },
  {
    term: "Couldn't verify the account on-chain just now — try again in a moment.",
    aliases: ["503", "couldnt verify", "try again in a moment", "account derivation"],
    plain: "Before arming your agent, we re-check that the account address in your grant really belongs to your owner key. That check can fail to run — the chain lookup doesn't answer, or our own record lookup doesn't. When it can't run, we stop rather than guess.",
    because: "refusalMessage maps 503 to this; the route returns 503 (not 403) whenever derivation fails — including derivationUnreachable and the zero-address case — deliberately, so an honest grant is retried rather than told its account is a forgery.",
    confusable: "A 403 from the same area (\"this smart account does not derive from the signed-in wallet\") is a real mismatch; 503 explicitly means the check could not be run.",
    evidence: "web/src/lib/session.ts:699-700",
  },
  {
    term: "couldn't read your owner key — don't fund this account, and tell us",
    aliases: ["couldnt read your owner key", "dont fund this account", "owner key missing"],
    plain: "This one is a real alarm, and it should be rare. When you tap \"reveal\" on the backup screen, we expect to show you the secret key that controls this account — and there was nothing there to show. Don't send any money to that address until we've looked at it, and tell us.",
    because: "The key row falls back to this string only when demoOwnerPrivateKey is missing on a grant that is not Privy-owned; the isPrivyOwned check is placed ahead of it exactly so a Privy account is never told to stop funding.",
    confusable: "An earlier version of this fallback said \"(external wallet — no key stored)\", which was untrue.",
    evidence: "web/src/terminal/screens/Wallet.tsx:1174-1179",
  },
  {
    term: "•••• •••• •••• •••• •••• •••• (recovery key shown as dots)",
    aliases: ["recovery key is only dots", "bunch of dots", "key is hidden", "cant see my recovery key", "reveal key"],
    plain: "The dots are just a cover over your key, like a password field. Nothing has gone wrong and nothing is missing. Tap the eye icon (during setup) or the \"reveal\" button (on the wallet screen) next to the dots and your real key appears; tap it again to hide it.",
    because: "CreateAgent renders the literal dot string when `reveal` is false and swaps in grant.demoOwnerPrivateKey when it is true; the wallet page renders \"•\".repeat(40) under the same toggle, whose button reads \"reveal\"/\"hide\".",
    confusable: "If instead of dots you see the words \"Held by your Privy login\", there is no key to reveal at all — your X login holds it and merrymen never sees it.",
    evidence: "web/src/terminal/screens/CreateAgent.tsx:106",
  },
  {
    term: "this wallet isn’t active",
    aliases: ["wallet isnt active", "desync", "re-arm this wallet", "worker no longer holds its grant", "dashboard shows no merryman"],
    plain: "Nothing has happened to your money. This browser still holds the wallet and its key, and the account still exists with whatever is in it — the panel shows you the address and its current balance, read straight from the chain, plus a button to reveal your recovery key if this browser saved one. What's missing is on our side: the server has lost the permission slip that lets your agent trade, so the agent won't run and won't show on the dashboard.",
    because: "The desync panel renders whenever a local grant exists and serverArmed is false — which happens after a kill switch, a `merrymen kill`, or a server refusal — and it deliberately renders the error line and the account's live balance inside itself, because the shared error line lives in the create panel and could never show once a grant existed.",
    confusable: "\"Isn't active\" sounds like the account was deleted.",
    evidence: "web/src/terminal/screens/Wallet.tsx:730,788-824",
  },
  {
    term: "wallets you used before",
    aliases: ["previous wallet", "old wallet", "my balance looks wrong", "where did my money go", "i funded a wallet and it disappeared"],
    plain: "Look here first if you sent money to an address and your balance now looks wrong. Every agent you create gets its own wallet with its own address — making a new agent does not move anything out of the old one. Whatever you sent is still sitting in the older wallet, and this browser still remembers that wallet.",
    because: "savedWallets is assembled from the current grant plus every localStorage archive written by archivePreviousGrant, and the section renders unconditionally whenever any non-current wallet exists; each row reads its balance straight off the chain rather than trusting the server.",
    confusable: "People assume one login = one address forever.",
    evidence: "web/src/terminal/screens/Wallet.tsx:832-850",
  },
  {
    term: "This is a smart-account address, not a MetaMask wallet.",
    aliases: ["metamask shows empty", "imported my key and its empty", "account address vs owner address", "i sent usdg but its not there", "wrong address"],
    plain: "You have two addresses, and that is on purpose. The one the funding panel shows is your account — that is where the money lives, and that is the one to fund. Your owner key is what controls that account, but the key also has an address of its own, and it is a different address.",
    because: "The funding panel states this outright and the backup panel prints both addresses side by side (\"your account\" vs the owner key's own address), because the funded address is a counterfactual ERC-4337 Kernel account derived from the owner, not the owner itself.",
    confusable: "The account can hold USDG and ETH before it has ever been deployed on-chain, so an explorer may show \"no contract here\" while the balance is real.",
    evidence: "web/src/terminal/screens/Wallet.tsx:1332-1338",
  },
  {
    term: "Token not listed vs Token unavailable",
    aliases: ["token not listed", "token unavailable", "check the address", "cant find this token", "market list came back without this token"],
    plain: "Two messages that look alike but mean opposite things. \"Token not listed\" = we reached our market list fine, and this address wasn't on it. So the address is worth double-checking, or the token just isn't tradable here.",
    because: "computes `unreadable` from loadError plus the market and discoveries read states and picks the heading and body from it, ordered unreadable-before-absent — added after a refused discoveries sweep made the page announce \"check the address\" about coins that exist.",
    confusable: "\"Check the address\" is only ever said when the read succeeded.",
    evidence: "web/src/terminal/App.tsx:337-358",
  },
  {
    term: "Creating your wallet…",
    aliases: ["setting up the wallet that will own your merryman", "stuck on creating your wallet", "provisioning", "embedded wallet"],
    plain: "This screen appears once, straight after you sign in, while the app sets up the wallet that will own your Merryman — the on-screen note says exactly that. A few seconds is normal. You get this new wallet whichever way you signed in: X, email, or by connecting a wallet you already had.",
    because: "useEmbeddedWallet returns getEmbeddedConnectedWallet(wallets), never wallets[0], and the effect sets phase 'provisioning' and returns early while it is null. configures embeddedWallets.ethereum.createOnLogin: 'all-users', so every login route gets one consistent owner signer.",
    confusable: "It is not creating your agent, and it is not your deposit address.",
    evidence: "web/src/terminal/PrivySignIn.tsx:54-58, web/src/terminal/PrivySignIn.tsx:107-110, web/src/terminal/Providers.tsx:55",
  },
  {
    term: "Your wallet is on 0x… but you signed in as 0x…",
    aliases: [
      "wallet is on but you signed in as",
      "signed in as",
      "wallet is on",
      "two different addresses",
      "wallet mismatch",
      "wrong account",
      "switch back to that account",
      "address doesn't match",
      "sign out and in again",
    ],
    plain: "You should not see this any more. It came from the old sign-in, which checked the account your browser wallet extension had selected — and once you sign in with X, the wallet that owns your agent is one Privy made for you, which no extension knows about. So the check compared two addresses that were never meant to be the same. Nothing was broken and no money moved either time. If it does still appear, reload the page first; you are on an old copy of the app.",
    because: "signBinding used to compare the injected wallet's active account against the signed-in tenant before prompting; under a Privy session it now signs with the embedded wallet directly and consults no extension at all.",
    confusable: "It reads like a warning about your funds. It never was one — it fired before anything was signed, and it is about which browser account was selected, not about where money is.",
    evidence: "web/src/lib/session.ts",
  },
  {
    term: "Counterfactual account",
    aliases: [
      "not deployed",
      "undeployed",
      "explorer shows nothing",
      "why does the explorer show nothing",
      "address is empty on the explorer",
      "no contract at my address",
      "no contract at that address",
      "account has never operated",
      "usdg didn't arrive",
      "my usdg didn't arrive",
      "funds didn't arrive",
      "deposit didn't arrive",
      "money hasn't shown up",
      "didn't arrive",
    ],
    plain: "Your agent's address is worked out by maths before anything is written to the blockchain. No code is put on-chain until the agent's first trade, so a block explorer shows the address as bare and empty — that is what it is meant to look like, and it says nothing about your money. Deposits sent to that address are held there regardless.",
    because: "The session module's header states the whole flow is counterfactual with nothing deployed until the first trade; the status route reads the balance with a direct balanceOf multicall against the address, and readFunding does the same for the funding panel.",
    confusable: "'Nothing is deployed' is often read as 'my deposit went nowhere'.",
    evidence: "web/src/lib/session.ts:10-11, web/src/app/api/grants/route.ts:332-342, web/src/lib/session.ts:948-963",
  },
  {
    term: "Owner key",
    aliases: ["recovery key", "private key", "backup key", "seed", "the key i was told to save"],
    plain: "If you created your agent with a recovery key rather than an X login, that key is the one thing that controls your money. Setup shows it on the \"Backup\" screen — labelled Recovery key, hidden behind dots until you tap the eye icon to reveal it, and it is a long string starting 0x, not twelve words. It is made inside your browser and stays there; on merrymen's hosted app it is never uploaded to us, so if you lose it nobody, including merrymen, can get the funds back.",
    because: "createAgentWallet generates the key with generatePrivateKey() in the browser; mintGrant writes the full grant INCLUDING demoOwnerPrivateKey to localStorage but omits that field from the copy sent to a hosted server, and the module header states plainly that localStorage is the shipped arrangement, not a testnet caveat.",
    confusable: "The header explicitly retracts an older claim that production owner keys live in a Turnkey TEE — no such thing is shipped.",
    evidence: "web/src/lib/session.ts:780-793, web/src/lib/session.ts:404-421, web/src/lib/session.ts:30-42",
  },
  {
    term: "Recovery key is only a bunch of dots",
    aliases: ["dots instead of key", "can't see my key", "masked key", "•••• ••••"],
    plain: "Nothing is broken — the key is just hidden. The screen shows a fixed row of dots on purpose, so anyone glancing at your screen (or a screen recording) doesn't capture your key. The dots are a placeholder: their number tells you nothing about the real key.",
    because: "The legacy backup step renders the literal placeholder '•••• •••• •••• •••• •••• ••••' until reveal is toggled by the Eye/EyeOff button; the wallet page uses '•'.repeat(40) with the same reveal toggle, and hides the reveal button entirely for a Privy-owned grant.",
    confusable: "Dots are not a failure to read the key.",
    evidence: "web/src/terminal/screens/CreateAgent.tsx:106, web/src/terminal/screens/Wallet.tsx:1174-1187",
  },
  {
    term: "Held by your Privy login",
    aliases: ["no recovery key", "nothing to write down", "why is there no key for me", "privy owned"],
    plain: "If you signed in through Privy (X or email), there is deliberately no recovery key for you to write down. The key that owns your agent's wallet lives inside that login, and merrymen never receives a copy — so it cannot show you one, and it cannot lose one. That is why the backup step shows \"Held by your Privy login\" instead of a key, and why there is no reveal button.",
    because: "isPrivyOwned reads the durable binding version 'privy-did-owner-v1' sealed into the grant at signing time; createPrivyOwnedWallet omits demoOwnerPrivateKey entirely and its docstring states that recovery for a Privy-owned Merryman is signer-based and NOT yet built.",
    confusable: "A missing key means two opposite things and the code says so at on a legacy grant it means something went wrong (do not fund); on a Privy grant it means everything is working.",
    evidence: "web/src/lib/session.ts:104-123, web/src/lib/session.ts:795-828, web/src/terminal/screens/CreateAgent.tsx:105",
  },
  {
    term: "Per day limit",
    aliases: ["daily usd", "daily cap", "$50 a day", "how much can it spend in a day"],
    plain: "The most your agent is allowed to spend across any rolling 24 hours. This limit works differently from the per-trade one, and the difference matters: merrymen's own software keeps the running total and stops the agent when it reaches your number. The blockchain doesn't count days at all, so it can't back this one up — it holds in normal operation, but if merrymen's software were ever tampered with, nothing on the chain would stop it.",
    because: "states the daily USDG cap is enforced only off-chain in the worker, and that a compromised worker ignores its own counter, leaving the true on-chain ceiling at perTradeUsdg × ops-until-expiry.",
    confusable: "The Limits screen presents per-trade and per-day side by side as if they were the same kind of guarantee.",
    evidence: "packages/core/src/wall.ts:176-183, packages/core/src/wall.ts:720-723",
  },
  {
    term: "Drawdown limit 5%",
    aliases: ["drawdown", "stop loss", "5 percent", "breaker"],
    plain: "A safety stop: if your agent's value falls 5% below its best-ever level, merrymen stops it opening anything new. It can still sell out of what it holds — that's on purpose, so a bad moment doesn't trap you in a losing position. Two things to be clear about.",
    because: "The session module header states the drawdown breaker is worker-enforced until the breaker contract ships (Phase 2); the value is carried in the caps sealed into the grant.",
    confusable: "It appears on the same limits panel as the per-trade cap, which is contract-enforced.",
    evidence: "web/src/lib/session.ts:42-43, web/src/terminal/screens/CreateAgent.tsx:25",
  },
  {
    term: "Trading permission 7 days",
    aliases: ["expiry", "expires", "7 days", "does it expire", "revoke"],
    plain: "Your agent's permission to trade has an end date baked into it — whatever number of days you picked when you signed (the app shows it on the wallet screen). When that date passes, the agent simply stops being able to trade. Nothing happens to your money: the account, and everything in it, stays exactly where it is, and it is still yours.",
    because: "buildWallPolicies computes expiresAt = now + expiryDays*86400 and installs toTimestampPolicy({validAfter: now, validUntil: expiresAt}) — a contract that IS deployed on this chain. restoreAgentWallet re-derives the same smart account from the same owner key and signs a new session key, moving nothing on-chain.",
    confusable: "Expiry stops trading; it does not touch your money.",
    evidence: "packages/core/src/wall.ts:694-698, web/src/lib/session.ts:830-845",
  },
  {
    term: "Add trading funds",
    aliases: ["deposit", "fund my agent", "send usdg", "copy deposit address", "how do i put money in"],
    plain: "Funding your agent means sending USDG to your agent's own account address — the address the funding screen shows with a \"Copy deposit address\" button. It has to come from your own wallet or an exchange; there is no free-money tap on the real chain, and the screen says so. Where to watch for it: the wallet setup page's funding panel re-checks your balance on the chain roughly every 8 seconds on its own, so the two balance tiles — \"native gas\" and \"USDG\" — fill in by themselves once the transfer lands.",
    because: "FundingPanel renders grant.smartAccount as the deposit address with a copy button and says the balance updates after the transfer is recorded; the wallet page's funding panel polls readFunding and shows 'waiting for the first deposit to land… this panel updates automatically' plus '(no faucet on mainnet — send from your own wallet or exchange)'.",
    confusable: "On the TESTNET chain the USDG tile is pinned at '—' forever no matter what you send, because merrymen only knows the mainnet USDG address —.",
    evidence: "web/src/terminal/HostedControls.tsx:66, web/src/terminal/screens/Wallet.tsx:1452-1456, web/src/lib/session.ts:948-963",
  },
  {
    term: "session key",
    aliases: ["agent key", "trading key", "the key the bot uses", "scoped key", "demosessionprivatekey"],
    plain: "A second, throwaway key that the trading worker uses to act on your behalf. It is created in the same step that creates your agent ( and it is intentionally weak. It can only call the handful of contracts and functions on the approved list, it can never move more than your per-trade or daily cap, and it stops working on its own after your chosen number of days.",
    because: "mintGrant generates a fresh session keypair, wraps it in a ZeroDev permission validator built from buildWallPolicies, and serializes it; carriesOwnerKey deliberately does NOT flag demoSessionPrivateKey because the worker needs it and the wall makes a leaked one 'value-churn, never theft'.",
    confusable: "Not the same as your login session cookie.",
    evidence: "web/src/lib/session.ts:275-277 and 319-329 (session keypair + permission validator)",
  },
  {
    term: "the permission wall",
    aliases: ["the wall", "the permissions", "policies", "what the agent can do", "guardrails"],
    plain: "Your agent trades with a temporary key, and that key comes with a list of the only things it is allowed to do. The list is enforced by your own wallet on the blockchain itself, not by our servers — so even if our software were taken over, it could not step outside it. The list pins: which tokens the agent may hand to a trading venue, which venues it may use, how much USDG it may put into any single trade, and a date the key stops working.",
    because: "buildWallPolicies assembles a timestamp policy plus a ZeroDev CallPolicy V0_0_4 whose permissions come from buildCallPermissions, and those travel on-chain in the validator's enable data; the swap recipient and vault receiver are pinned EQUAL to your own smart account.",
    confusable: "Two things it does NOT do.",
    evidence: "packages/core/src/wall.ts:10-28 (one shared definition, 'every entry below is a power granted to an automated agent')",
  },
  {
    term: "kill switch",
    aliases: ["kill", "kill all agents", "stop my agent", "merrymen kill", "revoke"],
    plain: "Kill switch = a stop button for the agent, not a delete button for your money. Pressing it (twice — once to arm, once to confirm) tells the server to throw away the agent's trading permission, and clears that permission from this browser. The trading worker stops at its next check-in.",
    because: "KillSwitch DELETEs /api/grants then calls clearGrant(), and clearGrant archives the current grant under its smart-account key before removing the live slot; the hosted DELETE only removes the stored session-key grant, because the server never held an owner key.",
    confusable: "This used to be a bare localStorage removeItem, which on the hosted service permanently destroyed the only copy of the owner key — pressing KILL meant the funds became unreachable while the UI said only 'grant destroyed'.",
    evidence: "web/src/components/KillSwitch.tsx:19-31 and 41-44 ('grant revoked · worker halts on its next tick · your recovery key is kept')",
  },
  {
    term: "recovery",
    aliases: ["get my money out", "withdraw", "recover funds", "merrymen recover", "recovery panel"],
    plain: "Recovery means moving everything in your agent's account out to any address you control. You sign it with your owner key — the key you were told to back up — so it works even if the agent is killed, even if you're signed out, and even if the agent never traded (the account creates itself on the way out). Your trading limits don't apply: those limits are attached to the agent's day-to-day key, and the owner key is a separate, unrestricted signer.",
    because: "planRecovery/recoverFunds rebuild the Kernel account with the owner key as the sudo signer and send one owner-signed UserOp; the sudo validator has no session-key policies attached, so the whole balance can move in one operation.",
    confusable: "You cannot recover by importing the owner key into MetaMask — that shows a different, empty address.",
    evidence: "worker/src/recover.ts:1-17 (why it exists and why sudo is unbounded)",
  },
  {
    term: "tenant",
    aliases: ["your login", "account owner", "signed-in wallet", "who owns this agent", "my account"],
    plain: "Your tenant is just your login — the wallet address you signed in with. When you sign in, the site gives your wallet a one-time message to sign; the server works out your address from that signature rather than believing anything your browser says it is. It then puts that address in a sealed cookie the site can check on later requests, good for 7 days before you sign in again.",
    because: "verifySignedChallenge recovers the address from the signed challenge, mintSession HMACs it into a stateless cookie, and tenantOf reads it back on every mutating route.",
    confusable: "The tenant address is NOT your agent's address and is NOT your owner key.",
    evidence: "web/src/lib/auth.ts:1-19 (the model: 'the tenant IS a wallet address')",
  },
  {
    term: "privy-owned account",
    aliases: ["signed in with x", "sign in with google", "email login", "privy", "embedded wallet owner", "held by your privy login"],
    plain: "Some agents keep their owner key inside your login (the account you signed in with — the app calls it your X login) instead of inside this browser. merrymen never receives that key, so it cannot store it, leak it, or display it. That is why there is no recovery key to write down here, and why the backup screen says \"held by your Privy login — merrymen never sees it\" instead of showing you a string of characters. Nothing is broken and the account is safe to fund.",
    because: "createPrivyOwnedWallet passes Privy's LocalAccount as the owner signer with binding 'privy-did-owner-v1' and deliberately omits demoOwnerPrivateKey; every screen checks isPrivyOwned(grant) before deciding what an absent key means.",
    confusable: "This is exactly the 'recovery key is only a bunch of dots' and \"couldn't read your owner key - don't fund this account\" reports.",
    evidence: "web/src/lib/session.ts:795-828 ('WHAT IS GONE, DELIBERATELY: demoOwnerPrivateKey … Recovery for a Privy-owned Merryman is signer-based and is NOT yet built')",
  },
  {
    term: "legacy-wallet-owner-v1",
    aliases: ["browser-key agent", "two signatures", "classic owner key", "the old binding"],
    plain: "The older of the two ways an agent can be owned. Your agent has its own private key, held only in your browser — that is the \"recovery key\" you were asked to write down. When you set the agent up, that key and the wallet you log in with each sign the same authorization: one proves who you are, the other proves the agent is yours.",
    because: "verifyGrantBinding's legacy arm requires a walletSignature that recovers to the tenant and an ownerSignature that recovers to the grant's owner, and refuses when both land on the same address (ENFORCE_LEGACY_TWO_PROOF, on since a 22-grant census found zero collisions).",
    confusable: "If you pasted your login wallet's own private key as an owner key during a restore, this agent cannot be re-armed — the claim collapses to one proof.",
    evidence: "packages/core/src/grant.ts:205-240 (the two versions and why they are never merged)",
  },
  {
    term: "\"Your wallet is on 0xA but you signed in as 0xB\"",
    aliases: ["wallet mismatch", "wrong account", "switch back to that account"],
    plain: "Nothing is broken and no money moved. This appears while the app is linking your agent account to your login, and only when you sign in with a browser wallet extension like MetaMask. Your extension currently has a different account selected than the one you signed in with, so the app compares the two and stops right there ( — before asking you to sign anything.",
    because: "signBinding calls requestAccount(provider) and compares the wallet's currently ACTIVE account to the session tenant before prompting for personal_sign, throwing this exact sentence on a mismatch.",
    confusable: "It sounds like your funds are on the wrong wallet.",
    evidence: "web/src/lib/session.ts:541-553 (the check and the message, 'CHECK BEFORE PROMPTING')",
  },
  {
    term: "first-arm identity proof",
    aliases: ["account already linked to a different login", "derivation check", "409", "squatting"],
    plain: "Your agent has its own address, and it is not the wallet you sign in with — two different 0x addresses is the normal, intended state, not a mix-up. When you first arm an agent, the server does not simply believe the agent address your browser sends it. It recalculates that address itself from the agent's owner key and accepts the agent only if the two come out identical, and it refuses an agent account that is already attached to a different login.",
    because: "deriveKernelAccountAddress re-runs the identical Kernel derivation server-side from the owner address alone, and accountsMatch refuses to compare a derivation that failed; a separate tenantForAccount check enforces first-claim-wins.",
    confusable: "A 503 here ('couldn't verify the account on-chain just now') means the chain did not answer, not that your account is a forgery — retry.",
    evidence: "web/src/lib/derive-account.ts:8-27 and 28-68",
  },
  {
    term: "ETH is not in your balance",
    aliases: ["why isn't my eth counted", "my eth is missing", "gas balance", "eth not showing"],
    plain: "Your agent keeps a small amount of ETH on hand purely to pay network fees. That ETH is real money, but it is deliberately not counted in your balance — your balance is only the USDG side: cash, vault, and open positions. Instead of showing the fuel as an asset, the app charges what you actually burn: each completed trade's fee is converted to USDG at the ETH price at the time it was burned, and that amount is subtracted when your profit is worked out.",
    because: "composeEquityUsdg omits ETH on purpose; folding a volatile asset in would ratchet the high-water mark, accrue a performance fee on the gas float, and make an hour of unreadable WETH pricing look like a real drawdown.",
    confusable: "It looks like a bug — the wallet has ETH and the balance ignores it.",
    evidence: "worker/src/equity.ts:36",
  },
  {
    term: "Vault / In vaults",
    aliases: ["in vaults", "savings", "yield", "morpho", "earning"],
    plain: "Money your agent has parked in a savings pool instead of leaving it as spare cash. It is still your money and it is still part of your total — the app adds your cash and your vault balance together, so moving money into or out of the vault never changes what you're worth, only where it sits. Your agent decides when to park and unpark it; you don't have to do anything.",
    because: "vaultUsdg is the account's shares in the Steakhouse USDG Morpho V2 vault converted back to assets via convertToAssets, and the flows table explicitly excludes vault moves as equity-neutral shuffles inside the wall.",
    confusable: "A vault move is not a deposit or a withdrawal.",
    evidence: "worker/src/snapshot.ts:210",
  },
  {
    term: "Unrealised P&L (on a holding)",
    aliases: ["unrealized", "paper gain", "position pnl", "up on a position", "% on a holding"],
    plain: "For one holding: what it is worth now compared with what your agent paid for it, as a percentage. Nothing has been sold, so it is only on paper and it moves as the price moves. If you see a dash instead of a percentage, we have no record of what that holding cost, so the percentage cannot be worked out — a dash means unknown, not 0%.",
    because: "pnlBps is (value − cost) / cost, computed only when a cost_basis row exists and is positive; otherwise it is null and rendered as a dash.",
    confusable: "A blank return is often read as 0%.",
    evidence: "web/src/lib/read-agent.ts:440",
  },
  {
    term: "Realised P&L",
    aliases: ["realized", "booked profit", "profit on closed trades", "locked in"],
    plain: "Money the agent has actually locked in by selling. Buying alone never produces a profit or loss figure — the number only moves on a sale. When it sells, the app takes the share of what those units originally cost (a blended average of every buy of that token, not a specific purchase) and subtracts it from the cash the sale brought in; that difference is the realised figure, and it can be negative.",
    because: "applyFill books realized only on sells and sets basisUnknown when cost is missing, and getRealizedPnlUsdg sums only rows where realized_pnl_usdg IS NOT NULL, per book.",
    confusable: "Realised P&L and the headline return are different numbers.",
    evidence: "worker/src/basis.ts:55",
  },
  {
    term: "Return / performance / P&L",
    aliases: ["pnl", "return", "how am i doing", "performance", "percent up", "am i making money"],
    plain: "Your return is what the account is worth now, minus the money you put in, minus what was spent on network fees. It can show as a dollar figure or a percentage. We only show a return when all of these hold: your deposits are on record and add up to more than zero, at least one trade has actually gone through, we have a current balance reading, and every deposit can be traced to a real on-chain transaction rather than inferred from a balance that changed.",
    because: "pnlUsdg is equity − netContributions − gas, and rankPnl refuses to publish a percentage on any of those four failures rather than dividing pretend by real.",
    confusable: "The refusals exist because production once published +2643.3% by dividing a paper book's flat 1000.0000 opening balance by ~36 USDG of real contributions, from an agent with zero landed trades.",
    evidence: "worker/src/equity.ts:69",
  },
  {
    term: "Net contributions",
    aliases: ["deposits", "what i put in", "funded", "capital in", "money added"],
    plain: "Money you have put into this agent, minus any you have taken back out, counted only for the agent's current run (its \"epoch\" —. It is the baseline your profit or loss is measured against: profit is your balance minus this number. If the agent has no funding or withdrawal recorded for the current run, this shows as unknown rather than 0 — because measuring against 0 would hand your own deposit back to you as if it were profit.",
    because: "getNetContributionsUsdg sums flows in minus flows out scoped to the current epoch, and returns null (not 0) when no flow rows exist.",
    confusable: "It only counts money crossing the account boundary — not trades, and not vault deposits or withdrawals, which are equity-neutral.",
    evidence: "worker/src/store.ts:1372",
  },
  {
    term: "Inferred deposit / unevidenced capital",
    aliases: ["inferred", "unevidenced", "no transaction", "balance change", "phantom deposit"],
    plain: "Every time money enters or leaves your account, we record HOW we know it happened, not just that it did. Best case: we can point at the actual blockchain transaction — either someone sending money in, or a withdrawal we made ourselves. Middle case: when one accounting period closes and the next opens, we carry the closing balance forward as the opening one.",
    because: "flows.source records the evidence class, and rankPnl returns 'contributions-unevidenced' when the worker's contributions_known flag is false.",
    confusable: "An 'inferred' row is a real row in the same table with the same columns as a receipted one — the distinction only survives because it is stamped at write time.",
    evidence: "worker/src/store.ts:100",
  },
  {
    term: "USDG",
    aliases: ["usdg", "stablecoin", "dollars", "cash token", "global dollar"],
    plain: "USDG is the dollar the whole product runs on — Paxos's Global Dollar, a stablecoin worth about $1. Every dollar amount you see is USDG: your cash, your balance, the size of each trade, and the spending limits you set. When you fund the account, USDG is what you send.",
    because: "CASH.USDG is the token address with USDG_DECIMALS = 6 verified on-chain, and usdgUnits scales UI dollars by 10^6 into base units for the on-chain spending caps.",
    confusable: "Stock tokens and WETH are 18 decimals.",
    evidence: "packages/core/src/tokens.ts:142",
  },
  {
    term: "WETH",
    aliases: ["weth", "wrapped eth", "eth pool"],
    plain: "WETH is \"wrapped ETH\" — ETH in a form that can sit in a pool and be traded like any other token. In merrymen it does two jobs. 1) It is how the app works out what ETH is worth. Gas (the network fee for every trade) is paid in ETH, but your book is kept in USDG, and this chain has no official ETH price feed.",
    because: "there is no Chainlink ETH/USD feed on this chain, so the ETH price comes from the WETH/USDG pool TWAP through the guarded pool reader, and StockToken.quote documents the WETH routing default.",
    confusable: "WETH is treated as kind 'memecoin' in the price code.",
    evidence: "worker/src/gas-price.ts:9",
  },
  {
    term: "Today / daily change",
    aliases: ["24h", "today's change", "daily change", "change today", "chg24"],
    plain: "The \"today\" figure is your balance now minus your balance a day ago. Both come from the snapshots we record of your account, not from a fresh look at the chain. If those snapshots don't reach back a full day, you'll see \"Daily change unavailable\" rather than a few hours' change wearing the word \"today\".",
    because: "equityDayAgo returns null unless the series starts at or before the 24h cutoff, and picks the last reading at or before it; chg24 is latest − dayAgo.",
    confusable: "An earlier version compared against the OLDEST point in the series, which is change-since-inception labelled as a daily figure — on a week-old book those differ by an order of magnitude.",
    evidence: "web/src/terminal/live.ts:641",
  },
  {
    term: "Performance fee",
    aliases: ["fee", "commission", "what does it cost", "profit share"],
    plain: "You are only charged on new profit — money made above the highest value your account has ever reached. Nothing is charged on losses, there is no monthly or management fee, and if your account drops and then climbs back to a level it already hit, that recovery is free; you are only charged again once you pass the old peak. Money you deposit yourself is not profit: adding funds raises the peak by the same amount, so funding your account never creates a fee.",
    because: "accrueAboveHwm computes the fee only on the excess over the mark and states collection has not shipped; the settings field says the same to the owner.",
    evidence: "worker/src/fees.ts:1",
  },
  {
    term: "Paper trading / paper fill",
    aliases: ["paper", "simulated", "practice", "fake money", "demo", "not real"],
    plain: "Paper trading means your agent does everything for real except spend money. It reads the same live market prices, asks the same permission it would need to spend real funds, and obeys the same limits you signed — but the buy or sell is only pretended, so nothing leaves your wallet. Paper trades appear in the same activity feed as real ones, tagged \"Paper trade\".",
    because: "fills approved intents at the live Chainlink oracle price minus configured slippage without relaxing the policy wall; the budget rails, cost_basis modes and the profile's filledPaper counter are all partitioned from live.",
    confusable: "On the activity feed a paper fill is grouped with 'landed' — both are outcomes where something filled.",
    evidence: "worker/src/paper.ts:1",
  },
  {
    term: "Epoch / reporting period",
    aliases: ["epoch", "reporting period", "reset", "fresh start", "history excluded"],
    plain: "An accounting period. Some accounts have old records from before the app tracked deposits properly, or trades whose price was written down as an estimate rather than measured. Those records can't be audited, so the app closes that period and opens a fresh one — automatically, the first time the agent is armed, not because of anything you did.",
    because: "openNextEpoch bumps agents.epoch and writes the prior period's closing equity as an 'epoch-carry' opening flow in the new one; performance readers carry an epoch predicate.",
    confusable: "Not every figure resets.",
    evidence: "worker/src/store.ts:1176",
  },
  {
    term: "Carried at cost / quarantined",
    aliases: ["quarantined", "at cost", "unpriceable", "can't be priced", "no price"],
    plain: "Sometimes your agent holds a token nobody can put a trustworthy price on — usually because the token is brand new, or so little of it trades that one person with some money could push the price wherever they liked. Rather than hide the holding or invent a value, we show what you paid for it and label it \"at cost\". That figure is not what the token is worth today.",
    because: "carries the position at cost, composeEquityUsdg adds quarantinedCost as its own term, and the limit is stated explicitly — the scout budget, not the breaker, is the risk control for that money.",
    confusable: "It looks like a valuation and is not one.",
    evidence: "worker/src/quarantine.ts:12",
  },
  {
    term: "Trade size vs what actually filled",
    aliases: ["amount", "trade size", "how much did it buy", "fill amount"],
    plain: "The dollar amount shown next to a trade is the size your agent asked for, not necessarily what it got. What actually moved is stored separately, together with how we know it: \"receipt\" means we read it straight off the finished transaction (the fact), \"quote\" means we fell back to the pre-trade estimate because the transaction could not be read, and \"paper\" means practice mode — an exact figure, but no real money moved. If the two numbers differ, the \"receipt\" figure is the one to trust.",
    because: "amount_usdg is the intent's size while fill_cash_usdg is the USDG that actually moved, stored rather than derived so an on-chain check compares exact to exact; basis_source records the evidence class.",
    confusable: "A trade marked 'submitted' has left the building but has not filled — the feed shows it as 'pending', because an earlier version published anything not rejected or reverted as filled.",
    evidence: "worker/src/store.ts:754",
  },
  {
    term: "steady-basket",
    aliases: ["steady basket", "dca", "default strategy", "the boring one"],
    plain: "This is the default setting, and there's no AI in it — it follows fixed rules. On a regular schedule it spends a set amount of your cash (25 USDG by default) buying the stock tokens you picked, split by the percentages you gave them. Cash you aren't using sits in a savings vault instead of doing nothing: anything above a cushion it keeps on hand (50 USDG by default) gets moved there, and it pulls money back out when it needs it to buy.",
    because: "`steadyBasketTick` splits `buyPerTickUsdg` across legs by `weightBps`, skips paused and stale-feed legs, then deposits cash above `idleFloorUsdg` into the vault; the withdraw-only branch fires first when cash cannot cover a buy.",
    confusable: "The vault sweep is sized to what is left of the DAILY budget after this tick's buys, so a small grant can see the sweep arrive in pieces across several ticks rather than all at once.",
    evidence: "worker/src/strategies/steady-basket.ts:33-106, packages/core/src/settings.ts:548-549",
  },
  {
    term: "weekend-gap",
    aliases: ["weekend gap", "gap strategy", "the weekend one"],
    plain: "Most US stocks stop trading at night and on weekends, but the tokenised versions of them keep trading around the clock. This strategy tries to profit from that gap. It decides purely from one signal: whether the official price feed for a stock has gone quiet.",
    because: "`weekendGapTick` keys entirely off `snap.staleFeeds`: stale + not held means ENTER, fresh + held means EXIT of the full `rawBalance`.",
    confusable: "For every other strategy a stale feed means STOP.",
    evidence: "worker/src/strategies/weekend-gap.ts:1-17, worker/src/strategies/weekend-gap.ts:43-73",
  },
  {
    term: "dip-hunter",
    aliases: ["dip hunter", "buy the dip strategy", "dip buyer"],
    plain: "Dip hunter is a strategy for $MERRYMEN holders (Merry Man tier or above). If you pick it without holding, your agent just sits there and posts one note saying so — it never trades. Each time it runs, instead of splitting the round's money across all the stocks you follow, it puts the entire round's amount into the ONE that has fallen furthest below the highest price it has personally seen for that stock.",
    because: "`makeDipHunter` keeps a per-symbol rolling high in a closure across ticks (the only strategy that carries state), skips legs with no fresh price or a paused token, and buys the deepest `dipBps` above `minDipBps`, which the registry sets to 150 bps.",
    confusable: "The \"high\" is only the high it has personally observed since the worker started, not an all-time or 52-week high.",
    evidence: "worker/src/strategies/dip-hunter.ts:1-9, worker/src/strategies/dip-hunter.ts:25-57, worker/src/strategies/registry.ts:252-260",
  },
  {
    term: "llm-strategist",
    aliases: ["ai strategy", "the llm one", "model-driven", "strategist"],
    plain: "A strategy that lets an AI model have an opinion — but only an opinion. It doesn't ask the model on every price tick. It asks at spaced check-ins, 30 minutes apart by default, and in between it does nothing at all.",
    because: "`makeLlmStrategist` gates model calls on `decisionIntervalMs` (llmIntervalMin × 60,000, default 30 min), and `proposals.ts` states a proposal is symbols and sizes only, validated against the strategy's own universe before becoming a TradeIntent.",
    confusable: "The model's words are logged for you but never parsed and never trusted; nothing it writes reaches the wall.",
    evidence: "worker/src/strategist/strategy.ts:1-8, worker/src/strategist/proposals.ts:1-10, worker/src/strategies/registry.ts:186-215, packages/core/src/settings.ts:556-557",
  },
  {
    term: "custom strategy",
    aliases: ["my own strategy", "strategy file", "plugin strategy", "user-written strategy"],
    plain: "You can write your own strategy and save it in your merrymen strategies folder, then pick it in settings by the file's name (letters, numbers, dashes - no folders). Edit the file and merrymen notices the change and uses the new version on its next round, with nothing to restart. If your file has an error, fails to load, or crashes while running, that round simply makes no trades and the reason shows up in your event feed - it never takes the agent down.",
    because: "`makeCustomStrategy` lazily re-imports on mtime change and degrades a load failure or thrown tick to \"no trades this tick\"; the registry refuses the dynamic import in hosted mode because it would execute tenant code in the process holding every tenant's session key, and falls through to steady-basket with a warning.",
    confusable: "A custom strategy returns a bare intent list, so it cannot publish a written reason — its decisions appear with no prose by design.",
    evidence: "worker/src/strategies/custom.ts:1-13, worker/src/strategies/registry.ts:170-185",
  },
  {
    term: "daily cap",
    aliases: ["daily limit", "trades per day", "ops cap", "daily-cap", "max ops per day", "spent today"],
    plain: "Your agent has two limits that reset by themselves. Over any 24-hour stretch it can spend at most a set amount of USDG (50, 500 or 2,000 depending on the preset you picked when you signed) and can make at most a set number of moves (24, 48 or 96). Both are counted and enforced by merrymen's own software, not by anything on the blockchain — the on-chain part only limits the size of a single trade.",
    because: "checkPolicy rejects with `ops-cap` and `daily-cap` against worker-held counters; records that the on-chain rate-limit policy was REMOVED because its contract has zero bytecode on chain 4663, and says outright that maxOpsPerDay is now enforced by the worker only. `refreshBudget` re-reads the settled 24h totals from the ledger every tick.",
    confusable: "This is the one place where merrymen's guarantee is weaker than it sounds: the honest on-chain ceiling is per-trade size × however many operations fit before the key expires, not the daily figure shown in the UI.",
    evidence: "worker/src/policy.ts:443-476, packages/core/src/wall.ts:699-733, worker/src/index.ts:4763-4768",
  },
  {
    term: "drawdown breaker",
    aliases: ["breaker", "circuit breaker", "drawdown-breaker", "it stopped after losses", "max drawdown"],
    plain: "A safety brake on losses. The app tracks the highest total value your account has ever reached. If your value drops by more than your preset's limit below that peak (5% on the smallest preset, 10% on the middle, 15% on the largest —, the agent refuses to spend money on anything new until the value recovers.",
    because: "checkPolicy computes drawdown bps against the high-water mark and rejects with `drawdown-breaker`, but only after an `isExit` test that exempts vault-withdraw, transfer, swaps into cash, equity sells, and curve trades back into the quote side.",
    confusable: "The exit exemption exists because an earlier version blocked everything, locking the account into a losing position where the only escape the code offered was to deposit MORE money (which lifts the mark and shrinks the ratio).",
    evidence: "worker/src/policy.ts:478-536, worker/src/index.ts:5600-5603",
  },
  {
    term: "stale price",
    aliases: ["stale feed", "market closed", "weekend price", "why is my price from friday", "24-5 feed", "pricestale"],
    plain: "The tokens trade around the clock, but the price feed they are valued from follows the real stock market's hours — it stops updating at the close and starts again at the open. Once a price is more than two hours old, we mark it \"stale\". Stale does not mean lost or worth nothing: your holding keeps the last real price, so an AAPL position over a weeknight or weekend is still carried at Friday's close until Monday.",
    because: "`readMarketSafety` marks a symbol stale when `now - updatedAt > 2 * 3600` and still records the price for valuation with a `stale` flag; steady-basket, even-keel and dip-hunter all skip stale legs, while weekend-gap deliberately uses staleness as its entry signal.",
    confusable: "\"Stale\" means the oracle answered with an old number.",
    evidence: "worker/src/snapshot.ts:144-148, worker/src/snapshot.ts:48-49, worker/src/strategies/steady-basket.ts:55",
  },
  {
    term: "market unreadable",
    aliases: ["couldn't read the market", "no trading this tick", "market could not be read"],
    plain: "Your agent wakes up on a fixed cycle (a \"tick\") and, before it does anything else, asks the chain a few questions: what block are we on, are any of these tokens paused, what are the prices. \"Market unreadable\" means those questions came back empty — a rate limit, a timeout, or a provider having a bad minute on our side. It is a statement about our reads failing, not about prices, liquidity, or your balance.",
    because: "`unreadable` is set when the latest block did not answer, or the whole pause multicall failed, or no price feed answered at all; the tick logs which reads failed, writes a warn event saying it is a data gap, and returns — after writing the heartbeat, so the process is not killed for it.",
    confusable: "A handful of individually missing feeds is ordinary and stays a per-symbol fact.",
    evidence: "worker/src/snapshot.ts:158-163, worker/src/index.ts:4721-4744",
  },
  {
    term: "sequencer down",
    aliases: ["sequencer", "chain down", "sequencer down — all trading paused", "sequencerup"],
    plain: "The chain has to keep producing new blocks for anything to trade. If the newest block merrymen can see is more than two minutes old, it assumes the chain has stalled and every strategy stops proposing trades until fresh blocks appear again — nothing is stuck or lost, it just waits. You get one message when it stops and one when it starts again, not a message every minute.",
    because: "`sequencerUp` is a heuristic — `now - block.timestamp < 120` — because the Chainlink sequencer-uptime feed address is not yet confirmed for chain 4663; every strategy's first line is `if (!snap.sequencerUp) return`, and the tick only emits an event when the value CHANGES.",
    confusable: "An unread block is deliberately NOT reported as a down sequencer — that case is routed to \"market unreadable\" instead, so our own rate limit never announces a chain outage to every owner.",
    evidence: "worker/src/snapshot.ts:152-157, worker/src/index.ts:4746-4753, worker/src/strategies/steady-basket.ts:34",
  },
  {
    term: "no-gas",
    aliases: ["no eth", "out of gas", "why was my trade rejected no-gas", "send eth"],
    plain: "The account pays its own network fee in ETH, and ETH is a different thing from the USDG it trades with. If the account holds exactly zero ETH, no trade can go through at all — it would be rejected before it ever reached the blockchain — so merrymen stops it here instead, marks the attempt \"no-gas\", and tells you the account address to send ETH to. Sending more USDG will not fix it; ETH cannot be substituted.",
    because: "The tick refuses with `reject_rule: \"no-gas\"` when `lastGasWei === 0n && !gasSponsored()`, and only ZERO is refused — a low balance is warned about and left for the chain to judge, because a too-clever estimate refusing a trade the chain would have accepted is the worse failure.",
    confusable: "In paper mode the ETH balance is hardcoded to zero for the simulated book; the tick deliberately does NOT copy that fabricated zero into the live gas check, because unknown is not zero.",
    evidence: "worker/src/index.ts:3560-3594",
  },
  {
    term: "price impact",
    aliases: ["impact cap", "impact-cap", "slippage too high", "impact-unknown", "costly exit"],
    plain: "Before buying, the agent asks the same pool twice: once for the full trade, once for a tiny 1% test trade. If the big one gets a worse price per dollar, that gap is \"price impact\" — the cost of being too big for the pool. Buys are skipped if that cost is over 3% (the default), and also skipped if it could not be measured at all, because \"we don't know\" is treated as bad news, not as zero.",
    because: "`judgeImpact` returns `ok: true` with a note for any exit, refuses buys with `impact-cap` above `maxBps` and `impact-unknown` when bps is null; the cap is `maxImpactBps`, defaulting to 300, and a cap of 0 or less turns the guard off with no nagging note.",
    confusable: "Impact is measured by re-pricing the same route at a small probe — it is not the same as the minOut slippage floor, which is derived from the very quote being questioned and therefore cannot detect a bad fill.",
    evidence: "worker/src/impact.ts:132-176, packages/core/src/settings.ts:513, worker/src/index.ts:3758-3770",
  },
  {
    term: "shadow",
    aliases: ["brain", "shadow mode", "brain decision", "a merryman thinks", "shadow brain"],
    plain: "Brain is the part that reasons about your agent. Right now it runs in shadow: it thinks, writes down a decision and the reasoning behind it, and then nothing is bought or sold. A shadow decision never becomes a trade — the trading code and the thinking code are not connected to each other at all, so this cannot be switched on by accident.",
    because: "does not import proposalsToIntents, checkPolicy, simulate or the executor, and nothing it returns is shaped like an intent — execution is disconnected by ABSENCE, so connecting it later is an added import someone must review rather than a flag someone can flip.",
    confusable: "A Brain decision can say \"buy\" and still be a decision nothing acts on.",
    evidence: "worker/src/brain-shadow.ts:1-21, worker/src/brain-client.ts:22-25, worker/src/brain-enabled.ts:1-27, worker/src/brain-trigger.ts:57-80, worker/src/index.ts:5294-5309",
  },
];
