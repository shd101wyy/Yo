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
  # Check EVERY batch, not a hardcoded `.yo_selftest_batch_1.bin.c`: the runner
  # now splits a file's tests into batches of TEST_BATCH_SIZE (mirroring TS's
  # DEFAULT_TEST_BATCH_SIZE=100), so the artifacts are
  # `.yo_selftest_batch_<file>_<batch>.bin.c` and a big file emits several. A
  # hardcoded name reported hollow=NA for every file once batching landed, and
  # would silently skip batches 2..N even if it still matched batch 1.
  # hollow_sweep69.sh already globs the same way.
  batch_cs=$(ls "$d"/.yo_selftest_batch_*.bin.c 2>/dev/null)
  hollow=NA
  if [ -n "$batch_cs" ]; then
    hollow=0
    for c in $batch_cs; do
      if sed -n '/^void __yo_user_main() {/,/^}/p' "$c" | grep -q 'Failed to transpile'; then hollow=1; fi
    done
  fi
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
corpus_rc=$?
corpus=$(tail -1 "/tmp/${P}_corpus.log")
echo "CORPUS_RC=$corpus_rc  $corpus"
# diff-test.sh prints TWO different scorecards, and this gate has to read both.
# With a TS arm present it is the DIFFERENTIAL one (DIFF / SELF-FAIL / TS-FAIL);
# with `out/cjs/yo-cli.cjs` absent it falls back to GOLDEN mode and prints
# GOLDEN-DIFF / NO-GOLDEN, which contains no SELF-FAIL token at all.
#
# The absent TS arm is now the STEADY STATE for this job (P2.5 took bun/node out
# of it), so the old unconditional `grep SELF-FAIL 0` failed EVERY golden-mode
# run regardless of the result: runs 31856743929 and 31865473380 both reported
# "PASS 155 GOLDEN-DIFF 0 NO-GOLDEN 0 (total 155)" — a perfect score — and still
# failed the gate. The `DIFF 0` check meanwhile passed only by accident, since
# "GOLDEN-DIFF 0" happens to contain the substring "DIFF 0".
#
# The exit code is the mode-agnostic signal (diff-test.sh counts GOLDEN-DIFF and
# NO-GOLDEN as failures too), so it leads; the token checks stay as
# defence-in-depth, each matched against the scorecard its own mode emits.
[ "$corpus_rc" -eq 0 ] || {
  fail "corpus diff-test rc=$corpus_rc: $corpus"
  dump_log "/tmp/${P}_corpus.log"
}
if echo "$corpus" | grep -q 'GOLDEN-DIFF'; then
  echo "$corpus" | grep -qE 'GOLDEN-DIFF 0( |$)' || {
    fail "corpus diff-test reported a GOLDEN-DIFF: $corpus"
    dump_log "/tmp/${P}_corpus.log"
  }
  echo "$corpus" | grep -qE 'NO-GOLDEN 0( |$)' || {
    fail "corpus diff-test has cases with no golden: $corpus"
    dump_log "/tmp/${P}_corpus.log"
  }
else
  echo "$corpus" | grep -qE ' DIFF 0( |$)' || fail "corpus diff-test reported a DIFF: $corpus"
  echo "$corpus" | grep -qE 'SELF-FAIL 0( |$)' || {
    fail "corpus diff-test reported a SELF-FAIL: $corpus"
    dump_log "/tmp/${P}_corpus.log"
  }
fi

echo "=== T1 GATE 2b: corpus golden scoring ==="
# Same corpus, self arm scored against tests/codegen-bootstrap/goldens/
# (recorded with GATE 2's own flags — they are behavior-affecting). While both
# compilers exist this is the drift ratchet keeping the goldens honest; after
# src/ retirement it replaces GATE 2 (plans/P2_5_RETIRE_EXECUTION.md step 13).
# An intended behavior change re-records in the same commit:
#   scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4 --record
YO_SELF_BIN=$S1 scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4 --golden &> "/tmp/${P}_corpus_golden.log"
corpus_golden_rc=$?
echo "CORPUS_GOLDEN_RC=$corpus_golden_rc  $(tail -1 "/tmp/${P}_corpus_golden.log")"
if [ "$corpus_golden_rc" != "0" ]; then
  fail "corpus golden scoring failed (re-record with --record if the change is intended)"
  dump_log "/tmp/${P}_corpus_golden.log"
fi

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

echo "=== T1 GATE 5: CLI subcommands actually RUN (execution differential) ==="
# `check` proves a subcommand type-checks. It does NOT prove anything ever calls
# it. `init` shipped as 239 complete, type-checking lines wired to no subcommand
# — so it had never been executed once, and the first run SIGSEGV'd on an
# `io.await` in an `if` condition that codegen miscompiled silently
# (issues/fixed/yo-self-init-segfaults-on-first-run.md).
#
# That is the class this gate exists for: "ported" here can mean "type-checks
# and is unreachable", and only running the thing tells them apart. Assert the
# artifacts, not just rc=0 — the original bug created the directories and then
# died, so a directory-only check would have passed it.
init_dir="/tmp/${P}_init"
rm -rf "$init_dir" && mkdir -p "$init_dir"
(cd "$init_dir" && timeout 300 "$S1" init probe --name probe) &> "/tmp/${P}_init.log"
init_rc=$?
missing=""
for f in build.yo deps.yo src/main.yo src/lib.yo tests/main.test.yo .gitignore README.md; do
  [ -f "$init_dir/probe/$f" ] || missing="$missing $f"
done
echo "INIT_RC=$init_rc  missing=[${missing:-none}]"
if [ "$init_rc" != "0" ] || [ -n "$missing" ]; then
  fail "init execution differential rc=$init_rc missing=[${missing:-none}]"
  dump_log "/tmp/${P}_init.log"
fi

echo "=== T1 GATE 6: fmt (self-hosted check + write idempotence) ==="
# History: this was a TS-vs-self differential while the two formatters were
# being reconciled (339 divergent files → 17 → 0; root causes recorded in
# plans/P1_CLI_PARITY.md §7, resolution measured 2026-08-11 over all 865
# files). The TS pre-check is gone per plans/P2_5_RETIRE_EXECUTION.md step 14;
# what replaces the differential's value is (a) the tree must be
# self-fmt-clean, and (b) write mode must be a NO-OP on a check-clean tree —
# a diff there is a check/write divergence, the class --check alone can't see.
# The fmt-check/fmt-write cli-cases (GATE 7/7b) pin the formatter's OUTPUT.
#
# Clear GATE 1's leftovers first. It runs with YO_KEEP_BATCH=1 (the hollow check
# needs the emitted .c), which leaves generated `.yo_selftest_batch_*.yo` next to
# the test files — machine-generated and NOT fmt-clean, so `fmt --check ./tests`
# would report them and this gate would fail on its own debris.
find ./tests -name '.yo_selftest_batch_*' -delete 2>/dev/null

YO_MAIN_STACK_MB=4096 "$S1" fmt --check ./std ./tests ./yo-self &> "/tmp/${P}_fmt_self.log"
fmt_self_rc=$?
echo "FMT_SELF_RC=$fmt_self_rc"
if [ "$fmt_self_rc" != "0" ]; then
  fail "self-hosted fmt --check reports the tree unformatted"
  dump_log "/tmp/${P}_fmt_self.log"
else
  # Compare the diff CONTENT before/after the write, not cleanliness — a local
  # tree may carry unrelated in-flight edits, and a bare `git checkout` here
  # would destroy them. Files already dirty before the gate are never restored.
  fmt_pre_diff="$(git diff -- std tests yo-self | shasum -a 256)"
  fmt_pre_dirty="$(git diff --name-only -- std tests yo-self)"
  YO_MAIN_STACK_MB=4096 "$S1" fmt ./std ./tests ./yo-self &> "/tmp/${P}_fmt_write.log"
  fmt_post_diff="$(git diff -- std tests yo-self | shasum -a 256)"
  if [ "$fmt_pre_diff" = "$fmt_post_diff" ]; then
    echo "FMT_IDEMPOTENT=1"
  else
    fail "fmt write mode changed a check-clean tree (check/write divergence)"
    git diff --stat -- std tests yo-self | head -20
    # Restore only what the WRITE touched: dirty-now minus dirty-before.
    git diff --name-only -- std tests yo-self | while IFS= read -r fmt_f; do
      printf '%s\n' "$fmt_pre_dirty" | grep -qxF "$fmt_f" || git checkout -- "$fmt_f"
    done
  fi
fi

echo "=== T1 GATE 7: CLI subcommand differential ==="
# GATE 5 runs `init` and asserts its artifacts. This runs the whole corpus under
# BOTH compilers in isolated sandboxes (own project dir, own HOME) and diffs
# exit code, stdout, the project tree and the HOME tree. See
# tests/cli-cases/README.md; cases for not-yet-dispatched subcommands live in
# tests/cli-cases/pending/ and are not picked up here.
YO_SELF_BIN=$S1 scripts/cli-diff-test.sh &> "/tmp/${P}_clidiff.log"
clidiff_rc=$?
echo "CLIDIFF_RC=$clidiff_rc  $(tail -1 "/tmp/${P}_clidiff.log")"
if [ "$clidiff_rc" != "0" ]; then
  fail "CLI subcommand differential failed"
  dump_log "/tmp/${P}_clidiff.log"
fi

echo "=== T1 GATE 7b: CLI golden scoring ==="
# Same corpus, scored against the per-case recorded goldens (expected_rc /
# expected_stdout / expected_tree / expected_home_tree). While both compilers
# exist this is the drift ratchet that keeps the goldens honest — an intended
# behavior change must re-record its goldens in the same commit
# (scripts/cli-diff-test.sh --record). After src/ retirement it is the
# differential's replacement (plans/P2_5_RETIRE_EXECUTION.md step 12).
YO_SELF_BIN=$S1 scripts/cli-diff-test.sh --golden &> "/tmp/${P}_cligolden.log"
cligolden_rc=$?
echo "CLIGOLDEN_RC=$cligolden_rc  $(tail -1 "/tmp/${P}_cligolden.log")"
if [ "$cligolden_rc" != "0" ]; then
  fail "CLI golden scoring failed (re-record with scripts/cli-diff-test.sh --record if the change is intended)"
  dump_log "/tmp/${P}_cligolden.log"
fi

echo "=== T1_DONE (${P}) failures=${fails} ==="
[ "$fails" = "0" ] || exit 1
