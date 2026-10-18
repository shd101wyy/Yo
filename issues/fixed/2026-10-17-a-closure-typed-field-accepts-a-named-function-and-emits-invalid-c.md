# A field typed by a closure's identity accepts a named function, passes `check` and emits invalid C

**Severity:** S2 — `Arc(type_of(k))(f)` / `Holder(type_of(k))(f : f)` with `k` a closure and `f` a named function of the same signature type-check, then die in the C compiler; through `Arc` it also seats a function that `Send` never judged inside a `Send` type.

**Status:** FIXED 2026-10-18. **Found:** 2026-10-17, probing the
soundness of `issues/arc-of-a-named-function-value-fails-its-send-bound.md`,
on develop 5425cd7bf.

## Repro

```yo
{ println } :: import("std/fmt");
seven :: (fn() -> i32)(i32(7));
Holder :: (fn(comptime(T) : Type) -> comptime(Type))(struct(f : T));
main :: (fn() -> unit)({
  n := i32(3);
  (k : Impl(Fn() -> i32)) = (() => n);
  a := Arc(type_of(k))(seven); // check: OK
  h := Holder(type_of(k))(f : seven); // check: OK
  g := h.f;
  println(g());
  a;
});
export(main);
```

`yo check` accepts it, and `yo compile` fails in the C compiler:

```
error: passing 'int32_t ()' (aka 'int ()') to parameter of incompatible type '__yo_t_…' (aka 'struct __yo_t_…_struct')
error: incompatible pointer to integer conversion initializing 'int32_t' (aka 'int') with an expression of type 'int32_t ()'
```

## Analysis

- **The field's type is the closure's identity.** That is its `Impl(Fn() -> i32)`
  SomeT, resolved to `k`'s capture struct (plans/reference/TYPE_IDENTITY.md).
- **The argument is a concrete `fn() -> i32`.** `are_types_compatible`'s
  "Concrete (actual) vs SomeType (expected)" rule
  (`src/types/compatibility.yo`) accepts any concrete type that implements the
  SomeT's required traits. `fn() -> i32` implements `Fn() -> i32`, so the
  construction type-checks.
  - The rule never consults the SomeT's resolution.
  - A resolved closure identity is one specific type, not an open bound. Two
    closures are two types, and a named function is a third.
- **Codegen then receives a function pointer where the capture struct goes.**
- **It is also a `Send` hole that the evaluator lets through.**
  - The repro's dirty variant puts a function that pushes to a global
    `ArrayList` into `Arc(type_of(k))`, where `k` captures only an atomic.
  - It spawns a thread that calls `a.*`, and `check` accepts it.
  - Only the C compiler stops it today, so a codegen fix alone would turn it
    into a real data race.
- `(k2 : type_of(k)) = seven` does compile and run, because a local adopts the
  right-hand side's type. Only a fixed slot, such as a struct field or a
  constructor parameter, keeps the identity and reaches the bad C.

## Fix

Exactly the direction below: `are_types_compatible`'s "Concrete (actual) vs
SomeType (expected)" rule (`src/types/compatibility.yo`) now hops to the
SomeT's `resolution` FIRST, comparing the concrete actual against it and
returning that comparison's verdict — a failed resolution-comparison no
longer falls through to the trait test, which was the hole. An UNRESOLVED
bound keeps today's trait test. This is step 1 of
`issues/retired/2026-10-17-how-a-named-function-value-carries-send.md`'s
verdict; step 2 (function-item types, after decision 43) is what lets a named
function itself cross a `Send` bound.

The `Send` hole closes with the seating: the dirty variant
(`Arc(type_of(k))` of a function that pushes to a global) is now E0601 at
`check`, so no codegen-only fix could turn it into a data race.

## Verification

- `tests/closure.test.yo` "a closure-typed field refuses a named function of
  the same signature": the `Holder(type_of(k))(f : <named fn>)` construction
  is a `comptime_expect_error`, and `Holder(type_of(k))(f : k)` still seats,
  calls and returns `3`. Fails before the fix (the seed evaluates the
  construction cleanly), passes after.
- `tests/parallelism_soundness.test.yo`
  `_d9_arc_of_named_fn_in_a_closure_slot`: `Arc(type_of(k))(_d9_push)` is a
  `comptime_expect_error` (the `Send`-bypass face). Also fails before, passes
  after.
- `check ./src` and `check ./std` green under the tree binary (no legitimate
  use of the old lenient rule in either tree).
