# Throw Handler Lambda Has Restricted Scope (Forall Type Checking)

## Status: FIXED (commit pending)

Fixed in `src/evaluator/values/anonymous-function.ts` — regular `->` functions that
capture outer **runtime** variables now emit a clear evaluator error instead of
silently producing broken C code.

Regression test added: `tests/algebraic_effects.test.yo` — "regular fn handler cannot
capture outer runtime variable"

## Original Symptom

When a lambda is type-checked against a `forall(ResumeType)` function type (the type of
`Exception.throw`), capturing outer runtime variables produced broken C code without a
diagnostic.

```yo
// Works:
given(exn) := Exception(throw: ((err) -> panic("error")));

// NOW ERRORS with a clear message (previously: silent broken C):
outer_val := i32(42);
given(exn) := Exception(throw: ((err) -> begin(assert((outer_val == i32(0)), "bad"), panic("error"))));
```

## Root Cause

`->`-lambdas (regular functions, not closures) do not capture outer runtime variables —
they are not closures. The evaluator was silently allowing capture of runtime variables
in `->` lambdas, then generating broken C code that referenced variables from a different
stack frame.

Note: `->` and `=>` are distinct:

- `->` = regular function (no capture, type `fn(...)`)
- `=>` = closure (captures env, type `Impl(Fn(...))`)

Effect handlers (`given`/`using`) always use `->`, never `=>`.

## Fix

`src/evaluator/values/anonymous-function.ts`: After computing `capturedVariables`,
when `!isCreatingClosure` and any captured variable has `frameLevel < outerEnv.frames.length`
(true outer variable, not just a parameter), throw a clear evaluator error.

## Impact

- All throw handlers in bootstrapped evaluator continue to use `panic("...")` (compile-time strings)
- No yo-self code needed to change (they already used the correct pattern)

## Files

- `src/evaluator/values/anonymous-function.ts` — fix location
- `tests/algebraic_effects.test.yo` — regression test
