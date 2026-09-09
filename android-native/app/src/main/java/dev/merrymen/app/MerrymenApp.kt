package dev.merrymen.app

import android.app.Application
import dev.merrymen.app.net.Http
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.Session

/**
 * MANUAL DEPENDENCY WIRING, ON PURPOSE.
 *
 * Hilt would be idiomatic and is the wrong trade here. This app has one graph,
 * one scope and about eight singletons; annotation processing buys nothing for
 * that and costs a KSP/AGP version alignment that fails at build time with a
 * message about a generated class nobody wrote. A container you can read top to
 * bottom is easier to keep correct than a graph you cannot see.
 */
class MerrymenApp : Application() {
  lateinit var container: AppContainer
    private set

  override fun onCreate() {
    super.onCreate()
    container = AppContainer(this)
  }
}

class AppContainer(app: Application) {
  val session = Session(app)
  val cookieJar = PersistentCookieJar(session)
  val http = Http.client(session, cookieJar)
  val api = dev.merrymen.app.net.MerrymenApi(http, session)
  // Before the repository, which clears it on sign-out: likes and follows are
  // per-wallet facts and must not outlive the wallet they belong to.
  val social = dev.merrymen.app.data.Social(api)
  val repo = dev.merrymen.app.data.Repository(api, session, cookieJar, social)
}
