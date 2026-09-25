package dev.merrymen.app.net

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.io.File

/**
 * WHAT PRODUCTION ACTUALLY SAID, kept as files.
 *
 * Captured 2026-09-24 from app.merrymen.dev with read-only, signed-out GETs, so
 * they carry no session and nobody's private book. A model that cannot decode
 * one of these cannot decode the server this app ships against, and that is a
 * crash or a blank screen on a real phone; a test over the file finds it first.
 *
 * Named by the route they came from (`probe-theses.json` is GET /api/theses).
 * To add one, drop it in src/test/resources/fixtures/ and give it an entry in
 * DecodeFixturesTest, which refuses a fixture nobody decodes.
 */
object Fixtures {
  fun text(name: String): String =
    Fixtures::class.java.getResource("/fixtures/$name")?.readText()
      ?: error("no fixture named $name under src/test/resources/fixtures")

  /** Every fixture file present, by name. */
  fun names(): List<String> {
    val dir = Fixtures::class.java.getResource("/fixtures") ?: error("no fixtures directory on the test classpath")
    return File(dir.toURI()).listFiles().orEmpty().map { it.name }.filter { it.endsWith(".json") }.sorted()
  }
}

/**
 * THE REAL CLIENT, pointed at a MockWebServer.
 *
 * Built the way AppContainer builds it, minus the two Android-only pieces: the
 * DataStore cookie jar and the header interceptor (which reads BuildConfig).
 * Everything this module decides — the three-state result, the refusal
 * wording, decoding — is the production code path. A plain OkHttpClient
 * retries on its own, but a write still goes out once: MerrymenApi puts every
 * non-GET on writeHttp whatever client it was given (WriteOnceTest). To test
 * the app's client itself, build Http.client(jar, debug = false).
 */
fun apiFor(server: MockWebServer, http: OkHttpClient = OkHttpClient()): MerrymenApi =
  MerrymenApi(http, OriginSource { server.url("/").toString().removeSuffix("/") })

/** Queue one answer: a body, a status, and a content type (JSON unless said). */
fun MockWebServer.answer(body: String, code: Int = 200, type: String = "application/json") {
  enqueue(MockResponse().setResponseCode(code).setHeader("content-type", type).setBody(body))
}

/** A Next.js-style HTML page, the body a 404 or a proxy error really arrives with. */
const val HTML_PAGE = "<!DOCTYPE html><html><head><title>404: This page could not be found.</title></head>" +
  "<body><div id=\"__next\"><h1>404</h1><h2>This page could not be found.</h2></div></body></html>"

/**
 * "http://localhost:<port>": the address a MockWebServer answers on, in the
 * one form [checkOrigin] accepts for a plain-http server (localhost, as the
 * network security config allows). server.url() may name the loopback by
 * another hostname, which the check would rightly refuse.
 */
fun MockWebServer.origin(): String = "http://localhost:$port"

/**
 * THE DEVICE'S STORED SESSION, in fields: what [Session] keeps in DataStore,
 * for a JVM test that drives the real Repository and the real cookie jar.
 * [fallbackOrigin] plays the build's default origin: what a blank Server field
 * restores, and the only host the jar places an older build's blob on when the
 * stored address is not a web address.
 */
class MemoryStore(
  initial: String,
  override val fallbackOrigin: String = "https://app.merrymen.dev",
) : SessionStore, CookieBlob {
  val originState = MutableStateFlow(initial)
  override val origin: Flow<String> = originState

  /** The retired site password, as a 0.1.0 install left it. Null once dropped. */
  var gatePassword: String? = null
  /** Whether a start has already expired mm_gate in the WebView's store. */
  var webViewGateExpired = false
  /** The jar's blob, exactly as the jar wrote it. */
  var cookieBlob: String? = null
  var sessionsCleared = 0

  override suspend fun originNow(): String = originState.value
  override suspend fun setOrigin(checked: OriginCheck.Ok) {
    originState.value = checked.origin
  }
  override suspend fun dropRetiredGatePassword() {
    gatePassword = null
  }
  override suspend fun webViewGateExpired(): Boolean = webViewGateExpired
  override suspend fun markWebViewGateExpired() {
    webViewGateExpired = true
  }
  override suspend fun clearSession() {
    sessionsCleared++
    cookieBlob = null
  }
  override suspend fun cookiesRaw(): String? = cookieBlob
  override suspend fun setCookiesRaw(value: String) {
    cookieBlob = value
  }
}

/**
 * THE TWO COOKIE STORES, with the WebView's as a map of name to value.
 *
 * The jar is the real one. The WebView side stands in for CookieManager, and
 * the hand-back goes through the real [WebAuth.webCookies], so what a harvest
 * copies — and what it refuses to — is the production rule.
 */
class MemoryCookies(val jar: PersistentCookieJar) : CookieStores {
  val web = linkedMapOf<String, String>()

  /** How many times the WebView's store was opened to expire a cookie — the cost a cold start must not pay twice. */
  var webExpiries = 0

  /** Set to make the WebView's store refuse, as a missing or mid-update WebView does. */
  var webRefuses = false

  override suspend fun harvest(origin: String) {
    val url = origin.toHttpUrlOrNull() ?: return
    val raw = web.entries.joinToString("; ") { "${it.key}=${it.value}" }
    jar.saveFromResponse(url, WebAuth.webCookies(raw, url))
  }

  override suspend fun dropFromJar(name: String) {
    jar.drop(name)
  }

  override suspend fun expireInWebView(origin: String, name: String): Boolean {
    webExpiries++
    if (webRefuses || origin.toHttpUrlOrNull() == null) return false
    web.remove(name)
    return true
  }

  override suspend fun forgetAll() {
    jar.clear()
    web.clear()
  }
}
