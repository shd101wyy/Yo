# A `c_include`d constant that is an rvalue MACRO cannot be an `inout` receiver

**Status:** OPEN
**Found:** 2026-09-08, after fixing
`issues/fixed/c-include-global-does-not-emit-its-header.md`.

## Symptom

With the header now emitted, reading a `<math.h>` constant works — but using
one as a method receiver does not:

```rust
{ M_PI } :: import("std/libc/math");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  println(M_PI.to_string());        // ← fails
  v := M_PI;
  println(v.to_string());           // ← fine
});
export(main);
```

```
error: cannot take the address of an rvalue of type 'double'
 1608 |   __yo_t5 _file____priv_temp_9878 = yo_id_6843((&(M_PI)));
      |                                                 ^ ~~~~
```

`to_string` takes an `inout(self)` receiver, so codegen emits `&receiver`.

## Root cause

A `c_include` field is declared as though it names an extern OBJECT, and
codegen treats every extern-C global as addressable. The C reality is mixed:

| symbol | C form | addressable? |
| --- | --- | --- |
| `stdout` | an object (`FILE *stdout;`) | yes |
| `errno` | a macro expanding to an LVALUE (`(*__error())`) | yes |
| `M_PI`, `HUGE_VAL` | a macro expanding to an rvalue (`3.14159...`) | **no** |

Nothing in the declaration distinguishes the third row, and it is the row the
mathematical constants live in.

## Precedent for the fix

`src/codegen/exprs/other_fn_call.yo` already carries exactly this repair for a
different rvalue-that-looks-addressable: `arg_is_tag_constant` routes a
payload-free enum-variant literal (which lowers to an int-rvalue macro
`__YO_T0_B`) to the `__yo_ref_spill_N` temporary rather than `&`
(issues/fixed/inout-receiver-on-enum-variant-literal-takes-address-of-tag.md).
The same spill is the answer here.

## The decision the fix needs

Spilling is safe for a CONSTANT and wrong for a MUTABLE global: it copies, so a
callee writing through an `inout` reference would write to the copy. `errno` is
exactly that case. Options:

1. **Spill every extern-C global receiver.** Simplest; silently breaks a write
   through an `inout` receiver on `errno`. Nothing in the tree does that today,
   but nothing would report it either.
2. **Spill only non-pointer scalars.** Separates `M_PI`/`HUGE_VAL` (f64) from
   `stdout`/`errno` (pointers) cleanly for the symbols that exist, but it is a
   heuristic standing in for a property the declaration should state.
3. **Say it in the declaration.** Let `c_include` mark a field as a constant
   (or infer it: a field with no pointer type and an all-caps name is a poor
   proxy, but an explicit `const` marker is not). Most work, and the only
   option that is actually correct rather than correct-for-now.

## Not a blocker for `std/math`

The Yo-level float constants that `plans/STD_API_STABILIZATION.md` §4 asks for
(`f64.EPSILON`, `INFINITY`, `NAN`, `PI`) are better written as Yo literals
anyway — comptime, no header dependency, and
`issues/fixed/comptime-float-infinity-emits-invalid-c.md` made the non-finite
ones emit correctly. This bug only bites code reading libc's own constants
directly as a receiver.
