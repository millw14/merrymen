package dev.merrymen.app

import android.app.Application
import dev.merrymen.app.data.ChatThread
import dev.merrymen.app.net.Http
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

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
  /**
   * WORK THAT MUST OUTLIVE A SCREEN: an order followed to its outcome after the
   * owner left the Chat tab, a reply still streaming into the thread.
   *
   * A screen's rememberCoroutineScope is cancelled with the screen, which is
   * exactly wrong for those. SupervisorJob, so one failed child does not cancel
   * its siblings; Main.immediate, so state written here reaches Compose without
   * a thread hop. It is never cancelled: it lives as long as the process does.
   */
  val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

  val session = Session(app)
  val cookieJar = PersistentCookieJar(session)
  val http = Http.client(session, cookieJar)
  val api = dev.merrymen.app.net.MerrymenApi(http, session)
  val social = dev.merrymen.app.data.Social(api)
  val repo = dev.merrymen.app.data.Repository(api, session, cookieJar).also { repo ->
    // Likes and follows are per-wallet facts and must not outlive the wallet
    // they belong to — on sign-out, or when another wallet signs in.
    repo.addForgetHook { social.forget() }
  }

  /** The app-wide chat thread. Registers its own forget hook. */
  val chat = ChatThread(app, api, repo, appScope)
}
