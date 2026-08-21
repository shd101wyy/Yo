#!/bin/sh -e

#-----------------------------------------------------------------------------
# Installation script for Yo on Linux, macOS and HarmonyOS; use -h to see options.
#
#   curl -fsSL https://raw.githubusercontent.com/shd101wyy/Yo/develop/scripts/install.sh | sh
#
# Installs a prebuilt release bundle, or on platforms with no bundle (NixOS,
# Alpine-of-old, HarmonyOS) builds the published single-file yo.c with the
# local C compiler. Yo is self-hosted: the bundle carries the native compiler
# plus the standard library and the vendored mimalloc sources, so there is no
# toolchain to build and nothing to compile at install time — except on the
# source path, which compiles exactly that one file.
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
FROM_SOURCE=""          # build from the published single-file yo.c
CC_OVERRIDE=""          # -cc / --c-compiler
CFLAGS_OVERRIDE=""      # -cflags / --c-flags

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
    [Hh]armony[Oo][Ss]) OSNAME="harmonyos";;
    *) stop "Unsupported OS: $(uname). This installer supports Linux, macOS and HarmonyOS.
  On Windows use scripts/install.ps1 instead.";;
  esac

  if [ "$OSNAME" = "harmonyos" ]; then
    # HarmonyOS compiles the published single-file yo.c: the release has no
    # HarmonyOS bundles, but the per-target linux-<arch> artifact builds with
    # the OHOS toolchain (a musl system on a Linux-derived kernel).
    OSDISTRO="harmonyos"
    OSARCH="linux-$arch"
  else
    OSARCH="$OSNAME-$arch"
  fi

  if [ "$OSNAME" = "linux" ]; then
    distrocfg=""
    if [ -r /etc/os-release ]; then
      distrocfg="$(cat /etc/os-release 2>/dev/null)"
    fi

    # Immutable / atomic distributions come FIRST: several of them also match
    # a classic family (SteamOS is Arch, Bazzite is Fedora), but their root
    # filesystem is read-only or declaratively managed, so imperatively
    # installing packages either fails outright or is reverted by the next
    # system update. They need advice, not a package manager.
    if [ -f /etc/NIXOS ] || contains "$distrocfg" "^ID=nixos"; then
      OSDISTRO="nixos"
    elif contains "$distrocfg" "^ID=steamos"; then
      OSDISTRO="steamos"
    # /run/ostree-booted is the authoritative marker — the rpm-ostree BINARY can
    # also exist on an ordinary mutable Fedora, where skipping dnf would be
    # wrong.
    elif [ -f /run/ostree-booted ]; then
      OSDISTRO="ostree"
    elif has_cmd transactional-update; then
      OSDISTRO="microos"
    elif contains "$distrocfg" "rhel|centos|fedora|rocky|alma"; then
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

# True for distributions where imperative package installation is the wrong
# answer, whatever package manager happens to be present.
is_immutable_distro() {
  case "$OSDISTRO" in
    nixos|steamos|ostree|microos) return 0;;
    *) return 1;;
  esac
}

is_harmonyos() {
  [ "$OSDISTRO" = "harmonyos" ]
}

immutable_distro_advice() {
  case "$OSDISTRO" in
    nixos)
      warn "NixOS detected: packages are managed declaratively, so this script"
      warn "will not install anything. Get a toolchain with, for example:"
      warn "    nix-shell -p clang git pkg-config liburing"
      warn "or add those to your configuration.nix / home-manager profile.";;
    steamos)
      warn "SteamOS detected: the root filesystem is read-only and pacman"
      warn "changes are reverted by system updates. Rather than"
      warn "'steamos-readonly disable', prefer a container:"
      warn "    distrobox create --name dev --image archlinux"
      warn "    distrobox enter dev   # then install clang git pkgconf liburing";;
    ostree)
      warn "An ostree-based system (Silverblue/Kinoite/Bazzite) was detected."
      warn "Install the toolchain with rpm-ostree (needs a reboot):"
      warn "    rpm-ostree install clang git pkgconf-pkg-config liburing-devel"
      warn "or work inside a toolbox:  toolbox enter";;
    microos)
      warn "openSUSE MicroOS detected: use a transactional update (needs a reboot):"
      warn "    transactional-update pkg install clang git pkg-config liburing-devel"
      warn "or work inside a distrobox container.";;
  esac
}

# The published Linux bundles are ordinary glibc binaries whose ELF interpreter
# is an absolute path (/lib64/ld-linux-x86-64.so.2). NixOS does not provide that
# path — the loader lives in /nix/store — so the binary fails to exec with a
# baffling "No such file or directory" even though the file is plainly there.
# Say so up front rather than let the user meet that error cold.
check_dynamic_loader() {
  if [ "$OSNAME" != "linux" ]; then return 0; fi
  case "$(uname -m)" in
    x86_64*|amd64*) loader="/lib64/ld-linux-x86-64.so.2";;
    arm64*|aarch64*) loader="/lib/ld-linux-aarch64.so.1";;
    *) return 0;;
  esac
  if [ -e "$loader" ]; then return 0; fi
  warn ""
  warn "WARNING: this system has no $loader."
  warn "The published bundle is a normal glibc binary and will fail to start"
  warn "with 'No such file or directory' even once installed."
  if [ "$OSDISTRO" = "nixos" ]; then
    warn "On NixOS, run it through one of:"
    warn "    nix-shell -p steam-run --run 'steam-run yo --help'"
    warn "    programs.nix-ld.enable = true;   # then re-login"
    warn "or patch the interpreter:  patchelf --set-interpreter \"\$(cat \$NIX_CC/nix-support/dynamic-linker)\" <yo>"
  fi
  warn ""
  # Non-zero = "the prebuilt bundle cannot run here". The caller uses this to
  # point at the source install, which genuinely fixes it. Without this the
  # function returned the status of `warn ""` (always 0) and every caller
  # believed the loader was fine.
  return 1
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
      # Source install: build from the published single-file yo.c instead of
      # downloading a native bundle. Supplying either of these FORCES the
      # source path even on a platform that has a bundle — deliberately, so it
      # is exercisable on machines we can test, rather than being dead code
      # that only ever runs on platforms we cannot reach.
      -cc|--c-compiler) shift; CC_OVERRIDE="$1"; FROM_SOURCE="yes";;
      -cflags|--c-flags) shift; CFLAGS_OVERRIDE="$1"; FROM_SOURCE="yes";;
      --from-source)   FROM_SOURCE="yes";;
      *)
        case "$1" in
          -p=*|--prefix=*)   PREFIX="${1#*=}";;
          -v=*|--version=*)  VERSION="${1#*=}";;
          -cc=*|--c-compiler=*)  CC_OVERRIDE="${1#*=}"; FROM_SOURCE="yes";;
          -cflags=*|--c-flags=*) CFLAGS_OVERRIDE="${1#*=}"; FROM_SOURCE="yes";;
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
#     `git fetch` and `git checkout` (src/fetch.yo, install_command.yo).
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
    # DPkg::Lock::Timeout because apt-get otherwise waits on
    # /var/lib/dpkg/lock-frontend FOREVER, with no output. That is not a corner
    # case here: a freshly installed Ubuntu runs unattended-upgrades on first
    # boot, which is exactly when somebody curls this script — so the installer
    # would appear to hang on the very machines it is written for. Ten minutes,
    # then a real error message. (Same fix as CI's APT_OPTS; see
    # issues/ci-apt-hangs-on-dpkg-lock.md for the measurement that identified
    # it.)
    # shellcheck disable=SC2086
    if ! sudocmd apt-get -o DPkg::Lock::Timeout=600 install -y $missing; then
      warn "Installing apt packages failed ($missing)."
      warn "If it timed out waiting for the package lock, another package"
      warn "manager (often unattended-upgrades on a new install) holds it —"
      warn "wait for it to finish and re-run, or re-run with --no-deps."
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

# Which dependencies are actually absent. Computed BEFORE touching a package
# manager so an already-equipped machine is never asked for a sudo password to
# install nothing — the common case for developer boxes and CI images.
MISSING_CC=""
MISSING_GIT=""
MISSING_PKGCONFIG=""
MISSING_LIBURING=""

compute_missing_deps() {
  MISSING_CC=""; MISSING_GIT=""; MISSING_PKGCONFIG=""; MISSING_LIBURING=""
  if ! has_cmd clang && ! has_cmd gcc && ! has_cmd cc; then MISSING_CC="yes"; fi
  if ! has_cmd git; then MISSING_GIT="yes"; fi
  if [ "$OSNAME" = "linux" ] || is_harmonyos; then
    if ! has_cmd pkg-config && ! has_cmd pkgconf; then MISSING_PKGCONFIG="yes"; fi
    # "Installed" for liburing means pkg-config can SEE it, since that is
    # exactly the test the compiler makes before adding -luring.
    if ! (has_cmd pkg-config && pkg-config --exists liburing 2>/dev/null); then
      MISSING_LIBURING="yes"
    fi
  fi
}

any_missing() {
  if [ -n "$MISSING_CC$MISSING_GIT$MISSING_PKGCONFIG$MISSING_LIBURING" ]; then
    return 0
  fi
  return 1
}

# Package names differ per distribution; select only the missing ones.
_pkglist() {  # <cc-pkg> <git-pkg> <pkgconfig-pkg> <liburing-pkg>
  out=""
  if [ -n "$MISSING_CC" ]; then out="$out $1"; fi
  if [ -n "$MISSING_GIT" ]; then out="$out $2"; fi
  if [ -n "$MISSING_PKGCONFIG" ]; then out="$out $3"; fi
  if [ -n "$MISSING_LIBURING" ]; then out="$out $4"; fi
  echo "$out"
}

install_dependencies() {
  if [ -n "$NO_DEPS" ]; then
    info "Skipping dependency installation (--no-deps)."
    return 0
  fi

  compute_missing_deps
  if ! any_missing ; then
    info "All dependencies are already present; installing nothing."
    return 0
  fi

  if [ "$OSNAME" = "macos" ]; then
    # macOS ships clang AND git with the Command Line Tools, and uses kqueue
    # rather than io_uring, so a single CLT install covers everything.
    if [ -n "$MISSING_CC" ] || [ -n "$MISSING_GIT" ]; then
      warn "Missing developer tools. Install Apple's Command Line Tools:"
      warn "    xcode-select --install"
      warn "That provides both clang and git. Then re-run this installer."
    fi
    return 0
  fi

  if is_harmonyos; then
    # HarmonyOS has no apt/dnf/pacman; package management is harmonybrew —
    # a Homebrew reimplementation whose 'brew' works like macOS's, provided
    # by https://harmonybrew.atomgit.com/. It likewise CANNOT be installed
    # from inside this script (it needs its own installer), so ask first.
    if ! has_cmd brew; then
      warn ""
      warn "HarmonyOS detected, but 'brew' is not on PATH."
      warn "Install harmonybrew first — a Homebrew reimplementation for"
      warn "HarmonyOS that provides the 'brew' command like macOS:"
      warn "    https://harmonybrew.atomgit.com/"
      warn "Then re-run this installer."
      warn ""
      return 1
    fi

    # brew installs into <prefix>/bin; make that visible for the rest of the
    # script even when the user has not added it to their shell profile.
    brew_bin="$(brew --prefix 2>/dev/null)/bin"
    if [ -d "$brew_bin" ] && ! on_path "$brew_bin"; then
      PATH="$brew_bin:$PATH"
      info "Added $brew_bin to PATH for this run."
    fi

    # Install only the absent formulas; brew list --formula is the check.
    brew_install_if_missing() {  # <formula...>
      missing=""
      for f in "$@"; do
        if ! brew list --formula "$f" >/dev/null 2>&1; then
          missing="$missing $f"
        fi
      done
      if [ -n "$missing" ]; then
        info "Installing:$missing"
        # shellcheck disable=SC2086
        brew install $missing || return 1
      fi
      return 0
    }

    brew_install_if_missing ohos-sdk || true   # the OHOS clang/llvm toolchain
    if [ -n "$MISSING_GIT" ]; then brew_install_if_missing git || true; fi
    if ! has_cmd curl; then brew_install_if_missing curl || true; fi
    # pkgconf pairs with liburing EXACTLY as on Linux: the compiler adds
    # -luring only when `pkg-config --exists liburing` succeeds, so a box
    # with the header but no pkg-config emits io_uring calls that cannot
    # link (the header-without-pkg-config trap).
    if [ -n "$MISSING_PKGCONFIG$MISSING_LIBURING" ]; then
      brew_install_if_missing pkgconf liburing || true
    fi
    return 0
  fi

  if is_immutable_distro ; then
    info "Missing:$(_pkglist 'a C compiler' 'git' 'pkg-config' 'liburing')"
    immutable_distro_advice
    return 0
  fi

  pkgs=""
  if has_cmd apt-get ; then
    pkgs="$(_pkglist clang git pkg-config liburing-dev)"
  elif has_cmd dnf ; then
    pkgs="$(_pkglist clang git pkgconf-pkg-config liburing-devel)"
  elif has_cmd zypper ; then
    pkgs="$(_pkglist clang git pkg-config liburing-devel)"
  elif has_cmd pacman ; then
    pkgs="$(_pkglist clang git pkgconf liburing)"
  elif has_cmd apk ; then
    pkgs="$(_pkglist clang git pkgconf liburing-dev)"
  elif has_cmd yum ; then
    pkgs="$(_pkglist clang git pkgconfig liburing-devel)"
  else
    warn "No supported package manager found; skipping dependency installation."
    warn "Missing:$(_pkglist 'a C compiler' 'git' 'pkg-config' 'liburing')"
    return 0
  fi

  info "Installing:$pkgs"
  # shellcheck disable=SC2086
  if has_cmd apt-get ; then
    apt_get_install $pkgs || true
  elif has_cmd dnf ; then
    dnf_install $pkgs || true
  elif has_cmd zypper ; then
    zypper_install $pkgs || true
  elif has_cmd pacman ; then
    pacman_install $pkgs || true
  elif has_cmd apk ; then
    apk_install $pkgs || true
  elif has_cmd yum ; then
    yum_install $pkgs || true
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
  elif is_harmonyos; then
    warn "    brew install git"
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
  elif is_harmonyos; then
    warn "    brew install ohos-sdk   # provides clang and llvm"
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

# Does <url> exist? Used to choose between bundle flavors WITHOUT downloading
# either, so an optional bundle can be probed cheaply. Header-only request, and
# deliberately quiet: a miss here is an expected outcome, not an error.
download_probe() {  # <url>
  if has_cmd curl ; then
    curl -fsSL -I -o /dev/null "$1" 2>/dev/null || return 1
  elif has_cmd wget ; then
    wget -q --spider "$1" 2>/dev/null || return 1
  else
    return 1
  fi
}

#---------------------------------------------------------
# Install
#---------------------------------------------------------

# True when the C library is musl rather than glibc (Alpine and friends).
# `ldd --version` is the reliable probe: musl's prints "musl libc" — on stderr,
# and with a non-zero exit, so both have to be swallowed. The distro check is a
# fallback for images with no ldd at all.
is_musl() {
  if has_cmd ldd && ldd --version 2>&1 | grep -qi musl; then return 0; fi
  [ "$OSDISTRO" = "alpine" ]
}

install_dist() {
  # Linux is musl-only (2026-08-20): the static musl bundle is THE Linux
  # bundle — it runs on glibc and musl systems alike, so it is preferred on
  # EVERY Linux, not just detected-musl ones. The probe + glibc fallback
  # stays for releases that predate the musl legs (x64: v0.2.7+,
  # arm64: v0.2.12+); on a glibc host that fallback is fully functional,
  # on a musl host it will not run — hence the differentiated warning.
  bundle="yo-$VERSION-$OSARCH"
  if [ "$OSNAME" = "linux" ]; then
    musl_bundle="yo-$VERSION-$OSARCH-musl"
    if download_probe "$YO_DIST_BASE_URL/$VERSION/$musl_bundle.tar.gz"; then
      info "Using the static musl Linux bundle (runs on glibc and musl alike)."
      bundle="$musl_bundle"
    elif is_musl; then
      warn "musl libc detected, but $VERSION publishes no $musl_bundle bundle."
      warn "Falling back to the glibc bundle, which will NOT run here."
      warn "Prefer:  --from-source   (compiles yo.c with your own toolchain)"
    else
      info "$VERSION predates the static musl bundles — using its glibc bundle."
    fi
  fi
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
  Available targets: linux-x64-musl, linux-arm64-musl, macos-arm64, macos-x64, windows-x64.
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

#---------------------------------------------------------
# Source install (the single-file yo.c)
#
# Used when the platform has no native bundle, or when the caller passes
# -cc/-cflags. The published yo.c carries one complete translation unit per
# platform behind preprocessor conditionals, so the same file builds anywhere
# with a C compiler (plans/PORTABLE_C_DISTRIBUTION.md).
#
# The compiled binary still needs std/ at runtime — it is a compiler, not a
# self-contained program — so the release SOURCE tarball is fetched for it and
# laid out in exactly the bundle's shape (bin/ and std/ as siblings), which is
# what the executable-relative std lookup expects. vendor/mimalloc is NOT
# needed: the published C is the libc-allocator flavor.
#---------------------------------------------------------

pick_c_compiler() {
  if [ -n "$CC_OVERRIDE" ]; then
    has_cmd "$CC_OVERRIDE" || stop "C compiler not found: $CC_OVERRIDE"
    echo "$CC_OVERRIDE"; return 0
  fi
  if has_cmd cc; then echo "cc"; return 0; fi
  if has_cmd clang; then echo "clang"; return 0; fi
  if has_cmd gcc; then echo "gcc"; return 0; fi
  stop "No C compiler found. Install clang or gcc, or pass --c-compiler <cc>."
}

install_from_source() {
  # Per-target split (2026-08-21): releases publish one ~6 MiB
  # yo-<v>-<target>.c.gz per platform instead of the ~30 MiB merged file.
  # Older releases only have the merged yo-<v>.c.gz — probe, then fall back.
  cfile="yo-$VERSION-$OSARCH.c.gz"
  curl_url="$YO_DIST_BASE_URL/$VERSION/$cfile"
  if ! download_probe "$curl_url"; then
    info "$VERSION predates the per-target yo.c split — using the merged file."
    cfile="yo-$VERSION.c.gz"
    curl_url="$YO_DIST_BASE_URL/$VERSION/$cfile"
  fi
  src_url="https://github.com/$YO_REPO/archive/refs/tags/$VERSION.tar.gz"
  target="$PREFIX/lib/yo/$VERSION"
  bindir="$PREFIX/bin"
  CC_BIN="$(pick_c_compiler)"

  info "Installing Yo $VERSION for $OSARCH FROM SOURCE"
  info "  yo.c:     $curl_url"
  info "  std:      $src_url"
  info "  compiler: $CC_BIN"
  [ -n "$CFLAGS_OVERRIDE" ] && info "  cflags:   $CFLAGS_OVERRIDE"
  info "  target:   $target"

  if [ "$DRYRUN" = "yes" ]; then
    info "(dry run — stopping before any change)"
    return 0
  fi

  make_temp_dir
  info "Downloading yo.c.."
  download_file "$curl_url" "$YO_TEMP_DIR/$cfile" \
    || stop "Unable to download $curl_url
  $VERSION may predate the single-file yo.c artifact. Try a newer --version."
  gzip -dc "$YO_TEMP_DIR/$cfile" > "$YO_TEMP_DIR/yo.c" \
    || stop "Failed to decompress $cfile"

  info "Downloading the standard library.."
  download_file "$src_url" "$YO_TEMP_DIR/src.tar.gz" \
    || stop "Unable to download the source tarball: $src_url"
  (cd "$YO_TEMP_DIR" && tar -xzf src.tar.gz) || stop "Failed to extract the source tarball"
  src_std="$(find "$YO_TEMP_DIR" -maxdepth 2 -type d -name std | head -1)"
  [ -n "$src_std" ] || stop "The source tarball has no std/ directory"

  # -w: the emitted C is machine-generated and warns freely; warnings here are
  # noise, not signal, and would bury a real error.
  # -luring is REQUIRED whenever <liburing.h> is present, and must be decided
  # here rather than assumed. The emitted C opens its Linux async runtime with
  # `#if __has_include(<liburing.h>)` — a check made on THIS machine at this
  # moment — and the runtime it then compiles in calls real liburing symbols
  # (io_uring_queue_init/_submit/_wait_cqe), not just the header's static
  # inlines. So the header alone flips on code that cannot link without the
  # library, which is the exact trap check_liburing_consistency warns about;
  # this line simply has to obey it.
  #
  # Getting it wrong is worse than a link error in one direction: with NO
  # header the file compiles happily and the async runtime is silently
  # replaced by stubs, producing a `yo` that cannot read source files at all
  # (test.yml's musl leg asserts against exactly that outcome).
  #
  # pkg-config is the same oracle the compiler itself consults before adding
  # -luring, so this stays consistent with a bundle-built compiler.
  uring_libs=""
  uring_cflags=""
  if { [ "$OSNAME" = "linux" ] || is_harmonyos; } && has_cmd pkg-config && pkg-config --exists liburing 2>/dev/null; then
    uring_libs="$(pkg-config --libs liburing 2>/dev/null || echo -luring)"
    # The brew prefix is not a default include path (unlike /usr/include on
    # Linux), so the -I that locates liburing.h must come from pkg-config too.
    # Without it __has_include(<liburing.h>) is false at the user's compile
    # and the async runtime is silently stubbed out. Harmless elsewhere.
    uring_cflags="$(pkg-config --cflags liburing 2>/dev/null || true)"
    if is_harmonyos; then
      # The OHOS loader does not search brew's lib dir, and any
      # LD_LIBRARY_PATH pointing into the brew prefix breaks clang's linker
      # entirely (the loader refuses lld's bundled libxml2). Linking liburing
      # STATICALLY keeps `yo` runnable without any of that: the async runtime
      # comes out of liburing.a and the only DT_NEEDED left is libc.so.
      uring_libs="-Wl,-Bstatic $uring_libs -Wl,-Bdynamic"
    fi
    info "  liburing: $uring_libs (async I/O compiled in)"
  elif is_harmonyos || [ "$OSNAME" = "linux" ]; then
    warn "liburing is not visible to pkg-config, so async I/O will be compiled OUT"
    warn "and the resulting compiler cannot read source files. Install it first"
    warn "(e.g. 'apt-get install pkg-config liburing-dev', or on HarmonyOS"
    warn "'brew install pkgconf liburing') and re-run."
  fi

  info "Compiling yo.c (this takes a minute).."
  # shellcheck disable=SC2086  # CFLAGS_OVERRIDE, uring_cflags and uring_libs are intentionally word-split
  "$CC_BIN" -std=c11 -fno-strict-aliasing -fwrapv -w -O2 \
    "$YO_TEMP_DIR/yo.c" -o "$YO_TEMP_DIR/yo" $CFLAGS_OVERRIDE $uring_cflags -lpthread -lm $uring_libs \
    || stop "Failed to compile yo.c with $CC_BIN.
  On Linux, install the liburing development headers first (see --help).$(if is_harmonyos; then echo "
  On HarmonyOS the OHOS clang (ohos-sdk) is strict C11: releases before the
  label/statx compatibility fixes cannot build here — try a newer release."; fi)"

  info "Installing.."
  stage="$YO_TEMP_DIR/stage"
  mkdir -p "$stage/bin"
  mv "$YO_TEMP_DIR/yo" "$stage/bin/yo"
  chmod +x "$stage/bin/yo"
  cp -R "$src_std" "$stage/std"

  if [ -e "$target" ]; then
    writable_parent "$PREFIX/lib/yo" && rm -rf "$target" || sudocmd rm -rf "$target"
  fi
  mkdirp "$PREFIX/lib/yo"
  movedir "$stage" "$target"

  mkdirp "$bindir"
  yo_exe="$target/bin/yo"
  [ -x "$yo_exe" ] || stop "Source install produced no executable at $yo_exe"
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
    if is_harmonyos; then
      warn "On HarmonyOS, an immediate 'Bad system call' (rc=159/SIGSYS) usually"
      warn "means a sandbox/seccomp policy blocks io_uring — the compiler reads"
      warn "every source file through io_uring and cannot fall back to blocking"
      warn "I/O. Check for seccomp/container restrictions on this device."
    fi
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
  echo "      --from-source        build from the published single-file yo.c"
  echo "  -cc, --c-compiler=<cc>   C compiler for the source build (implies --from-source)"
  echo "  -cflags, --c-flags=<f>   extra C flags for the source build (implies --from-source)"
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
  echo "  install.sh --from-source                    # compile yo.c locally"
  echo "  install.sh -cc=gcc -cflags='-march=native'  # source build, chosen toolchain"
  echo ""
  echo "The source build works where no bundle can run - notably Alpine/musl,"
  echo "NixOS, whose loaders the prebuilt glibc binary cannot use, and"
  echo "HarmonyOS, which has no bundles (dependencies come from harmonybrew)."
}

main_install() {
  detect_osarch
  if is_harmonyos; then
    # No HarmonyOS bundles are published; the linux-<arch> single-file yo.c
    # compiles with the OHOS clang, so the source path is the only path.
    FROM_SOURCE="yes"

    # The OHOS loader cannot symbol-resolve the ohos-sdk's bundled libxml2
    # that clang's linker (lld) needs, and an LD_LIBRARY_PATH pointing into
    # the brew prefix makes that failure CERTAIN (the loader then refuses
    # the resolution entirely, even with LD_PRELOAD). Nothing in this
    # installer needs the variable: liburing is statically linked and the
    # -L flags come from pkg-config, so drop it for the run and say why.
    # (The compiler also static-links liburing into user programs, so Yo
    # never needs brew lib dirs at runtime either.)
    if [ -n "${LD_LIBRARY_PATH:-}" ]; then
      warn ""
      warn "WARNING: LD_LIBRARY_PATH=$LD_LIBRARY_PATH"
      warn "points into the brew prefix, which breaks the OHOS clang's"
      warn "linker (lld cannot load its libxml2 dependency). Yo does not"
      warn "need it — liburing is statically linked into yo and your"
      warn "programs. Unsetting it for this run; consider removing it from"
      warn "your shell profile."
      warn ""
      unset LD_LIBRARY_PATH
    fi
  fi
  resolve_version
  install_dependencies
  # check_dynamic_loader detects the two distros where the published Linux
  # bundle cannot run at all (musl/Alpine, and NixOS where
  # /lib64/ld-linux-x86-64.so.2 does not exist). Building from the published
  # yo.c fixes BOTH, because the user's own C compiler links against their own
  # libc and loader — the source path is the real answer there, not a warning.
  # On musl the STATIC musl bundle needs no loader at all, so install_dist
  # handles it and this advice would be actively misleading — it would send an
  # Alpine user to a source build they no longer need. Suppress it there and
  # let install_dist decide (it warns and falls back on its own if the release
  # has no musl bundle). NixOS still lands here, which is the case the source
  # path genuinely fixes.
  if [ -z "$FROM_SOURCE" ] && ! is_musl && ! check_dynamic_loader; then
    info ""
    info "The prebuilt bundle cannot run on this system, but the published"
    info "single-file yo.c can be compiled here. Re-run with:"
    info "    install.sh --from-source"
    info "(or pass --c-compiler <cc> / --c-flags '<flags>' to choose the toolchain)"
  fi
  check_c_compiler
  check_git
  check_liburing_consistency
  if [ -n "$FROM_SOURCE" ]; then
    install_from_source
  else
    install_dist
  fi
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
