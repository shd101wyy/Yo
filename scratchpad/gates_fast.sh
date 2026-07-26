#!/bin/bash
# gates_fast.sh — TIER 1 gates (~12 min): everything except stage2/stage3/fixpoint.
# Use on every change while batching; run scratchpad/gates_perf1.sh (TIER 2,
# ~75 min) ONCE per batch before pushing.
#   S1=<binary> P=<prefix> scratchpad/gates_fast.sh
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
S1=${S1:-/tmp/s1}
P=${P:-fast}

echo "=== T1 GATE 0: repros ==="
for r in issues/repros/box-eq-comptime-int-forall-leak.yo issues/repros/arc-spawn-capture-split.yo; do
  n=$(basename "$r" .yo)
  timeout 900 "$S1" compile "$r" --release -o "/tmp/${P}_${n}" &> "/tmp/${P}_${n}.log"
  echo "$n compile_rc=$?"
done

echo "=== T1 GATE 1: battery (with HOLLOW detection) ==="
for t in tests/comptime.test.yo tests/prelude.test.yo tests/arc.test.yo tests/async_await.test.yo tests/sys/bufio.test.yo tests/fs/file.test.yo tests/fs/temp.test.yo tests/fs/walker.test.yo tests/sys/signal.test.yo tests/cycle_collector.test.yo tests/basic.test.yo tests/closure.test.yo tests/imm_list.test.yo tests/imm_string.test.yo tests/module_struct_unification.test.yo tests/ref_struct.test.yo tests/fn.test.yo tests/iso.test.yo tests/rc.test.yo tests/operator_grouping.test.yo; do
  name=$(basename "$t" .test.yo); d=$(dirname "$t")
  YO_KEEP_BATCH=1 timeout 1200 "$S1" test "$t" &> "/tmp/${P}_${name}.log"
  rc=$?
  c="$d/.yo_selftest_batch_1.bin.c"
  hollow=NA
  [ -f "$c" ] && { if sed -n '/^void __yo_user_main() {/,/^}/p' "$c" | grep -q 'Failed to transpile'; then hollow=1; else hollow=0; fi; }
  echo "$name rc=$rc hollow=$hollow $(grep -oE '[0-9]+ passed' "/tmp/${P}_${name}.log" | tail -1)"
done

echo "=== T1 GATE 2: corpus diff-test ==="
YO_SELF_BIN=$S1 scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4 &> "/tmp/${P}_corpus.log"
tail -1 "/tmp/${P}_corpus.log"

echo "=== T1 GATE 3: check ./std ==="
YO_MAIN_STACK_MB=4096 "$S1" check ./std &> "/tmp/${P}_std.log"
echo "STD_RC=$?  $(tail -1 "/tmp/${P}_std.log")"
echo "=== T1_DONE (${P}) ==="
