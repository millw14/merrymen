#!/bin/sh
# merrymen desktop installer for Linux (AppImage).
#
#   curl -fsSL https://merrymen.dev/install-desktop.sh | bash
#
# Installs the latest published merrymen desktop AppImage to ~/.local/bin
# (or $XDG_BIN_HOME), makes it executable, and checks the FUSE prerequisite.
# Also installs the app icon + launcher entry, so the tile shows in app
# launchers (the same files the app itself refreshes on boot — reinstalling
# or updating never leaves a stale tile).
# Safe to re-run: re-installs/updates to the latest release. Override with:
#   MERRY_MEN_VERSION=desktop-beta-v0.1.8-dev.1 curl -fsSL ... | bash  # pin a version
#   MERRY_MEN_CHANNEL=beta curl -fsSL ... | bash  # latest beta pre-release
#   MERRY_MEN_BIN_DIR=/usr/local/bin ...              # system-wide (needs sudo)
#
# Default channel is stable (latest full release). Beta installs the newest
# published pre-release carrying an AppImage.
#
# This is the DESKTOP installer (bundled Electron app). For the CLI, see the
# root install.sh instead.
set -eu

REPO="millw14/merrymen"
APP="merrymen-desktop"
BIN_DIR="${MERRY_MEN_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"
TAG="${MERRY_MEN_VERSION:-latest}"
CHANNEL="${MERRY_MEN_CHANNEL:-stable}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required (sudo pacman -S curl / sudo apt install curl)"
[ "$(uname -s)" = "Linux" ] || die "this installer is Linux-only"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "only x86_64 builds are published (you have $(uname -m))" ;;
esac

# FUSE is what lets an AppImage mount itself. Check, don't install: package
# managers differ per distro and sudo may not exist.
if ! command -v fusermount >/dev/null 2>&1 && [ ! -e /dev/fuse ]; then
  if [ -f /etc/arch-release ]; then
    say "note: FUSE not found — install it with: sudo pacman -S fuse2"
  elif [ -f /etc/debian_version ]; then
    say "note: FUSE not found — install it with: sudo apt install libfuse2"
  else
    say "note: FUSE not found — install your distro's fuse2/libfuse2 package"
  fi
fi

if [ -n "${MERRY_MEN_VERSION:-}" ]; then
  API="https://api.github.com/repos/$REPO/releases/tags/$TAG"
  say "resolving $APP release ($TAG)…"
  JSON="$(curl -fsSL "$API")"
  URL="$(printf '%s' "$JSON" | grep -o '"browser_download_url": *"[^"]*\.AppImage"' | head -n 1 | cut -d'"' -f4)"
  ICON_URL="$(printf '%s' "$JSON" | grep -o '"browser_download_url": *"[^"]*/icon\.png"' | head -n 1 | cut -d'"' -f4)"
elif [ "$CHANNEL" = "beta" ]; then
  command -v python3 >/dev/null 2>&1 || die "MERRY_MEN_CHANNEL=beta needs python3 to read the releases list"
  API="https://api.github.com/repos/$REPO/releases"
  say "resolving $APP latest beta pre-release…"
  URLS="$(curl -fsSL "$API" | python3 -c 'import json,sys
for r in json.load(sys.stdin):
    if r.get("prerelease") and not r.get("draft"):
        app = icon = ""
        for a in r.get("assets", []):
            if a.get("name", "").endswith(".AppImage") and not app:
                app = a["browser_download_url"]
            if a.get("name") == "icon.png" and not icon:
                icon = a["browser_download_url"]
        if app:
            print(app); print(icon); break')"
  URL="$(printf '%s' "$URLS" | sed -n '1p')"
  ICON_URL="$(printf '%s' "$URLS" | sed -n '2p')"
elif [ "$CHANNEL" = "stable" ]; then
  API="https://api.github.com/repos/$REPO/releases/latest"
  say "resolving $APP release (latest stable)…"
  JSON="$(curl -fsSL "$API")"
  URL="$(printf '%s' "$JSON" | grep -o '"browser_download_url": *"[^"]*\.AppImage"' | head -n 1 | cut -d'"' -f4)"
  ICON_URL="$(printf '%s' "$JSON" | grep -o '"browser_download_url": *"[^"]*/icon\.png"' | head -n 1 | cut -d'"' -f4)"
else
  die "MERRY_MEN_CHANNEL must be stable or beta (got: $CHANNEL)"
fi
[ -n "$URL" ] || die "no AppImage asset found (API: $API)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
say "downloading $(basename "$URL")…"
curl -fsSL -o "$TMP/merrymen.AppImage" "$URL"
[ -s "$TMP/merrymen.AppImage" ] || die "download came back empty"

mkdir -p "$BIN_DIR"
mv "$TMP/merrymen.AppImage" "$BIN_DIR/merrymen-desktop"
chmod +x "$BIN_DIR/merrymen-desktop"

# Desktop entry + icon so launchers show the real tile (not a generic glyph).
# Same content the app itself refreshes on boot — either writer converges.
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/1024x1024/apps"
if [ -n "${ICON_URL:-}" ]; then
  mkdir -p "$ICON_DIR"
  say "installing icon…"
  curl -fsSL -o "$ICON_DIR/merrymen-desktop.png" "$ICON_URL" || say "note: icon download failed — tile falls back to generic"
else
  say "note: no icon asset on this release — tile falls back to generic"
fi
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/merrymen-desktop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=merrymen desktop
Comment=Autonomous agents for Robinhood Chain — dashboard + worker
Exec=$BIN_DIR/merrymen-desktop %U
Icon=merrymen-desktop
Terminal=false
Categories=Finance;
StartupWMClass=merrymen-desktop
EOF

say "installed to $BIN_DIR/merrymen-desktop"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "note: $BIN_DIR is not on your PATH — add: export PATH=\"\$PATH:$BIN_DIR\"" ;;
esac
say "run it with: merrymen-desktop   (data lives in ~/.merrymen, shared with the CLI)"
