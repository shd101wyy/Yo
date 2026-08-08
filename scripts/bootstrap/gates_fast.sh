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
# Dump the tail of a gate's log on failure. The per-gate logs live in /tmp and are
# NOT uploaded by CI, so without this a CI failure here is just `FAIL: battery
# imm_string rc=1` with no way to tell a clang error from a timeout from a failed
# assertion. Keep it bounded so the CI log stays readable.
dump_log() {
  local f=$1
  [ -f "$f" ] || { echo "  (no log at $f)"; return; }
  # Failure markers first, WITH context. The tail alone is not enough: a battery
  # file with one failing test among 116 prints its `✗` line hundreds of lines
  # before the summary, so `tail` showed only passing tests (this is exactly how
  # async_await's failing test stayed hidden). Keep both — the markers say WHICH
  # test failed, the tail says how the run ended.
  local markers
  markers=$(grep -nE '✗|error:|Error:|undefined reference|Memory leak|Assertion|SIGSEGV|SIGABRT|panic' "$f" | head -25)
  if [ -n "$markers" ]; then
    echo "  ---- failure markers in $f ----"
    echo "$markers" | sed 's/^/  /'
  fi
  echo "  ---- tail of $f ----"
  tail -40 "$f" | sed 's/^/  /'
  echo "  ---- end $f ----"
}

echo "=== T1 GATE 0: repros ==="
for r in issues/repros/box-eq-comptime-int-forall-leak.yo issues/repros/arc-spawn-capture-split.yo; do
  n=$(basename "$r" .yo)
  timeout 900 "$S1" compile "$r" --release -o "/tmp/${P}_${n}" &> "/tmp/${P}_${n}.log"
  rc=$?
  echo "$n compile_rc=$rc"
  if [ "$rc" != "0" ]; then
    fail "repro $n compile_rc=$rc"
    dump_log "/tmp/${P}_${n}.log"
  fi
done

echo "=== T1 GATE 1: battery (with HOLLOW detection) ==="
for t in tests/comptime.test.yo tests/prelude.test.yo tests/arc.test.yo tests/async_await.test.yo tests/sys/bufio.test.yo tests/fs/file.test.yo tests/fs/temp.test.yo tests/fs/walker.test.yo tests/sys/signal.test.yo tests/cycle_collector.test.yo tests/basic.test.yo tests/closure.test.yo tests/imm_list.test.yo tests/imm_string.test.yo tests/module_struct_unification.test.yo tests/ref_struct.test.yo tests/fn.test.yo tests/iso.test.yo tests/rc.test.yo tests/ref_field_borrow.test.yo tests/module.test.yo tests/operator_grouping.test.yo tests/algebraic_effects.test.yo; do
  name=$(basename "$t" .test.yo); d=$(dirname "$t")
  rm -f "$d"/.yo_selftest_batch_*
  # YO_KEEP_BATCH=1 is LOAD-BEARING — do not remove it. It is read by the
  # SELF-HOSTED runner (yo-self/main.yo:1522), which otherwise DELETES its
  # .yo_selftest_batch_<index>.{yo,bin,bin.c} artifacts next to the test file.
  # The hollow check below needs the .bin.c to exist; without this var every
  # file reports hollow=NA and the gate fails 20/20. (It is deliberately absent
  # from src/ — the TS runner has no counterpart — so grepping only src/ makes
  # it look dead. It is not. measure_one.sh and hollow_sweep69.sh set it for
  # the same reason.)
  YO_KEEP_BATCH=1 timeout 1200 "$S1" test "$t" &> "/tmp/${P}_${name}.log"
  rc=$?
  c="$d/.yo_selftest_batch_1.bin.c"
  hollow=NA
  [ -f "$c" ] && { if sed -n '/^void __yo_user_main() {/,/^}/p' "$c" | grep -q 'Failed to transpile'; then hollow=1; else hollow=0; fi; }
  echo "$name rc=$rc hollow=$hollow $(grep -oE '[0-9]+ passed' "/tmp/${P}_${name}.log" | tail -1)"
  if [ "$rc" != "0" ]; then
    fail "battery $name rc=$rc"
    dump_log "/tmp/${P}_${name}.log"
  fi
  # A HOLLOW batch is the failure mode that once counted 33 files green while
  # running nothing (issues/retired/yo-self-hollow-test-batch-main.md) — a `__yo_user_main`
  # containing "Failed to transpile" means the test body never ran.
  [ "$hollow" = "1" ] && fail "battery $name is HOLLOW (test body did not transpile)"
  [ "$hollow" = "NA" ] && fail "battery $name produced no batch .c — hollow state unknown"
done

echo "=== T1 GATE 2: corpus diff-test ==="
YO_SELF_BIN=$S1 scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4 &> "/tmp/${P}_corpus.log"
corpus=$(tail -1 "/tmp/${P}_corpus.log")
echo "$corpus"
echo "$corpus" | grep -qE 'DIFF 0( |$)' || fail "corpus diff-test reported a DIFF: $corpus"
echo "$corpus" | grep -qE 'SELF-FAIL 0( |$)' || {
  fail "corpus diff-test reported a SELF-FAIL: $corpus"
  dump_log "/tmp/${P}_corpus.log"
}

echo "=== T1 GATE 3: check ./std ==="
YO_MAIN_STACK_MB=4096 "$S1" check ./std &> "/tmp/${P}_std.log"
std_rc=$?
echo "STD_RC=$std_rc  $(tail -1 "/tmp/${P}_std.log")"
if [ "$std_rc" != "0" ]; then
  fail "check ./std rc=$std_rc"
  dump_log "/tmp/${P}_std.log"
fi

echo "=== T1 GATE 4: check ./yo-self ==="
# The compiler type-checking ITSELF. GATE 3 only covers ./std, which left two
# ported-but-unwired libraries (build_runner.yo, version_cache.yo — ~1600 lines)
# type-checked by nothing at all: they are outside main.yo's import closure, so
# the stage-2/stage-3 compiles never touch them either. This is also the
# workload that exposed the -O0 stack-exhaustion class (AGENTS.md), hence the
# explicit stack bump.
YO_MAIN_STACK_MB=4096 "$S1" check ./yo-self &> "/tmp/${P}_yoself.log"
yoself_rc=$?
echo "YOSELF_RC=$yoself_rc  $(tail -1 "/tmp/${P}_yoself.log")"
if [ "$yoself_rc" != "0" ]; then
  fail "check ./yo-self rc=$yoself_rc"
  dump_log "/tmp/${P}_yoself.log"
fi

# NOTE: a `fmt` differential is deliberately NOT a gate yet. Running
# `<bin> fmt --check ./std ./tests ./yo-self` today reports 315 files (down from
# 417 once the line-leading-dot bug was fixed), so wiring it in would land a
# permanently-red gate. The remaining divergence is tracked in
# issues/yo-self-formatter-diverges-from-ts.md, which also records why the naive
# framing is not a clean differential: the TS formatter PRESERVES existing line
# structure rather than canonicalizing it, so "would format" mixes real spacing
# bugs with line-breaking differences. Add the gate with the fix, per P1.

echo "=== T1_DONE (${P}) failures=${fails} ==="
[ "$fails" = "0" ] || exit 1
