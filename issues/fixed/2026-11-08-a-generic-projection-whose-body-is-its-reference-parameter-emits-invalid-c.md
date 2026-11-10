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

## Fixed

**Root cause.** A specialized generic body was never checked against the
projection result rule (decision 24: a `-> &T` body yields a place written
`&place`). The concrete body was; the specialization went straight to codegen,
where the bare `x` of type `&T` read as `T` and emitted `return (*__yo_v_x);`
from a C function returning `T*`. It is the same hole as
`2026-11-08-a-generic-fn-forwarding-a-projection-call-as-its-reference-tail-emits-a-value.md`.

**Fix.** #1838 (`f23081973`) gives a specialized generic body the concrete
body's decision-24 check (`calls/helper.yo`). On a develop build (`b5e6881c3`)
the reproducer is rejected in the evaluator with the same message as its
monomorphic twin ("this body has type `i32`"), so no invalid C is emitted. The
issue's "Expected" premise, that R1 makes the bare `x` a valid projection body
in both forms, does not hold: R1 (#1805) reads a reference binding as the
reference where a `&T` slot, payload, field or binder expects one, and a
projection body's tail is the place-lend position, not one of those; both the
generic and the monomorphic form are rejected alike and the accepted spelling
is `&x.*`. Whether a bare reference parameter should also be a projection tail
is a design question (recorded in the lane's hand-back), not this bug.

**Test.** `tests/ref_return_ban.test.yo`: the generic bare-`x` body is a
compile error ("this body has type"), and `&x.*` returns the place for `i32`
and a move-only `String`.

## Superseded 2026-11-10 (VERDICTS-45)

The bare body is accepted, in both forms: `(fn(generic(T), x : &T) -> &T)(x)` and `&x.*` are valid, as this issue's original "Expected" said. A function result declared `&T` is a reference slot (R1, decision 43 step 2), so a bare reference binding is the reference. The sentence above that a projection body's tail is "the place-lend position, not one of those" is overruled. The per-instantiation check of the fix above stays: it is what makes the generic form checked at all (P8, `tests/ref_return_ban.test.yo` `rrb_id_bare` beside `rrb_id`).
