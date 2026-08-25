#!/bin/bash
# chunked_gate.sh — the BEHAVIORAL fixpoint gate for chunked C emission
# (plans/CHUNKED_C_EMISSION.md step 5).
#
#   S1=<a working yo binary> N=<chunks> bash scripts/bootstrap/chunked_gate.sh
#
# The bootstrap fixpoint scripts prove that the compiler's DEFAULT emission is
# stable (stage2 = stage3). They say nothing about `--emit-chunks`, because
# they never pass it. This gate closes that hole from the other side: it builds
# the compiler ONCE normally and ONCE chunked, then checks that the two
# resulting binaries emit BYTE-IDENTICAL C for the same input.
#
# That is the strongest statement available about the linkage split. A chunked
# build rewrites linkage across ~175k functions, duplicates the RC hot path and
# the constructors into every translation unit, and splits the
# address-identity statics — if any of that changed program BEHAVIOUR, the two
# compilers would disagree on some emitted byte. They do not.
#
# Cost: two full self-builds plus two self-emits (~12 min on an M4, and a lot
# of RAM). That is why this is a script you run deliberately rather than a CI
# job on every PR — `--emit-chunks` is opt-in and no default path uses it. Wire
# it in if chunking ever becomes a default (see the plan's four conditions).
set -u
cd "$(dirname "$0")/../.." || exit 2
S1=${S1:?set S1 to a working yo binary}
N=${N:-4}
P=${P:-chgate}

echo "== building the compiler normally =="
"$S1" compile src/main.yo --release -o "/tmp/${P}_single" --std-path ./std > "/tmp/${P}_single_build.log" 2>&1
echo "SINGLE_BUILD_RC=$?"

echo "== building the compiler with --emit-chunks $N =="
"$S1" compile src/main.yo --release --emit-chunks "$N" -o "/tmp/${P}_chunked" --std-path ./std > "/tmp/${P}_chunked_build.log" 2>&1
echo "CHUNKED_BUILD_RC=$?"
grep -E '^chunks: ' "/tmp/${P}_chunked_build.log" || true

for b in "/tmp/${P}_single" "/tmp/${P}_chunked"; do
  if [ ! -x "$b" ]; then echo "GATE_FAILED: $b was not built"; exit 1; fi
done

echo "== both binaries emit the compiler's own C =="
"/tmp/${P}_single" compile src/main.yo --release --skip-c-compiler \
  --emit-c-to "/tmp/${P}_emit_single.c" --std-path ./std > "/tmp/${P}_emit_single.log" 2>&1
echo "SINGLE_EMIT_RC=$?"
"/tmp/${P}_chunked" compile src/main.yo --release --skip-c-compiler \
  --emit-c-to "/tmp/${P}_emit_chunked.c" --std-path ./std > "/tmp/${P}_emit_chunked.log" 2>&1
echo "CHUNKED_EMIT_RC=$?"

# A "Failed to transpile" marker in either emission would make a byte-identical
# comparison vacuous — both could be equally hollow.
for f in "/tmp/${P}_emit_single.c" "/tmp/${P}_emit_chunked.c"; do
  # Same detector as fixpoint_only.sh — anchoring to start-of-line misses the
  # `return // Failed to transpile x;` and `__yo_tN tmp = // ...` forms.
  echo "$(basename "$f") hollow=$(bash scripts/count-transpile-failures.sh "$f" | cut -d' ' -f1)"
done

if cmp -s "/tmp/${P}_emit_single.c" "/tmp/${P}_emit_chunked.c"; then
  echo "BEHAVIORAL_FIXPOINT_HOLDS: chunked-built and single-file-built compilers emit byte-identical C"
  exit 0
fi
echo "BEHAVIORAL_FIXPOINT_BROKEN: the two compilers disagree"
cmp "/tmp/${P}_emit_single.c" "/tmp/${P}_emit_chunked.c" | head -3
exit 1
