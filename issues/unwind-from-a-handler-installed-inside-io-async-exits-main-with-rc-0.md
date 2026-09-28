# `unwind` from an `Exception` handler installed INSIDE an `io.async` body silently ends the program with rc 0

**Severity:** S1 — unwinding from a handler inside io.async silently exits main with rc 0 (or segfaults) — the emitted C jumps somewhere it should not

**Status: OPEN.** Found 2026-09-06 while looking for a way to catch a framing
error per connection in `HttpServer.serve` (`plans/archive/STD_API_STABILIZATION.md`
§3 item 18).

## Reproducer

```rust
{ Error, Exception, IoExn } :: import("std/error");
open(import("std/fmt"));
open(import("std/string"));
Boom :: struct(msg : String);
impl(Boom, ToString(to_string : (self -> self.msg)));
impl(Boom, Error());
_may_fail :: (fn(fail : bool, io : Io) -> Impl(Future(String, IoExn)))(
  io.async(e => cond(fail => e.exn.throw(dyn(Boom(msg : `framing broke`))), true => `ok body`.to_string()))
);
// A LOCAL handler inside the async body that unwinds a value.
_guarded :: (fn(fail : bool, io : Io) -> Impl(Future(Result(String, String), IoExn)))(
  io.async(e => {
    local_exn := Exception(throw : (err -> { unwind(Result(String, String).Err(err.to_string())); }));
    raw := e.io.await(_may_fail(fail, e.io), IoExn(io : e.io, exn : local_exn));
    Result(String, String).Ok(raw)
  })
);
_show :: (fn(r : Result(String, String)) -> String)(match(r, .Ok(s) => s, .Err(m) => `ERR ${m}`));
main :: (fn(io : Io, exn : Exception) -> unit)({
  e := IoExn(io : io, exn : exn);
  println(`ok case: ${_show(io.await(_guarded(false, io), e))}`);
  println(`fail case: ${_show(io.await(_guarded(true, io), e))}`);
  println(`after: ${_show(io.await(_guarded(false, io), e))}`);
});
export(main);
```

```
$ yo compile tmp/fixme.yo --optimize 2 -o probe && ./probe; echo rc=$?
ok case: ok body
rc=0
```

The second and third lines never print. The `unwind` did not resolve
`_guarded`'s future with the `.Err` value — it aborted the task, the abort
propagated to `main`'s future, and the process exited **successfully** with
no diagnostic. Two things are wrong here, one of them independent of the
design question:

1. **rc 0 for an aborted main future.** Whatever `unwind` means inside an
   async body, a program whose `main` never ran to completion must not exit 0
   in silence. `__yo_async_main` should treat an `Aborted` main future as a
   failure (non-zero rc, a message on stderr), like the "async main Future was
   aborted by an effect handler" path in `runtime_core.yo` was meant to.
2. **There is no way to catch a thrown error inside an async body.** The
   handler's install frame is the `io.async` closure; `unwind(value)` there
   should exit that closure with `value` as the future's result (the sync
   semantics of `unwind` — "exits the install frame with the value"), which
   is what a per-connection error handler in a server loop needs. Whether that
   is the intended semantics or the abort is, the language documentation
   (`docs/*/ASYNC_AWAIT.md`, the algebraic-effects section of AGENTS.md) does
   not say, and the std has no precedent (`grep -rn "unwind(" std` finds only
   regex parser method names).

## Second shape: SIGSEGV

Moving the failing `await` into a helper called from `main`
(`issues/repros/unwind-inside-io-async-helper-sigsegv.yo`) crashes the process
instead — rc 139, no output at all (stdout's buffer dies with it):

```rust
_run_fail :: (fn(io : Io, exn : Exception) -> String)({
  e := IoExn(io : io, exn : exn);
  r := _show(io.await(_guarded(true, io), e));   // the local handler unwinds inside _guarded's async body
  println(`inside helper: ${r}`);
  r
});
```

So the same construct is a silent rc-0 exit in one frame shape and a
segfault in another: `unwind` from a handler installed inside an `io.async`
body has no well-defined install frame once the state machine runs from the
event loop, and the emitted C jumps somewhere it should not.

**Recommended fix order:** (1) make the evaluator REJECT a `ctl` value that
`unwind`s when it is bound inside an `io.async` body (a clear compile error:
"unwind inside an async body is not supported; return a Result from the
future instead"), so no program can reach the crash; (2) then decide the
real semantics — the useful one is "resolve the enclosing future with the
unwound value", which is what a per-connection error handler needs.

## Consequence for the std

Per-connection error recovery therefore has to be built WITHOUT catching:
D13's shape — a `Result`-returning core (`read_http_message` returning
`Result(String, HttpError)`) that the server consumes, with the throwing form
kept as a wrapper for the client. That is how §3 item 18 is being fixed.

## Re-verified 2026-09-28 (async state-machine audit)

Tree build of develop `af62bdb28`, and the v0.2.45 seed unless noted. See `plans/ASYNC_STATE_MACHINE_GENERATION.md` §3.3.

**STILL REPRODUCES, both shapes** (seed and tree build). Shape 1 prints only `ok case: ok body` and exits 0. Shape 2 exits 139, and ASan shows `SEGV on unknown address 0x000000000001` in `__yo_incr_rc` from the helper. Mechanism: the helper's synchronous await sees the aborted task and decides it is the handler's install frame (`is_await_unwind_handler_installation`, `src/codegen/exprs/await.yo`). It then runs `memcpy(&_unw_result, __yo_unwind_value, sizeof(String))`, reinterpreting the `Result(String, String).Err` that the task's local handler unwound (tag 1 read as pointer `0x1`) as the helper's `String` result. That is type confusion. In a unit `main`, the same path is a silent `return;`.

## Fix (2026-09-29, async state-machine plan phase 2 item 4)

The semantics are the useful one: `unwind(value)` exits the frame that
installed the handler, the function or `io.async` block whose body the handler
literal is written in. For an `io.async` block, the value resolves that
block's future.

The fix identifies the installer at run time instead of guessing it:

- **Identity.** Every handler `unwind` stores its handler's id (a hash of the
  handler literal's source position, `unwind_origin_id`) into the thread-local
  `__yo_unwind_target`. Each frame collects the ids of the handler literals
  written directly in its own body (`unwind_catches_of_body`).
- **Catching.** Two sites now catch only when the target is one of their own
  ids: a state machine whose awaited child aborted or whose call escaped
  (`emit_sm_unwind_catch`: copy the value into `sm->result`, drop the locals
  through the new `<dispose>_locals`, complete), and a synchronous `io.await`
  of an aborted task. Any other unwind, or a cancellation, propagates. The
  static `is_await_unwind_handler_installation`, which counted any effect
  bundle built in the frame as an installation, is gone. It was what made a
  helper frame read another frame's `Result` as its own `String`.
- **Transport.** Between a task's abort and its awaiter's resume other tasks
  run and may unwind, so the task-abort registry entry now carries the target
  and a copy of the value. `__yo_task_abort_take_unwind` restores them for the
  awaiter.
- **Types.** The evaluator does not check an `unwind` value against an
  `io.async` block's inferred result type, so codegen does. A mismatch is a
  user error at the `unwind`, where it used to be a byte reinterpretation.

Tests:

- `tests/async/sm_protocol.test.yo` covers both shapes of this doc and an
  unwind that passes through tasks to a synchronous installer.
- `tests/cli-cases/async-unwind-value-must-have-the-block-result-type` covers
  the type check.

Item 1 (rc 0) no longer arises: `main` cannot take an `Exception` any more,
and an unwind nobody catches reaches the top-level belt, which aborts loudly.
