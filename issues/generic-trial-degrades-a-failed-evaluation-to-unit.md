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

An attempt on `tss/impl-self-operator` bound a variable array length symbolically
(`N := VarRef("T.BYTES")` in the synthesizer's var-var `Array` case, aliased into the
`Substitution`), so `Array(u8, T.BYTES).fill(u8(0))` matched its impl in the trial. Built for the
first time on 2026-09-30, it broke develop's own `tests/array.test.yo` (the `_Widthy` blanket
impl): "Cannot unify incompatible types: usize and Type" at the prelude `fill`'s
`while(i < U, …)`. It was reverted (`e8ac3c0f2`); the `Array` case stays open. Dropping the
`unit` exclusion (commit `6308fed65`) also made `check ./std` fail
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


## Narrowed 2026-10-01 (measured with `YO_DEBUG_SWALLOW=1`, v0.2.47)

In a generic impl member's trial:

| the length | `(out : Array(u8, L)) = Array(u8, L).fill(u8(0))` |
| --- | --- |
| `usize(4)` | types as the array |
| `T.BYTES` | `unit` |
| a type alias `A :: Array(u8, T.BYTES)`, `A.fill(…)` | `unit` |
| a local `n :: T.BYTES`, `Array(u8, n)` | `unit` |

No error is swallowed before the final mismatch: the `fill` lookup falls back to `unit` without
throwing, because `impl(generic(T, U : usize), Array(T, U), …)` cannot bind `U` to a
value-dependent length. Why the reverted `N := VarRef("T.BYTES")` binding broke
`tests/array.test.yo` (REASONED): the symbolic expression names the OUTER `T`, but it is read
inside `fill`'s own impl, whose `T` is the element type, so `while(i < U, …)` saw `T.BYTES` of
the wrong `T` ("usize and Type"). Binding `U` to an unknown `usize` value names nothing. The
call's `Self` must still be the receiver's own type, so the result is `Array(u8, T.BYTES)`
rather than `Array(u8, <unknown>)`.

The same capture exists in TYPES, not only in the value binding: a value-dependent length is
stored as the string `length_var = "T.BYTES"`, and both `_subst_resolve_len_projection` and the
reverted symbolic alias (`subst_add_len_var_alias`) resolve it BY NAME against whatever
substitution is current. Inside another impl whose binder is also called `T`, that is the wrong
`T`. So the fix needs a length variable that refers to its type variable by identity (the
SomeT's id plus the projected constant), not by spelling. That is a design change to
`TypeValue.Array`'s length, which `plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 3 (type identity) did
not cover. Until it lands, the `unit` exclusion in `mark_generic_independent` stays.
