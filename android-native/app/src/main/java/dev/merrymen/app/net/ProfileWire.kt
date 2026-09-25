package dev.merrymen.app.net

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.net.URLEncoder
import kotlin.coroutines.resume

/**
 * AN AGENT'S PUBLIC PAGE, AS /api/agents/{slug} SERVES IT — and its owner's
 * own view, and its pictures.
 *
 * The page used to filter the GLOBAL /api/theses window by slug, which is a
 * 24-hour, per-lane-capped read of everybody: an active agent whose posts fell
 * outside the cap read "has not posted inside the current window". This route
 * answers for the one agent, with its own thirty days of decisions and a flag
 * saying whether they could be read at all.
 *
 * Every field is nullable or defaulted (web/src/lib/read-agent.ts
 * `AgentProfile`): an older server sends fewer of them, and a field that is
 * absent is NOT READ — it renders as nothing, never as a zero. Figures a server
 * might ever send with a fraction are Doubles, because one fractional number in
 * an Int slot fails the decode of the whole page.
 */

/** How it decides: {kind: "strategy", name} or {kind: "model", provider, model}. Null when we may not say. */
@Serializable
data class HowItTrades(
  val kind: String? = null,
  val name: String? = null,
  val provider: String? = null,
  val model: String? = null,
)

/** One hourly close of the growth index (deposits divided out). [at] is epoch seconds. */
@Serializable
data class GrowthPoint(val at: Long? = null, val g: Double? = null)

/** Gas charged against the return, and how many fills could not be priced. */
@Serializable
data class ProfileGas(val usdg: Double? = null, val unpricedTrades: Int? = null)

/**
 * A holding as a PUBLIC book publishes it. Empty unless the owner opted in —
 * [AgentProfile.publicBook] says which.
 */
@Serializable
data class ProfileHolding(
  val symbol: String? = null,
  val token: String? = null,
  val valueUsdg: Double? = null,
  val costUsdg: Double? = null,
  val pnlBps: Double? = null,
  /** Share of the marked book, in bps — a percentage, never a second dollar figure. */
  val shareBps: Double? = null,
  val priceStale: Boolean? = null,
  val priceSource: String? = null,
  val heldSince: Long? = null,
  val basisSource: String? = null,
)

/**
 * One fill as the profile may publish it (lib/profile-trades.ts). The size and
 * the realized dollars are sent ONLY for a public book or on the owner's own
 * read; the return (bps) only on a sell whose cost was evidenced.
 */
@Serializable
data class ProfileTrade(
  val id: String? = null,
  /** buy | sell | swap — "swap" when nothing recorded which way it went. */
  val action: String? = null,
  val symbol: String? = null,
  val displayName: String? = null,
  /** Epoch seconds. */
  val at: Long? = null,
  val paper: Boolean = false,
  val sizeUsdg: Double? = null,
  val realizedPnlUsdg: Double? = null,
  val realizedPnlBps: Double? = null,
)

@Serializable
data class AgentProfile(
  val slug: String? = null,
  val name: String? = null,
  val handle: String? = null,
  /** Absent is not proven. */
  val handleVerified: Boolean = false,
  /** live | paper | idle — the LAST HEARTBEAT's value. */
  val mode: String? = null,
  val beatAt: Long? = null,
  val how: HowItTrades? = null,
  /** Exactly one of this and [unrankedWhy] is set. */
  val pnlBps: Double? = null,
  val paperPnlBps: Double? = null,
  val unrankedWhy: String? = null,
  /** A FLOOR: measured over hourly closes, so a dip inside one hour is not seen. */
  val maxDdBps: Double? = null,
  /** Operations that filled for real. */
  val landed: Int? = null,
  /** Fills on paper — a separate counter, never folded into [landed]. */
  val filledPaper: Int? = null,
  val refused: Int? = null,
  val gas: ProfileGas? = null,
  val funded: Boolean? = null,
  /** Whether the flows divided out of the growth index were read from the chain. */
  val contributionsEvidenced: Boolean? = null,
  /** Oldest first, one close an hour over the whole period. Null from a server before windows. */
  val growth: List<GrowthPoint>? = null,
  /** False when the read hit its cap and the oldest hours were not read. */
  val growthComplete: Boolean? = null,
  val holdings: List<ProfileHolding> = emptyList(),
  /** The owner published this book. Null is not read, which is not "private". */
  val publicBook: Boolean? = null,
  val recentTrades: List<ProfileTrade>? = null,
  val activityRead: Boolean? = null,
  val holdingsRead: Boolean? = null,
  val topTrades: List<ProfileTrade>? = null,
  /** Whether [topTrades] was read. Read and empty is "No closed trades yet". */
  val topTradesRead: Boolean? = null,
  /** Distinct buys and sells this period. Null when unread. */
  val tradeCount: Int? = null,
  /** The count came from a capped read and is a floor ("5,000+"). */
  val tradeCountFloor: Boolean? = null,
  val avgHoldSec: Double? = null,
  /** When the identity was minted, epoch seconds. */
  val joinedAt: Long? = null,
  /** True only when EVERY landed operation was sponsored — measured, never assumed. */
  val gasless: Boolean? = null,
  /** This agent's own published decisions, up to thirty days. */
  val theses: List<Thesis> = emptyList(),
  /** False when the ledger behind [theses] could not be read — not "posted nothing". */
  val thesesRead: Boolean? = null,
)

/**
 * THE OWNER'S OWN FIGURES from /api/agents/{slug}/own: the same trades with
 * their sizes and dollars in. Anyone but the owner gets a 404, the same one an
 * unknown slug gets.
 */
@Serializable
data class OwnBook(
  val recentTrades: List<ProfileTrade>? = null,
  val activityRead: Boolean? = null,
  val topTrades: List<ProfileTrade>? = null,
  val topTradesRead: Boolean? = null,
)

/** The route's own shape check (api/agents/[slug]/route.ts). Nothing else is sent. */
private val AGENT_ID = Regex("^[a-zA-Z0-9_-]{1,100}$")

/**
 * GET /api/agents/{slug}. NOT named `agent` — [MerrymenApi.agent] is a member
 * and would win. A slug of the wrong shape is refused here, before anything
 * leaves the phone, with the route's own 400.
 */
suspend fun MerrymenApi.agentProfile(slug: String): ApiResult<AgentProfile> =
  if (!AGENT_ID.matches(slug)) ApiResult.Refused(400, "That isn't an agent's id.") else getJson("/api/agents/$slug")

/**
 * GET /api/agents/{slug}/own. The SERVER decides whether this session owns the
 * slug; a 404 means "not yours" (or "no trades on record") and is ignored.
 */
suspend fun MerrymenApi.ownBook(slug: String): ApiResult<OwnBook> =
  if (!AGENT_ID.matches(slug)) ApiResult.Refused(400, "That isn't an agent's id.") else getJson("/api/agents/$slug/own")

// ── pictures ────────────────────────────────────────────────────────────────

/** What one picture request amounted to. */
sealed interface ImageAnswer {
  /** New bytes, and the ETag to revalidate them with. */
  class Fresh(val bytes: ByteArray, val etag: String?) : ImageAnswer

  /** 304: the bytes held under the ETag sent are still the picture. */
  data object NotModified : ImageAnswer

  /** 404: nothing was uploaded. A feature, not a failure — the face falls back to initials. */
  data object Missing : ImageAnswer

  /** No answer, or one that was not an image. Says nothing about the agent. */
  data class Failed(val why: String) : ImageAnswer
}

/** The largest picture the route serves (banner, lib/agent-image.ts), plus room. */
private const val IMAGE_MAX_BYTES = 9L * 1024 * 1024

/**
 * GET /api/agent-image/{slug}/{kind} — OUR ORIGIN, never a third-party host:
 * the web stopped hotlinking robohash for exactly that reason (every reader's
 * IP went to a third party for every face on the page).
 *
 * [etag] is sent as If-None-Match so an unchanged picture costs a 304;
 * [version] is the `v` an upload hands back, which makes a new picture show at
 * once instead of after the route's minute of freshness.
 */
suspend fun MerrymenApi.agentImage(slug: String, kind: String, etag: String?, version: String?): ImageAnswer {
  val path = "/api/agent-image/$slug/$kind" + (version?.let { "?v=" + URLEncoder.encode(it, "UTF-8") } ?: "")
  val url = urlFor(path) ?: return ImageAnswer.Failed(NOT_A_WEB_ADDRESS)
  val request = Request.Builder()
    .url(url)
    .header("Accept", "image/webp,image/*")
    .apply { if (etag != null) header("If-None-Match", etag) }
    .build()
  return suspendCancellableCoroutine { cont ->
    val call = http.newCall(request)
    cont.invokeOnCancellation { call.cancel() }
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        if (cont.isActive) cont.resume(ImageAnswer.Failed(e.message ?: "no answer"))
      }

      override fun onResponse(call: Call, response: Response) {
        val answer = response.use { r ->
          when {
            r.code == 304 -> ImageAnswer.NotModified
            r.code == 404 -> ImageAnswer.Missing
            !r.isSuccessful -> ImageAnswer.Failed("HTTP ${r.code}")
            // An error page is not a picture, and decoding one would draw noise
            // where a face goes.
            r.body?.contentType()?.type != "image" -> ImageAnswer.Failed("not an image")
            (r.body?.contentLength() ?: 0L) > IMAGE_MAX_BYTES -> ImageAnswer.Failed("too large")
            else -> try {
              // Read at most one byte past the cap, whatever the header claimed:
              // a missing Content-Length is not permission to fill memory.
              val source = r.body!!.source()
              if (source.request(IMAGE_MAX_BYTES + 1)) {
                ImageAnswer.Failed("too large")
              } else {
                ImageAnswer.Fresh(source.buffer.readByteArray(), r.header("ETag"))
              }
            } catch (e: IOException) {
              ImageAnswer.Failed(e.message ?: "cut off")
            }
          }
        }
        if (cont.isActive) cont.resume(answer)
      }
    })
  }
}

/**
 * WHICH AGENT IS THE READER'S OWN, from their /api/feed: its `agent.slug`,
 * as the web's `mineOf` (terminal/live.ts) takes it.
 *
 * `nameSource` IS NOT CONSULTED, because it is about the NAME alone. The slug
 * comes from the identity store for the session's own tenant
 * (feed-identity.ts `identityOf`: `slug = tenant ? slugOf(tenant) : null`),
 * so a signed-out feed already sends null, and a signed-in one whose settings
 * could not be read — `"fallback"`, a name that says nothing — still carries
 * the reader's real slug. Gating on the name threw it away: the reader was
 * offered the wire on their own page and their own row on the board was not
 * marked "you". The house "Robin" is nobody's agent, and it never has a slug.
 */
fun ownSlugOf(feed: Feed?): String? = feed?.agent?.slug?.takeIf { it.isNotBlank() }
