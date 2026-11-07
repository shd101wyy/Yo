# A composite built in a `match(&o, …)` arm from the arm binding escapes the match without freezing `o`

**Severity:** S1 — use-after-free in safe code: the scrutinee is reassigned or dropped while a value built from its binding is live

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-composite-built-in-a-borrowed-match-arm-escapes-without-freezing-the-scrutinee.yo`.

`yo check` accepts it ("evaluator OK", tree binary at develop `8d475cd81` and later); compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free`. Also `p15c_rc_option_handle.yo` (through an `Rc` handle bound by the arm), `h3_match_option_holder_string.yo`, `p14c_match_return_option.yo`.

## Root cause

The match result's origin set is never computed (R-ARM); `origin_carrying_value_roots` sees only direct lends, so a constructor that wraps the arm binding carries no roots.

## Fix

Fixed by O-1 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §3, §8): `origin_of`
computes the match result's origin as the union over its arms (R-ARM), and each arm
value's composite as the union of its components (R-COMP). A lend through the arm
binding (`&h.*.s`) is resolved through the binding's registered entries — the binding's
frame has ended by the time the result is bound, so `local_borrow_place_of` cannot find
it, and the entries carry the scrutinee's places (R-LEND through R-READ). `bind` freezes
those places for `m`'s live range, so `o = ...` while `m` is live is E0911.

## Test that pins it

corpus rows `match-arm-composite`, `match-value-arm-composite`;
`tests/origins/unsound/h3b-match-arm-composite.yo` (G-B: rejected with E0911; its
positive twin `h3b-match-arm-composite-pos.yo` compiles and runs clean under ASan).
