# Installation script for Yo on Windows (PowerShell); use -Help to see options.
#
#   irm https://raw.githubusercontent.com/shd101wyy/Yo/develop/scripts/install.ps1 | iex
#
# Installs a prebuilt release bundle. Yo is self-hosted: the bundle carries the
# native compiler plus the standard library and the vendored mimalloc sources,
# so there is no toolchain to build and nothing to compile at install time.
#
# Installs to <Prefix>\lib\yo\<tag> and puts a `yo` shim in <Prefix>\bin.

[CmdletBinding()]
param(
  [string]$Version = '',                                    # empty => latest release
  [string]$Prefix  = (Join-Path $env:LOCALAPPDATA 'Yo'),    # user-level; no admin needed
  [switch]$Force,
  [switch]$Uninstall,
  [switch]$NoDeps,
  [switch]$NoVerify,
  [switch]$DryRun,
  [switch]$Quiet,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

$Repo        = if ($env:YO_REPO) { $env:YO_REPO } else { 'shd101wyy/Yo' }
$DistBaseUrl = "https://github.com/$Repo/releases/download"
$ApiUrl      = "https://api.github.com/repos/$Repo/releases"
$TempDir     = $null

function Info($msg) { if (-not $Quiet) { Write-Host $msg } }
function Warn($msg) { Write-Warning $msg }
function Fail($msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }
function Has-Cmd($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

function New-TempDir {
  if (-not $script:TempDir) {
    $script:TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("yo-" + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:TempDir -Force | Out-Null
  }
  return $script:TempDir
}

function Remove-TempDir {
  if ($script:TempDir -and (Test-Path $script:TempDir)) {
    Remove-Item -Recurse -Force $script:TempDir -ErrorAction SilentlyContinue
  }
  $script:TempDir = $null
}

function Show-Help {
  @'
usage: install.ps1 [options]

options:
  -Version <tag>    release to install (default: latest)
  -Prefix <dir>     install prefix (default: %LOCALAPPDATA%\Yo)
  -Force            overwrite an existing install / skip prompts
  -Uninstall        uninstall instead of install
  -NoDeps           do not install system dependencies
  -NoVerify         skip the post-install hello-world compile
  -DryRun           show what would happen, change nothing
  -Quiet            suppress output
  -Help             show this help

Installs to <Prefix>\lib\yo\<tag> and puts a `yo` shim in <Prefix>\bin.

examples:
  .\install.ps1                          # latest
  .\install.ps1 -Version v0.2.3          # a specific release
  .\install.ps1 -NoDeps -NoVerify -Force # unattended (CI)
'@ | Write-Host
}

# ---------------------------------------------------------------------------
# Platform
#
# PROCESSOR_ARCHITECTURE reports the architecture of the CURRENT PROCESS, so an
# x64 PowerShell emulated on an arm64 device reports AMD64. PROCESSOR_ARCHITEW6432
# is set only in that emulated case and names the NATIVE architecture, so it wins
# when present — installing the x64 bundle on an arm64 machine would produce a
# compiler that defaults to emitting x64 binaries.
# ---------------------------------------------------------------------------

function Get-OsArch {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
  switch ($arch) {
    'AMD64' { return 'windows-x64' }
    'ARM64' { return 'windows-arm64' }
    default {
      Fail "Unsupported CPU architecture: $arch. Yo publishes windows-x64 and windows-arm64 bundles."
    }
  }
}

# The published asset name for this host, in canonical target-triple form
# (plans/RELEASE_ASSET_TRIPLES.md). Kept in step with
# scripts/release_asset_triple.sh and src/version_cache.yo; this script is
# fetched standalone over HTTP, so it carries its own copy of the mapping.
function Get-HostTriple {
  switch (Get-OsArch) {
    'windows-x64'   { return 'x86_64-pc-windows-msvc' }
    'windows-arm64' { return 'aarch64-pc-windows-msvc' }
    default         { return $null }
  }
}

# $true when the asset exists, so the caller can prefer the triple name and fall
# back to the pre-triple short name on releases up to and including v0.2.18.
function Test-AssetExists {
  param([string]$Url)
  try {
    Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

# ---------------------------------------------------------------------------
# Dependencies
#
#   * clang — REQUIRED. `yo compile` invokes `clang` by default (a different
#     compiler can be selected with --cc).
#   * git — REQUIRED for `yo fetch` / `yo install`, which resolve dependencies
#     by shelling out to git. Compiling works without it.
#   * the Windows SDK — REQUIRED, and NOT installable from here. See
#     Test-CToolchain below for why this cannot be a package in the list above.
#
# There is no liburing on Windows (io_uring is Linux-only), and mimalloc is
# compiled from the vendored sources shipped in the bundle, so there is no
# cmake/ninja/vcpkg step.
# ---------------------------------------------------------------------------

function Install-Dependencies {
  if ($NoDeps) { Info 'Skipping dependency installation (-NoDeps).'; return }

  $wantClang = -not (Has-Cmd 'clang')
  $wantGit   = -not (Has-Cmd 'git')
  if (-not $wantClang -and -not $wantGit) { return }

  Info 'Installing dependencies (clang, git)..'
  if (Has-Cmd 'winget') {
    if ($wantClang) { winget install --id LLVM.LLVM -e --silent --accept-package-agreements --accept-source-agreements | Out-Null }
    if ($wantGit)   { winget install --id Git.Git  -e --silent --accept-package-agreements --accept-source-agreements | Out-Null }
  } elseif (Has-Cmd 'choco') {
    if ($wantClang) { choco install -y llvm | Out-Null }
    if ($wantGit)   { choco install -y git  | Out-Null }
  } elseif (Has-Cmd 'scoop') {
    if ($wantClang) { scoop install llvm | Out-Null }
    if ($wantGit)   { scoop install git  | Out-Null }
  } else {
    Warn 'No winget, choco or scoop found; skipping dependency installation.'
  }

  # A freshly installed tool is not on this process's PATH yet.
  $env:PATH = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Check-Dependencies {
  if (-not (Has-Cmd 'clang') -and -not (Has-Cmd 'gcc')) {
    Warn @'
No C compiler found on PATH. Yo compiles to C, so 'yo compile' will fail.
Install LLVM (winget install LLVM.LLVM) and reopen your terminal.
'@
  }
  if (-not (Has-Cmd 'git')) {
    Warn @'
git was not found on PATH. 'yo compile' works without it, but 'yo fetch' and
'yo install' resolve dependencies with git and will fail.
Install it with: winget install Git.Git
'@
  }
  Test-CToolchain
}

# `clang` on PATH is NOT the same as a working C toolchain on Windows, and this
# is the one prerequisite the installer cannot satisfy for the user.
#
# Clang here targets MSVC. It ships its own compiler headers but NOT the C
# runtime: <stdio.h> lives in the Windows SDK's UCRT, and the import libraries
# Yo links against (-lws2_32 -lbcrypt -ladvapi32, see src/main.yo) are SDK
# libraries too. `winget install LLVM.LLVM` installs clang alone, so a machine
# with no Visual Studio ends up with a clang that cannot build anything.
#
# It is not added to Install-Dependencies because the Build Tools are a
# multi-gigabyte install; a script piped from the internet should not start one
# unasked. Naming it precisely is the useful thing.
#
# Why this was missed until now: install-scripts.yml exercises install.ps1 on
# `windows-latest`, which ships Visual Studio — so CI has always had an SDK and
# has never once run the configuration a new user actually has. The repo README
# documents the requirement (both languages); nothing in the install path did.
#
# The probe is a real compile-and-link rather than a registry or path check,
# for the same reason Verify-Install compiles a hello world: it is the only
# check that cannot be fooled by a partial install.
function Test-CToolchain {
  if (-not (Has-Cmd 'clang')) { return }   # already reported above
  # New-TempDir hands back the SHARED script-scoped directory, so this does not
  # clean up after itself — Verify-Install compiles into the same place for the
  # same reason, and the single Remove-TempDir at the end of the run covers it.
  $tmp = New-TempDir
  $src = Join-Path $tmp 'probe.c'
  "#include <stdio.h>`nint main(void) { return 0; }" | Set-Content -Path $src -Encoding UTF8
  $out = Join-Path $tmp 'probe.exe'
  $log = & clang $src -o $out 2>&1
  if ($LASTEXITCODE -eq 0) { return }
  Warn @"
clang is on PATH but cannot build a C program on this machine, so 'yo compile'
will fail.

Clang on Windows targets MSVC: the C runtime headers (stdio.h) and the import
libraries Yo links against (ws2_32, bcrypt, advapi32) come from the WINDOWS SDK,
which the LLVM package does not include.

Install the "Desktop development with C++" workload — it provides MSVC, the
Windows SDK and the linker:

    winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet"

or download Visual Studio (Community edition is free) from
https://visualstudio.microsoft.com/downloads/ and select that workload. Then
reopen your terminal and re-run this installer.

clang reported:
$(($log | Out-String).Trim())
"@
}

# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

# Resolve the newest release tag.
#
# Prefer the /releases/latest REDIRECT over the REST API: the API is rate
# limited to 60 requests/hour per IP for unauthenticated callers, and shared
# egress IPs (CI runners, offices, NAT) routinely have that budget already
# spent. The redirect has no such limit and needs no token.
function Resolve-Version {
  if ($Version) {
    if ($Version -notmatch '^v') { $script:Version = "v$Version" }
    return
  }
  Info 'Resolving the latest release..'

  try {
    $resp = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" -UseBasicParsing
    # PowerShell 7 and 5.1 expose the final URL differently.
    $final = $null
    if ($resp.BaseResponse.PSObject.Properties.Name -contains 'RequestMessage') {
      $final = $resp.BaseResponse.RequestMessage.RequestUri.AbsoluteUri   # PS 7
    } elseif ($resp.BaseResponse.PSObject.Properties.Name -contains 'ResponseUri') {
      $final = $resp.BaseResponse.ResponseUri.AbsoluteUri                 # PS 5.1
    }
    if ($final -match '/releases/tag/(.+)$') { $script:Version = $Matches[1] }
  } catch {
    # fall through to the API
  }

  if (-not $script:Version) {
    try {
      $headers = @{ 'User-Agent' = 'yo-installer' }
      $token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else { $null }
      if ($token) { $headers['Authorization'] = "Bearer $token" }
      $rel = Invoke-RestMethod -Uri "$ApiUrl/latest" -Headers $headers -UseBasicParsing
      $script:Version = $rel.tag_name
    } catch {
      # reported below
    }
  }

  if (-not $script:Version) {
    Fail @'
Unable to resolve the latest release tag from GitHub.
This is usually a network problem or an exhausted API rate limit.
Pass a version explicitly, e.g. -Version v0.2.3
'@
  }
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

function Install-Dist {
  $osarch = Get-OsArch
  # Triple name first; the short name is what every release up to v0.2.18 has.
  $bundle = $null
  $triple = Get-HostTriple
  if ($triple) {
    $candidate = "yo-$Version-$triple"
    if (Test-AssetExists "$DistBaseUrl/$Version/$candidate.tar.gz") {
      $bundle = $candidate
    }
  }
  if (-not $bundle) { $bundle = "yo-$Version-$osarch" }
  $url    = "$DistBaseUrl/$Version/$bundle.tar.gz"
  $target = Join-Path (Join-Path (Join-Path $Prefix 'lib') 'yo') $Version
  $binDir = Join-Path $Prefix 'bin'

  Info "Installing Yo $Version for $osarch"
  Info "  bundle:  $url"
  Info "  target:  $target"
  Info "  command: $binDir\yo.cmd"

  if ($DryRun) { Info '(dry run - stopping before any change)'; return }

  if ((Test-Path $target) -and -not $Force) {
    Info "$Version is already installed at $target (use -Force to reinstall)."
  } else {
    $tmp = New-TempDir
    $archive = Join-Path $tmp "$bundle.tar.gz"

    Info 'Downloading..'
    try {
      Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
    } catch {
      Fail @"
Unable to download: $url
There may be no bundle for this platform at $Version.
Pick another release with -Version <tag>, or build from source.
"@
    }

    # Windows 10 1803+ ships bsdtar as tar.exe, which reads .tar.gz natively.
    if (-not (Has-Cmd 'tar')) {
      Fail 'tar.exe not found. Windows 10 1803 or newer is required (or extract the bundle manually).'
    }
    Info 'Extracting..'
    & tar -xzf $archive -C $tmp
    if ($LASTEXITCODE -ne 0) { Fail "Failed to extract $bundle.tar.gz" }

    # bin\, std\ and vendor\ must stay SIBLINGS: the compiler finds its standard
    # library by walking up from its own executable, and resolves the vendored
    # mimalloc as <std>\..\vendor. Move the extracted tree in one piece.
    $extracted = Join-Path $tmp $bundle
    if (-not (Test-Path (Join-Path $extracted 'std')) -or -not (Test-Path (Join-Path $extracted 'bin'))) {
      Fail "Unexpected bundle layout in $bundle.tar.gz (missing bin\ or std\)"
    }

    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Move-Item -Path $extracted -Destination $target
  }

  $exe = Join-Path (Join-Path $target 'bin') 'yo.exe'
  if (-not (Test-Path $exe)) { Fail "Installed bundle has no executable at $exe" }

  # A .cmd shim rather than a symlink: symlinks on Windows need admin rights or
  # Developer Mode. The shim invokes the real .exe, so the compiler still sees
  # its own path and resolves std by walking up from it.
  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
  $shim = Join-Path $binDir 'yo.cmd'
  @"
@echo off
"$exe" %*
exit /b %ERRORLEVEL%
"@ | Set-Content -Path $shim -Encoding ASCII
  Info "Wrote shim $shim -> $exe"

  Add-ToUserPath $binDir
}

function Add-ToUserPath($dir) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  $entries = $userPath -split ';' | Where-Object { $_ -ne '' }
  if ($entries -contains $dir) { return }
  [Environment]::SetEnvironmentVariable('Path', (($entries + $dir) -join ';'), 'User')
  $env:PATH = "$env:PATH;$dir"
  Info "Added $dir to your user PATH (restart your terminal to pick it up)."
}

# ---------------------------------------------------------------------------
# Verify
#
# A downloaded binary is not a working install: std must resolve, the vendored
# mimalloc must be found, and clang must link. Compiling a hello world is the
# only check that exercises all three.
# ---------------------------------------------------------------------------

function Verify-Install {
  if ($NoVerify -or $DryRun) { return }
  if (-not (Has-Cmd 'clang') -and -not (Has-Cmd 'gcc')) {
    Warn 'Skipping verification: no C compiler available.'
    return
  }
  $tmp = New-TempDir
  $src = Join-Path $tmp 'hello.yo'
  @'
open(import("std/fmt"));
main :: (fn() -> unit)({
  println(`Yo is installed`);
});
export(main);
'@ | Set-Content -Path $src -Encoding UTF8

  $exe = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $Prefix 'lib') 'yo') $Version) 'bin') 'yo.exe'
  $out = Join-Path $tmp 'hello.exe'
  Info 'Verifying (compiling a hello world)..'
  $log = & $exe compile $src -o $out 2>&1
  if ($LASTEXITCODE -ne 0) {
    Warn ($log | Out-String)
    Fail 'The install is present but cannot compile. See the output above.'
  }
  $printed = (& $out 2>&1 | Out-String).Trim()
  if ($printed -ne 'Yo is installed') {
    Fail "Verification FAILED: the compiled program printed '$printed'"
  }
  Info 'Verified: compiled and ran a hello world.'
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

function Uninstall-Dist {
  $root = Join-Path (Join-Path $Prefix 'lib') 'yo'
  $target = if ($Version) { Join-Path $root $Version } else { $root }

  if (-not (Test-Path $target)) { Info "Nothing to uninstall at $target"; return }

  if (-not $Force) {
    $answer = Read-Host "Remove $target and the 'yo' command? [yN]"
    if ($answer -notmatch '^[Yy]') { Info 'Cancelled.'; return }
  }
  if ($DryRun) { Info "(dry run) would remove $target"; return }

  # Only remove the shim if it points into what we are deleting.
  $shim = Join-Path (Join-Path $Prefix 'bin') 'yo.cmd'
  if (Test-Path $shim) {
    $content = Get-Content $shim -Raw
    if ($content -like "*$root*") {
      Remove-Item -Force $shim
      Info "Removed $shim"
    }
  }

  Remove-Item -Recurse -Force $target
  Info "Removed $target"

  if ((Test-Path $root) -and -not (Get-ChildItem $root)) { Remove-Item -Force $root }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

try {
  if ($Help) { Show-Help; exit 0 }

  if ($Uninstall) {
    if ($Version -and $Version -notmatch '^v') { $Version = "v$Version" }
    Uninstall-Dist
    exit 0
  }

  Resolve-Version
  Install-Dependencies
  Check-Dependencies
  Install-Dist
  if ($DryRun) { exit 0 }
  Verify-Install
  Info ''
  Info "Yo $Version is installed. Try:"
  Info '    yo --help'
} finally {
  Remove-TempDir
}
