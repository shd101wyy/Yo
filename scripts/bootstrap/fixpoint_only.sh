#!/bin/bash
# fixpoint_only.sh — GATE 4-6 of gates_perf1.sh in isolation.
#   S1=<binary> P=<prefix> bash scratchpad/fixpoint_only.sh
set -u
cd "$(dirname "$0")/../.." || exit 2
S1=${S1:?}; P=${P:?}
YO_MAIN_STACK_MB=4096 "$S1" compile src/main.yo --optimize 2 --emit-c --skip-c-compiler -o /tmp/${P}_stage2 &> /tmp/${P}_stage2_emit.log
echo "STAGE2_RC=$?"
# GATE, not a readout: a stage-2 C carrying an untranspiled body is a broken
# compiler even when stage2 == stage3 byte-for-byte (both stages would emit the
# same hole). The count comes from scripts/count-transpile-failures.sh so the
# string-literal floor and the mid-line marker forms are handled in one place —
# the previous inline `grep -cE '^\s*// ...'` here anchored to start-of-line and
# so scored `return // Failed to transpile x;` as clean.
if bash scripts/count-transpile-failures.sh /tmp/${P}_stage2.c; then
  echo "stage2 hollow=0"
else
  echo "stage2 hollow>0 STAGE2_HOLLOW_GATE_FAILED"
fi
# std/http in the compiler closure puts OpenSSL headers into stage2.c —
# resolve them via pkg-config (brew fallback for the non-pkgconfig keg-only
# openssl@3), tolerating platforms with a system OpenSSL in the default path.
SSL_FLAGS="$(pkg-config --cflags --libs openssl 2>/dev/null || true)"
if [ -z "$SSL_FLAGS" ] && command -v brew >/dev/null 2>&1; then
  SSL_FLAGS="$(brew --prefix openssl 2>/dev/null)/lib/pkgconfig"
  if [ -n "$SSL_FLAGS" ] && [ -f "$SSL_FLAGS/openssl.pc" ]; then
    SSL_FLAGS="$(PKG_CONFIG_PATH="$SSL_FLAGS" pkg-config --cflags --libs openssl 2>/dev/null || true)"
  else
    SSL_FLAGS=""
  fi
fi
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 $SSL_FLAGS /tmp/${P}_stage2.c -o /tmp/${P}_s2 2> /tmp/${P}_clang.log
echo "CLANG_RC=$?"
YO_MAIN_STACK_MB=4096 /tmp/${P}_s2 compile src/main.yo --optimize 2 --emit-c --skip-c-compiler -o /tmp/${P}_stage3 &> /tmp/${P}_stage3_emit.log
echo "STAGE3_RC=$?"
if cmp -s /tmp/${P}_stage2.c /tmp/${P}_stage3.c; then echo "FIXPOINT_HOLDS"; else echo "FIXPOINT_BROKEN"; cmp /tmp/${P}_stage2.c /tmp/${P}_stage3.c | head -2; fi
