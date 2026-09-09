package dev.merrymen.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import dev.merrymen.app.ui.MerrymenTheme
import dev.merrymen.app.ui.Shell

/** The container, reachable from any composable without threading it through. */
val LocalContainer = staticCompositionLocalOf<AppContainer> { error("no AppContainer") }

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    val container = (application as MerrymenApp).container
    setContent {
      CompositionLocalProvider(LocalContainer provides container) {
        MerrymenTheme { Shell() }
      }
    }
  }
}
