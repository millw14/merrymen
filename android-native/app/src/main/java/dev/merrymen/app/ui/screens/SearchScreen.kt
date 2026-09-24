package dev.merrymen.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.SearchResults
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.EmptyKind
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PagePadTop
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.sans
import kotlinx.coroutines.launch

/** `.search` — terminal.css:2206: the one input in the terminal set to 16px. */
private val SearchText = TextStyle(
  fontFamily = sans(16.sp),
  fontSize = 16.sp,
  fontWeight = FontWeight.W400,
  color = MerryColors.tx,
)

/**
 * `.search` — terminal.css:2188-2196 and :2206:
 * `width: 100%; background: var(--card); border: 0; border-radius: 14px; padding: 13px 14px; font-size: 16px`
 *
 * BORDERLESS, and a bigger face than any other input in the app. It is not the
 * 46px/12px-radius/hairlined form field: that vocabulary belongs to
 * `.terminal-form-page`, which this screen is not on.
 */
@Composable
private fun SearchField(
  value: String,
  onValueChange: (String) -> Unit,
  modifier: Modifier = Modifier,
  focusRequester: FocusRequester? = null,
) {
  val shape = RoundedCornerShape(14.dp)
  Box(
    modifier
      .fillMaxWidth()
      .clip(shape)
      .background(MerryColors.card)
      .padding(horizontal = 14.dp, vertical = 13.dp),
    contentAlignment = Alignment.CenterStart,
  ) {
    var field = Modifier.fillMaxWidth()
    if (focusRequester != null) field = field.focusRequester(focusRequester)
    BasicTextField(
      value = value,
      onValueChange = onValueChange,
      modifier = field.semantics { contentDescription = "Search tokens or agents" },
      singleLine = true,
      textStyle = SearchText,
      cursorBrush = SolidColor(MerryColors.tx),
      decorationBox = { inner ->
        Box(contentAlignment = Alignment.CenterStart) {
          if (value.isEmpty()) {
            Text("Search tokens or agents", style = SearchText, color = MerryColors.tx2)
          }
          inner()
        }
      },
    )
  }
}

@Composable
fun SearchScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var q by remember { mutableStateOf("") }
  var state by remember { mutableStateOf<Loaded<SearchResults>>(Loaded.Idle) }
  val scope = rememberCoroutineScope()
  val focus = remember { FocusRequester() }

  // `autoFocus` on the input — Search.tsx:43. Somebody who opened search wants
  // to type; the web does not make them tap the field first.
  //
  // GUARDED, because `requestFocus` throws if the node is not attached yet and
  // the ordering of a LaunchedEffect against first layout is not something this
  // screen should bet on. Losing the keyboard is a small miss; crashing on the
  // way into search is not.
  LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    // `.find-bar` — terminal.css:2364: `display: flex; align-items: center; gap: 10px; margin-bottom: 8px`,
    // the back control then a field that flexes to fill. THERE IS NO TITLE ON
    // THIS SCREEN — Search.tsx:38-52 renders the bar and nothing above it.
    Row(
      Modifier
        .fillMaxWidth()
        .padding(start = PagePadH, end = PagePadH, top = PagePadTop, bottom = 8.dp),
      horizontalArrangement = Arrangement.spacedBy(10.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      BackControl({ nav.popBackStack() })
      SearchField(
        value = q,
        onValueChange = {
          q = it
          scope.launch {
            if (it.isBlank()) state = Loaded.Idle
            else {
              state = Loaded.Loading
              state = c.api.search(it).toLoaded()
            }
          }
        },
        modifier = Modifier.weight(1f),
        focusRequester = focus,
      )
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH)) {
      LoadedBlock(state) { r ->
        if (r.hits.isEmpty()) {
          Empty("Nothing matched", "No token or agent by that name.", kind = EmptyKind.Search)
        } else {
          r.hits.forEach { h ->
            TokRow(
              seed = h.title.orEmpty(),
              title = h.title.orEmpty(),
              sub = h.sub,
              modifier = Modifier.clickable {
                // The server hands back its own web path; turn it into our route
                // rather than re-deriving the destination from the kind field.
                val href = h.href.orEmpty()
                when {
                  href.startsWith("/t/") -> nav.navigate(Routes.token(href.removePrefix("/t/")))
                  href.startsWith("/a/") -> nav.navigate(Routes.agent(href.removePrefix("/a/")))
                }
              },
            )
          }
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}
