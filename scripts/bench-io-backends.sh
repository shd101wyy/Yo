#!/usr/bin/env bash
# The backend comparison table (plans/reference/DROP_LIBURING.md Phase 6, G2): runs
# scripts/bench/io_bench.yo under YO_IO_BACKEND=uring and =epoll on THIS box,
# prints the ratio table, and checks the floors in scripts/bench/io-floors.env
# (a ratchet: record merged numbers there, never lower one). Wall-clock
# numbers vary by machine — this is a merge criterion and release check, not
# a CI gate; the CI-enforceable guarantees are scripts/io-budget-check.sh.
#
# Usage: YO=<yo-binary> YO_STD=<std-dir> scripts/bench-io-backends.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
YO="${YO:?set YO to the yo binary}"
: "${YO_STD:?set YO_STD to the std directory}"
OUT="$(mktemp -d)"
trap 'rm -rf "${OUT}"' EXIT
BIN="${OUT}/io_bench"

"${YO}" compile "${HERE}/bench/io_bench.yo" --optimize 2 -o "${BIN}" >/dev/null

run() { # <backend> -> writes <backend>.metrics
  local backend="$1"
  YO_IO_BACKEND="${backend}" YO_BENCH_DIR="${OUT}" "${BIN}" > "${OUT}/${backend}.raw" 2> "${OUT}/${backend}.err" || {
    echo "bench failed under ${backend}:" >&2; cat "${OUT}/${backend}.err" >&2; exit 1;
  }
  # metric = operations per second from MICROSECOND timings (the old whole-
  # millisecond readings of ~7 ms runs, with 0 replaced by 1, could not
  # resolve a 2x difference); higher is better, so ratio = epoll/uring.
  for key in pingpong parked timer file; do
    us=$(sed -n "s/^${key}_us \([0-9]*\) ops \([0-9]*\).*/\1/p" "${OUT}/${backend}.raw")
    ops=$(sed -n "s/^${key}_us \([0-9]*\) ops \([0-9]*\).*/\2/p" "${OUT}/${backend}.raw")
    if [ -z "${us}" ] || [ "${us}" -le 0 ]; then
      echo "bench under ${backend}: no usable ${key} timing" >&2; exit 1
    fi
    echo "${key} $(awk "BEGIN{print ${ops}*1000000/${us}}")" >> "${OUT}/${backend}.metrics"
  done
}

run uring
run epoll

fail=0
printf '%-10s %12s %12s %8s %8s\n' benchmark uring epoll ratio floor
while read -r key u_val; do
  e_val=$(sed -n "s/^${key} //p" "${OUT}/epoll.metrics")
  ratio=$(awk "BEGIN{printf \"%.3f\", ${e_val}/${u_val}}")
  floor=$(sed -n "s/^${key}_min_ratio=//p" "${HERE}/bench/io-floors.env")
  floor_txt="${floor:-n/a}"
  verdict=ok
  if [ -n "${floor}" ]; then
    awk "BEGIN{exit !(${ratio} < ${floor})}" && { verdict="BELOW FLOOR"; fail=1; }
  fi
  printf '%-10s %12.1f %12.1f %8s %8s  %s\n' "${key}" "${u_val}" "${e_val}" "${ratio}" "${floor_txt}" "${verdict}"
done < "${OUT}/uring.metrics"

cat "${OUT}/uring.raw"
if [ "${fail}" -ne 0 ]; then
  echo "BACKEND BENCH: BELOW FLOOR" >&2
  exit 1
fi
echo "BACKEND BENCH: floors met"
