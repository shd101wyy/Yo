# A by-value operand is read after a later `&mut` argument writes it

**Severity:** S2 — wrong value, no memory error: `sub(x, bump(&mut x))` passes the value `x` has after `bump` wrote it instead of the value it had when the argument was evaluated.

**Status:** fixed (codegen). Found 2026-10-25 while fixing
`issues/fixed/2026-10-24-a-dyn-closure-field-call-operand-runs-after-a-later-hoisted-argument.md`.

## Reproducer

`issues/repros/2026-10-25-a-by-value-operand-is-read-after-a-later-mut-argument-writes-it.yo`:

```yo
{ assert } :: import("std/assert");
sub :: (fn(a : i32, b : i32) -> i32)(a - b);
bump :: (fn(p : &mut i32) -> i32)({
  p = i32(10);
  i32(1)
});
main :: (fn() -> unit)({
  (mut(x) : i32) = i32(3);
  r := sub(x, bump(&mut x));
  assert(r == i32(2), "x is read before bump writes it");
  ()
});
export(main);
```

Source order gives `3 - 1 = 2`; the binary computes `10 - 1 = 9` and the assertion fails.

## Root cause (from the emitted C)

```c
int32_t __yo_v_x = 3;
int32_t tmp_bump = yo_id_…((int32_t*)((&(__yo_v_x))));      // writes x = 10
int32_t tmp_sub = yo_id_…((int32_t)(__yo_v_x), (int32_t)(tmp_bump));
```

The earlier argument `x` stays an inline read and runs after the later argument's statement. The
cause is the one in
`issues/fixed/2026-10-25-an-rc-field-operand-is-read-after-a-later-argument-releases-the-handle.md`.

## Fix

Fixed by the same change: `sequence_operand` (`src/codegen/exprs/other_fn_call.yo`) settles each
earlier by-value operand into a `__yo_seq_<n>` local before a later operand that names its local
root (`x` here) or may write runs. Regression tests: `tests/parameter_modes.test.yo` "a by-value
operand is read before a later &mut argument writes it", "a by-value receiver or field operand is
read before a later &mut argument writes its root", and "a by-value operand is read before a later
block assigns it" (all three failed on the develop binary of 2026-10-25). The S1 sibling case
(inside a state machine, a later operand's `await` between the operand and its use) stays open as
`issues/2026-10-25-an-operand-before-an-await-in-a-later-operand-is-read-after-the-resume.md`.
