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
# A MISSING file is a FAILURE, never a clean score. Without this, `grep` on a
# path that does not exist prints nothing, `|| true` swallows its exit code and
# the script reports "0 real" and exits 0 — so a caller that gates on this
# (scripts/bootstrap/fixpoint_only.sh scores /tmp/${P}_stage2.c that way, and
# chunked_gate.sh cuts the count out of the line) scores a compile that never
# produced its .c as HOLLOW-CLEAN. Same family as the stale-stage3 trap in
# issues/fixed/ — verify the artifact exists before reading a number off it.
if [ ! -f "$f" ]; then
  echo "MISSING FILE — $f (no .c to score; the compile that should have written it did not run or did not finish)" >&2
  exit 2
fi
# `.?` captures the byte before each marker (empty at start-of-line), so the
# string-literal form sorts under a leading `"`.
hits=$(grep -oE '.?// (Failed to transpile|Unknown type:)' "$f" || true)
if [ -z "$hits" ]; then
  real=0; floor=0
else
  real=$(printf '%s\n' "$hits" | grep -vc '^"' || true)
  floor=$(printf '%s\n' "$hits" | grep -c '^"' || true)
fi
# SINCE PR #275 THE MARKER COUNT ALONE NO LONGER SEES EVERY HOLLOW BODY. When an
# untranspilable body sits in a VALUE-returning function, codegen no longer ships
# the `// Failed to transpile` comments (falling off the end is UB and
# `-Werror=return-type` rejects it) — it replaces the whole body with
# `abort(); /* untranspilable body in a value-returning fn: ... */`. Such a file
# scores "0 real" while the program aborts at runtime. MEASURED 2026-08-26: a
# closure nested inside an `io.async` closure body emits exactly one such stub,
# `0 real`, and the binary dies rc=134. So the stub count is printed too.
#
# It is NOT folded into `real` and does NOT affect the exit code: `real` is the
# number the bootstrap ratchets (scripts/bootstrap/known-failing.tsv,
# fixpoint_only.sh) are calibrated against, and moving it would re-baseline every
# one of them. Read the stub count yourself whenever "0 real" is the claim.
stubs=$(grep -c 'abort(); /\* untranspilable body' "$f" || true)
echo "$real real ($floor string-literal floor, $stubs abort-stub) — $f"
[ "$real" -eq 0 ]
