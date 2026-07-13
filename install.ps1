# merrymen installer for Windows — installs Node (if needed) + merrymen, fixes PATH.
#
#   irm https://raw.githubusercontent.com/millw14/merrymen/main/install.ps1 | iex
#
# Safe to re-run. Touches only: Node (via winget, with your consent) and your
# USER PATH. No admin rights required for the merrymen + PATH steps.

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

Write-Host ""
Say "merrymen -- stand and deliver" "Green"
Say "setting up your rig..." "DarkGray"
Write-Host ""

function Test-NodeOk {
  try {
    $v = (& node -v) -replace "^v", ""
    $p = $v.Split(".")
    return ([int]$p[0] -gt 22) -or (([int]$p[0] -eq 22) -and ([int]$p[1] -ge 12))
  } catch { return $false }
}

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
