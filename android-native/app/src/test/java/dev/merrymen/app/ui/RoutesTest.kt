package dev.merrymen.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.URLDecoder

/**
 * A WEB SCREEN'S TITLE READS BACK AS IT WAS WRITTEN.
 *
 * The emulator pass saw "Trading+limits" over the limits page: the route was
 * built with a form encoder (a space becomes '+') and Navigation reads the
 * argument back with Uri.decode, which undoes %XX only. android.net.Uri is not
 * on the JVM, so [navDecode] does exactly what Uri.decode does — percent
 * escapes, and a '+' left as a '+'.
 */
class RoutesTest {
  /** Uri.decode: %XX undone, '+' kept. URLDecoder alone would turn '+' into a space and hide the bug. */
  private fun navDecode(s: String): String = URLDecoder.decode(s.replace("+", "%2B"), "UTF-8")

  /** The two arguments of a Routes.web route, as the WEB destination hands them to WebFlowScreen. */
  private fun argsOf(route: String): Map<String, String> {
    val query = route.substringAfter("web?")
    return query.split('&').associate { part ->
      val (name, value) = part.split('=', limit = 2)
      name to navDecode(value)
    }
  }

  @Test fun aTitleWithSpacesComesBackWithSpaces() {
    val route = Routes.web("/limits", "Trading limits")
    assertEquals("web?path=%2Flimits&title=Trading%20limits", route)
    assertEquals(mapOf("path" to "/limits", "title" to "Trading limits"), argsOf(route))
  }

  /** Every title the app opens a web screen with, and the paths with a fragment after them. */
  @Test fun everyWebScreenTheAppOpensReadsBackAsWritten() {
    listOf(
      "/limits" to "Trading limits",
      "/grant" to "Wallet & permissions",
      "/grant#resign" to "Wallet & permissions",
      "/grant#resign" to "Re-sign",
      "/grant#resign" to "Signed limits",
      "/deposit" to "Add funds",
      "/withdraw" to "Withdraw",
      "/create" to "Create an agent",
      "/create" to "Create your Merryman",
      "/grant" to "Your agent",
      "/settings#telegram" to "Settings",
    ).forEach { (path, title) ->
      assertEquals(mapOf("path" to path, "title" to title), argsOf(Routes.web(path, title)))
    }
  }

  /** A '+' somebody meant, and the characters that would split the route, survive too. */
  @Test fun aRealPlusAndTheRoutesOwnSeparatorsSurvive() {
    val title = "C++ & 50%+ = gains?"
    val path = "/deposit?amount=1+2&x=y#top"
    assertEquals(mapOf("path" to path, "title" to title), argsOf(Routes.web(path, title)))
  }
}
