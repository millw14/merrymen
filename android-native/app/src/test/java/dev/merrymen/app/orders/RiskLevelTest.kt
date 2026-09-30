package dev.merrymen.app.orders

import dev.merrymen.app.ui.RISK_PROFILES
import dev.merrymen.app.ui.riskLevelOf
import dev.merrymen.app.ui.riskSettings
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * "HOW MUCH RISK?" OPENS ON THE OWNER'S RUNG — and the rungs are core's.
 *
 * riskLevelOf is core's levelOf as the web's panel calls it: the saved values,
 * all six matching. A hand-tuned book matches nothing and must not be rounded
 * to a rung. The table itself is a copy of packages/core/src/risk-level.ts,
 * held to the file when the repository is beside the app.
 */
class RiskLevelTest {
  @Test fun everyRungIsRecognisedFromItsOwnSixDials() {
    for (p in RISK_PROFILES) assertEquals(p.level, riskLevelOf(riskSettings(p.level)))
  }

  @Test fun oneDialOffIsHandTunedNotTheNearestRung() {
    val careful = riskSettings("careful")
    val nudged = JsonObject(careful + ("slippageBps" to JsonPrimitive(51)))
    assertNull(riskLevelOf(nudged))
    assertNull("nothing saved is not a rung", riskLevelOf(JsonObject(emptyMap())))
    assertNull(riskLevelOf(null))
  }

  @Test fun numbersSavedAsTextStillMatchAsTheWebsNumberDoes() {
    val asText = JsonObject(riskSettings("bold").mapValues { JsonPrimitive(it.value.toString()) })
    assertEquals("bold", riskLevelOf(asText))
  }

  @Test fun theTableIsCores() {
    val f = File("../../packages/core/src/risk-level.ts")
    assumeTrue("packages/core is not beside this checkout", f.isFile)
    val src = f.readText()
    val start = src.indexOf("export const RISK_PROFILES")
    assumeTrue(start >= 0)
    val body = src.substring(start, src.indexOf("});", start))
    for (p in RISK_PROFILES) {
      val at = body.indexOf("level: \"${p.level}\"")
      assertEquals("${p.level} is in core", true, at >= 0)
      val block = body.substring(at, body.indexOf("},\n  },", at).let { if (it < 0) body.length else it })
      fun field(name: String) = Regex("$name: (?:\"([^\"]*)\"|([0-9_]+))").find(block)!!.groupValues.let { g -> g[1].ifEmpty { g[2].replace("_", "") } }
      assertEquals(p.name, field("name"))
      assertEquals(p.blurb, field("blurb"))
      assertEquals(p.stopLossBps.toString(), field("strategistStopLossBps"))
      assertEquals(p.takeProfitBps.toString(), field("takeProfitBps"))
      assertEquals(p.buyPerTickUsdg.toString(), field("buyPerTickUsdg"))
      assertEquals(p.llmMaxActionUsdg.toString(), field("llmMaxActionUsdg"))
      assertEquals(p.slippageBps.toString(), field("slippageBps"))
      assertEquals(p.maxImpactBps.toString(), field("maxImpactBps"))
    }
    val levels = Regex("level: \"([a-z]+)\"").findAll(body).map { it.groupValues[1] }.toList()
    assertEquals("the same rungs in the same order", levels, RISK_PROFILES.map { it.level })
  }

  @Test fun theRiskWriteIsSixSettingsAndNeverTheLevel() {
    val body = Json.encodeToString(JsonObject.serializer(), riskSettings("balanced"))
    assertEquals(
      """{"strategistStopLossBps":2500,"takeProfitBps":2000,"buyPerTickUsdg":25,"llmMaxActionUsdg":50,"slippageBps":100,"maxImpactBps":300}""",
      body,
    )
  }
}
