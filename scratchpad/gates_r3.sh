#!/bin/bash
# Spec-gate broadening (drop closure-param narrowing) full gate chain.
# S1 = /tmp/r3_s1 (tree = capture-split commit + broadened gate).
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
S1=/tmp/r3_s1

echo "=== GATE 0: repros ==="
for r in issues/repros/box-eq-comptime-int-forall-leak.yo issues/repros/arc-spawn-capture-split.yo; do
  n=$(basename "$r" .yo)
  timeout 900 "$S1" compile "$r" --release -o "/tmp/r3_${n}" &> "/tmp/r3_${n}.log"
  rc=$?
  runout=""
  [ $rc -eq 0 ] && runout=$("/tmp/r3_${n}" 2>&1; echo "run_rc=$?")
  echo "$n compile_rc=$rc $runout"
done
timeout 900 "$S1" compile /tmp/imm_sortedmap_probe.yo --release -o /tmp/r3_smprobe &> /tmp/r3_smprobe.log
rc=$?; runout=""; [ $rc -eq 0 ] && runout=$(/tmp/r3_smprobe 2>&1; echo "run_rc=$?")
echo "sortedmap_probe compile_rc=$rc $runout"

echo "=== GATE 1: test battery ==="
for t in tests/prelude.test.yo tests/arc.test.yo tests/derive_clone_complex.test.yo tests/async_await.test.yo tests/sys/bufio.test.yo tests/fs/file.test.yo tests/fs/temp.test.yo tests/fs/walker.test.yo tests/sys/signal.test.yo tests/cycle_collector.test.yo tests/basic.test.yo tests/closure.test.yo tests/imm_list.test.yo tests/imm_string.test.yo tests/module_struct_unification.test.yo tests/ref_struct.test.yo tests/fn.test.yo tests/iso.test.yo tests/rc.test.yo; do
  name=$(basename "$t" .test.yo)
  timeout 1200 "$S1" test "$t" &> "/tmp/r3_${name}.log"
  rc=$?
  if [ $rc -ne 0 ] && [ ! -s "/tmp/r3_${name}.log" ]; then
    timeout 1200 "$S1" test "$t" &> "/tmp/r3_${name}.log"  # phantom-kill retry
    rc=$?
  fi
  tail -4 "/tmp/r3_${name}.log" | tr '\n' ' '
  echo "  <- $name rc=$rc"
done

echo "=== GATE 2: corpus diff-test ==="
YO_SELF_BIN=$S1 scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4 &> /tmp/r3_corpus.log
tail -3 /tmp/r3_corpus.log

echo "=== GATE 3: check ./std ==="
YO_MAIN_STACK_MB=4096 "$S1" check ./std &> /tmp/r3_std.log
echo "STD_RC=$?"
tail -2 /tmp/r3_std.log

echo "=== GATE 4: stage2 emit ==="
YO_MAIN_STACK_MB=4096 "$S1" compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/r3_stage2 &> /tmp/r3_stage2_emit.log
echo "STAGE2_RC=$?"
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/r3_stage2.c -o /tmp/r3_s2 2> /tmp/r3_clang.log
echo "CLANG_RC=$?"

echo "=== GATE 5: stage3 emit ==="
YO_MAIN_STACK_MB=4096 /tmp/r3_s2 compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/r3_stage3 &> /tmp/r3_stage3_emit.log
echo "STAGE3_RC=$?"
cmp /tmp/r3_stage2.c /tmp/r3_stage3.c && echo FIXPOINT_HOLDS || echo FIXPOINT_BROKEN
echo "=== cf4 chain done ==="
