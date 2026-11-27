#!/usr/bin/env bash
# The guard probe file (VERDICTS-70 rows 5 and 11): programs exercising the
# places the borrowed-argument guard (the caller-owned +1 a projection or an
# `Rc`/`Arc` payload place lent to a call once took, deleted in row 11)
# protected. Each program in tests/origins/guard/ is checked, then compiled
# and run under ASan, and its verdict is compared with its header.
#
# Headers (the first lines of each program):
#   // expect: accept | panic | E0xxx | reject | <VERDICT>
#       the verdict (`accept`, `panic` and `E0xxx` are the `expect` header
#       test 7 and G-B read). A recorded <VERDICT> (`DIRTY
#       heap-use-after-free`) is either a known open hole, and the program
#       then carries an `// issue:` line naming its open doc, or unsafe-capable
#       code (outside claim (S)) whose aliasing nothing in the compiler guards.
#   // issue: issues/<doc>.md   (optional) the open bug a recorded verdict
#       stands for; fixing it changes the verdict, and the fix re-records it.
#
# A verdict is one of:
#   REJECTED <code>   `yo check` fails with that first error code (`-` for
#                     an error that has none yet)
#   CLEAN             accepted, compiled under ASan, exits 0 with no report
#   PANIC             accepted; the run stops at a Yo panic or failed assert
#                     (`<message> (at <file>:<line>:<col>)`, then abort)
#   DIRTY <kind>      accepted; AddressSanitizer reports <kind>
#   LEAK              accepted; LeakSanitizer reports a leak
#   RUN-FAIL <rc> | TIMEOUT | COMPILE-FAIL | CHECK-CRASH
# `accept` means CLEAN, `panic` PANIC, `E0xxx` REJECTED E0xxx, `reject`
# REJECTED -. A changed verdict is progress (re-record the header) or a
# regression.
#
# Usage (from the repository root, clang on PATH: inside the nix shell for a
# tree binary):
#   YO=<yo binary> bash scripts/guard-off-probes.sh [<id>...]
# (<id> is a program's base name: run only those.)
# Prints one line per program; exit 0 when every verdict matches its header.
# About 10 s per program (one check, one ASan compile); no heavy-lock slot
# needed.

set -uo pipefail

ONLY=("$@")
YO=${YO:-yo}
ROOT=$PWD
DIR=${PROBES:-tests/origins/guard}
[ -d "$DIR" ] && [ -d std ] || { echo "run from the repository root" >&2; exit 2; }

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

# verdict <program> -> prints the verdict
verdict() {
  local prog=$1 id log bin rc code
  id=$(basename "$prog" .yo)
  log=$OUT/$id
  timeout 300 "$YO" check "$prog" --std-path "$ROOT/std" >"$log.check" 2>&1
  rc=$?
  if [ $rc -ne 0 ]; then
    code=$(grep -m1 -oE '^error\[E[0-9]+\]' "$log.check" | grep -oE 'E[0-9]+')
    if [ -n "$code" ]; then
      echo "REJECTED $code"
    elif grep -q '^error' "$log.check" && [ $rc -lt 124 ]; then
      echo "REJECTED -"
    else
      echo "CHECK-CRASH"
    fi
    return
  fi
  bin=$OUT/$id.bin
  if ! timeout 600 "$YO" compile "$prog" --std-path "$ROOT/std" --optimize 1 \
    --sanitize address --allocator system --cc "${YO_CC:-clang}" -o "$bin" >"$log.compile" 2>&1; then
    echo "COMPILE-FAIL"
    return
  fi
  ASAN_OPTIONS=detect_stack_use_after_return=1:detect_leaks=1 timeout 60 "$bin" >"$log.run" 2>&1
  rc=$?
  if grep -q 'ERROR: AddressSanitizer' "$log.run"; then
    echo "DIRTY $(grep -m1 -oE 'ERROR: AddressSanitizer: [A-Za-z-]+' "$log.run" | sed 's/.*: //')"
  elif grep -q 'ERROR: LeakSanitizer' "$log.run"; then
    echo "LEAK"
  elif [ $rc -eq 124 ]; then
    echo "TIMEOUT"
  elif [ $rc -eq 134 ] && grep -qE ' \(at [^)]*:[0-9]+:[0-9]+\)' "$log.run"; then
    echo "PANIC"
  elif [ $rc -ne 0 ]; then
    echo "RUN-FAIL rc$rc"
  else
    echo "CLEAN"
  fi
}

expected() { # <expect header value> -> verdict
  case $1 in
  accept) echo CLEAN ;;
  panic) echo PANIC ;;
  E[0-9]*) echo "REJECTED $1" ;;
  reject) echo "REJECTED -" ;;
  *) echo "$1" ;;
  esac
}

pass=0
fail=0
progs=()
if [ ${#ONLY[@]} -gt 0 ]; then
  for id in "${ONLY[@]}"; do progs+=("$DIR/$id.yo"); done
else
  progs=("$DIR"/*.yo)
fi
for prog in "${progs[@]}"; do
  id=$(basename "$prog" .yo)
  exp=$(sed -n 's/^\/\/ expect: //p' "$prog" | head -1)
  if [ -z "$exp" ]; then
    echo "FAIL $id: needs an '// expect:' header"
    fail=$((fail + 1))
    continue
  fi
  want=$(expected "$exp")
  got=$(verdict "$prog")
  if [ "$got" = "$want" ]; then
    echo "ok   $id: $got"
    pass=$((pass + 1))
  else
    echo "FAIL $id: expected $want, got $got"
    fail=$((fail + 1))
  fi
done
echo "guard probes: $pass passed, $fail failed"
[ $fail -eq 0 ]
