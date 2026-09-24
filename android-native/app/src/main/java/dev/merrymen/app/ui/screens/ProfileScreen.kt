package dev.merrymen.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.Feed
import dev.merrymen.app.ui.Avatar
import dev.merrymen.app.ui.BottomInsetSpacer
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Money
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PageTitle
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.sans
import dev.merrymen.app.ui.shortAddress
import kotlinx.coroutines.launch
import java.util.Locale

/** lucide `ChevronRight`, 18px, at the end of every account row. */
@Composable
private fun ChevronRight(tint: Color, size: Dp = 18.dp) =
  StrokeGlyph("m9 18 6-6-6-6", tint = tint, size = size)

/** `polish.css:75` — the sign-out red, which is deliberately NOT `--down`. */
private val SignOutRed = Color(0xFFF47777)

/** `.account-section-title h2` — `polish.css:134`: 19px, weight 600. */
@Composable
private fun AccountHeading(text: String, count: String? = null) {
  Row(
    Modifier.fillMaxWidth().padding(bottom = 12.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      text = text,
      style = TextStyle(
        fontFamily = sans(19.sp, FontWeight.W600),
        fontSize = 19.sp,
        fontWeight = FontWeight.W600,
        letterSpacing = (-0.02).em,
      ),
      color = MerryColors.tx,
    )
    // `polish.css:135` strips the chip styling the base sheet gave this: it is a
    // bare 12px faint number, not a pill.
    if (count != null) {
      Text(
        text = count,
        style = TextStyle(fontFamily = numerals(FontWeight.W400), fontSize = 12.sp),
        color = MerryColors.faint,
      )
    }
  }
}

/**
 * YOU — a flat, borderless page with exactly one card on it.
 *
 * `polish.css:122`: `.account-page { display: flex; flex-direction: column;
 * gap: 24px; padding: 0 }`, and `polish.css:133` strips the border, padding and
 * margin off every `.account-section`. Whitespace is the ONLY divider.
 *
 * ONE ELEMENT ON THIS SCREEN IS A CARD — the agent row (`polish.css:136`) — plus
 * the grouped account rows, which are one card built out of several. The balance
 * block, the sections and the header are backgroundless and borderless; the base
 * sheet's rules that boxed them are flattened to `border-radius: 0` by later
 * unconditional rules. Material's Card and Button will silently box all of it,
 * which changes what reads as "a thing the system knows" versus "a page of
 * prose", so nothing here uses them.
 *
 * THE TITLE STAYS "You". `You.tsx:50` says "Profile", but the tab this screen
 * sits on is labelled "You" in Shell.kt and Shell is out of scope for this pass;
 * a page heading that disagreed with the tab that opened it would be worse than
 * the mismatch with the web. Noted in the hand-off.
 */
@Composable
fun ProfileScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val signedIn by c.repo.signedIn.collectAsState()
  val identityKnown by c.repo.identityKnown.collectAsState()
  var feed by remember { mutableStateOf<Loaded<Feed>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  LaunchedEffect(Unit) { feed = c.api.feed().toLoaded() }

  Column(
    Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState())
      .padding(horizontal = PagePadH)
      // `.body:has(> .account-page) { padding-top: 20px }` — polish.css:180.
      .padding(top = 20.dp),
    verticalArrangement = Arrangement.spacedBy(24.dp),
  ) {
    PageTitle("You")

    // ONLY WHEN WE KNOW YOU ARE SIGNED OUT. While identity is unknown (the
    // session route has not answered, or the server was unreachable), a "Not
    // signed in" banner would be a claim about the reader that nobody checked;
    // the feed's own LoadedBlock below says what actually went wrong instead.
    if (identityKnown && signedIn == null) {
      Notice(
        title = "Not signed in",
        body = "Signing in proves you control your owner key. It moves no funds and grants no permissions.",
        actionLabel = "Sign in",
        onAction = { nav.navigate(Routes.SIGN_IN) },
      )
    }

    LoadedBlock(feed) { f ->
      AccountPerson(f)
      AccountBalance(f, nav)
      YourAgent(f, nav)
    }

    // The three controls that belong to the agent rather than to the account.
    Column(Modifier.fillMaxWidth()) {
      AccountHeading("Controls")
      AccountGroup {
        AccountRow("Trade", first = true) { nav.navigate(Routes.TRADE) }
        AccountRow("Coins to consider") { nav.navigate(Routes.PROPOSALS) }
        AccountRow("How much risk?") { nav.navigate(Routes.RISK) }
      }
    }

    Column(Modifier.fillMaxWidth()) {
      AccountHeading("Account")
      AccountGroup {
        AccountRow("Trading limits", first = true) {
          nav.navigate(Routes.web("/limits", "Trading limits"))
        }
        AccountRow("Wallet & permissions") {
          nav.navigate(Routes.web("/grant", "Wallet & permissions"))
        }
        AccountRow("Settings") { nav.navigate(Routes.SETTINGS) }
        AccountRow("Telegram") { nav.navigate(Routes.TELEGRAM) }
        AccountRow("The Merry Circle") { nav.navigate(Routes.CIRCLE) }
        AccountRow("Create an agent") {
          nav.navigate(Routes.web("/create", "Create an agent"))
        }
      }
      // EVERY ONE OF THE SIGNATURE-BEARING ROWS ENDS IN A CEREMONY, so every one
      // of them is a handoff to the web app rather than a native
      // reimplementation of key custody. The web gives these rows no warning
      // styling at all and neither do these; the sentence carries it instead.
      Prose(
        text = "Trading limits, wallet permissions and creating an agent need your owner key, " +
          "so they open the merrymen web app inside this one. This app never holds a key.",
        size = 13.sp,
        lineHeight = 19.5.sp,
        color = MerryColors.tx2,
        modifier = Modifier.padding(top = 12.dp),
      )
    }

    if (signedIn != null) {
      // THE KILL SWITCH, WHICH WAS DECLARED AND NEVER WIRED. revokeGrant()
      // (DELETE /api/grants) stands the worker down, and nothing in the app
      // reached it — a stop control you cannot find is not a stop control. It
      // arms then confirms, the way KillSwitch.tsx does, because a single tap on
      // "stop everything" is too easy to hit by accident. It is DESTRUCTIVE in
      // the true sense (`--down`, not the softer sign-out red): re-arming the
      // agent afterwards needs a fresh signature, which is a web handoff.
      var armed by remember { mutableStateOf(false) }
      var stopNote by remember { mutableStateOf<String?>(null) }
      Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Box(
          Modifier
            .heightIn(min = 44.dp)
            .clickable(role = Role.Button) {
              if (!armed) {
                armed = true
                stopNote = "Tap again to stop it. This revokes its trading permission until you re-sign."
              } else {
                armed = false
                scope.launch {
                  stopNote = when (val r = c.api.revokeGrant()) {
                    is dev.merrymen.app.net.ApiResult.Ok ->
                      "Stopped. Your agent will not trade again until you re-sign its permission."
                    is dev.merrymen.app.net.ApiResult.Refused ->
                      if (r.status == 401) "Sign in first." else r.message
                    is dev.merrymen.app.net.ApiResult.Unreachable ->
                      "Couldn't reach merrymen to stop it. " + r.cause
                  }
                }
              }
            },
          contentAlignment = Alignment.CenterStart,
        ) {
          Text(
            text = if (armed) "Tap again to stop your agent" else "Stop my agent",
            style = TextStyle(fontFamily = sans(15.sp, FontWeight.SemiBold), fontSize = 15.sp),
            color = MerryColors.down,
          )
        }
        stopNote?.let {
          Text(
            it,
            style = TextStyle(fontFamily = sans(13.sp), fontSize = 13.sp, lineHeight = 19.sp),
            color = MerryColors.tx2,
          )
        }
      }

      // `.profile-session-actions button` — polish.css:75-76: colour #f47777,
      // min-height 44px, 15px, transparent, no border. That red is NOT `--down`;
      // it is a softer one used only here, and keeping them apart keeps "a loss"
      // and "a destructive control" from wearing the same colour.
      Box(
        Modifier
          .heightIn(min = 44.dp)
          .clickable(role = Role.Button) { scope.launch { c.repo.signOut() } },
        contentAlignment = Alignment.CenterStart,
      ) {
        Text(
          text = "Sign out",
          style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp),
          color = SignOutRed,
        )
      }
    }
    BottomInsetSpacer()
  }
}

/**
 * `.account-person` — polish.css:124-127: a flex row at `gap: 14px` holding a
 * 48px circle, then the name at 19px/600 with `letter-spacing: -.02em`, then the
 * agent-count line at 14px `--faint`.
 *
 * THE AVATAR IS NOT A GRADIENT FACE. `terminal.css:3902-3911` (as re-sized by
 * polish.css:125) makes this one a plain `--raised` circle carrying a single
 * 24px glyph in `--tx`: the "◎" mark when the owner string is an address, and
 * otherwise the owner's first character uppercased. The earlier 52px
 * lime-on-#252c19 rounded square at terminal.css:3486 is fully overridden.
 *
 * "1 agent" IS A LITERAL in the web (`You.tsx:59`), not a count. It is not
 * pluralised here either — computing it would make the two clients disagree
 * about a number.
 *
 * THE STATUS CHIP IS NOT DRAWN. `.profile-mode` reads `mine.statusLabel`
 * ("Paper trading" / "Running" / "Idle" / "Offline") and this screen has no such
 * field; an empty chip, or one defaulted to "Offline", would state a fact about
 * the agent that nothing here read.
 */
@Composable
private fun AccountPerson(f: Feed) {
  val owner = f.agent?.owner
  val label = shortAddress(owner) ?: owner?.takeIf { it.isNotBlank() } ?: "You"
  val glyph = when {
    owner?.startsWith("0x") == true -> "◎"
    !label.isEmpty() -> label.take(1).uppercase(Locale.ROOT)
    else -> "?"
  }
  Row(
    Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(14.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      Modifier.size(48.dp).clip(CircleShape).background(MerryColors.raised),
      contentAlignment = Alignment.Center,
    ) {
      Text(
        text = glyph,
        style = TextStyle(
          fontFamily = sans(24.sp, FontWeight.W500),
          fontSize = 24.sp,
          fontWeight = FontWeight.W500,
        ),
        color = MerryColors.tx,
      )
    }
    Column(Modifier.weight(1f)) {
      Text(
        text = label,
        maxLines = 1,
        style = TextStyle(
          fontFamily = sans(19.sp, FontWeight.W600),
          fontSize = 19.sp,
          fontWeight = FontWeight.W600,
          letterSpacing = (-0.02).em,
        ),
        color = MerryColors.tx,
      )
      Prose(
        text = "1 agent",
        size = 14.sp,
        lineHeight = 18.9.sp,
        color = MerryColors.faint,
        modifier = Modifier.padding(top = 3.dp),
      )
    }
  }
}

/**
 * `.account-balance` — a plain block. `polish.css:128` sets `padding: 0;
 * margin: 0` and `terminal.css:3921` flattens its radius to 0, so the card the
 * base sheet drew here is gone.
 *
 * The label is 15px `--tx-2` with 8px under it (polish.css:129); the figure is
 * 54px of Geist Pixel at `line-height: 1.15` (polish.css:130) with the cents at
 * `0.43em` in `--tx-2` — 23px inside a 54px figure. `money(null)` is the em dash
 * and `BalanceFigure` then emits no decimals span at all, so an unread balance
 * is one dash and nothing else. NEVER "$0.00".
 *
 * THE DAILY CHANGE HAS THREE RENDERINGS AND ONLY ONE OF THEM IS COLOURED
 * (`You.tsx:68-72`): null gets the class `meta` — grey `--tx-2` — and the words
 * "Daily change unavailable"; a negative gets `--down`; anything else gets
 * `--up`. This client has no daily-change figure on this payload, so the null
 * arm is the true one and it says so in words rather than showing a dash with no
 * label. What it must never do is take the `>= 0` branch by default, which is
 * the screen saying "we don't know" in text and "it went up" in colour.
 */
@Composable
private fun AccountBalance(f: Feed, nav: NavHostController) {
  Column(Modifier.fillMaxWidth()) {
    Prose(
      text = "Portfolio balance",
      size = 15.sp,
      lineHeight = 20.25.sp,
      color = MerryColors.tx2,
      modifier = Modifier.padding(bottom = 8.dp),
    )
    PixelBalance(f.equityNow, size = 54.sp, cents = 23.sp, lineHeight = 62.1.sp)
    Prose(
      text = "Daily change unavailable",
      size = 14.sp,
      lineHeight = 21.sp,
      color = MerryColors.tx2,
      weight = FontWeight.W500,
      modifier = Modifier.padding(top = 8.dp, bottom = 16.dp),
    )

    // `.profile-funding` — polish.css:57-58 and :132: two equal columns,
    // `gap: 10px`, `margin-top: 18px`, each button 50px tall at radius 10 and
    // 16px/600. The primary is `--tx` on `--ink`; the secondary is `--card` with
    // a 1px `--line` border. WITHDRAW IS NOT STYLED AS DESTRUCTIVE — it is a
    // quiet secondary, which is the product's stated posture and not an
    // oversight to correct in a restyle.
    Row(
      Modifier.fillMaxWidth().padding(top = 18.dp),
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      FundButton("Add funds", filled = true, modifier = Modifier.weight(1f)) {
        nav.navigate(Routes.web("/deposit", "Add funds"))
      }
      FundButton("Withdraw", filled = false, modifier = Modifier.weight(1f)) {
        nav.navigate(Routes.web("/withdraw", "Withdraw"))
      }
    }
  }
}

@Composable
private fun FundButton(
  label: String,
  filled: Boolean,
  modifier: Modifier = Modifier,
  onClick: () -> Unit,
) {
  val shape = RoundedCornerShape(10.dp)
  Box(
    modifier
      .height(50.dp)
      .clip(shape)
      .background(if (filled) MerryColors.tx else MerryColors.card)
      .then(if (filled) Modifier else Modifier.border(1.dp, MerryColors.line, shape))
      .clickable(role = Role.Button, onClick = onClick)
      .padding(12.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      maxLines = 1,
      style = TextStyle(
        fontFamily = sans(16.sp, FontWeight.W600),
        fontSize = 16.sp,
        fontWeight = FontWeight.W600,
      ),
      color = if (filled) MerryColors.ink else MerryColors.tx,
    )
  }
}

/**
 * THE ONE CARDED ELEMENT ON THIS SCREEN — `.account-agent`, polish.css:136:
 * `border: 1px solid var(--line); border-radius: 14px; background: var(--card);
 * padding: 16px 12px; gap: 12px`, with a 44px face, the name at 16px/600, the
 * strategy at 13px `--tx-2` and the value right-aligned. Tapping it goes to Chat.
 */
@Composable
private fun YourAgent(f: Feed, nav: NavHostController) {
  val agent = f.agent
  val shape = RoundedCornerShape(14.dp)
  Column(Modifier.fillMaxWidth()) {
    AccountHeading("Your agent", count = if (agent != null) "1" else null)
    Row(
      Modifier
        .fillMaxWidth()
        .clip(shape)
        .background(MerryColors.card)
        .border(1.dp, MerryColors.line, shape)
        .clickable(role = Role.Button) { nav.navigate(Routes.CHAT) }
        .padding(horizontal = 12.dp, vertical = 16.dp),
      horizontalArrangement = Arrangement.spacedBy(12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Avatar(name = agent?.name ?: "No agent yet", size = 44.dp)
      Column(Modifier.weight(1f)) {
        Text(
          text = agent?.name ?: "No agent yet",
          maxLines = 1,
          style = TextStyle(
            fontFamily = sans(16.sp, FontWeight.W600),
            fontSize = 16.sp,
            fontWeight = FontWeight.W600,
          ),
          color = MerryColors.tx,
        )
        agent?.strategy?.takeIf { it.isNotBlank() }?.let {
          Prose(it, 13.sp, 18.85.sp, MerryColors.tx2, modifier = Modifier.padding(top = 5.dp))
        }
      }
      // `money(null)` is "—". An unread portfolio is not an empty one.
      Money(f.equityNow, bold = true)
    }
  }
}

/**
 * THE GROUPED ACCOUNT CARD — polish.css:141-143.
 *
 * The web builds this with `:nth-child` border-radius surgery: every row carries
 * `background: var(--card)` and a 1px `--line` border with `border-top: 0`, the
 * FIRST regains its top border and the corners `12px 12px 0 0`, and the LAST
 * takes `0 0 12px 12px`. That is a CSS-only trick. In Compose the whole column is
 * clipped once and the rows are separated by hairlines — do NOT try to give each
 * row its own shape.
 */
@Composable
private fun AccountGroup(content: @Composable ColumnScope.() -> Unit) {
  val shape = RoundedCornerShape(12.dp)
  Column(
    Modifier
      .fillMaxWidth()
      .clip(shape)
      .background(MerryColors.card)
      .border(1.dp, MerryColors.line, shape),
    content = content,
  )
}

/**
 * One row of it — `min-height: 64px; padding: 14px; gap: 14px` with the label at
 * 16px/600 `--tx` and a trailing 18px chevron in `--tx-2`.
 *
 * THE LEADING 24px LUCIDE ICON IS NOT DRAWN. The web gives each row a glyph
 * (SlidersHorizontal, Wallet, Settings, …); nine of them would have to be
 * hand-transcribed here, and a hand-drawn approximation of an icon set is the
 * kind of "close enough" this whole exercise exists to stop. Label and chevron
 * only, and it is stated rather than quietly dropped.
 */
@Composable
private fun ColumnScope.AccountRow(
  label: String,
  sub: String? = null,
  first: Boolean = false,
  onClick: () -> Unit,
) {
  Row(
    Modifier
      .fillMaxWidth()
      .heightIn(min = 64.dp)
      .then(
        if (first) {
          Modifier
        } else {
          Modifier.drawBehind { drawRect(MerryColors.line, size = Size(size.width, 1.dp.toPx())) }
        },
      )
      .clickable(role = Role.Button, onClick = onClick)
      .padding(14.dp),
    horizontalArrangement = Arrangement.spacedBy(14.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(Modifier.weight(1f)) {
      Text(
        text = label,
        style = TextStyle(
          fontFamily = sans(16.sp, FontWeight.W600),
          fontSize = 16.sp,
          fontWeight = FontWeight.W600,
        ),
        color = MerryColors.tx,
      )
      sub?.let {
        Prose(it, 13.sp, 19.5.sp, MerryColors.tx2, modifier = Modifier.padding(top = 5.dp))
      }
    }
    ChevronRight(MerryColors.tx2)
  }
}
