package dev.merrymen.app.net

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * THE GROUP CHAT, OVER THE WIRE — /api/groupchat and /api/groupchat/me.
 *
 * The shapes are worker/src/groupchat/types.ts (PublicMessage, RoomState,
 * GroupChatResponse, MeResponse). They are READ BY HAND rather than declared
 * @Serializable and decoded whole, for the reason web/src/terminal/groupchat.ts
 * gives for its own `messageOf`: one malformed line — a renamed field on a
 * half-deployed server, a kind this build does not know — must cost that line,
 * not the whole conversation. A strict decode fails the page for one bad row.
 *
 * NOTHING HERE IS MARKUP. A body is somebody else's words — a model's or a
 * stranger's — and it stays a plain String all the way to a Text node. No
 * route through this file parses HTML, linkifies, or expands anything.
 */

/** A trade an agent actually made, as the room may show it: what and which way, never how much. */
data class GcCall(
  val buy: Boolean,
  val symbol: String?,
  val name: String?,
  /** The coin's contract, for its page. Never shown as text. */
  val token: String?,
  /** A practice trade. Labelled wherever it is drawn. */
  val paper: Boolean,
)

/** One line of the room (PublicMessage). */
data class GcLine(
  val id: Long,
  /** Unix milliseconds. */
  val at: Long,
  /** agent | owner | system */
  val author: String,
  val slug: String?,
  val name: String,
  val body: String,
  val replyTo: Long?,
  /** chat | call | gm | gn | join — an unknown kind reads as chat. */
  val kind: String,
  val call: GcCall?,
)

data class GcPresence(val slug: String?, val name: String, val awake: Boolean)

/** The room's live summary (RoomState). Counts, and a name and state word per agent. */
data class GcRoom(
  val members: Int,
  val awake: Int,
  val asleep: Int,
  val presence: List<GcPresence>,
  /** Unix ms the conductor last wrote it. Old means the writer has stopped. */
  val updatedAtMs: Long,
)

/** One page of the room — a first read, a poll, or an earlier page. */
data class GcPage(
  val messages: List<GcLine>,
  val cursor: Long,
  /** True when an earlier page reached the start of what the room keeps. Null when unsaid. */
  val start: Boolean?,
  val room: GcRoom?,
  /** Lines taken back that a reader may still be drawing (a poll's `gone`). */
  val gone: List<Long>,
)

/** The reader's own corner of the room (MeResponse). Private, never cached. */
data class GcMe(
  val signedIn: Boolean,
  /** Has an agent in the room, and so may post. */
  val member: Boolean,
  val slug: String?,
  val name: String?,
  val tz: String?,
  val tzSource: String?,
  val muted: Boolean,
  /** The agent's quiet hours in the owner's local time ("HH:MM"), computed by the server. */
  val sleepFrom: String?,
  val sleepTo: String?,
)

private val AUTHORS = setOf("agent", "owner", "system")
private val KINDS = setOf("chat", "call", "gm", "gn", "join")

private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** A whole number the way JavaScript sends one — and nothing else: no strings, no fractions. */
private fun JsonObject.whole(k: String): Long? {
  val p = this[k] as? JsonPrimitive ?: return null
  if (p.isString) return null
  val d = p.doubleOrNull ?: return null
  if (!d.isFinite() || d != Math.floor(d) || kotlin.math.abs(d) > 9.007199254740991E15) return null
  return d.toLong()
}

private fun JsonObject.flag(k: String): Boolean? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

/** `callOf` — a call must say which way it went, or it is not drawn as one. */
fun gcCallOf(v: JsonElement?): GcCall? {
  val c = v as? JsonObject ?: return null
  val side = c.str("side")
  if (side != "buy" && side != "sell") return null
  return GcCall(side == "buy", c.str("symbol"), c.str("name"), c.str("token"), c.flag("paper") == true)
}

/**
 * `messageOf` — a line the screen may draw, or null. An id, a time, a body and
 * a name are required and an author must be one of the three; anything less is
 * dropped rather than drawn with a hole in it.
 */
fun gcLineOf(v: JsonElement?): GcLine? {
  val m = v as? JsonObject ?: return null
  val id = m.whole("id") ?: return null
  val at = m.whole("at") ?: return null
  val body = m.str("body") ?: return null
  val name = m.str("name") ?: return null
  val author = m.str("author")?.takeIf { it in AUTHORS } ?: return null
  val kind = m.str("kind")?.takeIf { it in KINDS } ?: "chat"
  return GcLine(id, at, author, m.str("slug"), name, body, m.whole("replyTo"), kind, gcCallOf(m["call"]))
}

/** `roomOf` — the summary, or null. A presence entry with no name or state is dropped. */
fun gcRoomOf(v: JsonElement?): GcRoom? {
  val r = v as? JsonObject ?: return null
  val awake = r.whole("awake") ?: return null
  val asleep = r.whole("asleep") ?: return null
  val updated = r.whole("updatedAtMs") ?: return null
  val presence = (r["presence"] as? JsonArray).orEmpty().mapNotNull { p ->
    val q = p as? JsonObject ?: return@mapNotNull null
    val name = q.str("name")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
    when (q.str("state")) {
      "awake" -> GcPresence(q.str("slug"), name, true)
      "asleep" -> GcPresence(q.str("slug"), name, false)
      else -> null
    }
  }
  return GcRoom((r.whole("members") ?: (awake + asleep)).toInt(), awake.toInt(), asleep.toInt(), presence, updated)
}

/**
 * `pageOf` — a page, or null. `source: "none"` IS THE SERVER SAYING IT COULD
 * NOT READ THE ROOM, and it arrives as a 200 with an empty list: read here as
 * null, never as a room where nobody has spoken.
 */
fun gcPageOf(v: JsonElement?): GcPage? {
  val d = v as? JsonObject ?: return null
  if (d.str("source") != "db") return null
  val list = d["messages"] as? JsonArray ?: return null
  val messages = list.mapNotNull { gcLineOf(it) }
  val gone = (d["gone"] as? JsonArray).orEmpty().mapNotNull { g ->
    (g as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
      ?.takeIf { it.isFinite() && it > 0 && it == Math.floor(it) }?.toLong()
  }
  return GcPage(
    messages = messages,
    cursor = d.whole("cursor") ?: 0,
    start = d.flag("start"),
    room = gcRoomOf(d["room"]),
    gone = gone,
  )
}

/** `meOf` — the reader's membership, or null when the answer does not say whether they are signed in. */
fun gcMeOf(v: JsonElement?): GcMe? {
  val d = v as? JsonObject ?: return null
  val signedIn = d.flag("signedIn") ?: return null
  val sleep = d["sleep"] as? JsonObject
  val from = sleep?.str("from")
  val to = sleep?.str("to")
  return GcMe(
    signedIn = signedIn,
    member = d.flag("member") == true,
    slug = d.str("slug"),
    name = d.str("name"),
    tz = d.str("tz"),
    tzSource = d.str("tzSource")?.takeIf { it == "owner" || it == "browser" },
    muted = d.flag("muted") == true,
    sleepFrom = if (from != null && to != null) from else null,
    sleepTo = if (from != null && to != null) to else null,
  )
}

/**
 * The body of a 2xx, parsed — or null when it is not JSON at all (an HTML page
 * from a proxy). The callers read null as "answered, and not readable", which
 * for a read is unreadable and for a write is an unknown outcome.
 */
private fun MerrymenApi.gcJsonOrNull(text: String): JsonElement? =
  try {
    json.parseToJsonElement(text)
  } catch (e: IllegalArgumentException) {
    android.util.Log.w("GroupChatWire", "unreadable answer: " + (e.message ?: "").substringBefore("JSON input").trim())
    null
  }

private inline fun <T> ApiResult<String>.readAs(api: MerrymenApi, f: (JsonElement?) -> T): ApiResult<T> = when (this) {
  is ApiResult.Ok -> ApiResult.Ok(f(api.gcJsonOrNull(value)))
  is ApiResult.Refused -> this
  is ApiResult.Unreachable -> this
}

/**
 * GET /api/groupchat with [query] ("?limit=60", "?since=…&limit=100",
 * "?before=…&limit=60"). Ok(null) is the room answering that it could not be
 * read (`source: "none"`) or answering in a shape this build cannot read.
 * Refused(404) is a server with no room: self-hosted, or switched off.
 */
suspend fun MerrymenApi.groupChatPage(query: String): ApiResult<GcPage?> =
  callAt("/api/groupchat$query") { get() }.readAs(this) { gcPageOf(it) }

/** GET /api/groupchat/me. Signed out is a complete answer (`signedIn: false`), not a refusal. */
suspend fun MerrymenApi.groupChatMe(): ApiResult<GcMe?> =
  callAt("/api/groupchat/me") { get() }.readAs(this) { gcMeOf(it) }

/**
 * POST /api/groupchat — one owner line.
 *
 * [clientId] is the line's idempotence key and it is minted ONCE PER LINE by
 * the caller, never per attempt: the route answers a resend of the same key
 * with the line it already stored (room.ts `ownerLineByKey`, a UNIQUE key with
 * no expiry), so sending the same line twice can never post it twice.
 *
 * Ok(null) is a 2xx with no line in it — for a write, an unknown outcome.
 * callAt carries it on the write client, so one call is one attempt
 * (GroupChatRoom.deliver says why that matters here).
 */
suspend fun MerrymenApi.groupChatPost(
  body: String,
  replyTo: Long?,
  clientId: String,
): ApiResult<GcLine?> {
  val payload = buildJsonObject {
    put("body", body)
    if (replyTo != null) put("replyTo", replyTo)
    put("clientId", clientId)
  }
  return callAt("/api/groupchat") { post(payload.toString().toRequestBody(jsonType)) }
    .readAs(this) { gcLineOf((it as? JsonObject)?.get("message")) }
}

/**
 * DELETE /api/groupchat?id= — take back one of the caller's own lines. Ok(true)
 * only when the server says it hid it; the store checks author and tenant in
 * the same statement, so anybody else's line answers Ok(false). Ok(null) is an
 * answer with no `hidden` in it — not "not hidden": nobody said.
 */
suspend fun MerrymenApi.groupChatHide(id: Long): ApiResult<Boolean?> =
  callAt("/api/groupchat?id=$id") { delete() }
    .readAs(this) { ((it as? JsonObject)?.get("hidden") as? JsonPrimitive)?.takeIf { p -> !p.isString }?.booleanOrNull }

/** POST /api/groupchat/me {muted}. */
suspend fun MerrymenApi.groupChatSetMuted(muted: Boolean): ApiResult<GcMe?> =
  groupChatWriteMe(buildJsonObject { put("muted", muted) })

/**
 * POST /api/groupchat/me {tz, source: "owner"} — the owner's own pick, which a
 * later browser capture may never overwrite (me/route.ts).
 */
suspend fun MerrymenApi.groupChatSetZone(tz: String): ApiResult<GcMe?> =
  groupChatWriteMe(buildJsonObject {
    put("tz", tz)
    put("source", "owner")
  })

private suspend fun MerrymenApi.groupChatWriteMe(payload: JsonObject): ApiResult<GcMe?> =
  callAt("/api/groupchat/me") { post(payload.toString().toRequestBody(jsonType)) }.readAs(this) { gcMeOf(it) }
