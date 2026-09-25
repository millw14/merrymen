package dev.merrymen.app.net

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A SERVER ADDRESS THAT IS NOT ONE IS REFUSED WHEN TYPED, AND HARMLESS WHEN STORED.
 *
 * "app.merrymen.dev" with no scheme used to be saved as typed. OkHttp threw on
 * it from outside anything that caught, so the Save crashed the app, and so did
 * every launch after it, until the owner cleared the app's data.
 */
class ServerOriginTest {
  private val fallback = "https://app.merrymen.dev"

  private fun refused(raw: String): String {
    val r = checkOrigin(raw, fallback)
    assertTrue("expected $raw to be refused, got $r", r is OriginCheck.Refused)
    return (r as OriginCheck.Refused).why
  }

  private fun ok(raw: String): String {
    val r = checkOrigin(raw, fallback)
    assertTrue("expected $raw to be accepted, got $r", r is OriginCheck.Ok)
    return (r as OriginCheck.Ok).origin
  }

  // ── what the Server field accepts ─────────────────────────────────────────

  @Test fun anAddressWithNoSchemeIsRefusedWithWhatToAdd() {
    assertTrue(refused("app.merrymen.dev").contains("https://"))
  }

  @Test fun junkIsRefused() {
    refused("https://app.merrymen.dev x")
    refused("ftp://app.merrymen.dev")
    refused("https://")
  }

  @Test fun plainHttpOnlyForThisDeviceOrTheEmulatorsHost() {
    // The session cookie would travel in the clear, and the network security
    // config refuses it anyway; better said here than as an opaque failure.
    assertTrue(refused("http://app.merrymen.dev").contains("https://"))
    refused("http://127.0.0.1:3000")
    assertEquals("http://10.0.2.2:3100", ok("http://10.0.2.2:3100"))
    assertEquals("http://localhost:3000", ok("http://localhost:3000/"))
  }

  @Test fun nothingThatWouldSwallowAPath() {
    refused("https://app.merrymen.dev/?x=1")
    refused("https://app.merrymen.dev/#top")
    refused("https://owner:secret@app.merrymen.dev")
  }

  @Test fun aPageIsNotAServer() {
    // The web's sign-in page is the likeliest paste. Stored, every read asked
    // /home/api/… and every screen said "HTTP 404" with nothing pointing here.
    assertTrue(refused("https://app.merrymen.dev/home").contains("/home"))
    refused("https://app.merrymen.dev/sub/")
    refused("http://10.0.2.2:3100/api")
    refused("https://app.merrymen.dev/ path")
    // A trailing slash is not a page.
    assertEquals("https://app.merrymen.dev", ok("https://app.merrymen.dev//"))
  }

  @Test fun storedTheWayTheParserReadsIt() {
    assertEquals("https://app.merrymen.dev", ok("  HTTPS://App.Merrymen.dev/  "))
    assertEquals("https://app.merrymen.dev", ok("https://app.merrymen.dev:443"))
  }

  @Test fun blankRestoresTheDefault() {
    assertEquals(fallback, ok("   "))
  }

  // ── what counts as another server ─────────────────────────────────────────

  @Test fun anotherServerIsSchemeHostOrPort() {
    assertFalse(isOtherServer("https://app.merrymen.dev", "https://APP.merrymen.dev/"))
    assertTrue(isOtherServer("https://app.merrymen.dev", "https://staging.merrymen.dev"))
    assertTrue(isOtherServer("http://localhost:3000", "http://localhost:3001"))
    assertTrue(isOtherServer("http://localhost:3000", "https://localhost:3000"))
    // Nothing can be said about an address that does not parse.
    assertTrue(isOtherServer("app.merrymen.dev", "https://app.merrymen.dev"))
  }

  // ── an address an older build already stored ─────────────────────────────

  @Test fun aStoredPageIsReadAsTheServerItNames() {
    // An older build saved the field as typed; none of these came through
    // checkOrigin.
    assertEquals("https://app.merrymen.dev", serverOf("https://app.merrymen.dev/home"))
    assertEquals("http://10.0.2.2:3100", serverOf("http://10.0.2.2:3100/sub/"))
    assertEquals("https://app.merrymen.dev", serverOf("https://owner:pw@App.merrymen.dev:443/home?x=1#top"))
    // Not a web address at all: left as it is, so a call still says so.
    assertEquals("app.merrymen.dev", serverOf("app.merrymen.dev"))
    // Whatever the Server field saves is already its own server.
    for (typed in listOf("https://app.merrymen.dev/", "http://localhost:3000", "http://10.0.2.2:3100", "https://h.example:8443")) {
      val stored = ok(typed)
      assertEquals(stored, serverOf(stored))
    }
  }

  @Test fun aStoredPageIsNotPutInFrontOfEveryRoute() = runBlocking {
    // Like the real server: every route at the root, and a Next 404 page for
    // anything else, which is what /home/api/… got.
    val server = MockWebServer()
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse =
        if (request.path.orEmpty().startsWith("/api/")) {
          MockResponse().setHeader("content-type", "application/json").setBody("""{"version":"0.21.0"}""")
        } else {
          MockResponse().setResponseCode(404).setHeader("content-type", "text/html").setBody(HTML_PAGE)
        }
    }
    server.start()
    try {
      val api = MerrymenApi(OkHttpClient(), OriginSource { server.origin() + "/home" })
      assertTrue("a read", api.version() is ApiResult.Ok)
      assertTrue("a write, as a route outside MerrymenApi.kt sends one", api.callAt("/api/settings") { put("{}".toRequestBody()) } is ApiResult.Ok)
      assertEquals("what a web URL beside them is built from", server.origin(), api.originNow())
      assertEquals(listOf("/api/version", "/api/settings"), List(2) { server.takeRequest().path })
    } finally {
      server.shutdown()
    }
  }

  @Test fun aStoredAddressThatIsNotOneIsUnreachableNeverAThrow() = runBlocking {
    for (bad in listOf("app.merrymen.dev", "https://app.merrymen.dev x", "")) {
      val api = MerrymenApi(OkHttpClient(), OriginSource { bad })
      // A read, a write and a route added from outside MerrymenApi.kt: every
      // path to the network is guarded, and nothing was sent.
      assertEquals(ApiResult.Unreachable(NOT_A_WEB_ADDRESS), api.version())
      assertEquals(ApiResult.Unreachable(NOT_A_WEB_ADDRESS), api.order("buy", "NVDA", 1.0))
      assertEquals(ApiResult.Unreachable(NOT_A_WEB_ADDRESS), api.callAt("/api/orders/ceiling") { get() })
    }
  }
}
