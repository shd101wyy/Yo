#!/bin/bash
# Round-3 flag-off gate chain. S1 = /tmp/r7_s1 (already built).
# Stages log to /tmp/r7_*.log; progress markers to stdout.
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
S1=/tmp/r7_s1

echo "=== GATE 1: test battery ==="
for t in tests/async_await.test.yo tests/sys/bufio.test.yo tests/fs/file.test.yo tests/sys/signal.test.yo tests/cycle_collector.test.yo tests/basic.test.yo; do
  name=$(basename "$t" .test.yo)
  timeout 1200 "$S1" test "$t" &> "/tmp/r7_${name}.log"
  tail -4 "/tmp/r7_${name}.log" | tr '\n' ' '
  echo "  <- $name"
done

echo "=== GATE 2: corpus diff-test ==="
YO_SELF_BIN=$S1 scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4 &> /tmp/r7_corpus.log
tail -3 /tmp/r7_corpus.log

echo "=== GATE 3: check ./std ==="
YO_MAIN_STACK_MB=4096 "$S1" check ./std &> /tmp/r7_std.log
echo "STD_RC=$?"
tail -2 /tmp/r7_std.log

echo "=== GATE 4: stage2 emit ==="
YO_MAIN_STACK_MB=4096 "$S1" compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/r7_stage2 &> /tmp/r7_stage2_emit.log
echo "STAGE2_RC=$?"
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/r7_stage2.c -o /tmp/r7_s2 2> /tmp/r7_clang.log
echo "CLANG_RC=$?"

echo "=== GATE 5: stage3 emit ==="
YO_MAIN_STACK_MB=4096 /tmp/r7_s2 compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/r7_stage3 &> /tmp/r7_stage3_emit.log
echo "STAGE3_RC=$?"
cmp /tmp/r7_stage2.c /tmp/r7_stage3.c && echo FIXPOINT_HOLDS || echo FIXPOINT_BROKEN
