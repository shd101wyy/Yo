# An untyped trait-member literal on a generic `Box(Self)` enum emits mismatched C types

**Severity:** S2 — a valid program (a generic `Eq` impl, spelled with an untyped `(lhs, rhs) -> ...` literal, on a type-constructor enum with a `Box(Self)` payload) passes `check` and fails in the C compiler with incompatible pointer types.

- Filed: 2026-11-20 (fix-forward lane for develop battery 44642495937). Found while looking for a Case 2 (generic impl) twin of `issues/fixed/2026-11-20-a-forced-impl-member-s-phase-a-flag-is-lost-on-its-evaluation-copy.md`. It is not that bug: the v0.2.78 seed, before R7, fails the same way.

## Reproducer

```yo
{ println } :: import("std/fmt");
GKind :: (fn(comptime(T) : Type) -> comptime(Type))(enum(Leaf(v : T), Node(elem : Box(Self))));
impl(
  generic(T : Type),
  GKind(T),
  Eq(GKind(T))(
    (==) : ((lhs, rhs) -> match(lhs, .Leaf(a) => match(rhs, .Leaf(b) => true, _ => false), .Node(l) => match(rhs, .Node(r) => true, _ => false)))
  )
);
main :: (fn() -> unit)({
  k := GKind(i32).Node(elem : Box.new(GKind(i32).Leaf(v : i32(1))));
  j := GKind(i32).Node(elem : Box.new(GKind(i32).Leaf(v : i32(1))));
  println(k == j);
});
export(main);
```

`yo compile` (v0.2.78 and develop `69f09baf4`):

```text
error: incompatible pointer types initializing '__yo_t_17135565237059852713 *' (aka 'struct __yo_t_5777471296560871647_struct **') with an expression of type '__yo_t_13381878362195104926 *' (aka 'struct __yo_t_17332834872344324894_struct **')
error: incompatible pointer types passing '__yo_t_5777471296560871647 *' ... to parameter of type '__yo_t_17332834872344324894 *'
yo: error: compile: C compiler failed (exit 1)
```

## What is known

Each of these variants compiles and runs correctly:

- the member spelled `(fn(lhs : &Self, rhs : &Self) -> bool)(...)` with the same body;
- the payload changed from `Box(Self)` to `i32`;
- the untyped literal with a body of `true` (no `match` binding the `Box(Self)` payload);
- a concrete (non-generic) enum with the same untyped literal (`tests/impl.test.yo`, `SelfEqKind`).

Two struct types reach C for what should be one `GKind(i32)` (or its `Box` cell): the untyped literal's parameter types are inferred from the trait with `Self` substituted to the receiver pattern, and the `Box(Self)` payload binding appears to mint a second instantiation. Not investigated further.
