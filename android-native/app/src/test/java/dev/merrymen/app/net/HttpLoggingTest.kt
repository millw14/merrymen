package dev.merrymen.app.net

import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.logging.HttpLoggingInterceptor
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * THE CALL LOG SAYS WHICH CALLS WERE MADE, AND NEVER WHOSE THEY WERE.
 *
 * The session cookie is a bearer credential for somebody's trading account. A
 * logger one level above BASIC prints headers, and every bug report and every
 * `adb logcat` collects what it prints.
 */
class HttpLoggingTest {
  private lateinit var server: MockWebServer

  @Before fun start() {
    server = MockWebServer()
    server.start()
  }

  @After fun stop() = server.shutdown()

  private fun loggers(c: OkHttpClient) = c.interceptors.filterIsInstance<HttpLoggingInterceptor>()

  @Test fun aReleaseBuildHasNoCallLogAtAll() {
    assertTrue(loggers(Http.client(CookieJar.NO_COOKIES, debug = false)).isEmpty())
  }

  @Test fun aDebugBuildLogsAtBasicAtMost() {
    val l = loggers(Http.client(CookieJar.NO_COOKIES, debug = true))
    assertEquals(1, l.size)
    assertTrue("level ${l.single().level} prints headers", l.single().level <= HttpLoggingInterceptor.Level.BASIC)
  }

  @Test fun theBuildTypeDecides() {
    // The default is BuildConfig.DEBUG, so the debug unit tests see a logger
    // and a release build, whose DEBUG is false, sees none.
    assertEquals(dev.merrymen.app.BuildConfig.DEBUG, loggers(Http.client(CookieJar.NO_COOKIES)).isNotEmpty())
  }

  @Test fun whatItPrintsCarriesNoCookieEvenOneLevelUp() {
    val lines = mutableListOf<String>()
    val log = debugCallLog { lines += it }
    val client = OkHttpClient.Builder().addInterceptor(log).build()
    fun roundTrip() {
      server.enqueue(MockResponse().setHeader("Set-Cookie", "mm_session=SERVERSECRET; Path=/").setBody("{}"))
      client.newCall(Request.Builder().url(server.url("/api/feed")).header("Cookie", "mm_session=OWNERSECRET").build())
        .execute().close()
    }
    roundTrip()
    assertTrue("the request line is logged", lines.any { it.contains("/api/feed") })
    assertFalse(lines.any { it.contains("SECRET") })
    // Raised by accident, it still cannot print one: both headers are redacted.
    log.level = HttpLoggingInterceptor.Level.HEADERS
    lines.clear()
    roundTrip()
    assertTrue("headers are printed at this level", lines.any { it.contains("Cookie") })
    assertFalse(lines.any { it.contains("SECRET") })
  }
}
