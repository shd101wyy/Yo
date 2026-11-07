#!/usr/bin/env bash
# G-B, the ASan must-reject directory (plans/backlog/BORROW_CHECKER_COMPLETENESS.md
# §6 G-B): every program in tests/origins/unsound/ is a hole's program with a
# header `// expect: E09xx` (or `// expect: accept` for a positive control, the
# same shape with the invalidating event after the last use).
#
# A negative program must FAIL `yo check` with exactly that code. When it does
# not, the program is compiled with --sanitize address --allocator system and
# RUN: the use-after-free (or ICE) the missing rejection would ship is printed
# beside the missing rejection, so a regression is never silent. A positive
# control is compiled and run under ASan too and must exit 0.
#
# Usage (from the repository root, the C compiler on PATH — inside the nix
# shell for a tree binary):
#   YO=<yo binary> bash scripts/origins-unsound.sh
# Each check is one `yo check` of a small program; the ASan leg runs only for
# a program that passes its `yo check` (a missing rejection) and for the
# positive controls.

set -uo pipefail

YO=${YO:-yo}
ROOT=$PWD
DIR=tests/origins/unsound
[ -d "$DIR" ] && [ -d std ] || { echo "run from the repository root" >&2; exit 2; }

fail=0
pass=0
problem() { echo "  FAIL $1"; fail=$((fail + 1)); }

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

# Compile-and-run one program under ASan; prints the verdict on stdout.
asan_run() { # <program> <log>
  local prog=$1 log=$2 bin
  bin="$OUT/$(basename "$prog" .yo)"
  if ! "$YO" compile "$prog" --std-path "$ROOT/std" --optimize 1 \
      --sanitize address --allocator system --cc "${YO_CC:-clang}" -o "$bin" >"$log" 2>&1; then
    echo "COMPILE-FAIL"
    return
  fi
  if ! ASAN_OPTIONS=detect_stack_use_after_return=1 "$bin" >"$log.run" 2>&1; then
    echo "RUN-FAIL"
    return
  fi
  echo "RUN-OK"
}

for prog in "$DIR"/*.yo; do
  id=$(basename "$prog" .yo)
  expect=$(sed -n 's/^\/\/ expect: //p' "$prog" | head -1)
  [ -n "$expect" ] || { problem "$id: no '// expect:' header"; continue; }
  log="$OUT/$id.check.log"
  "$YO" check "$prog" --std-path "$ROOT/std" > "$log" 2>&1
  rc=$?
  first=$(grep -m1 -oE '^error\[[E0-9]+\]' "$log" | grep -oE 'E[0-9]+')
  if [ "$expect" = accept ]; then
    # A positive control: check-accept, then compile and run clean under ASan.
    if [ $rc -ne 0 ]; then
      problem "$id: positive control rejected: $(grep -m1 '^error' "$log")"
      continue
    fi
    verdict=$(asan_run "$prog" "$OUT/$id.asan.log")
    if [ "$verdict" = RUN-OK ]; then
      pass=$((pass + 1))
    else
      problem "$id: positive control $verdict under ASan: $(tail -3 "$OUT/$id.asan.log" 2>/dev/null | head -3)"
    fi
  else
    if [ $rc -eq 0 ] || [ "$first" != "$expect" ]; then
      # The missing rejection: show what the program does when it runs.
      verdict=$(asan_run "$prog" "$OUT/$id.asan.log")
      problem "$id: expected $expect, yo check rc=$rc first='${first:-none}'; compiled+run: $verdict $(grep -m1 -E 'ERROR: AddressSanitizer|SUMMARY: AddressSanitizer' "$OUT/$id.asan.log" 2>/dev/null)"
      continue
    fi
    pass=$((pass + 1))
  fi
done

echo "origins unsound (G-B): $pass passed, $fail failed"
[ $fail -eq 0 ]
