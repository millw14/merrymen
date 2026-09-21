# merrymen desktop — the one-click app

A native app (`.exe` / `.dmg` / `.AppImage`) that bundles Node, so a user
double-clicks and gets the merrymen dashboard in a window — **no terminal, no
npm, no Node install.** It boots the same agent worker + dashboard as the CLI and
shares the same home (`~/.merrymen`), so it's fully interchangeable with
`npm i -g merrymen`.

## How it works

Electron ships its own Node runtime. On launch, `main.js`:
1. shows a splash,
2. spawns the dashboard (`next start`) + agent worker (`tsx`) using Electron-as-Node,
3. waits for `127.0.0.1:17430`,
4. loads it in a native window.

The `merrymen` npm package is a dependency, so `npm install` pulls the **prebuilt**
dashboard, the worker source, and every dep into `node_modules`. Nothing is fetched
at runtime.

## Run it in dev

```bash
cd desktop
npm install        # pulls electron + the local merrymen (builds its dashboard once)
npm start          # opens the app window
```

## Build the installers

```bash
cd desktop
npm run dist:win     # → dist/merrymen Setup <v>.exe   (run on Windows)
npm run dist:mac     # → dist/merrymen-<v>.dmg          (MUST run on macOS)
npm run dist:linux   # → dist/merrymen-<v>.AppImage
```

Cross-OS note: you can build the Windows `.exe` on Windows and the Linux
`.AppImage` anywhere, but a **`.dmg` must be built on a Mac** (or macOS CI).

## Before you ship (required, or users get scary warnings)

Icons — add these (electron-builder needs them):
- `build/icon.ico` (Windows, 256×256+)
- `build/icon.icns` (macOS)
- `build/icon.png` (Linux, 512×512) — you can reuse the merrymen logo.

**Code signing** — unsigned installers are the #1 reason a "one-click app" scares
users off:
- **Windows:** an unsigned `.exe` triggers SmartScreen ("Windows protected your
  PC"). Sign with an EV/OV cert: set `CSC_LINK` (path to `.pfx`) + `CSC_KEY_PASSWORD`
  and electron-builder signs automatically.
- **macOS:** an unsigned/un-notarized `.dmg` is **blocked** by Gatekeeper on modern
  macOS. You need an Apple Developer ID cert ($99/yr): sign via `CSC_LINK`/
  `CSC_KEY_PASSWORD` and notarize via `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` /
  `APPLE_TEAM_ID`.

The cleanest path to signed builds for both OSes is a GitHub Actions release
workflow (win runner + mac runner) with the certs stored as secrets — say the word
and I'll add it.

## Notes / knobs

- Data home is `~/.merrymen` (shared with the CLI). Change `HOME` in `main.js` to
  isolate the app's data instead.
- Port is `17430` (override with `MERRYMEN_PORT`). The CLI dashboard stays on
  `3100` — the desktop deliberately lives elsewhere so the two never fight.
  If the port's taken, the app offers Retry or Quit instead of failing silent.
  if you expect conflicts.
- `asar: false` keeps Next/tsx happy (they read files from disk). The installer is
  larger (~200–300 MB) because it bundles Node + all deps — that's the tradeoff for
  "nothing to install."
- This scaffold is verified to the extent this environment allows (syntax + logic).
  The GUI launch and the packaged installers must be built and smoke-tested on the
  target OS — `npm start` first, then `npm run dist:<os>`.
