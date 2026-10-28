package dev.merrymen.app.net

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class AndroidOAuthTest {
  private val state = "s".repeat(48)
  private fun authorization(nextState: String = state) = "https://twitter.com/i/oauth2/authorize".toHttpUrl().newBuilder()
    .addQueryParameter("response_type", "code")
    .addQueryParameter("client_id", "provider-client")
    .addQueryParameter("redirect_uri", "https://auth.privy.io/api/v1/oauth/callback")
    .addQueryParameter("scope", "users.read tweet.read")
    .addQueryParameter("state", nextState)
    .addQueryParameter("code_challenge", "challenge")
    .addQueryParameter("code_challenge_method", "S256").build().toString()
  private fun callback(nextState: String = state) = ANDROID_AUTH_URL.toHttpUrl().newBuilder()
    .addQueryParameter("privy_oauth_code", "one-time-code")
    .addQueryParameter("privy_oauth_state", nextState)
    .addQueryParameter("privy_oauth_provider", "twitter").build().toString()

  @Test fun `only the dedicated original page can start an external flow`() {
    val flow = AndroidOAuthExchange()
    for (source in listOf(null, "$ANDROID_AUTH_ORIGIN/home", "https://attacker.invalid/auth/android", "$ANDROID_AUTH_URL?return_to=anything")) {
      assertFalse(flow.begin("login", source, authorization()))
    }
    assertTrue(flow.begin("login", ANDROID_AUTH_URL, authorization()))
  }

  @Test fun `only the observed HTTPS X authorization shape is eligible`() {
    assertEquals(state, xOAuthState(authorization()))
    assertEquals(state, xOAuthState(authorization().replace("twitter.com", "x.com")))
    for (url in listOf(
      authorization().replace("https:", "http:"), authorization().replace("twitter.com", "x.com.attacker.invalid"),
      authorization().replace("/i/oauth2/authorize", "/profile"), authorization() + "&state=duplicate",
      authorization().replace("S256", "plain"), authorization().replace("auth.privy.io", "attacker.invalid"),
      authorization().replace("twitter.com", "user@twitter.com"), authorization() + "#fragment",
      "intent://i/oauth2/authorize#Intent;package=com.twitter.android;end",
    )) assertNull(url.substringBefore('?'), xOAuthState(url))
  }

  @Test fun `matching return delivers code to exactly the originating screen once`() {
    val flow = AndroidOAuthExchange()
    assertFalse(flow.accept(callback()))
    assertTrue(flow.begin("login", ANDROID_AUTH_URL, authorization()))
    assertFalse(flow.accept(callback("other".repeat(10))))
    assertNull(flow.take("login"))
    assertTrue(flow.accept(callback()))
    assertNull(flow.take("other-screen"))
    assertEquals(callback(), flow.take("login"))
    assertNull(flow.take("login"))
    assertFalse(flow.accept(callback()))
  }

  @Test fun `callback cannot introduce a destination token provider or ambiguous value`() {
    val flow = AndroidOAuthExchange()
    flow.begin("login", ANDROID_AUTH_URL, authorization())
    for (url in listOf(
      callback().replace("https:", "http:"), callback().replace("app.merrymen.dev", "app.merrymen.dev.attacker.invalid"),
      callback().replace("/auth/android", "/home"), callback().replace("twitter", "google"),
      callback() + "&access_token=never", callback() + "&return_to=https://attacker.invalid", callback() + "#fragment",
      callback() + "&privy_oauth_code=duplicate", callback().replace("one-time-code", "bad%0Acode"),
      callback().replace("app.merrymen.dev", "user@app.merrymen.dev"),
    )) assertFalse(flow.accept(url))
    assertTrue(flow.accept(callback()))
  }

  @Test fun `abandonment signout and server changes invalidate pending and queued returns`() {
    val flow = AndroidOAuthExchange()
    flow.begin("login", ANDROID_AUTH_URL, authorization())
    flow.cancelFlow("other-screen")
    assertTrue(flow.accept(callback()))
    flow.cancelFlow("login")
    assertNull(flow.take("login"))
    flow.begin("login", ANDROID_AUTH_URL, authorization())
    flow.cancel()
    assertFalse(flow.accept(callback()))
    flow.begin("login", ANDROID_AUTH_URL, authorization())
    assertTrue(flow.accept(callback()))
    flow.cancel()
    assertNull(flow.take("login"))
  }

  @Test fun `new login supersedes old state and an expired approval cannot resume`() {
    var now = 100L
    val flow = AndroidOAuthExchange { now }
    flow.begin("login", ANDROID_AUTH_URL, authorization())
    val next = "n".repeat(48)
    flow.begin("login", ANDROID_AUTH_URL, authorization(next))
    assertFalse(flow.accept(callback()))
    assertTrue(flow.accept(callback(next)))
    flow.begin("login", ANDROID_AUTH_URL, authorization())
    now += 600_001
    assertFalse(flow.accept(callback()))
    assertNull(flow.take("login"))
  }

  @Test fun `recreated screen can consume its in-memory flow but process restart cannot`() {
    val flow = AndroidOAuthExchange()
    flow.begin("saved-screen-id", ANDROID_AUTH_URL, authorization())
    assertTrue(flow.accept(callback()))
    assertNotNull(flow.take("saved-screen-id"))
    assertFalse(AndroidOAuthExchange().accept(callback()))
  }
}
