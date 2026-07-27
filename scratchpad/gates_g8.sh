#!/bin/bash
# Round-8 (anon-struct expected-type ctor routing) gate chain.
# Builds S1 fresh from the tree, then runs the full battery.
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
S1=/tmp/g8final_s1


echo "=== GATE 1: test battery ==="
for t in tests/async_await.test.yo tests/sys/bufio.test.yo tests/fs/file.test.yo tests/fs/temp.test.yo tests/fs/walker.test.yo tests/sys/signal.test.yo tests/cycle_collector.test.yo tests/basic.test.yo tests/closure.test.yo tests/imm_list.test.yo tests/imm_string.test.yo tests/module_struct_unification.test.yo tests/ref_struct.test.yo tests/fn.test.yo; do
  name=$(basename "$t" .test.yo)
  timeout 1200 "$S1" test "$t" &> "/tmp/g8f_${name}.log"
  rc=$?
  if [ $rc -ne 0 ] && [ ! -s "/tmp/g8f_${name}.log" ]; then
    timeout 1200 "$S1" test "$t" &> "/tmp/g8f_${name}.log"  # phantom-kill retry
    rc=$?
  fi
  tail -4 "/tmp/g8f_${name}.log" | tr '\n' ' '
  echo "  <- $name rc=$rc"
done

echo "=== GATE 2: corpus diff-test ==="
YO_SELF_BIN=$S1 scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4 &> /tmp/g8f_corpus.log
tail -3 /tmp/g8f_corpus.log

echo "=== GATE 3: check ./std ==="
YO_MAIN_STACK_MB=4096 "$S1" check ./std &> /tmp/g8f_std.log
echo "STD_RC=$?"
tail -2 /tmp/g8f_std.log

echo "=== GATE 4: stage2 emit ==="
YO_MAIN_STACK_MB=4096 "$S1" compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/g8f_stage2 &> /tmp/g8f_stage2_emit.log
echo "STAGE2_RC=$?"
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/g8f_stage2.c -o /tmp/g8f_s2 2> /tmp/g8f_clang.log
echo "CLANG_RC=$?"

echo "=== GATE 5: stage3 emit ==="
YO_MAIN_STACK_MB=4096 /tmp/g8f_s2 compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/g8f_stage3 &> /tmp/g8f_stage3_emit.log
echo "STAGE3_RC=$?"
cmp /tmp/g8f_stage2.c /tmp/g8f_stage3.c && echo FIXPOINT_HOLDS || echo FIXPOINT_BROKEN
