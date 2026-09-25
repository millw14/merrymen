package dev.merrymen.app.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * THE WIRE TYPES.
 *
 * Two rules run through all of them, and both are the server's own:
 *
 *   NULL IS NOT ZERO. Every figure that can be unknown is a nullable box, never
 *   a defaulted 0.0. The API is scrupulous about this — an unread balance comes
 *   back null, an unread tier as why="unreadable" — and a client that defaults
 *   those to zero re-tells the lie the server refused to tell. "$0.00" and "—"
 *   are different sentences, and only one of them sends somebody to buy tokens
 *   they already hold.
 *
 *   UNKNOWN KEYS ARE IGNORED (see the Json config in MerrymenApi). The server
 *   ships independently of this app; a field added there must not crash an
 *   install out here.
 */

@Serializable
data class Version(val version: String? = null, val commit: String? = null)

// ── auth ────────────────────────────────────────────────────────────────────

/**
 * GET /api/auth/session — {hosted, address}. address is null when signed out.
 *
 * `hosted` is null when the route did not say. It used to default to false,
 * which read a missing key as "self-hosted" — a claim about the server that
 * nobody made.
 */
@Serializable
data class SessionView(val hosted: Boolean? = null, val address: String? = null)

// ── the reader's standing in the Circle ─────────────────────────────────────

/** Mirrors TierView in web/src/app/api/tier/route.ts. */
@Serializable
data class TierView(
  /** "ok" | "sign-in" | "unreadable" — never a bare null that reads as zero. */
  val why: String = "ok",
  /** Whole tokens held, or null when we could not read. NEVER 0 for unread. */
  val tokens: Int? = null,
  val tierId: String? = null,
  val tierName: String? = null,
  val bonusStrategies: Boolean = false,
  val needTokens: Int = 100_000,
  val wallet: String? = null,
  val source: String? = null,
)

@Serializable
data class CircleTier(
  val id: String,
  val name: String,
  val emoji: String? = null,
  val minTokens: Int = 0,
  val feeDiscountBps: Int = 0,
  val voteWeight: Int = 0,
  val bonusStrategies: Boolean = false,
  val perks: List<String> = emptyList(),
  val effectiveFeeBps: Int? = null,
  val tokensToGo: Int? = null,
)

@Serializable
data class CircleView(
  /** "ok" | "sign-in" | "no-wallet" | "unreadable". */
  val why: String = "ok",
  val holderAddress: String? = null,
  val source: String? = null,
  val balance: Int? = null,
  val baseFeeBps: Int? = null,
  val effectiveFeeBps: Int? = null,
  val tier: CircleTier? = null,
  val next: CircleTier? = null,
  val tiers: List<CircleTier> = emptyList(),
  val error: String? = null,
)

// ── alpha ───────────────────────────────────────────────────────────────────

@Serializable
data class AlphaNeed(
  val tokens: Int? = null,
  val name: String? = null,
  val emoji: String? = null,
  /** What the entry tier unlocks, verbatim from CIRCLE_TIERS, for the locked gate. */
  val perks: List<String> = emptyList(),
)

/** The tier that opened Alpha for this reader. Sent only when open. */
@Serializable
data class AlphaTier(val id: String? = null, val name: String? = null, val emoji: String? = null)

@Serializable
data class AlphaToken(val symbol: String? = null, val address: String? = null)

/**
 * THE LOCKED AND OPEN PAYLOADS ARE DIFFERENT SHAPES, and `picks` changes TYPE
 * between them: a COUNT when locked, a list of rows when open.
 *
 * That is not sloppiness on the server's part, it is the lock working — the
 * body genuinely does not ship to a reader who has not earned it, so there is
 * nothing to blur. But it means a client that declares `picks: List<...>`
 * throws a SerializationException on the default path, which is every
 * non-holder. Modelled as raw JSON and read through the accessors below.
 */
@Serializable
data class AlphaView(
  val locked: Boolean = true,
  /** "sign-in" | "balance" | "unreachable" — three remedies, one of them ours. */
  val why: String? = null,
  val need: AlphaNeed? = null,
  val token: AlphaToken? = null,
  val tokens: Int? = null,
  val picks: JsonElement? = null,
  val passed: JsonElement? = null,
  /**
   * The DESK COULD NOT BE READ, for a holder who is allowed to see it. Distinct
   * from "considered and passed on everything": an empty picks list with this
   * true is our outage, not a quiet day. Rendering the two the same states a
   * fact about the market out of a failed read.
   */
  val indexUnreachable: Boolean = false,
  /**
   * WHY NO ROW CARRIES A VERDICT, when none does: "no-model" or "model-failed"
   * mean the scout COULD NOT LOOK; null means it looked and passed. The two
   * render as different sentences — the first is our failure, the second is a
   * fact about the market — so this travels separately from an empty list.
   */
  val verdictsWhy: String? = null,
  /**
   * Whether the site research ran at all, said once for the page. Null when the
   * server did not say (locked, or an older server), which is neither answer.
   */
  val researched: Boolean? = null,
  /** The index cut the sweep short: the list is a PREFIX of the market. */
  val truncated: Boolean = false,
  /** A degraded render: short because the read was, not because the market is. */
  val degraded: Boolean = false,
  /**
   * EPOCH SECONDS the index was read — the server's nowSec, passed through from
   * the discoveries read. Not ms: read as ms it dates the page to January 1970.
   * Null when locked or not sent.
   */
  val fetchedAt: Long? = null,
  /** The tier that opened it. Null when locked. */
  val tier: AlphaTier? = null,
) {
  val needTokens: Int? get() = need?.tokens
  val symbol: String? get() = token?.symbol

  /** The rows, when they were sent; empty when locked or absent. */
  val pickRows: List<JsonElement>
    get() = (picks as? kotlinx.serialization.json.JsonArray)?.toList() ?: emptyList()

  /** How many were vetted, whether or not we were allowed to see them. */
  val pickCount: Int
    get() = (picks as? kotlinx.serialization.json.JsonArray)?.size
      ?: (picks as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull()
      ?: 0
}

// ── telegram ────────────────────────────────────────────────────────────────

/** Mirrors TelegramStatus in web/src/app/api/telegram/route.ts. */
@Serializable
data class TelegramStatus(
  val enabled: Boolean = false,
  val hasToken: Boolean = false,
  val connected: Boolean = false,
  val botUsername: String? = null,
  val ownerId: Long? = null,
  val allowlist: List<Long> = emptyList(),
  /** The six-character code you send as "/link CODE". Null = not minted yet. */
  val linkCode: String? = null,
  val control: Boolean = true,
)

@Serializable
data class TelegramTest(val ok: Boolean = false, val username: String? = null, val reason: String? = null)

@Serializable
data class TelegramTestBody(val action: String = "test", val token: String? = null)

// ── the feed and the tape ───────────────────────────────────────────────────

@Serializable
data class Thesis(
  val name: String? = null,
  val slug: String? = null,
  val handle: String? = null,
  val handleVerified: Boolean = false,
  val head: String = "",
  val action: String? = null,
  val symbol: String? = null,
  val sizeUsdg: Double? = null,
  val reason: String? = null,
  val paper: Boolean = false,
  val at: Long? = null,
  val postId: String? = null,
  /** landed | refused | reverted | dropped | pending | view | shadow. */
  val outcome: String? = null,
  val outcomeText: String? = null,
  val shadow: Boolean = false,
  val source: String? = null,
  /**
   * THE COIN'S NAME, for a reader. A Trencher coin's `symbol` is an id minted
   * from its address (T + 11 hex, "T7631DACC21B"), and printing that at a person
   * is what the server added this to stop. Null when there is no better name
   * than the symbol.
   */
  val displayName: String? = null,
  /**
   * The agent's own one-line take, in its voice. Gated server-side so it can
   * never carry a number or an address. Null when it wrote none.
   */
  val post: String? = null,
  /** How many times this was said in its current stretch — the N in "×N". */
  val said: Int? = null,
  /** Epoch seconds of the first copy counted in [said]. */
  val firstAt: Long? = null,
  /** A landed buy's fill price. Null when not a landed buy, or unread. */
  val entryPriceUsd: Double? = null,
  /** A landed sell's realized return as a PERCENT (not bps). Null when unevidenced. */
  val realizedPct: Double? = null,
  /** The same in dollars — PUBLIC BOOKS ONLY. Null on a private book, never 0. */
  val realizedUsd: Double? = null,
  /** The price when a view was posted, for "since posted". Null when unread. */
  val markUsd: Double? = null,
  /** Market cap at posting. Null is unread, never 0. */
  val mcapUsd: Double? = null,
  /** The agent's CURRENT mode is Trencher — not a claim about when this was written. */
  val trencher: Boolean? = null,
  /**
   * Epoch seconds this post began its current unbroken stretch. Null when the
   * copies are not one stretch, and then "×N · since" would hide a change.
   */
  val unchangedSince: Long? = null,
  /** Views only: this agent named more coins than this page carries, so a count is a floor. */
  val moreNames: Boolean? = null,
)

@Serializable
data class ThesesPage(
  val theses: List<Thesis> = emptyList(),
  /** "sqlite" or "none" — and "none" means the ledger could NOT BE READ, not that nobody posted. */
  val source: String? = null,
  /**
   * Every action group in the window was read and none was cut. Only when this
   * is true does an empty trades lane mean "no published trades"; a scan that
   * stopped at its bound says nothing about what lay past it. Null from an
   * older server, which is not a yes.
   */
  val tradesComplete: Boolean? = null,
)

@Serializable
data class Position(
  val symbol: String,
  @SerialName("price_usd") val priceUsd: Double? = null,
  // 0/1 ON THE WIRE, not a bool. Decoding it as Boolean throws and takes the
  // whole feed down, so it is an Int with a helper below.
  @SerialName("price_stale") val priceStaleRaw: Int = 0,
  @SerialName("price_source") val priceSource: String? = null,
  @SerialName("value_usdg") val valueUsdg: Double? = null,
  @SerialName("raw_balance") val rawBalance: String? = null,
  /**
   * What the holding cost, in whole USDG. NULL when the ledger has no basis —
   * never 0, which would make the whole mark read as profit.
   */
  @SerialName("cost_usdg") val costUsdg: Double? = null,
  /**
   * Whether a fill booked from the pre-trade QUOTE may still be in [costUsdg].
   * Only an explicit false vouches for the cost; true and null both mean no %
   * return may be shown against it.
   */
  @SerialName("cost_from_quote") val costFromQuote: Boolean? = null,
  /** This position's own stop, in bps below cost. Null falls back to the owner's setting. */
  @SerialName("stop_floor_bps") val stopFloorBps: Int? = null,
  /** The sentence that stop was graded for, written at entry. */
  @SerialName("stop_floor_why") val stopFloorWhy: String? = null,
) {
  val priceStale: Boolean get() = priceStaleRaw != 0
}

/**
 * ONE OPERATION ON THE OWNER'S OWN TAPE, as /api/feed sends it (up to 30 over
 * seven days, a redeploy's re-recorded copies already collapsed server-side).
 *
 * EVERY FIELD IS NULLABLE, on purpose. The route's own type marks the newer
 * ones optional ("absent on an older ledger"), and the rest are ledger columns
 * a migration has already renamed once. A row that is missing a column must
 * still decode, with that one fact unread, rather than taking the whole feed
 * down with it.
 */
@Serializable
data class TradeRecord(
  val kind: String? = null,
  @SerialName("sell_token") val sellToken: String? = null,
  @SerialName("buy_token") val buyToken: String? = null,
  @SerialName("amount_usdg") val amountUsdg: Double? = null,
  @SerialName("tx_hash") val txHash: String? = null,
  /** landed | reverted | rejected | paper. */
  val status: String? = null,
  @SerialName("reject_rule") val rejectRule: String? = null,
  @SerialName("sim_quote_out") val simQuoteOut: String? = null,
  @SerialName("sim_min_out") val simMinOut: String? = null,
  @SerialName("sim_fee_tier") val simFeeTier: Int? = null,
  @SerialName("sim_gas") val simGas: String? = null,
  @SerialName("created_at") val createdAt: String? = null,
  /** What the ledger knows the fill WAS: buy | sell. */
  @SerialName("fill_side") val fillSide: String? = null,
  /** The fill's symbol, else the decision's. Unsanitised: render it as text, never as markup. */
  val symbol: String? = null,
  /** The coin's name, for a Trencher T-id. */
  @SerialName("display_name") val displayName: String? = null,
  /** The DECISION's side, so a refusal carries one too. */
  val action: String? = null,
  /** The decision's reason. Owner-only; the route sends it only to the owner. */
  val reason: String? = null,
  @SerialName("realized_pnl_usdg") val realizedPnlUsdg: Double? = null,
  /**
   * True only when BOTH the proceeds and the cost were evidenced. Realized
   * dollars print only then; anything else is an estimate wearing a figure.
   */
  @SerialName("realized_vouched") val realizedVouched: Boolean? = null,
)

@Serializable
data class AgentGlance(
  val slug: String? = null,
  val name: String? = null,
  val strategy: String? = null,
  val basket: List<String> = emptyList(),
  // NOT SENT BY /api/feed TODAY. Declared because /api/agents/{slug} does send
  // them and the same type is reused there; on the feed they stay null, which
  // renders as an em dash rather than as a confident zero.
  val handle: String? = null,
  val handleVerified: Boolean = false,
  val owner: String? = null,
  /**
   * settings | ledger | fallback. "fallback" means the name could NOT be read:
   * it is the house default ("Robin"), and a signed-out /api/feed sends exactly
   * that. Never present a fallback identity as the reader's own agent.
   */
  val nameSource: String? = null,
)

/**
 * One mark on the equity curve. THE HEADLINE FIGURE COMES FROM HERE, not from
 * an `equity` field on the agent — /api/feed does not send one, so reading it
 * from there rendered an em dash forever.
 */
@Serializable
data class EquityPoint(
  @SerialName("cash_usdg") val cashUsdg: Double? = null,
  @SerialName("vault_usdg") val vaultUsdg: Double? = null,
  @SerialName("equity_usdg") val equityUsdg: Double? = null,
  val at: String? = null,
)

@Serializable
data class EventRow(
  val level: String? = null,
  val message: String? = null,
  @SerialName("created_at") val createdAt: String? = null,
)

/**
 * /api/feed is the widest shape in the API and the one most likely to grow, so
 * it is modelled loosely on purpose: what this client renders is typed, and the
 * rest travels as raw JSON rather than as a schema that quietly goes stale.
 */
@Serializable
data class Feed(
  /**
   * "sqlite" or "none". "none" is UNREADABLE — a signed-out reader, or a ledger
   * that would not open — and then [agent] is the fallback identity and the
   * empty lists are not facts about anybody's account.
   */
  val source: String? = null,
  val agent: AgentGlance? = null,
  val events: List<EventRow> = emptyList(),
  val trades: List<TradeRecord> = emptyList(),
  val positions: List<Position> = emptyList(),
  val equity: List<EquityPoint> = emptyList(),
  /**
   * Capital put in less capital taken out. P&L is equity minus this minus gas.
   * NULL when nothing is on record, which is NOT zero: equity minus zero is the
   * bankroll presented as profit.
   */
  val netContributionsUsdg: Double? = null,
  /** Gas paid, in USDG — only the part that could be priced; see [gasUnpricedTrades]. */
  val gasUsdg: Double? = null,
  /** Landed trades whose gas could not be priced. Above 0, [gasUsdg] is a floor. */
  val gasUnpricedTrades: Int? = null,
  /** Distinct operations that landed in the current run. 0 means no return to measure. */
  val landed: Int? = null,
  /** The worker's verdict on [netContributionsUsdg]: true, false, or null for never assessed. */
  val contributionsKnown: Boolean? = null,
  /** {hwm_usdg, accrued_fee_usdg} or null. Kept raw until a screen renders it. */
  val financials: JsonElement? = null,
) {
  /** The newest mark, or null when the curve is empty. Null, never 0.0. */
  val equityNow: Double? get() = equity.lastOrNull()?.equityUsdg
}

// ── markets ─────────────────────────────────────────────────────────────────

/**
 * Mirrors MarketToken in web/src/lib/market.ts, served by **`/api/market`**.
 *
 * There is no `/api/tokens` list route — only `/api/tokens/{address}` — so the
 * markets screen was pointed at a 404.
 *
 * THE FIELD NAMES WERE GUESSED AND TWO OF THEM WERE WRONG, which `ignoreUnknownKeys`
 * turned into silence rather than an error. `halted` is called `paused` on the
 * wire, so the halt flag decoded as null on every token and the detail screen
 * said "we could not read whether trading is halted" about a read that had
 * succeeded — our own uncertainty invented on the token's behalf. And `chg24`
 * is not sent at all: /api/market has no 24-hour change, so the arrow beside
 * every price was permanently an em dash. A coin's change comes from the index,
 * on `/api/tokens/{address}`, and it is on `DiscoveryCoin.change24hPct`.
 *
 * `paused` STAYS NULLABLE. The server's own comment: a halt "may only be
 * asserted when the chain actually answered", and a client that defaults it to
 * false republishes "trading normally" for a token nobody could read.
 */
@Serializable
data class Token(
  val symbol: String,
  val name: String? = null,
  val kind: String? = null,
  val address: String? = null,
  val logo: String? = null,
  val priceUsd: Double? = null,
  /** Unix seconds of the last Chainlink update; null when the token has no feed. */
  val priceUpdatedAt: Long? = null,
  val paused: Boolean? = null,
  /** 1.0 = no pending corporate action. Bars must be multiplied by it. */
  val uiMultiplier: Double? = null,
  /** Whether Rialto considers it liquid. Null when Rialto could not be asked. */
  val rialtoLiquid: Boolean? = null,
  val volume24hUsd: Double? = null,
  val holders: Int? = null,
)

@Serializable
data class TokensPage(
  /** EPOCH SECONDS of the read (market.ts: Math.floor(Date.now() / 1000)). */
  val fetchedAt: Long? = null,
  val tokens: List<Token> = emptyList(),
)

/**
 * TWO MORE GUESSED FIELD NAMES, and this pair cost a false statement.
 *
 * The wire sends `landed`, `refused` and `unrankedWhy`; this declared `trades`
 * and `why`, so with `ignoreUnknownKeys` both decoded null on every row, for
 * ever. Verified against the live route: a row is
 * `{slug, unrankedWhy, name, handle, handleVerified, pnlBps, maxDdBps, landed, refused, curve}`.
 *
 * WHY THAT WAS NOT MERELY COSMETIC. A NULL `pnlBps` HERE DOES NOT MEAN
 * "UNREADABLE". `rank-pnl.ts` guarantees exactly one of `pnlBps` and
 * `unrankedWhy` is ever set, so a null return always means unranked FOR A NAMED
 * REASON — and on the live board eight rows carry one right now
 * ("contributions-unevidenced"). With the reason discarded, the phone rendered
 * those as the app's em dash, which Components.kt reserves for "we never got an
 * answer". That is the app stating something the server never said, in the one
 * glyph it keeps for its own ignorance.
 *
 * `landed` IS DELIBERATELY NOT CALLED `trades`. The web never does: a row with
 * 0 landed and 12 paper fills reads "12 on paper", not "0 trades".
 */
@Serializable
data class LeaderRow(
  val slug: String? = null,
  val name: String? = null,
  val handle: String? = null,
  /** False by default: absent is not proven. */
  val handleVerified: Boolean = false,
  /** Null when unranked; then — and only then — [unrankedWhy] says why. */
  val pnlBps: Int? = null,
  val maxDdBps: Int? = null,
  /** Settled fills. NOT "trades", and never rendered as one when it is 0. */
  val landed: Int? = null,
  val refused: Int? = null,
  /**
   * no-deposit | never-filled | contributions-unevidenced | quality-unknown,
   * and since the board took in every agent, paper | inactive.
   */
  val unrankedWhy: String? = null,
  /** live | paper | idle. Only a live row is ranked on [pnlBps]. */
  val mode: String? = null,
  /** A paper row's own return, in bps. Labelled Paper wherever it is shown, never ranked. */
  val paperPnlBps: Int? = null,
  /** Paper fills, the paper counterpart of [landed]. */
  val filledPaper: Int? = null,
)

@Serializable
data class Leaderboard(
  val agents: List<LeaderRow> = emptyList(),
  /**
   * "sqlite" or "none", and "none" means THE LEDGER COULD NOT BE READ — not
   * that nobody has traded. The route answers `{source, agents}`; this type
   * declared `why`, which does not exist on the wire, so the screen's
   * "couldn't rank" branch was dead and an unreadable board rendered as an
   * empty one. Same class of bug as [LeaderRow]'s, one level up.
   */
  val source: String? = null,
  /** How many retired, quiet or expired accounts were folded out. Null when not counted. */
  val retired: Int? = null,
)

/**
 * `/api/search` answers with ONE list of hits, not two typed lists.
 *
 * `kind` is "token" or "agent" and `href` is the web path (`/t/<addr>` or
 * `/a/<slug>`), which the client turns into its own route. Decoding the wrong
 * shape did not throw — `ignoreUnknownKeys` swallowed it — so search returned
 * an empty list for every query and looked like "no results".
 */
@Serializable
data class SearchHit(
  val kind: String? = null,
  val href: String? = null,
  val title: String? = null,
  val sub: String? = null,
)

@Serializable
data class SearchResults(val hits: List<SearchHit> = emptyList())

// ── settings ────────────────────────────────────────────────────────────────

/** A secret the server will never send back — only whether it is set. */
@Serializable
data class SecretView(val set: Boolean = false, val hint: String? = null)

@Serializable
data class Strategies(val builtin: List<String> = emptyList(), val custom: List<String> = emptyList())

/**
 * GET /api/settings.
 *
 * `values` and `defaults` stay RAW JSON on purpose. The server owns ~60 fields
 * and its validation is the authority; mirroring them as a data class here
 * would be a second, weaker copy that goes stale the moment a field is added.
 * The editor reads what it renders out of the object and writes back only what
 * the owner touched.
 *
 * WRITING IS A PATCH, NOT A REPLACE — and this is the correction to an earlier
 * note in this app's README. The PUT handler reads each field with
 * `if ("name" in body)`, so fields you omit are LEFT ALONE rather than unset.
 * Sending a subset is therefore both safe and correct; what would be wrong is
 * echoing back a field you never read, particularly a masked secret.
 */
@Serializable
data class SettingsEnvelope(
  val values: JsonElement? = null,
  val defaults: JsonElement? = null,
  val knownSymbols: List<String> = emptyList(),
  val strategies: Strategies = Strategies(),
  val errors: List<String> = emptyList(),
  val bundlerApiKey: SecretView = SecretView(),
  val llmApiKey: SecretView = SecretView(),
  val telegramBotToken: SecretView = SecretView(),
  /**
   * THE WALLET THESE VALUES WERE READ FOR. Hosted: the tenant, or "" when read
   * signed out; null self-hosted. A form sends it back on save
   * ([MerrymenApi.patchSettings]'s `owner`), so a save made after another wallet
   * signed in is refused (409) instead of landing on the wrong agent.
   */
  val owner: String? = null,
  /**
   * The verified platform-listed coins. An EMPTY list is a fact ("none listed");
   * null means the server did not send it. Separate from the
   * officialCoinsEnabled setting, which is in [values].
   */
  val officialCoins: List<String>? = null,
) {
  private val v get() = values as? kotlinx.serialization.json.JsonObject
  private val d get() = defaults as? kotlinx.serialization.json.JsonObject

  /**
   * A setting AS IT STANDS — the owner's value, else the default.
   *
   * Absent in `values` does not mean empty, it means "never edited, so the
   * default applies". Reading it as empty is the bug that let approving one
   * memecoin replace a whole default basket.
   */
  fun raw(key: String): JsonElement? = v?.get(key) ?: d?.get(key)

  fun str(key: String): String? =
    (raw(key) as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content

  fun num(key: String): Double? =
    (raw(key) as? kotlinx.serialization.json.JsonPrimitive)?.content?.toDoubleOrNull()

  fun bool(key: String): Boolean? =
    (raw(key) as? kotlinx.serialization.json.JsonPrimitive)?.content?.toBooleanStrictOrNull()

  fun list(key: String): List<String> =
    (raw(key) as? kotlinx.serialization.json.JsonArray)
      ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
      ?: emptyList()
}

/**
 * WHAT A SUCCESSFUL PUT /api/settings SAYS — not the envelope a GET returns.
 *
 * `{ok, appliesWithin, ignored?}`. This used to decode as a [SettingsEnvelope],
 * which worked only because `errors` defaulted to empty — and threw away
 * `ignored`, so a key the server dropped still read "Saved." A refusal (400,
 * 409 OWNER_CHANGED_SETTING) arrives as ApiResult.Refused with the joined
 * `errors`; [errors] here stays for a 200 that carries them.
 */
@Serializable
data class SettingsSaved(
  val ok: Boolean? = null,
  /** e.g. "one worker tick" — when the change takes effect. */
  val appliesWithin: String? = null,
  /** Keys the server did NOT save because it does not know them. Non-empty is not "Saved". */
  val ignored: List<String> = emptyList(),
  val errors: List<String> = emptyList(),
)

// ── chat, orders, proposals ─────────────────────────────────────────────────

@Serializable
data class ChatBody(
  val message: String,
  val state: String? = null,
  val history: List<ChatTurnWire> = emptyList(),
)

@Serializable
data class ChatTurnWire(val role: String, val content: String)

/**
 * A command the agent has PROPOSED. The server has already parsed and scrubbed
 * the marker; nothing here parses model output.
 */
@Serializable
data class ChatCommand(
  val id: String = "",
  /** Flat scalars only — the route drops anything nested before we see it. */
  val args: Map<String, JsonElement> = emptyMap(),
) {
  /** Arguments as text, which is all a card needs to show and a payload to send. */
  fun argText(): Map<String, String> =
    args.mapNotNull { (k, v) ->
      (v as? kotlinx.serialization.json.JsonPrimitive)?.let { k to it.content }
    }.toMap()
}

@Serializable
data class ChatReply(
  val reply: String? = null,
  /** no-llm | llm-error | cut-off | bad body | empty | not signed in. */
  val why: String? = null,
  /**
   * The provider's own line, REDACTED and for debugging only. The server marks
   * it "never rendered" and the web never shows it; speak [kind] instead.
   */
  val detail: String? = null,
  val command: ChatCommand? = null,
  /**
   * The server's classification of a model failure: key-rejected |
   * rate-limited | provider-down | unreachable | model-missing | other. It is
   * what the owner is told, in the agent's voice ("your Groq key was
   * rejected"), instead of a provider's raw text.
   */
  val kind: String? = null,
  /** Whose model failed, e.g. "Groq", for that sentence. */
  val provider: String? = null,
)

/**
 * `owner` is the wallet that tapped Confirm. Hosted, a body whose owner is not
 * the session's tenant is refused 409 OWNER_CHANGED before anything is placed;
 * null omits the key (explicitNulls = false) and the server judges by session
 * alone, as it always did.
 */
@Serializable
data class OrderBody(val side: String, val symbol: String, val usdgAmount: Double, val owner: String? = null)

@Serializable
data class OrderResult(
  val id: String? = null,
  val queued: Boolean = false,
  /** The same order placed twice is one order — the id is the idempotency key. */
  val duplicate: Boolean = false,
  val error: String? = null,
  /** Server epoch ms. NEVER compared with this device's clock; see [expiresInMs]. */
  val expiresAt: Long? = null,
  /**
   * The order's own window, as a DURATION from this response. A follower counts
   * it on the device clock from when the reply arrived, so a skewed phone clock
   * cannot end a follow early or late.
   */
  val expiresInMs: Long? = null,
)

/**
 * GET /api/orders?id= — what became of it.
 *
 * `state` is none | queued | running | done | expired. "expired" is the only
 * one that means NOTHING WAS SENT; "none" means no record exists. A ledger that
 * could not be read answers 503, not "none".
 */
@Serializable
data class OrderState(
  val id: String? = null,
  val state: String = "none",
  /** The worker's own sentence about the outcome. */
  val result: String? = null,
  /** Server epoch ms the order was placed. */
  val at: Long? = null,
  /** Server epoch ms. For display only, never compared with the device clock. */
  val expiresAt: Long? = null,
  /** What the worker read off the ledger when it finished. Absent from an older worker. */
  val receipt: OrderReceipt? = null,
)

/**
 * WHAT AN ORDER BECAME, AS THE WORKER READ IT OFF THE LEDGER — never model text.
 *
 * The one place a receipt line's words may come from ("[Buy] $5.00 CASHCAT ·
 * Filled"). The server shape-checks every field and sends null for one that
 * failed, so null here is "unread", never zero: a null [usdgActual] prints no
 * figure at all.
 */
@Serializable
data class OrderReceipt(
  /** filled | refused | failed | expired. */
  val status: String? = null,
  /** buy | sell. */
  val side: String? = null,
  val symbol: String? = null,
  val token: String? = null,
  val usdgActual: Double? = null,
  val txHash: String? = null,
  /** The wall rule that refused it, as a slug. */
  val rejectRule: String? = null,
)

@Serializable
data class SnipeTarget(val symbol: String, val address: String, val short: String? = null, val covered: Boolean = false)

/**
 * FOUR OUTCOMES, AND ONLY THE FIRST PLACES ANYTHING.
 *
 * resolved -> the caller then POSTs /api/orders for target.symbol.
 * ambiguous -> ask, never guess: more than one coin answers to that name.
 * needs-signature -> the key does not cover it yet.
 * anything else -> nothing was found.
 */
@Serializable
data class SnipeResult(
  val outcome: String = "",
  val target: SnipeTarget? = null,
  val usdgAmount: Double? = null,
  val matchedOn: String? = null,
  val candidates: List<SnipeTarget> = emptyList(),
  val total: Int = 0,
  val query: String? = null,
  val say: String? = null,
  val error: String? = null,
)

/** `owner` as on [OrderBody]: a mismatch with the session is a 409, and null omits it. */
@Serializable
data class SnipeBody(val query: String, val usdgAmount: Double, val owner: String? = null)

@Serializable
data class Proposal(
  val token: String,
  /** From the CONTRACT, sanitised. Never the index's label. */
  val symbol: String,
  val decimals: Int = 18,
  /** The index's label. Attacker-chosen — context only, never identity. */
  val indexLabel: String? = null,
  /** An ordering, never a size and never a permission. */
  val conviction: Int = 0,
  val reason: String? = null,
  /** Still on its launch curve: no pool, so a swap cannot route to it. */
  val onCurve: Boolean = false,
  val priceUsd: Double? = null,
  val fdvUsd: Double? = null,
  val volume24hUsd: Double? = null,
  val buyers24h: Int? = null,
  /** Watched and priced already, but not covered by the signature. */
  val watched: Boolean = false,
)

@Serializable
data class ProposalsView(
  val proposals: List<Proposal> = emptyList(),
  /**
   * ok | signed-out | no-grant | nothing-vetted | all-covered | unreadable.
   * "The scout picked nothing" and "you have no agent" are different facts
   * with different remedies, and an empty list renders identically for both.
   */
  val why: String = "ok",
  /**
   * How many tokens the current signature already covers.
   *
   * Shown because approving ANY coin re-seals the permission around the WHOLE
   * list — there is no per-token opt-in at signing — so the owner is entitled
   * to know what a re-sign actually re-authorises.
   */
  val covered: Int = 0,
)

/** A token the owner has added. The shape /api/settings stores and validates. */
@Serializable
data class CustomToken(val symbol: String, val address: String, val decimals: Int = 18)

// ── grants ──────────────────────────────────────────────────────────────────

/**
 * GET /api/grants — the account's status as the WORKER reports it.
 *
 * `mode`, `liveBlocker`, `workerAliveAt` and `gasSponsored` are the child's
 * own verdicts, never recomputed here: a second guess from another process
 * would eventually disagree with the one that actually refuses trades.
 */
@Serializable
data class GrantView(
  val exists: Boolean = false,
  val gasSponsored: Boolean? = null,
  /** The stored grant minus its secrets. Raw: read `caps` through [perTradeUsdg] and [dailyUsdg]. */
  val grant: JsonElement? = null,
  /** paper | live | idle, from the heartbeat. Null when the agent has not said. */
  val mode: String? = null,
  /**
   * What stops it trading for real: no-gas | no-cash | dead-policy |
   * wrong-chain | not-armed | no-executor. NULL IS TWO ANSWERS (never beaten,
   * or trading for real) and neither is a blocker; [mode] and [workerAliveAt]
   * tell them apart.
   */
  val liveBlocker: String? = null,
  /**
   * When the worker was last heard from, in EPOCH SECONDS: the heartbeat's
   * `at` or the ledger's beat_at, both written as Math.floor(nowMs / 1000).
   * Null when never.
   */
  val workerAliveAt: Long? = null,
  val balances: GrantBalances? = null,
)

/**
 * Decimal strings as read from the chain, per field. NULL MEANS THE READ
 * FAILED and "0" is a measured zero — they used to collapse to 0, which told a
 * funded owner on a slow node to "Add funds".
 */
@Serializable
data class GrantBalances(
  val ethWei: String? = null,
  val cashUsdg: String? = null,
  val vaultUsdg: String? = null,
)

/**
 * The signed per-trade cap, when the grant carries it AS A NUMBER.
 *
 * Numbers only: the caps are inside the signed payload, and a string or a
 * missing key is a cap nobody can vouch for — so it reads as null (unread),
 * never as a guess and never as 0.
 */
val GrantView.perTradeUsdg: Double? get() = capNumber("perTradeUsdg")

/** The signed daily cap, numbers only, as [perTradeUsdg]. */
val GrantView.dailyUsdg: Double? get() = capNumber("dailyUsdg")

private fun GrantView.capNumber(key: String): Double? {
  val caps = (grant as? kotlinx.serialization.json.JsonObject)?.get("caps") as? kotlinx.serialization.json.JsonObject
  val p = caps?.get(key) as? kotlinx.serialization.json.JsonPrimitive ?: return null
  if (p.isString) return null
  return p.content.toDoubleOrNull()?.takeIf { it.isFinite() }
}

/** A single-field error body, which several routes use verbatim. */
@Serializable
data class ApiError(
  val error: String? = null,
  val detail: String? = null,
  /**
   * The VALIDATION shape. /api/settings and the read-modify-write it backs
   * (proposals, risk) refuse with `{"errors":["slippageBps: must be a number
   * between 1 and 1000", …]}` — a list, not a single `error`. Without this the
   * client fell through to dumping the raw JSON body into the note, so a careful
   * per-field message arrived as `{"errors":[…]}`.
   */
  val errors: List<String>? = null,
  /** /api/chat's refusal carries its reason here (`{"reply":null,"why":"not signed in"}`). */
  val why: String? = null,
  /**
   * A 5xx body WRITTEN FOR THE OWNER ("couldn't check this account's
   * ownership"). Only then is a 5xx's own text shown; any other 5xx body is a
   * stack's words, not ours, and reads as the generic line.
   */
  val ownerFacing: Boolean? = null,
)

// ── likes and follows ───────────────────────────────────────────────────────

/**
 * WHAT THIS READER HAS LIKED — and, separately, whether we could find out.
 *
 * Four fields, three of which exist because collapsing them told somebody
 * something false about themselves. `signedIn` is not implied by a 200: the
 * route answers 200 with an empty list for a signed-OUT visitor on purpose, so
 * inferring it from the status enables a button that 401s on the tap. `read` is
 * not implied by `signedIn`: when the store will not open the route still
 * answers 200, with `signedIn` intact and `read` false, and a client that
 * treated that as signed-out would tell a reader who signed in five minutes ago
 * to go and sign in.
 *
 * `read` DEFAULTS TO TRUE. The absent case is an older server that never sends
 * the flag, and its answer was read; only an explicit `false` means it was not.
 */
@Serializable
data class LikesView(
  val liked: List<String> = emptyList(),
  val signedIn: Boolean = false,
  val read: Boolean = true,
  val max: Int = 0,
  /** "at-capacity" when the write was refused for a stated reason. */
  val refused: String? = null,
)

/**
 * How many wallets liked each post on the feed.
 *
 * ABSENT IS NOT ZERO UNLESS `read`. The route answers for every post in the
 * current window, zero included, so once `read` is true an absent id means the
 * post is not on the feed. When `read` is false the whole map is empty and a 0
 * rendered from it would be a claim nobody made.
 */
@Serializable
data class LikeCounts(
  val counts: Map<String, Int> = emptyMap(),
  val read: Boolean = false,
)

/** What the owner's agent reads. `max` is the prompt budget, not a suggestion. */
@Serializable
data class FollowView(
  val wired: List<String> = emptyList(),
  val max: Int = 8,
  val refused: String? = null,
)

@Serializable
data class LikeBody(val postId: String, val on: Boolean)

/**
 * `target`, not `slug`, and `on`, not `follow`.
 *
 * Both keys were wrong in this client and both failed QUIETLY in the worst
 * direction: the route reads `input.target`, so every follow answered 400 "that
 * is not an agent id"; and it reads `input.on === false` for an unfollow, so
 * `{"follow": false}` left `on` undefined and UNFOLLOWING WOULD HAVE FOLLOWED.
 */
@Serializable
data class FollowBody(val target: String, val on: Boolean)

// ── one token, in full ──────────────────────────────────────────────────────

/**
 * One bar. `v` IS NOT AN AMOUNT and is never rendered as one.
 *
 * read-candles.ts measured it: on an on-curve pons-v2 pool the minute candles
 * inside one hour summed to 1.6x the hour bar containing them, and both
 * exceeded that pool's own 24h volume by three to five times. Kept for shape.
 *
 * EVERY FIELD IS NULLABLE, and an incomplete bar is dropped where the bars are
 * drawn. These were required non-null Doubles, so one null in one bar failed
 * the decode of the whole token document — its holders and its market read
 * included — over a single price nobody could draw anyway. Defaulting them to
 * 0.0 instead would draw a bar to zero, a price that never existed.
 */
@Serializable
data class Candle(
  val t: Long? = null,
  val o: Double? = null,
  val h: Double? = null,
  val l: Double? = null,
  val c: Double? = null,
  val v: Double? = null,
)

/**
 * FOUR STATES, AND THE LAST ONE IS ABOUT US.
 *
 * ok       — the index answered and the bars are about this token.
 * none     — it answered, and this pool has no bars in that window.
 * mismatch — it has bars, but about the OTHER side of the pair.
 * refused  — it would not answer, or would not say what the bars are about.
 *
 * The middle two are facts about the pool. The last is a fact about our read,
 * and drawing it as either of the others states something about a token out of
 * our own outage. The default is `refused` for exactly that reason: a body we
 * could not decode has told us nothing about the pool.
 */
@Serializable
data class CandleRead(
  val state: String = "refused",
  val candles: List<Candle> = emptyList(),
  val base: String? = null,
  val quoteSymbol: String? = null,
  /** Seconds per bar, so a renderer can find the holes and leave them as holes. */
  val interval: Long = 0,
  val label: String = "",
  /** Bar-slots inside the range with no bar. A caption that omits this describes a different chart. */
  val gaps: Int = 0,
  /** Seconds of the newest bar that have elapsed. It is ALWAYS partial. */
  val lastBarAgeSec: Long? = null,
  /**
   * THESE BARS ARE THE LAST GOOD READ and the index has since refused. The
   * state still says "ok" so the chart can draw — the caption must say they are
   * not live, and the newest bar is not "still forming".
   */
  val stale: Boolean = false,
  /** rate-limited | unreachable | unreadable. Null unless the index refused. */
  val reason: String? = null,
  /** Epoch ms of that refusal. */
  val refusedAt: Long? = null,
)

/**
 * An agent holding this token, as its own book publishes it.
 *
 * `paper` and `basisSource` travel WITH the price because a pretend fill must
 * not look like a real one — the port to the web terminal dropped both and
 * every marker on a public page then read as somebody's money.
 */
@Serializable
data class TokenHolder(
  val slug: String? = null,
  val name: String = "",
  val handle: String? = null,
  val paper: Boolean = false,
  /**
   * NULL WHEN UNREAD, not 0.0. The server omits no holder for want of a value,
   * and a 0.0 default either decoded an unread value as a real zero or — with
   * an explicit null on the wire — failed the whole token document.
   */
  val valueUsdg: Double? = null,
  val costUsdg: Double? = null,
  val pnlBps: Int? = null,
  val enteredAt: Long? = null,
  val entryPriceUsd: Double? = null,
  /** receipt | paper | quote, or null when unrecorded. */
  val basisSource: String? = null,
)

@Serializable
data class TokenLedger(
  val symbol: String? = null,
  val holders: List<TokenHolder> = emptyList(),
  /** Agents holding it that do not publish their book. A count, never a list. */
  val privateHolders: Int = 0,
  /**
   * Whether the fills query answered AT ALL.
   *
   * Without it the page says "the position is real, the trade that opened it is
   * older than what the ledger keeps" — a positive claim about retention
   * manufactured out of a caught exception.
   */
  val fillsRead: Boolean = true,
)

/**
 * What the index knows about this token.
 *
 * `read` is `found | absent | unread`, and "absent" IS DELIBERATELY NARROW: the
 * pools come from page one of three feeds, so a token missing from them is not
 * a token the index has never heard of. Anything shown for that case must be a
 * sentence about those feeds, never about the index.
 */
@Serializable
data class TokenMarketRead(
  val kind: String? = null,
  val symbol: String? = null,
  val read: String? = null,
  val stock: Token? = null,
  val coin: DiscoveryCoin? = null,
  /**
   * This ticker also belongs to a LISTED token at another address.
   *
   * Both tickers are attacker-chosen, and theses are matched to a page BY
   * SYMBOL — so without this flag an agent's real reasoning about NVDA prints
   * on an impostor's page, attributed to a holder of the impostor.
   */
  val symbolClash: Boolean = false,
)

/** What the index returns for a coin. `reserveUsd` is mostly VIRTUAL on a curve. */
@Serializable
data class DiscoveryCoin(
  val token: String? = null,
  val name: String? = null,
  val venue: String? = null,
  val priceUsd: Double? = null,
  val reserveUsd: Double? = null,
  val fdvUsd: Double? = null,
  val volume24hUsd: Double? = null,
  val change24hPct: Double? = null,
  val buyers24h: Int? = null,
  val ageDays: Double? = null,
  val graduated: Boolean = false,
  /** Still on its bonding curve — treat `reserveUsd` with suspicion. */
  val onCurve: Boolean = false,
  /** The scout's {conviction, reason} when it had one. Null is a considered pass. */
  val verdict: JsonElement? = null,
  /**
   * The index's tape per window (5m, 1h, 6h, 24h), raw. A window the index
   * omitted is null throughout, never zero. Read through [tape].
   */
  val buckets: JsonElement? = null,
  /** The pool as the index names it. A key for the index, never an address to call. */
  val poolId: String? = null,
  /** Which venue the figures came from. */
  val dex: String? = null,
) {
  /** The same raw tape as [buckets], by the name the screens use for it. */
  val tape: JsonElement? get() = buckets
}

/**
 * GET /api/discoveries — what is trading on this chain, from the index.
 *
 * THE CAVEATS TRAVEL WITH THE LIST. [truncated] means the rows are a PREFIX of
 * the market, [degraded] that the render is short because the read was, and
 * [indexUnreachable] that there is nothing to show because we could not ask.
 * An incomplete list and a small one look identical without them.
 */
@Serializable
data class Discoveries(
  /**
   * EPOCH SECONDS of the read (read-discoveries.ts sets it to nowSec). The same
   * unit as [TokensPage.fetchedAt], so the two reads can be compared for which
   * is newer without converting either.
   */
  val fetchedAt: Long? = null,
  val scanned: Int? = null,
  val indexUnreachable: Boolean = false,
  val rows: List<DiscoveryCoin> = emptyList(),
  val graduated: Int? = null,
  /** Freshly launched coins, raw until a screen renders them. */
  val fresh: JsonElement? = null,
  /** The chain's own status block, raw. */
  val chain: JsonElement? = null,
  /** no-model | model-failed — the scout could not look — or null, it looked. */
  val verdictsWhy: String? = null,
  val truncated: Boolean = false,
  val degraded: Boolean = false,
)

@Serializable
data class TokenDetail(
  val ledger: TokenLedger = TokenLedger(),
  val market: TokenMarketRead = TokenMarketRead(),
  /** Null for a token the index never returned — there is no pool to ask about. */
  val candles: CandleRead? = null,
  /**
   * Pool evidence — recent pool trades and the tape — sent only when asked for
   * with `activity = true`, and only for a coin. Raw: {poolId, token, candles,
   * trades: {failed?, observedAt, data: [...]}}.
   */
  val evidence: JsonElement? = null,
)

/**
 * Yahoo's chart document, as the venue proxy passes it through.
 *
 * Modelled only as deeply as it is read. Every quote array is nullable at every
 * index — a halted minute has nulls in it — so a bar with any null is DROPPED
 * rather than interpolated, which is what draws a line through a price that
 * never existed.
 */
@Serializable
data class VenueChart(val chart: VenueChartBody? = null)

@Serializable
data class VenueChartBody(val result: List<VenueChartResult> = emptyList())

@Serializable
data class VenueChartResult(
  val timestamp: List<Long> = emptyList(),
  val indicators: VenueIndicators? = null,
)

@Serializable
data class VenueIndicators(val quote: List<VenueQuote> = emptyList())

@Serializable
data class VenueQuote(
  val open: List<Double?> = emptyList(),
  val high: List<Double?> = emptyList(),
  val low: List<Double?> = emptyList(),
  val close: List<Double?> = emptyList(),
)
