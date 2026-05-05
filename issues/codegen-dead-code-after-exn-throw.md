# Codegen attempts to emit comptime-only function call after `exn.throw`

## Status: OPEN (parametricity fix reverted)

The original fix (commit f51ad0d3) added a "parametricity" detection in
`src/evaluator/calls/function.ts`: when calling a function whose forall return
type doesn't appear in any parameter type (like `Exception.throw`), the call
was marked with `controlFlow = "escape"` even for runtime unknown values, so
the begin-block evaluator would skip subsequent dead code.

That fix was **reverted** during the bootstrap branch because it caused two
real-world regressions:

1. `io.async` and other IO builtins receive a closure whose return type `R`
   appears only inside `Impl(Fn(...) -> R)` — a Trait/SomeType wrapper that
   `typeContainsSomeType` does not currently recurse into. The parametricity
   check therefore wrongly fired on `io.async`, propagating an `escape`
   controlFlow up to the assignment `task := io.async(...)` and triggering
   `"Right-hand side contains escape from function."`.
2. User code with an explicit `return i32(12)` AFTER a `raise(...)`-style
   escape relied on the dead `return` to contribute to closure return-type
   inference. Marking the `raise(...)` call as escape made the begin-block
   loop break before the `return` was visited, leaving the closure's return
   type as the unresolved forall `T`. This broke
   `tests/async_await.test.yo`'s "Test escape in async closure".

A correct fix needs to either:

- handle the dead-code case purely at codegen (skip emitting comptime-only
  calls like type constructors instead of marking the call as escape), or
- continue evaluating `return`/`escape` statements after the first
  control-flow expression in begin blocks so closure return-type inference
  is not lost, and also teach `typeContainsSomeType` to see through trait
  wrappers around forall parameters.

## Original Symptom

Yo source like:

```rust
enclosing_ret := match(ctx.enclosing_function_return_type,
  .Some(t) => t,
  .None    => {
    exn.throw(dyn format_error_message(...));
    t_i32() // unreachable, just here to satisfy types
  }
);
```

Failed at codegen with: `Yo compilation error: Unhandled function call: t_i32()`

## Root Cause (detailed)

When `exn` is a **runtime** implicit parameter (passed as a void-pointer to a throw
callback), `exn.throw` evaluates to `UnknownValue` in the evaluator.

In `src/evaluator/calls/function.ts`, `controlFlow = "escape"` was set only when
`isFunctionValue(functionToCall.value) && isControlFunction && specializedFunctionValue !== undefined`.
When `exn.throw` is `UnknownValue`, the condition was false → no controlFlow set →
begin block continued evaluating dead code → codegen panicked on comptime-only calls.

## Fix

Added a secondary check in `function.ts` using **parametricity**: if:

- The call value is not a `FunctionValue` (runtime/unknown)
- The function has `forallParameters.length > 0`
- The return type is a `SomeType` (unresolved forall param)
- No regular or implicit parameter has that forall type in its type

...then by parametricity (Curry-Howard), the function can ONLY terminate by escaping.
This correctly detects `Exception.throw: fn(forall(ResumeType), error: AnyError) -> ResumeType`.

## Impact

- `yo-self/evaluator/exprs/escape.yo` used a split-match workaround for this.
  The workaround is still present (harmless) but no longer needed for correctness.

## Affected Files

- `src/evaluator/calls/function.ts` — fix location
- `yo-self/evaluator/exprs/escape.yo` — existing workaround (kept as-is)
