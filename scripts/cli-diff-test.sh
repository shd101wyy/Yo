#!/usr/bin/env bash
#
# cli-diff-test.sh — golden test harness for CLI SUBCOMMANDS.
# See plans/P1_CLI_PARITY.md §1.
#
# `scripts/diff-test.sh` compares stdout + exit code, which is the right verdict
# for a compiled program. It is useless for `init`/`fetch`/`install`/`cache`/
# `build`/`doc`, whose real output is a DIRECTORY TREE, a cache mutation, or an
# artifact set. This harness runs the subcommand in an isolated sandbox and
# scores the trees as well as stdout+rc against per-case recorded goldens.
#
# It began as a TWO-COMPILER differential (self-hosted vs the TypeScript
# reference) and the name is from that era. The TS compiler was deleted with
# `src/` (P2.5), so goldens are now the only reference — which is exactly the
# post-retirement form the golden mode was built for while both arms still
# existed (plans/P2_5_RETIRE_EXECUTION.md step 12).
#
# Why it exists: in this codebase "ported" can mean "type-checks and is
# unreachable", and `check` cannot tell those apart. `init_project` was 239
# complete, type-checking lines wired to no subcommand; the first time it ran it
# returned rc=139 where the reference returned rc=0.
#
# ── Case layout ────────────────────────────────────────────────────────────
#   tests/cli-cases/<name>/
#     cmd        REQUIRED. One command per line; each line is a shell-quoted
#                argv appended to the compiler binary, run in the sandbox
#                project dir. `#` comments and blank lines are ignored.
#     fixture/   OPTIONAL. Copied into the sandbox project dir before running.
#                Files named `*.fixture` are copied with that suffix STRIPPED
#                (`messy.yo.fixture` → `messy.yo`) — for fixtures that must be
#                misformatted `.yo` (the fmt cases), which may not live in the
#                repo as `.yo` or the repo-tree `fmt --check` gate would flag
#                them (same convention as formatter_fixtures/*.input).
#     ignore     OPTIONAL. One path glob per line; matching paths are dropped
#                from the tree comparison (globs match the `./`-prefixed
#                relative path, e.g. `./yo-out/*`).
#     opts       OPTIONAL. KEY=VALUE lines:
#                  stdout=strict|ignore   (default strict)
#                  stdout_keep=<ERE>      keep ONLY stdout lines matching this
#                                         extended regex before comparing. For
#                                         cases whose output legitimately cannot
#                                         match line-for-line — `build run` shells
#                                         out to a compile, and the two compilers
#                                         emit different (equivalent) C, so clang's
#                                         diagnostics carry different line numbers.
#                                         Prefer this over stdout=ignore: it keeps
#                                         asserting the output that IS comparable
#                                         (the built program's own stdout, the
#                                         build summary) instead of discarding all
#                                         of it.
#                  stdout_keep_match=<ERE> keep ONLY the matched SUBSTRING of
#                                         matching stdout lines (grep -oE).
#                                         For pinning the DIAGNOSTIC inside a
#                                         wrapper line whose remainder is
#                                         environment-specific: a case then
#                                         stops passing on ANY failure and
#                                         starts asserting THE failure. A
#                                         pattern that matches nothing is
#                                         vacuous and fails the case.
#                  network=1              (skipped unless --network is passed)
#                  timeout=<seconds>      (default 300, per command)
#                  env=K=V                extra environment for the run (one
#                                         per line, repeatable). `<PROJ>` and
#                                         `<HOME>` in the value expand to the
#                                         sandbox paths — needed for
#                                         cache-precedence / std-resolution
#                                         cases whose whole point is the env.
#     expected_rc          REQUIRED to score. Golden files recorded via
#     expected_stdout      --record. expected_stdout is absent for
#     expected_tree        stdout=ignore cases; expected_tree /
#     expected_home_tree   expected_home_tree are `snapshot_tree` manifests.
#
# The run gets its own HOME, so `~/.cache/yo` mutations are part of what is
# scored rather than leaking into the user's real cache. Both the project tree
# and the HOME tree are compared.
#
# ── Goldens are the reference ───────────────────────────────────────────────
# The harness runs the case under $YO_SELF_BIN and compares rc, normalized
# stdout, the project tree and the HOME tree against the case's recorded golden
# files. The harness injects YO_STD, so the environment is explicit rather than
# inherited. A case with no recorded goldens is a failure (NO-GOLDEN), not a
# skip — a silently unscored case is indistinguishable from a passing one.
#
# Re-record ONLY for an intended behavior change, and review the golden diff in
# the same commit as the change that caused it: that diff is the review surface.
#
#   scripts/cli-diff-test.sh [case ...]            # score against goldens
#   scripts/cli-diff-test.sh --record [case ...]   # (re)record the goldens
#
# ── Per-case verdicts (same vocabulary as scripts/diff-test.sh) ─────────────
#   PASS         the run matches the recorded goldens
#   GOLDEN-DIFF  it does not (rc, stdout, project tree, or HOME tree)
#   NO-GOLDEN    the case has no expected_rc — record it or fix the case
#   RECORDED     (--record only) goldens written from this run
#   SKIP         case declared network=1 and --network was not passed
#
# Usage:
#   scripts/cli-diff-test.sh [case ...] [--cases-dir DIR] [--filter SUBSTR]
#                            [--network] [--keep] [-v] [--golden] [--record]
#
# `--golden` is accepted and ignored: golden scoring is the only mode now that
# the TS reference is gone. It is kept so existing callers keep working.
#
# With no case arguments every case under --cases-dir (default
# tests/cli-cases) runs.
#
# Env:
#   YO_SELF_BIN        path to the self-hosted binary (default /tmp/yo-self-bin)
#   YO_MAIN_STACK_MB   stack for the self-hosted binary (default 4096)
#
# EXIT: 0 only if every non-SKIP case is PASS.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || exit 2

YO_SELF_BIN="${YO_SELF_BIN:-/tmp/yo-self-bin}"
export YO_MAIN_STACK_MB="${YO_MAIN_STACK_MB:-4096}"

CASES_DIR="tests/cli-cases"
FILTER=""
VERBOSE=0
NETWORK=0
KEEP=0
RECORD=0
declare -a WANTED=()

usage() { sed -n '2,111p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cases-dir) CASES_DIR="$2"; shift 2 ;;
    --filter)    FILTER="$2"; shift 2 ;;
    --network)   NETWORK=1; shift ;;
    --keep)      KEEP=1; shift ;;
    --golden)    shift ;;   # no-op: golden scoring is the only mode
    --record)    RECORD=1; shift ;;
    -v|--verbose) VERBOSE=1; shift ;;
    -h|--help)   usage 0 ;;
    -*)          echo "unknown flag: $1" >&2; usage 2 ;;
    *)           WANTED+=("$1"); shift ;;
  esac
done

[[ -d "$CASES_DIR" ]] || { echo "error: cases dir not found: $CASES_DIR" >&2; exit 2; }
[[ -x "$YO_SELF_BIN" ]] || echo "warning: YO_SELF_BIN not found/executable: $YO_SELF_BIN (every case will GOLDEN-DIFF)" >&2

# Portable timeout (macOS ships none by default).
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN=(timeout)
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN=(gtimeout)
else TIMEOUT_BIN=(); fi
run_with_timeout() {
  local secs="$1"; shift
  if [[ ${#TIMEOUT_BIN[@]} -gt 0 ]]; then "${TIMEOUT_BIN[@]}" "$secs" "$@"; else "$@"; fi
}

# Artifacts that are legitimately allowed to differ byte-for-byte between runs
# (emitted C, object files, linked binaries) or that are pure noise. A case may
# add more via its own `ignore` file. Kept deliberately short: a too-broad
# default here is how a tree comparison goes quietly hollow.
DEFAULT_IGNORES=(
  './yo-out/*' '*/yo-out/*'
  '*.o' '*.a' '*.dylib' '*.so' '*.out' '*.bin'
  '*.yo.c' '*.bin.c'
  './.DS_Store' '*/.DS_Store'
)

strip_ansi() { sed $'s/\x1b\\[[0-9;]*m//g'; }

# Rewrite everything environment-specific out of a captured stream so a run is
# comparable to a golden recorded on another machine: sandbox roots, the repo
# root, wall-clock durations and byte counts. Order matters — the sandbox paths
# are longest and must go first.
# $1 = project dir, $2 = home dir
normalize_stream() {
  local proj="$1" home="$2"
  strip_ansi \
    | sed -e "s|$proj|<PROJ>|g" \
          -e "s|$home|<HOME>|g" \
          -e "s|$REPO_ROOT|<REPO>|g" \
    | sed -E -e 's/[0-9]+(\.[0-9]+)?[[:space:]]*(ms|s\b|seconds)/<TIME>/g' \
             -e 's/\b[0-9a-f]{40}\b/<SHA1>/g' \
             -e 's/\b[0-9a-f]{64}\b/<SHA256>/g' \
             -e 's/\b(aarch64|arm64|x86_64|i686)-(apple-|unknown-|pc-)?(macos|darwin|linux-gnu|linux-musl|windows-msvc|windows-gnu|windows)\b/<TARGET>/g'
}

# Emit "<relpath>\t<sha>" for every regular file under $1, skipping ignored
# paths. Symlinks are recorded by their target rather than followed.
# $1 = root, $2 = newline-separated extra ignore globs
snapshot_tree() {
  local root="$1" extra="$2"
  [[ -d "$root" ]] || return 0
  local -a globs=("${DEFAULT_IGNORES[@]}")
  while IFS= read -r g; do
    [[ -z "$g" || "$g" == \#* ]] && continue
    globs+=("$g")
  done <<< "$extra"

  ( cd "$root" || return 0
    find . \( -type f -o -type l \) 2>/dev/null | LC_ALL=C sort | while IFS= read -r p; do
      local skip=0 g
      for g in "${globs[@]}"; do
        # shellcheck disable=SC2053
        [[ "$p" == $g ]] && { skip=1; break; }
      done
      [[ $skip -eq 1 ]] && continue
      if [[ -L "$p" ]]; then
        printf '%s\tsymlink:%s\n' "$p" "$(readlink "$p")"
      else
        printf '%s\t%s\n' "$p" "$(shasum -a 256 "$p" 2>/dev/null | cut -d' ' -f1)"
      fi
    done
  )
}

# Show WHY the tree differs from its golden: which paths are one-sided, and
# which differ in content. The golden side has no live root, so content
# mismatches are reported by path only (the recorded hash is all we kept).
# $1 = golden manifest, $2 = this run's manifest.
explain_golden_tree_diff() {
  local m_gold="$1" m_self="$2"
  [[ -f "$m_gold" ]] || { echo "    (no recorded golden manifest)"; return; }
  diff <(cut -f1 "$m_gold") <(cut -f1 "$m_self") | sed -n 's/^< /    only-in-golden: /p;s/^> /    only-in-self:   /p'
  local p sha_gold sha_self
  while IFS=$'\t' read -r p sha_gold; do
    sha_self="$(grep -F -m1 "$(printf '%s\t' "$p")" "$m_self" | cut -f2)"
    [[ -z "$sha_self" || "$sha_gold" == "$sha_self" ]] && continue
    echo "    content-differs (vs recorded golden hash): $p"
  done < "$m_gold"
}

# Apply the case's stdout filters to $1 in place: stdout_keep keeps matching
# LINES, stdout_keep_match keeps only the matched SUBSTRINGS (grep -oE).
apply_stdout_filters() {
  local f="$1"
  if [[ -n "$stdout_keep" ]]; then
    grep -E "$stdout_keep" "$f" > "$f.kept" || true
    mv "$f.kept" "$f"
  fi
  if [[ -n "$stdout_keep_match" ]]; then
    grep -oE "$stdout_keep_match" "$f" > "$f.kept" || true
    mv "$f.kept" "$f"
  fi
}

# Read `KEY=VALUE` from a case's opts file. $1 = case dir, $2 = key, $3 = default
opt() {
  local f="$1/opts" k="$2" d="$3" v
  [[ -f "$f" ]] || { printf '%s' "$d"; return; }
  v="$(grep -E "^${k}=" "$f" | tail -1 | cut -d= -f2-)"
  printf '%s' "${v:-$d}"
}

# ── collect cases ───────────────────────────────────────────────────────────
declare -a CASES=()
if [[ ${#WANTED[@]} -gt 0 ]]; then
  for w in "${WANTED[@]}"; do
    if [[ -d "$w" ]]; then CASES+=("$w")
    elif [[ -d "$CASES_DIR/$w" ]]; then CASES+=("$CASES_DIR/$w")
    else echo "error: no such case: $w" >&2; exit 2; fi
  done
else
  while IFS= read -r d; do
    [[ -f "$d/cmd" ]] && CASES+=("$d")
  done < <(find "$CASES_DIR" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort)
fi
[[ ${#CASES[@]} -eq 0 ]] && { echo "error: no cases found under $CASES_DIR" >&2; exit 2; }

# ── run the case ────────────────────────────────────────────────────────────
# Runs every line of the case's `cmd` in a fresh sandbox.
# Stops at the first non-zero rc (later commands would score noise).
# $1 = case dir, $2 = sandbox root, $3 = timeout
# Reads the case's `env=K=V` opts from the global CASE_ENV_RAW (one K=V per
# line; `<PROJ>`/`<HOME>` expand to this run's sandbox paths).
# Writes $2/stdout.raw and echoes the final rc.
run_case() {
  local cdir="$1" sand="$2" tmo="$3"
  local proj="$sand/proj" home="$sand/home"
  mkdir -p "$proj" "$home"
  [[ -d "$cdir/fixture" ]] && cp -R "$cdir/fixture/." "$proj/"
  # Strip the `.fixture` suffix (see the case-layout doc): lets a case ship a
  # deliberately-misformatted `.yo` without tripping the repo fmt gate.
  find "$proj" -name '*.fixture' -type f 2>/dev/null | while IFS= read -r fx; do
    mv "$fx" "${fx%.fixture}"
  done

  local -a envkv=() kv
  while IFS= read -r kv; do
    [[ -z "$kv" ]] && continue
    kv="${kv//<PROJ>/$proj}"
    kv="${kv//<HOME>/$home}"
    envkv+=("$kv")
  done <<< "${CASE_ENV_RAW:-}"

  local rc=0 line
  # A case may provide a `stdin` file (raw bytes, e.g. framed LSP messages
  # for `yo lsp`); commands read /dev/null otherwise so an accidentally
  # interactive subcommand can never hang the harness. Resolve it to an
  # ABSOLUTE path HERE: the redirect below is evaluated after `cd "$proj"`,
  # where a relative $cdir no longer exists — the original inline
  # `[[ -f "$cdir/stdin" ]]` check silently fell back to /dev/null on every
  # run, which made the lsp-handshake case vacuous (empty golden, rc=0).
  local stdin_file=/dev/null
  [[ -f "$cdir/stdin" ]] && stdin_file="$(cd "$cdir" && pwd)/stdin"
  : > "$sand/stdout.raw"
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    local -a argv=()
    eval "argv=($line)"
    {
      echo "\$ yo ${argv[*]}"
      ( cd "$proj" && HOME="$home" YO_ORIGINAL_CWD="$proj" YO_STD="$REPO_ROOT/std" \
          run_with_timeout "$tmo" env ${envkv[@]+"${envkv[@]}"} "$YO_SELF_BIN" "${argv[@]}" 2>&1 \
          < "$stdin_file" )
      rc=$?
      echo "rc=$rc"
    } >> "$sand/stdout.raw"
    [[ $rc -ne 0 ]] && break
  done < "$cdir/cmd"
  echo "$rc"
}

# ── main loop ───────────────────────────────────────────────────────────────
declare -A COUNT=( [PASS]=0 [SKIP]=0 [GOLDEN-DIFF]=0 [NO-GOLDEN]=0 [RECORDED]=0 )
declare -a REPORT=()
total=0

for cdir in "${CASES[@]}"; do
  name="$(basename "$cdir")"
  [[ -n "$FILTER" && "$name" != *"$FILTER"* ]] && continue
  total=$((total + 1))

  if [[ "$(opt "$cdir" network 0)" == "1" && $NETWORK -eq 0 ]]; then
    COUNT[SKIP]=$(( COUNT[SKIP] + 1 ))
    REPORT+=("SKIP|$name|network=1, pass --network to run")
    continue
  fi

  tmo="$(opt "$cdir" timeout 300)"
  stdout_mode="$(opt "$cdir" stdout strict)"
  stdout_keep="$(opt "$cdir" stdout_keep '')"
  stdout_keep_match="$(opt "$cdir" stdout_keep_match '')"
  extra_ignores=""
  [[ -f "$cdir/ignore" ]] && extra_ignores="$(cat "$cdir/ignore")"
  CASE_ENV_RAW=""
  [[ -f "$cdir/opts" ]] && CASE_ENV_RAW="$(grep -E '^env=' "$cdir/opts" | cut -d= -f2- || true)"

  # `pwd -P` resolves /var -> /private/var on macOS. Without it the sandbox path
  # a child sees via its own cwd differs from the one we hand it in
  # YO_ORIGINAL_CWD, and every path the tool prints relative to its cwd picks up
  # a spurious `../../..` prefix that looks like a real divergence.
  work="$(cd "$(mktemp -d)" && pwd -P)"

  run_rc="$(run_case "$cdir" "$work/run" "$tmo")"
  normalize_stream "$work/run/proj" "$work/run/home" < "$work/run/stdout.raw" > "$work/run.out"
  apply_stdout_filters "$work/run.out"
  snapshot_tree "$work/run/proj" "$extra_ignores" > "$work/run.proj.manifest"
  snapshot_tree "$work/run/home" "$extra_ignores" > "$work/run.home.manifest"

  # A keep-match pattern that matched NOTHING is a vacuous assertion (typo'd
  # pattern, changed diagnostic) — never record it and never pass it.
  if [[ -n "$stdout_keep_match" && ! -s "$work/run.out" ]]; then
    COUNT[NO-GOLDEN]=$(( COUNT[NO-GOLDEN] + 1 ))
    REPORT+=("NO-GOLDEN|$name|stdout_keep_match matched nothing — vacuous")
    echo "── NO-GOLDEN  $name  (stdout_keep_match matched nothing — vacuous)" >&2
    if [[ $KEEP -eq 1 ]]; then echo "  kept sandbox: $work" >&2; else rm -rf "$work"; fi
    continue
  fi

  if [[ $RECORD -eq 1 ]]; then
    printf '%s\n' "$run_rc" > "$cdir/expected_rc"
    if [[ "$stdout_mode" != "ignore" ]]; then
      cp "$work/run.out" "$cdir/expected_stdout"
    else
      rm -f "$cdir/expected_stdout"
    fi
    cp "$work/run.proj.manifest" "$cdir/expected_tree"
    cp "$work/run.home.manifest" "$cdir/expected_home_tree"
    COUNT[RECORDED]=$(( COUNT[RECORDED] + 1 ))
    REPORT+=("RECORDED|$name|rc=$run_rc")
    echo "── RECORDED  $name  (rc=$run_rc)" >&2
  elif [[ ! -f "$cdir/expected_rc" ]]; then
    COUNT[NO-GOLDEN]=$(( COUNT[NO-GOLDEN] + 1 ))
    REPORT+=("NO-GOLDEN|$name|no expected_rc — record with --record")
    echo "── NO-GOLDEN  $name  (no expected_rc — record with --record)" >&2
  else
    exp_rc="$(cat "$cdir/expected_rc")"
    reasons=""
    [[ "$exp_rc" != "$run_rc" ]] && reasons="$reasons rc(golden=$exp_rc,run=$run_rc)"
    if [[ "$stdout_mode" != "ignore" ]]; then
      if [[ ! -f "$cdir/expected_stdout" ]] || ! cmp -s "$cdir/expected_stdout" "$work/run.out"; then
        reasons="$reasons stdout"
      fi
    fi
    if [[ ! -f "$cdir/expected_tree" ]] || ! cmp -s "$cdir/expected_tree" "$work/run.proj.manifest"; then
      reasons="$reasons tree"
    fi
    if [[ ! -f "$cdir/expected_home_tree" ]] || ! cmp -s "$cdir/expected_home_tree" "$work/run.home.manifest"; then
      reasons="$reasons home"
    fi

    if [[ -z "$reasons" ]]; then
      verdict=PASS; detail="rc=$run_rc (golden)"
    else
      verdict=GOLDEN-DIFF; detail="rc=$run_rc;$reasons"
    fi
    COUNT[$verdict]=$(( COUNT[$verdict] + 1 ))
    REPORT+=("$verdict|$name|$detail")

    if [[ "$verdict" != "PASS" || $VERBOSE -eq 1 ]]; then
      {
        echo "── $verdict  $name  ($detail)"
        if [[ "$reasons" == *stdout* ]]; then
          echo "    stdout diff (golden < / run >):"
          diff "$cdir/expected_stdout" "$work/run.out" 2>/dev/null | head -40 | sed 's/^/      /'
        fi
        if [[ "$reasons" == *tree* ]]; then
          echo "    project tree:"
          explain_golden_tree_diff "$cdir/expected_tree" "$work/run.proj.manifest"
        fi
        if [[ "$reasons" == *home* ]]; then
          echo "    HOME tree:"
          explain_golden_tree_diff "$cdir/expected_home_tree" "$work/run.home.manifest"
        fi
      } >&2
    fi
  fi

  if [[ $KEEP -eq 1 ]]; then
    echo "  kept sandbox: $work" >&2
  else
    rm -rf "$work"
  fi
done

# ── scorecard ───────────────────────────────────────────────────────────────
echo
echo "CLI golden scorecard"
echo "──────────────────────────────────────────────"
for r in "${REPORT[@]}"; do
  IFS='|' read -r verdict name detail <<< "$r"
  if [[ "$verdict" != "PASS" || $VERBOSE -eq 1 ]]; then
    printf '  %-10s %s  (%s)\n' "$verdict" "$name" "$detail"
  fi
done
echo "──────────────────────────────────────────────"
if [[ $RECORD -eq 1 ]]; then
  printf 'RECORDED %d  SKIP %d  (total %d)\n' "${COUNT[RECORDED]}" "${COUNT[SKIP]}" "$total"
else
  # Keep this line's shape: gates_fast.sh GATE 7 greps it for `GOLDEN-DIFF 0`
  # and `NO-GOLDEN 0` as defence-in-depth behind the exit code.
  printf 'PASS %d  GOLDEN-DIFF %d  NO-GOLDEN %d  SKIP %d  (total %d)\n' \
    "${COUNT[PASS]}" "${COUNT[GOLDEN-DIFF]}" "${COUNT[NO-GOLDEN]}" "${COUNT[SKIP]}" "$total"
fi

# NO-GOLDEN counts as a failure: an unscored case is indistinguishable from a
# passing one, so a missing golden must never be a silent skip.
FAILED=$(( COUNT[GOLDEN-DIFF] + COUNT[NO-GOLDEN] ))
[[ $FAILED -gt 0 ]] && exit 1
exit 0
