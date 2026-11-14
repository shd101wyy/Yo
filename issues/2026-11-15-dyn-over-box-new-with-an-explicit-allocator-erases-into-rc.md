# `dyn` over `Box.new(v, alloc : .Some(a))` erases into `Rc(Dyn(...))`

**Severity:** S2 (blocks `tests/explicit_allocators.test.yo`'s dyn rows — the placed/explicit-allocator dyns of VERDICTS-61 §Q4's ASan rows; the 1-argument `dyn(Box.new(v))` is unaffected)

**Date:** 2026-11-15

## Verbatim error

```text
error[E0601]: Incompatible types:
- Expected: Box(Dyn(_Speak))
- Given   : Rc(Dyn(_Speak))
   --> ./tests/.yo_selftest_batch_483872_1_0.yo:69:164
```

## Reproducer (`tests/explicit_allocators.test.yo`, the "dyn dispatch" row)

```yo
(d : Box(Dyn(_Speak))) = dyn(Box.new(_Dog(volume : i32(6)), alloc : .Some(heap)));
```

The 1-argument `dyn(Box.new(v))` gives `Box(Dyn(...))` (dyn.test.yo's rows,
p5); only the allocator-argument form erases into `Rc(Dyn(...))`.

## Root cause (hypothesis, unverified)

`evaluate_dyn_value` picks the erasure handle by `_erasure_handle_name`,
which names `Rc`/`Arc` when the runtime payload's recorded type is a cell
handle (`cell_handle_view`) and `Box` otherwise. For the 2-argument form the
payload expression's evaluation goes through `_synthesized_cell_call`'s
concrete branch, whose cell construction records the prelude CELL (`Rc`)
shape as the payload type, so the handle name comes out `Rc`. The 1-argument
form's payload records `Box(V)` (a raw-pointer newtype) and names `Box`.

## Test

The explicit_allocators row above once fixed; `tmp/p/p13.yo` was a
standalone attempt (its preamble is the test file's own counting allocator).

## Status

Parked 2026-11-15 05:50 to keep the flip's test-respelling lane moving;
pick up in src/evaluator/values/dyn.yo (`evaluate_dyn_value` /
`_erasure_handle_name` / `_synthesized_cell_call`).
