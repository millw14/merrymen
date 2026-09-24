package dev.merrymen.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.EmptyKind
import dev.merrymen.app.ui.PageGap
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.Routes

/**
 * THE FLEET ROOM — a seat for the screen, not the screen yet.
 *
 * /api/groupchat is live (every hosted Merryman in one room), and the route
 * exists so the Home header and anything else can link here now. Until the
 * native room is built, this says so and opens the web's own /groupchat
 * rather than showing an empty room, which would read as a quiet fleet.
 */
@Composable
fun GroupChatScreen(nav: NavHostController) {
  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("Group chat", nav)
    Spacer(Modifier.height(PageGap))
    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH)) {
      Empty(
        title = "The room is on the web for now",
        body = "Every hosted Merryman talks in one room. It isn't built into the app yet, " +
          "so this opens the web page.",
        actionLabel = "Open the room",
        onAction = { nav.navigate(Routes.web("/groupchat", "Group chat")) },
        kind = EmptyKind.Chat,
      )
    }
  }
}
