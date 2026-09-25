package dev.merrymen.app.net

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * WHAT THE OWNER TYPED INTO "Server", checked before anything is saved.
 *
 * The field used to be trimmed and stored as-is. "app.merrymen.dev" — no
 * scheme — went straight into the store, and OkHttp throws on a URL it cannot
 * parse, from outside anything that catches. So one mistyped address crashed
 * the Save, and then crashed every launch after it, because the next cold
 * start read the same address back. The owner's only way out was to clear the
 * app's data.
 *
 * So it is checked HERE, once, and a refusal is a sentence the Settings screen
 * shows instead of saving. [MerrymenApi] still guards every call, because an
 * address stored by an older build never came through this door; an address
 * that parses but carries a page is read as its server ([serverOf]).
 */
sealed interface OriginCheck {
  /** Fit to store: an http(s) origin with no trailing slash, so a path can be appended as-is. */
  data class Ok(val origin: String) : OriginCheck

  /** Not saved. [why] is written for the owner and says what to type instead. */
  data class Refused(val why: String) : OriginCheck
}

/**
 * Hosts a plain http:// address may name. The same two the network security
 * config lets through (res/xml/network_security_config.xml): a laptop reached
 * from the emulator, and this device. Anything else over http would carry the
 * session cookie in the clear, and the platform refuses it anyway — accepting it
 * here would only move the refusal somewhere the owner cannot read it.
 */
private val CLEARTEXT_HOSTS = setOf("10.0.2.2", "localhost")

/**
 * Check [raw] as a Server address. Blank means "the default again" and gives
 * [fallback], so clearing the field is how an owner gets back to the hosted
 * service.
 */
fun checkOrigin(raw: String, fallback: String): OriginCheck {
  val trimmed = raw.trim().trimEnd('/')
  if (trimmed.isEmpty()) return OriginCheck.Ok(fallback.trimEnd('/'))
  // The mistake that crashed the app, named as what it is. Without a scheme
  // the parser has nothing to say but "not a URL", which does not tell anybody
  // what to add.
  if (!trimmed.contains("://")) {
    return OriginCheck.Refused("Start the address with https:// — for example https://app.merrymen.dev.")
  }
  val url = trimmed.toHttpUrlOrNull()
    ?: return OriginCheck.Refused("That isn't a web address. It should look like https://app.merrymen.dev.")
  // toHttpUrlOrNull accepts http and https only, so a scheme check past this
  // point is about cleartext, not about ftp:// or javascript:.
  if (url.scheme == "http" && url.host !in CLEARTEXT_HOSTS) {
    return OriginCheck.Refused(
      "Use https:// for this server. Plain http:// only works for this device (localhost) " +
        "or a laptop reached from the emulator (10.0.2.2).",
    )
  }
  // A query or a fragment would swallow every path appended after it
  // ("https://host?x=1" + "/api/feed" is a query, not a route), and a user name
  // or password in an address ends up in every log line that prints a URL.
  if (url.encodedQuery != null || url.encodedFragment != null || url.encodedUsername.isNotEmpty() ||
    url.encodedPassword.isNotEmpty()
  ) {
    return OriginCheck.Refused("Enter just the server's address, with nothing after ? or # and no user name in it.")
  }
  // A PAGE IS NOT A SERVER. Every route is appended to the stored address, so
  // "https://app.merrymen.dev/home" — the web's own sign-in page, and the
  // likeliest thing to be pasted here — made every read ask /home/api/…, and
  // every screen said "The server said no: HTTP 404" with nothing pointing at
  // this field. The trailing slash was trimmed above, so a bare origin's path
  // is "/".
  if (url.encodedPath != "/") {
    return OriginCheck.Refused(
      "Enter just the server's address, like https://app.merrymen.dev — without /home or any other page after it.",
    )
  }
  // Stored the way the parser reads it — scheme and host lowercased, a default
  // port dropped — so the same server typed two ways is one stored address.
  return OriginCheck.Ok(url.toString().trimEnd('/'))
}

/**
 * THE SERVER A STORED ADDRESS NAMES: its scheme, host and port, and nothing
 * after them. [stored] comes back as it is when it will not parse, so a caller
 * still finds out that it is not a web address.
 *
 * [checkOrigin] refuses a page, a query and a user name, but an older build
 * stored the field exactly as typed, so "https://app.merrymen.dev/home" (the
 * web's sign-in page, and the likeliest paste) is on upgraded phones. Routes
 * were appended to it, every read asked /home/api/…, and every screen said
 * "The server said no: HTTP 404" with nothing pointing at Settings.
 *
 * Nothing after the host can mean anything to this app. A merrymen server
 * keeps every route at the root of its origin (web/next.config.mjs sets no
 * basePath), and that is how the web's own "/api/…" fetches resolve from
 * whatever page they run on. So the address is read as the server it names:
 * the same host, so the same cookies and the same turn, and the app works
 * where it used to show a 404.
 */
fun serverOf(stored: String): String {
  val url = stored.trim().toHttpUrlOrNull() ?: return stored
  return HttpUrl.Builder().scheme(url.scheme).host(url.host).port(url.port).build().toString().trimEnd('/')
}

/**
 * Whether [a] and [b] name DIFFERENT SERVERS — scheme, host or port. A trailing
 * slash or a letter's case is the same server; an address that does not parse
 * is treated as different, because nothing can be said about what it was.
 */
fun isOtherServer(a: String, b: String): Boolean {
  val x: HttpUrl = a.trim().toHttpUrlOrNull() ?: return true
  val y: HttpUrl = b.trim().toHttpUrlOrNull() ?: return true
  return x.scheme != y.scheme || x.host != y.host || x.port != y.port
}
