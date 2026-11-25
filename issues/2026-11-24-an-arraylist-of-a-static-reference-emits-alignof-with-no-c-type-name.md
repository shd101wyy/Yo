# An `ArrayList` of a static reference to a sized type emits `_Alignof` with no C type name

**Severity:** S2 (a valid program does not compile: the emitted C is rejected by the C compiler).

**Status:** OPEN. Found 2026-11-24 by the P12 lane (VERDICTS-74) on `v0280/p12-static-origin`. Safe code
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

## Root cause (not yet traced)

`ArrayList`'s growth path calls an allocation function with the element's alignment, and the C name of the
type argument `&X` (a reference to a sized type, which C lowers to `X *`) is not resolved at that
`_Alignof` site: the type-name helper has no arm for a reference type argument there.

## The test

The repro as a row of `tests/unsized-places.test.yo` (beside the `ArrayList(&(str, static))` row) once fixed.
