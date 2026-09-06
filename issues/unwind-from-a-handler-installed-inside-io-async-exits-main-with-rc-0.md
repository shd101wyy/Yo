# `unwind` from an `Exception` handler installed INSIDE an `io.async` body silently ends the program with rc 0

**Status: OPEN.** Found 2026-09-06 while looking for a way to catch a framing
error per connection in `HttpServer.serve` (`plans/STD_API_STABILIZATION.md`
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

## Consequence for the std

Per-connection error recovery therefore has to be built WITHOUT catching:
D13's shape — a `Result`-returning core (`read_http_message` returning
`Result(String, HttpError)`) that the server consumes, with the throwing form
kept as a wrapper for the client. That is how §3 item 18 is being fixed.
