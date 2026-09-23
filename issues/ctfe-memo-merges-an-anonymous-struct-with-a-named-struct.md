# The CTFE instantiation memo merges types that are not equal, so `Type.eq` and instantiations depend on call order

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 3).
**Status:** OPEN. Wrong answers from type reflection, a spurious E0610, and a SIGSEGV, each
depending only on which instantiation ran first. This is a live, reproduced sibling of the
hypothesis in `issues/ctfe-memo-shared-struct-id-fast-path-smell.md`, through a different
predicate.
**Measured:** yo 0.2.39 seed.

## Repro 1: `Type.eq` depends on what ran before it

```rust
pragma(Pragma.AllowUnsafe);
{ printf } :: import("std/libc/stdio");
A :: struct(x : i32);
B :: struct(x : i32);
main :: (fn() -> unit)({
  unsafe(printf("anon eq: %d\n", i32(cond(Type.eq(struct(x : i32), struct(x : i32)) => 1, true => 0))));
  unsafe(printf("A eq B: %d\n", i32(cond(Type.eq(A, B) => 1, true => 0))));
  ()
});
export(main);
```

In this order both lines print `1`. Swap the two lines and both print `0`. `A` and `B` are
distinct nominal types, so `0` is right; `docs/en-US/TYPE_REFLECTION.md`'s own `Type.neq(A, B)`
example therefore depends on what ran first.

## Repro 2: an instantiation adopts an earlier, different one

```rust
Wrap :: (fn(comptime(T) : Type) -> comptime(Type))(struct(inner : T));
A :: struct(x : i32);
impl(A, show : (fn(self : Self) -> i32)(self.x + i32(100)));
main :: (fn() -> unit)({
  (w0 : Wrap(struct(x : i32))) = Wrap(struct(x : i32))(inner : { x : i32(1) });
  (w1 : Wrap(A)) = Wrap(A)(inner : A(x : i32(2)));
  unsafe(printf("%d\n", w1.inner.show()));
  ()
});
```

(with the `pragma`/`printf` header of Repro 1) fails with `E0610 No matching call ...
w1.inner.show()`. Delete the `w0` line and it prints `102`.

## Repro 3: the same with fn types ends in SIGSEGV

```rust
Wrap :: (fn(comptime(T) : Type) -> comptime(Type))(struct(inner : T));
by_val :: (fn(x : i32) -> unit)({ x; () });
bump :: (fn(inout(x) : i32) -> unit)({ x = (x + i32(1)); () });
main :: (fn() -> unit)({
  (w0 : Wrap((fn(x : i32) -> unit))) = Wrap((fn(x : i32) -> unit))(inner : by_val);
  (w1 : Wrap((fn(inout(x) : i32) -> unit))) = Wrap((fn(inout(x) : i32) -> unit))(inner : bump);
  (v : i32) = i32(5);
  w1.inner(v);
  unsafe(printf("v=%d\n", v));
  ()
});
```

With the same header, this compiles and the binary exits rc=139. `Wrap(fn(inout(x) : i32) -> unit)` was served the by-value
instantiation.

## Mechanism (READ)

`_ctfe_args_equal` (`src/evaluator/calls/comptime_fn.yo` ~195-280) falls back to
`are_types_compatible_exact`, and the exact relation (`src/types/compatibility.yo`) treats:

- an anonymous struct as equal to a named struct with the same fields (the empty name is a
  wildcard, ~734);
- `fn(inout(x) : i32)`, `fn(own(x) : i32)` and `fn(x : i32, using(io : i32))` as equal to
  `fn(x : i32)` (the `FuncMeta` flags and implicit params are not compared);
- `Tuple(a : i32, b : bool)` as equal to `Tuple(c : i32, d : bool)`;
- `Dyn(Speak, Run)` as equal to `Dyn(Speak)`, but not the reverse (subset check in both modes,
  ~1170).

## Fix direction

The memo needs a true identity predicate, not "exact compatibility". Either key it on the
codegen type key, or make exact mode reject a named-vs-anonymous pair, compare `FuncMeta` flags,
implicit params and tuple labels, and require equal trait sets for `Dyn`.
