#!/usr/bin/env bash
# Build the pinned Z3 as one self-contained `z3` executable for a release target
# (plans/backlog/DEFAULT_ON_VERIFICATION.md, step SD; decision D9).
#
#   bash scripts/build-static-z3.sh <z3-version> <target-triple> <out-dir>
#
# Writes `<out-dir>/z3-<z3-version>-<target-triple>/bin/z3[.exe]` and the Z3
# licence beside `bin/`. Nothing else ships: no libz3, no headers, no bindings.
#
# Per target:
#   *-unknown-linux-musl  run INSIDE Alpine (musl); links with -static, so the
#                         binary needs no loader and runs on any Linux kernel,
#                         glibc or musl (the official Z3 assets need glibc 2.38+).
#   *-apple-darwin        libz3 is linked in statically; the binary depends only
#                         on the system's libSystem and libc++ (macOS has no
#                         static libc). Deployment target 11.0.
#   *-pc-windows-msvc     run with an MSVC developer environment for the target
#                         architecture; /MT links the C runtime statically.
#
# Needs: curl, tar, cmake, ninja, python3 and the platform C++ compiler.
# `Z3_BUILD_JOBS` caps the parallelism (default: all cores).
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <z3-version> <target-triple> <out-dir>" >&2
  exit 2
fi
VER="$1"
TRIPLE="$2"
OUT="$3"

case "$TRIPLE" in
  x86_64-unknown-linux-musl | aarch64-unknown-linux-musl)
    EXE=z3
    PLATFORM_ARGS=(-DCMAKE_EXE_LINKER_FLAGS=-static)
    ;;
  x86_64-apple-darwin)
    EXE=z3
    PLATFORM_ARGS=(-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 -DCMAKE_OSX_ARCHITECTURES=x86_64)
    ;;
  aarch64-apple-darwin)
    EXE=z3
    PLATFORM_ARGS=(-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 -DCMAKE_OSX_ARCHITECTURES=arm64)
    ;;
  x86_64-pc-windows-msvc | aarch64-pc-windows-msvc)
    EXE=z3.exe
    # cmake_minimum_required(3.16) turns policy CMP0091 on, so the runtime is
    # chosen by CMAKE_MSVC_RUNTIME_LIBRARY and Z3's own /MD -> /MT rewrite of
    # the flag strings finds nothing to rewrite: both settings are needed.
    PLATFORM_ARGS=(-DZ3_BUILD_LIBZ3_MSVC_STATIC=ON -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
      -DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl)
    ;;
  *)
    echo "build-static-z3: no recipe for target '$TRIPLE'" >&2
    exit 2
    ;;
esac

if [ -z "${Z3_BUILD_JOBS:-}" ]; then
  Z3_BUILD_JOBS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "${NUMBER_OF_PROCESSORS:-4}")
fi

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d 2>/dev/null || mktemp -d -t z3build)
trap 'rm -rf "$WORK"' EXIT

echo "build-static-z3: Z3 $VER for $TRIPLE ($Z3_BUILD_JOBS jobs)"
curl -fsSL --retry 3 "https://github.com/Z3Prover/z3/archive/refs/tags/z3-$VER.tar.gz" -o "$WORK/src.tar.gz"
tar -xzf "$WORK/src.tar.gz" -C "$WORK"
SRC="$WORK/z3-z3-$VER"
[ -f "$SRC/CMakeLists.txt" ] || { echo "build-static-z3: unexpected source layout" >&2; exit 1; }

# No git metadata in the version string: `z3 --version` must print exactly
# `Z3 version <ver> - 64 bit`, the identity the verify cache keys on.
cmake -S "$SRC" -B "$WORK/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DZ3_BUILD_LIBZ3_SHARED=OFF \
  -DZ3_BUILD_EXECUTABLE=ON \
  -DZ3_BUILD_TEST_EXECUTABLES=OFF \
  -DZ3_ENABLE_EXAMPLE_TARGETS=OFF \
  -DZ3_BUILD_DOCUMENTATION=OFF \
  -DZ3_BUILD_PYTHON_BINDINGS=OFF \
  -DZ3_BUILD_DOTNET_BINDINGS=OFF \
  -DZ3_BUILD_JAVA_BINDINGS=OFF \
  -DZ3_INCLUDE_GIT_HASH=OFF \
  -DZ3_INCLUDE_GIT_DESCRIBE=OFF \
  "${PLATFORM_ARGS[@]}"
cmake --build "$WORK/build" --target shell --parallel "$Z3_BUILD_JOBS"

DEST="$OUT/z3-$VER-$TRIPLE"
rm -rf "$DEST"
mkdir -p "$DEST/bin"
cp "$WORK/build/$EXE" "$DEST/bin/$EXE"
case "$TRIPLE" in
  *-pc-windows-msvc) ;;
  *) strip "$DEST/bin/$EXE" ;;
esac
cp "$SRC/LICENSE.txt" "$DEST/LICENSE.txt"

# The binary must answer for itself before it is published.
GOT=$("$DEST/bin/$EXE" --version | tr -d '\r')
case "$GOT" in
  "Z3 version $VER "*) echo "build-static-z3: $GOT" ;;
  *) echo "build-static-z3: '$DEST/bin/$EXE --version' printed '$GOT', expected Z3 version $VER" >&2; exit 1 ;;
esac
case "$TRIPLE" in
  *-linux-musl)
    # A static ELF has no program interpreter.
    if readelf -l "$DEST/bin/$EXE" 2>/dev/null | grep -q 'INTERP'; then
      echo "build-static-z3: $DEST/bin/$EXE is dynamically linked" >&2
      exit 1
    fi
    ;;
esac
ls -l "$DEST/bin/$EXE"
