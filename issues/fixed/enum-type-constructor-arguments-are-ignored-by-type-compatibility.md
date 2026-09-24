# Enum type-constructor arguments are ignored by compatibility: `Value(i32)` flows into `Value(bool)`

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 1).
**Status:** FIXED 2026-09-24 (Phase 1.1 of `plans/TYPE_SYSTEM_SOUNDNESS.md`) for Repros 1–3: an
enum instantiation's type arguments are part of its identity, and a GADT variant constructs only
the instantiation its index names. The fourth finding (a GADT arm body checked under its
refinement only when some caller instantiates that index) is split out as
`issues/gadt-arm-is-type-checked-only-when-its-index-is-instantiated.md`, because it is the
deferred-generic trial's swallow (Phase 6), not a compatibility question.
Originally: OPEN, **critical soundness hole**: GADT indices and phantom enum parameters were not
part of type identity, so a program could read an `i32` through a `bool`-typed binding.
**Measured:** yo 0.2.39 seed; re-verified on a develop build `d455b6a67` (same results, except Repro 2's printed value).

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
omits the `BoolVal` arm (correctly, per GADT refinement), and the match falls off: the program
prints `0` with the seed and `1` with the develop build, an unspecified value.

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

## Root cause (confirmed)

`EnumT` carries no type arguments (unlike `Struct.type_arguments`), and the compatibility relation
had nothing else to tell two instantiations apart when no variant payload mentions the parameter:
`Value(i32)` and `Value(bool)` have identical variant fields, both lenient and exact comparison
accepted the pair. CTFE mints a fresh enum id per instantiation (`stable_type_id` in
`src/evaluator/types/enum.yo`), so the fact could be recorded beside the type, keyed by id, the
same way the enum cfid and the GADT tables already are. Construction had no index check at all.

## Fix

- `src/types/creators.yo`: `register_enum_type_arguments` / `lookup_enum_type_arguments`, an
  id-keyed side table of the constructor arguments an enum instantiation was minted with.
- `src/evaluator/calls/comptime_fn.yo`: the comptime-fn return registers them for an enum minted
  in CTFE (not for a module-level `enum_decl_` returned by an alias constructor), next to the
  existing cfid stamp. The CTFE memo's era equality also requires equal recorded arguments, so
  `P(i32)` and `P(bool)` are two memo keys.
- `src/types/compatibility.yo`, `EnumT` arm: two instantiations whose recorded arguments disagree
  are different types under both rules. Substitution rewrites an instance's variant fields but
  keeps its id, so a substituted instance still reports definition-era arguments; a position that
  mentions a SomeT anywhere is therefore a wildcard (the first cut used the top-level-only
  `type_contains_some_type` and rejected 85 correct sites in `check ./src`, all
  `?(*(MapEntry(K, V)))` against `?(*(MapEntry(String, String)))`).
- `src/evaluator/exprs/property_access.yo`: `Type.Variant` and the `.Variant` shorthand reject a
  GADT variant whose `-> recur(...)` index is not the instantiation's (`gadt_branch_reachable`),
  with E0601: `GADT variant "BoolVal" is declared -> recur(bool), so it cannot construct a
  Value(i32)`.

## Verification

- Repros 1 and 3: E0601 at the binding (`Expected: Value(bool)`, `Given: Value(i32)`). Repro 2:
  E0601 at the construction.
- `tests/type_soundness.test.yo`: four rejections plus a same-index canary (a same-index GADT
  value, a same-index phantom value and the `.BoolVal(true)` shorthand at the declared index all
  still flow). `tests/gadts.test.yo` stays green (10 passed).
- `check ./std` 176/176 and `check ./src` 279/279 with the tree-built compiler.
