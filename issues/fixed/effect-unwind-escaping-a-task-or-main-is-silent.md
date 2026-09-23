# An effect unwind that aborts a task (or escapes to top level) exits silently

**Status: FIXED** (safe-mode Phase 0a; `plans/SAFE_MODE.md` §3).

## The behavior (measured 2026-09-22, seed v0.2.38)

A spawned async task whose effect handler unwinds enters `FutureState.Aborted`
(state = -2). When the `JoinHandle` is awaited, that is the designed `.None`
observation channel. When the handle is **discarded** (fire-and-forget
`io.spawn`), the abort was completely invisible:

```
$ ./escape_ff.bin
task: throwing
handler: unwinding
main: spawned fire-and-forget, returning
$ echo $?
0
```

rc=0, nothing on stderr. The program's most exceptional event — an effect
escaping a handler's scope and discarding a whole computation — left no signal
whatsoever.

## Minimal repro (`tmp/sm/escape_ff.yo`, recorded in the cli-case
`tests/cli-cases/task-effect-unwind-diagnostic/`)

```rust
{ IoExn, Exception } :: import("std/error");
{ println, ToString } :: import("std/fmt");

MyError :: enum(Boom);
derive(MyError, Error(.Boom => `boom`));

main :: (fn(io : Io) -> unit)({
  exn := Exception(throw : ((err) -> { unwind(()); }));
  task := io.async((e : IoExn) => {
    e.exn.throw(dyn(MyError.Boom));
  });
  io.spawn(task, IoExn(io : io, exn : exn));  // handle discarded
});
export(main);
```

## Root cause — and the correction to SAFE_MODE §1 H9

The survey's mechanism claim was **wrong in one direction and right in
another**. Reading the emitted C:

1. **The `__yo_effect_escaped` flag cannot currently survive to top level.**
   Every unwind is caught at a task boundary (`sync_fut_t_resume` /
   `emit_async_future_escape`) or at a handler-install call site, and the task
   boundaries CLEAR the flag when converting the unwind into state = -2. The
   module-init check was therefore the only flag consumer after init — a belt
   with no second buckle. The post-`__yo_user_main` check still lands (all
   three platform arms in `generate_main_wrapper`), because any future
   propagation path that leaves the flag set must fail loudly, not rc=0; but
   it is unreachable through today's surface.
2. **The real observable defect is the silent task abort.** The -2 transition
   is written by three emitters: `__yo_task_abort`
   (`src/codegen/async/runtime_core.yo:980`, the `JoinHandle.abort()`
   cancellation path used by `race`/`timeout`) and the two UNWIND-side
   writers — `emit_async_future_escape`
   (`src/codegen/exprs/async_completion.yo`) for full state machines and the
   `if (__yo_effect_escaped)` block in the sync_fut resume emitter
   (`src/codegen/exprs/async.yo`). None of them printed anything.

## The fix

- **Unwind-side task aborts are loud.** Both unwind-side -2 writers emit
  `fprintf(stderr, "unhandled effect unwind aborted an async task\n");` before
  the RC decrement. The cancellation path (`__yo_task_abort`) is deliberately
  NOT touched — `race`/`timeout` abort loser tasks routinely, and warning on
  those would be constant noise. `JoinHandle.await` continues to return
  `.None` as the typed channel.
- **The post-`main` flag belt: DEFERRED, with the reason measured.** The
  belt was built and CI caught it firing on LEGITIMATE programs: in a
  handler-install frame (a local `(raise : Raise) = handler; raise(...)`
  binding, the batch/test context), the escape path emits
  `if (__yo_effect_escaped) { drop locals; return; }` — it exits the
  install frame correctly but leaves the flag SET. Every later effect
  protocol resets the flag in its prologue, so the dirt is invisible until
  main exits — where the belt aborted. The unwind semantics are CORRECT in
  these flows; the defect is flag hygiene at the install-frame exit
  (`_call_is_handler_installation` rule 1 classifying the direct
  local-handler call in the batch context as propagate instead of install,
  or the install exit missing its clear). Filed as
  `issues/effect-install-frame-exit-leaves-the-escaped-flag-dirty.md`; the
  belt returns with that fix.

## Tests

- `tests/cli-cases/task-effect-unwind-diagnostic/` — compiles the repro with
  the self-hosted binary, runs it, and requires the stderr line (rc stays 0:
  the diagnostic is not a crash).
- The awaited twin still returns `.None` and continues; covered by the
  existing algebraic-effects tests plus the cli-case's awaited variant.
