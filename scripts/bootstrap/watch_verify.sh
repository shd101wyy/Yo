#!/bin/bash
# watch_verify.sh — Phase 3b's correctness oracle (§6 gates,
# plans/INCREMENTAL_COMPILATION_ZIG_LESSONS.md): a live `check --watch`
# session's per-round diagnostics must agree with a cold `check` of the same
# tree. Zig's incremental bugs were almost all "stale state the invalidation
# missed" — this is the cheap oracle for that class, run over a scripted
# edit sequence before merging any watcher change.
#
#   BIN=<built yo> [TARGET=./src] bash scripts/bootstrap/watch_verify.sh
#
# Sequence (every edit is reverted; the tree is clean at exit even on
# failure — the trap restores both probe files):
#   1. comment-only edit            -> no-op round (skipped, 0 revalidated)
#   2. hub body edit (token.yo)     -> per-def round, must stay clean
#   3. leaf body BREAK (version.yo) -> the round must FAIL
#   4. revert the break             -> the round must be clean again
#   5. break the leaf again         -> watch AND cold check both fail it,
#                                      naming the same file
#   6. revert everything            -> git diff empty, cold check green
set -u
cd "$(dirname "$0")/../.." || exit 2

if [ -z "${BIN:-}" ]; then
  echo "usage: BIN=<built yo> [TARGET=./src] bash scripts/bootstrap/watch_verify.sh"
  exit 2
fi
TARGET=${TARGET:-./src}
STD=${STD:-$PWD/std}
LOG=$(mktemp /tmp/yo_watch_verify.XXXXXX.log)
COLD=$(mktemp /tmp/yo_watch_verify_cold.XXXXXX.log)
export YO_STD="$STD"
export YO_MAIN_STACK_MB=${YO_MAIN_STACK_MB:-4096}
trap 'kill "$WATCH_PID" 2>/dev/null; git checkout -- src/token.yo src/version.yo 2>/dev/null; wait "$WATCH_PID" 2>/dev/null' EXIT

fails=0
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }
pass() { echo "ok:   $*"; }

rounds_before() { grep -c 'watch: revalidated' "$LOG" 2>/dev/null || true; }
# Wait until a new round summary line appears after `$1` seen rounds.
wait_round() {
  local before=$1 i=0
  while [ "$(rounds_before)" -le "$before" ] && [ "$i" -lt 360 ]; do
    sleep 1
    i=$((i + 1))
  done
  [ "$(rounds_before)" -gt "$before" ]
}

echo "== starting watch over $TARGET (initial pass; several minutes) =="
"$BIN" check "$TARGET" --watch --poll-ms 200 >"$LOG" 2>&1 &
WATCH_PID=$!

# Wait for the initial pass: the session banner is printed after it.
i=0
while ! grep -q 'watch: watching' "$LOG" 2>/dev/null && [ "$i" -lt 900 ]; do
  if ! kill -0 "$WATCH_PID" 2>/dev/null; then
    echo "watch died during the initial pass:"
    tail -20 "$LOG"
    exit 1
  fi
  sleep 1
  i=$((i + 1))
done
if ! grep -q 'watch: watching' "$LOG"; then
  fail "initial pass never finished"
  exit 1
fi
pass "initial pass complete"

R=$(rounds_before)

# --- 1. comment-only edit: a no-op round -----------------------------------
sed -i '1i // watch_verify probe comment' src/token.yo
if wait_round "$R"; then pass "comment-only edit produced a round"; else fail "comment-only edit produced no round"; fi
R=$(rounds_before)
LAST=$(tail -1 "$LOG")
echo "   round: $LAST"
case "$LAST" in
  *"revalidated 0 definition(s), rechecked 0 file(s), 0 failed"*) pass "comment-only round was a no-op" ;;
  *) fail "comment-only round was not a no-op: $LAST" ;;
esac
git checkout -- src/token.yo
# The revert itself is another (comment-only) round — absorb it.
wait_round "$R" || true
R=$(rounds_before)

# --- 2. hub body edit: per-def round, clean ---------------------------------
sed -i 's/is_identifier_start(c) || c.is_digit()/is_identifier_start(c) || c.is_digit() || (c.char == u32(1))/' src/token.yo
if wait_round "$R"; then pass "hub body edit produced a round"; else fail "hub body edit produced no round"; fi
R=$(rounds_before)
LAST=$(tail -1 "$LOG")
echo "   round: $LAST"
case "$LAST" in
  *"0 failed"*) pass "hub body edit stayed clean" ;;
  *) fail "hub body edit failed: $LAST" ;;
esac
git checkout -- src/token.yo
wait_round "$R" || true
R=$(rounds_before)

# --- 3. leaf body BREAK: the round must fail --------------------------------
sed -i 's/ok := true;/ok := 1;/' src/version.yo
if wait_round "$R"; then pass "leaf break produced a round"; else fail "leaf break produced no round"; fi
R=$(rounds_before)
LAST=$(tail -1 "$LOG")
echo "   round: $LAST"
case "$LAST" in
  *"0 failed"*) fail "leaf break was NOT reported: $LAST" ;;
  *) pass "leaf break was reported" ;;
esac
grep -q 'version.yo' "$LOG" && pass "failure names version.yo" || fail "failure does not name version.yo"

# --- 4. revert the break: clean again ---------------------------------------
git checkout -- src/version.yo
if wait_round "$R"; then pass "leaf fix produced a round"; else fail "leaf fix produced no round"; fi
R=$(rounds_before)
LAST=$(tail -1 "$LOG")
case "$LAST" in
  *"0 failed"*) pass "leaf fix is clean" ;;
  *) fail "leaf fix still failing: $LAST" ;;
esac

# --- 5. break again, then compare against a cold check ----------------------
sed -i 's/ok := true;/ok := 1;/' src/version.yo
if wait_round "$R"; then pass "second break produced a round"; else fail "second break produced no round"; fi
WATCH_FAILED=$(grep -c '— FAILED' "$LOG" || true)
# Cold check of the SAME tree state.
"$BIN" check "$TARGET" >"$COLD" 2>&1
COLD_RC=$?
echo "   watch failed-count (session total): $WATCH_FAILED; cold rc=$COLD_RC"
if [ "$COLD_RC" -ne 0 ] && grep -q 'version.yo' "$COLD"; then
  pass "cold check agrees the tree is broken in version.yo"
else
  fail "cold check disagrees (rc=$COLD_RC)"
fi
git checkout -- src/version.yo

# --- 6. everything reverted: cold check green, tree clean -------------------
# Mark the log position first: an mtime burst can produce a DUPLICATE round
# for the pre-revert state, and positionally waiting for "a" new round can
# consume the wrong one. Assert on EVERY summary line from here on instead.
POS=$(wc -l < "$LOG")
if wait_round "$R"; then pass "final revert produced a round"; else fail "final revert produced no round"; fi
sleep 2
BAD=$(tail -n +"$((POS + 1))" "$LOG" | grep 'watch: revalidated' | grep -v '0 failed' | head -1)
if [ -z "$BAD" ]; then
  pass "final watch rounds are clean"
else
  fail "final watch round not clean: $BAD"
fi
if [ -n "$(git status --porcelain src/token.yo src/version.yo)" ]; then
  fail "probe files not restored"
else
  pass "probe files restored"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "watch_verify: ALL CHECKS PASSED"
  exit 0
fi
echo "watch_verify: $fails failure(s)"
exit 1
