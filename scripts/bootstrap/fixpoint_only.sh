#!/bin/bash
# fixpoint_only.sh — GATE 4-6 of gates_perf1.sh in isolation.
#   S1=<binary> P=<prefix> bash scratchpad/fixpoint_only.sh
set -u
cd "$(dirname "$0")/../.." || exit 2
S1=${S1:?}; P=${P:?}
YO_MAIN_STACK_MB=4096 "$S1" compile src/main.yo --release --emit-c --skip-c-compiler -o /tmp/${P}_stage2 &> /tmp/${P}_stage2_emit.log
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
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/${P}_stage2.c -o /tmp/${P}_s2 2> /tmp/${P}_clang.log
echo "CLANG_RC=$?"
YO_MAIN_STACK_MB=4096 /tmp/${P}_s2 compile src/main.yo --release --emit-c --skip-c-compiler -o /tmp/${P}_stage3 &> /tmp/${P}_stage3_emit.log
echo "STAGE3_RC=$?"
if cmp -s /tmp/${P}_stage2.c /tmp/${P}_stage3.c; then echo "FIXPOINT_HOLDS"; else echo "FIXPOINT_BROKEN"; cmp /tmp/${P}_stage2.c /tmp/${P}_stage3.c | head -2; fi
