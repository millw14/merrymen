package dev.merrymen.app.net

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * A WRITE WHOSE ANSWER IS LOST IS SENT ONCE, AND READS AS UNKNOWN.
 *
 * The shared client had retryOnConnectionFailure on, and OkHttp then re-sent a
 * request by itself when its answer was cut off on a REUSED connection: an
 * agent-picture PUT reached the server twice in cluster D's test, and an order
 * is a POST that goes the same way. A second order nobody decided on is the
 * one thing a trading client must never do; a lost answer is UNKNOWN and the
 * caller looks it up.
 *
 * Every test warms a connection with a read, so the write rides a pooled
 * connection, then has the server take the write and hang up without
 * answering (DISCONNECT_AFTER_REQUEST). Behind that it queues the answer a
 * SECOND copy would get, so a re-send cannot hide: it would come back Ok, and
 * the server would count it.
 */
class WriteOnceTest {
  private lateinit var server: MockWebServer

  @Before fun start() {
    server = MockWebServer()
    server.start()
  }

  @After fun stop() = server.shutdown()

  /** The client the app runs: Http.client over the real cookie jar. */
  private fun appApi(s: MockWebServer = server): MerrymenApi {
    val store = MemoryStore(s.origin())
    return MerrymenApi(Http.client(PersistentCookieJar(store), debug = false), store)
  }

  /** One read first, so its connection is pooled and the next request reuses it. */
  private suspend fun warm(api: MerrymenApi, s: MockWebServer = server) {
    s.answer("""{"version":"0.21.0"}""")
    assertTrue(api.version() is ApiResult.Ok)
  }

  /** The next request arrives and its answer never does; behind it, what a second copy would be told. */
  private fun cutOffThenOffer(secondCopyGets: String, s: MockWebServer = server) {
    s.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
    s.answer(secondCopyGets)
  }

  /** Every request that arrived after the warm-up read, as "METHOD /path". */
  private fun arrivedAfterWarmUp(s: MockWebServer = server): List<String> {
    val all: List<RecordedRequest> = List(s.requestCount) { s.takeRequest(1, TimeUnit.SECONDS)!! }
    assertEquals("the warm-up read", "GET /api/version", all.first().let { it.method + " " + it.path })
    return all.drop(1).map { it.method + " " + it.path }
  }

  private fun assertUnknown(what: String, r: ApiResult<*>) {
    // Unreachable and not "unreadable": no answer came, so nobody can say
    // whether it was done. Refused would be a lie (nobody said no); Ok a worse one.
    if (r !is ApiResult.Unreachable || r.unreadable) fail("$what: a lost answer must be unknown, got $r")
  }

  /**
   * [path] on the host the app's client talks to. The same host as the warm-up
   * read, or the pool would open a fresh connection and there would be no
   * reused one to cut off.
   */
  private fun at(path: String) = (server.origin() + path).toHttpUrl()

  private fun orderPost(): Request =
    Request.Builder().url(at("/api/orders"))
      .post("""{"side":"buy","symbol":"NVDA","usdg":5}""".toRequestBody("application/json".toMediaType()))
      .build()

  /** A raw call the way a Wire file makes one: true if any answer came back, false if the call failed. */
  private fun answered(client: OkHttpClient, req: Request): Boolean = try {
    client.newCall(req).execute().use { true }
  } catch (e: IOException) {
    false
  }

  // ── the app's own client ────────────────────────────────────────────────

  @Test fun anOrderWhoseAnswerIsCutOffIsSentOnceAndIsUnknown() = runBlocking {
    val api = appApi()
    warm(api)
    cutOffThenOffer("""{"id":"o-2","queued":true}""")

    assertUnknown("the order", api.order("buy", "NVDA", 5.0, owner = "0xabc"))

    val all = List(server.requestCount) { server.takeRequest(1, TimeUnit.SECONDS)!! }
    assertEquals(
      "the read, then one order — never a second one underneath",
      listOf("GET /api/version", "POST /api/orders"),
      all.map { it.method + " " + it.path },
    )
    assertEquals("the order rode the reused connection, the case the transport used to retry", 1, all[1].sequenceNumber)
  }

  @Test fun aWriteBuiltByHandOnTheSharedClientIsSentOnce() = runBlocking {
    // How a Wire file sends a write it reads by hand: http.newCall. The
    // contract says writeHttp, but the shared client must not be the one that
    // re-sends when somebody forgets.
    val api = appApi()
    warm(api)
    cutOffThenOffer("{}")
    assertEquals(false, answered(api.http, orderPost()))
    assertEquals(listOf("POST /api/orders"), arrivedAfterWarmUp())
  }

  @Test fun aClientDerivedWithRetryTurnedBackOnStillSendsAWriteOnce() = runBlocking {
    // A route that derives its own client from the shared one and switches the
    // transport's recovery back on still cannot re-send a write: the body is
    // one-shot, and OkHttp never transmits a one-shot body twice.
    val api = appApi()
    warm(api)
    val retrying = api.http.newBuilder().retryOnConnectionFailure(true).build()
    cutOffThenOffer("{}")
    assertEquals(false, answered(retrying, orderPost()))
    assertEquals(listOf("POST /api/orders"), arrivedAfterWarmUp())
  }

  @Test fun aWriteWithNoBodyIsOneShotToo() = runBlocking {
    // DELETE may be built with no body at all, and a missing body cannot be
    // marked one-shot — so it is given an empty one, as OkHttp's own delete()
    // sends. Here SendWritesOnce is the only guard: the client retries.
    val retrying = OkHttpClient.Builder().addInterceptor(SendWritesOnce()).build()
    assertEquals(true, retrying.retryOnConnectionFailure)
    server.answer("{}")
    assertEquals(true, answered(retrying, Request.Builder().url(server.url("/api/version")).build()))
    cutOffThenOffer("{}")
    assertEquals(false, answered(retrying, Request.Builder().url(server.url("/api/grants")).method("DELETE", null).build()))
    assertEquals(2, server.requestCount)
  }

  @Test fun theSharedClientRetriesNothingOnItsOwn() = runBlocking {
    // Off globally, reads included: a read built by hand on it is not repeated
    // either. The API's own reads get their recovery back (see below).
    val api = appApi()
    warm(api)
    assertEquals(false, api.http.retryOnConnectionFailure)
    cutOffThenOffer("{}")
    assertEquals(false, answered(api.http, Request.Builder().url(at("/api/feed")).build()))
    assertEquals(listOf("GET /api/feed"), arrivedAfterWarmUp())
  }

  @Test fun a503ThatSaysRetryNowIsTheAnswerNotAResend() = runBlocking {
    // OkHttp repeats a request answered 503 with Retry-After: 0 by itself,
    // retryOnConnectionFailure or not. A gateway can send that after the route
    // already placed the order, so for a write it is the answer, and it is read.
    val api = appApi()
    warm(api)
    server.enqueue(
      MockResponse().setResponseCode(503).setHeader("Retry-After", "0")
        .setHeader("content-type", "application/json").setBody("""{"error":"busy"}"""),
    )
    server.answer("""{"id":"o-2","queued":true}""")

    val r = api.order("buy", "NVDA", 5.0)

    assertTrue("the 503 is what came back, got $r", r is ApiResult.Refused && r.status == 503)
    assertEquals(listOf("POST /api/orders"), arrivedAfterWarmUp())
  }

  @Test fun aReadStillRecoversFromAStaleConnection() = runBlocking {
    // What the retry was good for, kept where it is safe: a read the API makes
    // is asked again on a fresh connection, which changes nothing.
    val api = appApi()
    warm(api)
    cutOffThenOffer("""{"version":"0.21.1"}""")
    assertEquals(ApiResult.Ok(Version(version = "0.21.1")), api.version())
    assertEquals(listOf("GET /api/version", "GET /api/version"), arrivedAfterWarmUp())
  }

  // ── whatever client the API was built with ─────────────────────────────

  @Test fun everyWriteTheApiSendsGoesOutOnceEvenOnAClientThatRetries() = runBlocking {
    // A plain OkHttpClient retries by default — the client a test hands in, or
    // one a later change builds. MerrymenApi puts every non-GET on writeHttp
    // regardless, so a route's own code cannot get this wrong.
    val png = byteArrayOf(1, 2, 3).toRequestBody("image/png".toMediaType())
    val writes: List<Pair<String, suspend (MerrymenApi) -> ApiResult<*>>> = listOf(
      "POST /api/orders" to { api -> api.order("buy", "NVDA", 5.0) },
      "POST /api/snipe" to { api -> api.snipe("pepe", 5.0) },
      "PUT /api/settings" to { api ->
        api.patchSettings(buildJsonObject { put("assetMode", JsonPrimitive("crypto")) }, "0xabc")
      },
      "DELETE /api/grants" to { api -> api.revokeGrant() },
      "POST /api/chat" to { api -> api.chat(ChatBody(message = "buy nvda")) },
      // An upload's shape, and a Wire file's own DELETE, both through callAt.
      "PUT /api/agent-image/me/avatar" to { api -> api.callAt("/api/agent-image/me/avatar") { put(png) } },
      "DELETE /api/groupchat?id=7" to { api -> api.callAt("/api/groupchat?id=7") { delete() } },
    )
    for ((route, send) in writes) {
      // A server of its own per route, so an unused second answer never
      // lands on the next route's warm-up.
      val s = MockWebServer().apply { start() }
      try {
        val api = apiFor(s, OkHttpClient())
        assertEquals(true, api.http.retryOnConnectionFailure)
        warm(api, s)
        cutOffThenOffer("""{"reply":"x","id":"o-2","queued":true,"ok":true}""", s)
        assertUnknown(route, send(api))
        assertEquals("$route was sent once", listOf(route), arrivedAfterWarmUp(s))
      } finally {
        s.shutdown()
      }
    }
  }

  @Test fun theChatClientSendsOnceWhenAStreamReaderCallsItDirectly() = runBlocking {
    // A streamed reply is read by hand on chatHttp.newCall, outside call(): the
    // client itself must be the guard. Built on a client that retries.
    val api = apiFor(server, OkHttpClient())
    warm(api)
    cutOffThenOffer("{}")
    val chat = Request.Builder().url(server.url("/api/chat")).header("accept", "text/event-stream")
      .post("""{"message":"hi"}""".toRequestBody("application/json".toMediaType())).build()
    assertEquals(false, answered(api.chatHttp, chat))
    assertEquals(listOf("POST /api/chat"), arrivedAfterWarmUp())
    assertEquals(false, api.chatHttp.retryOnConnectionFailure)
    assertTrue("same pool as the shared client", api.chatHttp.connectionPool === api.http.connectionPool)
  }
}
