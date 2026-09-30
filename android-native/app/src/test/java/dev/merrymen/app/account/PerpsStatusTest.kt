package dev.merrymen.app.account

import dev.merrymen.app.net.GRANTS_PERPS_NOT_SENT
import dev.merrymen.app.net.GrantView
import dev.merrymen.app.net.PERP_BLOCKERS
import dev.merrymen.app.net.perpsReportOf
import dev.merrymen.app.ui.PERPS_INCIDENT_LINE
import dev.merrymen.app.ui.PERPS_NO_CLOSE_LINE
import dev.merrymen.app.ui.PERPS_RECOVER
import dev.merrymen.app.ui.PERPS_UNREAD_CUSTODY
import dev.merrymen.app.ui.PerpsCustody
import dev.merrymen.app.ui.PerpsState
import dev.merrymen.app.ui.PerpsStatus
import dev.merrymen.app.ui.perpsAtLighterOf
import dev.merrymen.app.ui.perpsAtLighterRowOf
import dev.merrymen.app.ui.perpsBannerOf
import dev.merrymen.app.ui.perpsCustodyOfStopAnswer
import dev.merrymen.app.ui.perpsEmptyPositions
import dev.merrymen.app.ui.perpsKillWarning
import dev.merrymen.app.ui.perpsPositionRows
import dev.merrymen.app.ui.perpsPositionsHeading
import dev.merrymen.app.ui.perpsStatusOf
import dev.merrymen.app.ui.perpsStopCustody
import java.io.File
import java.math.BigInteger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * THE PHONE'S HONESTY MINIMUM FOR PERPETUALS (docs/perps.md, Surfaces →
 * Mobile), rule by rule: never "No positions" over leverage or an unread
 * venue, a banner in every state but none, and kill words that never say the
 * funds are home while anything may be on Lighter. The iOS twin runs the same
 * cases (ios-native/Policy PerpsStatusTests).
 */
class PerpsStatusTest {
  private fun json(s: String): JsonElement = Json.parseToJsonElement(s)

  /** Five minutes after the fixtures' venue read. */
  private val now = 1_790_290_000_000L + 5 * 60_000L

  private val perpsGrant = json(
    """{"smartAccount":"0x1111111111111111111111111111111111111111","grantFeatures":["perp-lighter-v1"],""" +
      """"perp":{"route":"perp-lighter-v1","apiKeyIndex":16,"apiPublicKey":"0x01"}}""",
  )
  private val plainGrant = json("""{"smartAccount":"0x1111111111111111111111111111111111111111","grantFeatures":[]}""")

  /** A GET /api/grants answer: [perps] null is the literal JSON null, absent is [GRANTS_PERPS_NOT_SENT]. */
  private fun grants(perps: JsonElement?, mode: String = "live", perpsOn: Boolean = true) =
    GrantView(exists = true, mode = mode, grant = if (perpsOn) perpsGrant else plainGrant, perps = perps)

  private fun read(perps: String?, mode: String = "live", perpsOn: Boolean = true): PerpsStatus =
    perpsStatusOf(grants(perps?.let(::json) ?: GRANTS_PERPS_NOT_SENT, mode, perpsOn), now)

  private val btc = """{"market":"BTC-PERP","side":"long","baseAmount":"0.00020","entryPrice":"65000.0","markPrice":"66000.0",""" +
    """"leverage":3,"marginMicro":"4333333","liqPrice":"44000.0","unrealizedMicro":"200000","stopTrigger":"61750.0","fundingMicro":"-1200"}"""

  private fun report(
    mode: String = "live",
    positions: List<String> = emptyList(),
    notional: String? = "0",
    collateral: String? = "0",
    transit: String? = "0",
    minLiq: String = "null",
    stopsMissing: Int = 0,
    incident: Boolean = false,
    blocker: String = "null",
    accountIndex: String = "22149",
  ): String {
    fun q(s: String?) = s?.let { "\"$it\"" } ?: "null"
    return """{"v":1,"mode":"$mode","blocker":$blocker,"venueReadAt":1790290000000,"protectAt":null,"accountIndex":$accountIndex,""" +
      """"positions":[${positions.joinToString(",")}],"openNotionalMicro":${q(notional)},"collateralMicro":${q(collateral)},""" +
      """"inTransitMicro":${q(transit)},"minLiqDistanceBps":$minLiq,"stopsMissing":$stopsMissing,"incident":$incident}"""
  }

  private val unreadLive = PerpsStatus(PerpsState.Unread(paper = false, recorded = 0, incident = false), PerpsCustody.Unread)

  // ── the state ──────────────────────────────────────────────────────────

  @Test fun realVenueIndexNeverBecomesPracticeWhenTheAccountSwitchesToPaper() {
    for (mode in listOf("off", "refuse")) {
      val s = read(report(mode = mode, positions = listOf(btc), notional = "13000000"), mode = "paper")
      assertEquals(false, perpsBannerOf(s)?.paper)
      assertTrue(perpsAtLighterRowOf(s) != null)
    }
  }

  @Test fun removedGrantKeepsShutdownCustodyVisible() {
    val s = perpsStatusOf(GrantView(exists = false, perpsShutdown = json("""{"state":"expired","result":{"outcome":"unreachable"}}""")), now)
    assertEquals(PerpsCustody.Unread, s.custody)
    assertTrue(perpsBannerOf(s) != null)
    assertTrue(perpsEmptyPositions(s).contains("leveraged positions"))
  }

  @Test fun absentIsNoneAndNullIsUnreadOnlyWhereThePermissionAllowsLeverage() {
    assertEquals("a server from before the report", PerpsState.None, read(null).state)
    assertEquals(unreadLive, perpsStatusOf(grants(null), now))
    assertEquals(unreadLive, perpsStatusOf(grants(JsonNull), now))
    assertEquals("no permission: the wall never let it post margin", PerpsStatus.NONE, perpsStatusOf(grants(null, perpsOn = false), now))
    assertEquals(PerpsStatus.NONE, perpsStatusOf(GrantView(exists = false), now))
  }

  @Test fun anythingTheStrictParserRefusesIsUnreadNeverNone() {
    for (bad in listOf(
      "\"yes\"", "[]", """{"v":2}""", report(mode = "maybe"), report(blocker = "\"new-blocker\""),
      report(positions = listOf(btc.replace("\"long\"", "\"sell\"")), notional = "1"),
      report(positions = listOf(btc.replace("\"4333333\"", "4333333")), notional = "1"),
      report(notional = "1.5"),
      report().replace("\"incident\":false", "\"incident\":\"false\""),
      report().replace("\"stopsMissing\":0", "\"stopsMissing\":\"0\""),
    )) {
      assertNull(bad, perpsReportOf(json(bad)))
      assertEquals(bad, unreadLive, read(bad))
      // Said and unreadable is unread even where the grant has no perps.
      assertEquals(bad, PerpsCustody.Unread, read(bad, perpsOn = false).custody)
    }
  }

  @Test fun aFlatReportIsNoneAndSaysNoPositions() {
    val s = read(report())
    assertEquals(PerpsState.None, s.state)
    assertNull(perpsBannerOf(s))
    assertNull(perpsAtLighterOf(s))
    assertEquals("No positions reported yet.", perpsEmptyPositions(s))
    assertEquals("Positions", perpsPositionsHeading(s))
    // Known and empty still names a venue account: a kill says the other
    // accounts under it were not read, never that the funds are all home.
    assertEquals(PerpsCustody.Known(0, BigInteger.ZERO), s.custody)
    assertEquals(PerpsStatus.NONE, read(report(accountIndex = "null")))
  }

  @Test fun aStatusNotReadYetRulesNothingOut() {
    assertFalse(perpsEmptyPositions(null).startsWith("No positions"))
    assertEquals("Spot positions", perpsPositionsHeading(null))
    assertNull(perpsKillWarning(null))
  }

  @Test fun missingVenueFiguresAreUnreadWithTheLedgersOwnCount() {
    // The worker's report for a venue it could not read (view.ts): the
    // ledger's positions, every venue figure null.
    val s = read(report(positions = listOf(btc), notional = null, collateral = null, transit = null, stopsMissing = 1))
    assertEquals(PerpsStatus(PerpsState.Unread(paper = false, recorded = 1, incident = false), PerpsCustody.Unread), s)
    val b = perpsBannerOf(s)!!
    assertEquals("Lighter could not be read — you may have open leveraged positions", b.headline)
    assertTrue(b.alarm)
    assertTrue(b.lines.contains("The agent's own records list 1 position."))
    assertEquals("couldn't read", perpsAtLighterRowOf(s))
    assertFalse(perpsEmptyPositions(s).startsWith("No positions"))
  }

  // ── the banner ─────────────────────────────────────────────────────────

  @Test fun heldPositionsNameCountNotionalAndLiquidationRoundedTowardIt() {
    val eth = btc.replace("BTC", "ETH")
    val s = read(report(positions = listOf(btc, eth), notional = "25000001", collateral = "8666666", minLiq = "1239.9"))
    val b = perpsBannerOf(s)!!
    assertEquals("Leveraged positions on Lighter: 2, \$25.01 notional, nearest liquidation 12.3% away", b.headline)
    assertFalse(b.alarm)
    assertFalse(b.paper)
    assertEquals("BTC-PERP · Long · 3x · liquidation 44000.0", perpsPositionRows(s).first())
    assertEquals("No spot positions reported yet. Its leveraged positions are shown above.", perpsEmptyPositions(s))
    assertEquals("Spot positions", perpsPositionsHeading(s))
    // C + T + ΣU: 8.666666 + 0 + 0.2 + 0.2, up to the cent.
    assertEquals("At Lighter" to "\$9.07", perpsAtLighterOf(s))
    assertEquals("\$9.07", perpsAtLighterRowOf(s))
  }

  @Test fun anUnreadLiquidationOrPnlIsSaidNotGuessed() {
    // Its stop was not seen resting, so the report leaves the trigger out and
    // counts it in stopsMissing (worker view.ts).
    val noPnl = btc.replace("\"unrealizedMicro\":\"200000\"", "\"unrealizedMicro\":null")
      .replace("\"stopTrigger\":\"61750.0\"", "\"stopTrigger\":null")
    val s = read(report(positions = listOf(noPnl), notional = "13000000", collateral = "4333333", stopsMissing = 1))
    val b = perpsBannerOf(s)!!
    assertEquals("Leveraged positions on Lighter: 1, \$13.00 notional, nearest liquidation not read", b.headline)
    assertEquals(listOf("1 position has no stop seen resting at Lighter.", PERPS_NO_CLOSE_LINE), b.lines)
    assertEquals("\$4.34 posted, P&L not read", perpsAtLighterRowOf(s))
  }

  @Test fun aPositionTheReportCouldNotListStillRaisesTheBanner() {
    val b = perpsBannerOf(read(report(stopsMissing = 1, incident = true)))!!
    assertEquals("Leveraged positions on Lighter: 1, \$0.00 notional, nearest liquidation not read", b.headline)
    assertTrue(b.alarm)
    assertTrue(b.lines.contains("1 position could not be listed here and is not in that notional."))
    assertTrue(b.lines.contains(PERPS_INCIDENT_LINE))
    // One listed with its stop seen resting, one foreign the report could not render: two, not one.
    val mixed = perpsBannerOf(read(report(positions = listOf(btc), notional = "13000000", collateral = "1", stopsMissing = 1, incident = true)))!!
    assertTrue(mixed.headline.startsWith("Leveraged positions on Lighter: 2, \$13.00 notional"))
  }

  @Test fun moneyLeftOnLighterWithNothingOpenIsStillABanner() {
    val s = read(report(collateral = "5000000", transit = "1000000"))
    assertEquals("USDG on Lighter: \$6.00, no leveraged position open", perpsBannerOf(s)!!.headline)
    assertEquals("No positions reported yet.", perpsEmptyPositions(s))
    assertEquals("\$6.00", perpsAtLighterRowOf(s))
  }

  @Test fun paperIsAlwaysLabelledPaper() {
    val paper = read(report(mode = "paper", positions = listOf(btc), notional = "13000000", collateral = "4333333", minLiq = "3000"), mode = "paper")
    val b = perpsBannerOf(paper)!!
    assertEquals("Paper leveraged positions: 1, \$13.00 notional, nearest liquidation 30.0% away", b.headline)
    assertTrue(b.paper)
    assertTrue(b.lines.contains("Practice book: no real money is traded in it."))
    assertEquals("Paper perps", perpsAtLighterOf(paper)?.first)
    assertNull("a practice figure is not a row under the real account", perpsAtLighterRowOf(paper))
    // With no real venue index, the off rail can retain a practice book.
    assertTrue(perpsBannerOf(read(report(mode = "off", positions = listOf(btc), notional = "1").replace("\"accountIndex\":22149", "\"accountIndex\":null"), mode = "paper"))!!.paper)
    // An off rail on a live account is real money until something says otherwise.
    assertFalse(perpsBannerOf(read(report(mode = "off", positions = listOf(btc), notional = "1"), mode = "live"))!!.paper)
  }

  // ── the kill ───────────────────────────────────────────────────────────

  @Test fun killWordsNeverSayTheFundsAreHomeWhileAnythingMayBeOnLighter() {
    assertNull(perpsKillWarning(PerpsStatus.NONE))
    assertNull(perpsStopCustody(PerpsStatus.NONE, null))

    // THE HOSTED SERVICE CLOSES NOTHING ON A KILL YET (no perpsStanddownOnKill):
    // the copy says so, and never "closed at market".
    val unread = perpsStatusOf(grants(null), now)
    assertFalse(unread.standsDownOnKill)
    assertEquals("Nothing at Lighter was closed. $PERPS_UNREAD_CUSTODY", perpsStopCustody(unread, null))
    assertTrue(perpsKillWarning(unread)!!.contains("Lighter could not be read, so any perpetual positions there stay open"))
    assertFalse(perpsKillWarning(unread)!!.contains("closed at market"))

    val held = read(report(positions = listOf(btc), notional = "13000000", collateral = "4333333", transit = "1000000"))
    assertEquals(PerpsCustody.Known(1, BigInteger.valueOf(5_333_333)), held.custody)
    assertEquals(
      "Nothing at Lighter was closed. As last read before the stop: Still on Lighter: 1 open position, 5.34 USDG of collateral. Other Lighter accounts under your smart account could not be read, " +
        "so whether they hold anything is unknown. Any stops resting at Lighter stay in place until those positions close. " +
        "To unwind it yourself with your owner key, open Withdraw on the web dashboard, which shows what is at Lighter, then run merrymen recover.",
      perpsStopCustody(held, null),
    )
    assertEquals(
      "Stopping the agent here does NOT close its perpetuals: this server cannot stand them down yet. Its open perpetual position on Lighter stays open, " +
        "protected only by the stops resting at Lighter — they expire after at most 28 days and nothing re-places them once the agent is stopped — " +
        "and collateral stays at Lighter. Before stopping, use Close or Close all on the desk to review an exit request; a close is only complete when the worker reports the remaining book.",
      perpsKillWarning(held),
    )
    // Only a server that says it stands perps down gets the promise of a close.
    val standing = perpsStatusOf(
      GrantView(exists = true, mode = "live", grant = perpsGrant, perps = json(report(positions = listOf(btc), notional = "13000000", collateral = "4333333", transit = "1000000")), perpsStanddownOnKill = true),
      now,
    )
    assertTrue(standing.standsDownOnKill)
    assertEquals(
      "Stopping the agent requests a stand-down: the worker attempts to close its open perpetual position on Lighter at market with " +
        "reduce-only orders, which can realize a loss, and requests withdrawal of free collateral to your smart account after Lighter's delay. A request can fail or leave a partial fill; check the shutdown result for what remains.",
      perpsKillWarning(standing),
    )
    // The DELETE answer's own sentence, built from the stand-down's result, wins.
    val answer = json("""{"ok":true,"custody":"Lighter reads empty."}""")
    assertEquals("Lighter reads empty.", perpsStopCustody(held, perpsCustodyOfStopAnswer(answer)))
    assertNull(perpsCustodyOfStopAnswer(json("""{"ok":true}""")))

    // A read too old to describe now is not repeated as fact.
    val old = perpsStatusOf(grants(json(report(positions = listOf(btc), notional = "1", collateral = "1"))), 1_790_290_000_000L + 16 * 60_000L)
    assertEquals(PerpsCustody.Unread, old.custody)
    assertTrue(perpsBannerOf(old)!!.alarm)
    assertTrue(perpsBannerOf(old)!!.lines.contains("Last read over 15 minutes ago, so this may not be current."))

    // A practice book says nothing about a real venue account: unread for a
    // perps grant, nothing to say for one without.
    val paperReport = report(mode = "paper", positions = listOf(btc), notional = "1")
    assertEquals(PerpsCustody.Unread, read(paperReport, mode = "paper").custody)
    val paperOnly = read(paperReport, mode = "paper", perpsOn = false)
    assertNull(perpsKillWarning(paperOnly))
    assertNull(perpsStopCustody(paperOnly, null))
  }

  // ── drift against core and the web ─────────────────────────────────────

  private fun sibling(path: String): String? = File("../../$path").takeIf { it.isFile }?.readText()

  @Test fun copiedWordsAndBlockersMatchCore() {
    val core = sibling("packages/core/src/perps.ts")
    assumeTrue("packages/core is not beside this checkout", core != null)
    val flat = core!!.replace(Regex("\"\\s*\\+\\s*`"), "")
    assertTrue(flat.contains(PERPS_UNREAD_CUSTODY.removeSuffix("$PERPS_RECOVER.")))
    assertTrue(core.contains(PERPS_INCIDENT_LINE))
    assertTrue(core.contains("Any stops resting at Lighter stay in place until those positions close."))
    assertTrue(core.contains("Other Lighter accounts under your smart account could not be read, so whether they hold anything is unknown."))
    assertTrue(flat.contains("To unwind it yourself with your owner key, \${recover}."))
    assertTrue(core.contains("GRANT_PERP_LIGHTER = \"perp-lighter-v1\""))
    val listed = core.substringAfter("PERP_BLOCKERS = Object.freeze([").substringBefore("] as const")
      .lines().mapNotNull { Regex("\"([a-z-]+)\"").find(it)?.groupValues?.get(1) }
    assertEquals(listed, PERP_BLOCKERS)
    // The web's port of the same report, where it is present: the kill warning
    // and the staleness rule are the same on every surface.
    sibling("web/src/lib/perps-view.ts")?.let { web ->
      assertTrue(web.contains("at market with reduce-only orders, which can realize a loss, "))
      assertTrue(web.contains("and requests withdrawal of free collateral to your smart account after Lighter's delay. A request can fail or leave a partial fill; check the shutdown result for what remains."))
      assertTrue(web.contains("any perpetual positions there (Lighter could not be read)"))
      assertTrue(web.contains("Stopping the agent here does NOT close its perpetuals: this server cannot stand them down yet."))
      assertTrue(web.contains("Lighter could not be read, so any perpetual positions there stay open"))
      assertTrue(web.contains("PERPS_REPORT_STALE_MS = 15 * 60_000"))
    }
  }
}
