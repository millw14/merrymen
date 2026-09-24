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
class Session(private val context: Context) : OriginSource {

  private object Keys {
    val ORIGIN = stringPreferencesKey("origin")
    val COOKIES = stringPreferencesKey("cookies")
    /** The retired site password. Read by nothing; only ever deleted. */
    val RETIRED_GATE = stringPreferencesKey("gate")
    val TENANT = stringPreferencesKey("tenant")
    val WATCHLIST = stringSetPreferencesKey("watchlist")
    val WELCOMED = androidx.datastore.preferences.core.booleanPreferencesKey("welcomed")
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

  val origin: Flow<String> = context.sessionStore.data.map { it[Keys.ORIGIN] ?: defaultOrigin }
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

  suspend fun setOrigin(value: String) {
    // Normalised once, here, so every caller can concatenate a path without
    // wondering whether it will produce a double slash.
    val trimmed = value.trim().removeSuffix("/")
    context.sessionStore.edit { it[Keys.ORIGIN] = trimmed.ifEmpty { defaultOrigin } }
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
  suspend fun dropRetiredGatePassword() {
    if (context.sessionStore.data.first()[Keys.RETIRED_GATE] == null) return
    context.sessionStore.edit { it.remove(Keys.RETIRED_GATE) }
  }

  suspend fun cookiesRaw(): String? = context.sessionStore.data.first()[Keys.COOKIES]

  suspend fun setCookiesRaw(value: String) =
    context.sessionStore.edit { it[Keys.COOKIES] = value }

  /** Sign-out: forget the session, keep the origin. */
  suspend fun clearSession() =
    context.sessionStore.edit { p: MutablePreferences ->
      p.remove(Keys.COOKIES)
      p.remove(Keys.TENANT)
    }

  companion object {
    var defaultOrigin: String = dev.merrymen.app.BuildConfig.DEFAULT_ORIGIN
  }
}
