# A generic body checks its origin parameters elided, so a store widens a rigid origin

**Severity:** S1 — use-after-free in safe code: a reference whose origin a generic body names `q` is stored into a holder over `p`, and the caller binds `q` to a place that dies first

Found 2026-11-07 while verifying O-2's `generic-rigid-origin` corpus row (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §9).

## Reproducer

Program: `issues/repros/2026-11-07-a-generic-body-checks-its-origin-parameters-elided-so-a-store-widens-a-rigid-origin.yo`.

`_pick(generic(p : Origin, q : Origin), a : &(Rc(X), p), b : &(Rc(X), q), dst : &mut Option(&(Rc(X), p)))` stores `b` into `dst` through a nested generic call `_put(b, dst)`. The caller binds `p := x` and `q := y`, a block local; `slot` is read after the block. `yo check` accepts it (develop `f89a24b0d`); compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free`. The direct form `dst.* = .Some(b)` in `_pick`'s body is accepted the same way (corpus row `generic-rigid-origin`).

## Root cause

A function with `generic(...)` parameters is evaluated per specialization, and a specialization re-evaluates its parameter types with their origins ELIDED (origins never specialize). Inside the body, `b`'s and `dst`'s types carry no `p` or `q`, so neither the `=` join's subset check nor the call boundary's O3-3 unification has a spelled origin to compare: every check that reads a parameter's type off the environment or the argument's `ExprInfo` sees `&Rc(X)` and passes. O2 says a generic body is checked with its origin parameters RIGID — `p` and `q` are distinct names whatever a caller binds them to — and the body's own function type still spells them (the return rule already reads it).

## Fix

Fixed by O-2: `param_declared_origin_slot` (`src/evaluator/utils.yo`) reads a parameter's DECLARED slot off the function type of the body being evaluated when that slot spells origins. The `=` join's subset check (`bind_join`, for the holder and for parameter roots) and `lend_through`'s argument walk (`_argument_origin_type`, `src/evaluator/calls/function.yo`) use it, so `b : &(_, q)` stored into a holder over `p` is E0923 in the body — directly or through `_put(b, dst)`, whose `dst` now fixes `_put`'s origin to `p`.

## Test that pins it

`tests/origins/unsound/rigid-generic-nested-call.yo` (G-B: rejected with E0923; its positive twin `rigid-generic-nested-call-pos.yo` compiles and runs clean under ASan); corpus row `generic-rigid-origin`.
