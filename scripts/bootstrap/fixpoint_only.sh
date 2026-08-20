#!/bin/bash
# fixpoint_only.sh — GATE 4-6 of gates_perf1.sh in isolation.
#   S1=<binary> P=<prefix> bash scratchpad/fixpoint_only.sh
set -u
cd "$(dirname "$0")/../.." || exit 2
S1=${S1:?}; P=${P:?}
YO_MAIN_STACK_MB=4096 "$S1" compile src/main.yo --release --emit-c --skip-c-compiler -o /tmp/${P}_stage2 &> /tmp/${P}_stage2_emit.log
echo "STAGE2_RC=$?"
echo "stage2 hollow=$(grep -cE '^\s*// (Failed to transpile|Unknown type:)' /tmp/${P}_stage2.c)"
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/${P}_stage2.c -o /tmp/${P}_s2 2> /tmp/${P}_clang.log
echo "CLANG_RC=$?"
YO_MAIN_STACK_MB=4096 /tmp/${P}_s2 compile src/main.yo --release --emit-c --skip-c-compiler -o /tmp/${P}_stage3 &> /tmp/${P}_stage3_emit.log
echo "STAGE3_RC=$?"
if cmp -s /tmp/${P}_stage2.c /tmp/${P}_stage3.c; then echo "FIXPOINT_HOLDS"; else echo "FIXPOINT_BROKEN"; cmp /tmp/${P}_stage2.c /tmp/${P}_stage3.c | head -2; fi
