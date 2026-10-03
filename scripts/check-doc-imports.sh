#!/usr/bin/env bash
# Doc examples and source comments must not teach `:: import "path"` — the
# paren-less spelling the parser rejects outright (E0008), so a reader's first
# line fails to compile. The sweep that landed the correct spelling was #696
# (std doc comments) and #881 (docs/); this gate is the anti-rot half of
# issues/fixed/std-doc-examples-use-parenless-import-which-does-not-parse.md
# (its fix option (a)): before it, the wrong idiom propagated by copy-paste
# into brand-new std modules twice in one month, and nothing checked.
#
# The correct spelling is the only one that parses: { X } :: import("path");
#
# Deliberately narrow: this ONE idiom, exactly as the issue prescribes. It
# does not flag Markdown's `<!-- @import "[TOC]" -->` preprocessor directive
# (no `::`), and it scans std/ docs/ src/ only — a parser test under tests/
# may need to quote the form, and the pattern below appears in this file.
#
# REPORTS, never repairs. Exit 1 on any match, 0 otherwise.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  printf '%s\n' "$hit"
  fail=1
done < <(grep -rnIF -- ':: import "' std docs src 2>/dev/null)

if [ "$fail" -ne 0 ]; then
  printf 'paren-less `:: import "path"` above: the parser rejects it (E0008) — write :: import("path")\n'
else
  echo 'doc-imports: no paren-less `:: import "path"` in std/ docs/ src/'
fi
exit $fail
