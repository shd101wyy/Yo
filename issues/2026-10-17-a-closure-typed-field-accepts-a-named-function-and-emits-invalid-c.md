# A field typed by a closure's identity accepts a named function, passes `check` and emits invalid C

**Severity:** S2 — `Arc(type_of(k))(f)` / `Holder(type_of(k))(f : f)` with `k` a closure and `f` a named function of the same signature type-check, then die in the C compiler; through `Arc` it also seats a function that `Send` never judged inside a `Send` type.

**Status:** OPEN. **Found:** 2026-10-17, probing the soundness of
`issues/arc-of-a-named-function-value-fails-its-send-bound.md`, on develop
5425cd7bf.

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

## Direction

Make a SomeT that carries a resolution compare by its resolution in the
concrete-actual rule, as the SomeT-actual rule already does a few lines below
it. A concrete `fn` is then incompatible with a resolved closure identity, and
an unresolved bound keeps today's trait test.

The regression test needs two cases:
- the repro's constructions are refused at `check`;
- `Holder(type_of(k))(f : k)` still compiles.
