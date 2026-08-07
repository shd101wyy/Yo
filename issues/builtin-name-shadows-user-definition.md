# Builtin names silently shadow same-named user definitions (OPEN-DESIGN)

**Found 2026-08-06** while attempting to fix
`issues/retired/ctfe-elided-unit-call-arg-temp-leak.md` (whose diagnosis this
finding invalidates — see the banner there).

## The hole

A user definition with the same name as a builtin type-checks fine but is
**dead code**: both compilers' dispatch checks builtins BEFORE user bindings.

- Evaluator: `src/evaluator/exprs/_expr.ts:750` routes `consume(x)` to
  `evaluateConsume` (`src/evaluator/builtins/consume.ts`) even when the user
  defined `consume :: (fn(x : MyVal) -> unit)(...)` in scope.
- Codegen: `src/codegen/exprs/generation.ts:1010` does the same.

Demonstrated: a program defining and calling its own `consume` never calls
it — the builtin evaluates the argument (attaching an owned RC temp), marks
it consumed, and discards it, which reads like a leak but is the builtin's
legal semantics. Renaming the function to `eat_it` produces fully correct C
(real call + scope-end and escape-path drops).

## Secondary observation

Statement-position builtin `consume(<fresh owned value>)` is a silent leak
instrument; an evaluator diagnostic (warning on consuming a freshly
constructed value in statement position) may be worth adding regardless of
the shadowing decision.

## Decision needed

1. **Reserve builtin names** — reject user definitions whose name collides
   with a builtin (clear, breaking for existing code that shadows harmlessly).
2. **Prefer user bindings** — resolve identifiers through the env first and
   fall back to builtins (matches user intuition; needs an audit of prelude
   internals that rely on builtin-first dispatch).
3. Keep builtin-first but **warn on shadowing definitions** (cheapest,
   catches the confusion without changing semantics).

Either way the fix must land in BOTH compilers (dispatch sites above + the
yo-self mirrors in `yo-self/evaluator/exprs/_expr.yo` /
`yo-self/codegen/exprs/generation.yo`).
