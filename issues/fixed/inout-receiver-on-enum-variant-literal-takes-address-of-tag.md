# An `inout(self)` method on a payload-free enum VARIANT LITERAL emits `&(<C tag constant>)`

**Status: FIXED 2026-08-29** (`src/codegen/exprs/other_fn_call.yo`, `_apply_ref_amp`).
**Found:** 2026-08-29 writing `tests/fs/watch.test.yo`
(`FsEventKind.Rename.to_string()`).
**Severity:** MEDIUM — loud (a C error), but it fires at C-compile time on an
ordinary expression `yo check` accepts, and the workaround users would reach
for (bind the literal to a local first) hides a codegen defect.

## Symptom

```rust
E :: enum(A, B);
impl(E, ToString(to_string : (self -> match(self, .A => `a`, .B => `b`))));
E.B.to_string()      // ToString.to_string takes inout(self)
```

```
error: cannot take the address of an rvalue of type 'int'
  __yo_t5 t = fn_yo_id_6892((&(__YO_T0_B)));
```

A bound receiver (`k := E.B; k.to_string()`) and a payload-carrying literal
(`F.A(v : i32(1)).to_string()`, a struct compound literal) both worked; only
the payload-free literal of a payload-free enum — which the C backend
represents as a bare enum tag constant — failed.

## Mechanism

`_apply_ref_amp` wraps a ref/`inout` argument in `&(...)`: a `(*x)` is folded,
a bare literal becomes a compound literal, an ADDRESSABLE C expression gets
`&(...)`, and anything else is spilled to a `__yo_ref_spill_N` temp. The tag
constant `__YO_T0_B` is an identifier, so `_is_addressable_c_expr` said yes —
but it is an rvalue.

## Fix

The arg's `ExprInfo.value` tells the truth: a comptime `EnumVal` with no
fields is the tag-constant rendition. Such an arg takes the spill path
(`__yo_t0 __yo_ref_spill_N = __YO_T0_B; … (&(__yo_ref_spill_N))`).

## Regression test

`tests/enum_literal_inout_receiver.test.yo` — `ToString` and a user
`inout(self)` trait on literal receivers of a payload-free enum and of a
tagged enum's payload-free variant, plus interpolation; RED on the previous
compiler with exactly the clang error above.
