#!/usr/bin/env bash
# merrymen installer for macOS/Linux — local (Node) or Docker, your choice.
#
#   curl -fsSL https://raw.githubusercontent.com/millw14/merrymen/main/install.sh | bash
#
# Picks how you'd like to run merrymen :
#   Local  — installs Node (if needed) + merrymen via npm. `merrymen` is the CLI.
#   Docker — clones the source, builds the image locally (no registry), and
#            starts the band via docker compose.
#
# Safe to re-run. Installs Node only via a package manager you already have
# (Homebrew / fnm); otherwise it points you to nodejs.org rather than guessing.
set -euo pipefail

grn() { printf "  \033[32m%s\033[0m\n" "$1"; }
ylw() { printf "  \033[33m%s\033[0m\n" "$1"; }
red() { printf "  \033[31m%s\033[0m\n" "$1"; }
dim() { printf "  \033[2m%s\033[0m\n" "$1"; }

echo
grn "merrymen -- stand and deliver"
dim "setting up your rig..."
echo

RERUN="curl -fsSL https://raw.githubusercontent.com/millw14/merrymen/main/install.sh | bash"
DOCKER_SRC="$HOME/.merrymen-docker/src"

# Which (repo, ref) the Docker image is built from. Candidates are probed in
# order — the first whose Dockerfile is actually reachable wins:
#   1) an explicit MERRYMEN_REPO / MERRYMEN_REF override (for power users)
#   2) upstream `main`  — the steady state once the Docker PR is merged
#   3) the PR branch on the fork — so installers work for testers today, and
#      silently move to main the moment it merges (no script edit, no env var).
# GLOBALS set: BUILD_REPO ("owner/repo") and BUILD_REF (branch/tag).
BUILD_REPO="${MERRYMEN_REPO:-millw14/merrymen}"
BUILD_REF="main"
pick_a_ref() {
  local r="$1" ref="$2"
  if curl -fsSI "https://raw.githubusercontent.com/$r/$ref/Dockerfile" >/dev/null 2>&1; then
    BUILD_REPO="$r"; BUILD_REF="$ref"; return 0
  fi
  return 1
}
pick_ref() {
  if [ -n "${MERRYMEN_REF:-}" ]; then
    pick_a_ref "$BUILD_REPO" "$MERRYMEN_REF" && return 0
  fi
  pick_a_ref "millw14/merrymen" "main" && return 0
  pick_a_ref "aor-rex/merrymen" "feat/docker-install" && return 0
  # nothing reachable — build from the repo's default branch and let docker fail
  # loudly if that proves wrong, rather than silently guessing.
  BUILD_REPO="${MERRYMEN_REPO:-millw14/merrymen}"; BUILD_REF="main"
  return 0
}

# ── pick the install method ──────────────────────────────────────────────
# A piped script (`curl | bash`) has its stdin stolen by the pipe, so every
# key is read from the controlling terminal (/dev/tty) directly. Arrow-key
# menu: ↑/↓ to move, Enter to pick. With no controlling terminal (a
# non-interactive run, e.g. in CI) it falls back to the first option — Local.
menu() {
  local mtitle="$1"; shift
  local mopts=("$@")
  local mn=${#mopts[@]}
  local key first=1
  local msel=0 lines=$(( mn + 2 ))

  # State lives in globals (a nested bash function can't see the caller's
  # locals), and the painter is a global function that reads them.
  __menu_title=$mtitle
  __menu_opts=("${mopts[@]}")
  __menu_n=$mn
  __menu_sel=0
  __menu_lines=$lines
  __menu_draw() {
    local j
    printf '\r\033[J'
    printf '%s\n\n' "$__menu_title"
    for j in "${!__menu_opts[@]}"; do
      if [ "$j" -eq "$__menu_sel" ]; then
        printf '  \033[32m➜\033[0m \033[1m%s\033[0m\033[K\n' "${__menu_opts[$j]}"
      else
        printf '    %s\033[K\n' "${__menu_opts[$j]}"
      fi
    done
  }

  __menu_draw
  while :; do
    if ! IFS= read -rs -n1 key < /dev/tty; then
      if [ "$first" = 1 ]; then
        printf '\r\033[J'    # no terminal — pick the default (first option)
        return 0
      fi
      continue
    fi
    first=0
    case "$key" in
      $'\x1b')
        IFS= read -rs -n1 key < /dev/tty || true
        IFS= read -rs -n1 key < /dev/tty || true
        case "$key" in
          A)
            if [ "$__menu_sel" -gt 0 ]; then __menu_sel=$((__menu_sel - 1)); fi
            printf '\033[%dA' "$__menu_lines"
            __menu_draw
            ;;
          B)
            if [ "$__menu_sel" -lt "$((__menu_n - 1))" ]; then __menu_sel=$((__menu_sel + 1)); fi
            printf '\033[%dA' "$__menu_lines"
            __menu_draw
            ;;
        esac
        ;;
      # Note: bash `read -rs -n1` returns an EMPTY string for Enter
          # (\r / \n), not the byte itself — so match '' as well.
          $'\r'|$'\n'|'')
            break
            ;;
    esac
  done
  printf '\033[%dA\033[J' "$__menu_lines"
  printf '  %s\n' "${__menu_opts[$__menu_sel]}"
  MENU_SEL=$__menu_sel
  unset __menu_title __menu_opts __menu_n __menu_sel __menu_lines
  unset -f __menu_draw
}

echo
menu "How would you like to run merrymen?" \
  "Local machine   (Node 22.12+ + npm install -g)" \
  "Docker          (build the image locally, no registry)"
choice=$MENU_SEL

if [ "$choice" = "1" ]; then
  echo
  grn "[ok] Docker install"

  if ! command -v docker >/dev/null 2>&1; then
    red "Docker isn't installed."
    dim "  macOS:  https://docs.docker.com/desktop/setup/install/mac-install/"
    dim "  Linux:  your package manager, or https://docs.docker.com/engine/install/"
    dim "Then re-run:  $RERUN"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    red "Docker is installed but the daemon isn't running."
    dim "Start Docker Desktop (or the docker service), then re-run:  $RERUN"
    exit 1
  fi

  # Get the source for the image build, from whichever (repo, ref) carries a
  # Dockerfile — upstream main once merged, the fork's PR branch until then.
  pick_ref
  ylw "[..] building the image from $BUILD_REPO @ $BUILD_REF"

  if [ -d "$DOCKER_SRC/.git" ]; then
    # Re-run: make sure the checkout sits on the freshly-resolved ref, so a
    # clone made from the fork's PR branch auto-switches to upstream `main` the
    # day it merges. On a stale/misconfigured src fall back to a plain pull.
    ylw "[..] refreshing the merrymen source ($BUILD_REF)..."
    if [ ! -f "$DOCKER_SRC/.merrymen-ref" ] || [ "$(cat "$DOCKER_SRC/.merrymen-ref")" != "$BUILD_REF" ]; then
      if git -C "$DOCKER_SRC" fetch --depth 1 origin "$BUILD_REF" 2>/dev/null \
        && git -C "$DOCKER_SRC" checkout -q -B "$BUILD_REF" FETCH_HEAD 2>/dev/null; then
        printf '%s' "$BUILD_REF" > "$DOCKER_SRC/.merrymen-ref"
      else
        ylw "couldn't switch the source to $BUILD_REF — updating the current branch instead."
        git -C "$DOCKER_SRC" pull --ff-only 2>/dev/null || true
      fi
    else
      git -C "$DOCKER_SRC" pull --ff-only
    fi
  elif command -v git >/dev/null 2>&1; then
    ylw "[..] cloning the merrymen source for the image build..."
    mkdir -p "$(dirname "$DOCKER_SRC")"
    git clone --depth 1 --branch "$BUILD_REF" "https://github.com/$BUILD_REPO.git" "$DOCKER_SRC"
    printf '%s' "$BUILD_REF" > "$DOCKER_SRC/.merrymen-ref"
  else
    ylw "[..] no git found — downloading the merrymen source tarball instead..."
    TMP_DIR="$(mktemp -d)"
    curl -fsSL "https://codeload.github.com/$BUILD_REPO/tar.gz/refs/heads/$BUILD_REF" -o "$TMP_DIR/merrymen.tar.gz"
    tar -xzf "$TMP_DIR/merrymen.tar.gz" -C "$TMP_DIR"
    rm -rf "$DOCKER_SRC" 2>/dev/null || true
    mkdir -p "$(dirname "$DOCKER_SRC")"
    mv "$TMP_DIR/merrymen-${BUILD_REF//\//-}" "$DOCKER_SRC"
    rm -rf "$TMP_DIR"
  fi

  ylw "[..] building the image (first build installs deps + builds the dashboard — a few minutes)..."
  docker build -t merrymen:latest "$DOCKER_SRC"

  # ── make the dashboard reachable ──────────────────────────────────────
  # The point of the Docker install is a server. The dashboard's host guard only
  # lets loopback + private IPs through, so on a VPS (a public primary IP) every
  # /api/* call is 403 unless that IP is allowlisted — persist it to the compose
  # project's `.env` so it survives shells + reboots. On a private-LAN box
  # (laptop) the LAN IP already passes; the detected public IP is still
  # allowlisted as a no-op (it also covers NAT'd cloud VPSes with a private
  # NIC IP).
  primary_ip() {
    local ip=""
    if command -v hostname >/dev/null 2>&1; then
      ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    fi
    if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
      ip="$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2; exit}' | cut -d/ -f1)"
    fi
    printf '%s' "$ip"
  }
  CFG="$DOCKER_SRC/.env"
  PRIMARY_IP="$(primary_ip)"
  case "$PRIMARY_IP" in
    ""|127.*|10.*|192.168.*|169.254.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*|*:*) LAN=1 ;;
    *) LAN=0 ;;
  esac
  SERVER_IP=""
  if [ "$LAN" = "0" ]; then
    SERVER_IP="$PRIMARY_IP"
  elif command -v curl >/dev/null 2>&1; then
    ylw "[..] detecting the public IP (dashboard host guard)..."
    SERVER_IP="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  fi
  if [ -n "$SERVER_IP" ]; then
    mkdir -p "$(dirname "$CFG")"
    { printf 'MERRYMEN_ALLOWED_HOSTS=%s\n' "$SERVER_IP"; } > "$CFG"
    grn "[ok] dashboard host $SERVER_IP allowlisted"
  else
    rm -f "$CFG"
  fi

  # Open the dashboard port when ufw is around (root: do it, else nudge).
  if command -v ufw >/dev/null 2>&1; then
    if [ "$(id -u)" = "0" ]; then
      ufw allow 3100/tcp >/dev/null 2>&1 && grn "[ok] ufw: port 3100/tcp opened"
    else
      ylw "Open the dashboard port so it's reachable (and 3100/tcp in your cloud firewall):"
      dim "  sudo ufw allow 3100/tcp"
      echo
    fi
  fi

  # Start the band now — dashboard + worker — so the installer is done.
  # Docker is driven directly with compose: no `merrymen` command is installed
  # for the Docker path. The bind mount source must exist first, or docker makes
  # it a root-owned directory the unprivileged container user can't write into.
  mkdir -p "$HOME/.merrymen"
  ylw "[..] starting the band (dashboard + worker in Docker)..."
  MYUID="$(id -u)" MYGID="$(id -g)" docker compose -f "$DOCKER_SRC/docker-compose.yml" up -d

  # If ~/.merrymen already exists but is owned by root (an earlier Docker run
  # without user mapping), the unprivileged container user can't write to it.
  if [ -d "$HOME/.merrymen" ] && ! [ -O "$HOME/.merrymen" ]; then
    ylw "~/.merrymen isn't owned by you — the container writes as your user. Fix once:"
    dim "  sudo chown -R \"$(id -u):$(id -g)\" \"$HOME/.merrymen\""
    echo
  fi

  echo
  if [ "$LAN" = "0" ]; then
    grn "the band is live — dashboard: http://$SERVER_IP:3100"
  else
    grn "the band is live — dashboard: http://localhost:3100 (LAN: http://$PRIMARY_IP:3100)"
    if [ -n "$SERVER_IP" ]; then
      dim "  a NAT'd server is also reachable via: http://$SERVER_IP:3100"
    fi
  fi
  dim "  add your keys, strategy + basket at /settings (or: docker compose run --rm merrymen node cli/bin.mjs onboard)"
  dim "  logs: docker compose -f $DOCKER_SRC/docker-compose.yml logs -f · stop: docker compose -f $DOCKER_SRC/docker-compose.yml down"
  echo
  exit 0
fi

# ── local install ────────────────────────────────────────────────────────
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v maj rest min
  v=$(node -v | sed 's/^v//')
  maj=${v%%.*}; rest=${v#*.}; min=${rest%%.*}
  [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 12 ]; }
}

if node_ok; then
  grn "[ok] node $(node -v) already installed"
else
  ylw "[..] Node 22.12+ not found -- installing..."
  if command -v brew >/dev/null 2>&1; then
    brew install node
  elif command -v fnm >/dev/null 2>&1; then
    fnm install 22 && fnm use 22
  else
    red "No Homebrew or fnm found to install Node automatically."
    dim "Install Node 22.12+ from https://nodejs.org/en/download (or via nvm), then re-run:"
    dim "  $RERUN"
    exit 1
  fi
  if ! node_ok; then
    red "Node installed but this shell still sees an old/none version."
    dim "Open a new terminal (or 'fnm use 22'), then re-run:  $RERUN"
    exit 1
  fi
  grn "[ok] node $(node -v) installed"
fi

ylw "[..] installing merrymen (global)..."
npm install -g merrymen

echo
grn "the band is ready. next:"
dim "  merrymen setup     # confirm the rig"
dim "  merrymen onboard   # keys, strategy, basket"
dim "  merrymen start     # dashboard at localhost:3100 + the worker"
echo

# nudge about PATH if npm's global bin isn't on it (the "command not found" trap)
prefix=$(npm prefix -g 2>/dev/null || true)
if [ -n "$prefix" ] && ! printf ':%s:' "$PATH" | grep -q ":$prefix/bin:"; then
  ylw "Add npm's global bin to PATH (then reopen your shell):"
  dim "  echo 'export PATH=\"$prefix/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
  echo
fi
