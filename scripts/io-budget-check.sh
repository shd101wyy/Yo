#!/usr/bin/env bash
# The deterministic I/O budgets (plans/DROP_LIBURING.md Phase 6, G3) — the
# hard CI gate of the performance guarantees. Counts, not clocks: kernel
# enters per operation must stay LINEAR (no syscall storms) and a blocked
# loop must accrue almost nothing (the anti-spin rule that keeps the
# DEFER_TASKRUN spin class from ever recurring silently).
#
# Usage: YO=<yo-binary> YO_STD=<std-dir> scripts/io-budget-check.sh
# Drives the budget program under BOTH backends: the default (io_uring) and
# YO_IO_BACKEND=epoll.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
YO="${YO:?set YO to the yo binary}"
: "${YO_STD:?set YO_STD to the std directory}"
BIN="$(mktemp -u /tmp/yo_io_budget.XXXXXX)"

"${YO}" compile "${HERE}/bench/io_budget.yo" --optimize 2 -o "${BIN}" >/dev/null

fail=0
for backend in uring epoll; do
  echo "=== io budgets: YO_IO_BACKEND=${backend} ==="
  if YO_IO_BACKEND="${backend}" "${BIN}" | tee /tmp/yo_io_budget_out.txt; then
    grep -q "ALL BUDGETS OK" /tmp/yo_io_budget_out.txt || fail=1
  else
    echo "budget program failed under ${backend}" >&2
    fail=1
  fi
done
rm -f "${BIN}" /tmp/yo_io_budget_out.txt
if [ "${fail}" -ne 0 ]; then
  echo "IO BUDGETS: FAIL" >&2
  exit 1
fi
echo "IO BUDGETS: PASS (both backends)"
