package dev.merrymen.app.net

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.internal.http2.ConnectionShutdownException
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

/**
 * NO ANSWER IS SAID IN THE APP'S WORDS, never OkHttp's.
 *
 * ApiResult.Unreachable.cause reaches the owner verbatim (`said`, the
 * LoadedBlock notice, Home's stale line); it used to be the exception's
 * message or, for one without a message, its class name.
 */
class NoAnswerTest {
  private val noRetry = OkHttpClient.Builder().retryOnConnectionFailure(false).build()

  /** Nothing a person should read: a class name, OkHttp's phrasing, a host lookup's system text. */
  private fun assertPlain(cause: String) {
    for (raw in listOf("Exception", "unexpected end of stream", "stream was reset", "Unable to resolve host", "Failed to connect", "localhost")) {
      assertFalse("'$raw' shown to the owner: $cause", cause.contains(raw, ignoreCase = true))
    }
  }

  private fun <T> withServer(block: suspend (MockWebServer) -> T): T = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      block(server)
    } finally {
      server.shutdown()
    }
  }

  @Test fun aConnectionCutBeforeTheAnswerSaysItDropped() = withServer { server ->
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
    val r = apiFor(server, noRetry).version()
    val u = r as ApiResult.Unreachable
    assertFalse(u.unreadable)
    assertEquals("the connection dropped before an answer came back", u.cause)
    assertEquals("Can't reach merrymen right now: the connection dropped before an answer came back", u.said)
    assertPlain(u.said)
  }

  @Test fun aSlowServerSaysItTimedOut() = withServer { server ->
    server.enqueue(MockResponse().setBody("{}").setHeadersDelay(2, TimeUnit.SECONDS))
    val quick = noRetry.newBuilder().readTimeout(200, TimeUnit.MILLISECONDS).build()
    val u = apiFor(server, quick).version() as ApiResult.Unreachable
    assertEquals("the connection timed out", u.cause)
    assertPlain(u.said)
  }

  @Test fun aServerThatIsNotThereSaysNoConnectionOpened() = runBlocking {
    val server = MockWebServer()
    server.start()
    val api = apiFor(server, noRetry)
    server.shutdown()
    val u = api.version() as ApiResult.Unreachable
    assertEquals("this phone couldn't open a connection to the server", u.cause)
    assertPlain(u.said)
  }

  @Test fun aMessagelessGoawayIsNotItsClassName() {
    // An HTTP/2 GOAWAY behind Cloudflare: no message, so the old fallback
    // printed the type name.
    val cause = noAnswerCause(ConnectionShutdownException())
    assertEquals("the connection dropped before an answer came back", cause)
    assertPlain(cause)
  }

  @Test fun anOfflinePhoneIsToldSoWithoutTheSystemsText() {
    val cause = noAnswerCause(UnknownHostException("Unable to resolve host \"app.merrymen.dev\": No address associated with hostname"))
    assertTrue(cause, cause.contains("look up the server's address"))
    assertPlain(cause)
  }
}
