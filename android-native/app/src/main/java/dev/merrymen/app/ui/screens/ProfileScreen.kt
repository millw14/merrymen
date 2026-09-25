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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.GrantView
import dev.merrymen.app.net.said
import dev.merrymen.app.ui.Avatar
import dev.merrymen.app.ui.BottomInsetSpacer
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Money
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.OwnBook
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PageTitle
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.accountControlsOf
import dev.merrymen.app.ui.modeChipOf
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.ownAgentName
import dev.merrymen.app.ui.ownBookOf
import dev.merrymen.app.ui.pnlLineOf
import dev.merrymen.app.ui.sans
import dev.merrymen.app.ui.shortAddress
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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
 * THE TITLE STAYS "You". `You.tsx:50` says "Profile", but the tab this screen
 * sits on is labelled "You" in Shell.kt; a page heading that disagreed with the
 * tab that opened it would be worse than the mismatch with the web.
 *
 * WHOSE ACCOUNT THIS IS decides everything below the title ([ownBookOf]): a
 * signed-out reader's feed is the house fallback, and an unreadable one is our
 * failure — neither is drawn as a balance, an agent card or a picture to change.
 *
 * SIGN-IN IS OFFERED ONLY WHERE IT EXISTS (repo.canOfferSignIn: hosted, and
 * nobody signed in). A self-hosted install answers the session route with
 * {hosted:false, address:null}; it has no sign-in, and a "Not signed in — Sign
 * in" banner there sent owners to a web page that does not apply.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val signedIn by c.repo.signedIn.collectAsState()
  val hosted by c.repo.hosted.collectAsState()
  val canOfferSignIn by c.repo.canOfferSignIn.collectAsState()
  val reads = remember(signedIn) { OwnReads() }
  var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
  var refreshing by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  val lifecycle = LocalLifecycleOwner.current.lifecycle

  suspend fun load() {
    reads.load(c.api, signedIn, c.repo.hosted.value, withStrip = false, nowMs = { System.currentTimeMillis() }) {
      c.repo.refreshIdentity()
    }
    nowMs = System.currentTimeMillis()
  }
  LaunchedEffect(signedIn, lifecycle) {
    lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
      while (true) {
        load()
        delay(60_000)
      }
    }
  }
  val book = ownBookOf(reads.feed, signedIn, hosted, canOfferSignIn)
  val controls = accountControlsOf(signedIn, hosted, canOfferSignIn)
  val pull = rememberPullToRefreshState()

  PullToRefreshBox(
    isRefreshing = refreshing,
    onRefresh = {
      scope.launch {
        refreshing = true
        load()
        refreshing = false
      }
    },
    state = pull,
    modifier = Modifier.fillMaxSize(),
    indicator = {
      PullToRefreshDefaults.Indicator(
        state = pull,
        isRefreshing = refreshing,
        modifier = Modifier.align(Alignment.TopCenter),
        containerColor = MerryColors.card,
        color = MerryColors.tx,
      )
    },
  ) {
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
      SignedInNotice()

      if (controls.signInBanner) {
        Notice(
          title = "Not signed in",
          body = "Signing in proves you control your owner key. It moves no funds and grants no permissions.",
          actionLabel = "Sign in",
          onAction = { nav.navigate(Routes.SIGN_IN) },
        )
      }

      when (book) {
        OwnBook.Loading -> LoadedBlock(Loaded.Loading) { _: Unit -> }
        is OwnBook.Failed -> LoadedBlock(
          book.state,
          onSignIn = if (canOfferSignIn) ({ nav.navigate(Routes.SIGN_IN) }) else null,
          onRetry = { scope.launch { load() } },
        ) { _: Unit -> }
        // The banner above is the whole answer for a signed-out reader; this
        // only says what the page is for, and claims nothing about an account.
        is OwnBook.SignedOut -> Prose("Your agents belong here.", 15.sp, 20.25.sp, MerryColors.tx2)
        OwnBook.Unreadable -> Notice(
          title = "Couldn't read your book just now",
          body = "merrymen answered, but your agent's ledger could not be read — that's our read failing, " +
            "not a fact about your account.",
          actionLabel = "Try again",
          onAction = { scope.launch { load() } },
        )
        is OwnBook.Mine -> {
          val g = (reads.grants as? Loaded.Value)?.value
          if (g != null && !g.exists) {
            Notice(
              title = "Your agents belong here",
              body = "Create an agent to manage your portfolio and follow its trades here.",
              actionLabel = "Create an agent",
              onAction = { nav.navigate(Routes.web("/create", "Create an agent")) },
            )
          } else {
            staleLine(reads.feedFailure, reads.feedAtMs, nowMs)?.let { Prose(it, 13.sp, 18.85.sp, MerryColors.tx2) }
            AccountPerson(signedIn, g)
            AccountBalance(book.feed, g, nav)
            YourAgent(book.feed, g, nav)
            AccountNameChip(c.api, book.feed.agent, reads.readFor, hosted, onNamed = { scope.launch { load() } })
            // PICTURES ARE HOSTED-ONLY and belong to an agent that exists: the
            // route answers 404 self-hosted, and a picture needs a slug to
            // belong to. The owner they are for is the one this page was read for.
            val slug = book.feed.agent?.slug
            if (hosted == true && reads.readFor != null && slug != null) {
              AccountPictures(c.api, slug, reads.readFor)
            }
          }
        }
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
        // reimplementation of key custody.
        Prose(
          text = "Trading limits, wallet permissions and creating an agent need your owner key, " +
            "so they open the merrymen web app inside this one. This app never holds a key.",
          size = 13.sp,
          lineHeight = 19.5.sp,
          color = MerryColors.tx2,
          modifier = Modifier.padding(top = 12.dp),
        )
      }

      // THE KILL SWITCH, for whoever this server acts for: a signed-in owner
      // hosted, or the one operator of a self-hosted box (which has no session
      // at all, and whose DELETE /api/grants needs none). See accountControlsOf.
      if (controls.stop) StopControl()

      // SIGN OUT ONLY WHERE THERE IS A SESSION TO END. `.profile-session-actions
      // button` — polish.css:75-76: #f47777, min-height 44px, 15px.
      if (controls.signOut) {
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
}

/**
 * THE KILL SWITCH. revokeGrant() (DELETE /api/grants) stands the worker down.
 * It arms then confirms, the way KillSwitch.tsx does, because a single tap on
 * "stop everything" is too easy to hit by accident. DESTRUCTIVE in the true
 * sense (`--down`): re-arming needs a fresh signature, which is a web handoff.
 *
 * A LOST ANSWER IS NOT "it didn't stop". The grant may be gone. So the status
 * route is asked, and the owner is told what it says — stopped, or still
 * armed and theirs to stop again — rather than a failure that may be false.
 */
@Composable
private fun StopControl() {
  val c = LocalContainer.current
  val scope = rememberCoroutineScope()
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
                is ApiResult.Ok ->
                  "Stopped. Your agent will not trade again until you re-sign its permission."
                is ApiResult.Refused ->
                  if (r.status == 401) "Sign in first. Nothing was stopped." else r.message
                is ApiResult.Unreachable -> when (val after = c.api.grants()) {
                  is ApiResult.Ok -> if (!after.value.exists) {
                    "Stopped. Your agent will not trade again until you re-sign its permission."
                  } else {
                    "Couldn't tell whether that went through (${r.said.trimEnd('.')}), and your agent's " +
                      "permission is still in place. Tap again to stop it."
                  }
                  else -> "Couldn't tell whether your agent stopped — ${r.said.trimEnd('.')}, and its " +
                    "status could not be read back. Look again before trying again."
                }
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
}

/**
 * `.account-person` — polish.css:124-127: a flex row at `gap: 14px` holding a
 * 48px circle, then the name at 19px/600, then the agent-count line at 14px
 * `--faint`, and the `.profile-mode` chip.
 *
 * THE LABEL IS THE SIGNED-IN WALLET, the one fact about the reader this app
 * actually holds — /api/feed sends no owner field, so the old reading of one
 * always fell to "You". The glyph is "◎" for an address, as the web draws it.
 *
 * THE MODE CHIP is the heartbeat's own LIVE / PAPER / IDLE, and nothing when it
 * reported none: a chip defaulted to "Offline" would state a fact nobody read.
 *
 * "1 agent" IS A LITERAL in the web (`You.tsx:59`), not a count.
 */
@Composable
private fun AccountPerson(signedIn: String?, g: GrantView?) {
  val label = shortAddress(signedIn) ?: "You"
  val glyph = if (signedIn?.startsWith("0x") == true) "◎" else "Y"
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
    modeChipOf(g?.takeIf { it.exists }?.mode)?.let { AccountModeTag(it) }
  }
}

/**
 * `.account-balance` — a plain block (polish.css:128-130): the label at 15px,
 * the figure at 54px of Geist Pixel. `money(null)` is the em dash, NEVER "$0.00".
 *
 * THE DAILY CHANGE STAYS "Daily change unavailable". The web's "+$X today" is
 * raw equity, which counts a same-day deposit as a gain, and /api/feed carries
 * no dated flows to take one out. The all-time line under it is net of
 * contributions and gas, and appears only where every term is evidence
 * (pnlLineOf) — on a live book, with fills, and a deposit history the worker
 * vouches for.
 */
@Composable
private fun AccountBalance(f: Feed, g: GrantView?, nav: NavHostController) {
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
      modifier = Modifier.padding(top = 8.dp),
    )
    pnlLineOf(f, g?.mode)?.let { p ->
      Prose(p.text, 14.sp, 21.sp, if (p.usd < 0) MerryColors.down else MerryColors.up, weight = FontWeight.W500, modifier = Modifier.padding(top = 4.dp))
    }

    // `.profile-funding` — polish.css:57-58 and :132: two equal columns,
    // `gap: 10px`, `margin-top: 18px`. WITHDRAW IS NOT STYLED AS DESTRUCTIVE.
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
 *
 * The name is the one the owner SET (settings or ledger); the house fallback is
 * "Your agent", never "Robin" presented as theirs.
 */
@Composable
private fun YourAgent(f: Feed, g: GrantView?, nav: NavHostController) {
  val agent = f.agent
  val name = ownAgentName(agent) ?: "Your agent"
  val shape = RoundedCornerShape(14.dp)
  Column(Modifier.fillMaxWidth()) {
    AccountHeading("Your agent", count = "1")
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
      Avatar(name = name, size = 44.dp)
      Column(Modifier.weight(1f)) {
        Text(
          text = name,
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
      Column(horizontalAlignment = Alignment.End) {
        // `money(null)` is "—". An unread portfolio is not an empty one.
        Money(f.equityNow, bold = true)
        modeChipOf(g?.takeIf { it.exists }?.mode)?.let {
          Prose(it, 12.sp, 16.sp, MerryColors.tx2, modifier = Modifier.padding(top = 3.dp))
        }
      }
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
