# merrymen for Android — native Kotlin client

Jetpack Compose, Material 3, Kotlin 2.0. A native client for the merrymen API.

> **Not built on this machine.** There is no JDK, Gradle or Android SDK on the
> workstation this was written on, so **none of this has been compiled, linted
> or run**. It is written to compile, and the parts that are easy to get wrong
> without a compiler are called out at the bottom. Treat the first `./gradlew
> assembleDebug` as the real review.

```bash
# from android-native/
./gradlew assembleDebug
./gradlew installDebug
# point it somewhere else at build time:
./gradlew assembleDebug -Pmerrymen.origin=http://10.0.2.2:3100
```

`minSdk 26`, `targetSdk 35`.

---

## The one architectural decision

**This app does not hold a private key, and the four operations that need one
are handed to the web app inside a WebView.**

The API is cookie-authenticated, and getting the cookie costs a signature:
`GET /api/auth/challenge` returns an EIP-191 message naming the origin and a
single-use nonce; you sign it with the **owner** key; `POST /api/auth/verify`
returns `mm_session`.

The owner key is not the trading key. It is the sudo validator on the smart
account — the key that signs the permission wall itself. The session key signs
trades, and lives in the worker. The Expo client at `mobile/` keeps a 12-word
BIP-39 mnemonic in the platform keystore and is largely built around guarding
it; the web client never holds one at all, because Privy keeps it behind the
user's login.

Re-implementing BIP-39, secure-element custody and ERC-4337 grant signing in a
third client would triple the surface on which somebody's entire account can be
lost, to save one screen. So the key stays where it already lives and the
WebView borrows it: the user signs in against the real web app, inside this app,
and the only thing that crosses back out is the cookie.

`WebAuth.harvest()` is the whole trick — a WebView's cookie jar and OkHttp's are
separate stores, so a cookie set in the page is invisible to the API layer until
it is copied across. `mm_session` and `mm_gate` are both `httpOnly`, so no page
script could read them; `CookieManager`, being the platform's own store, can.
That is why the bridge is native code and not injected JavaScript.

**What this costs, stated rather than discovered:** arming or re-signing a
grant, changing sealed trading limits, the recovery sweep, and proving a holder
wallet all open the web app's own screen for that action. They are signature
ceremonies. They belong where the key is.

---

## What is native

| Screen | Endpoints |
|---|---|
| Home — portfolio, positions, agent warning, Circle lock banner | `/api/feed`, `/api/tier` |
| Feed — filters, honest verbs | `/api/theses` |
| Chat — full conversation with the agent | `/api/chat` |
| Alpha — three-state lock | `/api/alpha` |
| You — identity, controls, handoffs, sign out | `/api/feed`, `/api/grants` |
| Markets, Token detail | `/api/tokens` |
| Search | `/api/search` |
| Leaderboard, Agent detail | `/api/leaderboard`, `/api/theses` |
| The Merry Circle | `/api/circle` |
| Telegram — connection, **link code**, owner chat | `/api/telegram` |
| Settings — server, site gate, practice reset | `/api/settings`, `/api/gate`, `/api/paper-reset` |

`MerrymenApi` covers the wider surface too — orders, snipe, proposals, selftest,
follow, likes, models, holder link/unlink, grant revoke (the kill switch),
market, venue, wall, wall-tape, discoveries, agents, scoreboard, like-counts.

## Three rules carried across from the server

1. **Null is not zero.** Every figure that can be unknown is a nullable box.
   `Money(null)` renders `—`, never `$0.00`. `$0.00` says we asked and the
   answer was nothing; `—` says we never got an answer, and only one of those
   should send somebody to buy tokens they may already hold.
2. **Three states, not two.** `ApiResult`/`Loaded` keep *a value*, *the server
   said no* (with its status, so 401 and 503 stay apart) and *we never reached
   it* distinct all the way to the pixel. `LoadedBlock` renders each with its
   own next action.
3. **A refused trade is not a purchase.** `verbOf()` gives past tense only to
   `landed`; a refused buy reads "tried to buy", and `toneOf()` refuses it the
   green that means money moved.

## Headers: what a non-browser must not send

The API middleware rejects a request whose `Sec-Fetch-Site` is cross-site. A
native client sends none, which reads as `none` and is allowed. **Do not add an
`Origin` header to look more like a browser** — that is the header that would
get every request refused. Against a *self-hosted* install the host allowlist is
active, so the `Host` must be loopback or private-LAN.

## Known gaps

- **Settings is read-only here**, with an "edit on the web screen" handoff. The
  server's settings object has ~60 validated fields; a native form that PUT a
  subset would silently unset everything it does not render — the exact
  read-modify-write hazard that has already erased a basket and an allowlist in
  this repo. Per-field editors need to be built against the server's validation,
  not guessed.
- No offline cache, no push, no widgets.
- `AgentDetailScreen` filters the public thesis window client-side rather than
  reading a per-agent endpoint.

## Most likely to be wrong on first compile

Written without a compiler, so in rough order of risk:

1. Compose BOM / AGP / Kotlin 2.0 alignment in `gradle/libs.versions.toml`.
2. `StateFlow.collectAsState()` import — `androidx.compose.runtime`.
3. OkHttp 4.x uses **methods** (`response.code()`, `body()`, `HttpUrl.get()`),
   not Kotlin properties. Moving to OkHttp 5 changes all of those.
4. `Modifier.clickable` on `SectionCard` passes through to its outer `Column`.
5. The suspend-`load()`-inside-composable pattern is deliberate and compiles,
   but every call site must be inside a coroutine or a `LaunchedEffect`.
