#!/bin/sh -e

#-----------------------------------------------------------------------------
# Installation script for Yo on Linux and macOS; use -h to see options.
#
#   curl -fsSL https://raw.githubusercontent.com/shd101wyy/Yo/develop/scripts/install.sh | sh
#
# Installs a prebuilt release bundle. Yo is self-hosted: the bundle carries the
# native compiler plus the standard library and the vendored mimalloc sources,
# so there is no toolchain to build and nothing to compile at install time.
#-----------------------------------------------------------------------------

VERSION=""              # empty => resolve the latest release tag
MODE="install"          # or uninstall
PREFIX="$HOME/.local"   # user-level by default; no sudo needed
QUIET=""
FORCE=""
NO_DEPS=""              # skip package-manager dependency installation
NO_VERIFY=""            # skip the post-install hello-world compile
DRYRUN="no"
OSARCH=""
OSNAME=""
OSDISTRO=""
USE_SUDO=""
YO_TEMP_DIR=""

YO_REPO="${YO_REPO:-shd101wyy/Yo}"
YO_DIST_BASE_URL="https://github.com/$YO_REPO/releases/download"
YO_API_URL="https://api.github.com/repos/$YO_REPO/releases"

#---------------------------------------------------------
# Helpers
#---------------------------------------------------------

make_temp_dir() {
  if [ -z "$YO_TEMP_DIR" ] ; then
    YO_TEMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t yo)"
  fi
}

cleanup_temp_dir() {
  if [ -n "$YO_TEMP_DIR" ] ; then
    rm -rf "$YO_TEMP_DIR"
    YO_TEMP_DIR=
  fi
}

trap cleanup_temp_dir EXIT INT TERM

info() {
  if [ -z "$QUIET" ] ; then
    echo "$@"
  fi
}

warn() {
  echo "$@" >&2
}

stop() {
  warn "$@"
  exit 1
}

has_cmd() {
  command -v "$1" > /dev/null 2>&1
}

on_path() {
  echo ":$PATH:" | grep -q :"$1":
}

contains() {
  if echo "$1" | grep -i -E "$2" > /dev/null; then
    return 0
  else
    return 1
  fi
}

#---------------------------------------------------------
# Detect OS and cpu architecture
#---------------------------------------------------------

detect_osarch() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64*|amd64*)          arch="x64";;
    arm64*|aarch64*|armv8*)  arch="arm64";;
    *) stop "Unsupported CPU architecture: $arch.
  Yo publishes bundles for x64 and arm64 only. Build from source:
  <https://github.com/$YO_REPO#building-from-source>";;
  esac

  case "$(uname)" in
    [Ll]inux)  OSNAME="linux";;
    [Dd]arwin) OSNAME="macos";;
    *) stop "Unsupported OS: $(uname). This installer supports Linux and macOS.
  On Windows use scripts/install.ps1 instead.";;
  esac

  OSARCH="$OSNAME-$arch"

  if [ "$OSNAME" = "linux" ] && [ -n "$(find /etc -maxdepth 1 -name '*-release' -type f 2>/dev/null)" ]; then
    distrocfg="$(cat /etc/*-release 2>/dev/null)"
    if contains "$distrocfg" "rhel|centos|fedora|rocky|alma"; then
      OSDISTRO="rhel"
    elif contains "$distrocfg" "opensuse|suse"; then
      OSDISTRO="opensuse"
    elif contains "$distrocfg" "alpine"; then
      OSDISTRO="alpine"
    elif contains "$distrocfg" "arch|manjaro"; then
      OSDISTRO="arch"
    else
      OSDISTRO="debian"
    fi
  fi
}

#---------------------------------------------------------
# Options
#---------------------------------------------------------

process_options() {
  while : ; do
    case "$1" in
      "") break;;
      -q|--quiet)      QUIET="yes";;
      -f|--force)      FORCE="yes";;
      -u|--uninstall)  MODE="uninstall";;
      --no-deps)       NO_DEPS="yes";;
      --no-verify)     NO_VERIFY="yes";;
      --dry-run)       DRYRUN="yes";;
      -h|--help)       MODE="help";;
      -p|--prefix)   shift; PREFIX="$1";;
      -v|--version)  shift; VERSION="$1";;
      *)
        case "$1" in
          -p=*|--prefix=*)   PREFIX="${1#*=}";;
          -v=*|--version=*)  VERSION="${1#*=}";;
          *) warn "Unknown option: $1"; MODE="help";;
        esac;;
    esac
    shift
  done

  # Accept "0.2.3" as well as "v0.2.3".
  if [ -n "$VERSION" ]; then
    case "$VERSION" in
      v*) ;;
      *) VERSION="v$VERSION";;
    esac
  fi
}

#---------------------------------------------------------
# sudo
#---------------------------------------------------------

sudocmd() {
  if [ -z "$USE_SUDO" ] ; then
    if has_cmd sudo && [ "$(id -u)" != "0" ] ; then
      info ""
      info "Need to use 'sudo' for: $*"
      USE_SUDO="always"
      sudo -k
    else
      USE_SUDO="never"
    fi
  fi
  if [ "$USE_SUDO" = "never" ] ; then
    "$@"
  else
    sudo "$@"
  fi
}

#---------------------------------------------------------
# Dependencies
#
# Yo needs far less than a typical toolchain: the bundle ships the compiler,
# the standard library and mimalloc's SOURCES (compiled straight into your
# program by the C compiler), so there is no cmake/ninja/vcpkg step.
#
#   * a C compiler (clang or gcc) — REQUIRED; `yo compile` invokes it.
#   * git — REQUIRED for `yo fetch` / `yo install`, which resolve and download
#     dependencies by shelling out to `git ls-remote`, `git clone`,
#     `git fetch` and `git checkout` (yo-self/fetch.yo, install_command.yo).
#     Compiling works without it; dependency management does not.
#   * liburing + pkg-config on Linux — for async I/O (io_uring). pkg-config is
#     also how a project's declared system libraries are resolved.
#
# liburing and pkg-config MUST be installed as a PAIR. The emitted C guards its
# io_uring calls with `#if __has_include(<liburing.h>)`, while the `-luring`
# link flag is added only when `pkg-config --exists liburing` succeeds. So a box
# with the HEADER but no pkg-config emits io_uring calls and then fails to link
# them ("undefined reference to io_uring_peek_batch_cqe"). Header without
# pkg-config is strictly worse than neither.
#---------------------------------------------------------

apt_get_install() {
  missing=
  for pkg in "$@"; do
    if ! dpkg -s "$pkg" 2>/dev/null | grep '^Status:.*installed' >/dev/null; then
      missing="$missing $pkg"
    fi
  done
  if [ -n "$missing" ]; then
    # shellcheck disable=SC2086
    if ! sudocmd apt-get install -y $missing; then
      warn "Installing apt packages failed ($missing)."
      warn "Run 'apt-get update' and try again, or re-run with --no-deps."
      return 1
    fi
  fi
}

dnf_install() {
  sudocmd dnf install -y "$@" || { warn "installing dnf packages failed ($*)"; return 1; }
}

yum_install() {
  sudocmd yum install -y "$@" || { warn "installing yum packages failed ($*)"; return 1; }
}

pacman_install() {
  sudocmd pacman -S --noconfirm --needed "$@" || { warn "installing pacman packages failed ($*)"; return 1; }
}

apk_install() {
  sudocmd apk add --no-cache "$@" || { warn "installing apk packages failed ($*)"; return 1; }
}

zypper_install() {
  sudocmd zypper install -y "$@" || { warn "installing zypper packages failed ($*)"; return 1; }
}

install_dependencies() {
  if [ -n "$NO_DEPS" ]; then
    info "Skipping dependency installation (--no-deps)."
    return 0
  fi

  if [ "$OSNAME" = "macos" ]; then
    # macOS ships clang AND git with the Command Line Tools, and uses kqueue
    # rather than io_uring, so a single CLT install covers everything.
    if ! has_cmd clang && ! has_cmd gcc; then
      warn "No C compiler found. Install Apple's Command Line Tools:"
      warn "    xcode-select --install"
      warn "(That also provides git.) Then re-run this installer."
    fi
    return 0
  fi

  info "Installing dependencies (C compiler, git, liburing, pkg-config).."
  if has_cmd apt-get ; then
    apt_get_install clang git pkg-config liburing-dev || true
  elif has_cmd dnf ; then
    dnf_install clang git pkgconf-pkg-config liburing-devel || true
  elif has_cmd zypper ; then
    zypper_install clang git pkg-config liburing-devel || true
  elif has_cmd pacman ; then
    pacman_install clang git pkgconf liburing || true
  elif has_cmd apk ; then
    apk_install clang git pkgconf liburing-dev || true
  elif has_cmd yum ; then
    yum_install clang git pkgconfig liburing-devel || true
  else
    info "No supported package manager found; skipping dependency installation."
  fi
}

# git is not needed to compile, but `yo fetch` / `yo install` shell out to it.
check_git() {
  if has_cmd git; then
    return 0
  fi
  warn ""
  warn "WARNING: git was not found on PATH."
  warn "'yo compile' works without it, but 'yo fetch' and 'yo install' resolve"
  warn "dependencies with 'git ls-remote' and 'git clone' and will fail."
  if [ "$OSNAME" = "macos" ]; then
    warn "    xcode-select --install"
  else
    warn "    e.g. 'apt-get install git' or 'dnf install git'"
  fi
  warn ""
}

# A C compiler is not optional: without one `yo compile` cannot produce a binary.
check_c_compiler() {
  if has_cmd clang || has_cmd gcc || has_cmd cc; then
    return 0
  fi
  warn ""
  warn "WARNING: no C compiler (clang, gcc or cc) found on PATH."
  warn "Yo compiles to C, so 'yo compile' will fail until you install one."
  if [ "$OSNAME" = "macos" ]; then
    warn "    xcode-select --install"
  else
    warn "    e.g. 'apt-get install clang' or 'dnf install clang'"
  fi
  warn ""
}

# Guard the header-without-pkg-config trap described above.
check_liburing_consistency() {
  if [ "$OSNAME" != "linux" ]; then return 0; fi
  header=""
  for d in /usr/include /usr/local/include; do
    if [ -f "$d/liburing.h" ]; then header="yes"; fi
  done
  if [ -z "$header" ]; then return 0; fi
  if has_cmd pkg-config && pkg-config --exists liburing 2>/dev/null; then
    return 0
  fi
  warn ""
  warn "WARNING: <liburing.h> is present but pkg-config cannot see liburing."
  warn "Yo emits io_uring calls whenever that header exists, but only passes"
  warn "-luring when 'pkg-config --exists liburing' succeeds — so linking will"
  warn "fail with 'undefined reference to io_uring_*'."
  warn "Install pkg-config and liburing's .pc file (e.g. 'apt-get install"
  warn "pkg-config liburing-dev'), or remove liburing.h."
  warn ""
}

#---------------------------------------------------------
# Download
#---------------------------------------------------------

# Resolve the newest release tag.
#
# Prefer the /releases/latest REDIRECT over the REST API: the API is rate
# limited to 60 requests/hour per IP for unauthenticated callers, and shared
# egress IPs (CI runners, offices, NAT) routinely have that budget already
# spent — which is exactly how this failed on GitHub's own macOS runners while
# working locally. The redirect has no such limit and needs no token. The API
# stays as a fallback for wget-only boxes.
resolve_version() {
  if [ -n "$VERSION" ]; then return 0; fi
  info "Resolving the latest release.."

  if has_cmd curl ; then
    # -I: HEAD, -L: follow, and report where we landed:
    #   https://github.com/<repo>/releases/tag/v1.2.3
    effective="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
      "https://github.com/$YO_REPO/releases/latest" 2>/dev/null || true)"
    case "$effective" in
      */releases/tag/*) VERSION="${effective##*/}";;
    esac
  fi

  if [ -z "$VERSION" ]; then
    auth=""
    if [ -n "${GITHUB_TOKEN:-}" ]; then auth="$GITHUB_TOKEN"; fi
    if [ -z "$auth" ] && [ -n "${GH_TOKEN:-}" ]; then auth="$GH_TOKEN"; fi
    if has_cmd curl ; then
      if [ -n "$auth" ]; then
        VERSION="$(curl -sSL -H "Authorization: Bearer $auth" -H 'Accept: application/vnd.github+json' "$YO_API_URL/latest" 2>/dev/null \
          | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[ ]*:[ ]*"\([^"]*\)".*/\1/')"
      else
        VERSION="$(curl -sSL -H 'Accept: application/vnd.github+json' "$YO_API_URL/latest" 2>/dev/null \
          | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[ ]*:[ ]*"\([^"]*\)".*/\1/')"
      fi
    elif has_cmd wget ; then
      VERSION="$(wget -qO- --header='Accept: application/vnd.github+json' "$YO_API_URL/latest" 2>/dev/null \
        | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[ ]*:[ ]*"\([^"]*\)".*/\1/')"
    fi
  fi

  if [ -z "$VERSION" ]; then
    stop "Unable to resolve the latest release tag from GitHub.
  This is usually a network problem or an exhausted API rate limit.
  Pass a version explicitly, e.g. --version=v0.2.3"
  fi
}

download_file() {  # <url> <destination>
  if has_cmd curl ; then
    curl -fsSL "$1" -o "$2" || return 1
  elif has_cmd wget ; then
    wget -q "$1" -O "$2" || return 1
  else
    stop "Neither curl nor wget is available; cannot download $1"
  fi
}

#---------------------------------------------------------
# Install
#---------------------------------------------------------

install_dist() {
  bundle="yo-$VERSION-$OSARCH"
  url="$YO_DIST_BASE_URL/$VERSION/$bundle.tar.gz"
  target="$PREFIX/lib/yo/$VERSION"
  bindir="$PREFIX/bin"

  info "Installing Yo $VERSION for $OSARCH"
  info "  bundle:  $url"
  info "  target:  $target"
  info "  command: $bindir/yo"

  if [ "$DRYRUN" = "yes" ]; then
    info "(dry run — stopping before any change)"
    return 0
  fi

  if [ -e "$target" ] && [ -z "$FORCE" ]; then
    info "$VERSION is already installed at $target (use --force to reinstall)."
  else
    make_temp_dir
    info "Downloading.."
    if ! download_file "$url" "$YO_TEMP_DIR/$bundle.tar.gz"; then
      stop "Unable to download: $url
  There may be no bundle for this platform ($OSARCH) at $VERSION.
  Available targets: linux-x64, linux-arm64, macos-arm64, macos-x64.
  Pick another release with --version=<tag>, or build from source."
    fi

    info "Extracting.."
    tar -xzf "$YO_TEMP_DIR/$bundle.tar.gz" -C "$YO_TEMP_DIR" \
      || stop "Failed to extract $bundle.tar.gz"

    # The bundle keeps bin/, std/ and vendor/ as SIBLINGS: the compiler finds
    # its standard library by walking up from its own executable, and resolves
    # the vendored mimalloc as <std>/../vendor. Installing them apart breaks
    # both. Move the extracted tree in one piece.
    if [ ! -d "$YO_TEMP_DIR/$bundle/std" ] || [ ! -d "$YO_TEMP_DIR/$bundle/bin" ]; then
      stop "Unexpected bundle layout in $bundle.tar.gz (missing bin/ or std/)"
    fi

    if [ -e "$target" ]; then
      writable_parent "$PREFIX/lib/yo" && rm -rf "$target" || sudocmd rm -rf "$target"
    fi
    mkdirp "$PREFIX/lib/yo"
    movedir "$YO_TEMP_DIR/$bundle" "$target"
  fi

  mkdirp "$bindir"
  yo_exe="$target/bin/yo"
  [ -x "$yo_exe" ] || stop "Installed bundle has no executable at $yo_exe"
  if writable_parent "$bindir"; then
    ln -sf "$yo_exe" "$bindir/yo"
  else
    sudocmd ln -sf "$yo_exe" "$bindir/yo"
  fi
  info "Linked $bindir/yo -> $yo_exe"
}

writable_parent() {  # <dir>
  d="$1"
  while [ ! -e "$d" ] && [ "$d" != "/" ]; do d="$(dirname "$d")"; done
  [ -w "$d" ]
}

mkdirp() {  # <dir>
  if [ -d "$1" ]; then return 0; fi
  if writable_parent "$1"; then
    mkdir -p "$1"
  else
    sudocmd mkdir -p "$1"
  fi
}

movedir() {  # <src> <dst>
  if writable_parent "$(dirname "$2")"; then
    mv "$1" "$2"
  else
    sudocmd mv "$1" "$2"
  fi
}

#---------------------------------------------------------
# Verify
#
# A downloaded binary is not a working install: std must resolve, the vendored
# mimalloc must be found, and the C compiler must link. Compiling a hello world
# is the only check that exercises all three.
#---------------------------------------------------------

verify_install() {
  if [ -n "$NO_VERIFY" ]; then return 0; fi
  if [ "$DRYRUN" = "yes" ]; then return 0; fi
  if ! has_cmd clang && ! has_cmd gcc && ! has_cmd cc; then
    warn "Skipping verification: no C compiler available."
    return 0
  fi
  make_temp_dir
  cat > "$YO_TEMP_DIR/hello.yo" <<'YOEOF'
open(import("std/fmt"));
main :: (fn() -> unit)({
  println(`Yo is installed`);
});
export(main);
YOEOF
  info "Verifying (compiling a hello world).."
  if ! "$PREFIX/lib/yo/$VERSION/bin/yo" compile "$YO_TEMP_DIR/hello.yo" -o "$YO_TEMP_DIR/hello" > "$YO_TEMP_DIR/verify.log" 2>&1 ; then
    warn "Verification FAILED. Compiler output:"
    warn "$(cat "$YO_TEMP_DIR/verify.log")"
    stop "The install is present but cannot compile. See the output above."
  fi
  out="$("$YO_TEMP_DIR/hello" 2>&1 || true)"
  if [ "$out" != "Yo is installed" ]; then
    stop "Verification FAILED: the compiled program printed '$out'"
  fi
  info "Verified: compiled and ran a hello world."
}

#---------------------------------------------------------
# Uninstall
#---------------------------------------------------------

uninstall_dist() {
  root="$PREFIX/lib/yo"
  if [ -n "$VERSION" ]; then
    targets="$root/$VERSION"
  else
    targets="$root"
  fi

  if [ ! -e "$targets" ]; then
    info "Nothing to uninstall at $targets"
    return 0
  fi

  if [ -z "$FORCE" ]; then
    printf "Remove %s and the 'yo' command? [yN] " "$targets"
    read -r answer
    case "$answer" in
      [Yy]*) ;;
      *) info "Cancelled."; return 0;;
    esac
  fi

  if [ "$DRYRUN" = "yes" ]; then
    info "(dry run) would remove $targets and $PREFIX/bin/yo"
    return 0
  fi

  # Only remove the command if it points into what we are deleting.
  link="$PREFIX/bin/yo"
  if [ -L "$link" ]; then
    case "$(readlink "$link")" in
      "$root"/*)
        if writable_parent "$PREFIX/bin"; then rm -f "$link"; else sudocmd rm -f "$link"; fi
        info "Removed $link";;
    esac
  fi

  if writable_parent "$root"; then rm -rf "$targets"; else sudocmd rm -rf "$targets"; fi
  info "Removed $targets"

  # Tidy up an empty $PREFIX/lib/yo left behind by a versioned uninstall.
  if [ -d "$root" ] && [ -z "$(ls -A "$root" 2>/dev/null)" ]; then
    if writable_parent "$root"; then rmdir "$root"; else sudocmd rmdir "$root"; fi
  fi
}

#---------------------------------------------------------
# PATH advice
#---------------------------------------------------------

path_advice() {
  bindir="$PREFIX/bin"
  if on_path "$bindir"; then return 0; fi
  info ""
  info "NOTE: $bindir is not on your PATH. Add it with:"
  info "    export PATH=\"$bindir:\$PATH\""
  info "and put that line in your shell profile (~/.bashrc, ~/.zshrc, ..)."
}

#---------------------------------------------------------
# Main
#---------------------------------------------------------

main_help() {
  echo "usage: install.sh [options]"
  echo ""
  echo "options:"
  echo "  -q, --quiet              suppress output"
  echo "  -f, --force              overwrite an existing install / skip prompts"
  echo "  -p, --prefix=<dir>       install prefix (default: \$HOME/.local)"
  echo "  -v, --version=<tag>      release to install (default: latest)"
  echo "  -u, --uninstall          uninstall instead of install"
  echo "      --no-deps            do not install system dependencies"
  echo "      --no-verify          skip the post-install hello-world compile"
  echo "      --dry-run            show what would happen, change nothing"
  echo "  -h, --help               show this help"
  echo ""
  echo "Installs to <prefix>/lib/yo/<tag> and links <prefix>/bin/yo."
  echo ""
  echo "examples:"
  echo "  install.sh                                  # latest, into ~/.local"
  echo "  install.sh --version=v0.2.3                 # a specific release"
  echo "  install.sh --prefix=/usr/local              # system-wide (uses sudo)"
  echo "  install.sh --no-deps --no-verify -f         # unattended (CI)"
}

main_install() {
  detect_osarch
  resolve_version
  install_dependencies
  check_c_compiler
  check_git
  check_liburing_consistency
  install_dist
  if [ "$DRYRUN" = "yes" ]; then
    return 0
  fi
  verify_install
  path_advice
  info ""
  info "Yo $VERSION is installed. Try:"
  info "    yo --help"
}

main_uninstall() {
  detect_osarch
  uninstall_dist
}

process_options "$@"
case "$MODE" in
  help)      main_help;;
  uninstall) main_uninstall;;
  *)         main_install;;
esac
