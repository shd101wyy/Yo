# `%` on floats type-checks and then emits invalid C (`double % double`)

**Status:** OPEN
**Severity:** wrong layer — the program is rejected by the C compiler with a C
error naming a generated temporary, instead of by the evaluator with a source
location. `yo check` reports the file as fine.
**Found:** 2026-09-11, during the `///` documentation sweep of `std/math.yo`,
while verifying an existing doc comment's claim that `%` on floats is C's
`fmod`.

`f64.rem_euclid`'s doc comment said, before this sweep:

> The floating-point remainder of `self / rhs`, keeping the receiver's sign —
> C's `fmod`, and what Yo's `%` means for floats.

Neither half was true: the body adds `|rhs|` back on a negative result (it is
Rust's `rem_euclid`, always non-negative), and `%` on floats does not work at
all.

## Reproducer

`issues/repros/stddoc-coll-float-modulo-emits-invalid-c.yo`:

```rust
a := f64(-7.0);
b := f64(3.0);
println(`pct: ${a % b}`);
```

```
$ yo check issues/repros/stddoc-coll-float-modulo-emits-invalid-c.yo --std-path ./std
check: … — evaluator OK

$ yo compile issues/repros/stddoc-coll-float-modulo-emits-invalid-c.yo --std-path ./std --optimize 2 -o /tmp/mod_test
/tmp/mod_test.c:1687:34: error: invalid operands to binary expression ('double' and 'double')
 1687 |   double __yo_ref_spill_1 = ((a) % (b));
      |                              ~~~ ^ ~~~
1 error generated.
yo: error: compile: C compiler failed (exit 1) on /tmp/mod_test.c
```

## Root cause

The evaluator's `%` accepts a float operand pair and types the result as the
operand type, and codegen lowers `%` to the C `%` token unconditionally. C's
`%` is defined for integer operands only; the float remainder is the library
function `fmod`/`fmodf`, which `std/libc/math.yo` already binds
(`_c_fmod`, `_c_fmodf`, used by `rem_euclid` two lines away).

## Two possible fixes — a decision, not just a patch

1. **Support it, as Rust does.** Rust's `Rem` is implemented for `f64`/`f32`
   and means `fmod`. Lower a float `%` to `fmod`/`fmodf` in codegen; `std/math`
   already provides the bindings, and the truncated-remainder semantics are
   what every C and Rust programmer expects. This also makes the "keeping the
   receiver's sign" sentence the doc wanted to write true.
2. **Reject it in the evaluator**, with a source location and a message
   pointing at `rem_euclid` (non-negative) or a new `fmod` wrapper
   (truncated). Cheaper, and it is the D1-shaped answer if `%` is meant to be
   integer-only.

Either way the current state — accepted at check time, broken at compile time —
is the one outcome that should not stand. A `comptime_expect_error` negative
(for fix 2) or a runtime assertion on `(-7.0) % 3.0 == -1.0` (for fix 1) is the
test.
