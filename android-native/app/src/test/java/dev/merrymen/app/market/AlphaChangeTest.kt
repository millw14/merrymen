package dev.merrymen.app.market

import dev.merrymen.app.net.Fixtures
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE ALPHA DESK PRINTS A DAY'S CHANGE ONLY FOR A POOL A DAY OLD, as Markets
 * does. The rows are the captured sweep's, read as the desk reads its rows —
 * JSON objects, `change24hPct` and `ageDays` by name.
 */
class AlphaChangeTest {
  private val rows: Map<String, JsonObject> =
    Json.parseToJsonElement(Fixtures.text("probe-discoveries.json")).jsonObject["rows"]!!.jsonArray
      .map { it.jsonObject }
      .associateBy { it["name"]!!.jsonPrimitive.content }

  private fun JsonObject.num(k: String) = this[k]?.jsonPrimitive?.doubleOrNull

  private fun changeOf(name: String) = rows.getValue(name).let { alphaChange(it.num("change24hPct"), it.num("ageDays")) }

  @Test fun anHoursOldPoolSaysNewPoolNotItsChangeSinceLaunch() {
    // FOOMS: 0.18 days old, +1,647.6% in the index.
    val fooms = changeOf("FOOMS / WETH")
    assertEquals(AlphaChange("new pool", null), fooms)
    assertEquals("new pool", changeOf("CARDS / WETH").text)
  }

  @Test fun aPoolADayOldShowsItsDay() {
    // QUANTA: 1.15 days old.
    assertEquals(AlphaChange("+3824.3%", true), changeOf("QUANTA / WETH"))
    assertEquals(AlphaChange("-2.5%", false), alphaChange(-2.5, 3.0))
  }

  @Test fun anUnknownAgeIsNotAssumedOldEnough() {
    assertEquals(AlphaChange("—", null), alphaChange(18062.8, null))
    assertEquals(AlphaChange("—", null), alphaChange(null, 4.0))
    assertNull(alphaChange(Double.NaN, 4.0).up)
  }

  @Test fun theVolumeOfAnHoursOldPoolSaysHowOld() {
    val young = alphaVolumeLabel(rows.getValue("FOOMS / WETH").num("ageDays"))
    assertTrue(young, young.startsWith("24h · pool ") && young.endsWith(" old"))
    assertEquals("24h", alphaVolumeLabel(rows.getValue("QUANTA / WETH").num("ageDays")))
    assertEquals("24h", alphaVolumeLabel(null))
  }
}
