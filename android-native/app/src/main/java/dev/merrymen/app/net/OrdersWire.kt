package dev.merrymen.app.net

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * THE ORDER ROUTES, READ THE WAY THE WEB READS THEM.
 *
 * Every write here moves money or asks the worker to, and the one mistake
 * that matters is calling a lost answer a refusal. The shared [MerrymenApi.call]
 * cannot tell them apart for a 5xx: it turns every unmarked 5xx into the
 * generic sentence, and a 502 page from a gateway (nobody behind it answered,
 * so the row may exist) reads exactly like the route's own 503 "couldn't queue
 * it" (nothing was written). The web keeps them apart by whether the route
 * wrote a JSON body (terminal/order-follow.ts routeAnswer), and so does
 * [routeAnswer] here.
 */

/**
 * WHAT A WRITE CAME BACK WITH — or that it never came back.
 *
 * [Said] is the route's own answer: its status and the JSON object it wrote,
 * or a null body when a 2xx carried none (a row exists, but whatever it said
 * about it cannot be read). [Lost] is no answer at all — the request threw,
 * timed out, or an error status came back with no JSON the route wrote — and
 * for an order it is UNKNOWN: the row may exist, so it is looked up, never
 * reported as a failure and never sent again. [NotSent] is the one case where
 * nothing can have happened: the stored server address is not a web address,
 * so no request left the phone.
 */
sealed interface RouteAnswer {
  data class Said(val status: Int, val body: JsonObject?) : RouteAnswer {
    val ok: Boolean get() = status in 200..299
  }
  data object Lost : RouteAnswer
  data class NotSent(val why: String) : RouteAnswer
}

/** A string field of an answer's body, or null when absent or not a string. */
fun JsonObject?.text(key: String): String? =
  (this?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

/**
 * ONE WRITE, and what came back — see [RouteAnswer].
 *
 * Built on [MerrymenApi.urlFor] and the shared client (so the cookie jar and
 * headers are the app's), but read by hand, because the route's JSON body on
 * an error status is the whole difference between "refused" and "unknown".
 *
 * SENT ONCE, WHATEVER CLIENT CARRIES IT. The body is one-shot, the one thing
 * OkHttp promises never to transmit twice: not when a reused connection dies
 * after the request went out (with retryOnConnectionFailure on, which the
 * shared client of this branch's base still has), and not on a 503 that says
 * Retry-After: 0, which OkHttp re-sends even with that retry off. Either would
 * be a second copy of the owner's order sent behind their back, after the
 * route may already have placed the first. The failure or the answer comes
 * back instead, and is read as above. A connection that failed BEFORE anything
 * was sent may still try the host's other address, which is safe and is what
 * keeps a write working on a network where one address family is broken.
 */
suspend fun MerrymenApi.routeAnswer(
  path: String,
  method: String,
  body: JsonObject,
  client: OkHttpClient = http,
): RouteAnswer {
  val u = urlFor(path) ?: return RouteAnswer.NotSent(NOT_A_WEB_ADDRESS)
  val bytes = json.encodeToString(JsonElement.serializer(), body).toByteArray(Charsets.UTF_8)
  val req = Request.Builder()
    .url(u)
    .method(method, OneShotJson(bytes, jsonType))
    .build()
  return exchange(client, req) { r ->
    val obj = jsonObjectOf(r)
    // THE WEB'S RULE, exactly: an error status with nothing the route wrote is
    // nobody's answer. A 2xx with no JSON is still a 2xx — the row exists.
    if (!r.isSuccessful && obj == null) RouteAnswer.Lost else RouteAnswer.Said(r.code, obj)
  } ?: RouteAnswer.Lost
}

/** A write's body that OkHttp may transmit at most once; see [routeAnswer]. */
private class OneShotJson(private val bytes: ByteArray, private val type: MediaType) : RequestBody() {
  override fun contentType(): MediaType = type
  override fun contentLength(): Long = bytes.size.toLong()
  override fun isOneShot(): Boolean = true
  override fun writeTo(sink: BufferedSink) {
    sink.write(bytes)
  }
}

/**
 * A GET the order routes answer, as its JSON object — or null for anything
 * that is not a 2xx with one, or that took longer than [POLL_MS]. Used where a
 * failed read is simply "no answer yet": a poll, and the one look-up after a
 * lost placement.
 *
 * THROUGH callAt ON THE DEFAULT CLIENT, not a GET built by hand, because that
 * is the one read that keeps OkHttp's recovery once writes stop retrying. The
 * look-up runs straight after a placement whose connection died, and OkHttp
 * marks that route failed: the next call goes to the host's other address
 * first, and on a client that never retries, a refusal there is the end of it
 * — the look-up said "nothing open" about an order that was open. The time
 * limit is the coroutine's, which cancels the call.
 */
private suspend fun MerrymenApi.readObject(path: String): JsonObject? {
  val body = (withTimeoutOrNull(POLL_MS) { callAt(path) { get() } } as? ApiResult.Ok)?.value ?: return null
  return try {
    json.parseToJsonElement(body) as? JsonObject
  } catch (e: IllegalArgumentException) {
    null
  }
}

/**
 * One call, cancellable, with [read] run on the response while it is open.
 * Null when no response came: a dropped connection, a timeout, a cancelled
 * call — the caller decides what that means for its route.
 */
private suspend fun <T> exchange(client: OkHttpClient, req: Request, read: (Response) -> T): T? =
  suspendCancellableCoroutine { cont ->
    val call = client.newCall(req)
    cont.invokeOnCancellation { call.cancel() }
    call.enqueue(object : okhttp3.Callback {
      override fun onFailure(call: okhttp3.Call, e: IOException) {
        cont.resume(null)
      }

      override fun onResponse(call: okhttp3.Call, response: Response) {
        // ANYTHING that goes wrong reading the answer is no answer — never a
        // coroutine left waiting for ever on a callback that threw, which for
        // an order would be a placement nobody hears about.
        val out = try {
          response.use { read(it) }
        } catch (e: Exception) {
          null
        }
        cont.resume(out)
      }
    })
  }

/**
 * The body as a JSON object when the route SAID it was JSON and it parses as
 * one. Anything else — an HTML page, plain text, a JSON array — is not an
 * answer this code can read, and is null. Never pasted anywhere.
 */
private fun MerrymenApi.jsonObjectOf(r: Response): JsonObject? {
  val type = r.header("content-type").orEmpty()
  if (!type.contains("application/json", ignoreCase = true)) return null
  val raw = try {
    r.body?.string()
  } catch (e: IOException) {
    null
  } ?: return null
  return try {
    json.parseToJsonElement(raw) as? JsonObject
  } catch (e: IllegalArgumentException) {
    null
  }
}

// ── the ceiling ─────────────────────────────────────────────────────────────

/**
 * THE MOST ONE CHAT ORDER MAY SPEND, as POST /api/orders enforces it — or null
 * when it was not read.
 *
 * Read from the route that shares the orders route's own resolution (the
 * web's lib/order-ceiling.ts), never from /api/settings' values over the
 * defaults: the house can set a lower one, and a "(max)" drawn from the
 * settings would be an amount the route refuses. Signed out it answers 401,
 * and that, a failed read, or anything that is not a finite number ≥ 0 is
 * null — and no amount is offered against a limit nobody read. 0 is a value:
 * "no chat ceiling".
 */
suspend fun MerrymenApi.orderCeiling(): Double? {
  val body = (callAt("/api/orders/ceiling") { get() } as? ApiResult.Ok)?.value ?: return null
  val obj = try {
    json.parseToJsonElement(body) as? JsonObject
  } catch (e: IllegalArgumentException) {
    null
  } ?: return null
  val p = obj["ceilingUsdg"] as? JsonPrimitive ?: return null
  if (p.isString) return null
  return p.content.toDoubleOrNull()?.takeIf { it.isFinite() && it >= 0 }
}

// ── placing ─────────────────────────────────────────────────────────────────

/**
 * QUEUE ONE ORDER, naming the owner who confirmed it.
 *
 * [owner] goes in the body whenever there is one: hosted, the route refuses a
 * session that is not that owner's (409, lib/order-owner.ts OWNER_CHANGED) and
 * writes nothing. Null only self-hosted, where there is no sign-in to name.
 */
suspend fun MerrymenApi.postOrder(side: String, symbol: String, usdg: Double, owner: String?): RouteAnswer =
  routeAnswer(
    "/api/orders",
    "POST",
    buildJsonObject {
      put("side", JsonPrimitive(side))
      put("symbol", JsonPrimitive(symbol))
      put("usdgAmount", JsonPrimitive(usdg))
      if (owner != null) put("owner", JsonPrimitive(owner))
    },
  )

/**
 * HOW LONG A SNIPE'S LOOKUP MAY TAKE before it is given up on (the web's
 * SNIPE_LOOKUP_MS). The lookup places nothing, but nothing can be placed from
 * it until it answers, and an unbounded wait between a tap and an order is time
 * for another wallet to sign in and the price to move.
 */
const val SNIPE_LOOKUP_MS = 15_000L

/** Resolve a coin by name for the owner who confirmed. Places nothing; see [SNIPE_LOOKUP_MS]. */
suspend fun MerrymenApi.lookupSnipe(query: String, usdg: Double, owner: String?): RouteAnswer =
  routeAnswer(
    "/api/snipe",
    "POST",
    buildJsonObject {
      put("query", JsonPrimitive(query))
      put("usdgAmount", JsonPrimitive(usdg))
      if (owner != null) put("owner", JsonPrimitive(owner))
    },
    client = http.newBuilder().callTimeout(SNIPE_LOOKUP_MS, TimeUnit.MILLISECONDS).build(),
  )

/**
 * A SETTINGS WRITE FROM A CONFIRMED CARD, read like an order's.
 *
 * Not [MerrymenApi.patchSettings], because a lost PUT is "I couldn't tell
 * whether that saved" and a refused one is the route's reason — and the shared
 * call reads both of a gateway's 502 and the route's own refusal as one
 * generic sentence. [owner] as on [postOrder]; the route's refusal for a
 * mismatch is 409 OWNER_CHANGED_SETTING, and nothing is written.
 */
suspend fun MerrymenApi.putSettingsFor(patch: JsonObject, owner: String?): RouteAnswer =
  routeAnswer(
    "/api/settings",
    "PUT",
    if (owner == null) patch else JsonObject(patch + ("owner" to JsonPrimitive(owner))),
  )

// ── following ───────────────────────────────────────────────────────────────

/** What an order route answer's id must look like: a hash, and so a safe URL segment. */
val ORDER_ID = Regex("^[0-9a-f]{16,64}$", RegexOption.IGNORE_CASE)

/** How long one poll may take (the web's 8s). A slow poll is no answer yet, not an outcome. */
private const val POLL_MS = 8_000L

/**
 * ONE POLL'S READING, taken field by field rather than decoded whole.
 *
 * A strict decode of [OrderState] fails on one surprising field — a receipt
 * figure sent as text — and a poll that never decodes is a follow that never
 * ends. So [state] and [result] are read as strings when they are strings,
 * and the receipt goes through [receiptOf]'s own checks; a bad receipt costs
 * the receipt, never the answer.
 */
data class OrderPoll(val state: String?, val result: String?, val receipt: OrderReceipt?)

/** GET /api/orders?id= — null for anything but a readable 200: a failed poll is not an outcome. */
suspend fun MerrymenApi.pollOrder(id: String): OrderPoll? {
  if (!ORDER_ID.matches(id)) return null
  val obj = readObject("/api/orders?id=" + java.net.URLEncoder.encode(id, "UTF-8")) ?: return null
  return OrderPoll(state = obj.text("state"), result = obj.text("result"), receipt = receiptOf(obj["receipt"]))
}

/**
 * THE ORDER OPEN ON THIS OWNER'S KEY RIGHT NOW, by id — or null when there is
 * none, or it could not be read.
 *
 * Asked ONCE, after a placement whose answer was lost: one order is open at a
 * time, so an open one is the order that placement made or the one it was
 * refused beside, and following it tells the owner what their key is doing.
 * [owner] makes the route refuse a session that is no longer theirs (409),
 * which reads here as none — another wallet's open order is not this one's.
 */
suspend fun MerrymenApi.openOrder(owner: String?): String? {
  val path = if (owner != null) "/api/orders?owner=" + java.net.URLEncoder.encode(owner, "UTF-8") else "/api/orders"
  val obj = readObject(path) ?: return null
  val state = obj.text("state")
  val id = obj.text("id")
  return if ((state == "queued" || state == "running") && id != null && ORDER_ID.matches(id)) id else null
}

private val RECEIPT_STATUSES = setOf("filled", "refused", "failed", "expired")
private val RECEIPT_SYMBOL = Regex("^[^\\s<>\"'`\\u0000-\\u001f]{1,24}$")
private val RECEIPT_TOKEN = Regex("^0x[0-9a-fA-F]{40}$")
private val RECEIPT_TX = Regex("^0x[0-9a-fA-F]{64}$")
private val RECEIPT_RULE = Regex("^[a-z0-9][a-z0-9-]{0,63}$", RegexOption.IGNORE_CASE)

/**
 * A RECEIPT, SHAPE-CHECKED FIELD BY FIELD — the web's lib/order-state.ts
 * receiptOf. It is printed as a fact about somebody's money, so a field that
 * fails its shape is null ("unread", which prints nothing), never a guess, and
 * without a status there is no receipt at all: the status IS the sentence.
 * Accepts the object or the JSON text of one, the two ways the ferry sends it.
 */
fun receiptOf(v: JsonElement?): OrderReceipt? {
  var bag: JsonElement? = v
  if (v is JsonPrimitive && v.isString) {
    bag = try {
      kotlinx.serialization.json.Json.parseToJsonElement(v.content)
    } catch (e: IllegalArgumentException) {
      return null
    }
  }
  val r = bag as? JsonObject ?: return null
  val status = r.text("status")?.takeIf { it in RECEIPT_STATUSES } ?: return null
  fun shaped(key: String, shape: Regex) = r.text(key)?.takeIf { shape.matches(it) }
  val side = r.text("side")?.takeIf { it == "buy" || it == "sell" }
  val actual = (r["usdgActual"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull()
    ?.takeIf { it.isFinite() && it >= 0 }
  return OrderReceipt(
    status = status,
    side = side,
    symbol = shaped("symbol", RECEIPT_SYMBOL),
    token = shaped("token", RECEIPT_TOKEN),
    usdgActual = actual,
    txHash = shaped("txHash", RECEIPT_TX),
    rejectRule = shaped("rejectRule", RECEIPT_RULE),
  )
}

