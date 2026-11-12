# The value tail of a generic reference result has no origin

**Severity:** S3 — G-E's totality audit (`scripts/check-origin-sinks.sh --totality`, gate 0) reports two `untyped origin_of` lines in `tests/origins/reference_read_rule.test.yo`, so the "Origins corpus, unsound programs, origin totality" CI job is red; the result's origin was computed from nothing.

- Filed: 2026-11-12 (fixdev lane; develop battery 43142204182). `_sm_pick` came with #1904 (R3), which merged before #1908's gate existed.

## Reproducer

```yo ignore
_sm_pick :: (fn(generic(T : Type), a : T, b : T, first : bool) -> T)(if(first, a, b));
// instantiated at `T := &i32`: `_sm_pick(rx, ry, false)`
```

`YO_AUDIT_ORIGIN_TOTALITY=1 yo check` printed
`[origin-totality] untyped origin_of …:717:80 (a.(*))` and `…:717:83 (b.(*))`, and `YO_DEBUG_ORIGIN=1` showed the body's
origin as `cond(first => addr_of((a.(*))), true => addr_of((b.(*)))) -> []`.

## Root cause

R3 (`rewrite_value_reference_tails`, `src/expr.yo`) rewrites a bare name in a result position of a by-value `-> T`
specialized at `T := &U` to the marked `addr_of(name.*)` (`VALUE_*_READ_PATH`): the reference VALUE the result is.
`evaluate_address_call` evaluates `name.*` under another node id, so the written `name.*` node has no `ExprInfo`.
`_origin_of_into` did not know the marker (`addr_of` is not the `&` lend marker R-LEND reads), fell through to R-CALL's
"constructor" fallback, and recursed into the untyped `name.*`: the arm contributed no origin.

## Fix

`_origin_of_into` (`src/evaluator/utils.yo`) reads a value-tail node as R-READ of its name: the origin of `addr_of(name.*)`
is `name`'s. The gate is back to 0 for `tests/origins/reference_read_rule.test.yo`.
