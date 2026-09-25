package dev.merrymen.app.settings

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.SettingsRead
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.net.settingsRead
import dev.merrymen.app.ui.screens.PaperResetTap
import dev.merrymen.app.ui.screens.paperResetOffered
import dev.merrymen.app.ui.screens.paperResetSaid
import dev.merrymen.app.ui.screens.paperResetTap
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "RESTART THE PRACTICE BOOK" cannot be undone: two taps, one request, only
 * for the wallet the form was read for, and its answer said as what it is —
 * asked, not done, and refused by an agent trading for real.
 */
class PaperResetTest {
  private val a = "0x00000000000000000000000000000000000000aa"
  private val b = "0x00000000000000000000000000000000000000bb"

  /** The settings read as the app decodes it, from the signed-out capture with [owner] put in (null drops it). */
  private fun read(owner: String?): Loaded<SettingsRead> = runBlocking {
    val raw = Fixtures.text("probe-settings-signedout.json")
    val body = when (owner) {
      null -> raw.replace("\"owner\":\"\",", "").replace(",\"owner\":\"\"", "")
      else -> raw.replace("\"owner\":\"\"", "\"owner\":\"$owner\"")
    }
    val server = MockWebServer()
    server.start()
    try {
      server.answer(body)
      apiFor(server).settingsRead().toLoaded()
    } finally {
      server.shutdown()
    }
  }

  @Test fun aFirstTapOnlyArmsAndATapWhileOneIsOutSendsNothing() {
    assertEquals(PaperResetTap.Arm, paperResetTap(armed = false, busy = false))
    assertEquals(PaperResetTap.Fire, paperResetTap(armed = true, busy = false))
    assertEquals(PaperResetTap.Busy, paperResetTap(armed = true, busy = true))
    assertEquals(PaperResetTap.Busy, paperResetTap(armed = false, busy = true))
  }

  @Test fun itIsOfferedOnlyOverTheSignedInWalletsOwnForm() {
    val signedOut = read("")
    assertEquals("", (signedOut as Loaded.Value).value.env.owner)
    assertFalse("a form read for nobody", paperResetOffered(signedOut, signedIn = a, hosted = true))
    assertFalse(paperResetOffered(signedOut, signedIn = null, hosted = true))
    assertTrue(paperResetOffered(read(a), signedIn = a, hosted = true))
    assertTrue("addresses compare without case", paperResetOffered(read(a.uppercase().replace("0X", "0x")), signedIn = a, hosted = true))
    assertFalse("another wallet's form", paperResetOffered(read(a), signedIn = b, hosted = true))
    assertFalse("a read that failed", paperResetOffered(Loaded.Unreachable("the connection timed out"), signedIn = a, hosted = true))
    assertFalse(paperResetOffered(Loaded.Loading, signedIn = a, hosted = true))
    // Self-hosted: one operator, and the route names no owner.
    assertTrue(paperResetOffered(read(null), signedIn = null, hosted = false))
    assertFalse("no owner said by a hosted server is not self-hosted", paperResetOffered(read(null), signedIn = a, hosted = true))
  }

  @Test fun anAcceptedRestartIsSaidAsAskedAndNamesTheLiveRefusal() {
    val ok = paperResetSaid(ApiResult.Ok(Unit))
    assertFalse(ok.bad)
    assertTrue(ok.text, ok.text.startsWith("Asked your agent to restart the practice book"))
    assertTrue(ok.text, ok.text.contains("If it is trading for real it will refuse, and nothing is deleted."))
    val signedOut = paperResetSaid(ApiResult.Refused(401, "not signed in"))
    assertTrue(signedOut.bad)
    assertEquals("Sign in to restart the practice book. Nothing was restarted.", signedOut.text)
    val lost = paperResetSaid(ApiResult.Unreachable("the connection dropped before an answer came back"))
    assertTrue(lost.text, lost.text.startsWith("Couldn't tell whether the restart was queued."))
  }
}
