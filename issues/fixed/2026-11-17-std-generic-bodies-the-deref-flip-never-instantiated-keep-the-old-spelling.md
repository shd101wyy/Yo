# std generic bodies the deref flip never instantiated keep the old spelling, so their first caller fails with E0926 inside the standard library

**Severity:** S1. After #1976, a program calling any of these std functions failed to compile with E0926 raised inside the standard library. On develop 413e23a57 eight language test files went red (`btree_map`, `for_macro_borrow`, `for_read_walk`, `index`, `move_only_collections`, `array_list_convenience`, `int_checked_arithmetic`, `spec/refine_types`), on top of `arc` (#1977).

## Observed

```text
error[E0926]: `self` is a reference (`&i32`): reading the value it refers to is spelled `self.*`
note: raised here, inside the standard library
     --> std/prelude.yo:5015:25
5015 |         acc.checked_mul(self),
note: in `probe_int`, instantiated here
```

`tests/spec/refine_types.test.yo` failed the same way at `std/spec/refine.yo:137`, `Option(Bounded(T, lo, hi)).Some(x)`.

## Root cause

The deref flip (#1976) deleted `is_deref_rule_exempt`, so std is now held to the reference-reading rule: a reference binding used as a whole value is spelled `x.*`. The flip lane's migration (`yo fix --migrate deref`) and its gate (`yo check ./std`) both work from evaluation, and evaluation type-checks a generic body only at an instantiation. A std generic that nothing in `std/` instantiates, and that the lane's Tier-1 test files did not call, kept the pre-flip spelling. Most such sites were half-migrated, with one operand rewritten and the other not (`(self.* < lo)`), because the sweep rewrote only the uses it saw in the instantiations it did reach.

`yo fix --migrate deref` cannot repair these after the fact either: given a driver that instantiates them, it stops at the first std error ("does not evaluate; its references are migrated only as far as evaluation reached") and rewrites nothing in std.

The first instance was `Arc.make_mut` (`issues/fixed/2026-11-17-arc-make-mut-assigns-self-without-the-deref-after-the-flip.md`, #1977).

## Fix

Every whole-value use of a `&T` parameter in these bodies now reads `x.*`:

- `std/collections/array_list.yo`: `sort_unstable`'s comparator.
- `std/collections/btree_map.yo`: `BTreeMap._find`.
- `std/prelude.yo`, the integer batteries with a `self : &T` receiver: `checked_abs`, `checked_pow`, `clamp` (its `lo`/`hi` comparisons), `checked_neg`, `saturating_pow`, `isqrt`, `wrapping_rem`, `saturating_div`, `ilog` (its `base`), `checked_shl`, `checked_shr`, `abs`, `wrapping_neg`, `wrapping_abs`, the bit batteries (`count_ones`, `count_zeros`, `leading_zeros`, `trailing_zeros`, `leading_ones`, `trailing_ones`, `rotate_left`, `rotate_right`, `reverse_bits`, `swap_bytes`), `to_be_bytes`, `to_le_bytes`, `is_power_of_two` and `checked_next_power_of_two`.
- `std/spec/refine.yo`: the `Bounded` predicate and `check_bounded`.
- `std/spec/numeric.yo`: `check_even` and `check_odd`.

The integer batteries were swept with a throwaway driver that instantiates every `&T`-receiver method at `i8`, `i32`, `i64`, `u8`, `u32` and `usize` (and the signed and unsigned-only blocks at their types); it checks clean on the fixed tree.

## Test

`tests/int_checked_arithmetic.test.yo` (44/44) and `tests/spec/refine_types.test.yo` (8/8) fail to compile before the fix and pass after it, as do the six other files listed above. A gate that would catch this class before a merge is an open design decision: `issues/questions/2026-11-17-uninstantiated-std-generic-bodies-escape-every-std-gate.md`.
