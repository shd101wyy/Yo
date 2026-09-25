# A blanket inherent method reached through a `Dyn` receiver is dispatched through the VTABLE

**Status:** FIXED 2026-09-25 (Phase 2.7 of `plans/TYPE_SYSTEM_SOUNDNESS.md`).
**Found:** 2026-09-08, designing `Error.is(T)` for `plans/archive/STD_API_STABILIZATION.md` §4 Core.

## Symptom

A blanket INHERENT method over a trait bound, called on a `Dyn(Trait)` value:

```rust
{ Error, AnyError } :: import("std/error");
impl(
  generic(E : Type),
  where(E <: Error),
  E,
  is : (fn(self : Self, comptime(T) : Type) -> bool)(
    match(downcast(self, T), .Some(_) => true, .None => false)
  )
);
main :: (fn() -> unit)({
  (base : AnyError) = dyn(MyErr(code : i32(7)));
  println(`${base.is(MyErr)}`);
});
```

`yo check` passes. The emitted C does not compile:

```
error: no member named 'is' in 'struct __yo_t0_vtable_s'
 2510 |   bool _tmp = (base).vtable->is((base).data);
      |               ~~~~~~~~~~~~~  ^
```

## What is wrong

The evaluator RESOLVES the call — the blanket impl's bound `E <: Error` is
satisfied by `Dyn(Error)`, which is correct and useful. Codegen then assumes
that any method call on a `Dyn` receiver is a TRAIT method and emits a vtable
indirection. `is` is not a member of the `Error` trait, so there is no slot
for it, and the emitted C names a struct member that does not exist.

The right lowering is a DIRECT call to the monomorphised blanket method with
the `Dyn` value as the receiver — the same thing that happens for any other
concrete receiver type. Note the emitted call also correctly dropped the
`comptime(T)` argument, so the only defect is the dispatch mechanism.

## Why it matters

This is the one shape that would let a `Dyn(Trait)` value carry convenience
methods that are NOT part of the trait's vtable — Rust's `dyn Error` gets
`is::<T>()`, `downcast_ref`, and `source`-chain helpers exactly that way. With
this bug, every such helper has to be a free function, so `err.is(NotFound)`
must be written `error_is(err, NotFound)`.

`std/error.yo` takes the free-function route for that reason, with a comment
pointing here.

## Reproducer

`issues/repros/` — the snippet above is self-contained apart from a `MyErr`
struct implementing `ToString` and `Error`.

## Note on severity

It is an accepts-invalid: the failure is a C compile error, not a miscompile,
so nothing silently misbehaves at runtime. But the diagnostic names a
generated vtable struct and a source line in the emitted C, which points a
reader at codegen rather than at their own call site.

## Fix

Codegen dispatches through the vtable only when the method names a vtable SLOT of the receiver's
`Dyn` type (`dyn_type_has_vtable_slot`, the same predicate the vtable emitters use). Otherwise
the call takes the concrete method-call path with the `Dyn` as receiver: the evaluator already
specialized the blanket method for it. Two sites needed this: the method-call dispatch and the
method-value access in `codegen/exprs/property_access.yo`. The concrete path had excluded every
call whose first runtime argument was a `Dyn`. That exclusion exists for the `ctl`-field shape
(`exn.throw(dyn(err))`, receiver not prepended), and it is now limited to that shape.

With this and `issues/fixed/an-inherent-impl-on-a-dyn-type-registers-nothing.md`, `std/error.yo`'s
`error_is(err, T)` became `err.is(T)`.

## Verification

- `tests/dyn.test.yo`, "a blanket inherent method on a Dyn receiver is a direct call": the
  method's own `self.name()` still dispatches through the vtable.
- The issue's `is` repro prints `true false`.
