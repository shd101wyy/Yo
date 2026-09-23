# Struct compatibility accepts a bare name match or an anonymous-struct wildcard, so `check` passes unsound programs

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 3).
**Status:** OPEN. Green `yo check`; clang error or ICE in `yo compile`.
**Measured:** yo 0.2.39 seed.

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
