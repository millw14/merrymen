package dev.merrymen.app.net

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

class ReadDeadlineTest {
  private lateinit var server: MockWebServer
  @Before fun start() { server = MockWebServer(); server.start() }
  @After fun stop() { server.shutdown() }

  @Test fun ordinaryReadsHaveOneBudgetButWritesKeepTheirOriginalDeadline() = runBlocking {
    val seen = mutableListOf<Pair<String, Long>>()
    val http = OkHttpClient.Builder().addInterceptor { chain ->
      seen += chain.request().method to chain.call().timeout().timeoutNanos()
      chain.proceed(chain.request())
    }.build()
    val api = MerrymenApi(http, OriginSource { server.origin() }, recoverReads = true)
    server.answer("""{"version":"0.21.0"}""")
    assertTrue(api.version() is ApiResult.Ok)
    server.answer("{}")
    assertTrue(api.call(Request.Builder().url(server.url("/write")).post("{}".toRequestBody()).build()) is ApiResult.Ok)
    assertEquals(listOf("GET" to TimeUnit.SECONDS.toNanos(30), "POST" to 0L), seen)
  }

  @Test fun aShorterWholeCallLimitStillEndsAReadWhoseSocketHasNotTimedOut() = runBlocking {
    val http = OkHttpClient.Builder()
      .readTimeout(10, TimeUnit.SECONDS)
      .callTimeout(300, TimeUnit.MILLISECONDS)
      .build()
    val api = MerrymenApi(http, OriginSource { server.origin() }, recoverReads = true)
    server.enqueue(MockResponse().setBody("{}").setHeadersDelay(1, TimeUnit.SECONDS))
    val started = System.nanoTime()
    assertTrue(api.version() is ApiResult.Unreachable)
    assertTrue("the caller's shorter deadline must survive the read-client derivative",
      TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 2_000)
    assertEquals(1, server.requestCount)
  }
}
