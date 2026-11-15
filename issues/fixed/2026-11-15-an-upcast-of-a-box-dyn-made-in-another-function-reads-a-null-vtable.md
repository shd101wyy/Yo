# An upcast of a `Box(Dyn)` made in another function reads a NULL vtable

**Severity:** S1 (a NULL dereference at runtime from safe code: `upcast(&b.*, Dyn(T))` or
`upcast(b, Dyn(T))` of a box whose `dyn(Box.new(v))` sits in a different function than the upcast)

## Symptom

```yo
_up_both :: (fn(k : i32) -> Box(Dyn(_OsSp, _OsOt)))(
  cond((k == i32(0)) => dyn(Box.new(_OsCat(n : i32(3)))), true => dyn(Box.new(_UpDog(n : i32(4)))))
);
(dog : Box(Dyn(_OsSp, _OsOt))) = _up_both(i32(1));
upcast(&dog.*, Dyn(_OsOt)).other_n()   // SEGV, read at 0x48
```

Three `tests/dyn.test.yo` rows ("upcast drops traits and keeps each payload's impls", "a downcast or
upcast used as a receiver or discarded releases its payload", "upcast of an AnyError to its ToString
supertrait"). The source vtables declare `__yo_up_<Tgt>` members but initialize none, and no
(concrete, target) vtable is emitted.

## Root cause

`register_dyn_upcast_targets` (`src/codegen/utils/fixup.yo`) adds a (concrete, target) impl for every
registered (concrete, source) impl. It runs once, before any function body is emitted. The collection
pre-pass registered a `dyn(...)` erasure's impl only for a legacy cell or a `dyn(&v)` lend; the
payload-convention instance of `dyn(Box.new(v))` was registered only by `generate_dyn_call`, during body
emission — too late. An upcast in the same function happened to work when its source impl was collected
another way (`tests/dyn_pointer_kinds.test.yo`'s rows).

## Fix

The collector's `dyn` arm also registers the payload-convention instance of a `dyn(Box.new(v))` over a
concrete `v` (its key re-keys in `fixup_dyn_impl_keys` exactly as the creation site keys it).

## Test

The three dyn.test rows above (ASan). Fail before, pass after.
