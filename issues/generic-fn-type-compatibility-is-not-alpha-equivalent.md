# Generic function types are compared by BINDER NAME, not alpha-equivalence

**Status: OPEN. Not fixed — see "Why this is not a small fix".**

**Severity: type-system correctness (under-approximation).** Two generic
function types that differ only in the NAME of their `generic(...)` binder are
reported incompatible:

```
fn(generic(T : Type), x : T, y : T) -> T
fn(generic(Z : Type), a : Z, b : Z) -> Z      ->  NOT compatible
```

Rename `Z` back to `T` and the same pair is compatible, so the comparison is
keyed on the binder's identity rather than on its position.

**Found** 2026-09-05, by making `comptime_assert` fire inside a function body
(`issues/fixed/comptime-assert-never-fires-inside-a-function-body.md`).
`tests/comptime.test.yo`'s "Test types compatibility" has asserted the
alpha-equivalent answers since it was written; the assertions had never run.

## Reproducer

```rust
{ println } :: import("std/fmt");
MyBox :: (fn(comptime(T) : Type) -> comptime(Type))(struct(value : T));
Point :: (fn(comptime(T) : Type) -> comptime(Type))(struct(x : T, y : T));
_5  :: __yo_are_types_compatible(fn(generic(T : Type), x : T, y : T) -> T, fn(generic(Z : Type), a : Z, b : Z) -> Z);
_5b :: __yo_are_types_compatible(fn(generic(T : Type), x : T, y : T) -> T, fn(generic(T : Type), a : T, b : T) -> T);
_8  :: __yo_are_types_compatible(fn(generic(T : Type), x : T) -> MyBox(T), fn(generic(Z : Type), a : Z) -> MyBox(Z));
_9  :: __yo_are_types_compatible(fn(generic(T : Type), x : T, y : T) -> Point(T), fn(generic(Z : Type), a : Z, b : Z) -> Point(Z));
main :: (fn() -> unit)({
  println(`generic T vs generic Z = ${_5}    want true`);
  println(`generic T vs generic T = ${_5b}   want true`);
  println(`MyBox(T)  vs MyBox(Z)  = ${_8}    want true`);
  println(`Point(T)  vs Point(Z)  = ${_9}    want true`);
});
export(main);
```

Measured on v0.2.24 and on this tree (PR #429 + the `comptime_assert` fix) —
identical, so it is neither a regression nor caused by either change:

```
generic T vs generic Z = false    want true     WRONG
generic T vs generic T = true     want true     ok
MyBox(T)  vs MyBox(Z)  = false    want true     WRONG
Point(T)  vs Point(Z)  = false    want true     WRONG
```

The concrete cases in the same test are all correct
(`fn(x : i32, y : i32) -> i32` vs `fn(a : i32, y : i32) -> i32` is `true`;
generic-vs-concrete is `false` both ways; `*(i32)` params compare `true`).

## Root cause

`src/types/compatibility.yo`'s `.Func` arm compares `forall_types` pairwise
with the ordinary recursion. A `generic(T : Type)` binder is a `SomeT` with its
own identity, so the pair `SomeT(T)` / `SomeT(Z)` is compared as two unrelated
placeholder types and falls through to `false`. The same identity leaks into
the parameter and result positions, and into the `type_arguments` of an
instantiation (`MyBox(T)` vs `MyBox(Z)`).

## Why this is not a small fix

Alpha-equivalence needs a BINDER CORRESPONDENCE threaded through the whole
comparison — `are_types_compatible` would have to carry a `T ↦ Z` map and
consult it at every `SomeT` leaf, including the ones buried in a struct's
`type_arguments`. That routine is not only the assignability check: with
`require_exact` it is also the **cache-identity** predicate for comptime-fn
instantiations. Making two distinct `SomeT`s compare equal there is exactly the
collision class the file's own comments record — `(?*)(MapEntry(String,
ArrayList(ME)))` colliding with a cached `(?*)(ME)`, and
`issues/fixed/lenient-generic-enum-compatibility-by-name.md`. A correct fix has
to keep the correspondence LOCAL to a single `.Func` pair and must not relax
`SomeT` identity anywhere else, and it needs cache-collision canaries before it
can be trusted.

That is a separate piece of work from the `comptime_assert` fix that revealed
it, so it is filed rather than attempted there.

## What the tests do meanwhile

`tests/comptime.test.yo`'s "Test types compatibility" now asserts the MEASURED
answers with a comment naming this issue and the answer each case should give.
They stay live assertions on purpose: when alpha-equivalence lands, those three
go red, and that red is the reminder to restore them to `true`.
