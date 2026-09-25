package dev.merrymen.app.net

import okhttp3.Cookie
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

  // ── an older build's blob with no address to put it on yet ───────────────

  @Test fun anOlderBuildsBlobWaitsForAnAddressThatParses() {
    // A 0.2.0 owner, signed in, who then saved the Server with no scheme: the
    // blob came from a real server, and the stored address names none.
    val store = MemoryStore("app.merrymen.dev").apply { cookieBlob = "mm_gate=pw\nmm_session=abc" }
    val first = jar(store)
    first.drop("mm_gate") // what every start does first
    assertTrue(first.names(hosted).isEmpty())
    assertEquals("left on disk exactly as it was", "mm_gate=pw\nmm_session=abc", store.cookieBlob)

    // The owner fixes the address; the next start still has the session.
    store.originState.value = "https://app.merrymen.dev"
    val cold = jar(store)
    assertEquals(listOf("mm_session=abc"), cold.names(hosted))
    assertTrue(cold.names(other).isEmpty())
    assertTrue("rewritten with its host at once", store.cookieBlob!!.startsWith("["))
    assertFalse("the retired password is never read back in", store.cookieBlob!!.contains("mm_gate"))
  }

  @Test fun theSameRunPicksItUpOnceTheAddressIsFixed() {
    val store = MemoryStore("app.merrymen.dev").apply { cookieBlob = "mm_session=abc" }
    val j = jar(store)
    assertTrue(j.names(hosted).isEmpty())
    store.originState.value = "https://app.merrymen.dev"
    assertEquals(listOf("mm_session=abc"), j.names(hosted))
  }

  @Test fun aCookieSetWhileTheBlobWaitsDoesNotWriteOverIt() {
    // Nothing is written while it waits, so an answer from somewhere else
    // cannot replace the only copy of that session with its own cookie.
    val store = MemoryStore("app.merrymen.dev").apply { cookieBlob = "mm_session=abc" }
    val j = jar(store)
    j.set(other, "theirs=1; Path=/")
    assertEquals("mm_session=abc", store.cookieBlob)
    store.originState.value = "https://app.merrymen.dev"
    assertEquals(listOf("mm_session=abc"), j.names(hosted))
    assertEquals(listOf("theirs=1"), j.names(other))
    assertEquals("both, once it has a host", setOf("mm_session=abc", "theirs=1"), jar(store).let { it.names(hosted) + it.names(other) }.toSet())
  }

  @Test fun aSignOutForgetsAWaitingBlobToo() {
    val store = MemoryStore("app.merrymen.dev").apply { cookieBlob = "mm_session=abc" }
    jar(store).clear()
    assertEquals("[]", store.cookieBlob)
    store.originState.value = "https://app.merrymen.dev"
    assertTrue(jar(store).names(hosted).isEmpty())
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
