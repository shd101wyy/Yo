# A `ctl` operation returning its reference parameter (`ctl(key : &i32) -> &(i32, key)` resumed with `return(key)`) is rejected with E0605

**Severity:** S2 — a valid program is rejected (`Expected type "*(i32)", but got "i32"`)

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-ctl-operation-returning-its-reference-parameter-is-rejected-with-e0605.yo`.

`yo check` reports `error[E0605]: Return type mismatch. Expected type "*(i32)", but got "i32".` Corpus row `effect-resume-param`.

## Root cause

`ctl` signatures keep the pre-decision-43 pointer result form; N1b's retype never reached `ctl`.

## Fix

P8, v0.2.77 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

corpus row `effect-resume-param` goes green; `tests/algebraic_effects.test.yo` gains the case.

## Resolution (P8)

The `ctl` signature was not the gap: a `fn` with the same result, `(fn(key : &i32) -> &(i32, key))({ return(key); })`,
was rejected the same way. A `&T` result is a projection (decision 24), and `rewrite_projection_tails` turned only a
written `&place` into the marked `addr_of(place)`. A bare name in a result position (`return(key)`, a tail `r`)
stayed a whole-value read of the referent, so it was checked against the projection's `*(T)`.

`rewrite_projection_tails` now turns a bare name in a result position into `addr_of(name.*)`, marked
`PROJECTION_*_READ_PATH`. `evaluate_address_call` keeps that node when the name is a reference binding. That is the
read rule (R1): a reference read where the `&T` result expects one is the reference itself, so it lowers as `&key.*`
would, and its root check, its mode check and the closure/handler origin rule (E0923 for a capture, E0912 for a local)
are the projection's. Any other name is evaluated bare, as written, so its error is unchanged. A `&` binding returned
as a `&mut T` result is rejected by name.

The root rule also follows a local borrow into the places it freezes (`_local_borrow_root_error`): `r := &b.v; r` (or
`&r.*`) in a `-> &(T, b)` body was E0912 ("`r` is a local") on develop, although `r`'s place is reached from `b`.
A local borrow of a body local is still E0912.

## Tests

- Corpus: `effect-resume-param` is accepted (target ACCEPT). `effect-resume-local` stays E0912 and
  `effect-resume-capture` stays E0923. New row `effect-result-holder` (pos).
- `tests/algebraic_effects.test.yo`: "a ctl operation resumes with its own reference parameter" (`&`, `&mut`,
  a holder).
- `tests/origins/reference_read_rule.test.yo`: "a projection's result written as a reference binding" (`fn`,
  `&mut`, generic, local reference binding, closure), plus the two rejections.
