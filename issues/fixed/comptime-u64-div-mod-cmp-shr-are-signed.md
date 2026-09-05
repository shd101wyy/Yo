# Comptime `u64`/`usize` above `i64.MAX`: `/`, `%`, `>>` and the ordering comparisons are computed SIGNED

**Severity: silent wrong value at compile time.** Every `u64` or `usize`
constant above `i64.MAX` — `u64.MAX`, `usize.MAX`, hash seeds, bit masks with
the top bit set — divides, mods, right-shifts and compares wrongly when the
expression is folded at comptime. The runtime path is correct, so the same
expression gives two different answers depending on whether it happened to be
constant-folded.

**Found** 2026-09-04, while re-measuring the std-API audit queue: the
compiler's own integer-literal path (`src/evaluator/calls/numeric_type.yo:134`
calls `String.parse_u64`) started failing after `parse_u64` was made
overflow-checked, because the overflow guard divides by the radix.

## Reproducer

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  // Comptime-folded (both operands are constants):
  println(`u64.MAX / 2   = ${(u64.MAX / u64(2))}`);
  println(`u64.MAX % 10  = ${(u64.MAX % u64(10))}`);
  println(`u64.MAX > 1   = ${(u64.MAX > u64(1))}`);
  println(`u64.MAX >> 1  = ${(u64.MAX >> u64(1))}`);
  println(`(1 << 63) / 2 = ${((u64(1) << u64(63)) / u64(2))}`);
  println(`u64.MAX - 1   = ${(u64.MAX - u64(1))}`);
  // The same operations with a RUNTIME operand:
  m := u64.MAX;
  println(`runtime MAX/2 = ${(m / u64(2))}`);
  println(`runtime MAX>1 = ${(m > u64(1))}`);
});
export(main);
```

Observed on v0.2.24:

| expression | comptime | correct | why (as signed `i64`) |
| --- | --- | --- | --- |
| `u64.MAX / 2` | **0** | 9223372036854775807 | `-1 / 2` = 0 |
| `u64.MAX / 10` | **0** | 1844674407370955161 | `-1 / 10` = 0 |
| `u64.MAX % 10` | **18446744073709551615** | 5 | `-1 % 10` = -1 |
| `u64.MAX > 1` | **false** | true | `-1 > 1` is false |
| `u64.MAX >> 1` | **18446744073709551615** | 9223372036854775807 | arithmetic shift of -1 is -1 |
| `(1 << 63) / 2` | **13835058055282163712** | 4611686018427387904 | `i64.MIN / 2` = -4611686018427387904 |
| `u64.MAX - 1` | 18446744073709551614 | same | correct — see below |

The runtime forms print the correct values, which is what makes this so easy to
miss: `(m / u64(2))` and `(u64.MAX / u64(2))` disagree.

`usize` is affected identically — `is_unsigned_integer_type` covers `.Usize`
and `get_integer_type_bits(.Usize)` reports the target pointer width — so a
comptime bounds check written against `usize.MAX` reads a negative pattern.

## Root cause

`src/evaluator/builtins/comptime_numeric_fns.yo` carries comptime integers as
`i64` (`lhs_n`, `rhs_n` are `Option(i64)` produced by `parse_raw_int`). A `u64`
value above `i64.MAX` is therefore stored as a **negative bit pattern**, and
the operations were applied with signed semantics:

```rust
result_val = make_int_val(a / b, numeric_type);   // signed division
result_val = make_int_val(a % b, numeric_type);   // signed modulo
b_result := cond( … (op_s == "gt") => (a > b), … ) // signed comparison
n_result := cond( (op_s == "shl") => (a << b), true => (a >> b) ) // arithmetic shift
```

`add`, `sub`, `mul`, `eq`, `neq`, `shl` and the bitwise operators are
**two's-complement identical** in both domains, which is why `u64.MAX - 1` is
right and the bug looks selective.

The file already knew about the hazard. The `check_int_overflow` path carries
this comment and does exactly the right thing:

> `u64 / usize: yo-self carries comptime integers as i64, so every value above
> i64::MAX is a NEGATIVE i64 BIT PATTERN (usize.MAX, hash constants). Both
> signed tests below are meaningless there … so redo the test in the UNSIGNED
> domain on the patterns.`

The fix had been applied to the **overflow check** and not to the
**operations**.

## Why it went unnoticed

`tests/comptime.test.yo` has a `Test comptime u64` case — but its values are
around `1e12`, comfortably inside `i64`, so the top of the range was never
exercised. And its assertions could not have caught it anyway: all 1064
`comptime_assert` calls in that file sit inside `test(...)` bodies, where
`comptime_assert` **does not fire at all**
(`issues/fixed/comptime-assert-never-fires-inside-a-function-body.md`).

## Fix

Compute `unsigned_64` once in the integer binary path
(`is_unsigned_integer_type(numeric_type)` and a 64-bit width) and redo the four
affected operation groups in the unsigned domain:

```rust
// division / modulo
cond(unsigned_64 => i64(u64(a) / u64(b)), true => (a / b))
cond(unsigned_64 => i64(u64(a) % u64(b)), true => (a % b))
// ordering (eq/neq are bit comparisons and stay as they are)
unsigned_64 => cond((op_s == "lt") => (u64(a) < u64(b)), …)
// right shift becomes LOGICAL
unsigned_64 => i64(u64(a) >> u64(b))
```

`apply_bounds` passes 64-bit values through unchanged (`true => n` for
`.Int(64, _)`, `_ => n` for `.Usize`), so the bit pattern survives the round
trip.

## Regression test

`tests/comptime.test.yo` gained three tests. They are shaped as **module-level
`::` bindings observed by runtime `assert`s**, deliberately: a module-level
binding is folded at comptime, and the runtime assert then observes what the
folder produced. That makes the gate real, where a `comptime_assert` inside the
test body would have been dead. The third test is the negative control — `i64`
must keep signed semantics (`-1 / 10 == 0`, `-1 >> 1 == -1`,
`i64.MIN / 2 == -4611686018427387904`).

**Verified RED first**: both unsigned tests fail on the v0.2.24 binary
(exit code 6), and pass after the fix.

**FIXED 2026-09-04.**
