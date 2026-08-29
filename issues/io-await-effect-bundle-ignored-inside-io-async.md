# Inside an `io.async` body, `e.io.await(fut, bundle)` ignores `bundle` — throws route to the enclosing task's handlers

**Status: OPEN.** Found 2026-08-29 writing the chunked-body tests for `std/http`.
**Severity:** MEDIUM-HIGH — effect routing is silently wrong: a handler
installed for one awaited future never runs, the enclosing task's handler
runs instead (and, unwinding, kills the whole task).

## Reproducer

`issues/repros/io-await-bundle-ignored-inside-io-async.yo`:

```rust
outer_task :: (fn(log : ArrayList(String), io : Io) -> Impl(Future(unit, IoExn)))(
  io.async((e) => {
    inner_exn := Exception(throw : ((err) -> { unwind(()); }));
    inner := IoExn(io : e.io, exn : inner_exn);
    r := e.io.await(thrower(e.io), inner);   // thrower does e.exn.throw(...)
    log.push(`inner returned ${r}`);
  })
);
h := io.spawn(outer_task(log, io), IoExn(io : io, exn : outer_exn));
```

Expected (docs/en-US/ALGEBRAIC_EFFECTS.md "Async + effects": the bundle
passed to `io.await` supplies the awaited future's handlers): `inner_exn`
runs and unwinds `outer_task` at the await. Observed: `OUTER handler got:
bang` — the task's own bundle handled the throw; `inner_exn` never ran.

At top level (`io.await(fut, bundle)` outside any `io.async`) the bundle IS
honoured — `tests/http/http.test.yo`'s limit tests rely on it.

## Suspected area

The async state-machine emitter (`src/codegen/async/`) threads the
enclosing SM's effect record into every awaited child future, rather than the
record the `io.await` call names as its second argument; the evaluator
accepts the argument (it type-checks against `E`) and drops it.

## Workaround status

None needed for std; `tests/http/http.test.yo`'s malformed-chunk test was
restructured to spawn the throwing fetch as its own task (its bundle is the
spawn's, which IS honoured) and to read `JoinHandle.await`'s `None` for the
unwound task.
