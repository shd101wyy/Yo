# Yo language installer for Windows (PowerShell).
#
# Installs Yo into $env:LOCALAPPDATA\Yo and links the `yo` command into
# $env:LOCALAPPDATA\Yo\bin (added to user PATH).
#
# Usage:
#   irm https://raw.githubusercontent.com/shd101wyy/yo/main/scripts/install.ps1 | iex
#   # or, after cloning:
#   .\scripts\install.ps1
#
# Environment variables / parameters:
#   -InstallDir <path>   Target install dir.   Default: $env:LOCALAPPDATA\Yo
#   -BinDir     <path>   Wrapper bin dir.      Default: $InstallDir\bin
#   -Repo       <url>    Git repo URL.         Default: https://github.com/shd101wyy/yo.git
#   -Ref        <ref>    Git ref (branch/tag). Default: main
#   -Force               Overwrite existing install dir.

[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Yo'),
  [string]$BinDir,
  [string]$Repo = 'https://github.com/shd101wyy/yo.git',
  [string]$Ref = 'main',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $BinDir) { $BinDir = Join-Path $InstallDir 'bin' }

function Info($msg)  { Write-Host ">> $msg" -ForegroundColor Cyan }
function Warn($msg)  { Write-Host "!! $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "XX $msg" -ForegroundColor Red; exit 1 }

Info "Installing Yo on Windows"
Info "Install dir: $InstallDir"
Info "Bin dir:     $BinDir"

# ---------------------------------------------------------------------------
# Required tools
# ---------------------------------------------------------------------------

function Test-Cmd($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (-not (Test-Cmd 'git')) { Fail "Missing required command: git. Install from https://git-scm.com/" }

# C compiler (zig recommended on Windows; clang/gcc also work)
if (-not (Test-Cmd 'zig') -and -not (Test-Cmd 'clang') -and -not (Test-Cmd 'gcc')) {
  Warn "No C compiler found (zig, clang, or gcc). 'yo compile' will not work."
  Warn "  Recommended on Windows: install zig via 'winget install zig.zig'"
}

# bun runtime — required to run the current TypeScript-based compiler.
if (-not (Test-Cmd 'bun')) {
  Info "bun not found - installing via official PowerShell installer..."
  Invoke-RestMethod -Uri 'https://bun.sh/install.ps1' -UseBasicParsing | Invoke-Expression
  $bunBin = Join-Path $env:USERPROFILE '.bun\bin'
  if (Test-Path (Join-Path $bunBin 'bun.exe')) {
    $env:PATH = "$bunBin;$env:PATH"
  }
  if (-not (Test-Cmd 'bun')) {
    Fail "bun installation failed - install manually from https://bun.sh"
  }
}
Info "Using bun: $((Get-Command bun).Source) ($(bun --version))"

# ---------------------------------------------------------------------------
# Download Yo
# ---------------------------------------------------------------------------

if (Test-Path $InstallDir) {
  if ($Force) {
    Info "Removing existing install dir (-Force set)"
    Remove-Item -Recurse -Force $InstallDir
  } else {
    Fail "Install dir already exists: $InstallDir. Use -Force to overwrite."
  }
}

Info "Cloning $Repo ($Ref) into $InstallDir"
$parent = Split-Path -Parent $InstallDir
if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
git clone --depth 1 --branch $Ref $Repo $InstallDir
if ($LASTEXITCODE -ne 0) { Fail "git clone failed" }

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

Push-Location $InstallDir
try {
  Info "Installing dependencies (bun install)"
  bun install --silent
  if ($LASTEXITCODE -ne 0) { Fail "bun install failed" }

  Info "Building Yo (bun run build)"
  bun run build
  if ($LASTEXITCODE -ne 0) { Fail "bun run build failed" }
} finally {
  Pop-Location
}

# ---------------------------------------------------------------------------
# Wrapper script
# ---------------------------------------------------------------------------

if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir | Out-Null }

# yo.cmd — calls the existing yo-cli.ps1
$wrapperCmd = Join-Path $BinDir 'yo.cmd'
$yoCli = Join-Path $InstallDir 'yo-cli.ps1'
@"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File `"$yoCli`" %*
"@ | Set-Content -Path $wrapperCmd -Encoding ASCII

# yo.ps1 — for direct PowerShell invocation
$wrapperPs1 = Join-Path $BinDir 'yo.ps1'
@"
#!/usr/bin/env pwsh
& `"$yoCli`" @args
"@ | Set-Content -Path $wrapperPs1 -Encoding UTF8

Info "Installed wrappers: $wrapperCmd, $wrapperPs1"

# ---------------------------------------------------------------------------
# Add bin to user PATH (persistent)
# ---------------------------------------------------------------------------

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
$pathParts = $userPath -split ';' | Where-Object { $_ -ne '' }
if ($pathParts -notcontains $BinDir) {
  $newUserPath = if ($userPath -eq '') { $BinDir } else { "$userPath;$BinDir" }
  [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
  Info "Added $BinDir to user PATH (restart your shell to pick up the change)"
} else {
  Info "$BinDir already on user PATH"
}

Info "Done. Open a new shell and try: yo --help"
