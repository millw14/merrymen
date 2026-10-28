package dev.merrymen.app.net

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebNavigationTest {
  @Test fun telegramLinksLeaveButOAuthAndTheBlankPopupStayEmbedded() {
    assertEquals(WebLinkTarget.Telegram, webLinkTarget("https://t.me/merrybot?start=AB12CD"))
    assertEquals(WebLinkTarget.Telegram, webLinkTarget("tg://resolve?domain=BotFather&startapp=newbot"))
    assertEquals(WebLinkTarget.Embedded, webLinkTarget("about:blank"))
    assertEquals(WebLinkTarget.Embedded, webLinkTarget("https://auth.privy.io/oauth/callback?code=example"))
    assertEquals(WebLinkTarget.Embedded, webLinkTarget("https://app.merrymen.dev/settings#telegram"))
  }

  @Test fun externalAppLaunchesCannotBeInventedByAnIframeOrIntentPayload() {
    assertEquals(WebLinkTarget.Blocked, webLinkTarget("intent://resolve#Intent;scheme=tg;component=bad;end"))
    assertEquals(WebLinkTarget.Blocked, webLinkTarget("tg://resolve?domain=merrybot", mainFrame = false))
    assertEquals(WebLinkTarget.Blocked, webLinkTarget("tg://unrecognised-action"))
    assertEquals(WebLinkTarget.Blocked, webLinkTarget("tg://user@resolve?domain=merrybot"))
    assertEquals(WebLinkTarget.Blocked, webLinkTarget("file:///data/data/private"))
    assertEquals(WebLinkTarget.Blocked, webLinkTarget("javascript:alert(1)"))
    assertEquals(WebLinkTarget.Blocked, webLinkTarget("https://user:secret@t.me/bot"))
    assertEquals(WebLinkTarget.Embedded, webLinkTarget("https://t.me.evil.example/bot"))
    assertEquals(WebLinkTarget.Embedded, webLinkTarget("https://t.me/bot", mainFrame = false))
    assertEquals(WebLinkTarget.Embedded, webLinkTarget("https://t.me:444/bot"))
  }

  @Test fun changedCookiesStayPendingUntilTheNativeIdentityReadSucceeds() {
    val watch = WebSessionChanges()
    assertTrue(watch.needsAdoption(null))
    watch.adopted(null)
    assertFalse(watch.needsAdoption("mm_locale=en"))
    val signedIn = "mm_locale=en; mm_session=first"
    assertTrue(watch.needsAdoption(signedIn))
    // A failed or cancelled adoption never acknowledges the snapshot.
    assertTrue(watch.needsAdoption(signedIn))
    watch.adopted(signedIn)
    assertFalse(watch.needsAdoption("mm_session=first; mm_locale=fr"))
    assertTrue(watch.needsAdoption("mm_session=second"))
    watch.adopted("mm_session=second")
    assertTrue(watch.needsAdoption(null))
    assertTrue(watch.needsAdoption("mm_session="))
    watch.adopted(null)
    assertFalse(watch.needsAdoption(null))
  }

  @Test fun aSuccessfulMissingSessionReadExpiresOnlyItsOriginalHostsCookie() {
    val here = "https://app.merrymen.dev/".toHttpUrl()
    val there = "https://another.example/".toHttpUrl()
    val jar = PersistentCookieJar(MemoryStore(here.toString()))
    jar.saveFromResponse(here, listOf(Cookie.parse(here, "mm_session=one; Path=/; Secure")!!))
    jar.saveFromResponse(there, listOf(Cookie.parse(there, "mm_session=two; Path=/; Secure")!!))
    jar.saveFromResponse(here, harvestedWebCookies("mm_locale=en", here))
    assertFalse(jar.loadForRequest(here).any { it.name == "mm_session" })
    assertEquals("two", jar.loadForRequest(there).single().value)
    assertEquals("en", jar.loadForRequest(here).single().value)
    val replacement = harvestedWebCookies("mm_session=new", here).single()
    assertEquals("new", replacement.value)
    assertTrue(replacement.expiresAt > System.currentTimeMillis())
  }
}
