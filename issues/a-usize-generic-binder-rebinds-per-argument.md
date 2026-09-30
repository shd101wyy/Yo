# A `generic(N : usize)` binder rebinds per argument — two arrays of different lengths satisfy one `N`

**Severity:** S2 — a call that binds one length parameter to two lengths is accepted; the last argument's length wins, so a body indexing the shorter array by `N` hits the safe-mode bounds guard at run time instead of a check-time error.

**Found:** 2026-09-30, while auditing comptime-indexed types for
`plans/INDEXED_TYPES_ATS_LESSONS.md` (develop `df3798c4a`, seed v0.2.46).
**Status:** open. The fix belongs next to the Phase-2.4 type-variable check
(`issues/fixed/generic-type-var-rebinds-per-argument.md`), extended to value
binders; the soundness campaign (`plans/TYPE_SYSTEM_SOUNDNESS.md`) owns it.

## Repro

`issues/repros/usize-generic-binder-rebinds-per-argument.yo`:

```rust
{ println } :: import("std/fmt");
n_of :: (fn(generic(N : usize), a : Array(u8, N), b : Array(u8, N)) -> usize)(N);
last_b :: (fn(generic(N : usize), a : Array(u8, N), b : Array(u8, N)) -> u8)(b(N - usize(1)));
main :: (fn() -> unit)({
  x := [u8(1), u8(2)];
  y := [u8(3), u8(4), u8(5)];
  println(n_of(x, y));   // 3
  println(n_of(y, x));   // 2
  println(last_b(y, x)); // 2
});
export(main);
```

Measured: `yo check` rc 0, `yo compile --optimize 2` rc 0, the binary prints
`3`, `2`, `2`. Every call should be an E0601 naming both arguments, exactly
as the type-variable twin is today:

```
error[E0601]: Incompatible types for generic parameter "A": it is String from argument 1 but i32 from argument 2. Every mention of a type parameter in one call stands for one type.
```

## Mechanism (reasoned from the fixed twin, not re-measured)

Phase 2.4 added a per-call binding check for TYPE variables on both call
paths. A `generic(N : usize)` binder is bound through the substitution's
value half (`len_var_names` / `subst_add_len_var`, `src/types/substitution.yo`;
the var-var `Array` case of the synthesizer), which the Phase-2.4 check does
not read: each argument's `Array(u8, N)` is matched on its own, and the
in-place update keeps the last binding ("last-wins", the same shape the fixed
twin describes for type variables).

## Consequence

Bounded: the wrong `N` is a compile-time constant, so an out-of-range index
computed from it (`a(N - usize(1))` after `N` was taken from the longer `b`)
trips the safe-mode array guard at run time (`plans/SAFE_MODE.md`) rather
than reading out of bounds. A body that only reads `N` (`n_of`) returns a
value that is not the length of one of its arguments.

## Regression test

Per `tests/type_soundness.test.yo`'s convention the `comptime_expect_error`
case is added in the PR that fixes the issue (the ratchet file stays green);
the case to add is the two `n_of` calls above expecting
`Incompatible types for generic parameter`.
