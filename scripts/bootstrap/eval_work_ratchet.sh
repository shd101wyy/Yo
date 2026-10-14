#!/bin/bash
# eval_work_ratchet.sh — the evaluator WORK ratchet (plans/VALUES_BY_DEFAULT.md §6,
# "Evaluator performance", step 3). Counts the heap allocation calls made by
# `check src/main.yo` and compares the count with the recorded baseline in
# memory-ratchet.tsv. The sibling memory_ratchet.sh gates max RSS; this gates
# CPU work, which RSS does not see (v0.2.50 -> v0.2.61: check ./src 113 s ->
# 177 s with RSS +3%; RC traffic and malloc/free were most of the growth).
#
#   bash scripts/bootstrap/eval_work_ratchet.sh <libc-linked yo binary> <alloc_count.so>
#
# Wall time is no gate on ubuntu-latest (identical trees: 3:47 to 8:53). An
# allocation count is deterministic: the run is single-process, ASLR is off
# (setarch -R), so nothing address- or schedule-dependent can move it.
#
# The binary must call the C library's malloc DYNAMICALLY so the LD_PRELOAD
# counter (alloc_count.c) sees the calls. CI's stage-2 binary links the
# vendored mimalloc statically, so the job recompiles the stage-2 C without the
# mimalloc include path: the emitted `__has_include(<mimalloc.h>)` fails and
# __yo_malloc becomes malloc. The script refuses a binary that does not import
# malloc, and a count below a floor (a wrong binary measures ~nothing).
#
# Fails BOTH ways like memory_ratchet.sh: more than TOL_PCT above the baseline
# is a regression; more than TOL_PCT below means the baseline must be lowered
# in the same PR. A baseline of 0 means "not recorded yet": the run prints the
# measurement and fails. REPEAT=N runs the measurement N times and prints the
# spread (the determinism probe); the gate uses the first run.
set -u
BIN="${1:?usage: eval_work_ratchet.sh <libc-linked yo binary> <alloc_count.so>}"
SHIM="${2:?usage: eval_work_ratchet.sh <libc-linked yo binary> <alloc_count.so>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TSV="$HERE/memory-ratchet.tsv"
KEY="check_src_main_alloc_calls"
TOL_PCT="${TOL_PCT:-5}"
REPEAT="${REPEAT:-1}"
FLOOR=1000000
base=$(awk -v k="$KEY" '$1 == k { print $2 }' "$TSV")
if [ -z "$base" ]; then
  echo "FAIL: no '$KEY' row in $TSV"
  exit 1
fi
if ! nm -D --undefined-only "$BIN" | awk '{ print $NF }' | grep -Eq '^malloc(@|$)'; then
  echo "FAIL: $BIN does not import malloc dynamically; the LD_PRELOAD counter would see nothing."
  echo "      Build it without the mimalloc include path (see the memory-ratchet job)."
  exit 1
fi
SHIM="$(cd "$(dirname "$SHIM")" && pwd)/$(basename "$SHIM")"
work=$(mktemp -d)
first=""
counts=()
for i in $(seq 1 "$REPEAT"); do
  out="$work/counts.$i"
  start=$(date +%s)
  setarch "$(uname -m)" -R env LD_PRELOAD="$SHIM" YO_ALLOC_COUNT_OUT="$out" \
    "$BIN" check src/main.yo --std-path ./std > "$work/log.$i" 2>&1
  rc=$?
  secs=$(( $(date +%s) - start ))
  if [ $rc -ne 0 ]; then
    echo "FAIL: check src/main.yo exited $rc"
    tail -40 "$work/log.$i"
    exit 1
  fi
  if [ ! -s "$out" ]; then
    echo "FAIL: the counter wrote no $out (did the process leave through _exit?)"
    exit 1
  fi
  echo "run $i (${secs} s wall, $(wc -l < "$out") process line(s)):"
  sed 's/^/  /' "$out"
  n=$(awk '{ for (f = 2; f <= 5; f++) { split($f, kv, "="); s += kv[2] } } END { printf "%.0f", s }' "$out")
  echo "  allocation calls (malloc+calloc+realloc+aligned): $n"
  counts+=("$n")
  [ -z "$first" ] && first="$n"
done
if [ "$REPEAT" -gt 1 ]; then
  printf '%s\n' "${counts[@]}" | awk '
    NR == 1 { lo = $1; hi = $1 }
    { if ($1 < lo) lo = $1; if ($1 > hi) hi = $1 }
    END { printf "spread over %d runs: min %.0f, max %.0f, max-min %.0f (%.4f%%)\n", NR, lo, hi, hi - lo, (hi - lo) * 100.0 / lo }'
fi
n="$first"
echo "check src/main.yo: ${n} allocation calls; baseline ${base}, tolerance ±${TOL_PCT}%"
if [ "$n" -lt "$FLOOR" ]; then
  echo "FAIL: ${n} allocation calls is below the ${FLOOR} floor — the counter is not seeing the evaluator's allocations."
  exit 1
fi
if [ "$base" -eq 0 ]; then
  echo "FAIL: baseline not recorded yet — set '$KEY' in scripts/bootstrap/memory-ratchet.tsv to ${n}"
  exit 1
fi
hi=$(( base * (100 + TOL_PCT) / 100 ))
lo=$(( base * (100 - TOL_PCT) / 100 ))
if [ "$n" -gt "$hi" ]; then
  echo "FAIL: evaluator work regression — ${n} allocation calls > ${hi} (baseline ${base} + ${TOL_PCT}%)."
  echo "      Find the new copies before merging (a clone in a hot loop, a by-value String/ArrayList"
  echo "      parameter that should be a & lend); raise the baseline only for a deliberate, explained cost."
  exit 1
fi
if [ "$n" -lt "$lo" ]; then
  echo "FAIL: evaluator work improved beyond the ratchet — ${n} < ${lo}. Lower '$KEY' in"
  echo "      scripts/bootstrap/memory-ratchet.tsv to ${n} in this PR so the win is kept."
  exit 1
fi
echo "PASS: within ±${TOL_PCT}% of the baseline"
