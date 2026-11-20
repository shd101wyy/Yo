#!/usr/bin/env bash
# The guard-off probe file (VERDICTS-70 row 5): programs exercising the copies
# the borrowed-argument guard protects today (Aliasing Stage 0, the caller-owned
# +1 that `consume_argument_for_parameter` takes for a projection or an
# `Rc`/`Arc` payload place lent to a call). Each program in tests/origins/guard/
# is run twice: with the default compiler, and with `YO_DEBUG_GUARD_OFF=1`,
# the debug knob that skips the guard arm.
#
# Headers (the first lines of each program):
#   // expect: accept | panic | E0xxx | reject   the verdict with the guard on, the
#                                          shipped compiler (the same `expect`
#                                          header test 7 and G-B read)
#   // guard-off: same | <VERDICT> [<kind>]  the verdict with the knob set:
#                                          `same` = what `expect` says, or a
#                                          recorded verdict below (`DIRTY
#                                          heap-use-after-free`, `LEAK`, ...)
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
# REJECTED -.
#
# A program whose guard-off verdict is DIRTY or LEAK while its default one is
# clean is the evidence that blocks deleting the guard (VERDICTS-70 Q3): the
# checker must reject or wall it first. A changed verdict in either column is
# progress (re-record the header) or a regression.
#
# Usage (from the repository root, clang on PATH: inside the nix shell for a
# tree binary):
#   YO=<yo binary> bash scripts/guard-off-probes.sh [default|guard-off|both] [<id>...]
# (<id> is a program's base name: run only those.)
# Prints one line per program and mode; exit 0 when every verdict matches its
# header. About 10 s per program and mode (one check, one ASan compile); no
# heavy-lock slot needed.

set -uo pipefail

MODES=${1:-both}
[ $# -gt 0 ] && shift
ONLY=("$@")
YO=${YO:-yo}
ROOT=$PWD
DIR=${PROBES:-tests/origins/guard}
[ -d "$DIR" ] && [ -d std ] || { echo "run from the repository root" >&2; exit 2; }
case "$MODES" in default) MODES=default ;; guard-off) MODES=guard-off ;; both) MODES="default guard-off" ;;
*) echo "mode is default, guard-off or both, got $MODES" >&2; exit 2 ;; esac

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

# verdict <program> <mode> -> prints the verdict
verdict() {
  local prog=$1 mode=$2 id log bin rc code knob
  id=$(basename "$prog" .yo)-$mode
  log=$OUT/$id
  knob=()
  [ "$mode" = guard-off ] && knob=(env YO_DEBUG_GUARD_OFF=1)
  timeout 300 "${knob[@]}" "$YO" check "$prog" --std-path "$ROOT/std" >"$log.check" 2>&1
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
  if ! timeout 600 "${knob[@]}" "$YO" compile "$prog" --std-path "$ROOT/std" --optimize 1 \
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
  off=$(sed -n 's/^\/\/ guard-off: //p' "$prog" | head -1)
  if [ -z "$exp" ] || [ -z "$off" ]; then
    echo "FAIL $id: needs both '// expect:' and '// guard-off:' headers"
    fail=$((fail + 1))
    continue
  fi
  want_default=$(expected "$exp")
  if [ "$off" = same ]; then want_off=$want_default; else want_off=$(expected "$off"); fi
  for mode in $MODES; do
    if [ "$mode" = default ]; then want=$want_default; else want=$want_off; fi
    got=$(verdict "$prog" "$mode")
    if [ "$got" = "$want" ]; then
      echo "ok   $mode $id: $got"
      pass=$((pass + 1))
    else
      echo "FAIL $mode $id: expected $want, got $got"
      fail=$((fail + 1))
    fi
  done
done
echo "guard-off probes: $pass passed, $fail failed"
[ $fail -eq 0 ]
