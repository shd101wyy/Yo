# verifier: the literal folder aborts `yo verify` on a zero subtrahend or negand

**Severity:** S1 — `yo verify` (and a verify-mode `yo compile`) dies with rc 134 on valid code.

Found 2026-09-29 while building 5b Phase 2: `tests/spec/fixtures/valid/spec_insertion_sort.yo`
aborted once the elision-only obligations added more literal terms. The bug is older; the
Phase 1 binary reproduces it on the fixture below.

## Symptom

```rust
pragma(Pragma.Verify);

sub_zero :: (fn(a : i32, ensures(result == i32(5))) -> (result : i32))({
  x := i32(0);
  i32(5) - x
});
```

```
$ yo verify tmp/fold_sub_zero.yo; echo rc=$?
integer addition overflow (at file:///…/src/verifier/vc.yo:739:59)
rc=134
```

## Root cause (measured)

`_fold_bv2` / `_fold_bv1` in `src/verifier/vc.yo` fold literal bit-vector
operations. They model WRAPPING arithmetic, but computed it with the
compiler's own CHECKED `u64` operators: `a - b` as `a + (~b + 1)` and `-a` as
`~a + 1`. With `b = 0` (or `a = 0`), `~0 + 1` overflows `u64` and the
compiler's safe-mode trap aborts the run. `+` and `*` of large 64-bit
literals overflowed the same way.

## Fix

The folds use `wrapping_add` / `wrapping_sub` / `wrapping_mul` and then the
width mask, which is exactly the SMT-LIB `bvadd` / `bvsub` / `bvmul` / `bvneg`
semantics.

Regression test: `tests/internal/verifier_negative.test.yo` "the literal folder
wraps: subtracting or negating a zero literal does not abort", over
`tests/spec/fixtures/valid/fold_wrapping_literals.yo` (`i32(5) - x` and `-(y)`
with zero-valued locals). Before the fix the test process aborts; after it,
both functions verify `ok`.
