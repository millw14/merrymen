package dev.merrymen.app.account

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Position
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.ui.positionLabel
import dev.merrymen.app.ui.positionLinesOf
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/** Feed decoding and the display row, without changing the ledger's identity or evidence. */
class PositionLabelTest {
  private val server = MockWebServer()
  private val address = "0x7eebda046d451bc7a7d12491eff72a861aa8136e"
  private val ledgerKey = "TA861AA8136E"

  @Before fun start() = server.start()
  @After fun stop() = server.shutdown()

  private suspend fun read(row: String): Position {
    server.answer("""{"source":"sqlite","positions":[$row]}""")
    return (apiFor(server).feed() as ApiResult.Ok).value.positions.single()
  }

  @Test fun aSavedTickerDoesNotAlterTheLedgerKeyOrVouchForCost() = runBlocking {
    val position = read("""{"symbol":"$ledgerKey","token":"$address","display_symbol":"SWARM","value_usdg":12,"cost_usdg":10,"cost_from_quote":true,"stop_floor_bps":800,"stop_floor_why":"protected"}""")
    val row = positionLinesOf(listOf(position)).single()
    assertEquals("\$SWARM", row.label)
    assertEquals(ledgerKey, position.symbol)
    assertEquals(ledgerKey, row.symbol)
    assertEquals(address, position.token)
    assertEquals("\$12.00 · cost unconfirmed", row.detail)
    assertNull(row.pnlPct)
    assertEquals(800, position.stopFloorBps)
    assertEquals("protected", position.stopFloorWhy)
  }

  @Test fun anAbsentLabelKeepsLegacyTickersButExplicitNullDoesNot() = runBlocking {
    val legacy = read("""{"symbol":"ETH"}""")
    assertEquals("ETH", legacy.displaySymbol)
    assertEquals("\$ETH", positionLabel(legacy))

    val missing = read("""{"symbol":"ETH","display_symbol":null,"token":"$address"}""")
    assertNull(missing.displaySymbol)
    assertEquals("0x7eeb…136e", positionLabel(missing))
    assertEquals("Unknown token", positionLabel(read("""{"symbol":"ETH","display_symbol":null}""")))
    assertEquals("Unknown token", positionLabel(read("""{"symbol":"$ledgerKey"}""")))
  }

  @Test fun unsafeOrGeneratedLabelsFallBackToTheFullAddressIdentity() = runBlocking {
    for (label in listOf(null, "", ledgerKey, ledgerKey.lowercase(), address, "<script>", "line\nbreak", "A".repeat(33))) {
      val position = read(buildJsonObject {
        put("symbol", "SWARM")
        put("token", address)
        put("display_symbol", label?.let(::JsonPrimitive) ?: JsonNull)
      }.toString())
      assertEquals("0x7eeb…136e", positionLabel(position))
    }
    for (badAddress in listOf("0x1234", "javascript:alert(1)", address + "extra")) {
      assertEquals("Unknown token", positionLabel(Position(symbol = ledgerKey, token = badAddress, displaySymbol = null)))
    }
  }

  @Test fun cashtagsPreserveTickerCaseAndNeverChangeReturnGates() {
    val position = Position(symbol = ledgerKey, token = address, displaySymbol = "  \$\$Index  ", valueUsdg = 12.0, costUsdg = 10.0, costFromQuote = false)
    val row = positionLinesOf(listOf(position)).single()
    assertEquals("\$Index", row.label)
    assertEquals(20.0, row.pnlPct!!, 1e-9)
    assertEquals("\$12.00", row.detail)
    val stale = positionLinesOf(listOf(position.copy(priceStaleRaw = 1))).single()
    assertEquals("\$Index", stale.label)
    assertNull(stale.pnlPct)
    assertEquals("\$12.00 · last mark", stale.detail)
  }
}
