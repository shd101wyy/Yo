# A generic fn body is never checked against its declared result type

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 1).
**Status:** FIXED 2026-09-24 (Phase 1.3 of `plans/TYPE_SYSTEM_SOUNDNESS.md`). Originally OPEN: soundness hole, green `yo check`, binary ran with a reinterpreted value.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro

```rust
{ println } :: import("std/fmt");
bad :: (fn(comptime(T) : Type, x : T) -> i32)(true);
bad3 :: (fn(generic(T : Type), x : T) -> i32)(true);
main :: (fn() -> unit)({
  println(`${bad(i32, i32(1))}`);
  println(`${bad3(i32(1))}`);
});
export(main);
```

`yo check`: `evaluator OK`, rc=0. `bad` compiles and prints `1`. A `-> T` result with a `bool`
body is accepted the same way. The non-generic `(fn(x : i32) -> i32)(true)` IS rejected with
E0604, so only the generic path is open.

## Mechanism (READ)

- `check_deferred_generic_return_type` (`src/evaluator/calls/function_type.yo` ~128-145) is a stub
  that discards every argument, yet the concrete path's E0604 check (~1698-1730) defers to it for
  any signature containing a SomeT (`ub_skip`).
- Specialization (`_evaluate_funcval_runtime_call` in `src/evaluator/calls/function.yo`, the
  cache-miss path in `src/evaluator/calls/helper.yo`) re-evaluates the body at concrete types but
  performs no result check.

## Fix direction

Run the E0604 comparison on the specialized body at the specialization cache miss, where both
sides are concrete, and delete the stub. Report the error at the generic definition with a
"when instantiated with T = i32" note.

## Fix

- `src/evaluator/calls/helper.yo`, the specialization cache miss (`create_specialized_function_inline`,
  right after the specialized body is evaluated): the body type is compared with the specialized
  result type `spec_ret_ty` under the concrete path's guards (a control-flow tail, `void`,
  `Type`-kinded and `ref` results, and a type still carrying a SomeT are skipped). A mismatch is
  E0604 at the body, naming the instantiation: `Function body has type bool, but the declared
  result type is i32 (instantiated with T = i32).`
- The no-op `check_deferred_generic_return_type` stub is deleted; the real deferred-generic compare
  (a `-> T` result answered with a concrete body at definition) was already inline in
  `calls/function_type.yo` and is unchanged.

## Verification

Both repro functions are rejected with E0604. `tests/type_soundness.test.yo` covers
`comptime(T)`, `generic(T)` with a concrete result, and `generic(T)` with a `-> T` result, plus a
canary that `x => x`-shaped generics still specialize.
