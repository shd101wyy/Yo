#!/usr/bin/env bash
# Gate G6 on one release target (plans/backlog/DEFAULT_ON_VERIFICATION.md §4):
# the solver the installer fetches runs wherever `yo` runs, and a build with no
# solver, or with one that cannot run, passes with exactly one line.
#
#   bash scripts/solver-smoke.sh <yo-binary> <solver-archive.tar.gz>
#
#   1. the archive, unpacked the way scripts/install.sh unpacks it (into
#      `<cache>/solvers/`), is found with no YO_Z3_PATH and proves an obligation;
#   2. with an empty cache, `check` of two verify+ files and `compile` of one
#      pass and print exactly one `verify:` line;
#   3. a YO_Z3_PATH that cannot run is the same case: one line, passes;
#   4. `--require-solver` and YO_REQUIRE_SOLVER=1 make the missing solver an error.
#
# `yo` finds its std by walking up from its executable, or through YO_STD.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <yo-binary> <solver-archive.tar.gz>" >&2
  exit 2
fi
abs() { (cd "$(dirname "$1")" && printf '%s/%s\n' "$(pwd)" "$(basename "$1")"); }
YO=$(abs "$1")
ARCHIVE=$(abs "$2")
WORK=$(mktemp -d 2>/dev/null || mktemp -d -t solversmoke)
trap 'rm -rf "$WORK"' EXIT
# Native Windows programs need `C:/...` paths, not MSYS ones.
if command -v cygpath > /dev/null 2>&1; then
  WORK=$(cygpath -m "$WORK")
  YO=$(cygpath -m "$YO")
fi
cd "$WORK"
unset YO_Z3_PATH YO_REQUIRE_SOLVER
fail() {
  echo "solver-smoke: FAIL: $*" >&2
  exit 1
}
# The `verify:` lines of a log.
verify_lines() { tr -d '\r' < "$1" | grep -c '^verify: ' || true; }

cat > proved.yo <<'EOF'
pragma(Pragma.Verify);

next_below :: (fn(x : i32, requires((x >= i32(0)) && (x < i32(100))), ensures(r > x)) -> (r : i32))(
  x + i32(1)
);
EOF
for f in plus_a plus_b; do
  cat > "$f.yo" <<'EOF'
pragma(Pragma.VerifyOrAssert);

halve :: (fn(a : i32, requires(a >= i32(0)), ensures(r <= a)) -> (r : i32))(
  a / i32(2)
);

main :: (fn() -> unit)({
  _ := halve(i32(10));
});
export(main);
EOF
done

# 1. The installed solver proves.
mkdir -p with-solver/solvers empty-cache
tar -xzf "$ARCHIVE" -C with-solver/solvers
YO_CACHE_DIR="$WORK/with-solver" "$YO" verify proved.yo --no-cache > verify.log 2>&1 || {
  cat verify.log
  fail "yo verify did not prove proved.yo with the installed solver"
}
cat verify.log
tr -d '\r' < verify.log | grep -q "^verify: solver: $WORK/with-solver/solvers/" \
  || fail "yo verify did not use the solver unpacked into the cache"
tr -d '\r' < verify.log | grep -qE '^verify: 1 ok, .* 0 refuted, 0 solver-error' \
  || fail "the summary is not one proved function"
YO_CACHE_DIR="$WORK/with-solver" "$YO" compile proved.yo --skip-c-compiler -o proved > compile-proved.log 2>&1 || {
  cat compile-proved.log
  fail "a verify-mode compile failed with the installed solver"
}

# 2. No solver: passes, one line for the whole run.
YO_CACHE_DIR="$WORK/empty-cache" "$YO" check plus_a.yo plus_b.yo > nosolver-check.log 2>&1 || {
  cat nosolver-check.log
  fail "check of verify+ files failed without a solver"
}
cat nosolver-check.log
[ "$(verify_lines nosolver-check.log)" = 1 ] || fail "check of two files without a solver printed $(verify_lines nosolver-check.log) verify: lines, not 1"
tr -d '\r' < nosolver-check.log | grep -q '^verify: no Z3 solver found' || fail "the line does not say the solver is missing"
YO_CACHE_DIR="$WORK/empty-cache" "$YO" compile plus_a.yo --skip-c-compiler -o plus_a > nosolver-compile.log 2>&1 || {
  cat nosolver-compile.log
  fail "compile of a verify+ file failed without a solver"
}
[ "$(verify_lines nosolver-compile.log)" = 1 ] || fail "compile without a solver printed $(verify_lines nosolver-compile.log) verify: lines, not 1"

# 3. A solver that cannot run: the same case.
printf 'not a solver\n' > broken-z3
chmod +x broken-z3 2>/dev/null || true
YO_CACHE_DIR="$WORK/empty-cache" YO_Z3_PATH="$WORK/broken-z3" "$YO" check plus_a.yo plus_b.yo > broken.log 2>&1 || {
  cat broken.log
  fail "check of verify+ files failed with a solver that cannot run"
}
cat broken.log
[ "$(verify_lines broken.log)" = 1 ] || fail "a solver that cannot run printed $(verify_lines broken.log) verify: lines, not 1"
tr -d '\r' < broken.log | grep -q "^verify: the Z3 solver at '$WORK/broken-z3' cannot run" || fail "the line does not say the solver cannot run"

# 4. --require-solver / YO_REQUIRE_SOLVER=1: an error.
if YO_CACHE_DIR="$WORK/empty-cache" "$YO" check plus_a.yo --require-solver > required.log 2>&1; then
  cat required.log
  fail "--require-solver passed without a solver"
fi
tr -d '\r' < required.log | grep -q '^verify: error: no Z3 solver found' || { cat required.log; fail "--require-solver did not say why it failed"; }
if YO_CACHE_DIR="$WORK/empty-cache" YO_REQUIRE_SOLVER=1 "$YO" compile plus_a.yo --skip-c-compiler -o plus_a > required-env.log 2>&1; then
  cat required-env.log
  fail "YO_REQUIRE_SOLVER=1 passed without a solver"
fi

echo "solver-smoke: OK ($(tr -d '\r' < verify.log | grep '^verify: solver:'))"
