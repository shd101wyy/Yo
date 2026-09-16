#!/bin/bash
# warm_compile_gate.sh — Phase 4 (§7 step 1) gate: `yo compile --warm-selfcheck`
# compiles each fixture twice in one process (pass 2 holding pass 1's evaluator
# state) and requires byte-identical C with zero "Failed to transpile" markers.
#   BIN=<built yo> bash scripts/bootstrap/warm_compile_gate.sh
#
# The expectation table is a RATCHET: `must_pass` fixtures fail the script when
# red; `known_red` fixtures are the open work list (issues/warm-compile-selfcheck.md)
# — when one goes green, MOVE it to must_pass in the fixing PR; if a known_red
# fixture passes while still listed red, the script fails too (stale entry).
set -u
cd "$(dirname "$0")/../.." || exit 2
BIN=${BIN:-./yo-out/x86_64-unknown-linux-gnu/bin/yo}
if [ ! -x "$BIN" ]; then
  echo "usage: BIN=<built yo> bash scripts/bootstrap/warm_compile_gate.sh"
  exit 2
fi
export YO_STD=${YO_STD:-$PWD/std}
export YO_MAIN_STACK_MB=${YO_MAIN_STACK_MB:-4096}

FIXDIR=$(mktemp -d /tmp/yo_warm_gate.XXXXXX)
trap 'rm -rf "$FIXDIR"' EXIT

cat >"$FIXDIR/trivial.yo" <<'EOF'
main :: (fn(io : Io) -> unit)({
  x := i32(41);
});
export(main);
EOF
cat >"$FIXDIR/alist.yo" <<'EOF'
{ ArrayList } :: import("std/collections/array_list");
main :: (fn(io : Io) -> unit)({
  xs := ArrayList(i32).new();
  xs.push(i32(1));
  xs.push(i32(2));
});
export(main);
EOF
cat >"$FIXDIR/strings.yo" <<'EOF'
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn(io : Io) -> unit)({
  names := ArrayList(String).new();
  names.push(String.from("alpha"));
  names.push(String.from("beta"));
  total := usize(0);
  (i : usize) = usize(0);
  while(i < names.len(), {
    match(
      names.get(i),
      .Some(n) => {
        total = (total + n.len());
      },
      .None => ()
    );
    i = (i + usize(1));
  });
  println(`total=${total.to_string()}`);
});
export(main);
EOF

# must_pass: enforced green. known_red: the open work list — see
# issues/warm-compile-selfcheck.md; move entries here as they are fixed.
MUST_PASS="trivial alist strings"
KNOWN_RED=""

fails=0
run_one() {
  local fixture=$1
  "$BIN" compile "$FIXDIR/$fixture.yo" --warm-selfcheck >"$FIXDIR/$fixture.log" 2>&1
  echo $?
}
for f in $MUST_PASS; do
  rc=$(run_one "$f")
  if [ "$rc" -eq 0 ]; then
    echo "ok:   $f — $(grep -m1 'warm-selfcheck:' "$FIXDIR/$f.log")"
  else
    echo "FAIL: $f must pass (rc=$rc): $(grep -m1 -E 'warm-selfcheck:|error' "$FIXDIR/$f.log")"
    fails=$((fails + 1))
  fi
done
for f in $KNOWN_RED; do
  rc=$(run_one "$f")
  if [ "$rc" -ne 0 ]; then
    echo "red:  $f — known-open ($(grep -m1 -E 'warm-selfcheck:|error' "$FIXDIR/$f.log" | cut -c1-120))"
  else
    echo "FAIL: $f is listed known_red but PASSES — move it to must_pass (ratchet)"
    fails=$((fails + 1))
  fi
done

echo
if [ "$fails" -eq 0 ]; then
  echo "warm_compile_gate: OK"
  exit 0
fi
echo "warm_compile_gate: $fails failure(s)"
exit 1
