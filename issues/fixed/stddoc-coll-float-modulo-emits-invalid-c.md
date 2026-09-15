# `%` on floats type-checks and then emits invalid C (`double % double`)

**Status: FIXED 2026-09-14** — option 1 (support it, as Rust does). Verified
red-then-green against the pre-fix v0.2.32 seed and a tree-built compiler; see
"Decision and fix" at the end.
**Was: OPEN**
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

---

## Decision and fix (2026-09-14)

This doc framed it correctly as **a decision, not just a patch**, so the
reasoning matters as much as the patch: **option 1 — support float `%` as
`fmod`.** Chosen on house evidence rather than preference:

1. **Rust parity is the stated house style.**
   `.github/instructions/yo-design.instructions.md` reaches for "as in Rust" /
   "that is the Rust regex crate's shape" as the deciding argument throughout,
   and Rust implements `Rem` for `f64`/`f32` as `fmod`.
2. **`std/math.yo` already claimed this was the semantics.** The `rem_euclid`
   doc comment said `%` on floats was "C's `fmod`" — the sentence this doc
   opens by calling untrue. Option 1 makes existing documentation true; option
   2 would have required correcting it.
3. **The library already has the operation.** `_c_fmod` / `_c_fmodf` are bound
   two lines from that comment, so nothing new is introduced.

Option 2 (reject in the evaluator) remains the right answer *if* `%` is meant
to be integer-only — but nothing in the tree says so, and the doc comment said
the opposite.

### Mechanics

`src/codegen/exprs/inline_fns.yo`. `_mod_op` picks `fmodf` / `fmod` / `%` off
the expression's result type via the existing `ei_ty`, mirroring how
`_unop_narrowed` already takes `expr` + `context`; `_callop2` renders the call
with the same degraded-render guard `_binop` has for operands that failed to
transpile.

No `add_c_include` from there — it would be a silent no-op that late in
emission, and `<math.h>` is already added unconditionally by `codegen_c.yo`, so
the declaration is always in scope.

### Verification

Red-then-green, with the **pre-fix v0.2.32 seed as the red oracle** (the
pre-fix tree binary had already been replaced by the rebuild):

| | `-7.0 % 3.0` |
| --- | --- |
| seed v0.2.32 (pre-fix) | `error: invalid operands to binary expression ('double' and 'double')` at `((a) % (b))` — the error this doc recorded, verbatim |
| tree-built (post-fix) | `pct: -1` |

`tests/math.test.yo` gains eleven assertions, and under the seed the test file
**does not compile at all**, failing on those very lines — so the test cannot
pass without the fix.

Expectations derived from C's `fmod` semantics (truncated remainder, sign of
the DIVIDEND), not from this document — the same discipline that caught a
wrong expected-value table twice elsewhere in this clean-up. Covered: negative
dividend, positive, negative divisor, fractional remainder, exact division,
both `f32` rows (a different C function, `fmodf`), and two integer rows so the
float lowering cannot disturb `%` on ints.

**The contrast is asserted explicitly**, because it is what the old doc comment
got wrong: for `-7.0` and `3.0`, `%` is `-1` and `rem_euclid` is `+2`. They are
different functions, and the test now says so on adjacent lines.
