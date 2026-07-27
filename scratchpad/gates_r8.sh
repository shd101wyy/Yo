#!/bin/bash
# Round-8 (anon-struct expected-type ctor routing) gate chain.
# Builds S1 fresh from the tree, then runs the full battery.
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
S1=/tmp/f8_s1

echo "=== GATE 0: build s1 ==="
./yo-cli compile yo-self/main.yo --release -o $S1 &> /tmp/f8_s1_build.log
echo "BUILD_RC=$?"

echo "=== GATE 1: test battery ==="
for t in tests/async_await.test.yo tests/sys/bufio.test.yo tests/fs/file.test.yo tests/fs/temp.test.yo tests/fs/walker.test.yo tests/sys/signal.test.yo tests/cycle_collector.test.yo tests/basic.test.yo tests/struct.test.yo tests/closure.test.yo; do
  name=$(basename "$t" .test.yo)
  timeout 1200 "$S1" test "$t" &> "/tmp/f8_${name}.log"
  rc=$?
  if [ $rc -ne 0 ] && [ ! -s "/tmp/f8_${name}.log" ]; then
    timeout 1200 "$S1" test "$t" &> "/tmp/f8_${name}.log"  # phantom-kill retry
    rc=$?
  fi
  tail -4 "/tmp/f8_${name}.log" | tr '\n' ' '
  echo "  <- $name rc=$rc"
done

echo "=== GATE 2: corpus diff-test ==="
YO_SELF_BIN=$S1 scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4 &> /tmp/f8_corpus.log
tail -3 /tmp/f8_corpus.log

echo "=== GATE 3: check ./std ==="
YO_MAIN_STACK_MB=4096 "$S1" check ./std &> /tmp/f8_std.log
echo "STD_RC=$?"
tail -2 /tmp/f8_std.log

echo "=== GATE 4: stage2 emit ==="
YO_MAIN_STACK_MB=4096 "$S1" compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/f8_stage2 &> /tmp/f8_stage2_emit.log
echo "STAGE2_RC=$?"
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/f8_stage2.c -o /tmp/f8_s2 2> /tmp/f8_clang.log
echo "CLANG_RC=$?"

echo "=== GATE 5: stage3 emit ==="
YO_MAIN_STACK_MB=4096 /tmp/f8_s2 compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/f8_stage3 &> /tmp/f8_stage3_emit.log
echo "STAGE3_RC=$?"
cmp /tmp/f8_stage2.c /tmp/f8_stage3.c && echo FIXPOINT_HOLDS || echo FIXPOINT_BROKEN
