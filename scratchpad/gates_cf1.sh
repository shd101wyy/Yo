#!/bin/bash
# Capture-split fix (closure fid in spec cache key) gate chain.
# S1 = /tmp/cf1_s1 (built from tree with the helper.yo clfid keying).
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
S1=/tmp/cf1_s1

echo "=== GATE 0: repro ==="
timeout 600 "$S1" compile issues/repros/arc-spawn-capture-split.yo --release -o /tmp/cf1_repro &> /tmp/cf1_repro.log
echo "REPRO_COMPILE_RC=$?"
/tmp/cf1_repro
echo "REPRO_RUN_RC=$?"

echo "=== GATE 1: test battery ==="
for t in tests/arc.test.yo tests/prelude.test.yo tests/async_await.test.yo tests/sys/bufio.test.yo tests/fs/file.test.yo tests/fs/temp.test.yo tests/fs/walker.test.yo tests/sys/signal.test.yo tests/cycle_collector.test.yo tests/basic.test.yo tests/closure.test.yo tests/imm_list.test.yo tests/imm_string.test.yo tests/module_struct_unification.test.yo tests/ref_struct.test.yo tests/fn.test.yo tests/iso.test.yo tests/rc.test.yo; do
  name=$(basename "$t" .test.yo)
  timeout 1200 "$S1" test "$t" &> "/tmp/cf1_${name}.log"
  rc=$?
  if [ $rc -ne 0 ] && [ ! -s "/tmp/cf1_${name}.log" ]; then
    timeout 1200 "$S1" test "$t" &> "/tmp/cf1_${name}.log"  # phantom-kill retry
    rc=$?
  fi
  tail -4 "/tmp/cf1_${name}.log" | tr '\n' ' '
  echo "  <- $name rc=$rc"
done

echo "=== GATE 2: corpus diff-test ==="
YO_SELF_BIN=$S1 scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4 &> /tmp/cf1_corpus.log
tail -3 /tmp/cf1_corpus.log

echo "=== GATE 3: check ./std ==="
YO_MAIN_STACK_MB=4096 "$S1" check ./std &> /tmp/cf1_std.log
echo "STD_RC=$?"
tail -2 /tmp/cf1_std.log

echo "=== GATE 4: stage2 emit ==="
YO_MAIN_STACK_MB=4096 "$S1" compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/cf1_stage2 &> /tmp/cf1_stage2_emit.log
echo "STAGE2_RC=$?"
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/cf1_stage2.c -o /tmp/cf1_s2 2> /tmp/cf1_clang.log
echo "CLANG_RC=$?"

echo "=== GATE 5: stage3 emit ==="
YO_MAIN_STACK_MB=4096 /tmp/cf1_s2 compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/cf1_stage3 &> /tmp/cf1_stage3_emit.log
echo "STAGE3_RC=$?"
cmp /tmp/cf1_stage2.c /tmp/cf1_stage3.c && echo FIXPOINT_HOLDS || echo FIXPOINT_BROKEN
