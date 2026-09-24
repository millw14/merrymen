package dev.merrymen.app.net

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
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
