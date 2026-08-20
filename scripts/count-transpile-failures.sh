#!/usr/bin/env bash
# Count REAL "Failed to transpile" markers in an emitted C file (P1 metric).
#
# WHY THIS EXISTS: a naive `grep -c "Failed to transpile" stage2.c` OVERCOUNTS by
# a fixed floor of 2. When the self-hosted compiler emits an unhandled expression
# it writes a COMMENT LINE `// Failed to transpile <expr>` into its output. But the
# codegen's own fallback branches DEFINE that message as a string literal —
# `out := String.from("// Failed to transpile ")` at src/codegen/exprs/
# generation.yo:409 (value-emit) and :577 (ref-emit). When yo-self compiles
# yo-self, those two source strings become two C string literals
# (`(const uint8_t*)"// Failed to transpile "`) baked into stage2.c — matched by a
# naive grep even though they are not failures. Every historical P1 count
# (527 → 30 → … → 2) was inflated by this floor of 2; "2" means ZERO real failures.
#
# A REAL marker is an emitted COMMENT line: leading whitespace then `// Failed`.
# A FLOOR occurrence is inside a string literal: `…"// Failed` (non-`/` before it).
# Distinguish by anchoring the comment form to the start of the line.
#
# Usage: scripts/count-transpile-failures.sh <emitted.c>
#   Prints "<real> real (<floor> string-literal floor)" and exits non-zero if
#   real > 0 (so CI / drain loops can gate on real failures only).
set -euo pipefail
f="${1:?usage: count-transpile-failures.sh <emitted.c>}"
real=$(grep -cE '^[[:space:]]*// Failed to transpile' "$f" || true)
floor=$(grep -cE '"// Failed to transpile' "$f" || true)
echo "$real real ($floor string-literal floor) — $f"
[ "$real" -eq 0 ]
