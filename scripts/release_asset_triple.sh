#!/usr/bin/env bash
# The published-asset name for an internal release target label.
#
# Internal labels stay short (`macos-arm64`, `linux-x64-musl`) because they are
# also artifact names, job titles and the portable-arm presence checks in
# .github/workflows/release.yml. What ships is the canonical target triple, so
# the ABI is explicit on every platform the way `-musl` already made it explicit
# on Linux — plans/RELEASE_ASSET_TRIPLES.md.
#
# Sourced by release.yml. `install.sh` / `install.ps1` cannot use this file:
# they are fetched standalone over HTTP and carry their own copy of the mapping.
#
#   . scripts/release_asset_triple.sh
#   asset_triple macos-arm64   # -> aarch64-apple-darwin
asset_triple() {
  case "$1" in
    macos-arm64)      echo "aarch64-apple-darwin" ;;
    macos-x64)        echo "x86_64-apple-darwin" ;;
    windows-arm64)    echo "aarch64-pc-windows-msvc" ;;
    windows-x64)      echo "x86_64-pc-windows-msvc" ;;
    linux-arm64-musl) echo "aarch64-unknown-linux-musl" ;;
    linux-x64-musl)   echo "x86_64-unknown-linux-musl" ;;
    # Portable-C arms only: the single-file C is emitted for the OS default ABI,
    # which on Linux is glibc. There is no musl arm — the same C compiles under
    # either libc.
    linux-arm64)      echo "aarch64-unknown-linux-gnu" ;;
    linux-x64)        echo "x86_64-unknown-linux-gnu" ;;
    *)
      echo "asset_triple: no published triple for target '$1'" >&2
      return 1
      ;;
  esac
}

# Self-test: `bash scripts/release_asset_triple.sh --check` asserts the whole
# table, so a typo fails here rather than by publishing a misnamed asset.
if [ "${1:-}" = "--check" ]; then
  fail=0
  check() {
    got=$(asset_triple "$1") || { echo "FAIL $1: mapping errored"; fail=1; return; }
    if [ "$got" != "$2" ]; then
      echo "FAIL $1: got '$got', want '$2'"
      fail=1
    fi
  }
  check macos-arm64 aarch64-apple-darwin
  check macos-x64 x86_64-apple-darwin
  check windows-arm64 aarch64-pc-windows-msvc
  check windows-x64 x86_64-pc-windows-msvc
  check linux-arm64-musl aarch64-unknown-linux-musl
  check linux-x64-musl x86_64-unknown-linux-musl
  check linux-arm64 aarch64-unknown-linux-gnu
  check linux-x64 x86_64-unknown-linux-gnu
  if asset_triple bogus-target >/dev/null 2>&1; then
    echo "FAIL: an unknown target must not resolve"
    fail=1
  fi
  [ "$fail" = 0 ] && echo "release_asset_triple: all mappings OK"
  exit "$fail"
fi
