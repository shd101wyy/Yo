# Calling an `inout(self)` method on a `unit` value emits an invalid C ref-spill

**Status: OPEN.** Found 2026-08-24 implementing D3.8 (`ToString` for `unit`,
branch s1-tostring — the impl is DEFERRED because of this).

## Symptom

With `impl(unit, ToString(to_string : (fn(inout(self) : Self) -> String)(...)))`:

```rust
u := ();
u.to_string();
```

emits

```c
void __yo_ref_spill_61 = ;
```

("variable has incomplete type 'void'" + "expected expression").

## Root cause

`_apply_ref_amp` (src/codegen/exprs/other_fn_call.yo) spills a
non-addressable ref argument to a typed temp; for a unit receiver the C
type renders as `void` and the value expression is empty. Unit-typed
inout/ref parameters need to be elided (or handed a dummy) at both the
call site and the callee signature.

## Repro

tmp/fixme scale: the two lines above with the unit ToString impl restored
(see the s1-tostring branch history).
