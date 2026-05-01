# Throw Handler Lambda Has Restricted Scope (Forall Type Checking)

## Status

Known bug; no fix yet. Workaround: only use builtins (`panic`, `escape`) in throw lambdas.

## Symptom

When a lambda is type-checked against a `forall(ResumeType)` function type (the type of
`Exception.throw`), the lambda body can ONLY access builtins — not imported module-level
functions and not outer function parameters.

```yo
// Works:
given(exn) := Exception(throw: ((err) -> panic("error")));

// FAILS — 'make_err_expr' is a module-level imported function:
given(exn) := Exception(throw: ((err) -> begin(panic("error"), make_err_expr())));

// FAILS — 'expr' is a parameter of the enclosing function:
given(exn) := Exception(throw: ((err) -> begin(panic("error"), expr)));
```

## Root Cause

When the evaluator checks the lambda `(err) -> body` against
`fn(forall(ResumeType), AnyError) -> ResumeType`, it evaluates the lambda body in an
isolated scope. Module-level imported functions and outer function parameters are NOT
accessible from this restricted scope — only builtins (which are always in scope
regardless of environment) work.

Hypothesis: the evaluator uses a fresh/minimal environment when evaluating the
universally quantified function body, rather than the calling environment. This is
different from how top-level functions work (they capture the definition environment).

## Impact

- Cannot return meaningful values from throw handlers
- Cannot log useful context (only the error message string is accessible via `err`)
- All throw handlers in bootstrapped evaluator use `panic("...")` exclusively

## Workaround

Only use builtin functions (`panic`, `escape`, `assert`) inside throw handler lambdas:

```yo
// Safe pattern:
given(exn) := Exception(throw: ((err) -> panic("some error message")));
```

## Files

- `yo-self/evaluator/exprs/_expr.yo` — uses the panic-only workaround
- `src/evaluator/` — bug location (unknown exact file; likely in lambda type-checking)
