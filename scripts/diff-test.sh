#!/usr/bin/env bash
#
# diff-test.sh — golden test harness for the codegen corpus.
# See plans/archive/BOOTSTRAPPING_CODEGEN.md (Phase 0).
#
# Compiles/runs a .yo file (or every .yo under a directory) with the self-hosted
# binary (yo-self-bin) and compares BEHAVIOR against a recorded golden — stdout
# + exit code (for runnable programs) or the test-runner pass/total summary +
# exit code (for *.test.yo files).
#
# This is the `check`-equivalent for the whole codegen phase: run it after every
# porting batch. Equivalence is judged by RUN BEHAVIOR, never C-text equality.
#
# It began as a TWO-COMPILER differential against the TypeScript reference
# (`node out/cjs/yo-cli.cjs`) and the name is from that era. That compiler was
# deleted with the TypeScript `src/` (P2.5), so the goldens are now the only reference — which
# is exactly the post-retirement form the golden mode was built for while both
# arms still existed (plans/P2_5_RETIRE_EXECUTION.md step 13).
#
# ── Goldens are the reference ───────────────────────────────────────────────
# Per-file goldens live under <dir-of-file>/goldens/<basename>.golden. A golden
# pins exactly what the harness asserts: for a *.test.yo, the runner's
# pass/total summary + rc; for a runnable program, the compile rc, the run rc
# and the full stdout. Record with --record; re-record ONLY for an intended
# behavior change, in the same commit as the change that caused it. The corpus
# is run-deterministic by construction.
#
# Per-file verdicts:
#   PASS         the run matches the recorded golden
#   GOLDEN-DIFF  it does not (compile rc, run rc, summary, or stdout). A
#                self-hosted compile failure lands here too — the golden
#                records the successful compile rc it no longer produces.
#   NO-GOLDEN    the file has no golden — record it, or drop the file. A file
#                that scores nothing is indistinguishable from a passing one,
#                so this FAILS the run rather than skipping.
#   RECORDED     (--record only) the golden was written from this run
#
# Usage:
#   scripts/diff-test.sh <path> [--parallel N] [--cc clang|gcc|zig]
#                               [--release] [--filter SUBSTR] [-v]
#                               [--golden] [--record]
#
# `--golden` is accepted and ignored: golden scoring is the only mode now that
# the TS reference is gone. It is kept so existing callers keep working.
# `--cc` / `--release` are behavior-affecting for the compile-and-run files, so
# score with the same flags the goldens were recorded with.
#
# Env:
#   YO_SELF_BIN        path to the self-hosted binary (default /tmp/yo-self-bin)
#   YO_MAIN_STACK_MB   stack for the self-hosted binary (default 4096)

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || exit 2

YO_SELF_BIN="${YO_SELF_BIN:-/tmp/yo-self-bin}"
export YO_MAIN_STACK_MB="${YO_MAIN_STACK_MB:-4096}"

PARALLEL=1
CC=clang
RELEASE=""
FILTER=""
VERBOSE=0
TARGET=""
RUN_TIMEOUT=120     # seconds per compiled-program run
RECORD=0

usage() { sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallel) PARALLEL="$2"; shift 2 ;;
    --cc)       CC="$2"; shift 2 ;;
    --release)  RELEASE="--release"; shift ;;
    --filter)   FILTER="$2"; shift 2 ;;
    -v|--verbose) VERBOSE=1; shift ;;
    --golden)   shift ;;   # no-op: golden scoring is the only mode
    --record)   RECORD=1; shift ;;
    -h|--help)  usage 0 ;;
    -*)         echo "unknown flag: $1" >&2; usage 2 ;;
    *)          TARGET="$1"; shift ;;
  esac
done

[[ -z "$TARGET" ]] && { echo "error: no target path given" >&2; usage 2; }
[[ -e "$TARGET" ]] || { echo "error: target not found: $TARGET" >&2; exit 2; }
[[ -x "$YO_SELF_BIN" ]] || echo "warning: YO_SELF_BIN not found/executable: $YO_SELF_BIN (every file will GOLDEN-DIFF)" >&2

# Goldens live beside the corpus: <dir-of-file>/goldens/<basename>.golden.
golden_path() {
  local f="$1"
  printf '%s/goldens/%s.golden' "$(dirname "$f")" "$(basename "$f")"
}

# Portable timeout (macOS has no `timeout` by default).
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT=(timeout)
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT=(gtimeout)
else
  TIMEOUT=()   # no timeout available; run directly
fi
run_with_timeout() {
  local secs="$1"; shift
  if [[ ${#TIMEOUT[@]} -gt 0 ]]; then "${TIMEOUT[@]}" "$secs" "$@"; else "$@"; fi
}

strip_ansi() { sed $'s/\x1b\\[[0-9;]*m//g'; }

# Extract "<passed>/<total>" from test-runner output (ANSI already stripped).
# Falls back to "?/?" when the summary is absent (e.g. a crash before summary).
test_summary() {
  local out="$1" passed total
  passed="$(printf '%s\n' "$out" | grep -Eo '[0-9]+ passed' | head -1 | grep -Eo '[0-9]+')"
  total="$(printf '%s\n' "$out"  | grep -Eo '[0-9]+ total'  | head -1 | grep -Eo '[0-9]+')"
  printf '%s/%s' "${passed:-?}" "${total:-?}"
}

# Collect the file list. In directory mode we only consider RUNNABLE units:
# every `*.test.yo`, plus any other `.yo` that defines an entry point
# (`export(main)`). Plain module/fixture `.yo` files (helpers, circular-dep
# fixtures imported by tests) are not standalone-compilable and are skipped.
# A single explicitly-passed file is always processed as-is.
declare -a FILES=()
if [[ -d "$TARGET" ]]; then
  while IFS= read -r f; do
    if [[ "$f" == *.test.yo ]] || grep -q 'export(main)' "$f"; then FILES+=("$f"); fi
  done < <(find "$TARGET" -name '*.yo' | sort)
else
  FILES=("$TARGET")
fi

RESULT_DIR="$(mktemp -d)"
trap 'rm -rf "$RESULT_DIR"' EXIT

# ---- per-file worker -------------------------------------------------------
# Writes one line "<verdict>\t<file>\t<detail>" to $RESULT_DIR/<n>.
process_file() {
  local f="$1" slot="$2"
  local out_line verdict detail
  local work; work="$(mktemp -d)"

  local gfile head body=""
  gfile="$(golden_path "$f")"
  if [[ "$f" == *.test.yo ]]; then
    local run_out run_rc run_sum
    run_out="$("$YO_SELF_BIN" test "$f" 2>&1 | strip_ansi)"; run_rc=${PIPESTATUS[0]}
    run_sum="$(test_summary "$run_out")"
    head="mode=test rc=$run_rc summary=$run_sum"
  else
    local crc rrc=-
    "$YO_SELF_BIN" compile "$f" --c-compiler "$CC" $RELEASE -o "$work/self.out" >"$work/self.compile" 2>&1; crc=$?
    if [[ $crc -eq 0 ]]; then
      body="$(run_with_timeout "$RUN_TIMEOUT" "$work/self.out" 2>&1)"; rrc=$?
    fi
    head="mode=run compile_rc=$crc rc=$rrc"
  fi

  if [[ $RECORD -eq 1 ]]; then
    mkdir -p "$(dirname "$gfile")"
    { printf '%s\n' "$head"; [[ -n "$body" ]] && printf '%s\n' "$body"; } > "$gfile"
    verdict=RECORDED; detail="$head"
  elif [[ ! -f "$gfile" ]]; then
    verdict=NO-GOLDEN; detail="no golden — record with --record"
  else
    local exp_head exp_body got
    exp_head="$(head -1 "$gfile")"
    exp_body="$(tail -n +2 "$gfile")"
    got="$head"
    if [[ "$exp_head" != "$got" ]]; then
      verdict=GOLDEN-DIFF; detail="golden($exp_head) run($got)"
    elif [[ "$exp_body" != "$body" ]]; then
      verdict=GOLDEN-DIFF; detail="stdout differs from golden"
      if [[ $VERBOSE -eq 1 ]]; then
        diff <(printf '%s\n' "$exp_body") <(printf '%s\n' "$body") | head -20 | sed 's/^/      /' >&2
      fi
    else
      verdict=PASS; detail="$head"
    fi
  fi

  printf '%s\t%s\t%s\n' "$verdict" "$f" "$detail" > "$RESULT_DIR/$slot"
  rm -rf "$work"
  [[ $VERBOSE -eq 1 ]] && printf '  %-10s %s  (%s)\n' "$verdict" "$f" "$detail" >&2
}

# ---- scheduler (simple background-job pool) --------------------------------
slot=0
declare -a SLOT_FILES=()
for f in "${FILES[@]}"; do
  [[ -n "$FILTER" && "$f" != *"$FILTER"* ]] && continue
  SLOT_FILES[$slot]="$f"
  process_file "$f" "$slot" &
  slot=$((slot + 1))
  while [[ $(jobs -r -p | wc -l) -ge $PARALLEL ]]; do wait -n 2>/dev/null || break; done
done
wait

# ---- aggregate -------------------------------------------------------------
declare -A COUNT=( [PASS]=0 [GOLDEN-DIFF]=0 [NO-GOLDEN]=0 [RECORDED]=0 )
total=0
echo
echo "Golden scorecard"
echo "──────────────────────────────────────────────"
for i in $(seq 0 $((slot - 1))); do
  [[ -f "$RESULT_DIR/$i" ]] || continue
  IFS=$'\t' read -r verdict file detail < "$RESULT_DIR/$i"
  COUNT[$verdict]=$(( ${COUNT[$verdict]:-0} + 1 ))
  total=$((total + 1))
  if [[ "$verdict" != "PASS" || $VERBOSE -eq 1 ]]; then
    printf '  %-10s %s  (%s)\n' "$verdict" "$file" "$detail"
  fi
done
echo "──────────────────────────────────────────────"
if [[ $RECORD -eq 1 ]]; then
  printf 'RECORDED %d  (total %d)\n' "${COUNT[RECORDED]}" "$total"
else
  # Keep this line's shape: gates_fast.sh GATE 2 greps it for `GOLDEN-DIFF 0`
  # and `NO-GOLDEN 0` as defence-in-depth behind the exit code.
  printf 'PASS %d  GOLDEN-DIFF %d  NO-GOLDEN %d  (total %d)\n' \
    "${COUNT[PASS]}" "${COUNT[GOLDEN-DIFF]}" "${COUNT[NO-GOLDEN]}" "$total"
fi

# Exit non-zero on any verdict that means the compiler is wrong or broken. A
# self-hosted compile failure is a GOLDEN-DIFF (the golden records the compile
# rc it no longer produces), and NO-GOLDEN counts too: a file that scores
# nothing is indistinguishable from a passing one, so it must never be a silent
# skip. The old `--allow-self-fail` escape hatch is gone with the two-compiler
# mode it belonged to.
FAILED=$(( ${COUNT[GOLDEN-DIFF]} + ${COUNT[NO-GOLDEN]} ))
if [[ $FAILED -gt 0 ]]; then exit 1; fi
exit 0
