package dev.merrymen.app.act

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Discoveries
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.ui.screens.proposalsEmptyCopy
import dev.merrymen.app.ui.screens.riskPageOf
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * TWO EMPTY STATES THAT SAID MORE THAN THE ROUTE KNEW: the Risk page about a
 * signed-out reader's "dials", and Coins to consider about the market when the
 * scout could not look, or about a Sign in on a server that has none.
 */
class RiskAndProposalsTest {
  private val owner = "0x00000000000000000000000000000000000000aa"

  private fun <T> served(body: String, read: suspend (dev.merrymen.app.net.MerrymenApi) -> T): T = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      server.answer(body)
      read(apiFor(server))
    } finally {
      server.shutdown()
    }
  }

  private fun settings(owner: String): ApiResult<SettingsEnvelope> =
    served(Fixtures.text("probe-settings-signedout.json").replace("\"owner\":\"\"", "\"owner\":\"$owner\"")) { it.settings() }

  private val sweep: Discoveries = served(Fixtures.text("probe-discoveries.json")) { (it.discoveries() as ApiResult.Ok).value }

  // ── risk ──────────────────────────────────────────────────────────────────

  @Test fun aSignedOutReadIsNotSomebodysDialsSetByHand() {
    val read = settings("")
    assertEquals("", (read as ApiResult.Ok).value.owner)
    val page = riskPageOf(read, current = null, saved = null, busy = false)
    assertTrue(page.signedOut)
    assertFalse("no 'set by hand' about an account that does not exist", page.byHand)
    assertFalse("no rung that can only be refused", page.rungsEnabled)
  }

  @Test fun anOwnersUnmatchedDialsAreSetByHand() {
    val page = riskPageOf(settings(owner), current = null, saved = null, busy = false)
    assertFalse(page.signedOut)
    assertTrue(page.byHand)
    assertTrue(page.rungsEnabled)
    assertFalse(riskPageOf(settings(owner), current = null, saved = null, busy = true).rungsEnabled)
  }

  @Test fun aFailedReadLeavesTheRungsToReadTheOwnerAtTheTap() {
    val page = riskPageOf(ApiResult.Unreachable("the connection timed out"), current = null, saved = null, busy = false)
    assertFalse(page.signedOut)
    assertFalse(page.byHand)
    assertTrue(page.rungsEnabled)
  }

  // ── coins to consider ─────────────────────────────────────────────────────

  @Test fun aSelfHostedServerIsNotToldToSignIn() {
    val self = proposalsEmptyCopy("signed-out", hosted = false, canOfferSignIn = false, verdicts = null)
    assertFalse(self.signIn)
    assertFalse(self.title, self.title.contains("Sign in"))
    val hostedOut = proposalsEmptyCopy("signed-out", hosted = true, canOfferSignIn = true, verdicts = null)
    assertEquals("Sign in to see these", hostedOut.title)
    assertTrue(hostedOut.signIn)
    assertFalse(
      "no offer while this app still holds an address",
      proposalsEmptyCopy("signed-out", hosted = true, canOfferSignIn = false, verdicts = null).signIn,
    )
  }

  @Test fun nothingVettedIsNotAVerdictOnTheMarketWhenTheScoutCouldNotLook() {
    for (why in listOf("no-model", "model-failed", "something-new")) {
      val copy = proposalsEmptyCopy("nothing-vetted", hosted = true, canOfferSignIn = false, verdicts = Loaded.Value(sweep.copy(verdictsWhy = why)))
      assertTrue(copy.body, copy.body.endsWith("which is not the same as nothing qualifying."))
      assertFalse(copy.body, copy.body.contains("cleared the screen"))
    }
    val down = proposalsEmptyCopy("nothing-vetted", hosted = true, canOfferSignIn = false, verdicts = Loaded.Value(sweep.copy(indexUnreachable = true)))
    assertTrue(down.body, down.body.contains("which is not the same as nothing qualifying"))
  }

  @Test fun nothingVettedAfterTheScoutLookedClaimsNoMoreThanThat() {
    // The capture: the scout looked (verdictsWhy null).
    val looked = proposalsEmptyCopy("nothing-vetted", hosted = true, canOfferSignIn = false, verdicts = Loaded.Value(sweep))
    assertEquals("Nothing vetted to add right now", looked.title)
    assertFalse(looked.body, looked.body.contains("cleared the screen"))
    val unread = proposalsEmptyCopy("nothing-vetted", hosted = true, canOfferSignIn = false, verdicts = Loaded.Unreachable("the connection timed out"))
    assertTrue(unread.body, unread.body.contains("says nothing about the market"))
  }
}
