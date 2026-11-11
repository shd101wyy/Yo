#!/bin/sh
# Compiles emitted compiler C into the STATIC musl binary. Runs INSIDE `alpine:3.20` (both arches),
# from the repository root. The ONE copy of the recipe: release.yml's two musl-bundle compile steps
# and test.yml's musl leg all call this file, so the battery runs exactly what the release runs
# (VERDICTS-56).
#
#   sh scripts/musl-compile.sh <emitted.c> <output-binary> [fast|legacy-arm64|legacy]
#
# fast (default)  clang -O2 -U_FORTIFY_SOURCE; on x86_64 also links scripts/musl-fastmem.c.
# legacy-arm64    fast on x86_64, legacy on aarch64.
# legacy          the pre-v0.2.77 recipe, byte for byte: Alpine cc (GCC) -O2, fortify on.
# The two legacy recipes are the release's rollback (release.yml `musl_recipe` input); they are
# deleted in v0.2.78.
#
# Why (issues/fixed/2026-11-11-the-static-musl-bundle-runs-1-6x-slower-than-a-glibc-build.md):
#   - Alpine's cc AND clang define _FORTIFY_SOURCE=2 at -O2, which switches on fortify-headers. Its
#     inline memcpy adds a runtime overlap check plus a trap to EVERY memcpy, including the emitted
#     C's tens of thousands of fixed-size "Save old value by bytes" copies. That pins their
#     temporaries to the stack and was most of the 1.6x. -U_FORTIFY_SOURCE removes it.
#   - musl's x86_64 memcpy is a `rep movsq` loop and its memcmp a byte loop; musl-fastmem.c
#     replaces them (aarch64 musl already has an assembly memcpy, so it is x86_64 only).
#   - clang over GCC: equal or faster code, and the C compile peaks at 8 GB instead of 18 GB.
set -eu

SRC=$1
OUT=$2
RECIPE=${3:-fast}
ARCH=$(uname -m)

case "$RECIPE" in
  fast) MODE=fast ;;
  legacy) MODE=legacy ;;
  legacy-arm64) if [ "$ARCH" = aarch64 ]; then MODE=legacy; else MODE=fast; fi ;;
  *)
    echo "::error::musl-compile.sh: unknown recipe '$RECIPE' (fast|legacy-arm64|legacy)"
    exit 1
    ;;
esac
echo "musl-compile.sh: recipe=$RECIPE -> $MODE on $ARCH"

PKGS="build-base linux-headers openssl-dev openssl-libs-static"
if [ "$MODE" = fast ]; then PKGS="$PKGS clang"; fi
# shellcheck disable=SC2086 # word splitting of the package list is intended
apk add --no-cache $PKGS

# std/http in the compiler closure (D6 PR-3) puts OpenSSL into the emitted C. Alpine splits the
# archives out of openssl-dev (headers + .so) into openssl-libs-static; without it -static -lssl
# cannot work. Static means the artifact needs NO openssl on the machine that runs it.
test -f /usr/lib/libssl.a || {
  echo "::error::openssl-libs-static did not provide /usr/lib/libssl.a; -static -lssl cannot work"
  exit 1
}

if [ "$MODE" = legacy ]; then
  cc -std=c11 -fno-strict-aliasing -fwrapv -w -O2 \
    "$SRC" vendor/mimalloc/src/static.c \
    -I vendor/mimalloc/include -DMI_BUILD_RELEASE \
    -static -lssl -lcrypto -lpthread -lm \
    -o "$OUT"
  exit 0
fi

# -U_FORTIFY_SOURCE must actually undo Alpine's default, or the recipe silently loses its point.
if echo | clang -O2 -U_FORTIFY_SOURCE -dM -E - | grep -q _FORTIFY_SOURCE; then
  echo "::error::-U_FORTIFY_SOURCE did not remove _FORTIFY_SOURCE from clang's predefines"
  exit 1
fi

FASTMEM=""
if [ "$ARCH" = x86_64 ]; then
  WORK=$(mktemp -d)
  FASTMEM=$WORK/fastmem.o
  # -fno-builtin: otherwise the compiler may turn the copy loops back into memcpy calls, i.e.
  # into calls to the function being defined.
  clang -std=c11 -O2 -fno-builtin -U_FORTIFY_SOURCE -c scripts/musl-fastmem.c -o "$FASTMEM"
  if nm -u "$FASTMEM" | grep -E 'mem(cpy|move|set|cmp)'; then
    echo "::error::musl-fastmem.o references a mem* function itself (it would recurse)"
    exit 1
  fi
  # The exhaustive test runs against THIS object, the one linked below.
  clang -std=c11 -O2 -fno-builtin -U_FORTIFY_SOURCE scripts/musl-fastmem-test.c "$FASTMEM" \
    -static -o "$WORK/fastmem-test"
  "$WORK/fastmem-test"
fi

# shellcheck disable=SC2086 # FASTMEM is empty or one path
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 -U_FORTIFY_SOURCE \
  "$SRC" vendor/mimalloc/src/static.c $FASTMEM \
  -I vendor/mimalloc/include -DMI_BUILD_RELEASE \
  -static -lssl -lcrypto -lpthread -lm \
  -o "$OUT"

# musl's memcpy.o defines __memcpy_fwd; its presence means musl-fastmem.o lost the link.
if [ -n "$FASTMEM" ] && nm "$OUT" | grep -q __memcpy_fwd; then
  echo "::error::the binary links musl's memcpy, not scripts/musl-fastmem.c"
  exit 1
fi
