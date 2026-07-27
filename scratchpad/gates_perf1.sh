#!/bin/bash
# Perf-round full gate chain (parameterized; the template for every perf round).
#   S1=<binary> P=<prefix> scratchpad/gates_perf1.sh
# Defaults reproduce perf round 1 (920c2876d + a92e7c9a5).
# The stage2 emit duration is the REAL metric for codegen rounds — derive it
# from mtime(/tmp/$P_stage2.c) - mtime(/tmp/$P_std.log). Round-1 baseline:
# stage2 46.8 min, stage3 37.9 min.
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
S1=${S1:-/tmp/port_s1}
P=${P:-perf1}

echo "=== GATE 0: repros ==="
# NOTE: imm-map-unspecialized-comptime-helper is a KNOWN-RED — it documents the
# still-unfixed round-2' comptime-Type-param bug (see its header and
# plans/YO_SELF_STAGE2_HANDOFF.md priority 2). compile_rc=1 is the EXPECTED
# result for it; only the other two must be green.
for r in issues/repros/box-eq-comptime-int-forall-leak.yo issues/repros/arc-spawn-capture-split.yo issues/repros/imm-map-unspecialized-comptime-helper.yo; do
  n=$(basename "$r" .yo)
  timeout 900 "$S1" compile "$r" --release -o "/tmp/${P}_${n}" &> "/tmp/${P}_${n}.log"
  rc=$?
  runout=""
  [ $rc -eq 0 ] && runout=$("/tmp/${P}_${n}" 2>&1; echo "run_rc=$?")
  echo "$n compile_rc=$rc $runout"
done

echo "=== GATE 1: test battery ==="
for t in tests/comptime.test.yo tests/prelude.test.yo tests/arc.test.yo tests/async_await.test.yo tests/sys/bufio.test.yo tests/fs/file.test.yo tests/fs/temp.test.yo tests/fs/walker.test.yo tests/sys/signal.test.yo tests/cycle_collector.test.yo tests/basic.test.yo tests/closure.test.yo tests/imm_list.test.yo tests/imm_string.test.yo tests/module_struct_unification.test.yo tests/ref_struct.test.yo tests/fn.test.yo tests/iso.test.yo tests/rc.test.yo; do
  name=$(basename "$t" .test.yo)
  timeout 1200 "$S1" test "$t" &> "/tmp/${P}_${name}.log"
  rc=$?
  # Phantom-kill protocol: a nonzero rc with a ZERO-byte log is a machine kill.
  if [ $rc -ne 0 ] && [ ! -s "/tmp/${P}_${name}.log" ]; then
    timeout 1200 "$S1" test "$t" &> "/tmp/${P}_${name}.log"
    rc=$?
  fi
  tail -4 "/tmp/${P}_${name}.log" | tr '\n' ' '
  echo "  <- $name rc=$rc"
done

echo "=== GATE 2: corpus diff-test ==="
YO_SELF_BIN=$S1 scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4 &> /tmp/${P}_corpus.log
tail -3 /tmp/${P}_corpus.log

echo "=== GATE 3: check ./std ==="
YO_MAIN_STACK_MB=4096 "$S1" check ./std &> /tmp/${P}_std.log
echo "STD_RC=$?"
tail -2 /tmp/${P}_std.log

echo "=== GATE 4: stage2 emit ==="
YO_MAIN_STACK_MB=4096 "$S1" compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/${P}_stage2 &> /tmp/${P}_stage2_emit.log
echo "STAGE2_RC=$?"
# Count only REAL comment markers (line-anchored): the compiler SOURCE itself
# contains "// Failed to transpile" string literals (the FTT emitters and the
# 59c5fe1fa degraded-emission guards), which the self-compile embeds as C
# string constants — a plain grep counts those and false-alarms (raw went
# 6 -> 12 with ZERO new real markers). Real baseline: 1 (the unwind() marker).
echo "stage2 hollow=$(grep -cE '^\s*// (Failed to transpile|Unknown type:)' /tmp/${P}_stage2.c)"
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/${P}_stage2.c -o /tmp/${P}_s2 2> /tmp/${P}_clang.log
echo "CLANG_RC=$?"

echo "=== GATE 5: stage3 emit ==="
YO_MAIN_STACK_MB=4096 /tmp/${P}_s2 compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/${P}_stage3 &> /tmp/${P}_stage3_emit.log
echo "STAGE3_RC=$?"

echo "=== GATE 6: STRICT_FIXPOINT ==="
if cmp -s /tmp/${P}_stage2.c /tmp/${P}_stage3.c; then
  echo "FIXPOINT_HOLDS"
else
  echo "FIXPOINT_BROKEN"
  cmp /tmp/${P}_stage2.c /tmp/${P}_stage3.c | head -3
  ls -la /tmp/${P}_stage2.c /tmp/${P}_stage3.c
fi
echo "=== GATES_DONE (${P}) ==="
