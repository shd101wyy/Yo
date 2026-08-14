#!/usr/bin/env bash
#
# diff-test.sh — differential test harness for the codegen bootstrap.
# See plans/archive/BOOTSTRAPPING_CODEGEN.md (Phase 0).
#
# Compiles/runs a .yo file (or every .yo under a directory) with BOTH compilers:
#   * the TypeScript reference compiler  (node out/cjs/yo-cli.cjs)
#   * the self-hosted binary             (yo-self-bin)
# then compares BEHAVIOR — stdout + exit code (for runnable programs) or the
# test-runner pass/total summary + exit code (for *.test.yo files).
#
# This is the `check`-equivalent for the whole codegen phase: run it after every
# porting batch. Equivalence is judged by RUN BEHAVIOR, never C-text equality.
#
# Per-file verdicts:
#   PASS       both compiled+ran and behavior matched
#   DIFF       both compiled+ran but stdout / exit-code / test-summary differ
#   SELF-FAIL  the self-hosted compiler failed to compile/run (TS succeeded)
#              — fails the harness; pass --allow-self-fail for a mid-port sweep
#   TS-FAIL    the TS reference compiler failed (flags a broken test/baseline)
#   BOTH-FAIL  both compilers failed (e.g. the circular_error_{a,b} baseline)
#
# ── Golden mode (the TS arm is optional) ────────────────────────────────────
# When `out/cjs/yo-cli.cjs` is missing — or `--golden` is passed — the harness
# scores the self-hosted arm against per-file goldens under
# <target>/goldens/<file>.golden instead of against the TS reference
# (plans/P2_5_RETIRE_EXECUTION.md step 13). A golden pins exactly what the
# differential asserts: for a *.test.yo, the runner's pass/total summary + rc;
# for a runnable program, the compile rc, the run rc and the full stdout.
# Record with --record (self arm). A file with no golden is NO-GOLDEN and
# fails the run. Golden-mode verdicts: PASS / GOLDEN-DIFF / NO-GOLDEN.
#
# Usage:
#   scripts/diff-test.sh <path> [--parallel N] [--cc clang|gcc|zig]
#                               [--release] [--filter SUBSTR] [-v]
#                               [--allow-self-fail] [--golden] [--record]
#
# Env:
#   YO_SELF_BIN        path to the self-hosted binary (default /tmp/yo-self-bin)
#   YO_MAIN_STACK_MB   stack for the self-hosted binary (default 4096)

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || exit 2

YO_SELF_BIN="${YO_SELF_BIN:-/tmp/yo-self-bin}"
export YO_MAIN_STACK_MB="${YO_MAIN_STACK_MB:-4096}"
TS_CLI=(node "$REPO_ROOT/out/cjs/yo-cli.cjs")

PARALLEL=1
CC=clang
RELEASE=""
FILTER=""
VERBOSE=0
TARGET=""
ALLOW_SELF_FAIL=0   # 1 = tolerate SELF-FAIL/BOTH-FAIL (mid-port sweeps only)
RUN_TIMEOUT=120     # seconds per compiled-program run
MODE=diff           # diff | golden
RECORD=0

usage() { sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallel) PARALLEL="$2"; shift 2 ;;
    --cc)       CC="$2"; shift 2 ;;
    --release)  RELEASE="--release"; shift ;;
    --filter)   FILTER="$2"; shift 2 ;;
    -v|--verbose) VERBOSE=1; shift ;;
    --allow-self-fail) ALLOW_SELF_FAIL=1; shift ;;
    --golden)   MODE=golden; shift ;;
    --record)   RECORD=1; shift ;;
    -h|--help)  usage 0 ;;
    -*)         echo "unknown flag: $1" >&2; usage 2 ;;
    *)          TARGET="$1"; shift ;;
  esac
done

[[ -z "$TARGET" ]] && { echo "error: no target path given" >&2; usage 2; }
[[ -e "$TARGET" ]] || { echo "error: target not found: $TARGET" >&2; exit 2; }
[[ -x "$YO_SELF_BIN" ]] || echo "warning: YO_SELF_BIN not found/executable: $YO_SELF_BIN (self side will all SELF-FAIL)" >&2
# The TS arm is optional: without it the harness scores the self arm against
# the recorded goldens instead of failing every file (what outlives src/).
if [[ "$MODE" == "diff" && $RECORD -eq 0 && ! -f "$REPO_ROOT/out/cjs/yo-cli.cjs" ]]; then
  echo "note: out/cjs/yo-cli.cjs missing — no TS arm, falling back to golden mode" >&2
  MODE=golden
fi

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

  # ── golden mode / recording: the self arm only ─────────────────────────────
  if [[ $RECORD -eq 1 || "$MODE" == "golden" ]]; then
    local gfile head body=""
    gfile="$(golden_path "$f")"
    if [[ "$f" == *.test.yo ]]; then
      local self_out self_rc self_sum
      self_out="$("$YO_SELF_BIN" test "$f" 2>&1 | strip_ansi)"; self_rc=${PIPESTATUS[0]}
      self_sum="$(test_summary "$self_out")"
      head="mode=test rc=$self_rc summary=$self_sum"
    else
      local self_crc self_rrc=-
      "$YO_SELF_BIN" compile "$f" --c-compiler "$CC" $RELEASE -o "$work/self.out" >"$work/self.compile" 2>&1; self_crc=$?
      if [[ $self_crc -eq 0 ]]; then
        body="$(run_with_timeout "$RUN_TIMEOUT" "$work/self.out" 2>&1)"; self_rrc=$?
      fi
      head="mode=run compile_rc=$self_crc rc=$self_rrc"
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
        verdict=GOLDEN-DIFF; detail="golden($exp_head) self($got)"
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
    return
  fi

  if [[ "$f" == *.test.yo ]]; then
    # ---- test mode -----------------------------------------------------
    local ts_out ts_rc self_out self_rc ts_sum self_sum
    ts_out="$("${TS_CLI[@]}" test "$f" --parallel 1 --c-compiler "$CC" $RELEASE 2>&1 | strip_ansi)"; ts_rc=${PIPESTATUS[0]}
    if [[ -x "$YO_SELF_BIN" ]]; then
      self_out="$("$YO_SELF_BIN" test "$f" 2>&1 | strip_ansi)"; self_rc=${PIPESTATUS[0]}
    else
      self_out=""; self_rc=127
    fi
    ts_sum="$(test_summary "$ts_out")"
    self_sum="$(test_summary "$self_out")"
    local ts_ok=0 self_ok=0
    [[ $ts_rc -eq 0 ]] && ts_ok=1
    [[ $self_rc -eq 0 ]] && self_ok=1
    if [[ $ts_ok -eq 1 && $self_ok -eq 1 ]]; then
      if [[ "$ts_sum" == "$self_sum" ]]; then verdict=PASS; else verdict=DIFF; fi
      detail="ts=$ts_sum self=$self_sum"
    elif [[ $ts_ok -eq 0 && $self_ok -eq 0 ]]; then
      verdict=BOTH-FAIL; detail="ts_rc=$ts_rc self_rc=$self_rc"
    elif [[ $self_ok -eq 0 ]]; then
      verdict=SELF-FAIL; detail="ts=$ts_sum(rc0) self_rc=$self_rc"
    else
      verdict=TS-FAIL;   detail="ts_rc=$ts_rc self=$self_sum(rc0)"
    fi
  else
    # ---- compile-and-run mode -----------------------------------------
    local ts_crc self_crc
    "${TS_CLI[@]}" compile "$f" --c-compiler "$CC" $RELEASE -o "$work/ts.out" >"$work/ts.compile" 2>&1; ts_crc=$?
    if [[ -x "$YO_SELF_BIN" ]]; then
      "$YO_SELF_BIN" compile "$f" --c-compiler "$CC" $RELEASE -o "$work/self.out" >"$work/self.compile" 2>&1; self_crc=$?
    else
      self_crc=127
    fi
    if [[ $ts_crc -ne 0 && $self_crc -ne 0 ]]; then
      verdict=BOTH-FAIL; detail="ts/self compile failed"
    elif [[ $ts_crc -ne 0 ]]; then
      verdict=TS-FAIL; detail="ts compile failed"
    elif [[ $self_crc -ne 0 ]]; then
      verdict=SELF-FAIL; detail="self compile failed"
    else
      local ts_run ts_rrc self_run self_rrc
      ts_run="$(run_with_timeout "$RUN_TIMEOUT" "$work/ts.out" 2>&1)"; ts_rrc=$?
      self_run="$(run_with_timeout "$RUN_TIMEOUT" "$work/self.out" 2>&1)"; self_rrc=$?
      if [[ "$ts_run" == "$self_run" && $ts_rrc -eq $self_rrc ]]; then
        verdict=PASS; detail="rc=$ts_rrc"
      else
        verdict=DIFF; detail="ts_rc=$ts_rrc self_rc=$self_rrc"
      fi
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
declare -A COUNT=( [PASS]=0 [DIFF]=0 [SELF-FAIL]=0 [TS-FAIL]=0 [BOTH-FAIL]=0
                   [GOLDEN-DIFF]=0 [NO-GOLDEN]=0 [RECORDED]=0 )
total=0
echo
echo "Differential scorecard"
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
elif [[ "$MODE" == "golden" ]]; then
  printf 'PASS %d  GOLDEN-DIFF %d  NO-GOLDEN %d  (total %d)\n' \
    "${COUNT[PASS]}" "${COUNT[GOLDEN-DIFF]}" "${COUNT[NO-GOLDEN]}" "$total"
else
  printf 'PASS %d  DIFF %d  SELF-FAIL %d  TS-FAIL %d  BOTH-FAIL %d  (total %d)\n' \
    "${COUNT[PASS]}" "${COUNT[DIFF]}" "${COUNT[SELF-FAIL]}" "${COUNT[TS-FAIL]}" "${COUNT[BOTH-FAIL]}" "$total"
fi

# Exit non-zero on any verdict that means the self-hosted compiler is wrong or
# broken. SELF-FAIL/BOTH-FAIL used to be tolerated here ("expected during the
# port") — that stopped being true when the bootstrap completed, and the silent
# exit-0 meant any caller other than gates_fast.sh (which greps the scorecard
# line for `SELF-FAIL 0`) would go GREEN over a compiler that cannot compile the
# corpus at all. Pass --allow-self-fail to restore the old behavior for a
# genuine mid-port sweep.
FAILED=$(( ${COUNT[DIFF]} + ${COUNT[TS-FAIL]} + ${COUNT[GOLDEN-DIFF]} + ${COUNT[NO-GOLDEN]} ))
if [[ $ALLOW_SELF_FAIL -eq 0 ]]; then
  FAILED=$(( FAILED + ${COUNT[SELF-FAIL]} + ${COUNT[BOTH-FAIL]} ))
elif [[ ${COUNT[SELF-FAIL]} -gt 0 || ${COUNT[BOTH-FAIL]} -gt 0 ]]; then
  echo "note: --allow-self-fail tolerated ${COUNT[SELF-FAIL]} SELF-FAIL + ${COUNT[BOTH-FAIL]} BOTH-FAIL"
fi
if [[ $FAILED -gt 0 ]]; then exit 1; fi
exit 0
