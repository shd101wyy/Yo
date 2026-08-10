#!/usr/bin/env bash
#
# cli-diff-test.sh — differential test harness for CLI SUBCOMMANDS.
# See plans/P1_CLI_PARITY.md §1.
#
# `scripts/diff-test.sh` compares stdout + exit code, which is the right verdict
# for a compiled program. It is useless for `init`/`fetch`/`install`/`cache`/
# `build`/`doc`, whose real output is a DIRECTORY TREE, a cache mutation, or an
# artifact set. This harness runs the same subcommand under both compilers in
# two isolated sandboxes and diffs the trees as well as stdout+rc.
#
# Why it exists: in this codebase "ported" can mean "type-checks and is
# unreachable", and `check` cannot tell those apart. `init_project` was 239
# complete, type-checking lines wired to no subcommand; the first time it ran it
# returned rc=139 against the reference compiler's rc=0.
#
# ── Case layout ────────────────────────────────────────────────────────────
#   tests/cli-cases/<name>/
#     cmd        REQUIRED. One command per line; each line is a shell-quoted
#                argv appended to the compiler binary, run in the sandbox
#                project dir. `#` comments and blank lines are ignored.
#     fixture/   OPTIONAL. Copied into the sandbox project dir before running.
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
#                  network=1              (skipped unless --network is passed)
#                  timeout=<seconds>      (default 300, per command)
#
# Each side runs with its own HOME, so `~/.cache/yo` mutations are part of the
# differential rather than leaking between the two sides or into the user's
# real cache. Both the project tree and the HOME tree are compared.
#
# ── Per-case verdicts (same vocabulary as scripts/diff-test.sh) ─────────────
#   PASS       both sides behaved identically (rc, stdout, project tree, HOME tree)
#   DIFF       both sides succeeded but their behavior differs
#   SELF-FAIL  the self-hosted binary failed where the TS reference succeeded
#   TS-FAIL    the TS reference failed where the self-hosted binary succeeded
#   BOTH-FAIL  both failed AND their behavior differs (matching failures are
#              a PASS — a case may legitimately assert an error path)
#   SKIP       case declared network=1 and --network was not passed
#
# Usage:
#   scripts/cli-diff-test.sh [case ...] [--cases-dir DIR] [--filter SUBSTR]
#                            [--network] [--keep] [-v]
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
TS_CLI=(node "$REPO_ROOT/out/cjs/yo-cli.cjs")

CASES_DIR="tests/cli-cases"
FILTER=""
VERBOSE=0
NETWORK=0
KEEP=0
declare -a WANTED=()

usage() { sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cases-dir) CASES_DIR="$2"; shift 2 ;;
    --filter)    FILTER="$2"; shift 2 ;;
    --network)   NETWORK=1; shift ;;
    --keep)      KEEP=1; shift ;;
    -v|--verbose) VERBOSE=1; shift ;;
    -h|--help)   usage 0 ;;
    -*)          echo "unknown flag: $1" >&2; usage 2 ;;
    *)           WANTED+=("$1"); shift ;;
  esac
done

[[ -d "$CASES_DIR" ]] || { echo "error: cases dir not found: $CASES_DIR" >&2; exit 2; }
[[ -x "$YO_SELF_BIN" ]] || echo "warning: YO_SELF_BIN not found/executable: $YO_SELF_BIN (every case will SELF-FAIL)" >&2
[[ -f "$REPO_ROOT/out/cjs/yo-cli.cjs" ]] || { echo "error: out/cjs/yo-cli.cjs missing — run 'bun run build'" >&2; exit 2; }

# Portable timeout (macOS ships none by default).
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN=(timeout)
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN=(gtimeout)
else TIMEOUT_BIN=(); fi
run_with_timeout() {
  local secs="$1"; shift
  if [[ ${#TIMEOUT_BIN[@]} -gt 0 ]]; then "${TIMEOUT_BIN[@]}" "$secs" "$@"; else "$@"; fi
}

# Artifacts that are legitimately allowed to differ byte-for-byte between the
# two compilers (emitted C, object files, linked binaries) or that are pure
# noise. A case may add more via its own `ignore` file. Kept deliberately short:
# a too-broad default here is how a tree differential goes quietly hollow.
DEFAULT_IGNORES=(
  './yo-out/*' '*/yo-out/*'
  '*.o' '*.a' '*.dylib' '*.so' '*.out' '*.bin'
  '*.yo.c' '*.bin.c'
  './.DS_Store' '*/.DS_Store'
)

strip_ansi() { sed $'s/\x1b\\[[0-9;]*m//g'; }

# Rewrite everything environment-specific out of a captured stream so the two
# sides are comparable: sandbox roots, the repo root, wall-clock durations and
# byte counts. Order matters — the sandbox paths are longest and must go first.
# $1 = project dir, $2 = home dir
normalize_stream() {
  local proj="$1" home="$2"
  strip_ansi \
    | sed -e "s|$proj|<PROJ>|g" \
          -e "s|$home|<HOME>|g" \
          -e "s|$REPO_ROOT|<REPO>|g" \
    | sed -E -e 's/[0-9]+(\.[0-9]+)?[[:space:]]*(ms|s\b|seconds)/<TIME>/g' \
             -e 's/\b[0-9a-f]{40}\b/<SHA1>/g' \
             -e 's/\b[0-9a-f]{64}\b/<SHA256>/g'
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

# Show WHY two trees differ: which paths are one-sided, and for paths present
# on both with different content, a bounded unified diff of the text.
# $1/$2 = manifests, $3/$4 = roots
explain_tree_diff() {
  local m_ts="$1" m_self="$2" r_ts="$3" r_self="$4"
  diff <(cut -f1 "$m_ts") <(cut -f1 "$m_self") | sed -n 's/^< /    only-in-ts:   /p;s/^> /    only-in-self: /p'
  local p sha_ts sha_self
  while IFS=$'\t' read -r p sha_ts; do
    sha_self="$(grep -F -m1 "$(printf '%s\t' "$p")" "$m_self" | cut -f2)"
    [[ -z "$sha_self" || "$sha_ts" == "$sha_self" ]] && continue
    echo "    content-differs: $p"
    diff -u "$r_ts/$p" "$r_self/$p" 2>/dev/null | sed -n '3,23p' | sed 's/^/      /'
  done < "$m_ts"
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

# ── run one side ────────────────────────────────────────────────────────────
# Runs every line of the case's `cmd` under one compiler in a fresh sandbox.
# Stops at the first non-zero rc (later commands would compare noise).
# $1 = case dir, $2 = "ts"|"self", $3 = sandbox root, $4 = timeout
# Writes $3/stdout.raw and echoes the final rc.
run_side() {
  local cdir="$1" side="$2" sand="$3" tmo="$4"
  local proj="$sand/proj" home="$sand/home"
  mkdir -p "$proj" "$home"
  [[ -d "$cdir/fixture" ]] && cp -R "$cdir/fixture/." "$proj/"

  local rc=0 line
  : > "$sand/stdout.raw"
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    local -a argv=()
    eval "argv=($line)"
    {
      echo "\$ yo ${argv[*]}"
      if [[ "$side" == "ts" ]]; then
        ( cd "$proj" && HOME="$home" YO_ORIGINAL_CWD="$proj" \
            run_with_timeout "$tmo" "${TS_CLI[@]}" "${argv[@]}" 2>&1 )
      else
        ( cd "$proj" && HOME="$home" YO_ORIGINAL_CWD="$proj" YO_STD="$REPO_ROOT/std" \
            run_with_timeout "$tmo" "$YO_SELF_BIN" "${argv[@]}" 2>&1 )
      fi
      rc=$?
      echo "rc=$rc"
    } >> "$sand/stdout.raw"
    [[ $rc -ne 0 ]] && break
  done < "$cdir/cmd"
  echo "$rc"
}

# ── main loop ───────────────────────────────────────────────────────────────
declare -A COUNT=( [PASS]=0 [DIFF]=0 [SELF-FAIL]=0 [TS-FAIL]=0 [BOTH-FAIL]=0 [SKIP]=0 )
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
  extra_ignores=""
  [[ -f "$cdir/ignore" ]] && extra_ignores="$(cat "$cdir/ignore")"

  # `pwd -P` resolves /var -> /private/var on macOS. Without it the sandbox path
  # a child sees via `process.cwd()` differs from the one we hand it in
  # YO_ORIGINAL_CWD, and every path the tool prints relative to its cwd picks up
  # a spurious `../../..` prefix that looks like a real divergence.
  work="$(cd "$(mktemp -d)" && pwd -P)"
  ts_rc="$(run_side "$cdir" ts   "$work/ts"   "$tmo")"
  self_rc="$(run_side "$cdir" self "$work/self" "$tmo")"

  normalize_stream "$work/ts/proj"   "$work/ts/home"   < "$work/ts/stdout.raw"   > "$work/ts.out"
  normalize_stream "$work/self/proj" "$work/self/home" < "$work/self/stdout.raw" > "$work/self.out"
  if [[ -n "$stdout_keep" ]]; then
    grep -E "$stdout_keep" "$work/ts.out"   > "$work/ts.out.kept"   || true
    grep -E "$stdout_keep" "$work/self.out" > "$work/self.out.kept" || true
    mv "$work/ts.out.kept" "$work/ts.out"
    mv "$work/self.out.kept" "$work/self.out"
  fi

  snapshot_tree "$work/ts/proj"   "$extra_ignores" > "$work/ts.proj.manifest"
  snapshot_tree "$work/self/proj" "$extra_ignores" > "$work/self.proj.manifest"
  snapshot_tree "$work/ts/home"   "$extra_ignores" > "$work/ts.home.manifest"
  snapshot_tree "$work/self/home" "$extra_ignores" > "$work/self.home.manifest"

  reasons=""
  [[ "$ts_rc" != "$self_rc" ]] && reasons="$reasons rc(ts=$ts_rc,self=$self_rc)"
  if [[ "$stdout_mode" != "ignore" ]] && ! cmp -s "$work/ts.out" "$work/self.out"; then
    reasons="$reasons stdout"
  fi
  cmp -s "$work/ts.proj.manifest" "$work/self.proj.manifest" || reasons="$reasons tree"
  cmp -s "$work/ts.home.manifest" "$work/self.home.manifest" || reasons="$reasons home"

  if [[ -z "$reasons" ]]; then
    verdict=PASS; detail="rc=$ts_rc"
  elif [[ "$ts_rc" == "0" && "$self_rc" != "0" ]]; then
    verdict=SELF-FAIL; detail="self rc=$self_rc;$reasons"
  elif [[ "$ts_rc" != "0" && "$self_rc" == "0" ]]; then
    verdict=TS-FAIL; detail="ts rc=$ts_rc;$reasons"
  elif [[ "$ts_rc" != "0" && "$self_rc" != "0" ]]; then
    verdict=BOTH-FAIL; detail="ts rc=$ts_rc self rc=$self_rc;$reasons"
  else
    verdict=DIFF; detail="rc=$ts_rc;$reasons"
  fi

  COUNT[$verdict]=$(( COUNT[$verdict] + 1 ))
  REPORT+=("$verdict|$name|$detail")

  if [[ "$verdict" != "PASS" || $VERBOSE -eq 1 ]]; then
    {
      echo "── $verdict  $name  ($detail)"
      if [[ "$reasons" == *stdout* ]]; then
        echo "    stdout diff (ts < / self >):"
        diff "$work/ts.out" "$work/self.out" | head -40 | sed 's/^/      /'
      fi
      if [[ "$reasons" == *tree* ]]; then
        echo "    project tree:"
        explain_tree_diff "$work/ts.proj.manifest" "$work/self.proj.manifest" \
                          "$work/ts/proj" "$work/self/proj"
      fi
      if [[ "$reasons" == *home* ]]; then
        echo "    HOME tree:"
        explain_tree_diff "$work/ts.home.manifest" "$work/self.home.manifest" \
                          "$work/ts/home" "$work/self/home"
      fi
    } >&2
  fi

  if [[ $KEEP -eq 1 ]]; then
    echo "  kept sandbox: $work" >&2
  else
    rm -rf "$work"
  fi
done

# ── scorecard ───────────────────────────────────────────────────────────────
echo
echo "CLI differential scorecard"
echo "──────────────────────────────────────────────"
for r in "${REPORT[@]}"; do
  IFS='|' read -r verdict name detail <<< "$r"
  if [[ "$verdict" != "PASS" || $VERBOSE -eq 1 ]]; then
    printf '  %-10s %s  (%s)\n' "$verdict" "$name" "$detail"
  fi
done
echo "──────────────────────────────────────────────"
printf 'PASS %d  DIFF %d  SELF-FAIL %d  TS-FAIL %d  BOTH-FAIL %d  SKIP %d  (total %d)\n' \
  "${COUNT[PASS]}" "${COUNT[DIFF]}" "${COUNT[SELF-FAIL]}" "${COUNT[TS-FAIL]}" \
  "${COUNT[BOTH-FAIL]}" "${COUNT[SKIP]}" "$total"

FAILED=$(( COUNT[DIFF] + COUNT[SELF-FAIL] + COUNT[TS-FAIL] + COUNT[BOTH-FAIL] ))
[[ $FAILED -gt 0 ]] && exit 1
exit 0
