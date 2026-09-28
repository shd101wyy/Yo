# A cond arm's SECOND await of a field-held future frees the field's future (heap-use-after-free)

**Status: OPEN.** Found 2026-09-28 by the async state-machine audit
(`plans/ASYNC_STATE_MACHINE_GENERATION.md`). Seed v0.2.45 and develop
`af62bdb28`.

## Symptom

```
$ yo compile issues/repros/async-second-cond-arm-await-of-a-field-future-frees-it.yo -o ./b3 && ./b3
tcache_thread_shutdown(): unaligned tcache chunk detected
rc=134
```

Under AddressSanitizer:

```
ERROR: AddressSanitizer: heap-use-after-free ... READ of size 4
    #0 in __yo_user_main            (main's `io.await(h.fut, io)` reads ->state)
freed by thread T1 here:
    #1 in __yo_decr_rc
    #2 in <async block>_resume       (the arm's await extracts and releases the slot)
previously allocated by thread T1 here:
    #2 in __yo_async_yield_start     (the future stored in Holder.fut)
```

Control: the same program with `h.fut` as the arm's FIRST await
(`b := e.await(h.fut, e); a := i32(1);`) prints `1`, `0` and exits 0.

## Reproducer

`issues/repros/async-second-cond-arm-await-of-a-field-future-frees-it.yo`:
a `cond` arm that awaits something, then awaits `h.fut`, where
`h : Holder` and `Holder :: ref(struct(fut : IoFuture))`.

## Root cause

`sm->await_future_N` owns a reference: it is `__yo_decr_rc`'d when the await
extracts its result. A future read out of a place (`h.fut`) is borrowed, so
the store must take a reference of its own. `emit_await_future_store`
(`src/codegen/async/state_code_gen.yo`) does that, and
`.github/instructions/c-codegen.instructions.md` says every store site must
go through it.

`generate_remaining_expr_future` (`src/codegen/async/state_machine.yo`, the
"additional await in a cond branch" path) writes the slot directly, in two
places (the `x := await(f)` form and the standalone `await(f)` form):

```c
// Store Future for additional await in cond branch
sm->await_future_1 = sm->__capture.h->fut;      // no __yo_incr_rc
```

So the arm's second await releases `Holder`'s reference, and the next reader
of `h.fut` reads freed memory.

## Fix direction

Route both stores in `generate_remaining_expr_future` through
`emit_await_future_store`. A grep for `sm->${future_field_name} = ` and
`sm->await_future_` assignments should then find no other writers. The
regression test goes in `tests/async/`: the repro's shape, asserting both
values and running under the test runner's ASan.
