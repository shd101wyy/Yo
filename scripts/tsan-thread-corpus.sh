#!/usr/bin/env bash
# The standing proof of plans/archive/PARALLELISM_SOUNDNESS.md (Phase 7): every file of
# the thread corpus under ThreadSanitizer, ratcheted against
# scripts/bootstrap/tsan-known-failing.tsv so the gate fails BOTH ways — a new
# report fails it, and so does a listed file that now runs clean (remove its
# line). A run is also rejected as HOLLOW when the file never spawned a thread:
# TSan reports nothing on a program with one thread, and that silence must not
# count as a pass (YO_REPORT_SPAWNS makes the runtime print `yo: spawns=N` at
# exit).
#
#   BIN=/tmp/yo-stage1 bash scripts/tsan-thread-corpus.sh [--cc clang]
set -u
BIN=${BIN:?set BIN to the yo binary}
CC=${CC:-clang}
KNOWN=scripts/bootstrap/tsan-known-failing.tsv
OUT=${OUT:-/tmp/tsan-thread-corpus}
mkdir -p "$OUT"
# Only files that spawn threads: tests/thread_safety, tests/atomic_object and
# tests/iso_api_surface check their rules at compile time or on one thread,
# where TSan has nothing to observe (every run of them was HOLLOW).
FILES=(
  tests/thread.test.yo
  tests/thread_pool.test.yo
  tests/arc.test.yo
  tests/iso.test.yo
  tests/cross_thread_wake.test.yo
  tests/spawn_blocking.test.yo
  tests/imm_threading.test.yo
  tests/parallelism_soundness.test.yo
  tests/encoding/html.test.yo
  tests/unsafe_cast_rc_borrow.test.yo
)
known() { grep -v '^#' "$KNOWN" 2>/dev/null | awk -F'\t' -v f="$1" '$1==f{print "yes"; exit}'; }
bad=0
for f in "${FILES[@]}"; do
  log="$OUT/$(echo "$f" | tr '/' '_').log"
  YO_REPORT_SPAWNS=1 YO_TEST_SANITIZE=thread TSAN_OPTIONS=halt_on_error=1 YO_TEST_LEAK_VERDICT=0 \
    "$BIN" test "$f" --parallel 1 --verbose --c-compiler "$CC" > "$log" 2>&1
  rc=$?
  spawns=$(grep -ao 'yo: spawns=[0-9]*' "$log" | sed 's/.*=//' | awk '{s+=$1} END{print s+0}')
  races=$(grep -ac 'WARNING: ThreadSanitizer' "$log")
  listed=$(known "$f")
  if [ "$rc" -eq 0 ] && [ "$spawns" -eq 0 ]; then
    verdict=HOLLOW
  elif [ "$rc" -eq 0 ]; then
    verdict=PASS
  else
    verdict=FAIL
  fi
  echo "$verdict $f rc=$rc spawns=$spawns tsan_reports=$races${listed:+ (known-failing)}"
  case "$verdict" in
    PASS) if [ -n "$listed" ]; then echo "  -> listed in $KNOWN but now passes: remove its line"; bad=1; fi ;;
    FAIL) if [ -z "$listed" ]; then
        echo "  -> new failure; log: $log"
        awk '/WARNING: ThreadSanitizer/{p=1} p{print} /SUMMARY: ThreadSanitizer/{if(p && ++n==3) exit; p=0}' "$log" | head -150
        # A failure with no TSan report (a crash, an assert, a TSan fatal
        # error) says why only in the test's own output: print each failed
        # test with what it printed. A file that failed before any test ran
        # (spawns=0: its batch did not compile, or the runner died) has no
        # such line, so print the end of its log instead.
        if [ "$races" -eq 0 ]; then
          if grep -aq '✗' "$log"; then grep -a -A12 '✗' "$log" | head -80; else grep -av '^profile:' "$log" | tail -40; fi
          grep -a -m5 'ThreadSanitizer' "$log"
        fi
        bad=1
      fi ;;
    HOLLOW) echo "  -> no thread was spawned: the run proves nothing"; bad=1 ;;
  esac
done
exit $bad
