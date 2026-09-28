# An `unwind` type mismatch in a handler inside an `io.async` body was swallowed

**Severity:** S2 — an ill-typed `unwind` inside an `io.async` block passed `yo check`, and `yo compile` reported only the generic E0905

**Status: FIXED** (2026-09-29). The async twin of
`issues/fixed/unwind-type-mismatch-in-a-handler-is-swallowed.md`.

## Symptom (seed v0.2.45)

```rust
_guarded :: (fn(fail : bool, io : Io) -> Impl(Future(Result(String, String), IoExn)))(
  io.async((e : IoExn) => {
    local_exn := Exception(throw : (err -> { unwind(i32(5)); }));  // i32, not Result(String, String)
    raw := e.io.await(_may_fail(fail, e.io), IoExn(io : e.io, exn : local_exn));
    Result(String, String).Ok(raw)
  })
);
```

(full program: `tests/cli-cases/check-unwind-type-mismatch-in-async-body-handler/fixture/bad.yo`)

`yo check` exited 0. `yo compile --emit-c --skip-c-compiler` failed with only
E0905: "This `io.async` closure's body was never fully evaluated — an error
inside it was deferred at definition time and never re-checked". The real
error was never printed. `unwind` exits the frame that installed the handler,
here the async block, so its value must have the block's result type,
`Result(String, String)`; with `unwind(Result(String, String).Err(`x`))` the
program compiled cleanly.

## Root cause

`YO_DEBUG_SWALLOW=1` showed the E0604 swallowed TWICE and then
`[flow-post] out=1 pending=false` for `_guarded`'s body:

1. The handler `err -> { unwind(i32(5)); }` is a closure, trial-evaluated at
   definition time by `_trial_eval_anon_body`. `throw_unwind_type_mismatch`
   flags the E0604 on the flow-violation channel (`raise_flow_violation`) and
   throws it; the trial swallows the throw.
2. The handler's definition site (channel 1 in
   `src/evaluator/values/anonymous_function.yo`) re-raises the flagged error
   through the real `exn`, and CLEARS the flag first.
3. That `exn` is not the real one here. The handler is defined inside the
   `io.async` closure body, which is itself being trial-evaluated, so the
   re-raise landed in the io.async body's trial swallow. With the flag already
   cleared, the io.async closure's own channel 1 found nothing to re-raise, and
   its channel 3 (concrete parameters) does not apply to an io.async body,
   whose `e : E` parameter is typed at the call. The body stayed hollow, the
   enclosing fn's trial succeeded, and codegen's poison gate reported E0905.

In the synchronous case the handler's definition site re-raises straight into
the named fn's trial, whose caller re-raises every swallowed error of a
concrete fn, so the single hop was enough. The flow-violation channel only
worked one trial deep: every re-raise site dropped the flag on the way out.

## Fix

`reraise_flow_violation` (`src/types/flowability.yo`) clears the flag and
raises the error again through `raise_flow_violation`, which flags it anew.
Both definition-time re-raise sites use it: channel 1 of the closure
definition (`anonymous_function.yo`) and the named fn's post-trial re-raise
(`src/evaluator/calls/function_type.yo`). A rejection now survives any number
of enclosing trials and is reported at its own span. `raise_flow_violation`'s
guards still apply to the re-raise (no flag during an overload trial or in
`comptime_expect_error` propagate mode).

## Test

`tests/cli-cases/check-unwind-type-mismatch-in-async-body-handler`: `yo check`
exits 1 with the E0604 (`Expected (enclosing function return type):
Result(String, String)`, `Got: i32`). With the seed the case is a
GOLDEN-DIFF (rc=0, no error).
