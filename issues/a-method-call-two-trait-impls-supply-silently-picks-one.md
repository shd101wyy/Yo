# A method call that two trait impls supply silently picks one of them

**Status:** OPEN
**Found:** 2026-09-27, Dyn upcast feasibility audit (the concrete twin of
`issues/two-traits-sharing-a-method-name-in-one-dyn-emit-a-duplicate-c-wrapper.md`).
**Measured:** yo 0.2.44 seed: `check` rc=0, `compile` rc=0, prints `1`.
**Repro:** `issues/repros/a-method-call-two-trait-impls-supply-silently-picks-one.yo`

## Symptom

```rust
A :: trait(get : (fn(self : Self) -> i32));
B :: trait(get : (fn(self : Self) -> i32));
C :: ref(struct(n : i32));
impl(C, A(get : (self -> i32(1))));
impl(C, B(get : (self -> i32(2))));
main :: (fn() -> unit)({
  c := C(n : i32(0));
  println(`${c.get()}`);   // prints 1: A's impl, chosen by registration order
});
```

`docs/en-US/DESIGN.md` §Trait Method Disambiguation documents a `where(T <: T1)` bound and the
qualified `(T <: T2).get_number(self)` form for choosing between two same-named trait methods,
but an unqualified call on a concrete receiver with no bound is not rejected: which method runs
depends on impl registration order, so reordering two `impl` lines changes the program's output
without any diagnostic.

## Fix direction

An unqualified method call with two or more applicable trait methods (and no inherent method,
and no `where` bound selecting one) is an ambiguity error that names the traits and suggests the
qualified form, like Rust's E0034.
