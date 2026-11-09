# A generic projection whose body is its reference parameter emits invalid C

**Severity:** S2 — the evaluator accepts the function and the C compiler
then rejects the emitted file. The program is not miscompiled. Writing the
body as `&x.*` avoids it.

Found 2026-11-08 while writing `tests/sized.test.yo` (decision 49 S1a).
Reproduces on develop 40e10e7e9, so it was not introduced by S1a.

## Repro

```yo
{ assert } :: import("std/assert");
_id_ref :: (fn(generic(T : Type), x : &T) -> &T)(x);
main :: (fn() -> unit)({
  n := i32(9);
  assert(_id_ref(&n).* == i32(9), "the place comes back");
});
export(main);
```

`yo compile` emits `return (*__yo_v_x);` from a C function whose result type
is `int32_t*`, and clang rejects the file:

```text
error: incompatible integer to pointer conversion returning 'int32_t' (aka 'int') from a function with result type 'int32_t *'
```

The monomorphic twin, `(fn(x : &i32) -> &i32)(x)`, is decided in the
evaluator. Before decision 43's R1 read rule (#1805) it was rejected with the
projection message ("its result is a place … written `&place`"). Under R1,
a reference read where a `&T` slot expects one is the reference value, so
the body is valid and should emit `return __yo_v_x;`.

## Expected

The generic and the monomorphic function behave the same: both are accepted
under R1 and return the pointer itself.

## Notes

The generic body is evaluated when the function is called, so the
specialized body does not take the path the definition-time projection check
takes. Re-check this on a tree that carries #1805 before fixing it.
