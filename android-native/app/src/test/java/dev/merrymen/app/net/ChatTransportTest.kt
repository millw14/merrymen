package dev.merrymen.app.net

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * A SLOW MODEL IS NOT AN UNREACHABLE SERVER.
 *
 * /api/chat without a stream sends nothing until the completion is done. The
 * shared client gave up at 30s and the phone said "Couldn't reach merrymen"
 * about a reply the web would have waited 60s for.
 *
 * The delay test runs in seconds rather than the minute the real gap is: it
 * gives the SHARED client a 1s read timeout and the reply a 2s delay, so the
 * only way the chat can come back Ok is on its own client. The configured
 * numbers are pinned separately.
 */
class ChatTransportTest {
  private lateinit var server: MockWebServer
  private lateinit var api: MerrymenApi

  @Before fun start() {
    server = MockWebServer()
    server.start()
    val impatient = OkHttpClient.Builder().readTimeout(1, TimeUnit.SECONDS).build()
    api = apiFor(server, impatient)
  }

  @After fun stop() = server.shutdown()

  private fun slow(body: String) = server.enqueue(
    MockResponse().setHeader("content-type", "application/json").setBody(body).setHeadersDelay(2, TimeUnit.SECONDS),
  )

  @Test fun aReplySlowerThanTheSharedTimeoutStillArrives() = runBlocking {
    slow("""{"reply":"thought about it"}""")
    assertEquals(ApiResult.Ok(ChatReply(reply = "thought about it")), api.chat(ChatBody(message = "hi")))
  }

  @Test fun theSameDelayOnAnyOtherRouteIsUnreachable() = runBlocking {
    // The control: without its own client, this delay is a timeout.
    slow("""{"version":"x"}""")
    assertTrue(api.version() is ApiResult.Unreachable)
  }

  @Test fun theChatClientWaitsLongerThanTheWeb() {
    assertEquals(90_000, api.chatHttp.readTimeoutMillis)
    assertEquals(120_000, api.chatHttp.callTimeoutMillis)
    // Derived, not new: same pool, so the chat does not open its own sockets.
    assertTrue(api.chatHttp.connectionPool === api.http.connectionPool)
  }

  @Test fun aClassifiedFailureDecodesItsKindAndProvider() = runBlocking {
    server.answer(
      """{"reply":null,"why":"llm-error","kind":"rate-limited","provider":"Groq","detail":"429 from upstream"}""",
    )
    val r = (api.chat(ChatBody(message = "hi")) as ApiResult.Ok).value
    assertEquals("rate-limited", r.kind)
    assertEquals("Groq", r.provider)
    assertEquals("llm-error", r.why)
  }

  // ── the headers interceptor leaves a streamed request's Accept alone ─────

  private fun acceptSeenFor(accept: String?): String? {
    val client = OkHttpClient.Builder().addInterceptor(MerrymenHeaders()).build()
    server.answer("{}")
    val req = Request.Builder().url(server.url("/api/chat")).apply { if (accept != null) header("accept", accept) }.build()
    client.newCall(req).execute().close()
    return server.takeRequest().getHeader("accept")
  }

  @Test fun anAskedForAcceptSurvivesTheInterceptor() {
    assertEquals("text/event-stream, application/json", acceptSeenFor("text/event-stream, application/json"))
  }

  @Test fun noAcceptMeansJson() {
    assertEquals("application/json", acceptSeenFor(null))
  }
}
