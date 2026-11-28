#!/usr/bin/env bash
# Instructions per iteration of the allocation-free async benchmarks
# (plans/backlog/ALLOCATION_FREE_ASYNC.md, AFA-0; scripts/bench/async-chain.yo).
# Each mode runs at N = 0 and at N = COUNT; the figure is
# (instructions(N) - instructions(0)) / N, user-space instructions only, so it
# is deterministic on a shared machine (a count, not a clock). Uses
# `perf stat -e instructions:u` when perf can count, else
# `valgrind --tool=callgrind`; the first line says which.
#
# A second table gives cells and starts per iteration from the program's own
# `YO_ASYNC_STATS=1` report (the same N = 0 difference), when the compiler
# emits one; a compiler without it prints a note instead.
#
# Usage: YO=<yo-binary> YO_STD=<std-dir> [COUNT=100000] [MODES="chain select timeout spawn pingpong"] \
#          scripts/bench-async-chain.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
YO="${YO:?set YO to the yo binary}"
: "${YO_STD:?set YO_STD to the std directory}"
COUNT="${COUNT:-100000}"
MODES="${MODES:-chain select timeout spawn pingpong}"
OUT="$(mktemp -d)"
trap 'rm -rf "${OUT}"' EXIT
"${YO}" compile "${HERE}/bench/async-chain.yo" --std-path "${YO_STD}" --optimize 2 -o "${OUT}/bench" >/dev/null

if perf stat -x, -e instructions:u -o "${OUT}/probe" true 2>/dev/null &&
  grep -qE '^[0-9]+,,instructions' "${OUT}/probe"; then
  counter=perf
elif command -v valgrind >/dev/null 2>&1; then
  counter=callgrind
else
  echo "neither a working perf nor valgrind is available" >&2
  exit 2
fi
echo "counter: ${counter} (user-space instructions)"

instructions() { # <mode> <count>: instructions of one run
  if [ "${counter}" = perf ]; then
    BENCH_MODE="$1" BENCH_COUNT="$2" perf stat -x, -e instructions:u -o "${OUT}/stat" "${OUT}/bench" >/dev/null
    sed -n 's/^\([0-9]*\),,instructions.*/\1/p' "${OUT}/stat"
  else
    BENCH_MODE="$1" BENCH_COUNT="$2" valgrind --tool=callgrind --callgrind-out-file=/dev/null \
      "${OUT}/bench" 2>&1 >/dev/null | sed -n 's/^==[0-9]*== Collected : \([0-9]*\).*/\1/p'
  fi
}

printf '%-10s %12s %14s %14s\n' mode iterations total instr/iter
for m in ${MODES}; do
  base=$(instructions "${m}" 0)
  full=$(instructions "${m}" "${COUNT}")
  printf '%-10s %12s %14s %14s\n' "${m}" "${COUNT}" "${full}" "$(awk "BEGIN{printf \"%.0f\", (${full} - ${base}) / ${COUNT}}")"
done

stat() { # <mode> <count> <key>: one counter of the YO_ASYNC_STATS line of a run
  YO_ASYNC_STATS=1 BENCH_MODE="$1" BENCH_COUNT="$2" "${OUT}/bench" 2>&1 >/dev/null |
    sed -n 's/^yo: async-stats.* '"$3"'=\([0-9]*\).*/\1/p'
}
if [ -z "$(stat chain 0 sm_cells)" ]; then
  echo "this compiler emits no YO_ASYNC_STATS report; the cells table is skipped"
  exit 0
fi
echo
printf '%-10s %10s %10s %10s %12s %10s %10s\n' mode sm_cells sync_cells io_cells cell_starts fused spawns
for m in ${MODES}; do
  row=""
  for k in sm_cells sync_cells io_cells cell_starts fused_awaits spawns; do
    base=$(stat "${m}" 0 "${k}")
    full=$(stat "${m}" "${COUNT}" "${k}")
    row="${row} $(awk "BEGIN{printf \"%.2f\", (${full} - ${base}) / ${COUNT}}")"
  done
  # shellcheck disable=SC2086
  printf '%-10s %10s %10s %10s %12s %10s %10s\n' "${m}" ${row}
done
