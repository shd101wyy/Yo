# Two tasks awaiting the same pending future: the first waiter is never woken (hang)

**Severity:** S1 — the second awaiter overwrites the single waiter slot — the first task never resumes and the program hangs forever (documented multi-await semantics broken)

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit (`plans/ASYNC_STATE_MACHINE_GENERATION.md`). Reproduces on the v0.2.45 seed and on a tree build of develop `af62bdb28`.

## Symptom

`issues/repros/two-tasks-awaiting-one-pending-future-lose-the-first-waiter.yo`
spawns tasks `a` and `b`. Both `io.await(shared, io)` a future that sleeps
20 ms.

```
b got 7
<hang; rc=124 under timeout 8>
```

`a` never resumes, and `ha.await(io)` waits forever. The docs promise
multi-await ("`io.await(future)` can be called multiple times on the same
Future", `docs/en-US/ASYNC_AWAIT.md` rule 9, and the "Multi-Await" section).

## Root cause

A future has ONE waiter slot (`continuation_fn` / `continuation_sm` in the
common future header). The suspension core
(`_emit_await_suspension_core`, `src/codegen/async/state_machine.yo`)
unconditionally overwrites it:

```c
${acc}->continuation_fn = <resume>;
${acc}->continuation_sm = (void*)sm;
```

So the second waiter silently evicts the first, and completion
(`emit_async_future_completion`, `src/codegen/exprs/async_completion.yo`)
wakes only the survivor. Each waiter also took its own "event loop
reference", so the future leaks too
(`issues/fixed/awaiting-an-already-started-future-from-a-state-machine-leaks-it.md`).

## Fix direction

A waiter list. The cheap form keeps the inline slot for the common single
waiter and chains extra waiters through a small node (the runtime already
pools `__yo_continuation_t`). Completion, the effect-escape path and the
abort paths must wake every waiter. Regression test: the repro's shape
under `tests/async/`, asserting both tasks see 7.

## Fix (2026-09-29, async state-machine plan phase 2)

Every future now starts with the shared `__YO_FUTURE_PREFIX` (header,
state, abort hook, one inline waiter slot). A waiter registers with
`__yo_future_add_waiter`: a second waiter turns the slot into a list headed
by `__yo_waiters_dispatch`, and completion (`__yo_future_wake_waiters`)
wakes every waiter in registration order. Test: `tests/async/sm_protocol.test.yo`
"two tasks awaiting one pending future both resume".
