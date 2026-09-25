package dev.merrymen.app.net

import okhttp3.Cookie
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WHAT A HANDOFF PAGE IS GIVEN (WebAuth.seedLines): the session, httpOnly and
 * SameSite=Strict as the server sets it, and nothing a page script owns.
 *
 * The lines are what CookieManager.setCookie is handed, so an attribute
 * missing here is an attribute missing in the WebView's store.
 */
class WebSeedTest {
  private val hosted = "https://app.merrymen.dev".toHttpUrl()
  private val now = 1_790_000_000_000L

  /** A cookie as the jar holds it after a harvest: host-only, path /, no expiry (webCookies). */
  private fun harvested(name: String, value: String, url: HttpUrl = hosted) = WebAuth.webCookies("$name=$value", url).single()

  @Test fun theSessionGoesBackHttpOnlyAndStrictWhateverTheJarSays() {
    val lines = WebAuth.seedLines(listOf(harvested("mm_session", "0xaa.1790.mac")), webRaw = null, url = hosted, nowMs = now)
    val line = lines.single()
    assertTrue(line, line.startsWith("mm_session=0xaa.1790.mac; "))
    val attrs = line.split("; ").drop(1).toSet()
    assertTrue("no script on the page may read it: $line", "HttpOnly" in attrs)
    assertTrue("the server's SameSite, not Chromium's default: $line", "SameSite=Strict" in attrs)
    assertTrue("https, so Secure: $line", "Secure" in attrs)
    assertTrue(line, "Path=/" in attrs)
    assertFalse("a harvested copy has no age to give: $line", attrs.any { it.startsWith("Max-Age") })
  }

  @Test fun anAgeTheJarKnowsIsKept() {
    val sevenDays = 7 * 24 * 3600L
    val c = Cookie.Builder().name("mm_session").value("v").hostOnlyDomain(hosted.host).path("/")
      .expiresAt(now + sevenDays * 1000).httpOnly().secure().build()
    val line = WebAuth.seedLines(listOf(c), webRaw = null, url = hosted, nowMs = now).single()
    assertTrue(line, line.split("; ").contains("Max-Age=$sevenDays"))
    assertTrue(line, line.split("; ").contains("HttpOnly"))
  }

  @Test fun aSessionTheWebViewAlreadyHoldsIsLeftAsTheServerSetIt() {
    val held = listOf(harvested("mm_session", "same"))
    assertEquals(
      "overwriting it would only take away the server's own expiry",
      emptyList<String>(),
      WebAuth.seedLines(held, webRaw = "mm_locale=fr; mm_session=same", url = hosted, nowMs = now),
    )
  }

  @Test fun onceAfterAnUpgradeTheSameValueIsWrittenAgainHttpOnly() {
    // An older build seeded "mm_session=same; Path=/" here, with the jar's
    // own value: the skip above would keep that script-readable copy.
    val held = listOf(harvested("mm_locale", "fr"), harvested("mm_session", "same"))
    val lines = WebAuth.seedLines(held, webRaw = "mm_locale=fr; mm_session=same", url = hosted, nowMs = now, rewriteSame = true)
    val line = lines.single()
    assertTrue("still only the session: $lines", line.startsWith("mm_session=same; "))
    val attrs = line.split("; ").drop(1).toSet()
    assertEquals(line, setOf("Path=/", "HttpOnly", "SameSite=Strict", "Secure"), attrs)
  }

  @Test fun anOlderSessionInTheWebViewIsReplacedWithTheAppsOwn() {
    // CookieManager lost the newer cookie to a lazy flush and kept the older one.
    val line = WebAuth.seedLines(listOf(harvested("mm_session", "new")), webRaw = "mm_session=old", url = hosted, nowMs = now).single()
    assertTrue(line, line.startsWith("mm_session=new; ") && "HttpOnly" in line.split("; "))
  }

  @Test fun aCookieThePagesScriptOwnsIsNeverSeeded() {
    // Seeded httpOnly, the language could no longer be read or changed by the
    // script that sets it; seeded as it was, it would be a guess at attributes.
    val held = listOf(harvested("mm_locale", "fr"), harvested("privy-token", "t"), harvested("mm_session", "s"))
    val lines = WebAuth.seedLines(held, webRaw = null, url = hosted, nowMs = now)
    assertEquals(listOf("mm_session"), lines.map { it.substringBefore('=') })
  }

  @Test fun aPlainHttpDevServerGetsNoSecureFlagItCouldNotKeep() {
    val local = "http://localhost:3000".toHttpUrl()
    val line = WebAuth.seedLines(listOf(harvested("mm_session", "s", local)), webRaw = "", url = local, nowMs = now).single()
    val attrs = line.split("; ").toSet()
    assertFalse(line, "Secure" in attrs)
    assertTrue(line, "HttpOnly" in attrs && "SameSite=Strict" in attrs)
  }
}
