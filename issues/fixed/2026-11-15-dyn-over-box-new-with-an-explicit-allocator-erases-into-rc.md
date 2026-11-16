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

RESOLVED without a new change 2026-11-15: the night's commits (yo-il, head 82fa70ecd) already
type `dyn(Box.new(v, alloc : .Some(a)))` as `Box(Dyn(...))` — verified by `tmp/p/p19.yo` part 1
(evaluator OK, compiled and run under ASan, the placed-cell count asserted). The hypothesis above
describes a state that no longer reproduces. The file's remaining failure was a test-side
pre-flip annotation (`(d : Box(Dyn(_Speak))) = dyn(Rc.clone(r))`, which erases to the interim
`Rc(Dyn(_Speak))` by design) — respelled to `Rc(Dyn(_Speak))` in the same session;
`tests/explicit_allocators.test.yo` is 22/22 by yo-il.
