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
 * Three things, and they are deliberately different kinds of secret:
 *
 *   ORIGIN — not a secret at all. A build input with a default, so pointing the
 *   app at a laptop or a staging deploy is a setting rather than a rebuild.
 *
 *   COOKIES — the session. `mm_gate` opens the "not yet" door, and the SIWE
 *   session cookie is the thing that makes /api/settings answer about YOU. Both
 *   are bearer credentials for this account, which is why they live here and
 *   not in a log line.
 *
 *   GATE PASSWORD — shared, low-value, and stored only so a cold start does not
 *   ask for it again. It is a doorknob, not a lock: one password for everyone,
 *   checked at the edge with no session. Storing it does not weaken anything
 *   that was strong, and the repo says so in as many words.
 */
class Session(private val context: Context) {

  private object Keys {
    val ORIGIN = stringPreferencesKey("origin")
    val COOKIES = stringPreferencesKey("cookies")
    val GATE = stringPreferencesKey("gate")
    val TENANT = stringPreferencesKey("tenant")
    val WATCHLIST = stringSetPreferencesKey("watchlist")
  }

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

  suspend fun originNow(): String = origin.first()

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

  suspend fun gatePassword(): String? = context.sessionStore.data.first()[Keys.GATE]

  suspend fun setGatePassword(value: String?) =
    context.sessionStore.edit { p ->
      if (value.isNullOrBlank()) p.remove(Keys.GATE) else p[Keys.GATE] = value
    }

  suspend fun cookiesRaw(): String? = context.sessionStore.data.first()[Keys.COOKIES]

  suspend fun setCookiesRaw(value: String) =
    context.sessionStore.edit { it[Keys.COOKIES] = value }

  /** Sign-out: forget the session, keep the origin and the doorknob. */
  suspend fun clearSession() =
    context.sessionStore.edit { p: MutablePreferences ->
      p.remove(Keys.COOKIES)
      p.remove(Keys.TENANT)
    }

  companion object {
    var defaultOrigin: String = dev.merrymen.app.BuildConfig.DEFAULT_ORIGIN
  }
}
