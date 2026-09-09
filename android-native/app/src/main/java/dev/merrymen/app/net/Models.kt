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
data class AlphaView(
  val locked: Boolean = true,
  /** "sign-in" | "balance" | "unreachable" — three remedies, one of them ours. */
  val why: String? = null,
  val needTokens: Int? = null,
  val symbol: String? = null,
  val tokens: Int? = null,
  /** ABSENT when locked. A blur is not a lock: the body must not ship at all. */
  val picks: List<JsonElement> = emptyList(),
)

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
  val token: String? = null,
  val valueUsdg: Double? = null,
  val priceUsd: Double? = null,
  val priceStale: Boolean = false,
  val priceSource: String? = null,
)

@Serializable
data class AgentGlance(
  val id: String? = null,
  val name: String? = null,
  val slug: String? = null,
  val handle: String? = null,
  val owner: String? = null,
  val equity: Double? = null,
  val chg24: Double? = null,
  val mode: String? = null,
  val thesis: String? = null,
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
  val equity: List<JsonElement> = emptyList(),
)

// ── markets ─────────────────────────────────────────────────────────────────

@Serializable
data class Token(
  val id: String? = null,
  val symbol: String,
  val name: String? = null,
  val address: String? = null,
  val priceUsd: Double? = null,
  val chg24: Double? = null,
  val logo: String? = null,
  val kind: String? = null,
  val stale: Boolean = false,
)

@Serializable
data class TokensPage(val tokens: List<Token> = emptyList())

@Serializable
data class LeaderRow(
  val slug: String? = null,
  val name: String? = null,
  val handle: String? = null,
  val pnlBps: Int? = null,
  val trades: Int? = null,
  val why: String? = null,
)

@Serializable
data class Leaderboard(val agents: List<LeaderRow> = emptyList(), val why: String? = null)

@Serializable
data class SearchResults(val agents: List<LeaderRow> = emptyList(), val tokens: List<Token> = emptyList())

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
