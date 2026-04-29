# ASAN stack overflow in `evaluate` after adding `id` field to `AstExpr`

## Summary

After Phase 3a of the bootstrapping (adding `id : ExprId` as the first
field of both `AstExpr.Atom` and `AstExpr.FnCall`), recursive evaluator
tests started failing with `exit code null` (ASAN-detected stack overflow).
Subsequent phases (Phase 2az: extending `TraitT` with new fields, growing
`TypeValue`) further increased the frame size.

Affected tests and applied workarounds:

- `evaluate: recur simple countdown` — was `count(2)`, now reduced to `count(1)`
- `evaluate: typed fibonacci fib(2)=1` — renamed/reduced to `fib(1)=1`
- `evaluate: recur factorial` — was `fact(2)`, reduced to `fact(1)` (base case only) after Phase 2az

## Root cause

`yo-self/evaluator/eval.yo`'s `evaluate` function has ~693 local variables.
ASAN disables stack frame reuse and adds redzones around every local. Adding
one extra `usize` to every `AstExpr` pattern destructure (`.Atom(id, tok)`
and `.FnCall(id, func, args, infix, tok)`) introduced ~one extra local per
match arm, plus larger destructured variant payloads. Frame size grew enough
that workloads that previously fit just barely within macOS ARM64's 8MB
stack now overflow.

Per `.github/instructions/testing.instructions.md`, the per-frame overhead
on macOS ARM64 was ~566KB before. After Phase 3a, `count(2)` (~7 frames)
no longer fits in 8MB. After Phase 2az's TraitT growth, `fact(2)` (~8 frames
with extra `*` dispatch) also overflows.

## Workaround applied

Reduced test inputs to use base-case or single-recursion calls. The original
recursion-depth coverage is sacrificed until either:

1. The Phase 3 evaluator (which uses an external `ExprInfoTable` side
   table and is structured as many small handler functions instead of one
   giant `evaluate`) replaces `eval.yo`, dramatically shrinking the per-call
   frame size.
2. We split `evaluate` into smaller helpers manually before Phase 3
   completes.

## Status

Tracking: Phase 3 will fix this naturally once the production evaluator
port replaces the prototype `eval.yo`. Until then, accept the reduced
recursion-depth coverage in the affected tests.
