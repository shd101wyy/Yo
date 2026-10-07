#!/usr/bin/env bash
# Three assertions over issues/:
#   1. no doc exists in more than one of root/, fixed/, retired/, questions/
#   2. every cited issues/** path resolves
#   3. root docs carry a **Severity:** verdict; questions/ docs a Recommendation
#
# CHECK 2 -- references to issues/**.md that do not resolve.
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

# ---------------------------------------------------------------------------
# CHECK 1: no doc exists in more than one of root/, fixed/, retired/,
# questions/.
#
# A resolves/doesn't-resolve check is BLIND to this: both paths resolve, and
# the tree simply lies about the open count. Found 2026-09-14 with three docs
# present in BOTH issues/ and issues/fixed/ -- the fixing commits had COPIED
# rather than MOVED, so three already-fixed bugs were counted as open for
# weeks, each root copy a strictly older snapshot still saying OPEN.
#
# It also defeats the obvious triage signal: "cited as issues/fixed/ but
# sitting in root" reads as a stale CITATION, and for these the citation was
# right -- there were two files.
# ---------------------------------------------------------------------------
for f in issues/*.md; do
  b=$(basename "$f")
  [ "$b" = "README.md" ] || [ "$b" = "TRIAGE.md" ] && continue
  for d in fixed retired questions; do
    if [ -f "issues/$d/$b" ]; then
      printf 'DUPLICATE: %s exists in BOTH issues/ and issues/%s/\n' "$b" "$d"
      printf '    the open count is wrong until one copy is removed; compare them before deleting\n'
      fail=1
    fi
  done
done
# A doc filed under fixed/ or retired/ whose status line still reads a BARE
# "OPEN" is either a stale header or a live bug hiding in the closed pile --
# both worth a look, and invisible to every other check here. 18 were found on
# 2026-09-15; the one that looked worst (an ArrayList(Waker) tracer said to be
# blocking the channel rewrite) turned out to be a stale header, but only
# reading the CODE established that.
#
# Narrow on purpose: a doc that says "was OPEN", "OPEN -> fixed" or carries a
# FIXED marker in the same line is a normal, honest narration of history.
for f in issues/fixed/*.md issues/retired/*.md; do
  [ -f "$f" ] || continue
  line=$(head -14 "$f" | grep -iE '^\*\*Status' | head -1)
  case "$line" in
    *[Ww]as*|*FIXED*|*RETIRED*|*FIX*|*FIXED*) continue;;
  esac
  case "$line" in
    *OPEN*)
      printf '%s: filed as closed but its status line still reads OPEN\n' "$f"
      printf '    %s\n' "$(printf '%s' "$line" | cut -c1-100)"
      fail=1
      ;;
  esac
done
for f in issues/fixed/*.md; do
  b=$(basename "$f")
  if [ -f "issues/retired/$b" ]; then
    printf 'DUPLICATE: %s exists in BOTH issues/fixed/ and issues/retired/\n' "$b"
    fail=1
  fi
done

# ---------------------------------------------------------------------------
# CHECK 3: every open bug doc carries a Severity verdict, and every doc under
# questions/ carries a Recommendation.
#
# Severity is the triage vocabulary defined in issues/README.md (S1 trust of
# output, S2 bounded functional defect, S3 quality). A root doc without one
# cannot be sorted against the rest of the pile, so "what to fix first" has to
# be re-derived from prose by every reader. Added 2026-09-28 together with
# the initial severity pass over every then-open doc.
#
# questions/ docs are design decisions, not defects: they carry no Severity,
# but each must carry a ## Recommendation section so the queue is always in a
# decidable state rather than an open-ended list of options.
# ---------------------------------------------------------------------------
for f in issues/*.md; do
  b=$(basename "$f")
  [ "$b" = "README.md" ] || [ "$b" = "TRIAGE.md" ] && continue
  if ! grep -qE '^\*\*Severity:\*\* S[123]' "$f"; then
    printf '%s: open bug doc with no **Severity:** S1|S2|S3 line (scale: issues/README.md)\n' "$f"
    fail=1
  fi
done
for f in issues/questions/*.md; do
  [ -f "$f" ] || continue
  if ! grep -q '^## Recommendation' "$f"; then
    printf '%s: design question with no ## Recommendation section (state a position for the maintainer)\n' "$f"
    fail=1
  fi
  if grep -qE '^\*\*Severity:\*\* S[123]' "$f"; then
    printf '%s: questions/ doc carries a Severity line — design decisions are not bugs; drop it\n' "$f"
    fail=1
  fi
done

while IFS= read -r hit; do
  file=${hit%%:*}; rest=${hit#*:}; line=${rest%%:*}; text=${rest#*:}
  # case 3 heuristic: a quoted shell command naming the path
  case "$text" in *"git mv"*|*"grep -rn"*|*"ls issues"*) continue;; esac
  for p in $(printf '%s\n' "$text" | grep -ohE "issues/(fixed/|retired/|questions/|repros/|patches/)?[A-Za-z0-9._-]+\.(md|yo|patch)"); do
    [ -e "$p" ] && continue
    # issues/TRIAGE.md is UNTRACKED and gitignored since 2026-10-07: a locally
    # generated index (scripts/gen-issue-triage.py), never committed, so prose
    # citing it is correct even though it is absent from a fresh checkout.
    [ "$p" = "issues/TRIAGE.md" ] && continue
    printf '%s:%s: does not resolve -> %s\n    %s\n' "$file" "$line" "$p" "$(printf '%s' "$text" | sed 's/^[[:space:]]*//' | cut -c1-100)"
    fail=1
  done
done < <(grep -rnE "issues/(fixed/|retired/|questions/|repros/|patches/)?[A-Za-z0-9._-]+\.(md|yo|patch)" \
           --exclude-dir=.git --exclude-dir=yo-out --exclude-dir=node_modules . 2>/dev/null)
if [ $fail -eq 0 ]; then echo "issues/: no duplicated docs, all cited paths resolve, every open doc triaged"; fi
exit $fail
