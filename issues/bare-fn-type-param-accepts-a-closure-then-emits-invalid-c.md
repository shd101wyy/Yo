# A bare `fn(...)` parameter accepts a closure at `check`, then emits invalid C

**Status:** OPEN
**Found:** 2026-08-25, auditing `.github/instructions/` for Impl/Dyn/closure accuracy —
two HKT examples there declared their callback parameter as a bare `fn(...)`.
**Severity:** medium. Loud (the C compiler rejects it), but `yo check` says OK,
so the fast gate gives false confidence.

## Symptom

```rust
takes_bare :: (fn(f : (fn(a : i32) -> i32), v : i32) -> i32)(
  f(v)
);
main :: (fn() -> unit)({
  k := i32(10);
  takes_bare(((y) => (y + k)), i32(5));   // a closure, not a named fn
  ();
});
```

```
$ yo check  ./tmp/barefn.yo      # rc=0 — PASSES
$ yo compile ./tmp/barefn.yo --release
/tmp/bf.out.c:1531:55: error: operand of type '__yo_t9' (aka 'struct __yo_t9_struct')
                       where arithmetic or pointer type is required
```

## Root cause

A bare `fn(a : i32) -> i32` parameter is a FUNCTION POINTER slot. A closure is a
capture struct (`__yo_t9` here), and codegen hands that struct straight into the
pointer slot, so the emitted C tries to call a struct.

The closure-carrying parameter forms are `Impl(Fn(...))` (monomorphized, capture
struct passed by value) and `Dyn(Fn(...))` (heap-boxed behind a refcount header,
called through a `{data, vtable}` fat pointer). std uses `Impl(Fn(...))` for every
callback.

A bare `fn(...)` parameter DOES work when the argument is a named top-level
function — that is the shape it is for.

## Why it matters

This is the "`check` is not a real gate" family (compare
issues/yo-self-async-await-argcount-overpermissive.md and
issues/cinclude-int-comparison-fails-to-transpile.md): the evaluator accepts a
program that codegen cannot emit, so `yo check` — the fast iteration loop, and what
CI's cheap legs run — reports success on code that cannot build.

The right fix is to REJECT a closure argument against a bare `fn(...)` parameter in
the evaluator, with an error naming `Impl(Fn(...))` / `Dyn(Fn(...))` as the fix —
mirroring the good precedent already in `src/evaluator/types/field.yo:566-580`,
where `Impl(Fn(...))` as a field type is rejected with a message that names
`Dyn(Fn(...))` and the generic-parameter alternative.

## Reproducer

`issues/repros/bare-fn-param-closure-invalid-c.yo`

## Docs fixed alongside

`.github/instructions/yo-design.instructions.md` declared the HKT `Functor.map`
callback and the `do_map` helper's `f` parameter as bare `fn(a : A) -> B`, which
teaches exactly this broken shape. Both now use `Impl(Fn(a : A) -> B)`.
