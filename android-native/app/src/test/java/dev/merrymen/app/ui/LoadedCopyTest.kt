package dev.merrymen.app.ui

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.CANT_REACH
import dev.merrymen.app.net.HTML_PAGE
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WHAT A NOTICE SAYS, for each way a read can fail to give a value.
 *
 * Components.kt is frozen once the other branches start, so these words are
 * fixed here or nowhere: a 5xx titled "The server said no" with no retry, and
 * an unreadable answer titled "Couldn't reach merrymen" with our type name in
 * the body, were both what the review found.
 */
class LoadedCopyTest {
  private fun copy(state: Loaded<*>, signIn: Boolean = true, retry: Boolean = true) =
    noticeFor(state, canSignIn = signIn, canRetry = retry)!!

  @Test fun aServerFailureIsAFailureWithTryAgain() {
    val c = copy(Loaded.Refused(503, "merrymen answered with an error (503). Try again in a moment."))
    assertEquals("merrymen had a problem", c.title)
    assertEquals(NoticeAction.TryAgain, c.action)
    assertFalse("a failure is not a refusal", c.refusal)
    assertNull("no handler, no button", copy(Loaded.Refused(502, "x"), retry = false).action)
  }

  @Test fun aRefusalIsStillARefusal() {
    val c = copy(Loaded.Refused(403, "HTTP 403"))
    assertEquals("The server said no", c.title)
    assertNull("asking again gets the same answer", c.action)
    assertTrue(c.refusal)
  }

  @Test fun a401IsADoor() {
    assertEquals(NoticeAction.SignIn, copy(Loaded.Refused(401, "not signed in")).action)
    assertNull(copy(Loaded.Refused(401, "not signed in"), signIn = false).action)
  }

  @Test fun noAnswerIsCantReach() {
    val c = copy(Loaded.Unreachable("timeout"))
    assertEquals(CANT_REACH, c.title)
    assertTrue(c.body.endsWith("timeout"))
    assertEquals(NoticeAction.TryAgain, c.action)
  }

  @Test fun anAnswerWeCouldNotReadIsNotCantReach() = runBlocking {
    // Through the real client: an HTML 200 where JSON was due.
    val server = MockWebServer().apply { start() }
    try {
      server.answer(HTML_PAGE, 200, "text/html")
      val state = apiFor(server).theses().toLoaded()
      val c = copy(state)
      assertEquals("Couldn't read merrymen's answer", c.title)
      assertFalse(c.title.contains("reach"))
      assertFalse("our type name belongs in the log", (c.title + c.body).contains("ThesesPage"))
      assertEquals(NoticeAction.TryAgain, c.action)
    } finally {
      server.shutdown()
    }
  }

  @Test fun aValueHasNoNotice() {
    assertNull(noticeFor(Loaded.Value(1), canSignIn = true, canRetry = true))
    assertNull(noticeFor(Loaded.Loading, canSignIn = true, canRetry = true))
  }

  @Test fun theUnreadableFlagSurvivesTheTrip() {
    assertEquals(Loaded.Unreachable("x", unreadable = true), ApiResult.Unreachable("x", unreadable = true).toLoaded<Int>())
  }
}
