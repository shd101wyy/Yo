# An `ArrayList` of a static reference to a sized type emits `_Alignof` with no C type name

**Severity:** S2 (a valid program does not compile: the emitted C is rejected by the C compiler).

**Status:** FIXED (branch `fix/p12-t6-static-store`, 2026-11-25). Found 2026-11-24 by the P12 lane (VERDICTS-74) on `v0280/p12-static-origin`. Safe code
can spell `ArrayList(&(X, static))` only once P12 lands; before #2053 the push below stopped at a bogus
E0901 in a pragma'd file, so the codegen path was not reached.

## The repro

```yo
{ assert } :: import("std/assert");
{ ArrayList } :: import("std/collections/array-list");
X :: struct(n : i32);
G := X(n : i32(7));
main :: (fn() -> unit)({
  mut(xs) := ArrayList(&(X, static)).new();
  xs.push(&G);
  assert(xs.len() == usize(1), "pushed");
});
export(main);
```

`yo check` accepts it; `yo compile` fails in the C compiler:

```text
error: expected expression
  yo_id_3201847264520963415000000(_file____home_temp_..., _file____home_temp_..., _Alignof(/* Error: no C type name for &X */));
```

The same element type in a user container (`Box1(&(X, static))` with a `put(self : &mut Self, v : T)` method
called as `b.put(&G)`) compiles and runs, and `ArrayList(&(str, static))` (a view slot) compiles.

## Root cause

`ArrayList`'s growth path calls an allocation function with `align_of(T)`. The evaluator folds a known alignment
to a constant, but `get_alignment_of_type` has no arm for a reference (only `get_size_of_type` does), so
`align_of(&X)` stays a call and codegen emits `_Alignof(<T>)` (`generate_alignof`). `T` is a type value, which
`generate_comptime_value` lowers through the collected-type registry, and a reference type is never registered
there (`get_type_string` spells it structurally, `X const *`). `ArrayList(&(str, static))` compiled because
`&str` has its own `__yo_str` arm before the registry lookup. Before P12, `ArrayList(&X)` was E0909 and the
static spelling was confined to pragma'd files, so no program reached the path.

## The fix

`generate_comptime_value`'s `TypeVal` arm lowers a reference type through `get_type_string`, beside the
primitive, SomeT and extern-opaque arms that are never in the registry either
(`src/codegen/exprs/comptime-value.yo`). The evaluator's alignment walk is unchanged: folding a reference's
alignment would also fold every aggregate holding one, a layout change this fix does not need.

## The test

`tests/unsized-places.test.yo`, "a generic container over a static reference stores static values": an
`ArrayList(&(X, static))` pushed `&G` twice (the second push grows the buffer), beside the
`ArrayList(&(str, static))` row.
