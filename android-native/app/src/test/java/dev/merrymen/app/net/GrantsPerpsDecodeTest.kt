package dev.merrymen.app.net

import dev.merrymen.app.ui.PerpsCustody
import dev.merrymen.app.ui.PerpsState
import dev.merrymen.app.ui.perpsStatusOf
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * `perps` ON GET /api/grants, THROUGH THE REAL CLIENT (docs/perps.md, Surfaces
 * → Mobile).
 *
 * The three answers the key can give — absent, null, a report — must reach
 * the screens as three answers. The app's Json is lenient and ignores unknown
 * keys, which is how a new field usually turns into silence; here it would
 * turn "Lighter could not be read" into "No positions reported yet". A report
 * with a field the strict parser refuses must still decode the answer (the
 * rest of the status is fine) and read as unread.
 */
class GrantsPerpsDecodeTest {
  private lateinit var server: MockWebServer
  private lateinit var api: MerrymenApi

  @Before fun start() {
    server = MockWebServer()
    server.start()
    api = apiFor(server)
  }

  @After fun stop() = server.shutdown()

  private fun ok(r: ApiResult<GrantView>): GrantView = when (r) {
    is ApiResult.Ok -> r.value
    else -> { fail("expected Ok, got $r"); error("unreachable") }
  }

  private val grant = """"grant":{"smartAccount":"0x1111111111111111111111111111111111111111","grantFeatures":["perp-lighter-v1"]}"""
  private val now = 1_790_290_000_000L + 60_000L

  @Test fun anAbsentKeyIsNotSentAndSaysNothingIsHeld() = runBlocking {
    server.answer("""{"exists":true,"mode":"live",$grant}""")
    val g = ok(api.grants())
    assertTrue(g.perps === GRANTS_PERPS_NOT_SENT)
    assertEquals(PerpsState.None, perpsStatusOf(g, now).state)
  }

  @Test fun aNullReportForAPerpsGrantIsUnread() = runBlocking {
    server.answer("""{"exists":true,"mode":"live",$grant,"perps":null}""")
    val g = ok(api.grants())
    assertTrue("null, never the not-sent marker", g.perps == null || g.perps is JsonNull)
    val s = perpsStatusOf(g, now)
    assertEquals(PerpsState.Unread(paper = false, recorded = 0, incident = false), s.state)
    assertEquals(PerpsCustody.Unread, s.custody)
  }

  @Test fun aReportDecodesIntoTheBanner() = runBlocking {
    server.answer(
      """{"exists":true,"mode":"live",$grant,"perps":{"v":1,"mode":"live","blocker":null,"venueReadAt":1790290000000,""" +
        """"protectAt":null,"accountIndex":22149,"positions":[{"market":"BTC-PERP","side":"short","baseAmount":"0.001",""" +
        """"entryPrice":"65000","markPrice":"64000","leverage":2,"marginMicro":"32500000","liqPrice":"97000","unrealizedMicro":"1000000",""" +
        """"stopTrigger":"68250","fundingMicro":null}],"openNotionalMicro":"65000000","collateralMicro":"32500000","inTransitMicro":"0",""" +
        """"minLiqDistanceBps":5156.25,"stopsMissing":0,"incident":false,"someFutureKey":true}}""",
    )
    val g = ok(api.grants())
    assertTrue(g.perps is JsonObject)
    val k = (perpsStatusOf(g, now).state as PerpsState.Known).k
    assertEquals(1, k.count)
    assertEquals("short", k.positions.single().side)
  }

  @Test fun aMalformedReportLeavesTheStatusReadableAndReadsAsUnread() = runBlocking {
    server.answer("""{"exists":true,"mode":"live",$grant,"balances":{"cashUsdg":"5000000"},"perps":{"v":1,"mode":"live","positions":"none"}}""")
    val g = ok(api.grants())
    assertEquals("5000000", g.balances?.cashUsdg)
    assertEquals(PerpsState.Unread(paper = false, recorded = 0, incident = false), perpsStatusOf(g, now).state)
  }
}
