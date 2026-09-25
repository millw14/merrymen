package dev.merrymen.app

import android.app.Application
import dev.merrymen.app.data.ChatThread
import dev.merrymen.app.data.Repository
import dev.merrymen.app.data.Social
import dev.merrymen.app.net.CookieStores
import dev.merrymen.app.net.DeviceCookies
import dev.merrymen.app.net.Http
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.Session
import dev.merrymen.app.net.SessionStore
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient

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

/**
 * WORK THAT MUST OUTLIVE A SCREEN: an order followed to its outcome after the
 * owner left the Chat tab, a reply still streaming into the thread.
 *
 * A screen's rememberCoroutineScope is cancelled with the screen, which is
 * exactly wrong for those. SupervisorJob, so one failed child does not cancel
 * its siblings; Main.immediate, so state written here reaches Compose without a
 * thread hop. It is never cancelled: it lives as long as the process does.
 *
 * A FAILURE IN IT IS A LOG LINE, NOT A PROCESS DEATH. SupervisorJob keeps the
 * siblings alive, but an exception nobody catches in a launch still goes to the
 * thread's uncaught handler, and on Android that kills the app — so one
 * malformed event in a chat stream would take down whatever screen the owner
 * was reading. [onFailure] receives it instead. Work that must SAY it failed
 * (an order whose outcome is unknown) still has to catch and say so itself;
 * this is the floor, not the handling.
 */
fun newAppScope(
  dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
  onFailure: (Throwable) -> Unit = { e -> android.util.Log.e("merrymen", "app-scoped work failed", e) },
): CoroutineScope =
  CoroutineScope(SupervisorJob() + dispatcher + CoroutineExceptionHandler { _, e -> onFailure(e) })

/**
 * THE PART OF THE GRAPH THAT DECIDES WHOSE STATE IS HELD, with no Android in it.
 *
 * The API, the per-wallet likes-and-follows store and the Repository, wired
 * the way the app runs them — including Social's forget hook, the one line
 * whose absence would hand one wallet's likes to the next. A JVM test builds
 * this over a MockWebServer and fakes of the two stores and signs a wallet out.
 */
class AppGraph(http: OkHttpClient, store: SessionStore, cookies: CookieStores) {
  // READS RECOVER, WRITES NEVER REPEAT. The shared client retries nothing, so
  // a write whose answer is lost is looked up rather than sent twice; a read
  // that meets a stale pooled connection (common after the app sat in the
  // background) is asked again instead of showing "Can't reach merrymen".
  val api = MerrymenApi(http, store, recoverReads = true)
  val social = Social(api)
  val repo = Repository(api, store, cookies).also { repo ->
    // Likes and follows are per-wallet facts and must not outlive the wallet
    // they belong to — on sign-out, when another wallet signs in, or when the
    // app moves to another server.
    repo.addForgetHook { social.forget() }
  }
}

class AppContainer(app: Application) {
  /** Outlives every screen. See [newAppScope]. */
  val appScope = newAppScope()

  val session = Session(app)
  val cookieJar = PersistentCookieJar(session)
  val http = Http.client(cookieJar)
  private val graph = AppGraph(http, session, DeviceCookies(cookieJar))
  val api = graph.api
  val social = graph.social
  val repo = graph.repo

  /** The app-wide chat thread. Registers its own forget hook. */
  val chat = ChatThread(app, api, repo, appScope)
}
