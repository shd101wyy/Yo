#!/bin/bash
# gates_fast.sh — TIER 1 gates (~12 min): everything except stage2/stage3/fixpoint.
# Use on every change while batching; run scripts/bootstrap/fixpoint_only.sh for
# the stage-2/stage-3 byte-identity gate before pushing.
#   S1=<binary> P=<prefix> scripts/bootstrap/gates_fast.sh
#
# EXIT CODE: 0 only if every gate passed. Each failure is echoed with a `FAIL:`
# prefix and counted, so this is usable both interactively and as a CI step.
set -u
cd "$(dirname "$0")/../.." || exit 2
S1=${S1:-/tmp/s1}
P=${P:-fast}
fails=0
fail() {
  echo "FAIL: $*"
  fails=$((fails + 1))
}

echo "=== T1 GATE 0: repros ==="
for r in issues/repros/box-eq-comptime-int-forall-leak.yo issues/repros/arc-spawn-capture-split.yo; do
  n=$(basename "$r" .yo)
  timeout 900 "$S1" compile "$r" --release -o "/tmp/${P}_${n}" &> "/tmp/${P}_${n}.log"
  rc=$?
  echo "$n compile_rc=$rc"
  [ "$rc" = "0" ] || fail "repro $n compile_rc=$rc"
done

echo "=== T1 GATE 1: battery (with HOLLOW detection) ==="
for t in tests/comptime.test.yo tests/prelude.test.yo tests/arc.test.yo tests/async_await.test.yo tests/sys/bufio.test.yo tests/fs/file.test.yo tests/fs/temp.test.yo tests/fs/walker.test.yo tests/sys/signal.test.yo tests/cycle_collector.test.yo tests/basic.test.yo tests/closure.test.yo tests/imm_list.test.yo tests/imm_string.test.yo tests/module_struct_unification.test.yo tests/ref_struct.test.yo tests/fn.test.yo tests/iso.test.yo tests/rc.test.yo tests/operator_grouping.test.yo; do
  name=$(basename "$t" .test.yo); d=$(dirname "$t")
  rm -f "$d"/.yo_selftest_batch_*
  # No env var is needed to retain the batch artifacts: the SELF-HOSTED runner
  # writes .yo_selftest_batch_<index>.{yo,bin,bin.c} next to the test file
  # (yo-self/main.yo:1484) with a deterministic index and never cleans them up.
  # That is what makes the hollow check below possible. (`YO_KEEP_BATCH=1`, which
  # this line used to set, does not exist anywhere in src/ — it was a no-op that
  # implied a mechanism the code does not have. Two sibling scripts,
  # measure_one.sh and hollow_sweep69.sh, still set it; harmless but equally dead.)
  timeout 1200 "$S1" test "$t" &> "/tmp/${P}_${name}.log"
  rc=$?
  c="$d/.yo_selftest_batch_1.bin.c"
  hollow=NA
  [ -f "$c" ] && { if sed -n '/^void __yo_user_main() {/,/^}/p' "$c" | grep -q 'Failed to transpile'; then hollow=1; else hollow=0; fi; }
  echo "$name rc=$rc hollow=$hollow $(grep -oE '[0-9]+ passed' "/tmp/${P}_${name}.log" | tail -1)"
  [ "$rc" = "0" ] || fail "battery $name rc=$rc"
  # A HOLLOW batch is the failure mode that once counted 33 files green while
  # running nothing (issues/yo-self-hollow-test-batch-main.md) — a `__yo_user_main`
  # containing "Failed to transpile" means the test body never ran.
  [ "$hollow" = "1" ] && fail "battery $name is HOLLOW (test body did not transpile)"
  [ "$hollow" = "NA" ] && fail "battery $name produced no batch .c — hollow state unknown"
done

echo "=== T1 GATE 2: corpus diff-test ==="
YO_SELF_BIN=$S1 scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4 &> "/tmp/${P}_corpus.log"
corpus=$(tail -1 "/tmp/${P}_corpus.log")
echo "$corpus"
echo "$corpus" | grep -qE 'DIFF 0( |$)' || fail "corpus diff-test reported a DIFF: $corpus"
echo "$corpus" | grep -qE 'SELF-FAIL 0( |$)' || fail "corpus diff-test reported a SELF-FAIL: $corpus"

echo "=== T1 GATE 3: check ./std ==="
YO_MAIN_STACK_MB=4096 "$S1" check ./std &> "/tmp/${P}_std.log"
std_rc=$?
echo "STD_RC=$std_rc  $(tail -1 "/tmp/${P}_std.log")"
[ "$std_rc" = "0" ] || fail "check ./std rc=$std_rc"

echo "=== T1_DONE (${P}) failures=${fails} ==="
[ "$fails" = "0" ] || exit 1
