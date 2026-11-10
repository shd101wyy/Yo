# A closure literal returning its reference parameter into an `Impl(Fn(v : &i32) -> &i32)` slot fails to evaluate

**Severity:** S2 — a valid program is rejected ("Last expression in `begin` is not evaluated correctly")

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer


Corpus row `tests/origins/corpus/closure-returns-param.yo` (a positive control) fails evaluation; `closure-returns-capture`'s recorded text has the same root.

The recorded "Last expression in `begin` is not evaluated correctly" came from `_apply`'s own body, `f(v).*`. That is the `.*` of a projection call, the internal error of `issues/fixed/2026-11-05-dereferencing-a-projection-call-result-is-an-internal-error.md`. With that fixed (2026-11-08), the closure literal's own first error is visible, and the corpus rows record it. It is identical on the v0.2.76 seed with `_apply`'s body replaced by `i32(0)`:

```text
error[E0604]: Function body has type `i32`, but the declared result type is `*(i32)`.
  --> tests/origins/corpus/closure-returns-param.yo:8:29
  |
8 |   _ := _apply((v : &i32) => v, &x);
  |                             ^
```

## Root cause

A closure literal returning its reference parameter is not evaluated as a projection body.

## Fix

O-3, v0.2.77 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

the corpus row goes green; `tests/closure_capture_list.test.yo` gains the positive.

## Fixed

Measured 2026-11-10 on a develop-built tree binary (`f8c70b02a`). The internal "Last expression in `begin` is not evaluated correctly" was already gone (the projection-call `.*` fix of 2026-11-08). What remained was the corpus rows' own spelling: a closure literal returning `&T` is a projection (decision 24), whose tail is written `&place`, and `closure-returns-param` / `closure-returns-capture` wrote the bare name (`(v : &i32) => v`, `=> c`), the form a NAMED `-> &T` function rejects with "this body has type `i32`" too. Spelled `&v.*` the row is accepted, and `closure-returns-capture` (`=> &c.*`) is rejected for the intended origin reason, E0923 ("a closure's reference result is reached from one of its own `&`/`&mut` parameters ... `c` is a binding of the enclosing function"). So: (1) the two rows are re-spelled and their `today` column re-recorded (`accept`, `E0923|...`); (2) the closure path's mismatch, which printed the internal result form ("Function body has type `i32`, but the declared result type is `*(i32)`", E0604), now raises the decision-24 text the named path raises (`projection_body_mismatch_message`: "... a projection (decision 24): its result is a place ... written `&place`"); (3) the test "a closure literal returning its reference parameter is a projection" in `tests/closure_capture_list.test.yo` pins the accepted `&v.*`, the bare-`v` diagnostic and the E0923 capture row. Whether a bare reference binding should be a valid projection tail (R1 at the result position) is a design question, recorded in the hand-back; today it is rejected for named functions and closures alike.
