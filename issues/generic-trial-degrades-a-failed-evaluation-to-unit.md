# A generic body's definition-time trial degrades a failed sub-evaluation to `unit`

**Severity:** S2 — a failed sub-evaluation is silently typed `unit` — genuine type errors in never-called generic bodies go unreported

**Status:** OPEN
**Found:** 2026-09-28, Phase 6 step 2 (`plans/TYPE_SYSTEM_SOUNDNESS.md`): trialling EVERY deferred
generic body (not only those whose result mentions a type variable) made `check ./std` fail at
`std/prelude.yo`'s `to_be_bytes`.
**Measured:** tree build of `tss/p6-generic-reraise` before the `unit` exclusion in
`mark_generic_independent`.

## Symptom

```rust
impl(
  generic(T : Type),
  where(T <: (Integer, ByteWidth)),
  T,
  to_be_bytes : (fn(self : T) -> Array(u8, T.BYTES))({
    (out : Array(u8, T.BYTES)) = Array(u8, T.BYTES).fill(u8(0));
    ...
```

The generic trial (with `T` abstract) reported

```
error[E0601]: Incompatible types:
- Expected: Array(u8, T.BYTES)
- Given   : unit
```

The program is valid: every specialization types `Array(u8, T.BYTES).fill(u8(0))` as the array.
In the trial the call's result type is `unit`, which is not a type the expression has under any
`T`: some sub-evaluation failed and a fallback typed it `unit` (the evaluator's stand-in —
`t_unit()` fallbacks after a swallowed lookup, noted at several sites, e.g. the "non-Func unit
fallback" of a method lookup miss, and the dg return-type check's `dg_trial_degenerate` guard).

## Current handling

`mark_generic_independent` (`src/types/utils.yo`) does not treat a mismatch with `unit` on
either side as instantiation-independent, and a type whose array length is an unresolved
expression (`length_var`) counts as generic. That keeps the re-raise sound, but a genuine
`(x : i32) = ()` inside a never-called generic is not reported at `check`.

## Next step

Find which fallback types `Array(u8, T.BYTES).fill(u8(0))` as `unit` in the trial
(`YO_DEBUG_SWALLOW=1`, or instrument the `t_unit()` fallbacks in method-call resolution for a
static call on an `Array` type with a value-dependent length) and make it an error or an
`UnknownVal` of the right type. Then drop the `unit` exclusion.

## A second degrading case: a method from a later impl of the same type (measured 2026-09-30)

The `Array(u8, T.BYTES)` case above is fixed on `tss/impl-self-operator` (symbolic array
lengths). Dropping the `unit` exclusion there (commit `6308fed65`) made `check ./std` fail
at `std/string/string.yo:1605`, `(rest : String) = self.clone()` inside the generic
`splitn`: "Expected String, Given unit". The commit was reverted.

```rust
S :: struct(x : i32);
impl(S, dup_via : (fn(generic(P : Type), self : Self, p : P) -> S)({
  (r : S) = self.clone();
  r
}));
impl(S, Clone(clone : (fn(inout(self) : Self) -> Self)(S(x : self.x))));
```

The generic member's trial runs while the first `impl(S, …)` is being evaluated. `Clone` is
in a later impl of the same type, which `force_pending_impls_for_type_name` refuses to force
mid-registration, so the lookup misses and degrades to `unit`. A user trait behaves the same.
With the `Clone` impl first, the program checks. The non-generic version of the same member
fails outright on develop:
`issues/a-member-cannot-call-a-trait-method-from-a-later-impl-of-its-type.md`.

So the exclusion can go only after both fallbacks report or defer instead of producing `unit`.

