#!/usr/bin/env bash
# rename-operator-traits.sh — regenerate the VERDICTS-87 operator-trait rename
# (plans/backlog/STD_RUST_ALIGNMENT.md §9, V87-A) on the current tree.
#
#   scripts/rename-operator-traits.sh            # from the repository root
#
#   Mod -> Rem, Negate -> Neg, BitLeftShift -> Shl, BitRightShift -> Shr, and
#   their `Comptime*` twins. Members do not change (`(%)`, `neg`, `(<<)`, `(>>)`,
#   `Output`); `LogicalNot` and `BitNot` keep their names.
#
# Word-bounded over the `.yo` and `.md` files of std/, tests/, docs/, pack/,
# .github/instructions/ and src/ (src/ holds comments only, plus the
# `rust_std_name_hint` rows the hand edits delete). `Mod.` is skipped: it is a
# module in src/ comments (`Mod.Ty`), never the trait. plans/, issues/ and
# code-reviews/ keep their text (AGENTS.md "Reading historical documents"
# translates them). It never commits.
#
# Afterwards (the PR's procedure, not this script): the hand edits (the class-D
# table rows in docs/, pack/ and yo-design, `Rem`'s doc comment, the hint rows
# in src/diagnostics.yo, the cli-case fixture), `yo fmt` with the tree's
# stage 1, and scripts/cli-diff-test.sh with the rebuilt binary.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
find std tests docs pack .github/instructions src -type f \( -name '*.yo' -o -name '*.md' \) -print0 |
  xargs -0 perl -pi -e '
    s/\bComptimeMod\b/ComptimeRem/g;            s/\bMod\b(?!\.)/Rem/g;
    s/\bComptimeNegate\b/ComptimeNeg/g;         s/\bNegate\b/Neg/g;
    s/\bComptimeBitLeftShift\b/ComptimeShl/g;   s/\bBitLeftShift\b/Shl/g;
    s/\bComptimeBitRightShift\b/ComptimeShr/g;  s/\bBitRightShift\b/Shr/g;
  '
