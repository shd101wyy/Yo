# A non-`Send` closure that reads a global marks it "reached by another thread", so a later write is rejected

**Severity:** S2 — a valid global-reading non-Send async closure is wrongly rejected — an E0610 on an unrelated `JoinHandle.await` while the real D1 error is swallowed

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit, while
re-verifying the open async issues (tree build of develop `af62bdb28`).

## Symptom

Two `io.async` closures in one function, each incrementing a module-level
global. Async tasks run on the owning thread's event loop
(`docs/en-US/ASYNC_AWAIT.md`, rule 7), so no other thread is involved.

```
$ yo check issues/repros/a-non-send-closure-reading-a-global-marks-it-thread-reached.yo
error[E0610]: No method "await" on JoinHandle(T): the type has no field or method with that name.
   --> …:10:10
10 |   _ := h2.await(io);
```

The error points at an unrelated call. The real rejection only shows up
under `YO_DEBUG_SWALLOW=1`:

```
[anon-swallow] error: Cannot assign to module-level global 'g_counter' (type i32): a
closure that runs on another thread reads it (at …:5:58). …
  --> …:6:58
```

Location `5:58` is the FIRST `io.async` closure, which does not run on
another thread. Controls: with one closure, or with no global, the program
compiles and runs.

## Root cause

`validate_send_closure_global_reach` (`src/evaluator/utils/closure.yo`) walks
every closure with `function_reaches_non_send_global`, whether or not its slot
requires `Send`. The walk runs unconditionally so that its verdict is
memoized for later type judgements. Only the error is gated on `wants_send`.

The walk's atom visitor `_gr_atom` (`src/evaluator/effects/mutation_summary.yo`)
has a side effect: it inserts every global it sees into `g_d1_reached`, the
registry that `d1_record_global_write` consults. So an ordinary closure that
READS `g_counter` registers it as thread-reached. The next write, here the
second closure's `g_counter = …`, then fails rule D1.

The second defect is how the error surfaces: it is swallowed by the
closure's def-time trial, and the user sees an unrelated E0610 on the
`JoinHandle`. That is the swallow policy tracked as R2 in
`plans/TYPE_SYSTEM_SOUNDNESS.md`.

## Fix direction

Record into `g_d1_reached` only when the walk is for a closure bound to a
`Send` slot. Alternatively, key the registry by the verdict's consumer, so
that a memoized walk for a non-`Send` closure leaves no D1 evidence behind.
The regression test is the repro's shape, expecting `counter=3`, plus the
existing D1 tests (a real `Thread.spawn` closure reading a written global
must still be rejected).

## Fix (2026-09-29)

The reach walk (`src/evaluator/effects/mutation_summary.yo`) no longer writes `g_d1_reached`. It records, per function, the globals it reads (`g_gr_reads_by_fid`) and the functions it calls (`g_gr_callees_by_fid`). A new `d1_note_thread_reach(fid)` publishes the transitive set, and it is called only where code is established to run on another thread: a `Send` closure slot (`validate_send_closure_global_reach`), a `Send` judgement of a function type (`function_value_marker`), and a `Send` dyn's methods (`values/dyn.yo`). Regression: `tests/async/sm_ownership.test.yo`, "two io.async closures that update a module global". The existing D1 CLI cases (`check-global-assignment-rejected`, `check-spawn-reaches-non-send-global-rejected`, `check-function-value-reaching-global-is-not-send`) keep the real violations rejected.
