package dev.merrymen.app.net

import android.content.Context
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.sessionStore by preferencesDataStore("merrymen-session")

/**
 * WHAT [dev.merrymen.app.data.Repository] NEEDS FROM THE DEVICE'S STORED
 * SESSION, and nothing else.
 *
 * An interface for the same reason [OriginSource] is one: Session needs a
 * Context for its DataStore, and the wiring worth testing — sign-out running
 * every forget hook, a start dropping the retired password, a Server change
 * ending the wallet's turn — is Repository's, not DataStore's. A JVM test
 * implements this over plain fields and drives the real Repository.
 */
interface SessionStore : OriginSource {
  /** The stored origin, as it changes. */
  val origin: Flow<String>

  /** What a blank Server field restores: the build's default origin. */
  val fallbackOrigin: String

  /** Store an origin [checkOrigin] passed. Only a checked one: see [OriginCheck]. */
  suspend fun setOrigin(checked: OriginCheck.Ok)

  /** Delete the site password an older build stored. Idempotent. */
  suspend fun dropRetiredGatePassword()

  /**
   * Whether the retired mm_gate cookie has been expired in the WebView's store
   * on this install. Repository.bootstrap does that once, not on every start:
   * it wakes the WebView on the main thread for a cookie that is gone after the
   * first time.
   */
  suspend fun webViewGateExpired(): Boolean

  /** Record that it has. Survives sign-out: sign-out empties the WebView's store anyway. */
  suspend fun markWebViewGateExpired()

  /** Sign-out: forget the stored session, keep the origin. */
  suspend fun clearSession()
}

/**
 * WHAT THIS INSTALL KNOWS ABOUT ITS SERVER, AND ABOUT BEING LET IN.
 *
 * Two things, and they are deliberately different kinds of secret:
 *
 *   ORIGIN — not a secret at all. A build input with a default, so pointing the
 *   app at a laptop or a staging deploy is a setting rather than a rebuild.
 *
 *   COOKIES — the session. The SIWE session cookie is the thing that makes
 *   /api/settings answer about YOU. It is a bearer credential for this account,
 *   which is why it lives here and not in a log line.
 *
 * There used to be a third, the shared site password, stored so a cold start
 * did not ask for it again. The server stopped asking on 2026-09-16 (46c852d1);
 * see [dropRetiredGatePassword].
 */
class Session(private val context: Context) : SessionStore, CookieBlob {

  private object Keys {
    val ORIGIN = stringPreferencesKey("origin")
    val COOKIES = stringPreferencesKey("cookies")
    /** The retired site password. Read by nothing; only ever deleted. */
    val RETIRED_GATE = stringPreferencesKey("gate")
    val TENANT = stringPreferencesKey("tenant")
    val WATCHLIST = stringSetPreferencesKey("watchlist")
    val WELCOMED = androidx.datastore.preferences.core.booleanPreferencesKey("welcomed")
    /** The retired mm_gate cookie is gone from the WebView's store; see [webViewGateExpired]. */
    val WEBVIEW_GATE_EXPIRED = androidx.datastore.preferences.core.booleanPreferencesKey("webview-gate-expired")
  }

  /**
   * Whether the welcome page has been past ONCE on this device.
   *
   * A startup page, not a wall: it shows on a cold start until the reader signs
   * in or chooses to go on as a guest, then never again. It is an
   * introduction, so it must not become a gate. Signing in also sets it (the
   * reader has plainly seen it), and it is device-local like the watchlist —
   * nothing about a first visit belongs in anyone's ledger.
   */
  val welcomed: Flow<Boolean> = context.sessionStore.data.map { it[Keys.WELCOMED] == true }
  suspend fun welcomedNow(): Boolean = welcomed.first()
  suspend fun setWelcomed() = context.sessionStore.edit { it[Keys.WELCOMED] = true }

  override val origin: Flow<String> = context.sessionStore.data.map { it[Keys.ORIGIN] ?: defaultOrigin }
  override val fallbackOrigin: String get() = defaultOrigin
  val tenant: Flow<String?> = context.sessionStore.data.map { it[Keys.TENANT] }

  /**
   * TOKENS THIS DEVICE WANTS TO COME BACK TO — and only this device.
   *
   * The web keeps its watchlist in `localStorage` under `merrymen.watchlist`,
   * so it is already per-device there and does not follow a wallet. The same
   * choice here rather than a new server route: a watchlist is a bookmark, it
   * belongs to nobody's ledger, and inventing an endpoint for it would put a
   * per-caller read in front of a page that does not otherwise need one. The
   * consequence is worth stating plainly in the UI — starring on the phone does
   * NOT star on the web.
   *
   * Addresses are lowercased on the way in, because the same token arrives
   * checksummed from one route and lowercase from another.
   */
  val watchlist: Flow<Set<String>> =
    context.sessionStore.data.map { it[Keys.WATCHLIST] ?: emptySet() }

  suspend fun toggleWatch(address: String) {
    val key = address.trim().lowercase()
    if (key.isEmpty()) return
    context.sessionStore.edit { p ->
      val now = p[Keys.WATCHLIST] ?: emptySet()
      p[Keys.WATCHLIST] = if (key in now) now - key else now + key
    }
  }

  override suspend fun originNow(): String = origin.first()

  /**
   * Only an origin [checkOrigin] accepted reaches the store — the type says so.
   * It used to take the raw field, trimmed, and a scheme-less address stored
   * here crashed every launch that followed.
   */
  override suspend fun setOrigin(checked: OriginCheck.Ok) {
    context.sessionStore.edit { it[Keys.ORIGIN] = checked.origin }
  }

  suspend fun setTenant(value: String?) =
    context.sessionStore.edit { p ->
      if (value == null) p.remove(Keys.TENANT) else p[Keys.TENANT] = value
    }

  /**
   * DELETE THE SITE PASSWORD AN OLDER BUILD STORED.
   *
   * It was a shared beta password, kept so a cold start could re-open the door.
   * The door is gone, so keeping it only means a secret sits on the device with
   * nothing left to use it; a stored credential nobody reads is still a
   * credential. Idempotent: after the first run there is nothing to remove.
   */
  override suspend fun dropRetiredGatePassword() {
    if (context.sessionStore.data.first()[Keys.RETIRED_GATE] == null) return
    context.sessionStore.edit { it.remove(Keys.RETIRED_GATE) }
  }

  override suspend fun webViewGateExpired(): Boolean = context.sessionStore.data.first()[Keys.WEBVIEW_GATE_EXPIRED] == true

  override suspend fun markWebViewGateExpired() {
    context.sessionStore.edit { it[Keys.WEBVIEW_GATE_EXPIRED] = true }
  }

  override suspend fun cookiesRaw(): String? = context.sessionStore.data.first()[Keys.COOKIES]

  override suspend fun setCookiesRaw(value: String) {
    context.sessionStore.edit { it[Keys.COOKIES] = value }
  }

  /** Sign-out: forget the session, keep the origin. */
  override suspend fun clearSession() {
    context.sessionStore.edit { p: MutablePreferences ->
      p.remove(Keys.COOKIES)
      p.remove(Keys.TENANT)
    }
  }

  companion object {
    var defaultOrigin: String = dev.merrymen.app.BuildConfig.DEFAULT_ORIGIN
  }
}
