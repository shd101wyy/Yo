# Enum type-constructor arguments are ignored by compatibility: `Value(i32)` flows into `Value(bool)`

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 1).
**Status:** OPEN. **Critical soundness hole**: GADT indices and phantom enum parameters are not
part of type identity, so a program can read an `i32` through a `bool`-typed binding.
**Measured:** yo 0.2.39 seed.

## Repro 1: GADT index laundering (runs, wrong type)

```rust
{ println } :: import("std/fmt");
Value :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntVal(i : i32) -> recur(i32),
    BoolVal(b : bool) -> recur(bool),
    PairVal(a : i32, b : bool) -> recur(i32)
  )
);
eval_value :: (fn(generic(T : Type), v : Value(T)) -> T)(
  match(v, .IntVal(i) => i, .BoolVal(b) => b, .PairVal(a, b) => a));
main :: (fn() -> unit)({
  x := Value(i32).IntVal(i32(77));
  (y : Value(bool)) = x;
  r := eval_value(y);
  println(r);
});
export(main);
```

`yo check` OK, `yo compile` OK, prints `77` from a `bool`-typed `r`.

## Repro 2: wrong-index construction, match falls off

With `Value` from Repro 1:

```rust
only :: (fn(v : Value(i32)) -> i32)(
  match(v, .IntVal(i) => i, .PairVal(a, b) => a));
main :: (fn() -> unit)({ x := Value(i32).BoolVal(true); println(only(x)); });
```

`Value(i32).BoolVal(true)` is accepted even though `BoolVal` constructs `Value(bool)`. `only`
omits the `BoolVal` arm (correctly, per GADT refinement) and the program prints `0`.

## Repro 3: a plain phantom enum

```rust
P :: (fn(comptime(T) : Type) -> comptime(Type))(enum(A(x : i32), B(y : bool)));
main :: (fn() -> unit)({ x := P(i32).A(i32(1)); (y : P(bool)) = x; });
```

Accepted. The same shape with a `struct` is rejected, as is an enum whose `T` appears in a
payload, so only enums with an index that no payload mentions are affected.

## Mechanism (READ)

The lenient `EnumT` arm of `src/types/compatibility.yo` (~890-955) compares the enum name and the
concrete variant payloads. It never compares the recorded type-constructor arguments, and
construction never checks the `-> recur(...)` index against the requested instantiation.

Also measured (same area): a GADT arm body that is wrong under refinement is rejected only when
some caller instantiates that index; when the function is never called at `T = bool` the wrong
`.BoolVal(b) => i32(7)` arm is accepted (`src/evaluator/exprs/match.yo` ~581 skips unreachable
arms). `tests/gadts.test.yo` has no negative test.

## Fix direction

1. Compare the constructor id and type arguments in the `EnumT` arm, both exact and lenient.
2. At `Value(i32).BoolVal(...)`, check the variant's declared index against the instantiation.
3. Type-check each GADT arm once at definition time with `T` refined to the variant's index.
4. Add `comptime_expect_error` tests for all three repros to `tests/gadts.test.yo`.
