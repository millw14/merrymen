# merrymen installer for Windows — installs Node (if needed) + merrymen, fixes PATH.
#
#   irm https://raw.githubusercontent.com/millw14/merrymen/main/install.ps1 | iex
#
# Safe to re-run. Touches only: Node (via winget, with your consent) and your
# USER PATH. No admin rights required for the merrymen + PATH steps.

$ErrorActionPreference = "Stop"

function Say($msg, $color = "Gray") { Write-Host "  $msg" -ForegroundColor $color }

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
npm install -g merrymen

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
