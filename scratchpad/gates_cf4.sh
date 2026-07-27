#!/bin/bash
# Spec-gate broadening (drop closure-param narrowing) full gate chain.
# S1 = /tmp/cf4_s1 (tree = capture-split commit + broadened gate).
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
S1=/tmp/cf4_s1

echo "=== GATE 0: repros ==="
for r in issues/repros/imm-map-unspecialized-comptime-helper.yo issues/repros/arc-spawn-capture-split.yo; do
  n=$(basename "$r" .yo)
  timeout 900 "$S1" compile "$r" --release -o "/tmp/cf4_${n}" &> "/tmp/cf4_${n}.log"
  rc=$?
  runout=""
  [ $rc -eq 0 ] && runout=$("/tmp/cf4_${n}" 2>&1; echo "run_rc=$?")
  echo "$n compile_rc=$rc $runout"
done
timeout 900 "$S1" compile /tmp/imm_sortedmap_probe.yo --release -o /tmp/cf4_smprobe &> /tmp/cf4_smprobe.log
rc=$?; runout=""; [ $rc -eq 0 ] && runout=$(/tmp/cf4_smprobe 2>&1; echo "run_rc=$?")
echo "sortedmap_probe compile_rc=$rc $runout"

echo "=== GATE 1: test battery ==="
for t in tests/imm_map.test.yo tests/imm_set.test.yo tests/imm_sorted_set.test.yo tests/arc.test.yo tests/async_await.test.yo tests/sys/bufio.test.yo tests/fs/file.test.yo tests/fs/temp.test.yo tests/fs/walker.test.yo tests/sys/signal.test.yo tests/cycle_collector.test.yo tests/basic.test.yo tests/closure.test.yo tests/imm_list.test.yo tests/imm_string.test.yo tests/module_struct_unification.test.yo tests/ref_struct.test.yo tests/fn.test.yo tests/iso.test.yo tests/rc.test.yo; do
  name=$(basename "$t" .test.yo)
  timeout 1200 "$S1" test "$t" &> "/tmp/cf4_${name}.log"
  rc=$?
  if [ $rc -ne 0 ] && [ ! -s "/tmp/cf4_${name}.log" ]; then
    timeout 1200 "$S1" test "$t" &> "/tmp/cf4_${name}.log"  # phantom-kill retry
    rc=$?
  fi
  tail -4 "/tmp/cf4_${name}.log" | tr '\n' ' '
  echo "  <- $name rc=$rc"
done

echo "=== GATE 2: corpus diff-test ==="
YO_SELF_BIN=$S1 scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4 &> /tmp/cf4_corpus.log
tail -3 /tmp/cf4_corpus.log

echo "=== GATE 3: check ./std ==="
YO_MAIN_STACK_MB=4096 "$S1" check ./std &> /tmp/cf4_std.log
echo "STD_RC=$?"
tail -2 /tmp/cf4_std.log

echo "=== GATE 4: stage2 emit ==="
YO_MAIN_STACK_MB=4096 "$S1" compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/cf4_stage2 &> /tmp/cf4_stage2_emit.log
echo "STAGE2_RC=$?"
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/cf4_stage2.c -o /tmp/cf4_s2 2> /tmp/cf4_clang.log
echo "CLANG_RC=$?"

echo "=== GATE 5: stage3 emit ==="
YO_MAIN_STACK_MB=4096 /tmp/cf4_s2 compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/cf4_stage3 &> /tmp/cf4_stage3_emit.log
echo "STAGE3_RC=$?"
cmp /tmp/cf4_stage2.c /tmp/cf4_stage3.c && echo FIXPOINT_HOLDS || echo FIXPOINT_BROKEN
echo "=== cf4 chain done ==="
