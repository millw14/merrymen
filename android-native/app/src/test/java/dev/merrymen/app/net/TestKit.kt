package dev.merrymen.app.net

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
 * wording, decoding — is the production code path.
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
