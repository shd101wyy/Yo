# A generic body's definition-time trial degrades a failed sub-evaluation to `unit`

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
