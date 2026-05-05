# Codegen attempts to emit comptime-only function call after `exn.throw`

## Status: FIXED (commit f51ad0d3)

Fixed in `src/evaluator/calls/function.ts` — when calling a function whose
forall return type doesn't appear in any parameter type (like `Exception.throw`),
the call is marked with `controlFlow = "escape"` even for runtime unknown values.
This stops the begin-block evaluator from continuing past the throw.

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
