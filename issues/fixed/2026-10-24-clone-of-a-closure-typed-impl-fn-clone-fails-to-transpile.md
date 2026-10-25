# `k.clone()` on a closure typed `Impl(Fn(...), Clone)` fails to transpile

**Severity:** S2: a valid program passes `yo check` and then stops at `yo compile` with an internal compiler error (E1301, "Failed to transpile part of main's body"); inside a non-`main` function the call becomes an abort stub instead. The same closure typed `Impl(Fn(...))` clones fine.

**Status:** FIXED 2026-10-24 (`feat/b12-dyn-gen-a`). **Found:** 2026-10-24, while making `Dyn(Fn(...), Clone)` clone its closure payload for B12 (plans/VALUES_BY_DEFAULT.md decision 7). The payload of a closure literal written straight into `dyn(...)` is typed by the `Dyn`'s payload wrapper, which lists `Clone`, so every such `Dyn` hit this. Develop `27431e4be` fails the same way.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
main :: (fn() -> unit)({
  s := String.from("abc");
  (k : Impl(Fn(x : i32) -> i32, Clone)) = ((x : i32) => (x + i32(s.len())));
  g := k.clone();
  println(k(i32(1)) + g(i32(2)));
});
export(main);
```

```text
error[E1301]: internal compiler error: Failed to transpile part of main's body — the emitted C for "__yo_user_main" contains an untranspiled expression, so the program would run without it
```

## Root cause

A closure's `clone` is structural (decision 36): `_try_structural_copy_clone` (`src/evaluator/calls/function.yo`) expands `k.clone()` to a capture-record rebuild, or to a copy when every capture is `Copy`. It ran only when the receiver method lookup missed. For an `Impl` that lists `Clone` itself, the lookup did not miss: it found `clone` as the `Impl`'s own required-trait method. No impl implements that method for a capture record, so codegen had nothing to call and emitted its `// Failed to transpile` marker.

## Fix

`_structural_clone_precedes_lookup` tries the structural expansion before the method lookup when the receiver is an `Impl` that resolves to a capture record or an anonymous record. Such a type has no impl that could answer instead. Tuples and arrays keep the prelude's element-wise impl.

The `Dyn` clone slot also specializes a closure literal's clone for an `Impl` identity (`_dyn_clone_payload_identity`, `src/evaluator/values/dyn.yo`). The `Dyn`'s nameless payload wrapper is not a closure identity, so without this the expansion would not fire for it.

## Tests

- `tests/closure.test.yo`, "a closure typed Impl(Fn(...), Clone) clones structurally". It covers a `String` capture (the rebuild) and an `i32` capture (the copy).
- `tests/dyn.test.yo`, "a Dyn(Fn(...), Clone) clones its closure". It covers a literal with a `String` capture, a literal with a `Copy` capture, and a typed binding.

Both fail before the fix and pass after it.
