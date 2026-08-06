# merrymen installer for Windows — local (Node) or Docker, your choice.
#
#   irm https://raw.githubusercontent.com/millw14/merrymen/main/install.ps1 | iex
#
# Picks how you'd like to run merrymen :
#   Local  — installs Node (if needed) + merrymen via npm. `merrymen` is the CLI.
#   Docker — clones the source, builds the image locally (no registry), and
#            starts the band via docker compose. 
#
# Safe to re-run. Local install touches only: Node (via winget, with your
# consent) and your USER PATH. No admin rights required.

$ErrorActionPreference = "Stop"

function Say($msg, $color = "Gray") { Write-Host "  $msg" -ForegroundColor $color }

# Run npm without tripping PowerShell's execution policy. Typing `npm` in
# PowerShell resolves to its `npm.ps1` shim, which a default "Restricted" policy
# refuses to load (PSSecurityException / UnauthorizedAccess). Route through
# cmd.exe's `npm.cmd` batch shim instead — the execution policy never touches it,
# so the install works on a locked-down stock Windows without asking the user to
# change any system setting.
function Invoke-Npm($cmdLine) {
  & cmd.exe /c "npm $cmdLine"
  if ($LASTEXITCODE -ne 0) { throw "npm $cmdLine failed (exit $LASTEXITCODE)" }
}

# npm installs the `merrymen` CLI on Windows as a merrymen.ps1 shim. A default
# "Restricted" (or "AllSigned") execution policy refuses to load it, so
# `merrymen ...` would fail with PSSecurityException right after a successful
# install. Relax the CURRENT-USER policy to RemoteSigned — the standard
# Node-on-Windows setting: your own local scripts run, remote ones must be
# signed. No admin needed; only the current user is affected; reversible with
# `Set-ExecutionPolicy -Scope CurrentUser Undefined`.
function Enable-LocalScripts {
  try {
    $eff = Get-ExecutionPolicy
    if ($eff -eq "Restricted" -or $eff -eq "AllSigned") {
      Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force -ErrorAction Stop
      Say "[ok] allowed your local scripts to run (CurrentUser RemoteSigned) so 'merrymen' works" "Green"
    }
  } catch {
    Say "PowerShell is blocking scripts and I couldn't change it (locked by policy?)." "Yellow"
    Say "Run this once so 'merrymen' works:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned" "DarkGray"
    Say "...or just call it as 'merrymen.cmd setup' / from cmd.exe." "DarkGray"
  }
}

function Test-NodeOk {
  try {
    $v = (& node -v) -replace "^v", ""
    $p = $v.Split(".")
    return ([int]$p[0] -gt 22) -or (([int]$p[0] -eq 22) -and ([int]$p[1] -ge 12))
  } catch { return $false }
}

# Get (or refresh) the merrymen source into $dest. Prefers git when present,
# otherwise downloads and extracts the main-branch tarball — no git needed.
function Get-MerrymenSource($dest) {
  $parent = Split-Path $dest -Parent
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  if (Test-Path (Join-Path $dest "Dockerfile")) { return }
  if (Get-Command git -ErrorAction SilentlyContinue) {
    if (-not (Test-Path (Join-Path $dest ".git"))) {
      & git clone --depth 1 https://github.com/millw14/merrymen.git $dest
    } else {
      & git -C $dest pull --ff-only
    }
    return
  }
  $tgz = Join-Path $parent "merrymen.tar.gz"
  $ext = Join-Path $parent "merrymen-main"
  Invoke-WebRequest -Uri "https://codeload.github.com/millw14/merrymen/tar.gz/refs/heads/main" -OutFile $tgz
  tar -xzf $tgz -C $parent
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item $ext $dest
  Remove-Item -Force $tgz
}

function Install-Docker {
  Say "[ok] Docker install" "Green"

  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Say "Docker isn't installed." "Red"
    Say "Install Docker Desktop from https://www.docker.com/products/docker-desktop" "DarkGray"
    Say "then re-run this installer and pick the Docker option." "DarkGray"
    return
  }
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    Say "Docker is installed but the daemon isn't running." "Red"
    Say "Start Docker Desktop, then re-run this installer." "DarkGray"
    return
  }

  $src = Join-Path $HOME ".merrymen-docker\src"
  Say "cloning the merrymen source for the image build..." "Yellow"
  Get-MerrymenSource $src

  Say "building the image (first build installs deps + builds the dashboard -- a few minutes)..." "Yellow"
  & docker build -t merrymen:latest $src
  if ($LASTEXITCODE -ne 0) { throw "docker build failed (exit $LASTEXITCODE)" }

  # Start the band now via compose — no `merrymen` command is installed for the
  # Docker path. The bind mount source must exist first, or docker makes it a
  # root-owned directory the container user can't write into.
  $vol = Join-Path $HOME ".merrymen"
  New-Item -ItemType Directory -Force -Path $vol | Out-Null
  Say "starting the band (dashboard + worker in Docker)..." "Yellow"
  & docker compose -f (Join-Path $src "docker-compose.yml") up -d

  Write-Host ""
  Say "the band is live -- dashboard: http://localhost:3100" "Green"
  Write-Host "    docker compose -f $src\docker-compose.yml logs -f   " -NoNewline; Write-Host "# tail the band's logs" -ForegroundColor DarkGray
  Write-Host "    docker compose -f $src\docker-compose.yml down      " -NoNewline; Write-Host "# stop the band" -ForegroundColor DarkGray
  Write-Host "    docker compose -f $src\docker-compose.yml run --rm merrymen node cli/bin.mjs doctor" -NoNewline; Write-Host "   # doctor" -ForegroundColor DarkGray
  Write-Host ""
}

Write-Host ""
Say "merrymen -- stand and deliver" "Green"
Say "setting up your rig..." "DarkGray"
Write-Host ""

# ── pick the install method ──────────────────────────────────────────────
# Arrow-key selector: ↑/↓ to move, Enter to pick. Non-interactive (a piped or
# headless run) falls back to the first option — Local.
function Select-InstallMethod {
  $opts = @(
    "Local machine   (Node 22.12+ + npm install -g)",
    "Docker          (build the image locally, no registry)"
  )
  $n = $opts.Count
  $sel = 0

  Write-Host ""
  Write-Host "How would you like to run merrymen?"
  Write-Host ""
  if ([Console]::IsOutputRedirected) { $optTop = 0 } else { $optTop = [Console]::CursorTop }

  $draw = {
    if (-not [Console]::IsOutputRedirected) {
      [Console]::SetCursorPosition(0, $optTop)
    }
    for ($i = 0; $i -lt $n; $i++) {
      $line = if ($i -eq $sel) { "  " + [char]0x279C + " " + $opts[$i] } else { "    " + $opts[$i] }
      $width = if ([Console]::IsOutputRedirected) { 0 } else { [Console]::WindowWidth }
      $pad = ' ' * [Math]::Max(0, $width - $line.Length)
      if ($i -eq $sel) {
        Write-Host ($line + $pad) -ForegroundColor Green
      } else {
        Write-Host ($line + $pad) -ForegroundColor DarkGray
      }
    }
  }

  try {
    & $draw
    while ($true) {
      $key = [Console]::ReadKey($true)
      if ($key.Key -eq 'UpArrow') {
        if ($sel -gt 0) { $sel-- }
        & $draw
      } elseif ($key.Key -eq 'DownArrow') {
        if ($sel -lt ($n - 1)) { $sel++ }
        & $draw
      } elseif ($key.Key -eq 'Enter') {
        break
      }
    }
    if (-not [Console]::IsOutputRedirected) {
      [Console]::SetCursorPosition(0, $optTop + $n)
      Write-Host "  $($opts[$sel])" -ForegroundColor Green
      Write-Host ""
    } else {
      Write-Host "  $($opts[$sel])"
    }
  } catch {
    # no interactive console — pick the default (Local)
    Write-Host "  $($opts[$sel])"
  }
  return $sel
}

$choice = Select-InstallMethod

if ($choice -eq 1) {
  Install-Docker
  return
}

# ── local install ─────────────────────────────────────────────────────────
if (Test-NodeOk) {
  Say "[ok] node $(node -v) already installed" "Green"
} else {
  Say "[..] Node 22.12+ not found -- installing Node LTS..." "Yellow"
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    # refresh PATH for this session so `node`/`npm` resolve immediately
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
  } else {
    Say "winget isn't available. Install Node 22.12+ from https://nodejs.org/en/download" "Red"
    Say "then re-run:  irm https://raw.githubusercontent.com/millw14/merrymen/main/install.ps1 | iex" "DarkGray"
    return
  }
  if (-not (Test-NodeOk)) {
    Say "Node installed, but not on PATH in THIS window yet." "Red"
    Say "Close and reopen PowerShell, then re-run this installer." "DarkGray"
    return
  }
  Say "[ok] node $(node -v) installed" "Green"
}

Say "[..] installing merrymen (global)..." "Yellow"
Invoke-Npm "install -g merrymen"

# So the freshly-installed `merrymen` command can actually run in PowerShell.
Enable-LocalScripts

# ensure npm's global bin is on the USER PATH so `merrymen` resolves in new shells
$npmBin = Join-Path $env:APPDATA "npm"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$npmBin*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$npmBin", "User")
  $env:Path += ";$npmBin"
  Say "[ok] added npm global bin to PATH" "Green"
}

Write-Host ""
Say "the band is ready. next:" "Green"
Write-Host "    merrymen setup     " -NoNewline; Write-Host "# confirm the rig" -ForegroundColor DarkGray
Write-Host "    merrymen onboard   " -NoNewline; Write-Host "# keys, strategy, basket" -ForegroundColor DarkGray
Write-Host "    merrymen start     " -NoNewline; Write-Host "# dashboard at localhost:3100 + the worker" -ForegroundColor DarkGray
Write-Host ""
Say "(if 'merrymen' isn't found, open a fresh terminal -- PATH updates need one)" "DarkGray"
Write-Host ""
