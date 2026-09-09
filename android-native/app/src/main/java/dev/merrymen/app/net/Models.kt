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

/** GET /api/auth/session — {hosted, address}. address is null when signed out. */
@Serializable
data class SessionView(val hosted: Boolean = false, val address: String? = null)

@Serializable
data class Challenge(val origin: String, val nonce: String, val message: String)

@Serializable
data class VerifyBody(val address: String, val signature: String, val nonce: String)

@Serializable
data class VerifyResult(val ok: Boolean? = null, val address: String? = null, val error: String? = null)

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
data class AlphaNeed(val tokens: Int? = null, val name: String? = null, val emoji: String? = null)

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
)

@Serializable
data class ThesesPage(val theses: List<Thesis> = emptyList(), val source: String? = null)

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
) {
  val priceStale: Boolean get() = priceStaleRaw != 0
}

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
  val source: String? = null,
  val agent: AgentGlance? = null,
  val events: List<EventRow> = emptyList(),
  val trades: List<JsonElement> = emptyList(),
  val positions: List<Position> = emptyList(),
  val equity: List<EquityPoint> = emptyList(),
) {
  /** The newest mark, or null when the curve is empty. Null, never 0.0. */
  val equityNow: Double? get() = equity.lastOrNull()?.equityUsdg
}

// ── markets ─────────────────────────────────────────────────────────────────

/**
 * Mirrors MarketToken in web/src/lib/market.ts, served by **`/api/market`**.
 *
 * There is no `/api/tokens` list route — only `/api/tokens/{address}` — so the
 * markets screen was pointed at a 404. `halted` is deliberately nullable: the
 * server's own comment says a halt "may only be asserted when the chain
 * actually answered", and a client that defaults it to false republishes
 * "trading normally" for a token nobody could read.
 */
@Serializable
data class Token(
  val symbol: String,
  val name: String? = null,
  val kind: String? = null,
  val address: String? = null,
  val logo: String? = null,
  val priceUsd: Double? = null,
  val priceUpdatedAt: Long? = null,
  val halted: Boolean? = null,
  val chg24: Double? = null,
)

@Serializable
data class TokensPage(val fetchedAt: Long? = null, val tokens: List<Token> = emptyList())

@Serializable
data class LeaderRow(
  val slug: String? = null,
  val name: String? = null,
  val handle: String? = null,
  /** False by default: absent is not proven. */
  val handleVerified: Boolean = false,
  val pnlBps: Int? = null,
  val trades: Int? = null,
  val why: String? = null,
)

@Serializable
data class Leaderboard(val agents: List<LeaderRow> = emptyList(), val why: String? = null)

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

/**
 * Settings travel as raw JSON in both directions, and that is deliberate.
 *
 * The server's MerrymenSettings carries ~60 fields and validates every one;
 * that validation is the authority. Mirroring it as a data class here would
 * make a second, weaker copy which silently DROPS any field this app does not
 * know about on the next PUT — the read-modify-write hazard this repo has
 * already been bitten by twice, once erasing a basket and once an allowlist. So
 * the client edits the object it was handed and sends it back whole.
 */
@Serializable
data class SettingsEnvelope(
  val values: JsonElement? = null,
  val defaults: JsonElement? = null,
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

@Serializable
data class ChatReply(val reply: String? = null, val why: String? = null, val command: JsonElement? = null)

@Serializable
data class OrderBody(val side: String, val symbol: String, val usdgAmount: Double)

@Serializable
data class OrderResult(
  val id: String? = null,
  val queued: Boolean = false,
  val error: String? = null,
  val state: String? = null,
  val line: String? = null,
)

@Serializable
data class SnipeBody(val query: String, val usdgAmount: Double)

@Serializable
data class Proposal(
  val token: String,
  val symbol: String,
  val decimals: Int = 18,
  val why: String? = null,
  val signed: Boolean = false,
)

@Serializable
data class ProposalsView(val proposals: List<Proposal> = emptyList(), val why: String? = null)

// ── grants ──────────────────────────────────────────────────────────────────

@Serializable
data class GrantView(
  val exists: Boolean = false,
  val gasSponsored: Boolean? = null,
  val grant: JsonElement? = null,
)

// ── holder proof ────────────────────────────────────────────────────────────

@Serializable
data class HolderChallenge(val message: String? = null, val nonce: String? = null, val error: String? = null)

@Serializable
data class HolderLinked(val address: String? = null, val at: Long? = null)

/** A single-field error body, which several routes use verbatim. */
@Serializable
data class ApiError(val error: String? = null, val detail: String? = null)
