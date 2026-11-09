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

## Resolution (P8)

Fixed with `issues/fixed/2026-11-07-a-ctl-operation-returning-its-reference-parameter-is-rejected-with-e0605.md`: the
closure literal's tail `v` is a bare name in a projection's result position, which now reads as the reference the `&T`
result expects. `closure-returns-param` is accepted and `closure-returns-capture` is E0923 (the capture, by name), both
re-recorded. Test: `tests/origins/reference_read_rule.test.yo`, "a closure literal returns its reference parameter".
