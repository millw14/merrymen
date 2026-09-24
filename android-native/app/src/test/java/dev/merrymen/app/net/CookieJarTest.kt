package dev.merrymen.app.net

import okhttp3.Cookie
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A SESSION COOKIE GOES BACK TO THE HOST THAT SET IT, AND NOWHERE ELSE.
 *
 * The jar used to answer every request with every cookie it held. The Server
 * field takes any address, so pointing the app at another host — a typo, a
 * laptop, a link somebody sent — handed that host the owner's hosted
 * mm_session on the first request: a bearer credential for a trading account.
 */
class CookieJarTest {
  private val hosted = "https://app.merrymen.dev/".toHttpUrl()
  private val other = "https://evil.example/".toHttpUrl()

  private fun jar(store: MemoryStore = MemoryStore("https://app.merrymen.dev")) = PersistentCookieJar(store)

  private fun PersistentCookieJar.set(url: HttpUrl, header: String) =
    saveFromResponse(url, listOf(Cookie.parse(url, header)!!))

  private fun PersistentCookieJar.names(url: HttpUrl) = loadForRequest(url).map { it.name + "=" + it.value }

  @Test fun aCookieGoesOnlyToTheHostThatSetIt() {
    val j = jar()
    j.set(hosted, "mm_session=abc; Path=/; HttpOnly; Secure")
    assertEquals(listOf("mm_session=abc"), j.names(hosted.resolve("/api/feed")!!))
    assertTrue("another host gets nothing", j.names(other).isEmpty())
    assertTrue("a sibling host gets nothing", j.names("https://x.app.merrymen.dev/".toHttpUrl()).isEmpty())
    assertTrue("a Secure cookie never travels in the clear", j.names("http://app.merrymen.dev/".toHttpUrl()).isEmpty())
  }

  @Test fun itSurvivesAColdStartStillScoped() {
    val store = MemoryStore("https://app.merrymen.dev")
    jar(store).set(hosted, "mm_session=abc; Path=/; HttpOnly")
    // The origin changes before the next launch; the cookie stays with its host.
    store.originState.value = "https://evil.example"
    val cold = jar(store)
    assertEquals(listOf("mm_session=abc"), cold.names(hosted))
    assertTrue(cold.names(other).isEmpty())
    assertTrue("httpOnly survives the round trip", cold.loadForRequest(hosted).single().httpOnly)
  }

  @Test fun twoServersKeepTheirOwnSession() {
    val j = jar()
    j.set(hosted, "mm_session=a; Path=/")
    j.set(other, "mm_session=b; Path=/")
    assertEquals(listOf("mm_session=a"), j.names(hosted))
    assertEquals(listOf("mm_session=b"), j.names(other))
  }

  @Test fun anOlderBuildsBlobBelongsToTheOriginItWasStoredAgainst() {
    val store = MemoryStore("https://app.merrymen.dev").apply { cookieBlob = "mm_session=abc\nmm_other=1" }
    val j = jar(store)
    assertEquals(setOf("mm_session=abc", "mm_other=1"), j.names(hosted).toSet())
    assertTrue(j.names(other).isEmpty())
    // Rewritten at once with its host, so a Server change before the next
    // launch cannot re-home it onto the new origin.
    assertTrue(store.cookieBlob!!.startsWith("["))
    store.originState.value = "https://evil.example"
    assertTrue(jar(store).names(other).isEmpty())
  }

  @Test fun anExpiredCookieIsADelete() {
    val store = MemoryStore("https://app.merrymen.dev")
    val j = jar(store)
    j.set(hosted, "mm_session=abc; Path=/")
    j.set(hosted, "mm_session=; Path=/; Max-Age=0")
    assertTrue(j.names(hosted).isEmpty())
    assertTrue(jar(store).names(hosted).isEmpty())
  }

  @Test fun dropForgetsANameOnEveryHost() {
    val store = MemoryStore("https://app.merrymen.dev")
    val j = jar(store)
    j.set(hosted, "mm_gate=pw; Path=/")
    j.set(other, "mm_gate=pw; Path=/")
    j.set(hosted, "mm_session=abc; Path=/")
    j.drop("mm_gate")
    assertEquals(listOf("mm_session=abc"), j.names(hosted))
    assertTrue(jar(store).names(other).isEmpty())
  }

  // ── what comes back from the WebView ─────────────────────────────────────

  @Test fun theWebViewsLineIsHostOnlyAndNeverCarriesARetiredCookie() {
    val back = WebAuth.webCookies("mm_gate=beta-password; mm_session=abc; =junk; bare", hosted)
    assertEquals(listOf("mm_session"), back.map { it.name })
    assertTrue(back.single().hostOnly)
    assertEquals("app.merrymen.dev", back.single().domain)
  }
}
