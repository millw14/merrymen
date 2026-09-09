# merrymen for Android — native Kotlin client

Jetpack Compose, Material 3, Kotlin 2.2. A native client for the merrymen API.

> **It builds.** `assembleDebug` produces an 18 MB debug APK.
>
> An earlier version of this file said the machine had no toolchain and that
> nothing here had been compiled. That was wrong: Android Studio’s bundled JDK
> (`jbr`, OpenJDK 25) and a full SDK were both installed, just not on `PATH`.
> The version matrix guessed at the time — AGP 8.7.3 with Kotlin 2.0.21 — could
> not have worked on Gradle 9.3.1 or JDK 25; it is now AGP 8.13.1 with Kotlin
> 2.2.20 and `compileSdk` 36.
>
> This file also had the OkHttp guidance **backwards**. It said 4.x uses
> methods rather than properties; that describes 3.x. In 4.x those became
> `val`s and the method forms are `DeprecationLevel.ERROR`, so `response.code()`
> is a compile error, not a warning. Eight call sites had to move to property
> form.

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
| Feed — filters, most-liked sort, hearts | `/api/theses`, `/api/likes`, `/api/like-counts` |
| Chat — full conversation, plus the propose/confirm card | `/api/chat`, and whatever the confirmed command writes |
| Alpha — three-state lock | `/api/alpha` |
| You — identity, controls, handoffs, sign out | `/api/feed`, `/api/auth/session` |
| Markets | `/api/market` |
| Token — chart over six spans, holders, star, share, copy | `/api/tokens/{address}`, `/api/venue?desk=chart` |
| Search | `/api/search` |
| Leaderboard | `/api/leaderboard` |
| Agent desk — owner line, **wire in** with its budget, likes | `/api/theses`, `/api/follow` |
| Coins to consider — approve into basket and watchlist | `/api/proposals`, `/api/settings` |
| Trade — buy, sell, snipe, with the order followed after it is placed | `/api/orders`, `/api/snipe` |
| How much risk — one word into six settings | `/api/settings` |
| The Merry Circle | `/api/circle` |
| Telegram — connection, **link code**, owner chat | `/api/telegram` |
| Settings — a real editor, plus server, site gate, practice reset | `/api/settings`, `/api/gate`, `/api/paper-reset` |

`MerrymenApi` covers the wider surface too — selftest, models, holder
link/unlink, grant revoke (the kill switch), wall, wall-tape, discoveries,
agents, scoreboard.

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

- No offline cache, no push, no widgets.
- `AgentDetailScreen` filters the public thesis window client-side rather than
  reading a per-agent endpoint.
- The **watchlist is device-local**, in DataStore, the way the web's is
  device-local in `localStorage`. Starring here does not star on the web. There
  is no server route for it and inventing one would put a per-caller read in
  front of a page that does not otherwise need one.
- **Search results carry no owner line.** `/api/search` answers
  `{kind, href, title, sub}` and no handle, so there is nothing to render; the
  owner appears everywhere the API actually sends one.

## What the compiler actually found

Kept because the list is more useful than the guesses it replaced:

1. **A KDoc containing `/api/` + `*` opened a nested block comment.** Kotlin
   nests them, so one glob in a doc comment swallowed the rest of the file and
   surfaced as "Missing `}`" a hundred lines away — which then made every
   `c.api.*` call site an unresolved reference.
2. **Eight OkHttp calls in method form**, all `DeprecationLevel.ERROR`.
3. `Preferences.MutablePreferences` is a **top-level** class, not nested.
4. Wrong endpoints: `/api/tokens` has no list route (it is `/api/market`), and
   `/api/agents` is per-slug only.
5. Wrong shapes: `/api/search` returns `{hits}`; `/api/feed` sends positions in
   **snake_case** with `price_stale` as 0/1, and its agent object carries only
   `{slug,name,strategy,basket}` — no equity, which comes from the equity
   series; `/api/alpha` changes the TYPE of `picks` between locked and open, so
   the old model threw for every non-holder.

Two runtime bugs were fixed at the same time: a wrong site-gate password
reported success (both answers are a 303, so redirects had to be turned off to
see the destination), and requests used `suspendCoroutine`, leaking an
in-flight call per abandoned screen.

## What guessing at field names cost, separately

`ignoreUnknownKeys` turns a wrong field name into SILENCE rather than an error,
and four of them were wrong:

- **`/api/follow` takes `target`, not `slug`** — so every follow this client
  ever sent answered `400 "that is not an agent id"`.
- **It reads `on === false` for an unfollow, not `follow`** — so `{follow:false}`
  left `on` undefined and **unfollowing would have followed**.
- **`/api/market` sends `paused`, not `halted`** — the halt flag decoded as null
  on every token, and the detail screen said "we could not read whether trading
  is halted" about a read that had succeeded.
- **`/api/market` sends no 24-hour change at all** — so the arrow beside every
  price was permanently an em dash. A coin's change comes from the index, on
  `/api/tokens/{address}`.

The two write bodies are now built by a serializer from a declared type, which
is the actual fix: a serializer cannot get a key name wrong twice.

## Still missing

The chat propose/confirm card, the proposals approve loop, orders with polling,
snipe, the risk bar, a real settings editor, likes, follows, the token chart,
the watchlist, sharing and the holders table are all here now. What is not:

- **No agent creation and no signing.** Anything that ends in a signature — the
  grant, a re-sign, a withdrawal — is a WebView handoff to the web app's own
  screen, on purpose: that is where the owner key lives.
- The app is **verified running** on an API 35 emulator against production; see
  "Running it on an emulator" below.
- **No X-handle proof flow.** The app renders a proven handle as a link and an
  unproven one as plain text, but the proof itself (post a nonce, verify it) is
  web-only.
- No per-agent endpoint, so a desk's history is the public window filtered
  client-side.

## Running it on an emulator

It runs. This section exists because an earlier session concluded it did not,
and that conclusion was wrong in a way worth writing down.

### The one thing that will waste your afternoon

**`applicationIdSuffix = ".debug"` moves the PACKAGE but not the CLASS.** The
debug build installs as `dev.merrymen.app.debug`; `namespace` stays
`dev.merrymen.app`, so the activity is still `dev.merrymen.app.MainActivity`.
Only one component string resolves:

```bash
adb shell am start -n 'dev.merrymen.app.debug/dev.merrymen.app.MainActivity'
```

Both of the obvious things to type fail, and fail identically:

- `dev.merrymen.app/.MainActivity` — that package is not installed.
- `dev.merrymen.app.debug/.MainActivity` — `ComponentName.unflattenFromString`
  expands a leading dot against the **package**, giving
  `dev.merrymen.app.debug.MainActivity`, which does not exist.

Both answer `START_CLASS_NOT_FOUND`, which is **-92**
(`FIRST_START_FATAL_ERROR_CODE = -100`, `+ 8`). That code comes from a
PackageManagerService manifest-record lookup in `ActivityStarter.executeRequest`
— it is decided **before any class is loaded**, so it can never be caused by a
dexopt problem. If the dex were genuinely broken you would get
`START_SUCCESS (0)` and then a `ClassNotFoundException` in logcat instead. A
`[location is error]` line in `dumpsys package dexopt` alongside it is a red
herring; do not chase it.

`./gradlew installDebug` never hits this, because it resolves the component
itself. Only a hand-typed `am start` does.

### The AVD

The `shadow`/`shadow35` AVDs belong to a different project. Make your own:

```bash
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager.bat" create avd \
  -n merrymen35 -k "system-images;android-35;google_apis;x86_64" -d pixel_6 --force
```

`avdmanager` writes `avd.id = <build>` and `disk.dataPartition.path = <temp>`
into config.ini. Those literal-looking placeholders are **normal** — the
emulator resolves them at launch (check `hardware-qemu.ini` after a boot if you
doubt it). What it also writes is the pixel_6 profile's RAM, which is too low
for API 35, so raise these in `~/.android/avd/merrymen35.avd/config.ini`:

```
hw.ramSize=4096M
vm.heapSize=576M
disk.dataPartition.size=4096M
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
hw.keyboard=yes
```

API 35 `google_apis` matches the app exactly (`compileSdk`/`targetSdk` 35,
`minSdk` 26) and is rootable, unlike the `google_apis_playstore` images.

### Boot, install, drive

```bash
"$ANDROID_HOME/emulator/emulator.exe" -avd merrymen35 \
  -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect &
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done'
adb install -r -t app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n 'dev.merrymen.app.debug/dev.merrymen.app.MainActivity'
```

Then put the **site password** into Settings — every route answers
`401 {"error":"gated"}` until you do, and that is a different 401 from being
signed out. The app says which; see `LoadedBlock`.

Driving it blind by pixel coordinates drifts. Read the real ones:

```bash
adb shell uiautomator dump /sdcard/ui.xml && adb exec-out cat /sdcard/ui.xml
```

**Git-bash gotchas on Windows**, both of which cost time here: `adb push`/`pull`
need a *Windows* path for the host side (`C:\...`), while guest paths like
`/sdcard/ui.xml` get mangled into `C:/Program Files/Git/sdcard/...` unless you
set `MSYS2_ARG_CONV_EXCL="*"`. Setting `MSYS_NO_PATHCONV=1` fixes the guest side
and breaks the host side, so set neither globally — scope them per command.
