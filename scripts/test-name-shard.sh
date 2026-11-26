#!/usr/bin/env bash
# Print a `--test-name-pattern` regex selecting one stripe of ONE test file's tests,
# so a file whose tests run for an hour can be split across CI runners (test.yml's
# `verify` job runs tests/internal/verifier-list-len.test.yo this way).
#
#   scripts/test-name-shard.sh <yo binary> <test file> <index> <count>
#   "$YO" test <file> --test-name-pattern "$(scripts/test-name-shard.sh "$YO" <file> 1 3)"
#
# The distinct test names (`yo test --list`, in file order) are striped by
# position: stripe <index> keeps the names whose position is <index> modulo
# <count>, so the <count> stripes cover every test exactly once. A name that
# occurs twice selects both tests; striping distinct names keeps both in ONE stripe.
#
# The pattern is checked before it is printed: `yo test --list` with it must
# select exactly the stripe's tests (an escaping gap or a regex dialect
# difference fails here, not as a silently smaller run). Exit 1 on a mismatch or
# an empty stripe, 2 on bad arguments.
set -euo pipefail

[ $# -eq 4 ] || { echo "usage: $0 <yo binary> <test file> <index> <count>" >&2; exit 2; }
yo=$1 file=$2 index=$3 count=$4
case "$index$count" in *[!0-9]*) echo "index and count must be integers" >&2; exit 2 ;; esac
[ "$count" -ge 1 ] && [ "$index" -lt "$count" ] || { echo "need 0 <= index < count" >&2; exit 2; }

all=$("$yo" test "$file" --list | cut -f2-)
[ -n "$all" ] || { echo "::error::$file lists no tests" >&2; exit 1; }

# Distinct names in file order, then this stripe.
stripe=$(printf '%s\n' "$all" | awk '!seen[$0]++' | awk -v i="$index" -v n="$count" '(NR - 1) % n == i')
[ -n "$stripe" ] || { echo "::error::stripe $index/$count of $file selects no test" >&2; exit 1; }

# Anchored alternation; every regex metacharacter in a name is escaped.
pattern=$(printf '%s\n' "$stripe" |
  sed -e 's/[][\.^$|?*+(){}]/\\&/g' |
  awk 'BEGIN { ORS = "" } { print (NR > 1 ? "|" : "") $0 } END { print "\n" }')
pattern="^(${pattern})\$"

# The selection must be exactly the stripe's tests, duplicates included.
want=$(printf '%s\n' "$all" | grep -Fxf <(printf '%s\n' "$stripe") | LC_ALL=C sort)
got=$("$yo" test "$file" --list --test-name-pattern "$pattern" | cut -f2- | LC_ALL=C sort)
if [ "$want" != "$got" ]; then
  echo "::error::the pattern for stripe $index/$count of $file selects a different set of tests" >&2
  diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") >&2 || true
  exit 1
fi
echo "stripe $index/$count of $file: $(printf '%s\n' "$got" | wc -l) of $(printf '%s\n' "$all" | wc -l) tests" >&2
printf '%s\n' "$pattern"
