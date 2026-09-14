#!/usr/bin/env bash
# Report references to issues/**.md that do not resolve.
#
# REPORTS, never repairs. A non-resolving reference has three causes and only
# one of them is a defect:
#
#   1. STALE          the doc moved (usually into issues/fixed/) and the
#                     citation still names the old place. THIS is the bug --
#                     149 of these had accumulated by 2026-09-14, two of them
#                     in compiler source comments that are read while changing
#                     the very code the doc explains.
#   2. AHEAD OF TREE  the citation names where the doc is about to be, per a
#                     branch this tree does not have. Repairing it REVERTS
#                     someone's work. Run this on the MERGE RESULT, not on a
#                     branch in isolation, or concurrent moves read as stale.
#   3. NOT A CITATION historical prose describing a before-state, or a quoted
#                     `git mv` command. Correct exactly as written, forever.
#                     Common in precisely the docs that discuss moves.
#
# Cases 2 and 3 cannot be told apart from 1 mechanically, which is why this
# prints the offending line and leaves the judgement to a human.
#
# Exit 1 if anything does not resolve, 0 otherwise.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
while IFS= read -r hit; do
  file=${hit%%:*}; rest=${hit#*:}; line=${rest%%:*}; text=${rest#*:}
  # case 3 heuristic: a quoted shell command naming the path
  case "$text" in *"git mv"*|*"grep -rn"*|*"ls issues"*) continue;; esac
  for p in $(printf '%s\n' "$text" | grep -ohE "issues/(fixed/|retired/|repros/|patches/)?[A-Za-z0-9._-]+\.(md|yo|patch)"); do
    [ -e "$p" ] && continue
    printf '%s:%s: does not resolve -> %s\n    %s\n' "$file" "$line" "$p" "$(printf '%s' "$text" | sed 's/^[[:space:]]*//' | cut -c1-100)"
    fail=1
  done
done < <(grep -rnE "issues/(fixed/|retired/|repros/|patches/)?[A-Za-z0-9._-]+\.(md|yo|patch)" \
           --exclude-dir=.git --exclude-dir=yo-out --exclude-dir=node_modules . 2>/dev/null)
if [ $fail -eq 0 ]; then echo "issue references: all resolve"; fi
exit $fail
