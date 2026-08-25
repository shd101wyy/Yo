#!/usr/bin/env bash
# Count REAL untranspiled-body markers in an emitted C file.
#
# WHY THIS EXISTS: a naive `grep -c "Failed to transpile" stage2.c` OVERCOUNTS.
# When codegen cannot emit an expression it writes `// Failed to transpile
# <expr>` (or `// Unknown type: <t>`) into its output. But the codegen's own
# fallback branches DEFINE those messages as string literals — e.g.
# `out := String.from("// Failed to transpile ")` in
# src/codegen/exprs/generation.yo. When the compiler compiles itself, each such
# source string becomes a C string literal (`(const uint8_t*)"// Failed to
# transpile "`) baked into stage2.c, which a naive grep counts as a failure.
# That floor is NOT a fixed number — it tracks how many such literals the
# codegen currently spells (15 on 2026-08-25, 2 when this script was written).
#
# HOW TO TELL THEM APART: a string-literal occurrence is immediately preceded
# by a double quote; an emitted marker never is. That is the same rule the
# codegen's own abort-stub detector uses
# (src/codegen/functions/generation.yo, PR #275).
#
# DO NOT go back to anchoring the comment form to the start of the line
# (`^[[:space:]]*// Failed`). That was this script's original rule and it
# UNDERCOUNTS: codegen also emits markers mid-line, as
# `return // Failed to transpile <expr>;` and
# `__yo_tN tmp = // Failed to transpile <expr>;`. Anchoring silently scores
# those as clean — the same mistake that let a hollow `io.async` closure body
# ship green (issues/ftt-stub-in-live-closure-falls-off-non-void-function.md).
#
# Usage: scripts/count-transpile-failures.sh <emitted.c>
#   Prints "<real> real (<floor> string-literal floor) — <f>" and exits
#   non-zero if real > 0, so gates and drain loops can key on real failures.
set -uo pipefail
f="${1:?usage: count-transpile-failures.sh <emitted.c>}"
# `.?` captures the byte before each marker (empty at start-of-line), so the
# string-literal form sorts under a leading `"`.
hits=$(grep -oE '.?// (Failed to transpile|Unknown type:)' "$f" || true)
if [ -z "$hits" ]; then
  real=0; floor=0
else
  real=$(printf '%s\n' "$hits" | grep -vc '^"' || true)
  floor=$(printf '%s\n' "$hits" | grep -c '^"' || true)
fi
echo "$real real ($floor string-literal floor) — $f"
[ "$real" -eq 0 ]
