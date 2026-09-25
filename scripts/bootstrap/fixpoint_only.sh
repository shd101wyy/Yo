#!/bin/bash
# fixpoint_only.sh — GATE 4-6 of gates_perf1.sh in isolation.
#   S1=<binary> P=<prefix> bash scratchpad/fixpoint_only.sh
set -u
cd "$(dirname "$0")/../.." || exit 2
S1=${S1:?}; P=${P:?}
# --std-path on BOTH stages: the resolved std path feeds module paths and
# type keys, so two different spellings between stages byte-diff ~19k lines
# of __yo_tN churn (issues/fixed/fixpoint-gate-std-path-spelling-changes-type-keys.md).
# resolve_std_path canonicalizes since 2026-09-10; the explicit flag keeps
# the gate self-describing and independent of the resolution route.
# The exit status is the verdict (0 = holds), so a caller cannot read a broken
# fixpoint as a pass; the printed markers stay for humans and logs.
rc=0
YO_MAIN_STACK_MB=4096 "$S1" compile src/main.yo --optimize 2 --emit-c --skip-c-compiler --std-path ./std -o /tmp/${P}_stage2 &> /tmp/${P}_stage2_emit.log
stage2_rc=$?
echo "STAGE2_RC=$stage2_rc"
[ "$stage2_rc" -eq 0 ] || rc=1
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
  rc=1
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
clang_rc=$?
echo "CLANG_RC=$clang_rc"
[ "$clang_rc" -eq 0 ] || rc=1
YO_MAIN_STACK_MB=4096 /tmp/${P}_s2 compile src/main.yo --optimize 2 --emit-c --skip-c-compiler --std-path ./std -o /tmp/${P}_stage3 &> /tmp/${P}_stage3_emit.log
stage3_rc=$?
echo "STAGE3_RC=$stage3_rc"
[ "$stage3_rc" -eq 0 ] || rc=1
if cmp -s /tmp/${P}_stage2.c /tmp/${P}_stage3.c; then echo "FIXPOINT_HOLDS"; else echo "FIXPOINT_BROKEN"; cmp /tmp/${P}_stage2.c /tmp/${P}_stage3.c | head -2; rc=1; fi
exit $rc
