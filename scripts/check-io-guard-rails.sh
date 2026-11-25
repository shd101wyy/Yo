#!/usr/bin/env bash
# The Io interface's guard rail 1 in std (plans/backlog/ALLOCATION_FREE_ASYNC.md
# §4). The allocation-free async plan later starts every operation in a slot
# its caller owns (AFA-8), which rewrites `std/sys` and the two files named
# below; this rail keeps every other std file out of that rewrite. A grep
# gate, no binary needed.
#
#   1. `io.vtable.*.<op>(...)` is called only in `std/sys/`. The labels are
#      the fields of the prelude's `IoVTable`; while the prelude declares no
#      `IoVTable`, an `Io` has no table and there is no such call to find.
#   2. `IoFuture` is named, outside comments, only in `std/sys/` and in the
#      two files that build join waits and parks today: `std/async/index.yo`
#      and `std/async/waker.yo` (VERDICTS-81 §3).
#
# Usage (from anywhere in the repository): bash scripts/check-io-guard-rails.sh

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2

EXEMPT_RE='^std/(sys/|async/index\.yo:|async/waker\.yo:)'
fail=0

# Strip `//` comments (line and doc comments) before matching. The patterns
# below never contain `//`.
code_lines() {
  # $1: a grep -E pattern; prints file:line:code for std/**.yo outside comments.
  git grep -nE "$1" -- 'std/*.yo' 'std/**/*.yo' | sed -E 's|//.*||' | grep -E "^[^:]*:[^:]*:.*($1)" || true
}

# 1. Calls through an Io's table: `vtable.*.<label>(` for a label of the
# prelude's `IoVTable` (an `Allocator`'s table has other labels).
io_labels=$(awk '/^IoVTable :: struct\(/ { on = 1; next } on && /^\);/ { exit } on && /^  [a-z_]+ : \(fn/ { sub(/^  /, ""); sub(/ :.*/, ""); print }' std/prelude.yo | paste -sd '|')
if [ -n "$io_labels" ]; then
  hits=$(code_lines "vtable\.\*\.($io_labels)\(" | grep -vE '^std/sys/' || true)
  if [ -n "$hits" ]; then
    echo "::error::io.vtable.*.<op> outside std/sys (ALLOCATION_FREE_ASYNC.md §4, rail 1):"
    echo "$hits"
    fail=1
  fi
  table="IoVTable has $(tr '|' '\n' <<<"$io_labels" | wc -l) entries"
else
  table="no IoVTable in std/prelude.yo"
fi

# 2. IoFuture outside its three homes.
hits=$(code_lines '\bIoFuture\b' | grep -vE "$EXEMPT_RE" || true)
if [ -n "$hits" ]; then
  echo "::error::IoFuture named outside std/sys, std/async/index.yo and std/async/waker.yo (ALLOCATION_FREE_ASYNC.md §4, rail 1):"
  echo "$hits"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "io guard rails: OK ($table)"
