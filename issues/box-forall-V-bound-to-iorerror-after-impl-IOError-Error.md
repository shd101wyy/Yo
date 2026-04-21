# `box(closure)` fails with `V=IOError` after importing std/sys/errors

## Symptom

After `import "std/sys/errors"` (or any module that transitively imports it,
such as `std/env`, `std/process`, `std/process/command`), any later call to
`box(closure_value)` fails with:

```
Error: Failed to call the function:
- Type mismatch for type member "*":
Expected: IOError
Got:   Impl(Fn(y : i32) -> i32)

file:///Users/yiyiwang/Workspace/Yo/std/prelude.yo:5452:10:
  Box(V)(value)
```

The `forall(V : Type)` parameter of `box` ends up bound to `IOError` instead
of being inferred from the argument's type (`Impl(Fn(y : i32) -> i32)`).

## Reproducer

```rust
open import "std/libc/stdio";
__x :: import "std/env";   // any of std/env, std/process, std/process/command, std/sys/errors

main :: (fn() -> unit) {
  x := 1;
  (closure : Dyn(Fn(y : i32) -> i32)) =
    dyn(box((y) => { return (x + y); }));
};
export main;
```

Without the `__x :: import "std/env";` line, the file compiles fine. With it,
the type mismatch error fires.

## Bisect

First bad commit: `c6e7a8eb` ("Add Command wrapper, split std/env from std/process").
That commit added `std/process/command.yo` which imports `std/sys/errors`.
The new test runner injects `__yo_batch_env :: import "std/env";` which
transitively imports `std/process/command.yo` → `std/sys/errors.yo`.

## Likely root cause

Importing `std/sys/errors.yo` evaluates:

- `impl(IOError, Error())`
- `impl(IOError, ToString(...))`
- `impl(IOError, check : ... exn.throw(dyn Self.from_errno(i32(0) - result)) ...)`

One of these specializations seems to mutate a shared `SomeType` instance
belonging to `box`'s `forall(V : Type)`, setting `V.resolvedConcreteType =
IOError`. Subsequent calls to `box(...)` from any other module then see V
already-bound and fail to re-infer.

Suspect: the `dyn Self.from_errno(...)` body in `IOError.check` causes a
specialization of `box` (via auto-boxing inside `dyn`) and somehow leaks the
binding into the global cached function value for `box`.

## Affected tests

`tests/closure.test.yo` — all 8 tests fail (uses `box(closure)`,
`dyn box(closure)` patterns). All other tests pass because they don't
combine `box(closure)` with `import "std/env"`.

## Workaround

None at the user level — anyone importing std/env (or anything that pulls
in std/sys/errors) cannot use `box(closure)` afterwards.

## Investigation log

Added instrumentation at all `resolvedConcreteType =` mutation sites in
`src/evaluator/types/synthesizer.ts`, `src/evaluator/calls/function-type.ts`,
and `src/evaluator/values/anonymous-function.ts`. None of them fired with
`name === "V"` during the failing compile.

Added instrumentation in `src/evaluator/calls/type.ts` at the type-member
mismatch site. That fired with:

```
[DEBUG-TM] Box value mismatch: expected IOError got Impl(Fn(y : i32) -> i32)
[DEBUG-TM] memberElement.type id: enum_yode02de59_id_2
```

So at the point of the failure, `Box`'s `(*) : V` field has been substituted
to `(*) : IOError` (concrete enum type). The `box`'s body is
`Box(V)(value)` and the inner `Box(V)` call must have produced an object
type with V already bound to IOError.

`comptime-fn.ts` caches called-comptime-function results keyed by funcId +
argValues (with strict identity for SomeTypes — see lines 117-148). The
cache should NOT match a `Box(IOError)` (concrete) against a `Box(V)`
(SomeType) call. The comptime fn body is also cloned per call (line 182:
`body: cloneExpr(functionBodyExpr)`), so `expr.$` shouldn't leak between
calls.

The leak source remains unidentified. Possible candidates not yet ruled out:

- `src/evaluator/builtins/impl-constraint.ts:132` — sets
  `someType.resolvedConcreteType = concreteType` for `Impl(...)` types.
- Closure type wrapper logic in `src/evaluator/calls/closure-type.ts:222`
  which mutates `wrapperType.resolvedConcreteType`.
- `src/evaluator/calls/helper.ts:1325` — only effects-row, but worth
  confirming.
- Some path in `src/evaluator/values/dyn.ts` auto-box that mutates a shared
  type identity when constructing `Dyn(...)`.

## Status: OPEN, deferred

This is a pre-existing regression introduced by `c6e7a8eb`, not caused by
recent bootstrapping work. It only affects `tests/closure.test.yo` and
`tests/fn.test.yo` which use `dyn(box(closure))` patterns. No other tests
are affected because they either don't use `box(closure)` or don't import
modules that transitively pull in `std/sys/errors`.

Recommend tackling this as a focused debugging session with more time.
