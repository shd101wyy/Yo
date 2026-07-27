#!/bin/bash
# Capture-split fix gate chain, part A (non-./tests gates only — the g14
# sweep holds ./tests). Part B (battery + corpus) runs after the sweep.
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
S1=/tmp/cf2_s1

echo "=== GATE 3: check ./std ==="
YO_MAIN_STACK_MB=4096 "$S1" check ./std &> /tmp/cf2_std.log
echo "STD_RC=$?"
tail -2 /tmp/cf2_std.log

echo "=== GATE 4: stage2 emit ==="
YO_MAIN_STACK_MB=4096 "$S1" compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/cf2_stage2 &> /tmp/cf2_stage2_emit.log
echo "STAGE2_RC=$?"
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/cf2_stage2.c -o /tmp/cf2_s2 2> /tmp/cf2_clang.log
echo "CLANG_RC=$?"

echo "=== GATE 5: stage3 emit ==="
YO_MAIN_STACK_MB=4096 /tmp/cf2_s2 compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/cf2_stage3 &> /tmp/cf2_stage3_emit.log
echo "STAGE3_RC=$?"
cmp /tmp/cf2_stage2.c /tmp/cf2_stage3.c && echo FIXPOINT_HOLDS || echo FIXPOINT_BROKEN
echo "=== part A done ==="
