#!/usr/bin/env bash
# Compile-and-run every Yo program EMBEDDED in a shell script, PowerShell
# script or workflow file in this repository.
#
# Why this exists
# ---------------
# `yo check ./std`, `yo check ./src` and the language suite cover the three
# directories that hold `.yo` files. They do not cover Yo source that lives
# INSIDE another file — and six such programs gate the release and the install
# experience:
#
#   * the hello world `scripts/install.sh` / `scripts/install.ps1` compile with
#     the release they just downloaded (their verification step);
#   * the hello world `.github/workflows/install-scripts.yml` compiles after a
#     real install, on POSIX and on Windows;
#   * the hello world `.github/workflows/release.yml` compiles against each
#     freshly built bundle (three sites: bundle smoke, musl container smoke,
#     portable-C smoke).
#
# A language change that removes a form one of those uses lands green on every
# required check. `install-scripts.yml` is paths-filtered to the two installer
# files plus itself, and `release.yml` only runs at release time — so the
# breakage surfaces to a USER, at install time, with a diagnostic that reads
# like a broken release. That is exactly what happened when the `open(...)`
# builtin was removed: see
# issues/fixed/installer-verification-snippet-is-outside-every-per-pr-gate.md.
#
# Every snippet is EXTRACTED from its host file, never copied here. A copy
# drifts, and drift is the failure being prevented. Extraction that yields
# nothing is itself a failure, so moving a here-doc marker cannot silently turn
# this check vacuous.
#
# Usage:
#   scripts/check-embedded-yo.sh <path-to-yo> [workdir]
#
# Run from the repository root. Exits nonzero if any snippet fails to extract,
# fails to compile, or prints something other than what its host file asserts.

set -uo pipefail

YO=${1:?usage: check-embedded-yo.sh <path-to-yo> [workdir]}
WORK=${2:-$(mktemp -d)}
mkdir -p "$WORK"

# The snippets are compiled from a scratch directory, and <path-to-yo> is
# routinely a stage-1 staged OUTSIDE this checkout (CI's /tmp/yo-stage1), where
# the exe-relative walk-up finds no std/. Pin std to the checkout being
# checked — these are the snippets THIS tree ships, so they must be checked
# against THIS tree's std.
if [ -z "${YO_STD:-}" ] && [ -d "$PWD/std" ]; then
  export YO_STD="$PWD/std"
fi

fails=0
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }

# Strip the common leading indentation of a here-doc that was embedded in a
# YAML block scalar (`run: |`), where the indent belongs to the YAML and not to
# the program.
dedent() {
  awk '
    NR == 1 { match($0, /^[ \t]*/); n = RLENGTH }
    { print substr($0, n + 1) }
  ' "$1"
}

# check <label> <expected-stdout> <source-file>
check() {
  label=$1 expect=$2 src=$3
  if [ ! -s "$src" ]; then
    fail "$label: extraction produced nothing — the surrounding markers moved; update this script"
    return
  fi
  if ! "$YO" compile "$src" -o "$src.bin" > "$src.log" 2>&1; then
    fail "$label: does not compile"
    sed 's/^/    /' "$src.log"
    return
  fi
  got=$("$src.bin" 2>&1)
  if [ "$got" != "$expect" ]; then
    fail "$label: printed '$got', host file asserts '$expect'"
    return
  fi
  echo "ok: $label"
}

#---------------------------------------------------------
# 1+2. scripts/install.sh and scripts/install.ps1
#
# Both installers verify by compiling AND running a hello world, and both
# assert the same line — so they must embed the same program.
#---------------------------------------------------------
awk '/cat > "\$YO_TEMP_DIR\/hello.yo" <<.YOEOF.$/{f=1;next} f&&/^YOEOF$/{exit} f' \
  scripts/install.sh > "$WORK/install_sh.yo"
awk '/^  \$hello = @.$/{f=1;next} f&&/^.@$/{exit} f' \
  scripts/install.ps1 > "$WORK/install_ps1.yo"

check "scripts/install.sh verify snippet"  "Yo is installed" "$WORK/install_sh.yo"
check "scripts/install.ps1 verify snippet" "Yo is installed" "$WORK/install_ps1.yo"
if [ -s "$WORK/install_sh.yo" ] && [ -s "$WORK/install_ps1.yo" ]; then
  if ! diff -u "$WORK/install_sh.yo" "$WORK/install_ps1.yo" > "$WORK/installers.diff" 2>&1; then
    fail "install.sh and install.ps1 verify DIFFERENT programs"
    sed 's/^/    /' "$WORK/installers.diff"
  fi
fi

#---------------------------------------------------------
# 3+4. .github/workflows/install-scripts.yml (POSIX + Windows legs)
#
# Indented inside a YAML block scalar, so dedent before compiling.
#---------------------------------------------------------
awk '/cat > hello.yo <<.EOF.$/{f=1;next} f&&/^ *EOF$/{exit} f' \
  .github/workflows/install-scripts.yml > "$WORK/iw_posix.raw"
awk '/^ *@.$/{f=1;next} f&&/^ *.@ \| Set-Content/{exit} f' \
  .github/workflows/install-scripts.yml > "$WORK/iw_win.raw"
dedent "$WORK/iw_posix.raw" > "$WORK/iw_posix.yo"
dedent "$WORK/iw_win.raw"   > "$WORK/iw_win.yo"

check "install-scripts.yml POSIX smoke"   "installed ok" "$WORK/iw_posix.yo"
check "install-scripts.yml Windows smoke" "installed ok" "$WORK/iw_win.yo"

#---------------------------------------------------------
# 5. .github/workflows/release.yml — three `printf` one-liners
#
# Shape: printf '%s\n' 'line' 'line' 'line' > <path>/hello.yo
# Re-run the printf itself rather than re-parsing its quoting, then require all
# three sites to agree: they smoke the same bundle three different ways.
#---------------------------------------------------------
grep -n "printf '%s\\\\n' .* > .*hello\.yo" .github/workflows/release.yml \
  > "$WORK/release_sites.txt"
site_count=$(wc -l < "$WORK/release_sites.txt" | tr -d ' ')
if [ "$site_count" = "0" ]; then
  fail "release.yml: found no hello-world printf sites — the shape changed; update this script"
fi
n=0
while IFS= read -r line; do
  n=$((n + 1))
  lineno=${line%%:*}
  body=${line#*:}
  args=${body#*printf }
  args=${args%% > *}
  # `eval` of a printf whose arguments come from this repository's own
  # workflow file — the alternative is re-implementing shell quoting.
  eval "printf $args" > "$WORK/release_$n.yo" 2>"$WORK/release_$n.evalerr" || {
    fail "release.yml:$lineno: could not re-run its printf"
    sed 's/^/    /' "$WORK/release_$n.evalerr"
    continue
  }
  check "release.yml:$lineno bundle smoke" "hello from the yo seed" "$WORK/release_$n.yo"
  if [ "$n" -gt 1 ] && ! diff -q "$WORK/release_1.yo" "$WORK/release_$n.yo" > /dev/null 2>&1; then
    fail "release.yml:$lineno smokes a DIFFERENT program than the first site"
  fi
done < "$WORK/release_sites.txt"

echo "EMBEDDED_YO: sites=$((2 + 2 + site_count)) failures=$fails"
[ "$fails" = "0" ] || exit 1
