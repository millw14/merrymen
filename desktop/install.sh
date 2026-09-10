#!/bin/sh
# merrymen desktop installer for Linux (AppImage).
#
#   curl -fsSL https://merrymen.dev/install-desktop.sh | bash
#
# Installs the latest published merrymen desktop AppImage to ~/.local/bin
# (or $XDG_BIN_HOME), makes it executable, and checks the FUSE prerequisite.
# Safe to re-run: re-installs/updates to the latest release. Override with:
#   MERRY_MEN_VERSION=v0.1.8  curl -fsSL ... | bash   # pin a version
#   MERRY_MEN_BIN_DIR=/usr/local/bin ...              # system-wide (needs sudo)
#
# This is the DESKTOP installer (bundled Electron app). For the CLI, see the
# root install.sh instead.
set -eu

REPO="millw14/merrymen"
APP="merrymen-desktop"
BIN_DIR="${MERRY_MEN_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"
TAG="${MERRY_MEN_VERSION:-latest}"

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

if [ "$TAG" = "latest" ]; then
  API="https://api.github.com/repos/$REPO/releases/latest"
else
  API="https://api.github.com/repos/$REPO/releases/tags/$TAG"
fi
say "resolving $APP release ($TAG)…"
URL="$(curl -fsSL "$API" | grep -o '"browser_download_url": *"[^"]*\.AppImage"' | head -n 1 | cut -d'"' -f4)"
[ -n "$URL" ] || die "no AppImage asset found (API: $API)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
say "downloading $(basename "$URL")…"
curl -fsSL -o "$TMP/merrymen.AppImage" "$URL"
[ -s "$TMP/merrymen.AppImage" ] || die "download came back empty"

mkdir -p "$BIN_DIR"
mv "$TMP/merrymen.AppImage" "$BIN_DIR/merrymen-desktop"
chmod +x "$BIN_DIR/merrymen-desktop"

# Desktop entry so launchers find it (no icon shipped — launcher shows a
# generic glyph; harmless and removable).
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/merrymen-desktop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=merrymen desktop
Exec=$BIN_DIR/merrymen-desktop %U
Terminal=false
Categories=Finance;
EOF

say "installed to $BIN_DIR/merrymen-desktop"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "note: $BIN_DIR is not on your PATH — add: export PATH=\"\$PATH:$BIN_DIR\"" ;;
esac
say "run it with: merrymen-desktop   (data lives in ~/.merrymen, shared with the CLI)"
