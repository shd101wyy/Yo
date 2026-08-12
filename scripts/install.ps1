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
# Only x64 bundles are published for Windows. An arm64 device running the x64
# bundle under emulation would produce x64 binaries, so refuse rather than
# install something subtly wrong.
# ---------------------------------------------------------------------------

function Get-OsArch {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
  switch ($arch) {
    'AMD64' { return 'windows-x64' }
    default {
      Fail "Unsupported CPU architecture: $arch. Yo publishes a windows-x64 bundle only."
    }
  }
}

# ---------------------------------------------------------------------------
# Dependencies
#
#   * clang — REQUIRED. `yo compile` invokes `clang` by default (a different
#     compiler can be selected with --cc).
#   * git — REQUIRED for `yo fetch` / `yo install`, which resolve dependencies
#     by shelling out to git. Compiling works without it.
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
  if (-not (Has-Cmd 'clang') -and -not (Has-Cmd 'gcc') -and -not (Has-Cmd 'cl')) {
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
}

# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

function Resolve-Version {
  if ($Version) {
    if ($Version -notmatch '^v') { $script:Version = "v$Version" }
    return
  }
  Info 'Resolving the latest release..'
  try {
    $rel = Invoke-RestMethod -Uri "$ApiUrl/latest" -Headers @{ 'User-Agent' = 'yo-installer' } -UseBasicParsing
    $script:Version = $rel.tag_name
  } catch {
    Fail "Unable to resolve the latest release tag from GitHub. Pass one explicitly, e.g. -Version v0.2.3"
  }
  if (-not $script:Version) { Fail 'Unable to resolve the latest release tag.' }
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

function Install-Dist {
  $osarch = Get-OsArch
  $bundle = "yo-$Version-$osarch"
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
