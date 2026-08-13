#!/bin/bash
# hollow_sweep69.sh — full 188-file sweep that scores a test file HONESTLY:
# a file counts as GREEN only if it exits 0 AND its emitted batch `main` is not
# a `// Failed to transpile` comment. See issues/retired/yo-self-hollow-test-batch-main.md
# (a hollow main runs no assertions, so the harness reports every test as passed).
#
# Usage: BIN=/tmp/xxx_s1 OUT=/tmp/hsweep scratchpad/hollow_sweep69.sh
# Resumable: files already in $OUT/results.txt are skipped.
set -u
BIN="${BIN:-/tmp/drop_s1}"
OUT="${OUT:-/tmp/hsweep}"
TIMEOUT_S="${TIMEOUT_S:-900}"
mkdir -p "$OUT"
RESULTS="$OUT/results.txt"
touch "$RESULTS"
# `-prune` on tests/internal: those 58 files are the compiler's OWN tests (they
# were yo-self/tests until 2026-08-05, and landed under tests/ in the same move).
# Each one compiles the whole compiler — minutes and gigabytes apiece — so without
# this prune the sweep silently grows from the language corpus to ~4x the runtime.
# Run them with scripts/bootstrap/ or `test ./tests/internal` deliberately instead.
for t in $(find tests \( -path tests/internal -o -path tests/cli-cases \) -prune -o -name '*.test.yo' -print | sort); do
  grep -q "^$t " "$RESULTS" && continue
  d=$(dirname "$t"); n=$(echo "$t" | tr '/' '_')
  # Remove STALE batch artifacts from the PREVIOUS file first — the marker
  # count below globs the directory, and a leftover batch .c from another
  # test file phantom-hollowed clean files (the sweep previously read a
  # HARDCODED batch_1.bin.c, which for some files was the prior file's).
  rm -f "$d"/.yo_selftest_batch_*
  YO_KEEP_BATCH=1 timeout "$TIMEOUT_S" "$BIN" test "$t" --parallel 1 > "$OUT/$n.log" 2>&1
  rc=$?
  hollow=NA; markers=NA
  batch_cs=$(ls "$d"/.yo_selftest_batch_*.bin.c 2>/dev/null)
  if [ -n "$batch_cs" ]; then
    markers=$(cat $batch_cs | grep -c 'Failed to transpile\|Unknown type:\|// Error:')
    hollow=0
    for c in $batch_cs; do
      # `// Error:` joined this check when both codegens were changed to HALT on
      # an untranspilable expression instead of emitting a skippable C comment.
      # Neither marker should be emittable now, so this is a backstop against a
      # new marker site being introduced. NOTE `Unknown type:` is deliberately
      # NOT here: it is a LEGITIMATE "this type has no C representation, elide
      # the declaration" mechanism (comptime-only enum payloads and vtable
      # associated-type members — 3 of them in the compiler's own emitted C),
      # so it stays in the informational `markers` count only.
      if sed -n '/^void __yo_user_main() {/,/^}/p' "$c" | grep -q 'Failed to transpile\|// Error:'; then hollow=1; fi
    done
  fi
  summary=$(grep -oE '[0-9]+ passed' "$OUT/$n.log" | tail -1)
  if [ "$rc" -eq 0 ] && [ "$hollow" = "0" ]; then verdict=GREEN
  elif [ "$rc" -eq 0 ] && [ "$hollow" = "1" ]; then verdict=HOLLOW
  elif [ "$rc" -eq 0 ] && [ "$hollow" = "NA" ]; then verdict=GREEN_NOBATCH
  else verdict=RED; fi
  echo "$t $verdict rc=$rc hollow=$hollow markers=$markers ${summary:-none}" >> "$RESULTS"
done
echo "SWEEP_DONE" >> "$RESULTS"

# ---------------------------------------------------------------------------
# Gate. Scores the sweep against a checked-in allowlist of KNOWN-hollow files so
# this can gate CI today (blocking any NEW hollow file) while the known ones are
# worked down. Fails in BOTH directions so the allowlist cannot go stale:
#   * a hollow/RED file that is NOT allowlisted  -> fail (a regression)
#   * an allowlisted file that is no longer hollow -> fail (delete its line)
# Set ALLOWLIST=/dev/null to demand a fully-clean sweep.
# ---------------------------------------------------------------------------
ALLOWLIST="${ALLOWLIST:-$(dirname "$0")/known-failing.tsv}"

if [ ! -f "$ALLOWLIST" ] && [ "$ALLOWLIST" != "/dev/null" ]; then
  # Guard against the failure that shipped the first version of this gate: the
  # allowlist lived at known-hollow.TXT and `.gitignore`'s blanket `*.txt` rule
  # silently kept it out of the repo, so CI scored every known file as new.
  echo "FAIL: allowlist '$ALLOWLIST' does not exist (is it gitignored?)"
  exit 1
fi

# Compare "<path>\t<verdict>" PAIRS, not bare paths, so a file that changes from
# HOLLOW to RED (or back) is caught rather than silently tolerated.
known=$(grep -vE '^\s*(#|$)' "$ALLOWLIST" 2>/dev/null | awk 'NF>=2 {print $1"\t"$2}' | sort -u)
actual=$(awk '$2 == "HOLLOW" || $2 == "RED" {print $1"\t"$2}' "$RESULTS" | sort -u)

echo
echo "=== hollow sweep scorecard ==="
awk 'NF > 1 {print $2}' "$RESULTS" | sort | uniq -c
echo "allowlisted known-failing: $(echo "$known" | grep -c .)"

gate_fails=0

regressions=$(comm -23 <(echo "$actual") <(echo "$known"))
if [ -n "$regressions" ]; then
  echo "FAIL: failing file(s) not in $ALLOWLIST — a NEW regression under the self-hosted compiler."
  echo "      (HOLLOW = reports passes while running nothing; RED = non-zero exit/timeout)"
  echo "$regressions" | sed 's/^/  /'
  gate_fails=1
fi

stale=$(comm -13 <(echo "$actual") <(echo "$known"))
if [ -n "$stale" ]; then
  echo "FAIL: allowlisted entr(ies) no longer match — delete or update these lines in $ALLOWLIST:"
  echo "$stale" | sed 's/^/  /'
  gate_fails=1
fi

if [ "$gate_fails" = "0" ]; then
  echo "SWEEP_GATE_OK"
fi
exit "$gate_fails"
