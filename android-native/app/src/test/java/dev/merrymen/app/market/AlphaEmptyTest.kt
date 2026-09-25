package dev.merrymen.app.market

import dev.merrymen.app.net.AlphaView
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * "THE SCOUT COULD NOT RUN" IS NOT "NOTHING QUALIFIED".
 *
 * Each payload is served by a MockWebServer and read through the real client,
 * the way the screen reads it, so the decode of `verdictsWhy`, `researched`,
 * `truncated`, `degraded` and `tier` is part of what is tested.
 */
class AlphaEmptyTest {
  private lateinit var server: MockWebServer

  @Before fun start() {
    server = MockWebServer()
    server.start()
  }

  @After fun stop() = server.shutdown()

  private fun read(body: String): AlphaView = runBlocking {
    server.answer(body)
    when (val r = apiFor(server).alpha()) {
      is ApiResult.Ok -> r.value
      else -> { fail("expected Ok, got $r"); error("unreachable") }
    }
  }

  private fun open(
    verdictsWhy: String? = null,
    picks: String = "[]",
    researched: Boolean = true,
    truncated: Boolean = false,
    degraded: Boolean = false,
    indexUnreachable: Boolean = false,
    tier: String = """{"id":"merry-man","name":"Merry Man","emoji":"🏹"}""",
  ): String {
    val why = if (verdictsWhy == null) "null" else "\"$verdictsWhy\""
    return """{"locked":false,"tier":$tier,"fetchedAt":1790289976,"picks":$picks,"passed":[],""" +
      """"verdictsWhy":$why,"researched":$researched,"truncated":$truncated,"degraded":$degraded,""" +
      """"indexUnreachable":$indexUnreachable}"""
  }

  private val onePick = """[{"token":"0xd17c81cb01d44cc6e822936e8f098960001b47d2","name":"HOODCATS / WETH 0.25%",""" +
    """"priceUsd":0.0006,"change24hPct":206.8,"ageDays":5.8,"graduated":true,"onCurve":false,""" +
    """"verdict":{"conviction":3,"reason":"steady buyers"},"research":null}]"""

  @Test fun noModelSaysTheScoutCouldNotLookNotThatNothingQualified() {
    val copy = alphaEmptyCopy(read(open(verdictsWhy = "no-model")))!!
    assertTrue("our failure, drawn as a notice", copy.ours)
    assertEquals("Research has not run yet.", copy.title)
    assertTrue(copy.body.contains("no model configured"))
    assertTrue(copy.body.contains("not the same as nothing qualifying"))
    assertFalse(copy.title.contains("No picks"))
  }

  @Test fun modelFailedSaysTheScoutCouldNotLook() {
    val copy = alphaEmptyCopy(read(open(verdictsWhy = "model-failed")))!!
    assertTrue(copy.ours)
    assertEquals("Research is unavailable.", copy.title)
    assertTrue(copy.body.contains("failed this pass"))
    assertFalse(copy.title.contains("No picks"))
  }

  @Test fun aConsideredPassIsTheOnlyEmptyStateAboutTheMarket() {
    val copy = alphaEmptyCopy(read(open(verdictsWhy = null)))!!
    assertFalse(copy.ours)
    assertEquals("No picks this time.", copy.title)
  }

  @Test fun anUnreachableIndexIsOurOutageEvenWithNoVerdictReason() {
    val a = read(open(verdictsWhy = null, indexUnreachable = true))
    val copy = alphaEmptyCopy(a)!!
    assertTrue(copy.ours)
    assertTrue(copy.body.contains("not a quiet market"))
    // Said once, by the empty state; not again as a page note.
    assertTrue(alphaNotes(a).none { it.contains("Market data is unavailable") })
  }

  @Test fun aReasonThisBuildDoesNotKnowFailsClosed() {
    val copy = alphaEmptyCopy(read(open(verdictsWhy = "quota-exceeded")))!!
    assertTrue("an unknown reason is never read as a considered pass", copy.ours)
  }

  @Test fun picksMeanNoEmptyState() {
    val a = read(open(picks = onePick))
    assertEquals(1, a.pickRows.size)
    assertNull(alphaEmptyCopy(a))
  }

  @Test fun theDisclosuresAreSaidOnceForThePage() {
    val a = read(open(picks = onePick, researched = false, truncated = true, degraded = true))
    val notes = alphaNotes(a)
    assertEquals(3, notes.size)
    assertTrue(notes.any { it.contains("prefix of the market") })
    assertTrue(notes.any { it.contains("degraded") })
    assertTrue(notes.any { it == "Website research is unavailable for this update." })

    val whole = read(open(picks = onePick))
    assertTrue("a whole read says nothing", alphaNotes(whole).isEmpty())
  }

  @Test fun researchUnsaidIsNeitherAnswer() {
    // An older server that sends no `researched` must not be told "research is
    // unavailable" — nobody said so.
    val a = read(
      """{"locked":false,"tier":null,"picks":[],"passed":[],"verdictsWhy":null,"truncated":false,"degraded":false,"indexUnreachable":false}""",
    )
    assertNull(a.researched)
    assertTrue(alphaNotes(a).isEmpty())
  }

  @Test fun theTierBadgeIsTheServersAndOnlyWhenOpen() {
    assertEquals("🏹 Merry Man", alphaTierBadge(read(open())))
    // Self-hosted opens with no tier: no badge, never a guessed one.
    assertNull(alphaTierBadge(read(open(tier = "null"))))
    val locked = read(Fixtures.text("probe-alpha-signedout.json"))
    assertTrue(locked.locked)
    assertNull(alphaTierBadge(locked))
  }

  @Test fun theLockedGateListsThePerksVerbatim() {
    val locked = read(Fixtures.text("probe-alpha-signedout.json"))
    assertEquals(
      listOf(
        "25% off the platform performance fee",
        "The Merry Circle bonus strategy pack",
        "3× vote on basket & strategy proposals",
        "Priority in the roadmap queue",
      ),
      alphaPerks(locked),
    )
    // The locked view is unchanged otherwise: no empty-state copy, no notes.
    assertNull(alphaEmptyCopy(locked))
    assertTrue(alphaNotes(locked).isEmpty())
    assertEquals(4, locked.pickCount)
  }
}
