# Calling an `inout(self)` method on a `unit` value emits an invalid C ref-spill

**Status: FIXED 2026-08-24 (branch `fix/inout-unit-ref-spill`).**
`_apply_ref_amp` (src/codegen/exprs/other_fn_call.yo) now passes
`((void*)0)` for a ref/`inout` argument of type `unit` — the callee's unit
receiver renders as `void* self` and is never read, so a null pointer is
the correct C value; the empty-value `void __yo_ref_spill_N = ;` spill is
never emitted. The deferred D3.8 `unit` ToString impl lands with the fix
(std/fmt/to_string.yo, placed AFTER the `str` impl — the backtick literal's
str->String coercion needs `str.to_string` registered first), with tests in
tests/fmt.test.yo. Found 2026-08-24 implementing D3.8 (`ToString` for
`unit`, branch s1-tostring — the impl was DEFERRED because of this).

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

## Scope of this fix — what is still broken

This fixes the `inout`/ref **argument** path only. `unit` in a C
*declaration* position is still emitted as `void`, so a by-value `unit`
parameter (hence `println(())`, whose parameter is `value : T` at
`T = unit`), a `unit` struct field, and `ArrayList(unit)` still fail to
compile. That boundary is measured in full in
issues/fixed/unit-typed-params-and-fields-emit-c-void.md, which is the
follow-up.
