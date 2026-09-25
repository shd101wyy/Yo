# `consume` swallows its argument's error, and its result carries the wrong environment

**Found:** 2026-09-26, the Phase 4.4b battery of `plans/TYPE_SYSTEM_SOUNDNESS.md`
(`tests/imm_iterators.test.yo` stopped compiling). **Severity:** MEDIUM (a masked error; the
enclosing block continued in the wrong environment).
**Status:** FIXED on `tss/phase4-4b`.

## Reproducer

```rust
f :: (fn() -> unit)({
  consume(no_such_name);
});
export(f);
```

`yo check` reported `consume: failed to evaluate expression.` at the argument, not the unknown name.

## Root cause

The `consume` builtin (`src/evaluator/builtins/consume.yo`) evaluated its argument with the
3-argument `evaluate_expression`. That wrapper swallows every throw and returns an error node. The
real error was lost, and the error node's `ExprInfo` carried an environment that was not the
caller's. `consume` adopted that environment for its own result, and the enclosing block adopted
the result's environment for the statements after it.

That is how it surfaced. In the definition-time trial of `std/imm/vec.yo`'s generic `map`, the
argument `(new_ptr.add(i)).* = f(…)` fails (`U` is unresolved), and the block after the
`consume` ran in the prelude's environment. The loop's `i = (i + usize(1))` then failed with
"Variable i not found". That error was swallowed while its message read
`Variable i not found in the environment`. Phase 4.4b gave it the standard
`Variable "i" not found.` text, which the swallow policy re-raises as a hard error, so the
test stopped compiling.

## Fix

`consume` evaluates its argument through the caller's `exn` (`evaluate_expression_raw`). The
argument's error is reported as itself, and a trial that fails there fails as a trial, with the
environment untouched. The other builtins that still call the swallowing wrapper are Phase 6's
(retire the swallow policy).

## Tests

`tests/cli-cases/consume-reports-its-arguments-error`; `tests/imm_iterators.test.yo` compiles
again.
