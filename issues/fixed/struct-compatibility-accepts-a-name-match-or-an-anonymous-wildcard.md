# Struct compatibility accepts a bare name match or an anonymous-struct wildcard, so `check` passes unsound programs

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 3).
**Status:** FIXED 2026-09-25 (Phase 3.2 of `plans/TYPE_SYSTEM_SOUNDNESS.md`). Was: green `yo check`; clang error or ICE in `yo compile`.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro 1: two modules each export a differently-shaped `P`

`n1.yo`:

```rust
P :: struct(x : i32);
export(P);
```

`n2.yo` (note the leading blank line, so the declaration position differs):

```rust

P :: struct(s : bool, t : f64);
export(P);
```

`main.yo`:

```rust
pragma(Pragma.AllowUnsafe);
{ printf } :: import("std/libc/stdio");
{ P : P1 } :: import("./n1.yo");
{ P : P2 } :: import("./n2.yo");
take :: (fn(p : P1) -> i32)(p.x);
main :: (fn() -> unit)({
  q := P2(s : true, t : f64(1.0));
  unsafe(printf("%d\n", take(q)));
  ()
});
export(main);
```

`yo check` rc=0. clang: `passing '__yo_t_1243…' to parameter of incompatible type '__yo_t_3814…'`.

## Repro 2: an anonymous record with different fields assigned to a named struct

```rust
A :: struct(x : i32);
main :: (fn() -> unit)({
  r := { y : true, z : f64(2.5) };
  (a : A) = r;
});
```

`yo check` rc=0; `yo compile`: `internal compiler error: Failed to transpile part of main's body`.

## Measured relation (via `Type.is_compatible_with` / `Type.eq`)

| Pair | compatible | eq |
| --- | --- | --- |
| `A :: struct(x : i32)` vs `B :: struct(x : i32)` | 0 | 0 |
| anonymous `struct(y : bool)` vs `A` | **1** | 0 |
| anonymous `struct(x : i32)` vs anonymous `struct(y : bool, z : f64)` | **1** | – |
| `newtype(v : i32)` vs anonymous `struct(v : i32)` | **1** both ways | 0 |
| `ref(struct(x : i32))` vs anonymous `struct(x : i32)` | **1** | 0 |
| `enum(Blue)` vs `E1 :: enum(Red, Green)` | **1** | – |
| `union(a : i32)` vs `union(b : f64, c : u8)` | by name only | – |

The relation is not transitive: an anonymous `struct(x : i32)` is compatible with both `A` and
`B`, while `A` is not compatible with `B`.

## Mechanism (READ)

`src/types/compatibility.yo` (~734): a struct/enum whose stamped name is empty is a wildcard, and
two structs with the same *name* are accepted without comparing ids or fields. Unions compare by
name only.

## Fix direction

Require equal ids, or, for an anonymous side, field-wise compatibility including field names and
count. Never accept on a name match alone. Treat `newtype` as nominal against anonymous records.
Compare union fields.

## Fix (2026-09-25)

`src/types/compatibility.yo`, the Struct, EnumT and Union arms of `_compat_impl`, following the
rules written down in `plans/reference/TYPE_IDENTITY.md`:

- Flow (lenient): one declaration (equal non-empty ids) is accepted. Two different declarations
  are one type only when their shapes agree. An empty name is no longer a wildcard, and an equal
  name is no longer a pass: two modules' `P` with different fields are rejected ("These are two
  different types with the same name: the expected one is declared in …, the given one in …").
  The kind is part of the shape, so a value record, a `ref` object, an atomic object and a
  `newtype` never stand in for each other. A side still carrying a SomeT keeps the structural
  comparison (a def-time placeholder).
- Identity (exact): a named declaration is never identical to an anonymous record, and two ids
  that are both empty are no longer "the same id".
- Enums: different declarations must agree on their variant names (`enum(Blue)` is not
  `E1 :: enum(Red, Green)`).
- Unions: the fields are compared.

What the old wildcard was hiding: `Type.get_info` bound its `ComptimeList(VariantInfo)` (and
`FunctionInfo`) temporaries with `type_of_eval_value` of the first element, a type rebuilt from
field VALUES (no id, `comptime_int` for a `usize` field). The prelude's own `derive(Pragma,
Eq(Pragma))` failed with the wildcard gone. `src/evaluator/builtins/type_fns.yo` now binds them
with the declared type.

`tests/type_soundness.test.yo` runs both repros (the two-module one through
`tests/fixtures/soundness_p1.yo` / `soundness_p2.yo`), every row of the measured table, and a
canary that an anonymous record with the same fields still flows into a named struct.
